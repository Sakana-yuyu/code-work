import {
  CliProxyError,
  EnvironmentId,
  LocalAccountId,
  type CliProxyResult,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";
import { zhCN } from "../../i18n/messages";

const mock = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../../../web/src/test/reactHookHarness").then(
    (module) => module.reactHookHarness,
  )),
  useEffect: () => {},
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("react-native", () => ({ View: "div", Pressable: "button", Alert: { alert: vi.fn() } }));
vi.mock("../../components/AppText", () => ({ AppText: "span", AppTextInput: "input" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "section" }));
vi.mock("../../i18n", () => ({ t: (key: string) => zhCN[key] ?? key }));
vi.mock("../../state/server", () => ({ serverEnvironment: { cliProxy: "cliProxy" } }));
vi.mock("../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: { phase: "connected" } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mock.command }));

import { CliProxySettingsSection } from "./CliProxySettingsSection";

const render = () => {
  hooks.beginRender();
  return CliProxySettingsSection({
    environmentId: EnvironmentId.make("remote"),
    readOnly: false,
    onManageRoutes: () => {},
  });
};

beforeEach(() => {
  hooks.reset();
  mock.command.mockReset();
});

it("空模型账号显示待同步，同步模型后提示消失，清空后恢复", async () => {
  for (const models of [[], ["synced-model"], []]) {
    const value: CliProxyResult = {
      config: { strategy: "round-robin" },
      running: true,
      version: "embedded",
      baseUrl: "http://127.0.0.1:3000/v1",
      accounts: [],
      localAccounts: [
        {
          id: LocalAccountId.make("pending"),
          provider: "codex",
          displayName: "测试账号",
          enabled: true,
          models,
        },
      ],
    };
    mock.command.mockResolvedValueOnce({ _tag: "Success", value });
    const refresh = visitElements(
      render(),
      (element) => element.props.label === zhCN["cliProxy.refresh"],
    );
    (refresh!.props.onPress as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    const pending = visitElements(
      render(),
      (element) =>
        typeof element.props.children === "string" &&
        element.props.children === zhCN["cliProxy.modelsPending"],
    );
    expect(pending !== null).toBe(models.length === 0);
  }
});

it("宿主不支持额度查询时显示可读提示并保留重试入口", async () => {
  const detail = "当前环境无法查询官方账号额度。";
  mock.command.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new CliProxyError({ code: "upstream_error", detail })),
  });
  const refresh = visitElements(
    render(),
    (element) => element.props.label === zhCN["cliProxy.refresh"],
  );
  expect(refresh).not.toBeNull();
  (refresh!.props.onPress as () => void)();
  await Promise.resolve();
  await Promise.resolve();
  const tree = render();
  expect(
    visitElements(
      tree,
      (element) => element.props.children === zhCN["cliProxy.upstreamUnavailable"],
    ),
  ).not.toBeNull();
  expect(visitElements(tree, (element) => element.props.children === detail)).toBeNull();
  expect(
    visitElements(tree, (element) => element.props.label === zhCN["cliProxy.refresh"])?.props
      .disabled,
  ).toBe(false);
});
