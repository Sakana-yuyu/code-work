import {
  inspectLocalPluginWorkspaceTemplate,
  type LocalPluginCommandContribution,
  type LocalPluginPermission,
} from "@codework/contracts";

import type { IsolatedLocalPluginResult } from "../localPluginIsolation";
import { runIsolatedLocalPluginContribution } from "../localPluginIsolation";
import type { LocalPluginRuntime } from "../localPluginRuntime";
import {
  renderLocalPluginTemplate,
  type LocalPluginWorkspaceContext,
} from "../localPluginTemplate";

export interface LocalPluginCommandPorts {
  readonly openWorkspacePanel?: (pluginId: string, contributionId: string) => void;
  readonly writeClipboard?: (text: string) => Promise<void>;
  readonly insertPrompt?: (text: string) => boolean;
}

export interface EnabledLocalPluginCommand {
  readonly id: `local-plugin-command:${string}:${string}`;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contributionId: string;
  readonly title: string;
  readonly description?: string;
  readonly invoke: () => Promise<IsolatedLocalPluginResult<void>>;
}

function assertPermission(
  runtime: LocalPluginRuntime,
  pluginId: string,
  permission: LocalPluginPermission,
): void {
  if (!runtime.registry.hasPermission(pluginId, permission)) {
    throw new Error(`插件缺少 ${permission} 权限。`);
  }
}

function commandCanCloseLoop(input: {
  readonly command: LocalPluginCommandContribution;
  readonly workspace: LocalPluginWorkspaceContext | null;
  readonly ports: LocalPluginCommandPorts;
}): boolean {
  switch (input.command.action.type) {
    case "workspace.open-panel":
      return input.ports.openWorkspacePanel !== undefined;
    case "clipboard.write": {
      if (input.ports.writeClipboard === undefined) return false;
      const inspection = inspectLocalPluginWorkspaceTemplate(input.command.action.text);
      return inspection.fields.length === 0 || input.workspace !== null;
    }
    case "composer.prompt.insert":
      return input.ports.insertPrompt !== undefined;
    case "timeline.post":
      return false;
  }
}

async function invokeCurrentCommand(input: {
  readonly runtime: LocalPluginRuntime;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly workspace: LocalPluginWorkspaceContext | null;
  readonly ports: LocalPluginCommandPorts;
}): Promise<void> {
  const plugin = input.runtime.registry.get(input.pluginId);
  if (plugin === null) throw new Error("插件不存在。");
  if (!plugin.enabled) throw new Error("插件已禁用。");
  const command = plugin.manifest.contributions.commands?.find(
    (candidate) => candidate.id === input.contributionId,
  );
  if (command === undefined) throw new Error("命令贡献不存在。");

  switch (command.action.type) {
    case "workspace.open-panel": {
      const openWorkspacePanel = input.ports.openWorkspacePanel;
      if (openWorkspacePanel === undefined) throw new Error("当前没有可用的工作区面板宿主。");
      const panelId = command.action.panelId;
      const panelExists = plugin.manifest.contributions.workspacePanels?.some(
        (panel) => panel.id === panelId,
      );
      if (!panelExists) throw new Error("命令引用的工作区面板不存在。");
      openWorkspacePanel(input.pluginId, panelId);
      return;
    }
    case "clipboard.write": {
      const writeClipboard = input.ports.writeClipboard;
      if (writeClipboard === undefined) throw new Error("当前没有可用的剪贴板宿主。");
      assertPermission(input.runtime, input.pluginId, "clipboard.write");
      const inspection = inspectLocalPluginWorkspaceTemplate(command.action.text);
      if (inspection.fields.length > 0) {
        assertPermission(input.runtime, input.pluginId, "workspace.read");
      }
      const text = renderLocalPluginTemplate({
        template: command.action.text,
        allowedFields: ["workspace.name", "workspace.root"],
        workspace: input.workspace,
      });
      await writeClipboard(text);
      return;
    }
    case "composer.prompt.insert": {
      const insertPrompt = input.ports.insertPrompt;
      if (insertPrompt === undefined) throw new Error("当前没有可用的输入框宿主。");
      assertPermission(input.runtime, input.pluginId, "composer.prompt.write");
      if (!insertPrompt(command.action.text)) {
        throw new Error("当前输入框暂时不能接受插件内容。");
      }
      return;
    }
    case "timeline.post":
      throw new Error("Timeline contribution adapter 尚未接入当前命令宿主。");
  }
}

export function listEnabledLocalPluginCommands(input: {
  readonly runtime: LocalPluginRuntime;
  readonly workspace: LocalPluginWorkspaceContext | null;
  readonly ports: LocalPluginCommandPorts;
}): ReadonlyArray<EnabledLocalPluginCommand> {
  return input.runtime.registry
    .listEnabled("commands")
    .filter(({ contribution }) =>
      commandCanCloseLoop({
        command: contribution,
        workspace: input.workspace,
        ports: input.ports,
      }),
    )
    .map(({ pluginId, pluginName, contribution }) => ({
      id: `local-plugin-command:${pluginId}:${contribution.id}`,
      pluginId,
      pluginName,
      contributionId: contribution.id,
      title: contribution.title,
      ...(contribution.description === undefined ? {} : { description: contribution.description }),
      invoke: () =>
        runIsolatedLocalPluginContribution({
          failures: input.runtime.failures,
          pluginId,
          contributionKind: "commands",
          contributionId: contribution.id,
          run: () =>
            invokeCurrentCommand({
              runtime: input.runtime,
              pluginId,
              contributionId: contribution.id,
              workspace: input.workspace,
              ports: input.ports,
            }),
        }),
    }));
}
