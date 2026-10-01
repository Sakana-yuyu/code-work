import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const lifecycle = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    ...reactHookHarness,
    useEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ClaimOfferDialog } from "./ClaimOfferDialog";

afterEach(() => vi.unstubAllGlobals());

it("验证码就绪前不可点击；回调用最新领取函数；关闭销毁实例并拒绝迟到回调", async () => {
  hooks.reset();
  lifecycle.effects = [];
  const destroy = vi.fn();
  let success: (value: string) => void = () => {};
  vi.stubGlobal("window", {
    initAliyunCaptcha: (options: Parameters<NonNullable<Window["initAliyunCaptcha"]>>[0]) => {
      success = options.success;
      options.getInstance?.({ destroy });
    },
  });
  const first = vi.fn();
  const second = vi.fn();
  const props = {
    offer: { planId: "test", name: "体验套餐", entitlements: [] },
    captchaConfig: { enabled: true, prefix: "test", sceneId: "scene" },
    pending: false,
    result: null,
    onClose: vi.fn(),
    onClaim: first,
  };
  hooks.beginRender();
  const tree = ClaimOfferDialog(props);
  expect(
    visitElements(tree, (element) => element.props.id === "codework-captcha-button")!.props
      .disabled,
  ).toBe(true);
  const cleanup = lifecycle.effects[0]!();
  await Promise.resolve();
  hooks.beginRender();
  const ready = ClaimOfferDialog({ ...props, onClaim: second });
  expect(
    visitElements(ready, (element) => element.props.id === "codework-captcha-button")!.props
      .disabled,
  ).toBe(false);
  success("verified");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  cleanup?.();
  success("late");
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});
