import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type OrchestrationThreadActivity,
} from "@codework/contracts";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  atomReads: 0,
  config: null as ServerConfig | null,
  threads: [] as unknown[],
  queued: {} as Record<string, QueuedThreadMessage[]>,
  reads: [] as string[],
  activities: [] as OrchestrationThreadActivity[],
  confirm: vi.fn(),
  remove: vi.fn(),
  start: vi.fn(),
  update: vi.fn(),
  runtime: vi.fn(),
  mode: vi.fn(),
  readConfig: vi.fn(),
  editing: {} as Record<string, boolean>,
  finished: null as (() => void) | null,
  registry: new Map<unknown, unknown>(),
  prepareFiles: vi.fn(),
  persist: vi.fn(),
  deleteFiles: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => harness.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => (harness.atomReads++ === 0 ? null : {}),
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (key: unknown) => {
      if (typeof key !== "string")
        return harness.registry.has(key) ? harness.registry.get(key) : harness.editing;
      harness.reads.push(key);
      return key.startsWith("config:")
        ? harness.config
        : key.startsWith("activities:")
          ? harness.activities
          : [];
    },
    set: (key: unknown, value: unknown) => {
      harness.registry.set(key, value);
      if (value === null) harness.finished?.();
    },
  },
}));
vi.mock("./server", () => ({
  serverEnvironment: { readConfig: "readConfig", configValueAtom: (id: string) => `config:${id}` },
}));
vi.mock("./threads", () => ({
  threadEnvironment: {
    startTurn: "start",
    updateMetadata: "update",
    setRuntimeMode: "runtime",
    setInteractionMode: "mode",
  },
  environmentThreadDetails: {
    activitiesAtom: (ref: { environmentId: string; threadId: string }) =>
      `activities:${ref.environmentId}:${ref.threadId}`,
  },
}));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: "start" | "update" | "runtime" | "mode" | "readConfig") =>
    harness[command],
}));
vi.mock("./entities", () => ({ useProjects: () => [], useThreadShells: () => harness.threads }));
vi.mock("./use-thread-outbox", () => ({
  editingQueuedMessageIdsAtom: {},
  useThreadOutboxMessages: () => harness.queued,
  useThreadOutboxShellStatuses: () => new Map([["target", "live"]]),
}));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "target", connectionState: "connected" }],
  }),
}));
vi.mock("./thread-outbox", () => ({
  ensureThreadOutboxLoaded: vi.fn(),
  confirmThreadOutboxMessageQueued: (...args: unknown[]) => harness.confirm(...args),
  removeThreadOutboxMessage: (...args: unknown[]) => harness.remove(...args),
  updateThreadOutboxMessage: (...args: unknown[]) => harness.persist(...args),
}));
vi.mock("../lib/composerImages", () => ({
  toTurnAttachments: (attachments: unknown) => attachments,
}));
vi.mock("../lib/composerFiles", () => ({
  prepareComposerFileUploads: (...args: unknown[]) => harness.prepareFiles(...args),
  deleteOwnedComposerFiles: (...args: unknown[]) => harness.deleteFiles(...args),
}));
vi.mock("../lib/uuid", () => ({ randomHex: () => "fixture" }));
vi.mock("../i18n/runtime", () => ({ t: (key: string) => key }));

import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

const selection = {
  instanceId: ProviderInstanceId.make("codex_test"),
  model: "fixture-model",
  options: [{ id: "codexCollaborationMode", value: "plan" }],
};
const queued: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("target"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "受控队列消息",
  attachments: [],
  modelSelection: selection,
  interactionMode: "plan",
  runtimeMode: "approval-required",
  createdAt: "2026-10-14T00:00:00.000Z",
};
const config = {
  providers: [
    {
      instanceId: selection.instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated", type: "none" },
      showInteractionModeToggle: false,
      models: [
        {
          slug: selection.model,
          name: "受控模型",
          capabilities: {
            optionDescriptors: [
              {
                id: "codexCollaborationMode",
                label: "模式",
                type: "select",
                currentValue: "default",
                options: [{ id: "default", label: "默认" }],
              },
            ],
          },
        },
      ],
    },
  ],
} as unknown as ServerConfig;

beforeEach(() => {
  vi.clearAllMocks();
  harness.effects = [];
  harness.atomReads = 0;
  harness.config = null;
  harness.reads = [];
  harness.activities = [];
  harness.editing = {};
  harness.finished = null;
  harness.registry.clear();
  harness.queued = { "target:thread": [queued] };
  harness.threads = [{ ...queued, id: queued.threadId, session: null }];
  for (const command of [harness.start, harness.update, harness.runtime, harness.mode])
    command.mockResolvedValue({ _tag: "Success", value: undefined });
  harness.readConfig.mockImplementation(async () => ({ _tag: "Success", value: harness.config }));
  harness.prepareFiles.mockImplementation(
    async (input: { attachments: unknown }) => input.attachments,
  );
  harness.persist.mockResolvedValue(true);
  harness.deleteFiles.mockResolvedValue(undefined);
});

describe("手机队列实际派发入口", () => {
  it("主会话撤回全部模型后不派发、不写设置、不删除待发内容", async () => {
    harness.config = config;
    harness.activities = [
      {
        id: "withdraw-models",
        kind: "session.models.updated",
        tone: "info",
        summary: "目录撤回",
        createdAt: queued.createdAt,
        turnId: null,
        payload: { providerInstanceId: selection.instanceId, models: [] },
      } as OrchestrationThreadActivity,
    ];
    harness.confirm.mockResolvedValue(true);
    const finished = new Promise<void>((resolve) => (harness.finished = resolve));
    useThreadOutboxDrain();
    const cleanups = harness.effects.map((effect) => effect());
    await finished;
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.mode).not.toHaveBeenCalled();
    expect(harness.runtime).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.queued["target:thread"]).toEqual([queued]);
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  });

  it("当前配置读取失败保留队列，读取期间进入编辑也不发送", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => (complete = resolve));
    harness.finished = complete;
    harness.confirm.mockResolvedValue(true);
    harness.readConfig.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
    useThreadOutboxDrain();
    const cleanups = harness.effects.map((effect) => effect());
    await finished;
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    warn.mockRestore();
  });

  it("等待当前配置时进入队列编辑不会发送或删除消息", async () => {
    let respond!: (value: unknown) => void;
    harness.readConfig.mockReturnValue(new Promise((resolve) => (respond = resolve)));
    const entered = new Promise<void>((resolve) =>
      harness.confirm.mockImplementation(async () => {
        resolve();
        return true;
      }),
    );
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => (complete = resolve));
    harness.finished = complete;
    useThreadOutboxDrain();
    for (const effect of harness.effects) effect();
    await entered;
    harness.editing[queued.messageId] = true;
    respond({ _tag: "Success", value: config });
    await finished;
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  for (const creation of [false, true]) {
    it(`${creation ? "新线程" : "已有线程"}在持久化确认后读取所属环境最新目录再发送`, async () => {
      let confirm!: (value: boolean) => void;
      harness.confirm.mockReturnValue(new Promise<boolean>((resolve) => (confirm = resolve)));
      let complete!: () => void;
      const delivered = new Promise<void>((resolve) => (complete = resolve));
      harness.remove.mockImplementation(async () => complete());
      if (creation) {
        harness.threads = [];
        harness.queued = {
          "target:thread": [
            {
              ...queued,
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "C:/fixture",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            },
          ],
        };
      }
      useThreadOutboxDrain();
      for (const effect of harness.effects) effect();
      expect(harness.reads).toEqual([]);
      harness.config = config;
      confirm(true);
      await delivered;
      expect(harness.start).toHaveBeenCalledOnce();
      const request = harness.start.mock.calls[0]![0];
      expect(request.environmentId).toBe("target");
      expect(request.input).toMatchObject({
        modelSelection: {
          ...selection,
          options: [{ id: "codexCollaborationMode", value: "default" }],
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
      });
      expect(harness.readConfig).toHaveBeenCalledExactlyOnceWith({
        environmentId: "target",
        input: {},
      });
      expect(harness.reads).toEqual(creation ? [] : ["activities:target:thread"]);
      expect(harness.update).toHaveBeenCalledTimes(creation ? 0 : 1);
      expect(harness.mode).toHaveBeenCalledTimes(creation ? 0 : 1);
      expect(queued.modelSelection).toEqual(selection);
      expect(harness.remove).toHaveBeenCalledOnce();
    });
  }

  const file = {
    id: "draft-file",
    type: "file" as const,
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
    fileUri: "file:///documents/codework-composer-files/draft-file-report.pdf",
  };

  it("上传文件后带上传 id 发送，记录 id 供重试复用，送达后清理本地副本", async () => {
    harness.confirm.mockResolvedValue(true);
    harness.config = config;
    const uploaded = {
      ...file,
      uploadedAttachmentId: "pending-1-pdf",
      uploadEnvironmentId: "target",
    };
    harness.prepareFiles.mockResolvedValue([uploaded]);
    harness.queued = { "target:thread": [{ ...queued, attachments: [file] }] };
    let complete!: () => void;
    const delivered = new Promise<void>((resolve) => (complete = resolve));
    harness.remove.mockImplementation(async () => complete());
    useThreadOutboxDrain();
    for (const effect of harness.effects) effect();
    await delivered;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.prepareFiles).toHaveBeenCalledExactlyOnceWith({
      environmentId: "target",
      attachments: [file],
    });
    expect(harness.persist.mock.calls[0]![0]).toMatchObject({ attachments: [uploaded] });
    expect(harness.start.mock.calls[0]![0].input.message.attachments).toEqual([uploaded]);
    expect(harness.deleteFiles).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it("文件无法上传时不派发、不删除，留待退避重试", async () => {
    harness.confirm.mockResolvedValue(true);
    harness.config = config;
    let rejected!: () => void;
    const attempted = new Promise<void>((resolve) => (rejected = resolve));
    harness.prepareFiles.mockImplementation(async () => {
      rejected();
      throw new Error("upload failed");
    });
    harness.queued = { "target:thread": [{ ...queued, attachments: [file] }] };
    useThreadOutboxDrain();
    for (const effect of harness.effects) effect();
    await attempted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.deleteFiles).not.toHaveBeenCalled();
  });
});
