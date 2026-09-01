import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { LocalPluginFailureJournal } from "../localPluginFailureJournal";
import { LocalPluginLifecycle } from "../localPluginLifecycle";
import { LocalPluginRegistry } from "../localPluginRegistry";
import type { LocalPluginRuntime } from "../localPluginRuntime";
import {
  decodeLocalPluginStorageDocument,
  type LocalPluginStorage,
  type LocalPluginStorageCompareAndSwapInput,
  type LocalPluginStorageCompareAndSwapResult,
} from "../localPluginStorage";
import {
  listEnabledLocalPluginAttachments,
  type LocalPluginAttachmentCommitResult,
} from "./localPluginAttachmentAdapter";

class MemoryStorage implements LocalPluginStorage {
  value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }

  async compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    const revision =
      this.value === null ? 0 : (decodeLocalPluginStorageDocument(this.value).revision ?? 0);
    if (this.value !== input.expectedValue || revision !== input.expectedRevision) {
      return { swapped: false, currentValue: this.value };
    }
    this.write(input.nextValue);
    return { swapped: true, currentValue: this.value };
  }
}

const manifest = (id: string): LocalPluginManifest => ({
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id,
  name: `插件 ${id}`,
  version: "1.0.0",
  permissions: ["composer.attachment.add", "composer.prompt.write"],
  contributions: {
    attachments: [
      {
        id: "design",
        title: "附加设计图",
        description: "选择一张设计图并补充分析提示词",
        accept: ["image/png", "image/jpeg"],
        maxBytes: 4,
        promptPrefix: "请结合附件分析：",
      },
    ],
  },
});

function createRuntime(): LocalPluginRuntime {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage: new MemoryStorage(),
    now: () => 1,
  });
  return {
    failures,
    lifecycle,
    registry,
    restoreResult: { ok: true },
    lastSynchronizeResult: null,
    storageStatus: {
      getSnapshot: () => ({ phase: "restore", result: { ok: true } }),
      subscribe: () => () => undefined,
    },
    dispose: () => undefined,
  };
}

function file(name: string, type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

describe("localPluginAttachmentAdapter", () => {
  it("只枚举具备完整宿主端口的启用贡献，并逐文件应用 MIME 与大小限制", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.attachments"));
    const files = [
      file("diagram.png", "image/png", 3),
      file("large.jpg", "image/jpeg", 5),
      file("notes.txt", "text/plain", 2),
    ];
    const pickFiles = vi.fn(async () => files);
    const commitAttachment = vi.fn(
      async (): Promise<LocalPluginAttachmentCommitResult> => ({
        status: "complete",
      }),
    );

    expect(
      listEnabledLocalPluginAttachments({
        runtime,
        ports: { pickFiles },
      }),
    ).toEqual([]);

    const attachments = listEnabledLocalPluginAttachments({
      runtime,
      ports: { pickFiles, commitAttachment },
    });

    expect(attachments.map((attachment) => attachment.contributionId)).toEqual(["design"]);
    expect(await attachments[0]!.invoke()).toEqual({
      ok: true,
      value: {
        status: "complete",
        acceptedFiles: ["diagram.png"],
        rejectedFiles: [
          { fileName: "large.jpg", reason: "too-large" },
          { fileName: "notes.txt", reason: "mime-not-accepted" },
        ],
      },
    });
    expect(pickFiles).toHaveBeenCalledWith({
      accept: ["image/png", "image/jpeg"],
      multiple: true,
    });
    expect(commitAttachment).toHaveBeenCalledWith({
      files: [files[0]],
      promptPrefix: "请结合附件分析：",
    });
  });

  it("取消选择或全部文件被拒时写入失败 journal，且不调用 Composer", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.cancelled"));
    const commitAttachment = vi.fn(
      async (): Promise<LocalPluginAttachmentCommitResult> => ({ status: "complete" }),
    );
    const cancelled = listEnabledLocalPluginAttachments({
      runtime,
      ports: {
        pickFiles: async () => null,
        commitAttachment,
      },
    })[0]!;

    expect(await cancelled.invoke()).toMatchObject({
      ok: false,
      failure: {
        pluginId: "acme.cancelled",
        contributionKind: "attachments",
        contributionId: "design",
        message: "未选择附件。",
      },
    });

    const rejected = listEnabledLocalPluginAttachments({
      runtime,
      ports: {
        pickFiles: async () => [file("notes.txt", "text/plain", 2)],
        commitAttachment,
      },
    })[0]!;
    expect(await rejected.invoke()).toMatchObject({
      ok: false,
      failure: { message: "所选文件均不符合此附件贡献的类型或大小限制。" },
    });
    expect(commitAttachment).not.toHaveBeenCalled();
    expect(runtime.failures.getSnapshot()).toHaveLength(2);
  });

  it("调用时重新检查启用状态、权限与 contribution", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.stale"));
    const ports = {
      pickFiles: vi.fn(async () => [file("diagram.png", "image/png", 3)]),
      commitAttachment: vi.fn(
        async (): Promise<LocalPluginAttachmentCommitResult> => ({ status: "complete" }),
      ),
    };
    const stale = listEnabledLocalPluginAttachments({ runtime, ports })[0]!;

    await runtime.lifecycle.disable("acme.stale");
    expect(await stale.invoke()).toMatchObject({
      ok: false,
      failure: { message: "插件已禁用。" },
    });

    runtime.registry.replace([
      {
        manifest: { ...manifest("acme.stale"), permissions: ["composer.prompt.write"] },
        enabled: true,
        installedAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
    ]);
    expect(await stale.invoke()).toMatchObject({
      ok: false,
      failure: { message: "插件缺少 composer.attachment.add 权限。" },
    });

    runtime.registry.replace([
      {
        manifest: { ...manifest("acme.stale"), contributions: {} },
        enabled: true,
        installedAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
    ]);
    expect(await stale.invoke()).toMatchObject({
      ok: false,
      failure: { message: "附件贡献不存在。" },
    });
    expect(ports.pickFiles).not.toHaveBeenCalled();
  });

  it("Composer 写入失败只隔离当前插件，其他附件贡献仍可完成", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.failed"));
    await runtime.lifecycle.install(manifest("acme.healthy"));
    const commitAttachment = vi
      .fn<() => Promise<LocalPluginAttachmentCommitResult>>()
      .mockResolvedValueOnce({ status: "rejected" })
      .mockResolvedValueOnce({ status: "complete" });
    const attachments = listEnabledLocalPluginAttachments({
      runtime,
      ports: {
        pickFiles: async () => [file("diagram.png", "image/png", 3)],
        commitAttachment,
      },
    });

    expect(await attachments[0]!.invoke()).toMatchObject({
      ok: false,
      failure: {
        pluginId: "acme.failed",
        contributionId: "design",
        message: "当前输入框暂时不能接受插件附件。",
      },
    });
    expect(await attachments[1]!.invoke()).toMatchObject({
      ok: true,
      value: { acceptedFiles: ["diagram.png"] },
    });
    expect(runtime.failures.getSnapshot()).toHaveLength(1);
  });

  it("提示词写入失败时返回附件已写入的部分成功结果", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.partial"));
    const attachment = listEnabledLocalPluginAttachments({
      runtime,
      ports: {
        pickFiles: async () => [file("diagram.png", "image/png", 3)],
        commitAttachment: async () => ({
          status: "attachment-only",
          reason: "prompt-rejected",
        }),
      },
    })[0]!;

    expect(await attachment.invoke()).toEqual({
      ok: true,
      value: {
        status: "attachment-only",
        promptFailure: "prompt-rejected",
        acceptedFiles: ["diagram.png"],
        rejectedFiles: [],
      },
    });
    expect(runtime.failures.getSnapshot()).toEqual([]);
  });
});
