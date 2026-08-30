import type { LocalPluginManifest } from "@codework/contracts";

import type {
  LocalPluginFailureJournal,
  LocalPluginFailurePhase,
  LocalPluginManagementFailureCode,
} from "./localPluginFailureJournal";
import { decodeAllowedLocalPluginManifest, LocalPluginPolicyError } from "./localPluginPolicy";
import type { LocalPluginRegistry } from "./localPluginRegistry";
import {
  encodeLocalPluginStorageDocument,
  LocalPluginStorageDuplicateIdError,
  LocalPluginStorageInvalidDocumentError,
  LocalPluginStorageLockUnavailableError,
  type LocalPluginStorage,
  type StoredLocalPlugin,
} from "./localPluginStorage";
import {
  LocalPluginStorageSession,
  type LocalPluginStorageConflict,
  type LocalPluginStorageSnapshot,
} from "./localPluginStorageSession";

export type LocalPluginLifecycleErrorCode = LocalPluginManagementFailureCode;

export interface LocalPluginLifecycleError {
  readonly code: LocalPluginLifecycleErrorCode;
  readonly message: string;
}

export type LocalPluginLifecycleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: LocalPluginLifecycleError };

type LocalPluginMutationPhase = Exclude<
  LocalPluginFailurePhase,
  "restore" | "synchronize" | "invoke" | "render"
>;

export interface LocalPluginLifecycleMutationResult {
  readonly phase: LocalPluginMutationPhase;
  readonly result: LocalPluginLifecycleResult;
}

function storageErrorCode(
  error: unknown,
  fallback: "storage-invalid" | "storage-write-failed",
): LocalPluginLifecycleErrorCode {
  let current = error;
  let invalidDocument = false;
  while (current instanceof Error) {
    if (current instanceof LocalPluginStorageDuplicateIdError) return "storage-duplicate-id";
    if (current instanceof LocalPluginStorageLockUnavailableError) {
      return "storage-lock-unavailable";
    }
    if (current instanceof LocalPluginStorageInvalidDocumentError) invalidDocument = true;
    current = current.cause;
  }
  return invalidDocument ? "storage-invalid" : fallback;
}

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
  private restoreFailure: LocalPluginLifecycleError | null = null;
  private readonly storageSession: LocalPluginStorageSession;

  constructor(
    private readonly options: {
      readonly registry: LocalPluginRegistry;
      readonly failures: LocalPluginFailureJournal;
      readonly storage: LocalPluginStorage;
      readonly now: () => number;
      readonly writerId?: string;
      readonly onMutationResult?: (input: LocalPluginLifecycleMutationResult) => void;
    },
  ) {
    this.storageSession = new LocalPluginStorageSession({
      registry: options.registry,
      storage: options.storage,
      writerId: options.writerId ?? "local-plugin-runtime",
    });
  }

  restore(): LocalPluginLifecycleResult {
    try {
      this.storageSession.restore();
      this.restoreFailure = null;
      return { ok: true };
    } catch (error) {
      const result = this.fail(
        "unknown-plugin",
        "restore",
        storageErrorCode(error, "storage-invalid"),
        error,
      );
      if (!result.ok) this.restoreFailure = result.error;
      return result;
    }
  }

  synchronize(): LocalPluginLifecycleResult {
    let conflict: LocalPluginStorageConflict | null;
    try {
      conflict = this.storageSession.synchronize();
    } catch (error) {
      return this.fail(
        "unknown-plugin",
        "synchronize",
        storageErrorCode(error, "storage-invalid"),
        error,
      );
    }
    this.restoreFailure = null;
    if (!conflict) return { ok: true };
    return this.fail(
      "unknown-plugin",
      "synchronize",
      "storage-conflict",
      new Error(
        `检测到本地插件存储修订冲突（原修订 ${conflict.previousRevision}，原写入者 ${conflict.previousWriterId ?? "legacy"}，当前修订 ${conflict.currentRevision}，当前写入者 ${conflict.currentWriterId ?? "legacy"}），已采用最终持久化状态。`,
      ),
    );
  }

  async install(input: unknown): Promise<LocalPluginLifecycleResult> {
    const pluginId = pluginIdFromUnknown(input);
    const blocked = this.blockedByRestoreFailure();
    if (blocked) return this.publishMutationResult("install", blocked);
    let manifest: LocalPluginManifest;
    try {
      manifest = decodeAllowedLocalPluginManifest(input);
    } catch (error) {
      const code = error instanceof LocalPluginPolicyError ? error.code : "schema-invalid";
      return this.publishMutationResult("install", this.fail(pluginId, "install", code, error));
    }

    const prepared = this.prepareMutation(manifest.id, "install");
    if (!prepared.ok) return this.publishMutationResult("install", prepared.result);
    const current = prepared.snapshot.plugins;
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
    return this.publishMutationResult(
      "install",
      await this.persistAndPublish(manifest.id, "install", prepared.snapshot, next),
    );
  }

  enable(pluginId: string): Promise<LocalPluginLifecycleResult> {
    return this.setEnabled(pluginId, true, "enable");
  }

  disable(pluginId: string): Promise<LocalPluginLifecycleResult> {
    return this.setEnabled(pluginId, false, "disable");
  }

  async uninstall(pluginId: string): Promise<LocalPluginLifecycleResult> {
    const blocked = this.blockedByRestoreFailure();
    if (blocked) return this.publishMutationResult("uninstall", blocked);
    const prepared = this.prepareMutation(pluginId, "uninstall");
    if (!prepared.ok) return this.publishMutationResult("uninstall", prepared.result);
    const current = prepared.snapshot.plugins;
    if (!current.some((plugin) => plugin.manifest.id === pluginId)) {
      return this.publishMutationResult(
        "uninstall",
        this.fail(pluginId, "uninstall", "plugin-not-found", new Error("插件不存在。")),
      );
    }
    return this.publishMutationResult(
      "uninstall",
      await this.persistAndPublish(
        pluginId,
        "uninstall",
        prepared.snapshot,
        current.filter((plugin) => plugin.manifest.id !== pluginId),
      ),
    );
  }

  private async setEnabled(
    pluginId: string,
    enabled: boolean,
    phase: "enable" | "disable",
  ): Promise<LocalPluginLifecycleResult> {
    const blocked = this.blockedByRestoreFailure();
    if (blocked) return this.publishMutationResult(phase, blocked);
    const prepared = this.prepareMutation(pluginId, phase);
    if (!prepared.ok) return this.publishMutationResult(phase, prepared.result);
    const current = prepared.snapshot.plugins;
    if (!current.some((plugin) => plugin.manifest.id === pluginId)) {
      return this.publishMutationResult(
        phase,
        this.fail(pluginId, phase, "plugin-not-found", new Error("插件不存在。")),
      );
    }
    const next = current.map((plugin) =>
      plugin.manifest.id === pluginId
        ? { ...plugin, enabled, updatedAtUnixMs: this.options.now() }
        : plugin,
    );
    return this.publishMutationResult(
      phase,
      await this.persistAndPublish(pluginId, phase, prepared.snapshot, next),
    );
  }

  private publishMutationResult(
    phase: LocalPluginMutationPhase,
    result: LocalPluginLifecycleResult,
  ): LocalPluginLifecycleResult {
    this.options.onMutationResult?.({ phase, result });
    return result;
  }

  private prepareMutation(
    pluginId: string,
    phase: LocalPluginMutationPhase,
  ):
    | { readonly ok: true; readonly snapshot: LocalPluginStorageSnapshot }
    | { readonly ok: false; readonly result: LocalPluginLifecycleResult } {
    try {
      encodeLocalPluginStorageDocument(this.options.registry.getSnapshot().plugins);
      return { ok: true, snapshot: this.storageSession.readLatest() };
    } catch (error) {
      return {
        ok: false,
        result: this.fail(pluginId, phase, storageErrorCode(error, "storage-invalid"), error),
      };
    }
  }

  private async persistAndPublish(
    pluginId: string,
    phase: LocalPluginMutationPhase,
    base: LocalPluginStorageSnapshot,
    next: ReadonlyArray<StoredLocalPlugin>,
  ): Promise<LocalPluginLifecycleResult> {
    let persistedByThisRuntime: boolean;
    try {
      persistedByThisRuntime = await this.storageSession.persist(base, next);
    } catch (error) {
      return this.fail(pluginId, phase, storageErrorCode(error, "storage-write-failed"), error);
    }
    if (!persistedByThisRuntime) {
      return this.fail(
        pluginId,
        phase,
        "storage-conflict",
        new Error("本地插件设置写入时被其他标签页覆盖，已采用最终持久化状态。"),
      );
    }
    return { ok: true };
  }

  private blockedByRestoreFailure(): LocalPluginLifecycleResult | null {
    return this.restoreFailure === null ? null : { ok: false, error: this.restoreFailure };
  }

  private fail(
    pluginId: string,
    phase: LocalPluginFailurePhase,
    code: LocalPluginLifecycleErrorCode,
    error: unknown,
  ): LocalPluginLifecycleResult {
    const failure = this.options.failures.record({ pluginId, phase, code, error });
    return { ok: false, error: { code, message: failure.message } };
  }
}
