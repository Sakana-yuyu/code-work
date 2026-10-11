import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../orchestration/ActivityPayloadProjection.ts";
import { createRuntimeTurnItems } from "./runtimeTurnItems.ts";

const base = {
  eventId: EventId.make("open"),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-01-01T00:00:00.000Z",
};
describe("Adapter 终态补齐保持三端公共活动合同", () => {
  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    it(`${state} 后公共工具活动完成，审批取消，提问无编造答案`, () => {
      const tracker = createRuntimeTurnItems();
      const starts: ProviderRuntimeEvent[] = [
        {
          ...base,
          eventId: EventId.make("tool"),
          type: "item.started",
          itemId: RuntimeItemId.make("tool-1"),
          payload: { itemType: "mcp_tool_call", status: "inProgress", title: "检查文件" },
        },
        {
          ...base,
          eventId: EventId.make("approval"),
          type: "request.opened",
          requestId: RuntimeRequestId.make("approval-1"),
          payload: { requestType: "exec_command_approval" },
        },
        {
          ...base,
          eventId: EventId.make("question"),
          type: "user-input.requested",
          requestId: RuntimeRequestId.make("question-1"),
          payload: {
            questions: [{ id: "choice", header: "选择", question: "采用哪个方案？", options: [] }],
          },
        },
      ];
      const events = starts.flatMap(tracker.apply);
      const activities = () =>
        events
          .flatMap((event) => runtimeEventToActivities(event))
          .map(projectActivityPayload)
          .map((activity, index) => ({ ...activity, sequence: index + 1 }));
      expect(activities().map((activity) => activity.kind)).toEqual([
        "tool.started",
        "approval.requested",
        "user-input.requested",
      ]);
      events.push(
        ...tracker.apply({
          ...base,
          eventId: EventId.make("end"),
          createdAt: "2026-01-01T00:00:01.000Z",
          type: "turn.completed",
          payload: { state },
        }),
      );
      const settled = activities();
      expect(settled.slice(-3)).toMatchObject([
        {
          kind: "tool.completed",
          turnId: base.turnId,
          payload: { toolCallId: "tool-1", status: state === "completed" ? "completed" : "failed" },
        },
        {
          kind: "approval.resolved",
          turnId: base.turnId,
          payload: { requestId: "approval-1", decision: "cancel" },
        },
        {
          kind: "user-input.resolved",
          turnId: base.turnId,
          payload: { requestId: "question-1", answers: {} },
        },
      ]);
    });
  }
});
