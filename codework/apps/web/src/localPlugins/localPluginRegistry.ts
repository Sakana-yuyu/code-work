import type {
  LocalPluginAttachmentContribution,
  LocalPluginCommandContribution,
  LocalPluginManifest,
  LocalPluginTimelineContribution,
  LocalPluginWorkspacePanelContribution,
} from "@codework/contracts";

import type { StoredLocalPlugin } from "./localPluginStorage";

export type LocalPluginContributionKind =
  | "workspacePanels"
  | "commands"
  | "timeline"
  | "attachments";

interface LocalPluginContributionByKind {
  readonly workspacePanels: LocalPluginWorkspacePanelContribution;
  readonly commands: LocalPluginCommandContribution;
  readonly timeline: LocalPluginTimelineContribution;
  readonly attachments: LocalPluginAttachmentContribution;
}

export interface RegisteredLocalPluginContribution<K extends LocalPluginContributionKind> {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly contribution: LocalPluginContributionByKind[K];
}

export interface LocalPluginRegistrySnapshot {
  readonly plugins: ReadonlyArray<StoredLocalPlugin>;
}

type Listener = () => void;

export class LocalPluginRegistry {
  private snapshot: LocalPluginRegistrySnapshot = { plugins: [] };
  private readonly listeners = new Set<Listener>();

  getSnapshot = (): LocalPluginRegistrySnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(plugins: ReadonlyArray<StoredLocalPlugin>): void {
    this.snapshot = { plugins: [...plugins] };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不能中断已完成的快照发布或其他订阅者。
      }
    }
  }

  get(pluginId: string): StoredLocalPlugin | null {
    return this.snapshot.plugins.find((plugin) => plugin.manifest.id === pluginId) ?? null;
  }

  listEnabled<K extends LocalPluginContributionKind>(
    kind: K,
  ): ReadonlyArray<RegisteredLocalPluginContribution<K>> {
    const result: Array<RegisteredLocalPluginContribution<K>> = [];
    for (const registration of this.snapshot.plugins) {
      if (!registration.enabled) continue;
      const contributions = registration.manifest.contributions[kind] ?? [];
      for (const contribution of contributions) {
        result.push({
          pluginId: registration.manifest.id,
          pluginName: registration.manifest.name,
          pluginVersion: registration.manifest.version,
          contribution,
        } as RegisteredLocalPluginContribution<K>);
      }
    }
    return result;
  }

  hasPermission(pluginId: string, permission: LocalPluginManifest["permissions"][number]): boolean {
    const plugin = this.get(pluginId);
    return plugin?.enabled === true && plugin.manifest.permissions.includes(permission);
  }
}
