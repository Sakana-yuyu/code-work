import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  EventId,
  type ServerConfig,
  type OrchestrationThreadActivity,
} from "@codework/contracts";
import { AtomRegistry } from "effect/reactivity";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("thread outbox", () => {
  const queuedModes = () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex_test"),
      model: "fixture-model",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "codexCollaborationMode", value: "plan" },
      ],
    };
    const thread = {
      modelSelection: selection,
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const message = {
      ...queuedMessage({ messageId: "模式队列", createdAt: "2026-10-14T00:00:00.000Z" }),
      ...thread,
    };
    const config = (modes: ReadonlyArray<string>) =>
      ({
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
                      id: "reasoningEffort",
                      label: "推理",
                      type: "select",
                      currentValue: "medium",
                      options: [{ id: "medium", label: "中" }],
                    },
                    ...(modes.length
                      ? [
                          {
                            id: "codexCollaborationMode",
                            label: "模式",
                            type: "select",
                            currentValue: modes[0],
                            options: modes.map((id) => ({ id, label: id })),
                          },
                        ]
                      : []),
                  ],
                },
              },
            ],
          },
        ],
      }) as unknown as ServerConfig;
    return { message, thread, config };
  };

  it("恢复发送按最新目录撤回Plan，保留推理与权限且不改写持久化队列", () => {
    const { message, thread, config } = queuedModes();
    const persisted = encodeQueuedThreadMessage(message);
    const settings = resolveQueuedThreadSettings(message, thread, { config: config(["default"]) });
    expect(settings?.interactionMode).toBe("default");
    expect(settings?.modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "codexCollaborationMode", value: "default" },
    ]);
    expect(settings?.runtimeMode).toBe("approval-required");
    expect(encodeQueuedThreadMessage(message)).toEqual(persisted);
  });

  it("恢复发送在模式全部撤回时删除旧选项，重新广告后仍尊重原计划意图", () => {
    const { message, thread, config } = queuedModes();
    const withdrawn = resolveQueuedThreadSettings(message, thread, { config: config([]) });
    expect(withdrawn?.interactionMode).toBe("default");
    expect(withdrawn?.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "medium" }]);
    const restored = resolveQueuedThreadSettings(message, thread, {
      config: config(["default", "plan"]),
    });
    expect(restored?.interactionMode).toBe("plan");
    expect(restored?.modelSelection.options).toEqual(message.modelSelection.options);
  });

  it("离线或缺少实例信息时保留队列原生意图，V1消息继承线程设置", () => {
    const { message, thread } = queuedModes();
    expect(resolveQueuedThreadSettings(message, thread, { config: null })).toEqual(thread);
    expect(
      resolveQueuedThreadSettings(message, thread, {
        config: { providers: [] } as unknown as ServerConfig,
      }),
    ).toEqual(thread);
    expect(
      resolveQueuedThreadSettings(
        queuedMessage({ messageId: "v1", createdAt: message.createdAt }),
        thread,
        { config: null },
      ),
    ).toEqual(thread);
  });

  it("其他实例的模式不能被借用，旧模型没有广告时撤回Codex模式", () => {
    const { message, thread, config } = queuedModes();
    const current = config(["default"]);
    const other = config(["plan"]).providers[0]!;
    const missingModel = {
      ...current,
      providers: [
        { ...current.providers[0]!, models: [] },
        { ...other, instanceId: ProviderInstanceId.make("other") },
      ],
    };
    const settings = resolveQueuedThreadSettings(message, thread, { config: missingModel });
    expect(settings?.interactionMode).toBe("default");
    expect(settings?.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });

  it("恢复发送采用本线程ACP模式回执，保留原始URI并清理失效值", () => {
    const { message, thread, config } = queuedModes();
    const uri = "https://agentclientprotocol.com/protocol/session-modes#review";
    const original = config([]).providers[0]!;
    const current = {
      ...config([]),
      providers: [{ ...original, driver: ProviderDriverKind.make("acpAgent") }],
    };
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("mode"),
      kind: "session.mode.updated",
      tone: "info",
      summary: "模式",
      createdAt: message.createdAt,
      turnId: null,
      payload: {
        providerInstanceId: original.instanceId,
        mode: {
          id: "acpMode",
          label: "模式",
          type: "select",
          currentValue: uri,
          options: [{ id: uri, label: "审查" }],
        },
      },
    };
    const settings = resolveQueuedThreadSettings(
      {
        ...message,
        modelSelection: {
          ...message.modelSelection,
          options: [{ id: "acpMode", value: "removed" }],
        },
      },
      thread,
      { config: current, activities: [activity] },
    );
    expect(settings?.interactionMode).toBe("default");
    expect(settings?.modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "acpMode", value: uri },
    ]);
  });

  it("会话模型替换后采用同实例新目录，不补回已撤回的队列模型", () => {
    const { message, thread, config } = queuedModes();
    const current = config([]);
    const uri = "https://agentclientprotocol.com/protocol/session-modes#review";
    const queued = {
      ...message,
      modelSelection: {
        ...thread.modelSelection,
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "acpMode", value: uri },
        ],
      },
    };
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("new-models"),
      kind: "session.models.updated",
      tone: "info",
      summary: "目录",
      createdAt: message.createdAt,
      turnId: null,
      payload: {
        providerInstanceId: thread.modelSelection.instanceId,
        models: [
          {
            slug: "current-model",
            name: "当前模型",
            isCustom: false,
            isDefault: true,
            capabilities: {
              optionDescriptors: [
                ...current.providers[0]!.models[0]!.capabilities!.optionDescriptors!,
                {
                  id: "acpMode",
                  label: "模式",
                  type: "select",
                  currentValue: "code",
                  options: [
                    { id: "code", label: "实施" },
                    { id: uri, label: "审查" },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const settings = resolveQueuedThreadSettings(queued, thread, {
      config: current,
      activities: [activity],
    });
    expect(settings?.modelSelection).toEqual({
      instanceId: thread.modelSelection.instanceId,
      model: "current-model",
      options: queued.modelSelection.options,
    });
    expect(settings?.runtimeMode).toBe("approval-required");
    expect(settings?.interactionMode).toBe("default");
    expect(queued.modelSelection.model).toBe("fixture-model");
  });

  it("目录撤回全部模型时保留队列等待，不发送旧模型或借用其他实例", () => {
    const { message, thread, config } = queuedModes();
    const current = config([]);
    const other = { ...current.providers[0]!, instanceId: ProviderInstanceId.make("other") };
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("empty-models"),
      kind: "session.models.updated",
      tone: "info",
      summary: "目录撤回",
      createdAt: message.createdAt,
      turnId: null,
      payload: { providerInstanceId: thread.modelSelection.instanceId, models: [] },
    };
    expect(
      resolveQueuedThreadSettings(message, thread, {
        config: { ...current, providers: [...current.providers, other] },
        activities: [activity],
      }),
    ).toBeNull();
    expect(message.modelSelection).toBe(thread.modelSelection);
  });

  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: "environment-1",
      }),
    ).toThrow();
  });

  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe(false);
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
  });

  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return [...stored.values()];
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("reports structured load failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    let loadCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return [];
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    await manager.load();
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to load persisted messages",
        error: new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ]);

    await manager.load();
    expect(loadCalls).toBe(2);
    registry.dispose();
  });

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("publishes an enqueued message before the durable write resolves", async () => {
    const registry = AtomRegistry.make();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => writeBlocked,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const enqueueing = manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    releaseWrite();
    await enqueueing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    registry.dispose();
  });

  it("rolls an enqueued message back out when the durable write fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          throw writeCause;
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "enqueue",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("keeps a same-id retry queued when the first attempt's write fails", async () => {
    const registry = AtomRegistry.make();
    let failNextWrite = true;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          if (failNextWrite) {
            failNextWrite = false;
            await firstWriteBlocked;
            throw new Error("disk full");
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    const first = manager.enqueue(message);
    const second = manager.enqueue(retried);
    releaseFirstWrite();
    await expect(first).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    await second;

    // The failed first attempt must not roll back the retry that replaced it.
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    await expect(manager.confirmQueued(retried)).resolves.toBe(true);
    await expect(manager.confirmQueued(message)).resolves.toBe(false);
    registry.dispose();
  });

  it("replaces an existing message when an enqueue retry uses the same id", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    await manager.enqueue(message);
    await manager.enqueue(retried);

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    registry.dispose();
  });

  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = { ...message, text: "edited" };
    await expect(manager.update(edited)).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(message.messageId)).toEqual(edited);

    await manager.remove(edited);
    await expect(manager.update({ ...message, text: "stale flush" })).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });

  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
  });

  it("sends existing-thread messages whenever connected so queued messages can steer", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
        threadBusy: true,
      }),
    ).toBe("wait");
  });

  it("sends queued creations once connected and live, removing already-created ones", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
    // Connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("remove");
  });

  it("round-trips queued creations and gates incomplete ones from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("retains queued messages when settings synchronization fails before startTurn", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("discard");
  });
});
