import * as NodeHttp from "node:http";

import { NodeWS } from "@effect/platform-node/NodeSocket";

const token = "fixture-token";
const runtimeId = "runtime-1";
const workspaceId = "workspace-1";
const taskId = "remote-task-1";

const httpServer = NodeHttp.createServer((_request, response) => {
  response.statusCode = 404;
  response.end();
});
const daemonWebSocketServer = new NodeWS.WebSocketServer({ noServer: true });
const taskWebSocketServer = new NodeWS.WebSocketServer({ noServer: true });
const sockets = new Set();

const send = (socket, type, payload, eventId) => {
  if (socket.readyState !== NodeWS.WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type,
      payload,
      ...(eventId === undefined ? {} : { event_id: eventId }),
    }),
  );
};

const closeSocket = (socket) => {
  sockets.delete(socket);
  if (socket.readyState === NodeWS.WebSocket.OPEN) socket.close();
};

daemonWebSocketServer.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "daemon:heartbeat") {
      const payload = message.payload ?? {};
      send(socket, "daemon:heartbeat_ack", {
        runtime_id: payload.runtime_id,
        status: "online",
        server_capabilities: ["rpc-v1"],
      });
      send(
        socket,
        "daemon:task_available",
        {
          runtime_id: payload.runtime_id,
          task_id: taskId,
        },
        "fixture-control-task-available",
      );
      return;
    }
    if (message.type === "daemon:rpc_request") {
      const payload = message.payload ?? {};
      send(socket, "daemon:rpc_response", {
        request_id: payload.request_id,
        status: 200,
        body: { fixture: true, method: payload.method },
      });
    }
  });
  socket.on("close", () => sockets.delete(socket));
});

taskWebSocketServer.on("connection", (socket, request) => {
  sockets.add(socket);
  const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
  const requestedWorkspace = query.get("workspace_id");
  let authenticated = false;
  let workspaceSubscribed = false;
  let taskSubscribed = false;
  let eventsSent = false;

  const sendTaskEvents = () => {
    if (!authenticated || !workspaceSubscribed || !taskSubscribed || eventsSent) return;
    eventsSent = true;
    send(
      socket,
      "task:progress",
      {
        workspace_id: workspaceId,
        task_id: taskId,
        summary: "fixture progress",
        step: 1,
        total: 2,
      },
      "fixture-task-progress",
    );
    send(
      socket,
      "task:completed",
      {
        workspace_id: workspaceId,
        task_id: taskId,
        output: "fixture completed",
      },
      "fixture-task-completed",
    );
  };

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!authenticated) {
      if (message.type !== "auth" || message.payload?.token !== token) {
        send(socket, "auth_error", { error: "invalid fixture token" });
        closeSocket(socket);
        return;
      }
      authenticated = true;
      send(socket, "auth_ack", {});
      return;
    }
    if (message.type !== "subscribe") return;
    if (
      message.payload?.scope === "task" &&
      message.payload?.id === taskId &&
      requestedWorkspace === workspaceId
    ) {
      taskSubscribed = true;
      send(socket, "subscribe_ack", { scope: "task", id: taskId });
      sendTaskEvents();
      return;
    }
    if (message.payload?.scope !== "workspace" || message.payload?.id !== requestedWorkspace) {
      send(socket, "subscribe_error", { scope: message.payload?.scope, id: message.payload?.id });
      return;
    }
    workspaceSubscribed = true;
    send(socket, "subscribe_ack", { scope: "workspace", id: requestedWorkspace });
    if (requestedWorkspace !== workspaceId) closeSocket(socket);
  });
  socket.on("close", () => sockets.delete(socket));
});

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const isDaemon = url.pathname === "/api/daemon/ws";
  const isTask = url.pathname === "/ws" && url.searchParams.get("workspace_id") === workspaceId;
  if (!isDaemon && !isTask) {
    socket.destroy();
    return;
  }
  if (isDaemon && request.headers.authorization !== `Bearer ${token}`) {
    socket.destroy();
    return;
  }
  const server = isDaemon ? daemonWebSocketServer : taskWebSocketServer;
  server.handleUpgrade(request, socket, head, (webSocket) => {
    server.emit("connection", webSocket, request);
  });
});

const shutdown = () => {
  for (const socket of sockets) closeSocket(socket);
  daemonWebSocketServer.close();
  taskWebSocketServer.close();
  httpServer.close(() => process.exit(0));
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.includes("close")) shutdown();
});
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (typeof address !== "object" || address === null) {
    process.stderr.write("fixture server address unavailable\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
