#!/usr/bin/env node
// pi-mock-agent.mjs — fake `pi --mode rpc` binary for pi-family adapter tests.
//
// Wire contract (pi v1): one JSON per line on stdout. Requests arrive as
// `{...command, id}` on stdin; responses are `{type:"response", id, success,
// data, error}`; every other frame is an event notification. Pi v1 sends no
// ready frame on startup.
//
// Behavior is driven by MOCK_* env vars (see PiAdapter.test.ts):
//   MOCK_RESPONSE_TEXT       assistant text (default "Mock pi response.")
//   MOCK_SESSION_FILE        sessionFile reported by get_state
//   MOCK_MODEL_BASE_URL      baseUrl in get_available_models
//   MOCK_PI_TOOLS=1          emit a bash tool_execution pair
//   MOCK_PI_ERROR=1          fail the turn (errorMessage "Mock model failure")
//   MOCK_PI_STALL=1          emit agent_start/turn_start then nothing
//   MOCK_PI_EXIT_AFTER_PROMPT=1  exit(1) right after the first prompt's
//                                agent_start/turn_start frames
//   MOCK_PI_INPUT=1          raise an extension_ui_request and wait for the
//                            extension_ui_response notification
//   MOCK_PI_MODEL_HTTP=1     answer the prompt via a real HTTP POST to
//                            MOCK_MODEL_BASE_URL + "/chat/completions" with
//                            Authorization from MOCK_MODEL_API_KEY and body
//                            {model: MOCK_MODEL_ID, messages:[...]}
//
// The adapter spawns `node pi-mock-agent.mjs --mode rpc --model ...` (via a
// shell wrapper), so argv beyond the script path is ignored.
import * as NodeReadline from "node:readline";

const env = process.env;
const emit = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};
const respond = (id, data) => {
  emit({ type: "response", id, success: true, data });
};
const respondError = (id, error) => {
  emit({ type: "response", id, success: false, error });
};

/** 当前是否有未终态的 turn（决定 abort 是否补发 agent_end）。 */
let turnActive = false;

// ── notification waiters（extension_ui_response 等无 id 通知帧）──
const notificationWaiters = [];
const waitForNotification = (predicate, timeoutMs) =>
  new Promise((resolve) => {
    const entry = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = notificationWaiters.indexOf(entry);
        if (index >= 0) notificationWaiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs),
    };
    notificationWaiters.push(entry);
  });
const dispatchNotification = (frame) => {
  // 倒序遍历：waiter 可能在遍历中被移除。
  for (let index = notificationWaiters.length - 1; index >= 0; index -= 1) {
    const entry = notificationWaiters[index];
    if (!entry.predicate(frame)) continue;
    clearTimeout(entry.timer);
    notificationWaiters.splice(index, 1);
    entry.resolve(frame);
  }
};

const emitTextDeltas = (text) => {
  for (let offset = 0; offset < text.length; offset += 8) {
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: text.slice(offset, offset + 8) },
    });
  }
};

const finishTurn = ({ text, errorMessage, stopReason }) => {
  const message = {
    role: "assistant",
    content: errorMessage === undefined ? [{ type: "text", text }] : [],
    provider: "codework-openai",
    model: "mock-byok-adapter",
    responseId: "mock-response-1",
    responseModel: "mock-byok-adapter",
    ...(errorMessage === undefined ? {} : { errorMessage }),
    stopReason,
  };
  emit({ type: "message_start", message });
  if (errorMessage === undefined) {
    emitTextDeltas(text);
  }
  emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: [message], willRetry: false });
  emit({ type: "agent_settled" });
  turnActive = false;
};

/** MOCK_PI_MODEL_HTTP=1：把 prompt 真正发往上游（BYOK 路由 e2e 的核心）。 */
const answerViaHttp = async (prompt) => {
  const baseUrl = (env.MOCK_MODEL_BASE_URL ?? "").replace(/\/+$/u, "");
  if (baseUrl.length === 0) {
    return {
      errorMessage: "Mock model HTTP mode requires MOCK_MODEL_BASE_URL.",
      stopReason: "error",
    };
  }
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.MOCK_MODEL_API_KEY === undefined
          ? {}
          : { authorization: `Bearer ${env.MOCK_MODEL_API_KEY}` }),
      },
      body: JSON.stringify({
        model: env.MOCK_MODEL_ID ?? "mock-byok-adapter",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      return {
        errorMessage: `Mock model HTTP request failed with status ${response.status}`,
        stopReason: "error",
      };
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text =
      typeof content === "string" && content.length > 0
        ? content
        : `MOCK_UPSTREAM_UNPARSEABLE:${JSON.stringify(payload)}`;
    return { text, stopReason: "stop" };
  } catch (error) {
    return {
      errorMessage: `Mock model HTTP request failed: ${String(error?.message ?? error)}`,
      stopReason: "error",
    };
  }
};

const handlePrompt = async (frame) => {
  // pi 的 prompt ack 立即返回；终态由事件驱动。
  respond(frame.id, { agentInvoked: true });
  turnActive = true;
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });

  if (env.MOCK_PI_STALL === "1") return;
  if (env.MOCK_PI_EXIT_AFTER_PROMPT === "1") {
    // 先冲刷已写帧再退出，保证适配器收到 agent_start/turn_start；空行
    // 解码器会跳过，回调即代表此前写入已送出。
    process.stdout.write("\n", () => {
      process.exit(1);
    });
    setTimeout(() => process.exit(1), 500).unref();
    return;
  }

  let text = env.MOCK_RESPONSE_TEXT ?? "Mock pi response.";
  if (env.MOCK_PI_INPUT === "1") {
    emit({
      type: "extension_ui_request",
      id: "ui-1",
      method: "input",
      title: "Mock pi input request",
      options: ["Yes", "No"],
    });
    const answer = await waitForNotification(
      (candidate) => candidate.type === "extension_ui_response" && candidate.id === "ui-1",
      10_000,
    );
    text =
      answer === undefined || answer.cancelled === true
        ? "INPUT_CANCELLED"
        : `INPUT_RECEIVED:${String(answer.value ?? "")}`;
  }
  if (env.MOCK_PI_MODEL_HTTP === "1") {
    const viaHttp = await answerViaHttp(String(frame.message ?? ""));
    if (viaHttp.errorMessage !== undefined) {
      finishTurn({ text: "", errorMessage: viaHttp.errorMessage, stopReason: "error" });
      return;
    }
    text = viaHttp.text;
  }
  if (env.MOCK_PI_TOOLS === "1") {
    emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { stdout: "hi" },
      isError: false,
    });
  }
  if (env.MOCK_PI_ERROR === "1") {
    finishTurn({ text: "", errorMessage: "Mock model failure", stopReason: "error" });
    return;
  }
  finishTurn({ text, stopReason: "stop" });
};

const handleAbort = (frame) => {
  respond(frame.id, {});
  // 中断的 agent_end/agent_settled 延迟补发：真实 CLI 处理 abort 是异步的，
  // 适配器在 abort 响应后同步发射 turn.aborted，这里晚到的终态事件应被
  // settled 检查安全丢弃（避免与 interruptTurn 的 abortTurn 赛跑）。
  if (!turnActive) return;
  turnActive = false;
  setTimeout(() => {
    const message = {
      role: "assistant",
      content: [],
      provider: "codework-openai",
      model: "mock-byok-adapter",
      stopReason: "aborted",
    };
    emit({ type: "agent_end", messages: [message], willRetry: false });
    emit({ type: "agent_settled" });
  }, 200);
};

const commandHandlers = {
  get_state: (frame) => {
    respond(frame.id, {
      sessionId: "mock-pi-session",
      sessionFile: env.MOCK_SESSION_FILE ?? `${process.cwd()}/mock-session.jsonl`,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
    });
  },
  get_available_models: (frame) => {
    respond(frame.id, {
      models: [
        {
          provider: "codework-openai",
          id: "mock-byok-adapter",
          name: "Mock BYOK Adapter",
          api: "openai-completions",
          baseUrl: env.MOCK_MODEL_BASE_URL ?? "http://127.0.0.1:1/v1",
        },
      ],
    });
  },
  set_model: (frame) => {
    respond(frame.id, { provider: frame.provider, modelId: frame.modelId });
  },
  set_thinking_level: (frame) => {
    respond(frame.id, {});
  },
  get_commands: (frame) => {
    respond(frame.id, []);
  },
  get_messages: (frame) => {
    respond(frame.id, []);
  },
  get_session_stats: (frame) => {
    respond(frame.id, {});
  },
  clear_queue: (frame) => {
    respond(frame.id, {});
  },
};

const handleFrame = async (frame) => {
  if (frame === null || typeof frame !== "object") return;
  if (frame.type === "extension_ui_response" || frame.type === "host_tool_result") {
    dispatchNotification(frame);
    return;
  }
  if (typeof frame.id !== "string") return;
  if (frame.type === "prompt") {
    await handlePrompt(frame);
    return;
  }
  if (frame.type === "abort") {
    handleAbort(frame);
    return;
  }
  const handler = commandHandlers[frame.type];
  if (handler !== undefined) {
    handler(frame);
    return;
  }
  respondError(frame.id, `Unknown command: ${String(frame.type)}`);
};

const readline = NodeReadline.createInterface({ input: process.stdin, terminal: false });
readline.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handleFrame(frame);
});
readline.on("close", () => {
  process.exit(1);
});
