import { EnvironmentId } from "@codework/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../test/reactElementTree";

const state = vi.hoisted(() => ({
  requested: undefined as string | undefined,
  found: true,
  splitLoaders: [] as Array<() => Promise<{ component: () => unknown }>>,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => ({ environmentId: state.requested }),
  }),
  useNavigate: () => vi.fn(),
  // autoCodeSplitting 把路由组件拆成 lazyRouteComponent(loader)；测试捕获
  // loader 同步解析出原始组件再渲染。
  lazyRouteComponent: (loader: () => Promise<{ component: () => unknown }>) => {
    state.splitLoaders.push(loader);
    return () => null;
  },
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

const panel = async () => {
  const loader = state.splitLoaders[0];
  const component = loader
    ? (await loader()).component
    : (
        Route.options as unknown as {
          readonly component: (props?: Record<string, never>) => unknown;
        }
      ).component;
  return visitElements(component(), (element) => element.type === CliProxySettingsSection);
};

it("指定环境不存在时不回退到本机账号池", async () => {
  state.requested = "missing";
  state.found = false;
  expect(await panel()).toBeNull();
});

it("账号池表单以环境为身份边界，切换时卸载旧凭据草稿和登录卡", async () => {
  const primary = await panel();
  expect(primary?.props.environmentId).toBe(EnvironmentId.make("primary"));
  expect(primary?.key).toBe("primary");
  state.requested = "remote";
  expect((await panel())?.key).toBe("remote");
});
