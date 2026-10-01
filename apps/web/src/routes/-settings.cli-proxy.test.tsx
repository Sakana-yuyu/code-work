import { EnvironmentId } from "@codework/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../test/reactElementTree";

const state = vi.hoisted(() => ({ requested: undefined as string | undefined, found: true }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => ({ environmentId: state.requested }),
  }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "primary" }),
  useEnvironment: (id: string | null) =>
    id !== null && state.found ? { environmentId: id } : null,
}));
vi.mock("../components/settings/CliProxySettingsSection", () => ({
  CliProxySettingsSection: () => null,
}));

import { Route } from "./settings.cli-proxy";
import { CliProxySettingsSection } from "../components/settings/CliProxySettingsSection";

beforeEach(() => {
  state.requested = undefined;
  state.found = true;
});

const panel = () =>
  visitElements(
    Route.options.component!({}),
    (element) => element.type === CliProxySettingsSection,
  );

it("指定环境不存在时不回退到本机账号池", () => {
  state.requested = "missing";
  state.found = false;
  expect(panel()).toBeNull();
});

it("账号池表单以环境为身份边界，切换时卸载旧凭据草稿和登录卡", () => {
  const primary = panel();
  expect(primary?.props.environmentId).toBe(EnvironmentId.make("primary"));
  expect(primary?.key).toBe("primary");
  state.requested = "remote";
  expect(panel()?.key).toBe("remote");
});
