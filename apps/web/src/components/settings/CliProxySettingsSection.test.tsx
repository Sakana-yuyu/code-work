import {
  EnvironmentId,
  LocalAccountId,
  AuthTerminalOperateScope,
  type CliProxyResult,
} from "@codework/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { t } from "~/i18n";

const mock = vi.hoisted(() => ({ command: vi.fn(), scopes: [] as string[], connected: true }));
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
  useEnvironmentConnectionState: () => ({
    data: { phase: mock.connected ? "connected" : "connecting" },
  }),
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mock.command }));

import { CliProxyLoginCard } from "./CliProxyLoginCard";
import { ClaimOfferDialog } from "./ClaimOfferDialog";
import { Dialog } from "../ui/dialog";
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
  mock.connected = true;
  mock.command.mockReset().mockResolvedValue({ _tag: "Success", value: status });
});

it("从本地文件名生成服务端可接受的账号 ID", () => {
  expect(localAccountIdFromFileName("123.json")).toBe("account-123");
  expect(localAccountIdFromFileName("my account.JSON")).toBe("my-account");
  expect(localAccountIdFromFileName(".json")).toBe("account-import");
  expect(localAccountIdFromFileName(`${"1".repeat(100)}.json`)).toHaveLength(96);
});

it("只向选中环境提交内置状态/刷新操作", async () => {
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(mock.command).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "localAccountUsage" },
  });
  expect(button("cliProxy.refreshAccounts").props.disabled).toBe(false);
});

it("读取额度时同步服务端调度策略，不能把旧策略误保存回去", async () => {
  mock.command.mockResolvedValue({
    _tag: "Success",
    value: {
      ...status,
      config: { strategy: "weighted-round-robin" },
      localStrategy: "weighted-round-robin",
    },
  });
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(button("cliProxy.saveConfig").props.disabled).toBe(true);
});

it("没有终端管理权限时禁用并阻止 RPC", async () => {
  mock.scopes = [];
  expect(button("cliProxy.refresh").props.disabled).toBe(true);
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(mock.command).not.toHaveBeenCalled();
});

it("连接完成前不发送账号池 RPC，恢复连接后允许刷新", async () => {
  mock.connected = false;
  expect(button("cliProxy.refresh").props.disabled).toBe(true);
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(mock.command).not.toHaveBeenCalled();
  mock.connected = true;
  (button("cliProxy.refresh").props.onClick as () => void)();
  await flush();
  expect(mock.command).toHaveBeenCalledOnce();
});

it("登录添加账号卡片结束登录后把终端凭据导入号池", async () => {
  const card = visitElements(render(), (element) => element.type === CliProxyLoginCard);
  expect(card).not.toBeNull();
  expect(card!.props.disabled).toBe(false);
  (
    card!.props.onLoginFinished as (input: {
      provider: string;
      terminalId: string;
      models: string[];
    }) => void
  )({ provider: "codex", terminalId: "term-1", models: ["gpt-5"] });
  await flush();
  expect(mock.command).toHaveBeenCalledWith({
    environmentId,
    input: {
      action: "importLocalLogin",
      provider: "codex",
      terminalId: "term-1",
      models: ["gpt-5"],
    },
  });
});

const accountId = LocalAccountId.make("account-a");
const accountStatus: CliProxyResult = {
  ...status,
  localAccounts: [
    {
      id: accountId,
      provider: "codex",
      displayName: "测试账号",
      enabled: true,
      models: ["custom-model"],
    },
  ],
};
const clickLabel = async (label: string) => {
  const control = visitElements(
    render(),
    (element) =>
      element.props["aria-label"] === label && typeof element.props.onClick === "function",
  );
  expect(control).not.toBeNull();
  await (control!.props.onClick as () => Promise<void>)();
  await flush();
};

it("启停账号保留订阅快照，卡片刷新只查询当前账号", async () => {
  mock.command.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...accountStatus,
      accountSubscriptions: [{ id: accountId, plan: "Pro", windows: [] }],
    },
  });
  await clickLabel(t("cliProxy.refresh"));
  mock.command.mockResolvedValue({ _tag: "Success", value: accountStatus });
  (button("cliProxy.disable").props.onClick as () => void)();
  await flush();
  expect(
    visitElements(
      render(),
      (element) =>
        Array.isArray(element.props.children) && element.props.children.includes(" · Pro"),
    ),
  ).not.toBeNull();
  await clickLabel(t("cliProxy.usageRefresh"));
  expect(mock.command).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "localAccountUsage", id: accountId },
  });
});

it("模型查询保留自定义模型，保存失败保留弹窗和选择", async () => {
  mock.command.mockResolvedValueOnce({ _tag: "Success", value: accountStatus });
  await clickLabel(t("cliProxy.refresh"));
  mock.command.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...accountStatus,
      accountModels: { accountId, provider: "codex", source: "provider", models: ["gpt-5"] },
    },
  });
  await clickLabel(t("cliProxy.fetchModels"));
  const save = visitElements(
    render(),
    (element) => element.props.children === t("cliProxy.modelsSave", { count: 1 }),
  );
  expect(save).not.toBeNull();
  mock.command.mockRejectedValueOnce(new Error("保存失败"));
  (save!.props.onClick as () => void)();
  await flush();
  expect(mock.command).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "setLocalAccountModels", id: accountId, models: ["custom-model"] },
  });
  expect(
    visitElements(render(), (element) => element.type === Dialog && element.props.open === true),
  ).not.toBeNull();
});

it("领取 RPC 失败在弹窗显示错误，不报告成功", async () => {
  const offer = { planId: "trial", name: "体验套餐", entitlements: [] };
  mock.command.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...accountStatus,
      accountSubscriptions: [{ id: accountId, windows: [], offers: [offer] }],
    },
  });
  await clickLabel(t("cliProxy.refresh"));
  (button("cliProxy.offerClaim").props.onClick as () => void)();
  const dialog = visitElements(render(), (element) => element.type === ClaimOfferDialog)!;
  mock.command.mockRejectedValueOnce(new Error("登录已失效"));
  (dialog.props.onClaim as (token: string) => void)("test-verification");
  await flush();
  expect(
    visitElements(render(), (element) => element.type === ClaimOfferDialog)!.props.result,
  ).toEqual({ success: false, message: "登录已失效" });
});

it("没有终端管理权限时登录添加账号卡片被禁用", () => {
  mock.scopes = [];
  const card = visitElements(render(), (element) => element.type === CliProxyLoginCard);
  expect(card!.props.disabled).toBe(true);
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
