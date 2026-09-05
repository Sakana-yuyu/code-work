import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { t } from "~/i18n";

import {
  FacilitiesQuickGuide,
  closeGuideOnEscape,
  guideStepAdvancesOnClick,
  type FacilitiesGuideConcept,
  type FacilitiesGuideStep,
} from "./FacilitiesQuickGuide";

const steps: ReadonlyArray<FacilitiesGuideStep> = [
  {
    titleKey: "facilitiesGuide.byok.step1Title",
    descriptionKey: "facilitiesGuide.byok.step1Description",
    linkTo: "/settings/providers",
    linkLabelKey: "facilitiesGuide.byok.step1Link",
  },
  {
    titleKey: "facilitiesGuide.byok.step2Title",
    descriptionKey: "facilitiesGuide.byok.step2Description",
  },
];

const concepts: ReadonlyArray<FacilitiesGuideConcept> = [
  {
    termKey: "facilitiesGuide.byok.termChannel",
    descriptionKey: "facilitiesGuide.byok.termChannelDescription",
  },
];

describe("FacilitiesQuickGuide", () => {
  it("Esc 只关闭引导，输入步骤不会因点击预填值自动推进", () => {
    const event = {
      key: "Escape",
      defaultPrevented: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const close = vi.fn();
    closeGuideOnEscape(event as unknown as KeyboardEvent, close);
    expect(close).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    closeGuideOnEscape({ ...event, defaultPrevented: true } as unknown as KeyboardEvent, close);
    expect(close).toHaveBeenCalledOnce();
    closeGuideOnEscape({ ...event, isComposing: true } as unknown as KeyboardEvent, close);
    expect(close).toHaveBeenCalledOnce();
    expect(guideStepAdvancesOnClick({ ...steps[0]!, advanceOn: "input" })).toBe(false);
    expect(guideStepAdvancesOnClick({ ...steps[0]!, advanceOn: "manual" })).toBe(false);
    expect(guideStepAdvancesOnClick(steps[0]!)).toBe(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a guide trigger for the supplied steps", () => {
    const html = renderToStaticMarkup(
      <FacilitiesQuickGuide guideId="byok" steps={steps} concepts={concepts} />,
    );
    expect(html).toContain(t("facilitiesGuide.open"));
    expect(html).toContain('data-slot="dialog-trigger"');
  });

  it("uses the built-in preset when steps are omitted", () => {
    const html = renderToStaticMarkup(<FacilitiesQuickGuide guideId="providers" />);
    expect(html).toContain(t("facilitiesGuide.open"));
  });

  it("does not render a stepper until the dialog is opened", () => {
    const html = renderToStaticMarkup(
      <FacilitiesQuickGuide guideId="byok" steps={steps} concepts={[]} />,
    );
    expect(html).not.toContain(t("facilitiesGuide.byok.step1Title"));
  });

  it("promotes the entry with an empty-state hint while the page has nothing configured", () => {
    const html = renderToStaticMarkup(<FacilitiesQuickGuide guideId="byok" steps={steps} empty />);
    expect(html).toContain(t("facilitiesGuide.emptyHint"));
    expect(html).toContain(t("facilitiesGuide.open"));

    const plain = renderToStaticMarkup(<FacilitiesQuickGuide guideId="byok" steps={steps} />);
    expect(plain).not.toContain(t("facilitiesGuide.emptyHint"));
  });
});
