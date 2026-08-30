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
import { listEnabledLocalPluginCommands } from "./localPluginCommandAdapter";

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
  permissions: ["workspace.read", "clipboard.write", "composer.prompt.write", "timeline.write"],
  contributions: {
    workspacePanels: [{ id: "overview", title: "概览", sections: [{ body: "静态内容" }] }],
    commands: [
      {
        id: "open",
        title: "打开概览",
        action: { type: "workspace.open-panel", panelId: "overview" },
      },
      {
        id: "copy",
        title: "复制路径",
        action: { type: "clipboard.write", text: "{{workspace.name}}: {{workspace.root}}" },
      },
      {
        id: "insert",
        title: "插入提示词",
        action: { type: "composer.prompt.insert", text: "检查当前改动" },
      },
      {
        id: "timeline",
        title: "写入时间线",
        action: { type: "timeline.post", timelineId: "checks", message: "完成" },
      },
    ],
    timeline: [{ id: "checks", title: "检查", tone: "info" }],
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
    dispose: () => undefined,
  };
}

describe("localPluginCommandAdapter", () => {
  it("只枚举已有安全宿主端口的动作，并通过端口完成调用", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.commands"));
    const openWorkspacePanel = vi.fn();
    const writeClipboard = vi.fn(async () => undefined);
    const insertPrompt = vi.fn(() => true);
    const postTimeline = vi.fn(async () => undefined);

    const commands = listEnabledLocalPluginCommands({
      runtime,
      workspace: { name: "Code Work", root: "C:\\workspace\\code-work" },
      ports: { openWorkspacePanel, writeClipboard, insertPrompt, postTimeline },
    });

    expect(commands.map((command) => command.contributionId)).toEqual([
      "open",
      "copy",
      "insert",
      "timeline",
    ]);
    expect(await commands[0]!.invoke()).toEqual({ ok: true, value: undefined });
    expect(await commands[1]!.invoke()).toEqual({ ok: true, value: undefined });
    expect(await commands[2]!.invoke()).toEqual({ ok: true, value: undefined });
    expect(await commands[3]!.invoke()).toEqual({ ok: true, value: undefined });
    expect(openWorkspacePanel).toHaveBeenCalledWith("acme.commands", "overview");
    expect(writeClipboard).toHaveBeenCalledWith("Code Work: C:\\workspace\\code-work");
    expect(insertPrompt).toHaveBeenCalledWith("检查当前改动");
    expect(postTimeline).toHaveBeenCalledWith("acme.commands", "checks", "完成");
  });

  it("上下文或宿主端口缺失时不暴露无法形成闭环的命令", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.commands"));

    const commands = listEnabledLocalPluginCommands({
      runtime,
      workspace: null,
      ports: { writeClipboard: vi.fn(async () => undefined) },
    });

    expect(commands).toEqual([]);
  });

  it("调用时重新检查启用状态，并把单插件失败写入 journal", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.one"));
    await runtime.lifecycle.install(manifest("acme.two"));
    const insertPrompt = vi.fn(() => true);
    const commands = listEnabledLocalPluginCommands({
      runtime,
      workspace: { name: "Code Work", root: "C:\\workspace\\code-work" },
      ports: {
        openWorkspacePanel: vi.fn(),
        writeClipboard: vi.fn(async () => undefined),
        insertPrompt,
      },
    });
    const staleCommand = commands.find(
      (command) => command.pluginId === "acme.one" && command.contributionId === "insert",
    )!;
    const healthyCommand = commands.find(
      (command) => command.pluginId === "acme.two" && command.contributionId === "insert",
    )!;

    await runtime.lifecycle.disable("acme.one");

    expect(await staleCommand.invoke()).toMatchObject({
      ok: false,
      failure: { pluginId: "acme.one", contributionId: "insert", phase: "invoke" },
    });
    expect(await healthyCommand.invoke()).toEqual({ ok: true, value: undefined });
    expect(insertPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.failures.getSnapshot()).toHaveLength(1);
  });

  it("Timeline 宿主写入失败时只隔离当前命令", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.timeline"));
    const commands = listEnabledLocalPluginCommands({
      runtime,
      workspace: null,
      ports: {
        postTimeline: async () => {
          throw new Error("timeline storage unavailable");
        },
      },
    });

    expect(await commands[0]!.invoke()).toMatchObject({
      ok: false,
      failure: {
        pluginId: "acme.timeline",
        contributionId: "timeline",
        contributionKind: "commands",
        phase: "invoke",
        message: "timeline storage unavailable",
      },
    });
    expect(runtime.failures.getSnapshot()).toHaveLength(1);
  });
});
