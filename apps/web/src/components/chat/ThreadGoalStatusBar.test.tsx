import type { ThreadGoal } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { t } from "~/i18n";
import {
  ThreadGoalComposerControl,
  ThreadGoalStatusBar,
  displayedThreadGoalSeconds,
  formatThreadGoalDuration,
} from "./ThreadGoalStatusBar";

const goal = (status: ThreadGoal["status"] = "active"): ThreadGoal => ({
  threadId: "thread-1" as ThreadGoal["threadId"],
  goalId: "goal-1" as ThreadGoal["goalId"],
  objective: "Keep the release green",
  status,
  createdAt: 1,
  updatedAt: 2,
  timeUsedSeconds: 3,
  tokenBudget: 100,
  tokensUsed: 20,
});

describe("ThreadGoalStatusBar", () => {
  it("renders an accessible compact Composer control for an empty goal", () => {
    const markup = renderToStaticMarkup(
      <ThreadGoalComposerControl disabled={false} onClick={() => undefined} />,
    );

    expect(markup).toContain('aria-label="' + t("threadGoal.set") + '"');
    expect(markup).toContain("sr-only");
  });

  it("formats goal duration", () => {
    expect(formatThreadGoalDuration(65)).toBe("1m 05s");
    expect(formatThreadGoalDuration(3_725)).toBe("1h 02m");
  });

  it("adds live elapsed time only while the goal is active", () => {
    expect(displayedThreadGoalSeconds(goal(), 5_000, 2_000)).toBe(6);
    expect(displayedThreadGoalSeconds(goal("paused"), 5_000, 2_000)).toBe(3);
  });

  it("renders the active goal and exposes pause/edit/clear controls", () => {
    const markup = renderToStaticMarkup(
      <ThreadGoalStatusBar
        goal={goal()}
        isPending={false}
        errorMessage={null}
        onSetGoal={() => Promise.resolve(true)}
        onPause={() => Promise.resolve(true)}
        onResume={() => Promise.resolve(true)}
        onClear={() => Promise.resolve(true)}
      />,
    );

    expect(markup).toContain("Keep the release green");
    expect(markup).toContain('data-thread-goal-status="active"');
    expect(markup).toContain(`aria-label="${t("threadGoal.pause")}"`);
    expect(markup).toContain(`aria-label="${t("threadGoal.edit")}"`);
    expect(markup).toContain(`aria-label="${t("threadGoal.clear")}"`);
    expect(markup).toContain("0m 03s");
    expect(markup).toContain(`aria-label="${t("threadGoal.details")}"`);
    expect(markup).toContain("flex-nowrap");
    expect(markup).toContain("lucide-goal");
    expect(markup).toContain("lucide-maximize-2");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup.match(/<form/g) ?? []).toHaveLength(0);
  });

  it("renders an empty create affordance without inventing a goal", () => {
    const markup = renderToStaticMarkup(
      <ThreadGoalStatusBar
        goal={null}
        isPending={false}
        errorMessage={null}
        onSetGoal={() => Promise.resolve(true)}
        onPause={() => Promise.resolve(true)}
        onResume={() => Promise.resolve(true)}
        onClear={() => Promise.resolve(true)}
      />,
    );

    expect(markup).toContain(`aria-label="${t("threadGoal.set")}"`);
    expect(markup).not.toContain("Keep the release green");
  });

  it("keeps lifecycle controls disabled while a command is pending", () => {
    const markup = renderToStaticMarkup(
      <ThreadGoalStatusBar
        goal={goal("paused")}
        isPending={true}
        errorMessage={null}
        onSetGoal={() => Promise.resolve(true)}
        onPause={() => Promise.resolve(true)}
        onResume={() => Promise.resolve(true)}
        onClear={() => Promise.resolve(true)}
      />,
    );

    expect(markup).toContain('data-thread-goal-status="paused"');
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("maps every persisted status to its label and legal controls", () => {
    const statuses: Array<ThreadGoal["status"]> = [
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ];
    const statusLabels: Record<ThreadGoal["status"], string> = {
      active: t("threadGoal.status.active"),
      paused: t("threadGoal.status.paused"),
      blocked: t("threadGoal.status.blocked"),
      usageLimited: t("threadGoal.status.usageLimited"),
      budgetLimited: t("threadGoal.status.budgetLimited"),
      complete: t("threadGoal.status.complete"),
    };

    for (const status of statuses) {
      const markup = renderToStaticMarkup(
        <ThreadGoalStatusBar
          goal={goal(status)}
          isPending={false}
          errorMessage={null}
          onSetGoal={() => Promise.resolve(true)}
          onPause={() => Promise.resolve(true)}
          onResume={() => Promise.resolve(true)}
          onClear={() => Promise.resolve(true)}
        />,
      );
      expect(markup).toContain(`data-thread-goal-status="${status}"`);
      expect(markup).toContain(statusLabels[status]);
      expect(markup).toContain(`aria-label="${t("threadGoal.details")}"`);
      expect(markup).toContain(`aria-label="${t("threadGoal.clear")}"`);
      expect(markup).toContain(
        `aria-label="${t(status === "active" ? "threadGoal.pause" : status === "paused" ? "threadGoal.resume" : "threadGoal.clear")}"`,
      );
    }
  });

  it("does not offer editing for a completed goal", () => {
    const markup = renderToStaticMarkup(
      <ThreadGoalStatusBar
        goal={goal("complete")}
        isPending={false}
        errorMessage={null}
        onSetGoal={() => Promise.resolve(true)}
        onPause={() => Promise.resolve(true)}
        onResume={() => Promise.resolve(true)}
        onClear={() => Promise.resolve(true)}
      />,
    );

    expect(markup).not.toContain(`aria-label="${t("threadGoal.edit")}"`);
    expect(markup).toContain(`aria-label="${t("threadGoal.clear")}"`);
  });
});
