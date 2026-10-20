#!/usr/bin/env node
// ZCode `--prompt … --output-format stream-json` 的最小替身：逐行输出会话事件信封，
// 最后一行 type:"result"。MOCK_ZCODE_MODE 控制场景；MOCK_ZCODE_ARGV_FILE 记录每轮 argv。
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const argv = process.argv.slice(2);
if (process.env.MOCK_ZCODE_ARGV_FILE) {
  NodeFS.appendFileSync(process.env.MOCK_ZCODE_ARGV_FILE, `${JSON.stringify(argv)}\n`);
}
const resumeIndex = argv.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? argv[resumeIndex + 1] : "zc-session-1";
const mode = process.env.MOCK_ZCODE_MODE ?? "happy";
const releaseFile = process.env.MOCK_ZCODE_RELEASE_FILE;
let seq = 0;
const emit = (type, payload, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ type, eventId: `e${++seq}`, sessionId, seq, timestamp: Date.now(), traceId: "t", turnId: "turn-1", payload, ...extra })}\n`,
  );

if (mode === "crash") {
  process.stderr.write("zcode: provider not ready\n");
  process.exit(3);
}

if (mode === "delayed-exit" && resumeIndex >= 0 && releaseFile) {
  NodeFS.writeFileSync(releaseFile, "release\n");
}

// `drift`：模拟续接会话按会话库里的旧模型跑（MOCK_ZCODE_ACTUAL_MODEL 指定回报的模型）。
emit("turn.started", {
  turnNumber: 1,
  input: "x",
  ...(mode === "drift"
    ? {
        intent: {
          modelSelection: {
            providerId: process.env.MOCK_ZCODE_ACTUAL_PROVIDER ?? "codework-openai",
            modelId: process.env.MOCK_ZCODE_ACTUAL_MODEL ?? "stale-byok-adapter",
            options: {},
          },
        },
      }
    : {}),
});

if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  emit("turn.failed", {
    error: { type: "model", message: "upstream said no" },
    turnPhase: "model",
  });
  process.stdout.write(`${JSON.stringify({ type: "result", sessionId, response: "" })}\n`);
} else {
  emit("model.streaming", { kind: "reasoning_delta", delta: "thinking" });
  emit("model.streaming", { kind: "text_delta", delta: "hello " });
  emit("model.streaming", { kind: "text_delta", delta: "world" });
  // 占位标题先来一次：适配器必须丢掉，不能把用户起的线程名覆盖掉。
  emit("session.titleUpdated", {
    previousTitle: "Untitled",
    source: "default",
    title: "New session",
  });
  emit("session.titleUpdated", {
    previousTitle: "New session",
    source: "generated",
    title: "Fixture session title",
  });
  // 无头模式会拒绝的非白名单工具：适配器只能提示，不能开成可交互审批。
  // 只在 happy 场景发：drift 场景要断言「只提醒一次」，别让权限提示混进去。
  if (mode === "happy") {
    emit("permission.requested", {
      requestId: "perm1",
      toolCallId: "tc1",
      toolName: "Bash",
      reason: "headless mock",
      riskLevel: "medium",
      requestedAt: new Date().toISOString(),
    });
  }
  // 参数流：先开行、再分块吐 JSON，最后 end。分块不是可解析的 JSON 前缀。
  emit("model.streaming", {
    kind: "tool_input_start",
    toolCallId: "tc1",
    toolName: "Bash",
    delta: "",
  });
  emit("model.streaming", { kind: "tool_input_delta", toolCallId: "tc1", delta: '{"command":' });
  emit("model.streaming", { kind: "tool_input_delta", toolCallId: "tc1", delta: '"ls"}' });
  emit("model.streaming", { kind: "tool_input_end", toolCallId: "tc1", delta: "" });
  emit("tool.updated", {
    kind: "scheduled",
    toolCallId: "tc1",
    toolName: "Bash",
    input: { command: "ls" },
  });
  emit("tool.updated", { kind: "started", toolCallId: "tc1", startedAt: new Date().toISOString() });
  emit("tool.updated", {
    kind: "result",
    toolCallId: "tc1",
    result: { output: "ok" },
    duration: 5,
  });
  emit("turn.completed", {
    response: "hello world",
    tokenCount: 42,
    usage: {
      source: "provider",
      modelRequestCount: 1,
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      webSearchRequests: 0,
      webFetchRequests: 0,
    },
    toolCallCount: 1,
    duration: 10,
    resultType: mode === "cancelled" ? "cancelled" : "success",
  });
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      sessionId,
      response: "hello world",
      projection: {
        status: "ready",
        turnCount: 1,
        totalTokenCount: 42,
        contextUsed: 1_024,
        contextWindow: 128_000,
      },
    })}\n`,
  );
}

if (mode === "delayed-exit" && resumeIndex < 0 && releaseFile) {
  await new Promise((resolve) => {
    const watcher = NodeFS.watch(NodePath.dirname(releaseFile), (_event, filename) => {
      if (
        filename?.toString() !== NodePath.basename(releaseFile) ||
        !NodeFS.existsSync(releaseFile)
      ) {
        return;
      }
      watcher.close();
      resolve();
    });
  });
  emit("process_exit", {}, { error: "old process exited after the next turn started" });
}
