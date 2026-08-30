import type { LocalPluginManifest } from "@codework/contracts";

import type {
  LocalPluginFailureJournal,
  LocalPluginFailurePhase,
} from "./localPluginFailureJournal";
import { decodeAllowedLocalPluginManifest, LocalPluginPolicyError } from "./localPluginPolicy";
import type { LocalPluginRegistry } from "./localPluginRegistry";
import {
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
  type LocalPluginStorage,
  type StoredLocalPlugin,
} from "./localPluginStorage";

export type LocalPluginLifecycleErrorCode =
  | "schema-invalid"
  | "api-incompatible"
  | "manifest-invalid"
  | "plugin-not-found"
  | "storage-invalid"
  | "storage-write-failed";

export interface LocalPluginLifecycleError {
  readonly code: LocalPluginLifecycleErrorCode;
  readonly message: string;
}

export type LocalPluginLifecycleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: LocalPluginLifecycleError };

function pluginIdFromUnknown(input: unknown): string {
  if (
    input &&
    typeof input === "object" &&
    "id" in input &&
    typeof (input as { readonly id?: unknown }).id === "string"
  ) {
    return (input as { readonly id: string }).id;
  }
  return "unknown-plugin";
}

export class LocalPluginLifecycle {
  constructor(
    private readonly options: {
      readonly registry: LocalPluginRegistry;
      readonly failures: LocalPluginFailureJournal;
      readonly storage: LocalPluginStorage;
      readonly now: () => number;
    },
  ) {}

  restore(): LocalPluginLifecycleResult {
    const value = this.options.storage.read();
    if (value === null) {
      this.options.registry.replace([]);
      return { ok: true };
    }
    try {
      const document = decodeLocalPluginStorageDocument(value);
      for (const plugin of document.plugins) {
        decodeAllowedLocalPluginManifest(plugin.manifest);
      }
      this.options.registry.replace(document.plugins);
      return { ok: true };
    } catch (error) {
      return this.fail("unknown-plugin", "restore", "storage-invalid", error);
    }
  }

  install(input: unknown): LocalPluginLifecycleResult {
    const pluginId = pluginIdFromUnknown(input);
    let manifest: LocalPluginManifest;
    try {
      manifest = decodeAllowedLocalPluginManifest(input);
    } catch (error) {
      const code = error instanceof LocalPluginPolicyError ? error.code : "schema-invalid";
      return this.fail(pluginId, "install", code, error);
    }

    const current = this.options.registry.getSnapshot().plugins;
    const existing = current.find((plugin) => plugin.manifest.id === manifest.id);
    const now = this.options.now();
    const nextRegistration: StoredLocalPlugin = {
      manifest,
      enabled: existing?.enabled ?? true,
      installedAtUnixMs: existing?.installedAtUnixMs ?? now,
      updatedAtUnixMs: now,
    };
    const next = existing
      ? current.map((plugin) => (plugin.manifest.id === manifest.id ? nextRegistration : plugin))
      : [...current, nextRegistration];
    return this.persistAndPublish(manifest.id, "install", next);
  }

  enable(pluginId: string): LocalPluginLifecycleResult {
    return this.setEnabled(pluginId, true, "enable");
  }

  disable(pluginId: string): LocalPluginLifecycleResult {
    return this.setEnabled(pluginId, false, "disable");
  }

  uninstall(pluginId: string): LocalPluginLifecycleResult {
    const current = this.options.registry.getSnapshot().plugins;
    if (!current.some((plugin) => plugin.manifest.id === pluginId)) {
      return this.fail(pluginId, "uninstall", "plugin-not-found", new Error("插件不存在。"));
    }
    return this.persistAndPublish(
      pluginId,
      "uninstall",
      current.filter((plugin) => plugin.manifest.id !== pluginId),
    );
  }

  private setEnabled(
    pluginId: string,
    enabled: boolean,
    phase: "enable" | "disable",
  ): LocalPluginLifecycleResult {
    const current = this.options.registry.getSnapshot().plugins;
    if (!current.some((plugin) => plugin.manifest.id === pluginId)) {
      return this.fail(pluginId, phase, "plugin-not-found", new Error("插件不存在。"));
    }
    const next = current.map((plugin) =>
      plugin.manifest.id === pluginId
        ? { ...plugin, enabled, updatedAtUnixMs: this.options.now() }
        : plugin,
    );
    return this.persistAndPublish(pluginId, phase, next);
  }

  private persistAndPublish(
    pluginId: string,
    phase: Exclude<LocalPluginFailurePhase, "restore" | "invoke" | "render">,
    next: ReadonlyArray<StoredLocalPlugin>,
  ): LocalPluginLifecycleResult {
    try {
      this.options.storage.write(encodeLocalPluginStorageDocument(next));
    } catch (error) {
      return this.fail(pluginId, phase, "storage-write-failed", error);
    }
    this.options.registry.replace(next);
    return { ok: true };
  }

  private fail(
    pluginId: string,
    phase: LocalPluginFailurePhase,
    code: LocalPluginLifecycleErrorCode,
    error: unknown,
  ): LocalPluginLifecycleResult {
    const failure = this.options.failures.record({ pluginId, phase, error });
    return { ok: false, error: { code, message: failure.message } };
  }
}
