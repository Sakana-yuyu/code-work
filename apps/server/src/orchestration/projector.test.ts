import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const activityCreatedAt = "2026-03-01T10:00:00.000Z";

function makeActivity(
  sequence: number | undefined,
  id = `activity-${sequence}`,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    ...(sequence === undefined ? {} : { sequence }),
    createdAt: activityCreatedAt,
    tone: "tool",
    kind: "tool.updated",
    summary: id,
    payload: {},
    turnId: null,
  };
}

function makeActivityEvent(activity: OrchestrationThreadActivity, sequence: number) {
  return makeEvent({
    sequence,
    type: "thread.activity-appended",
    occurredAt: activityCreatedAt,
    aggregateKind: "thread",
    aggregateId: "thread-incremental-activities",
    commandId: `activity-command-${sequence}`,
    payload: { threadId: "thread-incremental-activities", activity },
  });
}

const activityModel = projectEvent(
  createEmptyReadModel(activityCreatedAt),
  makeEvent({
    sequence: 1,
    type: "thread.created",
    occurredAt: activityCreatedAt,
    aggregateKind: "thread",
    aggregateId: "thread-incremental-activities",
    commandId: "create-incremental-activities",
    payload: {
      threadId: "thread-incremental-activities",
      projectId: "activity-project",
      title: "活动夹具",
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: activityCreatedAt,
      updatedAt: activityCreatedAt,
    },
  }),
);

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("orchestration projector", () => {
  effectIt.effect("服务器单调追加不重排 500 条历史，并保留其他线程与回合引用", () =>
    Effect.gen(function* () {
      const base = yield* activityModel;
      let reads = 0;
      const activities = Array.from(
        { length: 500 },
        (_, index) =>
          new Proxy(makeActivity(index), {
            get(target, property, receiver) {
              if (property === "sequence") reads += 1;
              return Reflect.get(target, property, receiver);
            },
          }),
      );
      const other = {
        ...base.threads[0]!,
        id: ThreadId.make("other-incremental-thread"),
        activities,
      };
      const seeded = { ...base, threads: [{ ...base.threads[0]!, activities }, other] };
      const normalized = yield* projectEvent(seeded, makeActivityEvent(makeActivity(500), 2));
      const before = normalized.threads[0]!;
      const oldIds = before.activities.map((row) => row.id);
      reads = 0;
      const next = yield* projectEvent(normalized, makeActivityEvent(makeActivity(501), 3));
      expect(reads).toBeLessThan(25);
      expect(before.activities.map((row) => row.id)).toEqual(oldIds);
      expect(next.threads[0]?.activities).toHaveLength(500);
      expect(next.threads[0]?.activities[0]?.id).toBe("activity-2");
      expect(next.threads[0]?.activities.at(-1)?.id).toBe("activity-501");
      expect(next.threads[0]?.activities[200]).toBe(before.activities[201]);
      expect(next.threads[0]?.latestTurn).toBe(before.latestTurn);
      expect(next.threads[0]?.checkpoints).toBe(before.checkpoints);
      expect(next.threads[0]?.messages).toBe(before.messages);
      expect(next.threads[1]).toBe(other);
    }),
  );

  effectIt.effect("服务器规范化旧快照，缺省序号在前，迟到与替换仍按原顺序", () =>
    Effect.gen(function* () {
      const base = yield* activityModel;
      const legacyA = makeActivity(undefined, "legacy-a");
      const legacyZ = makeActivity(undefined, "legacy-z");
      const initial = [makeActivity(8), legacyZ, makeActivity(1), legacyA];
      const seeded = { ...base, threads: [{ ...base.threads[0]!, activities: initial }] };
      const normalized = yield* projectEvent(seeded, makeActivityEvent(makeActivity(4), 2));
      expect(normalized.threads[0]?.activities.map((row) => row.id)).toEqual([
        "legacy-a",
        "legacy-z",
        "activity-1",
        "activity-4",
        "activity-8",
      ]);
      const late = yield* projectEvent(normalized, makeActivityEvent(makeActivity(2), 3));
      const replacement = { ...makeActivity(9, "activity-1"), summary: "更新身份" };
      const replaced = yield* projectEvent(late, makeActivityEvent(replacement, 4));
      expect(replaced.threads[0]?.activities.map((row) => row.id)).toEqual([
        "legacy-a",
        "legacy-z",
        "activity-2",
        "activity-4",
        "activity-8",
        "activity-1",
      ]);
      expect(replaced.threads[0]?.activities.at(-1)?.summary).toBe("更新身份");
      expect(late.threads[0]?.activities.find((row) => row.id === "activity-1")?.summary).toBe(
        "activity-1",
      );
      expect(initial.map((row) => row.id)).toEqual([
        "activity-8",
        "legacy-z",
        "activity-1",
        "legacy-a",
      ]);
    }),
  );

  effectIt.effect("重复序号按时间与身份定位，重载数组不会继承错误的有序标记", () =>
    Effect.gen(function* () {
      const base = yield* activityModel;
      const a = makeActivity(7, "a");
      const b = makeActivity(7, "b");
      const c = { ...makeActivity(7, "c"), createdAt: "2026-03-01T10:00:01.000Z" };
      const seeded = { ...base, threads: [{ ...base.threads[0]!, activities: [b, c, a] }] };
      const normalized = yield* projectEvent(seeded, makeActivityEvent(makeActivity(7, "d"), 2));
      expect(normalized.threads[0]?.activities.map((row) => row.id)).toEqual(["a", "b", "d", "c"]);
      const reloaded = {
        ...normalized,
        threads: [
          {
            ...normalized.threads[0]!,
            activities: normalized.threads[0]!.activities.toReversed(),
          },
        ],
      };
      const next = yield* projectEvent(reloaded, makeActivityEvent(makeActivity(7, "e"), 3));
      expect(next.threads[0]?.activities.map((row) => row.id)).toEqual(["a", "b", "d", "e", "c"]);
    }),
  );

  effectIt.effect("追加、迟到与已淘汰身份重现均保留原有 500 条上限", () =>
    Effect.gen(function* () {
      let model = yield* activityModel;
      for (let index = 0; index <= 600; index++) {
        model = yield* projectEvent(model, makeActivityEvent(makeActivity(index), index + 2));
      }
      const expected = Array.from({ length: 500 }, (_, index) => `activity-${index + 101}`);
      expect(model.threads[0]?.activities.map((row) => row.id)).toEqual(expected);
      const late = yield* projectEvent(
        model,
        makeActivityEvent(makeActivity(0, "late-evicted"), 603),
      );
      expect(late.threads[0]?.activities.map((row) => row.id)).toEqual(expected);
      const revived = yield* projectEvent(
        late,
        makeActivityEvent(makeActivity(601, "activity-0"), 604),
      );
      expect(revived.threads[0]?.activities.map((row) => row.id)).toEqual([
        ...expected.slice(1),
        "activity-0",
      ]);
      expect(model.threads[0]?.activities.map((row) => row.id)).toEqual(expected);
    }),
  );

  it("applies thread.created events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        queuedMessages: [],
      },
    ]);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-01T00:00:01.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect(archived.threads[0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(unarchived.threads[0]?.archivedAt).toBeNull();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const settledAt = "2026-02-23T08:01:00.000Z";
    const [afterRunning, afterReady] = await Effect.runPromise(
      Effect.flatMap(
        projectEvent(
          afterCreate,
          makeEvent({
            sequence: 2,
            type: "thread.session-set",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: startedAt,
            commandId: "cmd-running",
            payload: {
              threadId: "thread-1",
              session: {
                threadId: "thread-1",
                status: "running",
                providerName: "codex",
                providerSessionId: "session-1",
                providerThreadId: "provider-thread-1",
                runtimeMode: "approval-required",
                activeTurnId: "turn-1",
                lastError: null,
                updatedAt: startedAt,
              },
            },
          }),
        ),
        (running) =>
          Effect.map(
            projectEvent(
              running,
              makeEvent({
                sequence: 3,
                type: "thread.session-set",
                aggregateKind: "thread",
                aggregateId: "thread-1",
                occurredAt: settledAt,
                commandId: "cmd-ready",
                payload: {
                  threadId: "thread-1",
                  session: {
                    threadId: "thread-1",
                    status: "ready",
                    providerName: "codex",
                    providerSessionId: "session-1",
                    providerThreadId: "provider-thread-1",
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: settledAt,
                  },
                },
              }),
            ),
            (ready) => [running, ready] as const,
          ),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");

    // Leaving the "running" session status settles the running turn with the
    // session timestamp as the turn end.
    const settledThread = afterReady.threads[0];
    expect(settledThread?.latestTurn?.turnId).toBe("turn-1");
    expect(settledThread?.latestTurn?.state).toBe("completed");
    expect(settledThread?.latestTurn?.completedAt).toBe(settledAt);
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            providerInstanceId: "codex",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.providerInstanceId).toBe("codex");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);

    const afterSwitch = await Effect.runPromise(
      projectEvent(
        afterComplete,
        makeEvent({
          sequence: 4,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-switch-provider",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "ready",
              providerName: "claudeAgent",
              providerInstanceId: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: completeAt,
            },
          },
        }),
      ),
    );
    const afterNewAssistant = await Effect.runPromise(
      projectEvent(
        afterSwitch,
        makeEvent({
          sequence: 5,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-new-assistant",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-2",
            role: "assistant",
            providerInstanceId: "claudeAgent",
            text: "new agent",
            turnId: "turn-2",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );
    expect(afterNewAssistant.threads[0]?.messages.map((entry) => entry.providerInstanceId)).toEqual(
      ["codex", "claudeAgent"],
    );
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  effectIt.effect("caps message and checkpoint retention for long-lived threads", () =>
    Effect.gen(function* () {
      const createdAt = "2026-03-01T10:00:00.000Z";
      const model = createEmptyReadModel(createdAt);

      const afterCreate = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      );

      const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
        { length: 2_100 },
        (_, index) =>
          makeEvent({
            sequence: index + 2,
            type: "thread.message-sent",
            aggregateKind: "thread",
            aggregateId: "thread-capped",
            occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            commandId: `cmd-message-${index}`,
            payload: {
              threadId: "thread-capped",
              messageId: `msg-${index}`,
              role: "assistant",
              text: `message-${index}`,
              turnId: `turn-${index}`,
              streaming: false,
              createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
              updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            },
          }),
      );
      let afterMessages = afterCreate;
      for (const event of messageEvents) {
        afterMessages = yield* projectEvent(afterMessages, event);
      }

      const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
        { length: 600 },
        (_, index) =>
          makeEvent({
            sequence: index + 2_102,
            type: "thread.turn-diff-completed",
            aggregateKind: "thread",
            aggregateId: "thread-capped",
            occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
            commandId: `cmd-checkpoint-${index}`,
            payload: {
              threadId: "thread-capped",
              turnId: `turn-${index}`,
              checkpointTurnCount: index + 1,
              checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
              status: "ready",
              files: [],
              assistantMessageId: `msg-${index}`,
              completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
            },
          }),
      );
      let finalState = afterMessages;
      for (const event of checkpointEvents) {
        finalState = yield* projectEvent(finalState, event);
      }

      const thread = finalState.threads[0];
      expect(thread?.messages).toHaveLength(2_000);
      expect(thread?.messages[0]?.id).toBe("msg-100");
      expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
      expect(thread?.checkpoints).toHaveLength(500);
      expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
      expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
    }),
  );
});
