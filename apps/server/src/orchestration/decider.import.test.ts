import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@codework/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("外部会话导入", (it) => {
  it.effect("原子生成线程、消息和来源事件，重复导入不覆盖标题", () =>
    Effect.gen(function* () {
      const createdAt = "2026-09-24T01:00:00.000Z";
      const projectId = ProjectId.make("project-import");
      const threadId = ThreadId.make("external_abc");
      const project = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("project-import-event"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("project-import-command"),
        causationEventId: null,
        correlationId: CommandId.make("project-import-command"),
        metadata: {},
        payload: {
          projectId,
          title: "项目",
          workspaceRoot: "/tmp/project-import",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      const command = {
        type: "thread.import" as const,
        commandId: CommandId.make("import-command"),
        threadId,
        projectId,
        title: "原始标题",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        provider: "codex" as const,
        nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
        createdAt,
        importedAt: "2026-09-24T02:00:00.000Z",
        messages: [
          {
            messageId: MessageId.make("import-user"),
            role: "user" as const,
            text: "请求",
            createdAt,
          },
          {
            messageId: MessageId.make("import-assistant"),
            role: "assistant" as const,
            text: "回复",
            createdAt,
          },
        ],
      };
      const decided = yield* decideOrchestrationCommand({ command, readModel: project });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      let projected = project;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 2 });
      }
      expect(projected.threads[0]?.messages.map((message) => message.text)).toEqual([
        "请求",
        "回复",
      ]);
      expect(projected.threads[0]?.messages.map((message) => message.providerInstanceId)).toEqual([
        undefined,
        "codex",
      ]);
      const repeated = yield* Effect.flip(
        decideOrchestrationCommand({ command, readModel: projected }),
      );
      expect(repeated.message).toContain("already exists");
      expect(projected.threads[0]?.title).toBe("原始标题");

      const switched = {
        ...projected,
        threads: projected.threads.map((thread) => ({
          ...thread,
          session: {
            threadId,
            status: "ready" as const,
            providerName: "claudeAgent",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
        })),
      };
      for (const assistantCommand of [
        {
          type: "thread.message.assistant.delta" as const,
          commandId: CommandId.make("switched-delta"),
          threadId,
          messageId: MessageId.make("switched-delta"),
          delta: "新回复",
          createdAt,
        },
        {
          type: "thread.message.assistant.complete" as const,
          commandId: CommandId.make("switched-complete"),
          threadId,
          messageId: MessageId.make("switched-complete"),
          createdAt,
        },
      ]) {
        const event = yield* decideOrchestrationCommand({
          command: assistantCommand,
          readModel: switched,
        });
        expect(event).toMatchObject({
          type: "thread.message-sent",
          payload: { providerInstanceId: "claudeAgent" },
        });
      }
    }),
  );
});
