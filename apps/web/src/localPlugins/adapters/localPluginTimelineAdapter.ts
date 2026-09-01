import type { LocalPluginRegistry } from "../localPluginRegistry";
import type { LocalPluginTimelineJournal } from "../localPluginTimelineJournal";

export interface EnabledLocalPluginTimelineEntry {
  readonly id: `local-plugin-timeline:${string}`;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contributionId: string;
  readonly title: string;
  readonly message: string;
  readonly tone: "info" | "success" | "warning" | "error";
  readonly createdAt: string;
}

export type LocalPluginTimelinePostPort = (
  pluginId: string,
  timelineId: string,
  message: string,
) => Promise<void>;

function resolveCurrentTimelineContribution(input: {
  readonly registry: LocalPluginRegistry;
  readonly pluginId: string;
  readonly timelineId: string;
}) {
  const plugin = input.registry.get(input.pluginId);
  if (plugin === null) throw new Error("插件不存在。");
  if (!plugin.enabled) throw new Error("插件已禁用。");
  if (!input.registry.hasPermission(input.pluginId, "timeline.write")) {
    throw new Error("插件缺少 timeline.write 权限。");
  }
  const contribution = plugin.manifest.contributions.timeline?.find(
    (candidate) => candidate.id === input.timelineId,
  );
  if (contribution === undefined) throw new Error("Timeline 贡献不存在。");
  return { plugin, contribution };
}

export function createLocalPluginTimelinePostPort(input: {
  readonly registry: LocalPluginRegistry;
  readonly journal: LocalPluginTimelineJournal;
  readonly threadKey: string;
}): LocalPluginTimelinePostPort {
  return async (pluginId, timelineId, message) => {
    const normalizedMessage = message.trim();
    if (normalizedMessage.length === 0 || normalizedMessage.length > 4_000) {
      throw new Error("Timeline 事件内容无效。");
    }
    const { contribution } = resolveCurrentTimelineContribution({
      registry: input.registry,
      pluginId,
      timelineId,
    });
    input.journal.append({
      threadKey: input.threadKey,
      pluginId,
      timelineId,
      title: contribution.title,
      message: normalizedMessage,
      tone: contribution.tone,
    });
  };
}

export function listEnabledLocalPluginTimelineEntries(input: {
  readonly registry: LocalPluginRegistry;
  readonly journal: LocalPluginTimelineJournal;
  readonly threadKey: string;
}): ReadonlyArray<EnabledLocalPluginTimelineEntry> {
  const result: EnabledLocalPluginTimelineEntry[] = [];
  for (const event of input.journal.list(input.threadKey)) {
    const plugin = input.registry.get(event.pluginId);
    if (plugin?.enabled !== true) continue;
    if (!input.registry.hasPermission(event.pluginId, "timeline.write")) continue;
    const contributionExists = plugin.manifest.contributions.timeline?.some(
      (contribution) => contribution.id === event.timelineId,
    );
    if (!contributionExists) continue;
    result.push({
      id: `local-plugin-timeline:${event.id}`,
      pluginId: event.pluginId,
      pluginName: plugin.manifest.name,
      contributionId: event.timelineId,
      title: event.title,
      message: event.message,
      tone: event.tone,
      createdAt: event.createdAt,
    });
  }
  return result;
}
