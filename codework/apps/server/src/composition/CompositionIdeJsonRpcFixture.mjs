import { createServer } from "node:http";

import { NodeWS } from "@effect/platform-node/NodeSocket";

const token = "fixture-ide-token";
const sessionId = "vscode-session-fixture";
const server = createServer((_request, response) => {
  response.statusCode = 404;
  response.end();
});
const webSocketServer = new NodeWS.WebSocketServer({ noServer: true });
const sockets = new Set();
const tasks = new Map();
let eventSequence = 0;

const send = (socket, message) => {
  if (socket.readyState === NodeWS.WebSocket.OPEN) socket.send(JSON.stringify(message));
};

const sendTaskEvent = (socket, task, type, payload) => {
  eventSequence += 1;
  send(socket, {
    jsonrpc: "2.0",
    method: "t3.ide.event",
    params: {
      sessionId,
      event: {
        eventId: `fixture-ide-event-${eventSequence}`,
        provider: "ide",
        threadId: task.runtimeId,
        createdAt: new Date().toISOString(),
        type,
        payload,
        raw: {
          source: "ide.jsonrpc",
          method: "t3.ide.event",
          runtimeId: task.runtimeId,
          runtimeTaskId: task.runtimeTaskId,
          payload: { sessionId },
        },
      },
    },
  });
};

webSocketServer.on("connection", (socket, request) => {
  sockets.add(socket);
  socket.on("message", (raw) => {
    let requestMessage;
    try {
      requestMessage = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof requestMessage.id !== "string" || requestMessage.jsonrpc !== "2.0") return;
    const params = requestMessage.params ?? {};
    if (requestMessage.method === "t3.ide.probe") {
      send(socket, {
        jsonrpc: "2.0",
        id: requestMessage.id,
        result: {
          sessionId,
          profile: "vscode_ide",
          verifiedOperations: [
            "editor.read",
            "editor.write",
            "task.start",
            "task.cancel",
            "task.events",
          ],
          status: "ready",
        },
      });
      return;
    }
    if (requestMessage.method === "t3.ide.handshake") {
      send(socket, {
        jsonrpc: "2.0",
        id: requestMessage.id,
        result: {
          sessionId: params.sessionId,
          taskId: params.taskId,
          runId: params.runId,
          agentId: params.agentId,
          profile: "vscode_ide",
          status: "accepted",
          handshakeId: "fixture-ide-handshake",
          acceptedGrantIds: params.capabilityGrantIds ?? [],
          verifiedOperations: params.requestedOperations ?? [],
        },
      });
      return;
    }
    if (requestMessage.method === "t3.ide.invoke") {
      if (params.operation === "task.start") {
        const runtimeTaskId = `fixture-runtime-task-${tasks.size + 1}`;
        const task = {
          taskId: params.taskId,
          runId: params.runId,
          runtimeTaskId,
          runtimeId: params.arguments?.runtimeId ?? `ide:${sessionId}`,
        };
        tasks.set(`${params.taskId}:${params.runId}`, task);
        send(socket, {
          jsonrpc: "2.0",
          id: requestMessage.id,
          result: { runtimeTaskId, status: "accepted" },
        });
        if (String(params.arguments?.prompt ?? "").includes("[fixture:complete]")) {
          queueMicrotask(() => {
            sendTaskEvent(socket, task, "task.progress", {
              taskId: runtimeTaskId,
              description: "IDE fixture 正在执行任务",
              summary: "IDE fixture 已执行第一步",
              status: "running",
            });
            sendTaskEvent(socket, task, "task.completed", {
              taskId: runtimeTaskId,
              status: "completed",
              summary: "IDE fixture 已完成任务",
            });
          });
        }
        return;
      }
      if (params.operation === "task.cancel") {
        const task = [...tasks.values()].find(
          (entry) => entry.runtimeTaskId === params.arguments?.runtimeTaskId,
        );
        send(socket, {
          jsonrpc: "2.0",
          id: requestMessage.id,
          result: { runtimeTaskId: params.arguments?.runtimeTaskId, status: "cancelled" },
        });
        if (task !== undefined) {
          queueMicrotask(() => {
            sendTaskEvent(socket, task, "task.completed", {
              taskId: task.runtimeTaskId,
              status: "stopped",
              summary: "IDE fixture 已取消任务",
            });
          });
        }
        return;
      }
      send(socket, {
        jsonrpc: "2.0",
        id: requestMessage.id,
        result: {
          operation: params.operation,
          sessionId: params.sessionId,
          taskId: params.taskId,
          runId: params.runId,
          agentId: params.agentId,
          contents: "fixture editor response",
          arguments: params.arguments,
        },
      });
    }
  });
  socket.on("close", () => sockets.delete(socket));
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/t3/ide" || request.headers.authorization !== `Bearer ${token}`) {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

const shutdown = () => {
  for (const socket of sockets) {
    if (socket.readyState === NodeWS.WebSocket.OPEN) socket.close();
  }
  webSocketServer.close();
  server.close(() => process.exit(0));
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.includes("close")) shutdown();
});
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    process.stderr.write("IDE fixture server address unavailable\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
