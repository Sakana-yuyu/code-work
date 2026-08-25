import { isElectron } from "~/env";
import { CATALOGS, t } from "~/i18n";

export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/integrations"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  // Its row only renders in the desktop app, so a browser result would land on
  // an anchor that isn't there.
  readonly desktopOnly?: boolean;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "general",
  "/settings/appearance": "appearance",
  "/settings/keybindings": "settings.keybindings",
  "/settings/providers": "settings.providers",
  "/settings/integrations": "settings.integrations",
  "/settings/source-control": "settings.sourceControl",
  "/settings/connections": "settings.connections",
  "/settings/archived": "settings.archive",
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "color-scheme",
    title: "settings.colorScheme",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "themes",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: "settings.contrast",
    to: "/settings/appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "settings.glassOpacity",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "settings.environmentIdentification",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "settings.interfaceFont",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "settings.promptFont",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "settings.codeFont",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "settings.terminalFont",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "settings.fontSmoothing",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "wordWrap",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "projectGrouping",
    to: "/settings/general",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "settings.autoSettleInactiveThreads",
    to: "/settings/general",
  },
  {
    id: "auto-settle-merged-threads",
    title: "settings.autoSettleMergedThreads",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "settings.timeFormat",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "settings.hideWhitespaceChanges",
    to: "/settings/general",
  },
  {
    id: "skills-in-slash-menu",
    title: "settings.showSkillsInSlashMenu",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "settings.providerUpdateChecks",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "settings.newThreads",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "settings.startFromOrigin",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "settings.addProjectStartsIn",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "settings.archiveConfirmation",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "settings.deleteConfirmation",
    to: "/settings/general",
  },
  {
    id: "quit-confirmation",
    title: "settings.holdToQuit",
    to: "/settings/general",
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "settings.textGenerationModel",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "settings.diagnostics",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "settings.planModeLegacy",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "settings.streamTokenByTokenLegacy",
    to: "/settings/general",
  },
  {
    id: "legacy-sidebar",
    title: "settings.sidebarLegacy",
    to: "/settings/general",
  },
  {
    id: "keybindings",
    title: "settings.keybindings",
    to: "/settings/keybindings",
  },
  {
    id: "providers",
    title: "settings.providers",
    to: "/settings/providers",
  },
  {
    id: "agent-browser-access",
    title: "settings.agentBrowserAccess",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-viewport",
    title: "settings.defaultBrowserViewport",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-zoom",
    title: "settings.defaultBrowserZoom",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-appearance",
    title: "settings.defaultBrowserAppearance",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "settings.autoShowFloatingPreview",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "source-control",
    title: "settings.sourceControlSetting",
    to: "/settings/source-control",
  },
  {
    id: "remote-environments",
    title: "settings.remoteEnvironments",
    to: "/settings/connections",
  },
  {
    id: "archive",
    title: "archivedThreads",
    to: "/settings/archived",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title: t(title) };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items
    .filter(
      (item) =>
        (isElectron || item.desktopOnly !== true) &&
        // Match the English source as well as the translated title, so an
        // English query still finds a setting under a translated locale.
        (normalizeSearchText(CATALOGS.en[item.title] ?? item.title).includes(normalizedQuery) ||
          normalizeSearchText(t(item.title)).includes(normalizedQuery)),
    )
    .map((item) => ({ ...item, title: t(item.title) }));
}
