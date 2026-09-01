import type { ThreadGoal, ProviderInteractionMode } from "@codework/contracts";
import {
  CheckIcon,
  FileTextIcon,
  GoalIcon,
  LightbulbIcon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ThreadGoalStatusBar } from "./ThreadGoalStatusBar";

type ComposerAddMenuPluginItem = Pick<
  CommandPaletteActionItem,
  "value" | "title" | "description" | "icon" | "run"
>;

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
}) {
  return (
    <button
      type="button"
      className="group flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
      disabled={props.disabled}
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
          title={objective}
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
              title={objective}
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
