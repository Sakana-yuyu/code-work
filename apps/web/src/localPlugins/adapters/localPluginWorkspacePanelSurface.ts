const LOCAL_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,95}$/;

export interface LocalPluginWorkspacePanelSurface {
  readonly id: `plugin:${string}:${string}`;
  readonly kind: "plugin";
  readonly pluginId: string;
  readonly contributionId: string;
}

function isLocalPluginId(value: unknown): value is string {
  return typeof value === "string" && LOCAL_PLUGIN_ID_PATTERN.test(value);
}

export function localPluginWorkspacePanelSurface(
  pluginId: string,
  contributionId: string,
): LocalPluginWorkspacePanelSurface {
  return {
    id: `plugin:${pluginId}:${contributionId}`,
    kind: "plugin",
    pluginId,
    contributionId,
  };
}

export function parseLocalPluginWorkspacePanelSurface(
  input: unknown,
): LocalPluginWorkspacePanelSurface | null {
  if (!input || typeof input !== "object") return null;
  const surface = input as Record<string, unknown>;
  if (
    surface.kind !== "plugin" ||
    !isLocalPluginId(surface.pluginId) ||
    !isLocalPluginId(surface.contributionId)
  ) {
    return null;
  }
  const parsed = localPluginWorkspacePanelSurface(surface.pluginId, surface.contributionId);
  return surface.id === parsed.id ? parsed : null;
}
