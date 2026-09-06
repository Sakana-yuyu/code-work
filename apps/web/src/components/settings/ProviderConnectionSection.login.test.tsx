import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";
import { expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { t } from "~/i18n";

const mock = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, ...reactHookHarness, useEffect: () => {} };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mock.command }));

import { ProviderConnectionSection } from "./ProviderConnectionSection";

it("Grok 原生账号可从实例卡发起设备授权，先保存配置再向当前环境登录", async () => {
  hooks.reset();
  mock.command.mockResolvedValue({ _tag: "Success", value: { terminalId: "fixture-terminal" } });
  const save = vi.fn().mockResolvedValue({ _tag: "Success", value: {} });
  hooks.beginRender();
  const tree = ProviderConnectionSection({
    environmentId: "grok-server",
    instanceId: ProviderInstanceId.make("grok-work"),
    instance: { driver: ProviderDriverKind.make("grok"), config: {} },
    onUpdate: save,
  });
  const deviceButton = visitElements(
    tree,
    (element) =>
      element.props.children === t("providerConnection.deviceLogin") &&
      typeof element.props.onClick === "function",
  );
  expect(deviceButton).not.toBeNull();
  (deviceButton!.props.onClick as () => void)();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ config: { routeThroughByok: false } }),
  );
  expect(mock.command).toHaveBeenCalledWith({
    environmentId: "grok-server",
    input: {
      instanceId: "grok-work",
      terminalId: expect.any(String),
      deviceCode: true,
    },
  });
});
