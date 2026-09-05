"use client";

import { Link } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  CompassIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import { t } from "~/i18n";

import { Button } from "../ui/button";
import type { SettingsPath } from "./settingsSearch";

export interface FacilitiesGuideStep {
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly linkTo?: SettingsPath;
  readonly linkLabelKey?: string;
  readonly targetSelector?: string;
  readonly targetActionKey?: string;
  readonly advanceOn?: "click" | "input" | "manual";
}

export interface FacilitiesGuideConcept {
  readonly termKey: string;
  readonly descriptionKey: string;
}

export function closeGuideOnEscape(event: KeyboardEvent, close: () => void) {
  if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

export const guideStepAdvancesOnClick = (step: FacilitiesGuideStep) =>
  step.advanceOn === undefined || step.advanceOn === "click";

type FacilitiesGuidePreset = {
  readonly steps: ReadonlyArray<FacilitiesGuideStep>;
};

type GuidePlacement = "top" | "bottom" | "left" | "right";

type GuidePosition = {
  readonly placement: GuidePlacement;
  readonly left: number;
  readonly top: number;
};

type GuideCalloutSize = {
  readonly width: number;
  readonly height: number;
};

const GUIDE_VIEWPORT_MARGIN = 16;
const GUIDE_TARGET_GAP = 14;
const GUIDE_DEFAULT_WIDTH = 320;
const GUIDE_DEFAULT_HEIGHT = 260;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function intersectionArea(
  left: number,
  top: number,
  width: number,
  height: number,
  target: DOMRect,
): number {
  const horizontal = Math.max(
    0,
    Math.min(left + width, target.right) - Math.max(left, target.left),
  );
  const vertical = Math.max(0, Math.min(top + height, target.bottom) - Math.max(top, target.top));
  return horizontal * vertical;
}

function calculateGuidePosition(
  target: DOMRect,
  callout: GuideCalloutSize | null,
): GuidePosition | null {
  if (typeof window === "undefined") return null;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(
    callout?.width || GUIDE_DEFAULT_WIDTH,
    viewportWidth - GUIDE_VIEWPORT_MARGIN * 2,
  );
  const height = Math.min(
    callout?.height || GUIDE_DEFAULT_HEIGHT,
    viewportHeight - GUIDE_VIEWPORT_MARGIN * 2,
  );
  const gap = GUIDE_TARGET_GAP;
  const candidates: ReadonlyArray<GuidePosition> = [
    {
      placement: "right",
      left: target.right + gap,
      top: target.top + (target.height - height) / 2,
    },
    {
      placement: "left",
      left: target.left - width - gap,
      top: target.top + (target.height - height) / 2,
    },
    {
      placement: "bottom",
      left: target.left + (target.width - width) / 2,
      top: target.bottom + gap,
    },
    {
      placement: "top",
      left: target.left + (target.width - width) / 2,
      top: target.top - height - gap,
    },
  ];
  const fits = candidates.find(
    (candidate) =>
      candidate.left >= GUIDE_VIEWPORT_MARGIN &&
      candidate.top >= GUIDE_VIEWPORT_MARGIN &&
      candidate.left + width <= viewportWidth - GUIDE_VIEWPORT_MARGIN &&
      candidate.top + height <= viewportHeight - GUIDE_VIEWPORT_MARGIN &&
      intersectionArea(candidate.left, candidate.top, width, height, target) === 0,
  );
  if (fits) return fits;

  const fallback = candidates
    .map((candidate) => {
      const left = clamp(
        candidate.left,
        GUIDE_VIEWPORT_MARGIN,
        viewportWidth - GUIDE_VIEWPORT_MARGIN - width,
      );
      const top = clamp(
        candidate.top,
        GUIDE_VIEWPORT_MARGIN,
        viewportHeight - GUIDE_VIEWPORT_MARGIN - height,
      );
      const overflow =
        Math.max(0, GUIDE_VIEWPORT_MARGIN - candidate.left) +
        Math.max(0, candidate.left + width - viewportWidth + GUIDE_VIEWPORT_MARGIN) +
        Math.max(0, GUIDE_VIEWPORT_MARGIN - candidate.top) +
        Math.max(0, candidate.top + height - viewportHeight + GUIDE_VIEWPORT_MARGIN);
      return {
        ...candidate,
        left,
        top,
        score: overflow * 1000 + intersectionArea(left, top, width, height, target),
      };
    })
    .sort((left, right) => left.score - right.score)[0];
  return fallback === undefined
    ? null
    : { placement: fallback.placement, left: fallback.left, top: fallback.top };
}

const EMPTY_CONCEPTS: ReadonlyArray<FacilitiesGuideConcept> = [];

function findGuideTarget(selector: string): Element | null {
  return (
    Array.from(document.querySelectorAll(selector)).find((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }) ?? null
  );
}

function guideTargetRect(element: Element): DOMRect {
  const rect = element.getBoundingClientRect();
  const isOversized =
    rect.width >= window.innerWidth * 0.72 && rect.height >= window.innerHeight * 0.7;
  if (!isOversized) return rect;
  const focused = Array.from(
    element.querySelectorAll<HTMLElement>(
      'button, input:not([type="hidden"]), textarea, select, h2, h3, h4, [role="button"]',
    ),
  ).find((candidate) => {
    const candidateRect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return (
      candidateRect.width > 1 &&
      candidateRect.height > 1 &&
      candidateRect.bottom > 0 &&
      candidateRect.top < window.innerHeight &&
      candidateRect.right > 0 &&
      candidateRect.left < window.innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  });
  return focused?.getBoundingClientRect() ?? rect;
}

function sameRect(left: DOMRect | null, right: DOMRect | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

const GUIDE_PRESETS: Readonly<Record<string, FacilitiesGuidePreset>> = {
  providers: {
    steps: [
      {
        titleKey: "facilitiesGuide.providers.step1Title",
        descriptionKey: "facilitiesGuide.providers.step1Description",
        targetSelector: '[data-facilities-guide-target="providers-byok-instance"]',
        targetActionKey: "facilitiesGuide.providers.step1Action",
      },
      {
        titleKey: "facilitiesGuide.providers.step2Title",
        descriptionKey: "facilitiesGuide.providers.step2Description",
        targetSelector: '[data-facilities-guide-target="providers-configuration-tab"]',
        targetActionKey: "facilitiesGuide.providers.step2Action",
      },
      {
        titleKey: "facilitiesGuide.providers.step3Title",
        descriptionKey: "facilitiesGuide.providers.step3Description",
        targetSelector: '[data-facilities-guide-target="providers-add-channel"]',
        targetActionKey: "facilitiesGuide.providers.step3Action",
      },
      {
        titleKey: "facilitiesGuide.providers.step4Title",
        descriptionKey: "facilitiesGuide.providers.step4Description",
        targetSelector: '[data-facilities-guide-target="providers-base-url"]',
        targetActionKey: "facilitiesGuide.providers.step4Action",
        advanceOn: "input",
      },
      {
        titleKey: "facilitiesGuide.providers.step5Title",
        descriptionKey: "facilitiesGuide.providers.step5Description",
        targetSelector: '[data-facilities-guide-target="providers-api-key"]',
        targetActionKey: "facilitiesGuide.providers.step5Action",
        advanceOn: "input",
      },
      {
        titleKey: "facilitiesGuide.providers.step6Title",
        descriptionKey: "facilitiesGuide.providers.step6Description",
        targetSelector: '[data-facilities-guide-target="providers-request-model"]',
        targetActionKey: "facilitiesGuide.providers.step6Action",
        advanceOn: "manual",
      },
      {
        titleKey: "facilitiesGuide.providers.step7Title",
        descriptionKey: "facilitiesGuide.providers.step7Description",
        targetSelector: '[data-facilities-guide-target="providers-discover-models"]',
        targetActionKey: "facilitiesGuide.providers.step7Action",
        advanceOn: "manual",
      },
      {
        titleKey: "facilitiesGuide.providers.step8Title",
        descriptionKey: "facilitiesGuide.providers.step8Description",
        targetSelector:
          '[data-facilities-guide-target="providers-select-model"], [data-facilities-guide-target="providers-manual-model-input"]',
        targetActionKey: "facilitiesGuide.providers.step8Action",
        advanceOn: "manual",
      },
      {
        titleKey: "facilitiesGuide.providers.step9Title",
        descriptionKey: "facilitiesGuide.providers.step9Description",
        targetSelector: '[data-facilities-guide-target="providers-save-channel"]',
        targetActionKey: "facilitiesGuide.providers.step9Action",
      },
    ],
  },
  runtime: {
    steps: [
      {
        titleKey: "facilitiesGuide.runtime.step1Title",
        descriptionKey: "facilitiesGuide.runtime.step1Description",
        targetSelector: '[data-facilities-guide-target="runtime-drivers"]',
        targetActionKey: "facilitiesGuide.runtime.step1Action",
      },
      {
        titleKey: "facilitiesGuide.runtime.step2Title",
        descriptionKey: "facilitiesGuide.runtime.step2Description",
        targetSelector: '[data-facilities-guide-target="runtime-capabilities"]',
        targetActionKey: "facilitiesGuide.runtime.step2Action",
      },
      {
        titleKey: "facilitiesGuide.runtime.step3Title",
        descriptionKey: "facilitiesGuide.runtime.step3Description",
        targetSelector: '[data-facilities-guide-target="runtime-delegation"]',
        targetActionKey: "facilitiesGuide.runtime.step3Action",
        advanceOn: "manual",
      },
    ],
  },
  team: {
    steps: [
      {
        titleKey: "facilitiesGuide.team.step1Title",
        descriptionKey: "facilitiesGuide.team.step1Description",
        targetSelector: '[data-facilities-guide-target="team-builder"]',
        targetActionKey: "facilitiesGuide.team.step1Action",
      },
      {
        titleKey: "facilitiesGuide.team.step2Title",
        descriptionKey: "facilitiesGuide.team.step2Description",
        targetSelector: '[data-facilities-guide-target="team-run"]',
        targetActionKey: "facilitiesGuide.team.step2Action",
      },
      {
        titleKey: "facilitiesGuide.team.step3Title",
        descriptionKey: "facilitiesGuide.team.step3Description",
        targetSelector: '[data-facilities-guide-target="team-control"]',
        targetActionKey: "facilitiesGuide.team.step3Action",
      },
      {
        titleKey: "facilitiesGuide.team.step4Title",
        descriptionKey: "facilitiesGuide.team.step4Description",
        targetSelector: '[data-facilities-guide-target="team-runtime"]',
        targetActionKey: "facilitiesGuide.team.step4Action",
        advanceOn: "manual",
      },
    ],
  },
  automations: {
    steps: [
      {
        titleKey: "facilitiesGuide.automations.step1Title",
        descriptionKey: "facilitiesGuide.automations.step1Description",
        targetSelector: '[data-facilities-guide-target="automation-editor"]',
        targetActionKey: "facilitiesGuide.automations.step1Action",
      },
      {
        titleKey: "facilitiesGuide.automations.step2Title",
        descriptionKey: "facilitiesGuide.automations.step2Description",
        targetSelector: '[data-facilities-guide-target="automation-trigger"]',
        targetActionKey: "facilitiesGuide.automations.step2Action",
      },
      {
        titleKey: "facilitiesGuide.automations.step3Title",
        descriptionKey: "facilitiesGuide.automations.step3Description",
        targetSelector: '[data-facilities-guide-target="automation-context"]',
        targetActionKey: "facilitiesGuide.automations.step3Action",
      },
      {
        titleKey: "facilitiesGuide.automations.step4Title",
        descriptionKey: "facilitiesGuide.automations.step4Description",
        targetSelector: '[data-facilities-guide-target="automation-history"]',
        targetActionKey: "facilitiesGuide.automations.step4Action",
        advanceOn: "manual",
      },
    ],
  },
  "workspace-scripts": {
    steps: [
      {
        titleKey: "facilitiesGuide.workspaceScripts.step1Title",
        descriptionKey: "facilitiesGuide.workspaceScripts.step1Description",
        targetSelector: '[data-facilities-guide-target="workspace-project"]',
        targetActionKey: "facilitiesGuide.workspaceScripts.step1Action",
      },
      {
        titleKey: "facilitiesGuide.workspaceScripts.step2Title",
        descriptionKey: "facilitiesGuide.workspaceScripts.step2Description",
        targetSelector: '[data-facilities-guide-target="workspace-declared"]',
        targetActionKey: "facilitiesGuide.workspaceScripts.step2Action",
      },
      {
        titleKey: "facilitiesGuide.workspaceScripts.step3Title",
        descriptionKey: "facilitiesGuide.workspaceScripts.step3Description",
        targetSelector: '[data-facilities-guide-target="workspace-start"]',
        targetActionKey: "facilitiesGuide.workspaceScripts.step3Action",
      },
      {
        titleKey: "facilitiesGuide.workspaceScripts.step4Title",
        descriptionKey: "facilitiesGuide.workspaceScripts.step4Description",
        targetSelector: '[data-facilities-guide-target="workspace-runs"]',
        targetActionKey: "facilitiesGuide.workspaceScripts.step4Action",
        advanceOn: "manual",
      },
    ],
  },
};

export function FacilitiesQuickGuide({
  guideId,
  steps,
  concepts = EMPTY_CONCEPTS,
  empty = false,
}: {
  readonly guideId: string;
  readonly steps?: ReadonlyArray<FacilitiesGuideStep>;
  readonly concepts?: ReadonlyArray<FacilitiesGuideConcept>;
  /** True while the page has nothing configured: the entry is promoted so beginners notice it. */
  readonly empty?: boolean;
}) {
  const preset = GUIDE_PRESETS[guideId];
  const resolvedSteps = useMemo(() => steps ?? preset?.steps ?? [], [preset?.steps, steps]);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = resolvedSteps[Math.min(stepIndex, Math.max(0, resolvedSteps.length - 1))];
  const isLastStep = stepIndex >= resolvedSteps.length - 1;
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(null);
  const [calloutSize, setCalloutSize] = useState<GuideCalloutSize | null>(null);
  const calloutRef = useRef<HTMLElement | null>(null);

  const refreshTarget = useCallback(() => {
    if (!open || !currentStep?.targetSelector) {
      setTargetRect((previous) => (previous === null ? previous : null));
      setDialogContainer(null);
      return;
    }
    const element = findGuideTarget(currentStep.targetSelector);
    // 引导参与当前弹窗的焦点范围，避免按钮被弹窗标记为不可访问。
    setDialogContainer(element?.closest<HTMLElement>('[data-slot="dialog-popup"]') ?? null);
    const nextRect = element ? guideTargetRect(element) : null;
    setTargetRect((previous) => (sameRect(previous, nextRect) ? previous : nextRect));
  }, [currentStep?.targetSelector, open]);

  useLayoutEffect(() => {
    if (!open) {
      setCalloutSize((previous) => (previous === null ? previous : null));
      return;
    }
    const callout = calloutRef.current;
    if (!callout) return;
    const updateSize = () => {
      const rect = callout.getBoundingClientRect();
      setCalloutSize((previous) =>
        previous && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(callout);
    return () => observer.disconnect();
  }, [concepts.length, currentStep?.descriptionKey, currentStep?.titleKey, open, stepIndex]);

  useEffect(() => {
    if (!open || !currentStep?.targetSelector) return;
    let frame = 0;
    let observer: MutationObserver | undefined;
    const revealTarget = () => {
      const target = findGuideTarget(currentStep.targetSelector!);
      if (!target) {
        refreshTarget();
        return;
      }
      const closedContainer = target.closest<HTMLElement>('[data-state="closed"]');
      const trigger = closedContainer?.querySelector<HTMLElement>(
        '[data-slot="collapsible-trigger"], button',
      );
      if (trigger && !target.contains(trigger)) trigger.click();
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      refreshTarget();
      frame = window.requestAnimationFrame(() => refreshTarget());
      observer?.disconnect();
    };
    frame = window.requestAnimationFrame(revealTarget);
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(revealTarget);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [currentStep?.targetSelector, open, refreshTarget]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    calloutRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) calloutRef.current?.focus({ preventScroll: true });
  }, [open, stepIndex, dialogContainer]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      closeGuideOnEscape(event, () => setOpen(false));
    };
    refreshTarget();
    const onViewportChange = () => refreshTarget();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onViewportChange, true);
    const observer = new MutationObserver(onViewportChange);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onViewportChange, true);
      observer.disconnect();
    };
  }, [open, refreshTarget]);

  useEffect(() => {
    // 输入由用户确认完成，避免首个字符或点击预填值就跳到下一步。
    if (!open || !currentStep?.targetSelector || !guideStepAdvancesOnClick(currentStep)) return;
    const onTargetAction = (event: Event) => {
      const target = findGuideTarget(currentStep.targetSelector!);
      if (
        !(target instanceof Element) ||
        !(event.target instanceof Node) ||
        !target.contains(event.target)
      ) {
        return;
      }
      setStepIndex((index) => Math.min(index + 1, resolvedSteps.length - 1));
    };
    document.addEventListener("click", onTargetAction, true);
    return () => {
      document.removeEventListener("click", onTargetAction, true);
    };
  }, [currentStep, open, resolvedSteps.length]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    setTargetRect(null);
    setCalloutSize(null);
    if (next) setStepIndex(0);
  };

  const guidePosition = targetRect ? calculateGuidePosition(targetRect, calloutSize) : null;
  const containerRect = dialogContainer?.getBoundingClientRect();
  const localPosition = (left: number, top: number): CSSProperties =>
    containerRect?.width && containerRect.height && dialogContainer
      ? {
          position: "absolute",
          left: (left - containerRect.left) / (containerRect.width / dialogContainer.offsetWidth),
          top: (top - containerRect.top) / (containerRect.height / dialogContainer.offsetHeight),
        }
      : { left, top };

  const guideOverlay = open ? (
    <>
      <div className="pointer-events-none fixed inset-0 z-[1000] bg-black/20" aria-hidden />
      {targetRect ? (
        <div
          className="pointer-events-none fixed z-[1001] rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background shadow-[0_0_0_9999px_rgba(0,0,0,0.42)]"
          style={{
            ...localPosition(targetRect.left - 6, targetRect.top - 6),
            width: targetRect.width + 12,
            height: targetRect.height + 12,
          }}
          aria-hidden
        />
      ) : null}
      <aside
        ref={calloutRef}
        role="dialog"
        tabIndex={-1}
        aria-label={currentStep ? t(currentStep.titleKey) : t("facilitiesGuide.title")}
        className="fixed z-[1002] max-h-[min(70vh,32rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl"
        style={
          guidePosition
            ? localPosition(guidePosition.left, guidePosition.top)
            : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
        }
        data-facilities-guide-callout={guideId}
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {resolvedSteps.length === 0 ? "!" : stepIndex + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                {resolvedSteps.length > 0
                  ? t("facilitiesGuide.stepCount", {
                      current: stepIndex + 1,
                      total: resolvedSteps.length,
                    })
                  : t("facilitiesGuide.empty")}
              </p>
              {targetRect ? (
                guidePosition?.placement === "top" ? (
                  <ArrowDownIcon className="size-4 text-primary" aria-hidden />
                ) : guidePosition?.placement === "bottom" ? (
                  <ArrowUpIcon className="size-4 text-primary" aria-hidden />
                ) : guidePosition?.placement === "left" ? (
                  <ArrowRightIcon className="size-4 text-primary" aria-hidden />
                ) : (
                  <ArrowLeftIcon className="size-4 text-primary" aria-hidden />
                )
              ) : null}
            </div>
            <h3 aria-live="polite" className="text-sm font-semibold text-foreground">
              {currentStep ? t(currentStep.titleKey) : t("facilitiesGuide.title")}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {currentStep ? t(currentStep.descriptionKey) : t("facilitiesGuide.empty")}
            </p>
            {currentStep?.targetActionKey ? (
              <p className="rounded-md bg-primary/8 px-2.5 py-2 text-xs font-medium text-foreground">
                {t(currentStep.targetActionKey)}
              </p>
            ) : null}
            {currentStep?.linkTo && currentStep.linkLabelKey ? (
              <Button size="xs" variant="outline" render={<Link to={currentStep.linkTo} />}>
                {t(currentStep.linkLabelKey)}
                <ArrowRightIcon />
              </Button>
            ) : null}
          </div>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={t("commandPalette.close")}
            onClick={() => setOpen(false)}
          >
            <XIcon />
          </Button>
        </div>
        {concepts.length > 0 ? (
          <details className="mt-4 border-t border-border/60 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              {t("facilitiesGuide.conceptsTitle")}
            </summary>
            <dl className="mt-3 grid gap-2">
              {concepts.map((concept) => (
                <div
                  key={concept.termKey}
                  className="grid gap-0.5 sm:grid-cols-[8rem_1fr] sm:gap-3"
                >
                  <dt className="text-xs font-medium text-foreground">{t(concept.termKey)}</dt>
                  <dd className="text-xs leading-relaxed text-muted-foreground">
                    {t(concept.descriptionKey)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
          >
            <ArrowLeftIcon />
            {t("facilitiesGuide.previous")}
          </Button>
          <Button
            size="xs"
            onClick={() => (isLastStep ? setOpen(false) : setStepIndex((index) => index + 1))}
          >
            {isLastStep ? <CheckIcon /> : null}
            {isLastStep ? t("facilitiesGuide.done") : t("facilitiesGuide.next")}
            {isLastStep ? null : <ArrowRightIcon />}
          </Button>
        </div>
      </aside>
    </>
  ) : null;

  return (
    <>
      {empty ? (
        <p className="hidden max-w-44 text-end text-[11px] leading-snug text-muted-foreground sm:block">
          {t("facilitiesGuide.emptyHint")}
        </p>
      ) : null}
      <Button
        data-slot="dialog-trigger"
        size="xs"
        variant={empty ? "default" : "outline"}
        aria-label={t("facilitiesGuide.open")}
        aria-expanded={open}
        onClick={() => handleOpenChange(true)}
      >
        <CompassIcon />
        {t("facilitiesGuide.open")}
      </Button>
      {guideOverlay && typeof document !== "undefined"
        ? createPortal(guideOverlay, dialogContainer ?? document.body)
        : null}
    </>
  );
}
