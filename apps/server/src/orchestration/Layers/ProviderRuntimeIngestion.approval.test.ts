import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";

describe("runtimeEventToActivities approval details", () => {
  it("宿主审批公开投影保留单次选项、路径与身份，结算决定不扩大授权", () => {
    const options = [
      { decision: "accept", label: "允许本次" },
      { decision: "decline", label: "拒绝" },
      { decision: "cancel", label: "取消" },
    ] as const;
    const stamp = {
      eventId: EventId.make("host-open"),
      provider: ProviderDriverKind.make("acpAgent"),
      createdAt: "2026-10-01T00:00:00.000Z",
      threadId: ThreadId.make("host-thread"),
      requestId: RuntimeRequestId.make("approval-host-single"),
    };
    const opened = {
      ...stamp,
      type: "request.opened",
      payload: {
        requestType: "file_change_approval",
        detail: "workspace.write_file · approved.txt",
        options,
        args: {
          canonicalToolName: "workspace.write_file",
          relativePath: "approved.txt",
          contents: "不能进入公共审批事件的合成正文",
        },
      },
    } satisfies ProviderRuntimeEvent;
    const [activity] = runtimeEventToActivities(opened).map(projectActivityPayload);
    expect(activity).toMatchObject({
      kind: "approval.requested",
      payload: {
        requestId: stamp.requestId,
        requestKind: "file-change",
        detail: opened.payload.detail,
        options,
      },
    });
    expect(activity?.payload).not.toHaveProperty("args");
    for (const decision of ["accept", "decline", "cancel"] as const) {
      const event = {
        ...stamp,
        eventId: EventId.make("host-" + decision),
        type: "request.resolved",
        payload: { requestType: "file_change_approval", decision },
      } satisfies ProviderRuntimeEvent;
      expect(runtimeEventToActivities(event).map(projectActivityPayload)).toMatchObject([
        { kind: "approval.resolved", payload: { requestId: stamp.requestId, decision } },
      ]);
    }
  });
  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("keeps app details and approval options available to remote clients", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ] as const;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-mcp-elicitation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-08-24T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-safari"),
      payload: {
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity).toMatchObject({
      kind: "approval.requested",
      summary: "App access approval requested",
      payload: {
        requestId: "approval-safari",
        requestKind: "mcp-elicitation",
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    });
  });
});
