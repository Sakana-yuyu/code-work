import type {
  CompositionAutomation,
  CompositionAutomationListResult,
  CompositionAutomationResult,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  decodeAutomationStatuses,
  formatAutomationDetails,
  formatAutomationList,
  getAutomation,
  listAutomations,
} from "./automation.ts";

const automation: CompositionAutomation = {
  automationId: "automation-daily-review",
  projectId: "project-1",
  name: "Daily review",
  prompt: "Review open issues",
  cadence: {
    type: "cron",
    expression: "0 9 * * 1-5",
    timezone: "Asia/Shanghai",
  },
  target: {
    type: "squad",
    squadId: "squad-review",
    squadRevision: 4,
    executionContext: {
      mode: "isolated",
      workspaceRoot: "E:\\repo",
      archiveOnFinish: true,
    },
  },
  status: "active",
  revision: 2,
  maxRuns: 10,
  runCount: 3,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 2_000,
  nextRunAtUnixMs: 3_000,
  lastRunAtUnixMs: 1_500,
  pausedAtUnixMs: null,
  expiresAtUnixMs: 10_000,
};

const listResult: CompositionAutomationListResult = { automations: [automation] };
const detailsResult: CompositionAutomationResult = { automation };

describe("Automation CLI", () => {
  it.effect("通过 typed RPC 查询 Automation，并透传项目和状态过滤", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(listResult));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({ "server.listCompositionAutomations": rpc } as never);
      };

      const result = yield* listAutomations(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          projectId: "project-1",
          statuses: ["active", "paused"],
        },
        open,
      );

      expect(result).toEqual(listResult);
      expect(connections).toEqual([
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
      ]);
      expect(rpc).toHaveBeenCalledWith({
        projectId: "project-1",
        statuses: ["active", "paused"],
      });
    }),
  );

  it.effect("通过 typed RPC 查询单个 Automation", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(detailsResult));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.getCompositionAutomation": rpc } as never);

      const result = yield* getAutomation(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: automation.automationId,
        },
        open,
      );

      expect(result).toEqual(detailsResult);
      expect(rpc).toHaveBeenCalledWith({ automationId: "automation-daily-review" });
    }),
  );

  it.effect("校验逗号分隔的 Automation 状态过滤", () =>
    Effect.gen(function* () {
      expect(yield* decodeAutomationStatuses("active, paused")).toEqual(["active", "paused"]);
      const error = yield* decodeAutomationStatuses("active,unknown").pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AutomationStatusInputError",
        message: "Automation statuses must be active, paused, or completed.",
      });
    }),
  );

  it("输出稳定的 JSON 或紧凑的人类可读列表", () => {
    expect(formatAutomationList(listResult, true)).toBe(
      JSON.stringify(listResult.automations, null, 2),
    );
    expect(formatAutomationList(listResult, false)).toBe(
      "Daily review  automation-daily-review  r2  active  squad  cron 0 9 * * 1-5 @ Asia/Shanghai  next=1970-01-01T00:00:03.000Z  runs=3/10",
    );
    expect(formatAutomationList({ automations: [] }, false)).toBe("No automations found.");
  });

  it("输出稳定的 Automation 详情", () => {
    expect(formatAutomationDetails(detailsResult, true)).toBe(JSON.stringify(automation, null, 2));
    expect(formatAutomationDetails(detailsResult, false)).toBe(
      [
        "Daily review (automation-daily-review)",
        "Project: project-1",
        "Revision: 2",
        "Status: active",
        "Cadence: cron 0 9 * * 1-5 @ Asia/Shanghai",
        "Target: squad squad-review r4",
        "Execution context: isolated E:\\repo archive-on-finish",
        "Runs: 3/10",
        "Next run: 1970-01-01T00:00:03.000Z",
        "Last run: 1970-01-01T00:00:01.500Z",
        "Expires: 1970-01-01T00:00:10.000Z",
        "Prompt: Review open issues",
      ].join("\n"),
    );
  });
});
