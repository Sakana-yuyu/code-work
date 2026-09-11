#!/usr/bin/env node
// omp-mock-agent.mjs — fake `omp --mode rpc-ui` binary for pi-family adapter
// tests.
//
// Wire contract (OMP 17.x): one JSON per line on stdout. On startup OMP sends
// the protocol ready frame; requests arrive as `{...command, id}` on stdin,
// responses are `{type:"response", id, success, data, error}`, everything else
// is an event. Inbound host_tool_result / extension_ui_response frames are
// plain notifications (no rpc id correlation beyond their own `id` field).
//
// Behavior is driven by MOCK_* env vars (see OmpAdapter.test.ts):
//   MOCK_RESPONSE_TEXT       assistant text (default "Mock omp response.")
//   MOCK_OMP_HOST_TOOL=1     issue a workspace.read_file host_tool_call and
//                            wait for the matching host_tool_result
//   MOCK_HOST_TOOL_PATH      arguments.path for that host tool call
//   MOCK_OMP_APPROVAL=1      raise an "Allow tool: bash" Approve/Deny
//                            extension_ui_request and wait for the response
//   MOCK_OMP_SUBAGENT=1      emit subagent lifecycle + progress frames
//   MOCK_OMP_STALL=1         emit agent_start/turn_start then nothing
//   MOCK_OMP_LOG             path of a file that records argv + every stdin
//                            frame (one JSON per line) for assertions
import * as NodeFS from "node:fs";
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

const logFrame = (entry) => {
  if (env.MOCK_OMP_LOG === undefined) return;
  NodeFS.appendFileSync(env.MOCK_OMP_LOG, `${JSON.stringify(entry)}\n`, "utf8");
};

/** set_host_tools 注册的宿主工具名。 */
let hostToolNames = [];
let turnActive = false;

// ── notification waiters（host_tool_result / extension_ui_response）──
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

const finishTurn = (text) => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "codework-openai",
    model: "mock-byok-adapter",
    responseId: "mock-omp-response-1",
    stopReason: "stop",
  };
  emit({ type: "message_start", message });
  emitTextDeltas(text);
  emit({ type: "message_end", message });
  // OMP 协议没有 agent_settled；agent_end 即终态。
  emit({ type: "agent_end", messages: [message] });
  turnActive = false;
};

const runHostToolScenario = async () => {
  if (env.MOCK_OMP_HOST_TOOL !== "1") return "";
  if (hostToolNames.length === 0) return "";
  emit({
    type: "host_tool_call",
    id: "hc-1",
    toolCallId: "ht-1",
    toolName: "workspace.read_file",
    arguments: { path: env.MOCK_HOST_TOOL_PATH ?? "/workspace/hello.txt" },
  });
  const result = await waitForNotification(
    (candidate) => candidate.type === "host_tool_result" && candidate.id === "hc-1",
    10_000,
  );
  const text =
    result === undefined
      ? "HOST_TOOL_TIMEOUT"
      : String(result?.result?.content?.[0]?.text ?? "HOST_TOOL_NO_TEXT");
  emit({
    type: "tool_execution_start",
    toolCallId: "tool-read-1",
    toolName: "read",
    args: { path: env.MOCK_HOST_TOOL_PATH ?? "/workspace/hello.txt" },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "tool-read-1",
    toolName: "read",
    result: { text },
    isError: result?.isError === true,
  });
  return `HOST_TOOL_DONE:${text}`;
};

const runApprovalScenario = async () => {
  if (env.MOCK_OMP_APPROVAL !== "1") return "";
  emit({
    type: "extension_ui_request",
    id: "perm-1",
    method: "select",
    title: "Allow tool: bash",
    options: ["Approve", "Deny"],
  });
  const answer = await waitForNotification(
    (candidate) => candidate.type === "extension_ui_response" && candidate.id === "perm-1",
    10_000,
  );
  if (answer !== undefined && answer.value === "Approve") {
    emit({
      type: "tool_execution_start",
      toolCallId: "tool-approval-1",
      toolName: "bash",
      args: { command: "echo approved" },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "tool-approval-1",
      toolName: "bash",
      result: { stdout: "approved" },
      isError: false,
    });
    return "APPROVED";
  }
  return "DENIED";
};

const runSubagentScenario = () => {
  if (env.MOCK_OMP_SUBAGENT !== "1") return;
  emit({
    type: "subagent_lifecycle",
    payload: {
      id: "sub-1",
      agent: "mock-subagent",
      description: "Mock subagent task",
      status: "started",
      index: 0,
    },
  });
  emit({
    type: "subagent_progress",
    payload: {
      index: 0,
      agent: "mock-subagent",
      task: "Mock subagent task",
      progress: { id: "sub-1", status: "running", description: "Working on the mock task" },
    },
  });
  emit({
    type: "subagent_lifecycle",
    payload: {
      id: "sub-1",
      agent: "mock-subagent",
      description: "Mock subagent task",
      status: "completed",
      index: 0,
    },
  });
};

const handlePrompt = async (frame) => {
  respond(frame.id, { agentInvoked: true });
  turnActive = true;
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });

  if (env.MOCK_OMP_STALL === "1") return;

  const segments = [];
  segments.push(await runHostToolScenario());
  segments.push(await runApprovalScenario());
  runSubagentScenario();
  const text = [
    ...segments.filter((segment) => segment.length > 0),
    env.MOCK_RESPONSE_TEXT ?? "Mock omp response.",
  ].join(" ");
  finishTurn(text);
};

const handleAbort = (frame) => {
  respond(frame.id, {});
  // 与 pi-mock-agent 相同：延迟补发中断终态，避免与 interruptTurn 的
  // abortTurn 赛跑（适配器在 abort 响应后同步发射 turn.aborted）。
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
    emit({ type: "agent_end", messages: [message] });
  }, 200);
};

const commandHandlers = {
  negotiate_protocol: (frame) => {
    respond(frame.id, { protocolVersion: 2 });
  },
  get_state: (frame) => {
    respond(frame.id, {
      sessionId: "mock-omp-session",
      sessionFile: env.MOCK_SESSION_FILE ?? `${process.cwd()}/mock-omp-session.jsonl`,
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
  set_host_tools: (frame) => {
    hostToolNames = Array.isArray(frame.tools)
      ? frame.tools.map((tool) => String(tool?.name ?? "")).filter((name) => name.length > 0)
      : [];
    respond(frame.id, { toolNames: [...hostToolNames] });
  },
  set_subagent_subscription: (frame) => {
    respond(frame.id, {});
  },
  get_messages: (frame) => {
    respond(frame.id, []);
  },
  get_session_stats: (frame) => {
    respond(frame.id, {});
  },
  get_commands: (frame) => {
    respond(frame.id, []);
  },
  get_available_commands: (frame) => {
    respond(frame.id, []);
  },
};

const handleFrame = async (frame) => {
  if (frame === null || typeof frame !== "object") return;
  logFrame({ kind: "frame", value: frame });
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

// argv 记录：适配器把 --mode rpc-ui/--approval-mode/--model 追加在
// binaryPath 之后，测试通过日志断言实际的 spawn 参数。
logFrame({ kind: "argv", value: process.argv.slice(2) });
// OMP 17.x 启动即宣告 v2 chunked 能力。
emit({
  type: "ready",
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});

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
