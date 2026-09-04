// 独立进程运行的本地 Multica daemon fixture：真实 HTTP 快建语义，用于进程级集成验证。
import * as NodeHttp from "node:http";

const state = {
  issues: new Map(), // idempotencyKey -> { taskId, prompt }
  quickCreateRequests: 0,
};

const respondJson = (response, status, body) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

const server = NodeHttp.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/__ready") {
    respondJson(response, 200, { ready: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__state") {
    const key = url.searchParams.get("key");
    const issue = key === null ? undefined : state.issues.get(key);
    respondJson(response, 200, {
      quickCreateRequests: state.quickCreateRequests,
      ...(issue === undefined ? {} : { taskId: issue.taskId, prompt: issue.prompt }),
    });
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/issues/by-key/")) {
    const key = decodeURIComponent(url.pathname.slice("/api/issues/by-key/".length));
    const issue = state.issues.get(key);
    if (issue === undefined) {
      respondJson(response, 404, { error: "not_found" });
      return;
    }
    respondJson(response, 200, { task_id: issue.taskId });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/issues/quick-create") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      state.quickCreateRequests += 1;
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        respondJson(response, 400, { error: "invalid_json" });
        return;
      }
      // 幂等键重放：已创建过则返回同一远端 ID，不重复建档。
      const key = request.headers["x-idempotency-key"];
      const workspaceId = request.headers["x-workspace-id"];
      if (typeof workspaceId !== "string" || workspaceId.length === 0) {
        respondJson(response, 400, { error: "missing_workspace" });
        return;
      }
      let issue = typeof key === "string" ? state.issues.get(key) : undefined;
      const dropResponse = request.headers["x-test-drop-response"] === "1" && issue === undefined;
      if (issue === undefined) {
        issue = {
          taskId: `remote-issue-${state.quickCreateRequests}`,
          prompt: typeof body.prompt === "string" ? body.prompt : "",
        };
        if (typeof key === "string") state.issues.set(key, issue);
      }
      if (dropResponse) {
        // 模拟"远端已创建但响应丢失"：服务端记录完成后直接断开连接。
        response.destroy();
        return;
      }
      respondJson(response, 200, { task_id: issue.taskId });
    });
    return;
  }
  respondJson(response, 404, { error: "not_found" });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
