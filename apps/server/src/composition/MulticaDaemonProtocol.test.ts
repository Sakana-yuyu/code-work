import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  MulticaDaemonProtocolFailure,
  decodeMulticaWebSocketFrame,
  encodeMulticaWebSocketFrame,
  makeMulticaDaemonProtocol,
  type MulticaHttpRequest,
  type MulticaHttpResponse,
  type MulticaHttpTransport,
} from "./MulticaDaemonProtocol.ts";

const response = <T>(status: number, body: T): MulticaHttpResponse<T> => ({
  status,
  body,
});

const makeTransport = (
  handler: (request: MulticaHttpRequest) => MulticaHttpResponse<unknown>,
): MulticaHttpTransport => ({
  request: <T>(request: MulticaHttpRequest) =>
    Effect.succeed(handler(request) as MulticaHttpResponse<T>),
});

describe("MulticaDaemonProtocol", () => {
  it("按官方 daemon 路径和 snake_case 请求体注册、心跳并领取任务", async () => {
    const requests: MulticaHttpRequest[] = [];
    const protocol = makeMulticaDaemonProtocol({
      baseUrl: "http://multica.test/",
      transport: makeTransport((request) => {
        requests.push(request);
        if (request.path === "/api/daemon/register") {
          return response(200, {
            runtimes: [{ id: "runtime-1", name: "Codex", provider: "codex", status: "online" }],
          });
        }
        if (request.path === "/api/daemon/heartbeat") {
          return response(200, {
            runtime_id: "runtime-1",
            status: "online",
            server_capabilities: ["rpc-v1"],
          });
        }
        if (request.path === "/api/daemon/runtimes/runtime-1/tasks/claim") {
          return response(200, {
            task: {
              id: "task-1",
              agent_id: "agent-1",
              runtime_id: "runtime-1",
              status: "dispatched",
            },
          });
        }
        throw new Error(`未预期路径：${request.path}`);
      }),
    });

    await expect(
      Effect.runPromise(
        protocol.register({
          workspaceId: "workspace-1",
          daemonId: "daemon-1",
          deviceName: "dev",
          cliVersion: "0.1.0",
          launchedBy: "t3",
          runtimes: [{ name: "Codex", type: "codex", version: "1.0.0", status: "online" }],
        }),
      ),
    ).resolves.toMatchObject({ runtimes: [{ id: "runtime-1", provider: "codex" }] });

    await expect(Effect.runPromise(protocol.heartbeat("runtime-1"))).resolves.toEqual({
      runtimeId: "runtime-1",
      status: "online",
      serverCapabilities: ["rpc-v1"],
      runtimeGone: false,
    });

    await expect(Effect.runPromise(protocol.claimTask("runtime-1"))).resolves.toMatchObject({
      id: "task-1",
      agentId: "agent-1",
      runtimeId: "runtime-1",
    });

    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/daemon/register",
        body: expect.objectContaining({
          workspace_id: "workspace-1",
          daemon_id: "daemon-1",
          cli_version: "0.1.0",
          runtimes: [{ name: "Codex", type: "codex", version: "1.0.0", status: "online" }],
        }),
      }),
      expect.objectContaining({
        method: "POST",
        path: "/api/daemon/heartbeat",
        body: { runtime_id: "runtime-1", supports_batch_import: true },
      }),
      expect.objectContaining({
        method: "POST",
        path: "/api/daemon/runtimes/runtime-1/tasks/claim",
        body: {},
      }),
    ]);
  });

  it("通过 X-Workspace-ID 调用官方 quick-create 并返回队列 task_id", async () => {
    const protocol = makeMulticaDaemonProtocol({
      baseUrl: "https://multica.test",
      transport: makeTransport((request) => {
        expect(request.path).toBe("/api/issues/quick-create");
        expect(request.headers).toEqual({ "X-Workspace-ID": "workspace-1" });
        expect(request.body).toEqual({
          squad_id: "squad-1",
          prompt: "拆分登录任务",
          priority: "high",
          due_date: "2026-08-25",
          project_id: "project-1",
          parent_issue_id: "issue-1",
          attachment_ids: ["attachment-1"],
        });
        return response(202, { task_id: "multica-task-1" });
      }),
    });

    await expect(
      Effect.runPromise(
        protocol.quickCreateTask({
          workspaceId: "workspace-1",
          squadId: "squad-1",
          prompt: "拆分登录任务",
          priority: "high",
          dueDate: "2026-08-25",
          projectId: "project-1",
          parentIssueId: "issue-1",
          attachmentIds: ["attachment-1"],
        }),
      ),
    ).resolves.toEqual({ taskId: "multica-task-1" });
  });

  it("拒绝同时指定或同时缺少 Agent/Squad", async () => {
    const protocol = makeMulticaDaemonProtocol({
      baseUrl: "https://multica.test",
      transport: makeTransport(() => response(202, { task_id: "unused" })),
    });

    await expect(
      Effect.runPromise(
        protocol.quickCreateTask({
          workspaceId: "workspace-1",
          prompt: "无归属任务",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      Effect.runPromise(
        protocol.quickCreateTask({
          workspaceId: "workspace-1",
          agentId: "agent-1",
          squadId: "squad-1",
          prompt: "重复归属任务",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("把进度、完成、失败和取消确认映射到正确的 daemon 回报接口", async () => {
    const requests: MulticaHttpRequest[] = [];
    const protocol = makeMulticaDaemonProtocol({
      baseUrl: "https://multica.test",
      transport: makeTransport((request) => {
        requests.push(request);
        return response(200, { status: "ok" });
      }),
    });

    await Effect.runPromise(
      Effect.all(
        [
          protocol.startTask("task-1"),
          protocol.reportProgress("task-1", { summary: "处理中", step: 2, total: 5 }),
          protocol.completeTask("task-1", {
            output: "完成",
            branchName: "codex/task-1",
            sessionId: "session-1",
            workDir: "C:/workspace",
          }),
          protocol.failTask("task-2", {
            error: "失败",
            failureReason: "transport_error",
            sessionId: "session-2",
          }),
          protocol.acknowledgeCancellation("task-3", {
            branchName: "codex/task-3",
            failureReason: "cancelled",
          }),
        ],
        { concurrency: "unbounded" },
      ),
    );

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/daemon/tasks/task-1/start",
          body: {},
        }),
        expect.objectContaining({
          method: "POST",
          path: "/api/daemon/tasks/task-1/progress",
          body: { summary: "处理中", step: 2, total: 5 },
        }),
        expect.objectContaining({
          method: "POST",
          path: "/api/daemon/tasks/task-1/complete",
          body: {
            output: "完成",
            branch_name: "codex/task-1",
            session_id: "session-1",
            work_dir: "C:/workspace",
          },
        }),
        expect.objectContaining({
          method: "POST",
          path: "/api/daemon/tasks/task-2/fail",
          body: { error: "失败", failure_reason: "transport_error", session_id: "session-2" },
        }),
        expect.objectContaining({
          method: "POST",
          path: "/api/daemon/tasks/task-3/cancel-ack",
          body: { branch_name: "codex/task-3", failure_reason: "cancelled" },
        }),
      ]),
    );
  });

  it("HTTP 非 2xx 和错误响应不会被伪装成空成功", async () => {
    const protocol = makeMulticaDaemonProtocol({
      baseUrl: "https://multica.test",
      transport: makeTransport(() => response(503, { error: "服务不可用" })),
    });

    await expect(Effect.runPromise(protocol.getTaskStatus("task-1"))).rejects.toMatchObject({
      _tag: "MulticaDaemonProtocolFailure",
      code: "http_error",
      status: 503,
    });
    await expect(Effect.runPromise(protocol.getTaskStatus("task-1"))).rejects.toBeInstanceOf(
      MulticaDaemonProtocolFailure,
    );
  });

  it("WebSocket frame 编解码保留事件类型和顶层 event_id", () => {
    const encoded = encodeMulticaWebSocketFrame({
      type: "daemon:heartbeat",
      payload: { runtime_id: "runtime-1" },
      eventId: "event-1",
    });
    expect(decodeMulticaWebSocketFrame(encoded)).toEqual({
      type: "daemon:heartbeat",
      payload: { runtime_id: "runtime-1" },
      eventId: "event-1",
    });

    expect(
      decodeMulticaWebSocketFrame(
        JSON.stringify({ type: "task:progress", event_id: "relay-event-1", payload: {} }),
      ),
    ).toEqual({ type: "task:progress", eventId: "relay-event-1", payload: {} });
    expect(() =>
      decodeMulticaWebSocketFrame(
        JSON.stringify({ type: "task:progress", event_id: "", payload: {} }),
      ),
    ).toThrow();

    expect(() => decodeMulticaWebSocketFrame("不是 JSON")).toThrow();
  });
});
