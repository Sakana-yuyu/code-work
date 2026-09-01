import type { LocalPluginWorkspacePanelContribution } from "@codework/contracts";

import type { LocalPluginRegistry } from "../localPluginRegistry";
import {
  renderLocalPluginTemplate,
  type LocalPluginWorkspaceContext,
} from "../localPluginTemplate";
import {
  localPluginWorkspacePanelSurface,
  type LocalPluginWorkspacePanelSurface,
} from "./localPluginWorkspacePanelSurface";

export interface LocalPluginWorkspacePanelView {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly title: string;
  readonly description?: string;
  readonly sections: ReadonlyArray<{ readonly heading?: string; readonly body: string }>;
}

export type LocalPluginWorkspacePanelResolution =
  | { readonly ok: true; readonly panel: LocalPluginWorkspacePanelView }
  | { readonly ok: false; readonly error: Error };

function renderPanelText(
  template: string,
  contribution: LocalPluginWorkspacePanelContribution,
  workspace: LocalPluginWorkspaceContext | null,
): string {
  return renderLocalPluginTemplate({
    template,
    allowedFields: contribution.context ?? [],
    workspace,
  });
}

export function listEnabledLocalPluginWorkspacePanels(
  registry: LocalPluginRegistry,
): ReadonlyArray<{
  readonly surface: LocalPluginWorkspacePanelSurface;
  readonly title: string;
}> {
  return registry.listEnabled("workspacePanels").map(({ pluginId, contribution }) => ({
    surface: localPluginWorkspacePanelSurface(pluginId, contribution.id),
    title: contribution.title,
  }));
}

export function resolveLocalPluginWorkspacePanel(input: {
  readonly registry: LocalPluginRegistry;
  readonly surface: LocalPluginWorkspacePanelSurface;
  readonly workspace: LocalPluginWorkspaceContext | null;
}): LocalPluginWorkspacePanelResolution {
  try {
    const plugin = input.registry.get(input.surface.pluginId);
    if (plugin === null) throw new Error("插件不存在。");
    if (!plugin.enabled) throw new Error("插件已禁用。");
    const contribution = plugin.manifest.contributions.workspacePanels?.find(
      (candidate) => candidate.id === input.surface.contributionId,
    );
    if (contribution === undefined) throw new Error("工作区面板贡献不存在。");
    if (
      (contribution.context?.length ?? 0) > 0 &&
      !input.registry.hasPermission(input.surface.pluginId, "workspace.read")
    ) {
      throw new Error("插件缺少 workspace.read 权限。");
    }

    return {
      ok: true,
      panel: {
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        pluginVersion: plugin.manifest.version,
        title: contribution.title,
        ...(contribution.description === undefined
          ? {}
          : {
              description: renderPanelText(contribution.description, contribution, input.workspace),
            }),
        sections: contribution.sections.map((section) => ({
          ...(section.heading === undefined
            ? {}
            : { heading: renderPanelText(section.heading, contribution, input.workspace) }),
          body: renderPanelText(section.body, contribution, input.workspace),
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
