import type { DesktopTrayRecentItem } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronShell from "./ElectronShell.ts";
import { t } from "../i18n.js";

const MAX_RECENT_TRAY_ITEMS = 24;
const MAX_TRAY_ITEMS_PER_SECTION = 3;
const MAX_TRAY_TITLE_LENGTH = 72;
const FEEDBACK_URL = "https://github.com/Sakana-yuyu/code-work/issues/new";

export interface ElectronTrayRecentItem extends DesktopTrayRecentItem {}

export function normalizeTrayRecentItems(
  items: readonly DesktopTrayRecentItem[],
): ReadonlyArray<ElectronTrayRecentItem> {
  const seen = new Set<string>();
  const normalized: ElectronTrayRecentItem[] = [];

  for (const item of items) {
    const environmentId = item.environmentId.trim();
    const projectId = item.projectId.trim();
    const threadId = item.threadId.trim();
    if (!environmentId || !projectId || !threadId) continue;

    const key = `${environmentId}\u0000${threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      environmentId,
      projectId,
      threadId,
      projectTitle: item.projectTitle.trim(),
      threadTitle: item.threadTitle.trim(),
      updatedAt: item.updatedAt,
      isRunning: item.isRunning,
      isPinned: item.isPinned,
    });
    if (normalized.length >= MAX_RECENT_TRAY_ITEMS) break;
  }

  return normalized;
}

export function trayThreadAction(
  item: Pick<DesktopTrayRecentItem, "environmentId" | "threadId">,
): string {
  return `open-thread:${encodeURIComponent(item.environmentId)}:${encodeURIComponent(item.threadId)}`;
}

function clipTitle(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim() || fallback;
  return normalized.length > MAX_TRAY_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TRAY_TITLE_LENGTH - 1)}…`
    : normalized;
}

function formatRecentItemLabel(item: DesktopTrayRecentItem, platform: NodeJS.Platform): string {
  const threadTitle = clipTitle(item.threadTitle, t("tray.conversation"));
  if (platform === "darwin") return threadTitle;
  return `${threadTitle} · ${clipTitle(item.projectTitle, t("tray.project"))}`;
}

type ElectronTrayRuntimeServices =
  | DesktopAssets.DesktopAssets
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronShell.ElectronShell;

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly configure: Effect.Effect<void>;
    readonly updateRecentItems: (items: readonly DesktopTrayRecentItem[]) => Effect.Effect<void>;
  }
>()("@codework/desktop/electron/ElectronTray") {}

const {
  logInfo: logTrayInfo,
  logWarning: logTrayWarning,
  logError: logTrayError,
} = DesktopObservability.makeComponentLogger("desktop-tray");

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronShell = yield* ElectronShell.ElectronShell;
  const recentItems = yield* Ref.make<ReadonlyArray<ElectronTrayRecentItem>>([]);
  const context = yield* Effect.context<ElectronTrayRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  let tray: Electron.Tray | undefined;

  const runTrayAction = <E>(
    action: string,
    effect: Effect.Effect<void, E, ElectronTrayRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.tray.action"),
        Effect.catchCause((cause) => logTrayError("tray action failed", { action, cause })),
      ),
    );
  };

  const rebuildMenu = Effect.gen(function* () {
    if (tray === undefined) return;

    const items = yield* Ref.get(recentItems);
    const sections = [
      { label: t("tray.running"), items: items.filter((item) => item.isRunning) },
      {
        label: t("tray.pinned"),
        items: items.filter((item) => !item.isRunning && item.isPinned),
      },
      {
        label: t("tray.recentConversations"),
        items: items.filter((item) => !item.isRunning && !item.isPinned),
      },
    ];
    const visibleSections = sections.filter((section) => section.items.length > 0);
    const recentMenuItem = (item: ElectronTrayRecentItem) => ({
      label: formatRecentItemLabel(item, environment.platform),
      sublabel: clipTitle(item.projectTitle, t("tray.project")),
      click: () => {
        runTrayAction(
          "open-recent-thread",
          desktopWindow.dispatchMenuAction(trayThreadAction(item)),
        );
      },
    });
    const recentMenu =
      visibleSections.length > 0
        ? visibleSections.flatMap((section) => [
            { type: "separator" as const },
            { label: section.label, enabled: false },
            ...section.items.slice(0, MAX_TRAY_ITEMS_PER_SECTION).map(recentMenuItem),
          ])
        : [
            { type: "separator" as const },
            { label: t("tray.noRecentConversations"), enabled: false },
          ];
    const overflowItems = visibleSections.flatMap((section) =>
      section.items.slice(MAX_TRAY_ITEMS_PER_SECTION).map(recentMenuItem),
    );
    const moreItems = [
      {
        label: t("tray.openCodeWork"),
        click: () => runTrayAction("show-window", desktopWindow.activate),
      },
      {
        label: t("settings"),
        click: () =>
          runTrayAction("open-settings", desktopWindow.dispatchMenuAction("open-settings")),
      },
      ...(overflowItems.length > 0
        ? [
            { type: "separator" as const },
            { label: t("tray.moreRecentConversations"), enabled: false },
            ...overflowItems,
          ]
        : []),
    ];

    yield* Effect.sync(() => {
      tray?.setContextMenu(
        Electron.Menu.buildFromTemplate([
          ...recentMenu,
          { type: "separator" },
          {
            label: t("tray.more"),
            submenu: moreItems,
          },
          { type: "separator" },
          {
            label: t("tray.newChat"),
            click: () =>
              runTrayAction("new-conversation", desktopWindow.dispatchMenuAction("new-thread")),
          },
          {
            label: t("tray.sendFeedback"),
            click: () =>
              runTrayAction(
                "send-feedback",
                electronShell.openExternal(FEEDBACK_URL).pipe(Effect.asVoid),
              ),
          },
          { type: "separator" },
          {
            label: t("tray.quit"),
            click: () => runTrayAction("quit", electronApp.quit),
          },
        ]),
      );
    });
  });

  const configure = Effect.gen(function* () {
    if (tray !== undefined) return;

    const iconPath = Option.getOrUndefined(
      environment.platform === "win32"
        ? (yield* assets.iconPaths).ico
        : (yield* assets.iconPaths).png,
    );
    if (iconPath === undefined) {
      yield* logTrayWarning("tray icon is unavailable; window close will remain normal");
      return;
    }

    const created = yield* Effect.sync(() => {
      try {
        return Option.some(new Electron.Tray(iconPath));
      } catch {
        return Option.none<Electron.Tray>();
      }
    });
    if (Option.isNone(created)) {
      yield* logTrayWarning("failed to create tray icon");
      return;
    }

    tray = created.value;
    tray.setToolTip(environment.displayName);
    tray.on("click", () => runTrayAction("show-window", desktopWindow.activate));
    yield* Ref.set(state.trayReady, true);
    yield* rebuildMenu;
    yield* logTrayInfo("tray configured");
  });

  return ElectronTray.of({
    configure,
    updateRecentItems: Effect.fn("desktop.tray.updateRecentItems")(function* (items) {
      yield* Ref.set(recentItems, normalizeTrayRecentItems(items));
      yield* rebuildMenu;
    }),
  });
});

export const layer = Layer.effect(ElectronTray, make);
