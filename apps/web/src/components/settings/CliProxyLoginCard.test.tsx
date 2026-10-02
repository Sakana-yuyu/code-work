import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CliProxyError } from "@codework/contracts";
import * as Cause from "effect/Cause";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { t } from "~/i18n";

const mock = vi.hoisted(() => ({
  start: vi.fn(),
  zcode: vi.fn(),
  close: vi.fn(),
  scan: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../test/reactHookHarness").then((module) => module.reactHookHarness)),
  useEffect: (effect: () => void | (() => void)) => mock.effects.push(effect),
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { startProviderLogin: "start", zcodeLogin: "zcode", cliProxy: "scan" },
  primaryServerKeybindingsAtom: "keybindings",
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: { close: "close" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "start" | "zcode" | "close" | "scan") => mock[name],
}));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));

import { CliProxyLoginCard } from "./CliProxyLoginCard";
const props = {
  environmentId: "environment-a",
  disabled: false,
  importOpen: false,
  onToggleImport: vi.fn(),
  onLoginFinished: vi.fn(),
};
const render = () => {
  hooks.beginRender();
  mock.effects = [];
  return CliProxyLoginCard(props);
};
const control = (label: string) => {
  const found = visitElements(
    render(),
    (element) =>
      (element.props.children === label ||
        (Array.isArray(element.props.children) && element.props.children.includes(label))) &&
      typeof element.props.onClick === "function",
  );
  expect(found).not.toBeNull();
  return found!;
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  hooks.reset();
  vi.resetAllMocks();
  mock.close.mockResolvedValue({ _tag: "Success" });
  mock.scan.mockResolvedValue({ _tag: "Success", value: { nativeLogins: [] } });
});

afterEach(() => vi.unstubAllGlobals());

it("扫描没有结果或失败后仍显示可重试的刷新入口", async () => {
  mock.scan.mockRejectedValueOnce(new Error("offline"));
  (control(t("cliProxy.refreshAccounts")).props.onClick as () => void)();
  await flush();
  expect(control(t("cliProxy.refreshAccounts")).props.disabled).toBe(false);
  (control(t("cliProxy.refreshAccounts")).props.onClick as () => void)();
  await flush();
  expect(mock.scan).toHaveBeenCalledTimes(2);
});

it("宿主不支持原生账号扫描时显示可读提示而不是原始错误详情", async () => {
  mock.scan.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(
      new CliProxyError({
        code: "upstream_error",
        detail: "当前环境无法扫描原生 CLI 登录态。",
      }),
    ),
  });
  (control(t("cliProxy.refreshAccounts")).props.onClick as () => void)();
  await flush();
  expect(
    visitElements(render(), (element) => element.props.role === "status")?.props.children,
  ).toBe(t("cliProxy.upstreamUnavailable"));
  expect(control(t("cliProxy.refreshAccounts")).props.disabled).toBe(false);
});

it("ZCode 慢轮询不重叠，失败结果允许下次查询，ready 只结算一次", async () => {
  let tick = () => {};
  const clearInterval = vi.fn();
  vi.stubGlobal("window", {
    setInterval: (callback: () => void) => {
      tick = callback;
      return 7;
    },
    clearInterval,
  });
  (control("ZCode 国际版 (Z.AI)").props.onClick as () => void)();
  mock.zcode.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      action: "start",
      sessionId: "poll-session",
      authorizeUrl: "https://example.test/auth",
    },
  });
  (control(t("providerConnection.login")).props.onClick as () => void)();
  await flush();
  render();
  const cleanup = mock.effects[1]!();
  let resolve!: (value: unknown) => void;
  mock.zcode.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  tick();
  tick();
  expect(mock.zcode).toHaveBeenCalledTimes(2);
  resolve({ _tag: "Interrupted" });
  await flush();
  mock.zcode.mockRejectedValueOnce(new Error("offline"));
  tick();
  await flush();
  mock.zcode.mockResolvedValue({ _tag: "Success", value: { action: "status", status: "ready" } });
  tick();
  await flush();
  tick();
  await flush();
  expect(mock.zcode).toHaveBeenCalledTimes(4);
  expect(props.onLoginFinished).toHaveBeenCalledOnce();
  expect(clearInterval).toHaveBeenCalledWith(7);
  cleanup?.();
});

it("登录请求拒绝后解除忙碌状态并允许重试", async () => {
  mock.start.mockRejectedValueOnce(new Error("disconnected"));
  (control(t("providerConnection.login")).props.onClick as () => void)();
  await flush();
  expect(control(t("providerConnection.login")).props.disabled).toBe(false);
  expect(
    visitElements(render(), (element) => element.props.role === "status")?.props.children,
  ).toBe(t("providerConnection.loginFailed"));
});

it("离开环境后才返回的 ZCode 授权会话在原环境取消", async () => {
  (control("ZCode 国际版 (Z.AI)").props.onClick as () => void)();
  let resolve!: (value: unknown) => void;
  mock.zcode.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const login = control(t("providerConnection.login"));
  const cleanup = mock.effects[0]!();
  (login.props.onClick as () => void)();
  cleanup?.();
  resolve({
    _tag: "Success",
    value: {
      action: "start",
      sessionId: "late-session",
      authorizeUrl: "https://example.test/auth",
    },
  });
  await flush();
  expect(mock.zcode).toHaveBeenLastCalledWith({
    environmentId: "environment-a",
    input: { action: "cancel", sessionId: "late-session" },
  });
  expect(props.onLoginFinished).not.toHaveBeenCalled();
});

it("终端启动在页面卸载后完成时再次关闭该终端", async () => {
  let resolve!: (value: unknown) => void;
  mock.start.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const login = control(t("providerConnection.login"));
  const cleanup = mock.effects[0]!();
  (login.props.onClick as () => void)();
  cleanup?.();
  const request = mock.start.mock.calls[0]![0];
  resolve({ _tag: "Success", value: { terminalId: request.input.terminalId, cwd: "/test" } });
  await flush();
  expect(mock.close).toHaveBeenCalledTimes(2);
  expect(mock.close).toHaveBeenLastCalledWith({
    environmentId: "environment-a",
    input: {
      threadId: "provider-login:codex",
      terminalId: request.input.terminalId,
      deleteHistory: true,
    },
  });
});
