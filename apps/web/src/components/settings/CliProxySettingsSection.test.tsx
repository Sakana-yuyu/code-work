import { EnvironmentId, AuthTerminalOperateScope, type CliProxyResult } from "@codework/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { t } from "~/i18n";

const mock = vi.hoisted(() => ({ command: vi.fn(), scopes: [] as string[] }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, ...reactHookHarness, useEffect: () => {} };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { cliProxy: Symbol("cliProxy") } }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: { authenticated: true, scopes: mock.scopes } }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mock.command }));

import { CliProxySettingsSection, localAccountIdFromFileName } from "./CliProxySettingsSection";

const environmentId = EnvironmentId.make("remote-cpa");
const status: CliProxyResult = {
  config: { strategy: "round-robin" },
  running: true,
  version: "embedded",
  baseUrl: "http://127.0.0.1:3000/v1",
  accounts: [],
};

const render = (readOnly = false, onConnected: (instanceId: unknown) => void = () => {}) => {
  hooks.beginRender();
  return CliProxySettingsSection({ environmentId, readOnly, onConnected });
};

const button = (key: string) => {
  const found = visitElements(
    render(),
    (element) => element.props.children === t(key) && typeof element.props.onClick === "function",
  );
  expect(found).not.toBeNull();
  return found!;
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  hooks.reset();
  mock.scopes = [AuthTerminalOperateScope];
  mock.command.mockReset().mockResolvedValue({ _tag: "Success", value: status });
});

it("从本地文件名生成服务端可接受的账号 ID", () => {
  expect(localAccountIdFromFileName("123.json")).toBe("account-123");
  expect(localAccountIdFromFileName("my account.JSON")).toBe("my-account");
  expect(localAccountIdFromFileName(".json")).toBe("account-import");
});

it("只向选中环境提交内置状态/刷新操作", async () => {
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(mock.command).toHaveBeenLastCalledWith({ environmentId, input: { action: "status" } });
  expect(button("cliProxy.refreshAccounts").props.disabled).toBe(false);
});

it("没有终端管理权限时禁用并阻止 RPC", async () => {
  mock.scopes = [];
  expect(button("cliProxy.refresh").props.disabled).toBe(true);
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(mock.command).not.toHaveBeenCalled();
});

it("官方登录入口会触发供应商登录页回调", () => {
  const connected: unknown[] = [];
  const found = visitElements(
    render(false, (instanceId) => connected.push(instanceId)),
    (element) =>
      element.props.children === "打开官方登录" && typeof element.props.onClick === "function",
  );
  expect(found).not.toBeNull();
  (found!.props.onClick as () => void)();
  expect(connected.map(String)).toEqual(["codex"]);
});

it("搜索图标位于输入框背景层之上，不会留下空白占位", () => {
  const found = visitElements(
    render(),
    (element) =>
      typeof element.props.className === "string" &&
      element.props.className.includes("pointer-events-none") &&
      element.props.className.includes("z-10"),
  );
  expect(found).not.toBeNull();
});
