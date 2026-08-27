import {
  buildRemoteOpenUrl,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@codework/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { t } from "~/i18n";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<OpenInOption> = [
    {
      label: t("cursor"),
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      label: t("trae"),
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      label: t("kiro"),
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      label: t("vsCode"),
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      label: t("vsCodeInsiders"),
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      label: t("vscodium"),
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      label: t("zed"),
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      label: t("antigravity"),
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      label: t("intellijIdea"),
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      label: t("aqua"),
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      label: t("clion"),
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      label: t("datagrip"),
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      label: t("dataspell"),
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      label: t("goland"),
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      label: t("phpstorm"),
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      label: t("pycharm"),
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      label: t("rider"),
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      label: t("rubymine"),
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      label: t("rustrover"),
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      label: t("webstorm"),
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      label: isMacPlatform(platform)
        ? t("finder")
        : isWindowsPlatform(platform)
          ? t("explorer")
          : t("surface.files"),
      Icon: FolderClosedIcon,
      value: "file-manager",
      kind: "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions.filter((option) => availableEditorSet.has(option.value));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  compact = false,
  enableShortcut = true,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  compact?: boolean;
  enableShortcut?: boolean;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  // Remote mode ignores the server's PATH probe: what matters is what runs on
  // the viewing machine, which only the desktop app can probe.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, effectiveEditors),
    [effectiveEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      if (!openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      if (remote.mode === "remote-unavailable") return;
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor,
          host: remote.host.host,
          absolutePath: openInCwd,
        });
        if (url === undefined) return;
        // Only record hint-seen/preferred when the shell actually accepted
        // the URL (an older desktop build can refuse the editor scheme).
        void openRemoteEditorUrl(url).then((opened) => {
          if (!opened) return;
          markRemoteHintSeen();
          setPreferredEditor(editor);
        });
        return;
      }
      const result = openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor,
        },
      });
      setPreferredEditor(editor);
      return result;
    },
    [
      environmentId,
      markRemoteHintSeen,
      openInCwd,
      openInEditorMutation,
      preferredEditor,
      remote,
      setPreferredEditor,
    ],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    if (!enableShortcut) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void openInEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableShortcut, keybindings, openInCwd, openInEditor, preferredEditor]);

  return (
    <Group aria-label={t("openInEditor")}>
      <Button
        aria-label={compact ? t("openFileInPreferredEditor") : undefined}
        className="ps-[8.5px]"
        size="xs"
        variant="outline"
        disabled={!preferredEditor || !openInCwd || remote.mode === "remote-unavailable"}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn("size-3.5", getOpenInIconClass(primaryOption.kind))}
          />
        )}
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          {t("open")}
        </span>
      </Button>
      <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={compact ? t("chooseEditor") : t("copyOptions")}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {remote.mode === "remote-unavailable" ? (
            <MenuItem disabled>{t("noSshRouteTo", { environment: environmentLabel })}</MenuItem>
          ) : (
            <>
              {options.length === 0 && <MenuItem disabled>{t("noInstalledEditorsFound")}</MenuItem>}
              {options.map(({ label, Icon, value, kind }) => (
                <MenuItem key={value} onClick={() => openInEditor(value)}>
                  <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
                  {label}
                  {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                    <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
                  )}
                </MenuItem>
              ))}
              {remote.mode === "remote-links" && !remoteHintSeen && (
                <MenuItem disabled>
                  {t("opensOverSshNeedsKey", { environment: environmentLabel })}
                </MenuItem>
              )}
            </>
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
