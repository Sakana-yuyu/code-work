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
});
