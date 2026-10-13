import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@codework/contracts";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  atomReads: 0,
  config: null as ServerConfig | null,
  threads: [] as unknown[],
  queued: {} as Record<string, QueuedThreadMessage[]>,
  reads: [] as string[],
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
      return key.startsWith("config:") ? harness.config : [];
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
}));
vi.mock("../lib/composerImages", () => ({
  toUploadChatImageAttachments: (attachments: unknown) => attachments,
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
  harness.editing = {};
  harness.finished = null;
  harness.registry.clear();
  harness.queued = { "target:thread": [queued] };
  harness.threads = [{ ...queued, id: queued.threadId, session: null }];
  for (const command of [harness.start, harness.update, harness.runtime, harness.mode])
    command.mockResolvedValue({ _tag: "Success", value: undefined });
  harness.readConfig.mockImplementation(async () => ({ _tag: "Success", value: harness.config }));
});

describe("手机队列实际派发入口", () => {
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
});
