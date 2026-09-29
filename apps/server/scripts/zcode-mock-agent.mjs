#!/usr/bin/env node
// ZCode `--prompt … --output-format stream-json` 的最小替身：逐行输出会话事件信封，
// 最后一行 type:"result"。MOCK_ZCODE_MODE 控制场景；MOCK_ZCODE_ARGV_FILE 记录每轮 argv。
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.MOCK_ZCODE_ARGV_FILE) {
  appendFileSync(process.env.MOCK_ZCODE_ARGV_FILE, `${JSON.stringify(argv)}\n`);
}
const resumeIndex = argv.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? argv[resumeIndex + 1] : "zc-session-1";
const mode = process.env.MOCK_ZCODE_MODE ?? "happy";
let seq = 0;
const emit = (type, payload, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ type, eventId: `e${++seq}`, sessionId, seq, timestamp: Date.now(), traceId: "t", turnId: "turn-1", payload, ...extra })}\n`,
  );

if (mode === "crash") {
  process.stderr.write("zcode: provider not ready\n");
  process.exit(3);
}

emit("turn.started", { turnNumber: 1, input: "x" });

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
    toolCallCount: 1,
    duration: 10,
    resultType: mode === "cancelled" ? "cancelled" : "success",
  });
  process.stdout.write(
    `${JSON.stringify({ type: "result", sessionId, response: "hello world" })}\n`,
  );
}
