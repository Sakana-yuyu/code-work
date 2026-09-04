import type { ContextMenuItem, ScopedThreadRef } from "@codework/contracts";
import type { SnoozePreset } from "@codework/client-runtime/state/thread-settled";
import { scopedThreadKey } from "@codework/client-runtime/environment";
import { t } from "~/i18n/runtime";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "open-in-split"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

/**
 * "Open beside" only means something for a thread that is not already on
 * screen: the main-view thread and the split-pane thread are both excluded,
 * otherwise the action would silently do nothing.
 */
export function canOpenThreadBeside(
  threadKey: string,
  primaryThreadRef: ScopedThreadRef | null,
  secondaryThreadRef: ScopedThreadRef | null,
): boolean {
  if (primaryThreadRef && scopedThreadKey(primaryThreadRef) === threadKey) return false;
  if (secondaryThreadRef && scopedThreadKey(secondaryThreadRef) === threadKey) return false;
  return true;
}

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an active turn, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  /**
   * False when the thread is already on screen (the main view or the split
   * pane): opening it beside would be a silent no-op, so the item stays
   * visible but disabled instead.
   */
  readonly canOpenBeside: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu both render exactly this list, so labels,
 * ordering, and capability gating cannot drift between the two surfaces.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    {
      id: "open-in-split",
      label: t("openThreadBeside"),
      icon: "message-square-plus",
      disabled: !state.canOpenBeside,
    },
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: t("newThreadOn", { branch: state.branch }),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: t("unpinThread"), icon: "pin-off" }
            : { id: "pin" as const, label: t("pinThread"), icon: "pin" },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: t("unSettleThread2"), icon: "circle-check" }
            : { id: "settle" as const, label: t("settleThread2"), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: t("wakeThread"), icon: "clock" }
            : {
                id: "snooze" as const,
                label: t("snooze2"),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: state.snoozePresets.map((preset) => ({
                  id: `snooze:${preset.id}` as const,
                  label: `${t(preset.labelKey)} (${preset.whenLabel})`,
                })),
              },
        ]
      : []),
    { id: "rename", label: t("renameThread"), icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? t("regenerating2") : t("regenerateTitle"),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: t("markUnread"), icon: "mail-open" },
    {
      id: "copy",
      label: t("copy"),
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: t("path"), icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: t("gitCommit.branch"), icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: t("threadId2"), icon: "hash" },
      ],
    },
    // Archive removes the thread from the sidebar while keeping its
    // conversation under Settings > Archived threads — distinct from Settle
    // (stays visible in the Settled shelf) and Delete (clears history for
    // good), so it sits beside Delete without borrowing its destructive
    // styling.
    {
      id: "archive",
      label: t("settleThread"),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: t("delete"),
      destructive: true,
      icon: "trash",
    },
  ];
}
