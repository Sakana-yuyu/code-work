import type {
  ProviderInteractionMode,
  SpecWorkflowStage,
  SpecWorkflowState,
  SpecWorkflowStatus,
  ThreadGoal,
} from "@codework/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  FileTextIcon,
  GoalIcon,
  LightbulbIcon,
  PauseIcon,
  PaperclipIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { t } from "~/i18n";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ThreadGoalStatusBar } from "./ThreadGoalStatusBar";

type ComposerAddMenuPluginItem = Pick<
  CommandPaletteActionItem,
  "value" | "title" | "description" | "icon" | "run"
>;

export interface ComposerSpecWorkflowControl {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly workflowState: SpecWorkflowState | null;
  readonly workflowStateIsPending: boolean;
  readonly workflowStateHasError: boolean;
  readonly onToggle: () => Promise<boolean>;
  readonly onApproveProposal: () => Promise<boolean>;
  readonly onRejectProposal: () => Promise<boolean>;
  readonly onCompleteAcceptance: () => Promise<boolean>;
  readonly onPause: () => Promise<boolean>;
  readonly onResume: () => Promise<boolean>;
}

export interface ComposerAddMenuProps {
  readonly disabled: boolean;
  readonly interactionMode: ProviderInteractionMode;
  readonly planModeEnabled: boolean;
  readonly canEditGoal: boolean;
  readonly goal: ThreadGoal | null;
  readonly draftObjective?: string | null;
  readonly goalIsPending: boolean;
  readonly goalErrorMessage: string | null;
  readonly pluginItems: ReadonlyArray<ComposerAddMenuPluginItem>;
  readonly onAddFileReference: () => boolean;
  readonly onAddSkillReference: () => boolean;
  readonly onTogglePlanMode: () => void;
  readonly onSelectGoal: () => void;
  readonly onSetGoal: (objective: string) => Promise<boolean>;
  readonly onPauseGoal: () => Promise<boolean>;
  readonly onResumeGoal: () => Promise<boolean>;
  readonly onClearGoal: () => Promise<boolean>;
  readonly onEditGoalInComposer?: () => void;
  readonly specWorkflow: ComposerSpecWorkflowControl;
}

export interface ComposerGoalControlProps {
  readonly goal: ThreadGoal | null;
  readonly draftObjective?: string | null;
  readonly goalIsPending: boolean;
  readonly goalErrorMessage: string | null;
  readonly onSetGoal: (objective: string) => Promise<boolean>;
  readonly onPauseGoal: () => Promise<boolean>;
  readonly onResumeGoal: () => Promise<boolean>;
  readonly onClearGoal: () => Promise<boolean>;
  readonly onEditGoalInComposer?: () => void;
}

function ComposerAddMenuItem(props: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly onClick: () => void;
  readonly trailing?: ReactNode;
  readonly disabled?: boolean;
  readonly ariaPressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="group flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
      disabled={props.disabled}
      aria-pressed={props.ariaPressed}
      onClick={props.onClick}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/65 text-muted-foreground transition-colors group-hover:text-foreground">
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{props.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{props.description}</span>
      </span>
      {props.trailing ? (
        <span className="shrink-0 text-muted-foreground">{props.trailing}</span>
      ) : null}
    </button>
  );
}

const specWorkflowStageLabelKey: Record<SpecWorkflowStage, string> = {
  idle: "composer.specWorkflowStage.idle",
  research: "composer.specWorkflowStage.research",
  ask: "composer.specWorkflowStage.ask",
  design: "composer.specWorkflowStage.design",
  propose: "composer.specWorkflowStage.propose",
  awaitingApproval: "composer.specWorkflowStage.awaitingApproval",
  revise: "composer.specWorkflowStage.revise",
  apply: "composer.specWorkflowStage.apply",
  verify: "composer.specWorkflowStage.verify",
  acceptance: "composer.specWorkflowStage.acceptance",
  archive: "composer.specWorkflowStage.archive",
};

const specWorkflowStatusLabelKey: Record<SpecWorkflowStatus, string> = {
  active: "composer.specWorkflowStatus.active",
  paused: "composer.specWorkflowStatus.paused",
  blocked: "composer.specWorkflowStatus.blocked",
  completed: "composer.specWorkflowStatus.completed",
};

function SpecWorkflowMenuStatus(props: {
  readonly control: ComposerSpecWorkflowControl;
  readonly onActionSucceeded: () => void;
}) {
  if (!props.control.enabled) return null;

  const state = props.control.workflowState;
  const actionDisabled =
    props.control.isPending ||
    props.control.workflowStateIsPending ||
    props.control.workflowStateHasError ||
    state === null;
  const runAction = (action: () => Promise<boolean>) => {
    void action()
      .then((changed) => {
        if (changed) props.onActionSucceeded();
      })
      .catch(() => undefined);
  };

  return (
    <div
      className="mx-2 mb-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-xs"
      data-composer-spec-workflow-status="true"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {props.control.workflowStateIsPending
            ? t("composer.specWorkflowStateLoading")
            : props.control.workflowStateHasError
              ? t("composer.specWorkflowStateLoadFailed")
              : state === null
                ? t("composer.specWorkflowNotStarted")
                : `${t(specWorkflowStageLabelKey[state.stage])} · ${t(specWorkflowStatusLabelKey[state.status])}`}
        </span>
      </div>
      {state !== null &&
      !props.control.workflowStateIsPending &&
      !props.control.workflowStateHasError ? (
        <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
          <span>{t("composer.specWorkflowChange")}</span>
          <span className="truncate text-foreground">{state.changeName}</span>
          <span>{t("composer.specWorkflowStage")}</span>
          <span>{t(specWorkflowStageLabelKey[state.stage])}</span>
          <span>{t("composer.specWorkflowStatus")}</span>
          <span>{t(specWorkflowStatusLabelKey[state.status])}</span>
        </div>
      ) : null}
      {state?.lastError ? (
        <div className="mt-1.5 flex items-start gap-1 text-destructive" role="alert">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{state.lastError}</span>
        </div>
      ) : null}
      {state?.stage === "awaitingApproval" && state.proposalStatus === "pending" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-7 px-2 text-xs"
            disabled={actionDisabled}
            onClick={() => runAction(props.control.onApproveProposal)}
          >
            <CheckIcon />
            {t("composer.specWorkflowApprove")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={actionDisabled}
            onClick={() => runAction(props.control.onRejectProposal)}
          >
            <XIcon />
            {t("composer.specWorkflowReject")}
          </Button>
        </div>
      ) : null}
      {state?.stage === "acceptance" && state.acceptanceStatus === "pending" ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="mt-2 h-7 px-2 text-xs"
          disabled={actionDisabled || state.status !== "active"}
          onClick={() => runAction(props.control.onCompleteAcceptance)}
        >
          <CheckIcon />
          {t("composer.specWorkflowCompleteAcceptance")}
        </Button>
      ) : null}
      {state?.status === "active" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-2 h-7 px-2 text-xs"
          disabled={actionDisabled}
          onClick={() => runAction(props.control.onPause)}
        >
          <PauseIcon />
          {t("composer.specWorkflowPause")}
        </Button>
      ) : state?.status === "paused" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-2 h-7 px-2 text-xs"
          disabled={actionDisabled}
          onClick={() => runAction(props.control.onResume)}
        >
          <PlayIcon />
          {t("composer.specWorkflowResume")}
        </Button>
      ) : null}
    </div>
  );
}

export function ComposerGoalControl(props: ComposerGoalControlProps) {
  const objective = props.goal?.objective ?? props.draftObjective ?? t("composer.addGoal");
  const disabled = props.goalIsPending;

  if (props.goal === null) {
    return (
      <div className="group flex min-w-0 max-w-[min(24rem,45vw)] items-center rounded-lg text-xs">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
          aria-label={t("composer.addGoal")}
          disabled={disabled}
          onClick={props.onEditGoalInComposer}
        >
          <GoalIcon className="size-3.5 shrink-0" />
          <span className="truncate">{t("composer.addGoal")}</span>
        </button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="-ms-1 size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t("threadGoal.clear")}
          disabled={disabled}
          onClick={() => void props.onClearGoal()}
        >
          <XIcon />
        </Button>
      </div>
    );
  }

  return (
    <Popover>
      <div className="group flex min-w-0 max-w-[min(24rem,45vw)] items-center rounded-lg text-xs">
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
              aria-label={t("composer.addGoal")}
              disabled={disabled}
            />
          }
        >
          <GoalIcon className="size-3.5 shrink-0" />
          <span className="truncate">{t("composer.addGoal")}</span>
        </PopoverTrigger>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="-ms-1 size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t("threadGoal.clear")}
          disabled={disabled}
          onClick={() => void props.onClearGoal()}
        >
          <XIcon />
        </Button>
      </div>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        viewportClassName="p-0"
        className="w-[min(25rem,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-2xl"
      >
        <div className="p-2">
          <ThreadGoalStatusBar
            goal={props.goal}
            draftObjective={props.draftObjective}
            isPending={props.goalIsPending}
            errorMessage={props.goalErrorMessage}
            initialEditing={false}
            presentation="menu"
            className="border-0 bg-transparent px-1 py-1 shadow-none"
            {...(props.onEditGoalInComposer
              ? { onEditInComposer: props.onEditGoalInComposer }
              : {})}
            onSetGoal={props.onSetGoal}
            onPause={props.onPauseGoal}
            onResume={props.onResumeGoal}
            onClear={props.onClearGoal}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ComposerAddMenu(props: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);

  const runPlugin = (item: ComposerAddMenuPluginItem) => {
    void item
      .run()
      .catch(() => undefined)
      .finally(() => setOpen(false));
  };

  const goalDescription = props.canEditGoal
    ? (props.goal?.objective ?? props.draftObjective ?? t("threadGoal.objectivePlaceholder"))
    : t("composer.addGoalDisabledDescription");
  const planDescription =
    props.interactionMode === "plan"
      ? t("switchThisThreadBackToNormalBuildMode")
      : t("switchThisThreadIntoPlanMode");
  const specWorkflowDescription = !props.specWorkflow.available
    ? t("composer.specWorkflowRequiresThread")
    : props.specWorkflow.isPending
      ? t("composer.specWorkflowLoading")
      : props.specWorkflow.hasError
        ? t("composer.specWorkflowLoadFailed")
        : props.specWorkflow.enabled
          ? t("composer.specWorkflowEnabledDescription")
          : t("composer.specWorkflowDisabledDescription");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
            aria-label={t("add")}
            disabled={props.disabled}
            data-composer-add-trigger="true"
          />
        }
      >
        <PlusIcon className="size-4" strokeWidth={2.25} />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        viewportClassName="p-0"
        className="w-[min(25rem,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-2xl"
        data-composer-add-menu="true"
      >
        <div className="p-1.5">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t("add")}</div>
          <ComposerAddMenuItem
            icon={<PaperclipIcon className="size-4" />}
            title={t("composer.addFilesAndFolders")}
            description={t("composer.addFilesAndFoldersDescription")}
            disabled={props.disabled}
            onClick={() => {
              if (props.onAddFileReference()) setOpen(false);
            }}
          />
          <ComposerAddMenuItem
            icon={<SparklesIcon className="size-4" />}
            title={t("composer.addSkill")}
            description={t("composer.addSkillDescription")}
            disabled={props.disabled}
            onClick={() => {
              if (props.onAddSkillReference()) setOpen(false);
            }}
          />
          <ComposerAddMenuItem
            icon={<GoalIcon className="size-4" />}
            title={t("composer.addGoal")}
            description={goalDescription}
            disabled={props.disabled || !props.canEditGoal}
            onClick={() => {
              props.onSelectGoal();
              setOpen(false);
            }}
            trailing={
              props.goal ? <span className="size-1.5 rounded-full bg-emerald-500" /> : undefined
            }
          />
          <ComposerAddMenuItem
            icon={<LightbulbIcon className="size-4" />}
            title={t("composer.planMode")}
            description={
              props.planModeEnabled ? planDescription : t("composer.planModeDisabledDescription")
            }
            disabled={props.disabled || !props.planModeEnabled}
            onClick={() => {
              props.onTogglePlanMode();
              setOpen(false);
            }}
            trailing={
              props.interactionMode === "plan" ? <CheckIcon className="size-4" /> : undefined
            }
          />
          <div className="mt-1 border-t border-border/60 px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
            {t("composer.specWorkflowSection")}
          </div>
          <ComposerAddMenuItem
            icon={<WorkflowIcon className="size-4" />}
            title={t("composer.specWorkflow")}
            description={specWorkflowDescription}
            disabled={
              props.disabled ||
              !props.specWorkflow.available ||
              props.specWorkflow.isPending ||
              props.specWorkflow.hasError
            }
            ariaPressed={props.specWorkflow.enabled}
            onClick={() => {
              void props.specWorkflow
                .onToggle()
                .then((changed) => {
                  if (changed) setOpen(false);
                })
                .catch(() => undefined);
            }}
            trailing={
              props.specWorkflow.enabled ? (
                <CheckIcon className="size-4" />
              ) : (
                <span className="size-1.5 rounded-full bg-muted-foreground/50" />
              )
            }
          />
          <SpecWorkflowMenuStatus
            control={props.specWorkflow}
            onActionSucceeded={() => setOpen(false)}
          />
          <div className="mt-1 border-t border-border/60 px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
            {t("localPlugins.title")}
          </div>
          {props.pluginItems.length > 0 ? (
            props.pluginItems.map((item) => (
              <ComposerAddMenuItem
                key={item.value}
                icon={item.icon ?? <FileTextIcon className="size-4" />}
                title={item.title}
                description={item.description ?? t("localPlugins.title")}
                disabled={props.disabled}
                onClick={() => runPlugin(item)}
              />
            ))
          ) : (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              {t("localPlugins.empty")}
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
