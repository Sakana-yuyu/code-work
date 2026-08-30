import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { LocalPluginFailureJournal } from "../localPluginFailureJournal";
import { LocalPluginLifecycle } from "../localPluginLifecycle";
import { LocalPluginRegistry } from "../localPluginRegistry";
import type { LocalPluginRuntime } from "../localPluginRuntime";
import type { LocalPluginStorage } from "../localPluginStorage";
import { listEnabledLocalPluginAttachments } from "./localPluginAttachmentAdapter";

class MemoryStorage implements LocalPluginStorage {
  value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
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
  return { failures, lifecycle, registry };
}

function file(name: string, type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

describe("localPluginAttachmentAdapter", () => {
  it("只枚举具备完整宿主端口的启用贡献，并逐文件应用 MIME 与大小限制", async () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.attachments"));
    const files = [
      file("diagram.png", "image/png", 3),
      file("large.jpg", "image/jpeg", 5),
      file("notes.txt", "text/plain", 2),
    ];
    const pickFiles = vi.fn(async () => files);
    const addFiles = vi.fn(async () => true);
    const insertPrompt = vi.fn(() => true);

    expect(
      listEnabledLocalPluginAttachments({
        runtime,
        ports: { pickFiles, addFiles },
      }),
    ).toEqual([]);

    const attachments = listEnabledLocalPluginAttachments({
      runtime,
      ports: { pickFiles, addFiles, insertPrompt },
    });

    expect(attachments.map((attachment) => attachment.contributionId)).toEqual(["design"]);
    expect(await attachments[0]!.invoke()).toEqual({
      ok: true,
      value: {
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
    expect(addFiles).toHaveBeenCalledWith([files[0]]);
    expect(insertPrompt).toHaveBeenCalledWith("请结合附件分析：");
  });

  it("取消选择或全部文件被拒时写入失败 journal，且不调用 Composer", async () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.cancelled"));
    const addFiles = vi.fn(async () => true);
    const insertPrompt = vi.fn(() => true);
    const cancelled = listEnabledLocalPluginAttachments({
      runtime,
      ports: {
        pickFiles: async () => null,
        addFiles,
        insertPrompt,
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
        addFiles,
        insertPrompt,
      },
    })[0]!;
    expect(await rejected.invoke()).toMatchObject({
      ok: false,
      failure: { message: "所选文件均不符合此附件贡献的类型或大小限制。" },
    });
    expect(addFiles).not.toHaveBeenCalled();
    expect(insertPrompt).not.toHaveBeenCalled();
    expect(runtime.failures.getSnapshot()).toHaveLength(2);
  });

  it("调用时重新检查启用状态、权限与 contribution", async () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.stale"));
    const ports = {
      pickFiles: vi.fn(async () => [file("diagram.png", "image/png", 3)]),
      addFiles: vi.fn(async () => true),
      insertPrompt: vi.fn(() => true),
    };
    const stale = listEnabledLocalPluginAttachments({ runtime, ports })[0]!;

    runtime.lifecycle.disable("acme.stale");
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
    runtime.lifecycle.install(manifest("acme.failed"));
    runtime.lifecycle.install(manifest("acme.healthy"));
    const addFiles = vi
      .fn<(files: ReadonlyArray<File>) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const attachments = listEnabledLocalPluginAttachments({
      runtime,
      ports: {
        pickFiles: async () => [file("diagram.png", "image/png", 3)],
        addFiles,
        insertPrompt: () => true,
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
});
