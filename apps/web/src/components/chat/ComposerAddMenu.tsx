import type { ThreadGoal, ProviderInteractionMode } from "@codework/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  FileTextIcon,
  FlagIcon,
  LightbulbIcon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

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
  readonly goalIsPending: boolean;
  readonly goalErrorMessage: string | null;
  readonly pluginItems: ReadonlyArray<ComposerAddMenuPluginItem>;
  readonly onAddFileReference: () => boolean;
  readonly onAddSkillReference: () => boolean;
  readonly onTogglePlanMode: () => void;
  readonly onSetGoal: (objective: string) => Promise<boolean>;
  readonly onPauseGoal: () => Promise<boolean>;
  readonly onResumeGoal: () => Promise<boolean>;
  readonly onClearGoal: () => Promise<boolean>;
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

export function ComposerAddMenu(props: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "goal">("root");

  useEffect(() => {
    if (!open) setView("root");
  }, [open]);

  const runPlugin = (item: ComposerAddMenuPluginItem) => {
    void item
      .run()
      .catch(() => undefined)
      .finally(() => setOpen(false));
  };

  const goalDescription = props.canEditGoal
    ? (props.goal?.objective ?? t("threadGoal.objectivePlaceholder"))
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
        {view === "goal" ? (
          <div className="p-2">
            <div className="flex items-center gap-1 px-1 pb-2">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t("back")}
                onClick={() => setView("root")}
              >
                <ArrowLeftIcon />
              </Button>
              <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-foreground">
                {t("threadGoal.title")}
              </div>
            </div>
            <ThreadGoalStatusBar
              goal={props.goal}
              isPending={props.goalIsPending}
              errorMessage={props.goalErrorMessage}
              initialEditing={props.goal === null}
              presentation="menu"
              className="border-0 bg-transparent px-1 py-1 shadow-none"
              onEmptyEditorClose={() => setView("root")}
              onSetGoal={props.onSetGoal}
              onPause={props.onPauseGoal}
              onResume={props.onResumeGoal}
              onClear={props.onClearGoal}
            />
          </div>
        ) : (
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
              icon={<FlagIcon className="size-4" />}
              title={t("composer.addGoal")}
              description={goalDescription}
              disabled={props.disabled || !props.canEditGoal}
              onClick={() => setView("goal")}
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
        )}
      </PopoverPopup>
    </Popover>
  );
}
