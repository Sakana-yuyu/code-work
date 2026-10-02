#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimersInEffect:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.CODEWORK_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.CODEWORK_ACP_EXIT_LOG_PATH;
const closeBehavior = process.env.CODEWORK_ACP_CLOSE_BEHAVIOR;
const childPidLogPath = process.env.CODEWORK_ACP_CHILD_PID_LOG_PATH;
const emitToolCalls = process.env.CODEWORK_ACP_EMIT_TOOL_CALLS === "1";
const emitThoughts = process.env.CODEWORK_ACP_EMIT_THOUGHTS === "1";
const emitResources = process.env.CODEWORK_ACP_EMIT_RESOURCES === "1";
const emitUsage = process.env.CODEWORK_ACP_EMIT_USAGE === "1";
const emitConfigUpdates = process.env.CODEWORK_ACP_EMIT_CONFIG_UPDATES === "1";
const startupConfig = process.env.CODEWORK_ACP_STARTUP_CONFIG;
const emitCommands = process.env.CODEWORK_ACP_EMIT_COMMANDS === "1";
const emitGajaeIdle = process.env.CODEWORK_ACP_EMIT_GAJAE_IDLE === "1";
const emitKiroCommands = process.env.CODEWORK_ACP_EMIT_KIRO_COMMANDS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.CODEWORK_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.CODEWORK_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitAskQuestion = process.env.CODEWORK_ACP_EMIT_ASK_QUESTION === "1";
const emitXAiAskUserQuestion = process.env.CODEWORK_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
const emitXAiExitPlanMode = process.env.CODEWORK_ACP_EMIT_XAI_EXIT_PLAN_MODE === "1";
const emitXAiPlanMdWrite = process.env.CODEWORK_ACP_EMIT_XAI_PLAN_MD_WRITE === "1";
const emitXAiPromptCompleteThenHang =
  process.env.CODEWORK_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
const emitXAiRateLimitThenHang = process.env.CODEWORK_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1";
const emitXAiAskUserQuestionThenHang =
  process.env.CODEWORK_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG === "1";
const emitContentThenHang = process.env.CODEWORK_ACP_EMIT_CONTENT_THEN_HANG === "1";
const emitPlanThenHang = process.env.CODEWORK_ACP_EMIT_PLAN_THEN_HANG === "1";
const emitActiveToolThenHang = process.env.CODEWORK_ACP_EMIT_ACTIVE_TOOL_THEN_HANG === "1";
const emitForeignSessionUpdates = process.env.CODEWORK_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
const hangPromptForever = process.env.CODEWORK_ACP_HANG_PROMPT_FOREVER === "1";
const hangFirstPromptForever = process.env.CODEWORK_ACP_HANG_FIRST_PROMPT_FOREVER === "1";
const replyCancelledPrompt = process.env.CODEWORK_ACP_REPLY_CANCELLED_PROMPT === "1";
const cancelResponseBarrier = process.env.CODEWORK_ACP_CANCEL_RESPONSE_BARRIER === "1";
const codebuddyCancelWindow = process.env.CODEWORK_ACP_CODEBUDDY_CANCEL_WINDOW === "1";
const requestHostCapabilities = process.env.CODEWORK_ACP_REQUEST_HOST_CAPABILITIES === "1";
const hostCapabilitiesResultLogPath =
  process.env.CODEWORK_ACP_HOST_CAPABILITIES_RESULT_LOG_PATH?.trim() || undefined;
const encodeHostCapabilities = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const emitLateUpdateAfterCancel = process.env.CODEWORK_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
const omitXAiPromptCompleteStopReason =
  process.env.CODEWORK_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === "1";
const failLoadSession = process.env.CODEWORK_ACP_FAIL_LOAD_SESSION === "1";
const emitLoadReplay = process.env.CODEWORK_ACP_EMIT_LOAD_REPLAY === "1";
const hangLoadSessionAfterReplay = process.env.CODEWORK_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === "1";
const delayLoadSessionAfterReplay =
  process.env.CODEWORK_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === "1";
const loadSessionDelayMs = Number(process.env.CODEWORK_ACP_LOAD_SESSION_DELAY_MS ?? "5000");
const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.CODEWORK_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === "1";
const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.CODEWORK_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === "1";
const failPrompt = process.env.CODEWORK_ACP_FAIL_PROMPT === "1";
const failSetConfigOption = process.env.CODEWORK_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.CODEWORK_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const exitAfterPermissionRequest = process.env.CODEWORK_ACP_EXIT_AFTER_PERMISSION_REQUEST === "1";
const crashSignalPath = process.env.CODEWORK_ACP_CRASH_SIGNAL_PATH?.trim() || undefined;
const promptResponseText = process.env.CODEWORK_ACP_PROMPT_RESPONSE_TEXT;
const initialGrokReasoningEffort =
  process.env.CODEWORK_ACP_INITIAL_GROK_REASONING_EFFORT?.trim() || undefined;
const readTextFilePath = process.env.CODEWORK_ACP_READ_TEXT_FILE_PATH;
const clientToolSessionId = process.env.CODEWORK_ACP_CLIENT_TOOL_SESSION_ID;
const writeTextFilePath = process.env.CODEWORK_ACP_WRITE_TEXT_FILE_PATH;
const writeTextFileContent = process.env.CODEWORK_ACP_WRITE_TEXT_FILE_CONTENT ?? "mock write";
const clientToolResultLogPath = process.env.CODEWORK_ACP_CLIENT_TOOL_RESULT_LOG_PATH;
const terminalCommand = process.env.CODEWORK_ACP_TERMINAL_COMMAND;
const terminalArgs = (() => {
  const indexed = Array.from(
    { length: 10 },
    (_, index) => process.env[`CODEWORK_ACP_TERMINAL_ARG_${index}`],
  ).filter((value): value is string => value !== undefined);
  if (indexed.length > 0) return indexed;
  const raw = process.env.CODEWORK_ACP_TERMINAL_ARGS_JSON;
  if (!raw) return [] as string[];
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
})();
const terminalCwd = process.env.CODEWORK_ACP_TERMINAL_CWD;
const terminalKillBeforeWait = process.env.CODEWORK_ACP_TERMINAL_KILL_BEFORE_WAIT === "1";
const terminalHangAfterCreate = process.env.CODEWORK_ACP_TERMINAL_HANG_AFTER_CREATE === "1";
const promptDelayMs = Number(process.env.CODEWORK_ACP_PROMPT_DELAY_MS ?? "0");
const permissionOptionIds = {
  allowOnce: process.env.CODEWORK_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.CODEWORK_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.CODEWORK_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};
const omitAllowAlways = process.env.CODEWORK_ACP_OMIT_ALLOW_ALWAYS === "1";
const permissionRequestCount = Math.max(
  1,
  Number(process.env.CODEWORK_ACP_PERMISSION_REQUEST_COUNT ?? "1") || 1,
);
const sessionId = "mock-session-1";
const uriModes = process.env.CODEWORK_ACP_URI_MODES === "1";
const reviewMode = "https://agentclientprotocol.com/protocol/session-modes#review";

let currentModeId = "ask";
let currentModelId = "default";
let dynamicConfigActive = false;
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
let promptCount = 0;
let overlappingFirstPromptId: string | undefined;
const cancelledSessions = new Set<string>();

function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

if (childPidLogPath) {
  NodeFS.writeFileSync(childPidLogPath, String(process.pid), "utf8");
}

function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function logClientToolResult(value: unknown): void {
  if (!clientToolResultLogPath) return;
  NodeFS.appendFileSync(clientToolResultLogPath, `${JSON.stringify(value)}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

let selectedPersona = "";
let allowAll = "off";

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (process.env.CODEWORK_ACP_LEGACY_MODELS === "1") return [];
  if (process.env.CODEWORK_ACP_COPILOT_CONFIG === "1") {
    return [
      {
        id: "agent",
        name: "Agent",
        category: "_agent",
        type: "select",
        currentValue: selectedPersona,
        options: [
          { value: "", name: "Copilot" },
          { value: "reviewer", name: "审查角色" },
        ],
      },
      {
        id: "allow_all",
        name: "Allow All",
        category: "permissions",
        type: "select",
        currentValue: allowAll,
        options: [
          { value: "on", name: "On" },
          { value: "off", name: "Off" },
        ],
      },
    ];
  }
  if (dynamicConfigActive) {
    return [
      {
        id: "engine",
        name: "模型",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          {
            group: "dynamic",
            name: "动态模型",
            options: [
              { value: "dynamic-default", name: "默认模型" },
              { value: "dynamic-next", name: "新增模型" },
            ],
          },
        ],
      },
      {
        id: "operation",
        name: "模式",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: [
          { value: "plan", name: "计划" },
          { value: "code", name: "实施" },
          ...(uriModes ? [{ value: reviewMode, name: "审查" }] : []),
        ],
      },
      { id: "fast", name: "快速", type: "boolean", currentValue: currentFast },
    ];
  }
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = currentModelId;
  try {
    currentModelId = modelId;
    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    currentModelId = previousModelId;
  }
}

function availableModels(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>;
}> {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }));
}

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  ...(uriModes ? [{ id: reviewMode, name: "审查", description: "检查当前变更" }] : []),
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

const grokAcpModels: ReadonlyArray<AcpSchema.ModelInfo> = [
  {
    modelId: "grok-build",
    name: "Grok Build",
    ...(initialGrokReasoningEffort
      ? { _meta: { reasoningEffort: initialGrokReasoningEffort } }
      : {}),
  },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

function modelState(): AcpSchema.SessionModelState {
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : "grok-build";
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const cancelResponseReleased = yield* Deferred.make<void>();
  yield* agent.handleExtRequest("_codework/release_cancel", Schema.Struct({}), () =>
    Deferred.succeed(cancelResponseReleased, undefined).pipe(Effect.as({})),
  );

  yield* agent.handleInitialize((request) =>
    Effect.sync(() => {
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 1,
        ...(process.env.CODEWORK_ACP_AGENT_NAME
          ? { agentInfo: { name: process.env.CODEWORK_ACP_AGENT_NAME, version: "0.0.0" } }
          : {}),
        agentCapabilities: {
          loadSession: true,
          ...(closeBehavior ? { sessionCapabilities: { close: {} } } : {}),
        },
      };
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));
  yield* agent.handleCloseSession(() =>
    closeBehavior === "hang"
      ? Effect.never
      : closeBehavior === "fail"
        ? AcpError.AcpRequestError.internalError("测试会话关闭失败")
        : Effect.succeed({}),
  );

  let startupAttempts = 0;
  const startupMetadata = (requestedSessionId: string) =>
    Effect.gen(function* () {
      const original = {
        ...(process.env.CODEWORK_ACP_COPILOT_CONFIG === "1" ? {} : { modes: modeState() }),
        ...(process.env.CODEWORK_ACP_COPILOT_CONFIG === "1" ? {} : { models: modelState() }),
        configOptions: configOptions(),
      };
      if (!startupConfig) return original;
      startupAttempts++;
      if (startupConfig === "retry" && startupAttempts > 1) return {};
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: original.configOptions,
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "startup", description: "" }],
        },
      });
      dynamicConfigActive = true;
      currentModelId = "dynamic-default";
      currentModeId = "plan";
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: startupConfig === "withdraw" ? [] : configOptions(),
        },
      });
      for (const metadata of [
        { sessionId: "foreign-session" },
        { sessionId: requestedSessionId, _meta: { isReplay: true } },
      ])
        yield* agent.client.sessionUpdate({
          ...metadata,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: original.configOptions,
          },
        });
      if (startupConfig === "retry")
        return yield* AcpError.AcpRequestError.internalError("首次启动失败");
      if (startupConfig === "idle") return yield* Effect.never;
      if (startupConfig === "empty") return { configOptions: [] };
      if (startupConfig === "explicit") return original;
      if (startupConfig === "null") return { configOptions: null };
      return {};
    });

  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      if (emitKiroCommands) {
        writeJsonRpcNotification("_kiro.dev/commands/available", {
          sessionId,
          commands: [{ name: "/agent", description: "选择代理", meta: { hint: "swap <name>" } }],
          prompts: [{ name: "review", description: "审查变更", serverName: "skill:local" }],
          tools: [{ name: "terminal" }],
        });
        writeJsonRpcNotification("_kiro.dev/commands/available", {
          sessionId: "child-session",
          commands: [{ name: "/foreign" }],
        });
      }
      if (emitCommands) {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "review", description: "审查变更", input: { hint: "文件路径" } },
            ],
          },
        });
      }
      return {
        sessionId,
        ...(yield* startupMetadata(sessionId)),
      };
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (failLoadSession) {
        return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
      }
      if (startupConfig) return yield* startupMetadata(requestedSessionId);
      if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay) {
        emitLoadReplayNotifications(requestedSessionId);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "replay-tail" },
          },
        });
        yield* Effect.sleep(loadSessionDelayMs);
        return {
          ...(process.env.CODEWORK_ACP_COPILOT_CONFIG === "1" ? {} : { modes: modeState() }),
          ...(process.env.CODEWORK_ACP_COPILOT_CONFIG === "1" ? {} : { models: modelState() }),
          configOptions: configOptions(),
        };
      }
      if (emitLoadReplay) {
        emitLoadReplayNotifications(requestedSessionId);
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replay" },
        },
      });
      return {
        ...(process.env.CODEWORK_ACP_COPILOT_CONFIG === "1" ? {} : { modes: modeState() }),
        ...(process.env.CODEWORK_ACP_COPILOT_CONFIG === "1" ? {} : { models: modelState() }),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleSetSessionModel((request) =>
    Effect.gen(function* () {
      if (!grokAcpModels.some((model) => model.modelId === request.modelId)) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock model id: ${request.modelId}`,
          {
            method: "session/set_model",
            params: request,
          },
        );
      }
      currentModelId = request.modelId;
      if (process.env.CODEWORK_ACP_EMIT_IDLE_USAGE === "1") {
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: "usage_update", used: 0, size: 64_000 },
        });
      }
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (
        (request.configId === "mode" ||
          (dynamicConfigActive && request.configId === "operation")) &&
        typeof request.value === "string"
      ) {
        currentModeId = request.value;
      }
      if (
        (request.configId === "model" || (dynamicConfigActive && request.configId === "engine")) &&
        typeof request.value === "string"
      ) {
        currentModelId = request.value;
      }
      if (request.configId === "agent" && typeof request.value === "string")
        selectedPersona = request.value;
      if (request.configId === "allow_all" && typeof request.value === "string")
        allowAll = request.value;
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      const cancelledSessionId = String(sessionId ?? "mock-session-1");
      cancelledSessions.add(cancelledSessionId);
      if (replyCancelledPrompt) yield* Deferred.succeed(cancelResponseReleased, undefined);
      if (cancelResponseBarrier) {
        yield* agent.client.sessionUpdate({
          sessionId: cancelledSessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: "cancel-awaiting-release",
          },
        });
      }
      if (emitLateUpdateAfterCancel) {
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => {
          writeJsonRpcNotification("session/update", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late after cancel" },
            },
          });
        });
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      promptCount += 1;
      if (cancelResponseBarrier && promptCount === 1) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: "first-prompt-running",
          },
        });
        yield* Deferred.await(cancelResponseReleased);
        cancelledSessions.delete(requestedSessionId);
        return {
          stopReason: "cancelled" as const,
          ...(codebuddyCancelWindow ? { _meta: { "codebuddy.ai/outcome": "CANCELLED" } } : {}),
        };
      }

      if (requestHostCapabilities) {
        const capabilities = yield* agent.client.extRequest("host/capabilities", {
          sessionId: requestedSessionId,
        });
        if (hostCapabilitiesResultLogPath) {
          const encoded = yield* encodeHostCapabilities(capabilities).pipe(
            Effect.mapError(
              (cause) =>
                new AcpError.AcpTransportError({
                  detail: "测试宿主能力回复不能编码为 JSON",
                  cause,
                }),
            ),
          );
          NodeFS.appendFileSync(hostCapabilitiesResultLogPath, `${encoded}\n`, "utf8");
        }
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (emitGajaeIdle) {
        const first = request.prompt[0];
        const text = first?.type === "text" ? first.text : "";
        if (text === "failure")
          return yield* AcpError.AcpRequestError.internalError("模拟 Gajae 回合失败");
        if (text === "early")
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } },
          });
        return { stopReason: "end_turn" };
      }
      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 1) {
        return {
          stopReason: "end_turn",
          _meta: {
            promptId: "mock-stale-xai-prompt-1",
            requestId: "mock-stale-xai-prompt-1",
          },
        };
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 2) {
        const currentPromptId = promptIdFromRequestMeta(request) ?? "mock-current-xai-prompt-2";
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: "mock-stale-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: currentPromptId,
          stopReason: "end_turn",
          agentResult: null,
        });

        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 1) {
        overlappingFirstPromptId = promptIdFromRequestMeta(request);
        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 2) {
        const secondPromptId = promptIdFromRequestMeta(request);
        if (overlappingFirstPromptId !== undefined && secondPromptId !== undefined) {
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: secondPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: overlappingFirstPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
        }
        return yield* Effect.never;
      }

      if (hangPromptForever || (hangFirstPromptForever && promptCount === 1)) {
        if (replyCancelledPrompt) {
          yield* Deferred.await(cancelResponseReleased);
          cancelledSessions.delete(requestedSessionId);
          return { stopReason: "cancelled" as const };
        }
        if (emitLateUpdateAfterCancel) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late-cancel-prompt-running" },
            },
          });
        }
        return yield* Effect.never;
      }

      if (emitXAiRateLimitThenHang) {
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-rate-limit-prompt-1",
          stopReason: "rate_limit",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitContentThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial before stall" },
          },
        });
        return yield* Effect.never;
      }

      if (emitKiroCommands) {
        writeJsonRpcNotification("_kiro.dev/commands/available", {
          sessionId: requestedSessionId,
          commands: promptCount === 1 ? [{ name: "/inspect", description: "检查文件" }] : [],
          prompts: [],
        });
        return { stopReason: "end_turn" };
      }
      if (emitCommands) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands:
              promptCount === 1 ? [{ name: "inspect", description: "检查文件" }] : [],
          },
        });
        for (const notification of [
          { sessionId: "mock-child-session-1" },
          { sessionId: requestedSessionId, _meta: { isReplay: true } },
        ])
          yield* agent.client.sessionUpdate({
            ...notification,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "foreign", description: "其它会话" }],
            },
          });
        return { stopReason: "end_turn" };
      }

      if (emitConfigUpdates) {
        dynamicConfigActive = true;
        currentModelId = "dynamic-default";
        currentModeId = "plan";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: promptCount === 1 ? configOptions() : [],
          },
        });
        for (const notification of [
          { sessionId: "mock-child-session-1" },
          { sessionId: requestedSessionId, _meta: { isReplay: true } },
        ]) {
          yield* agent.client.sessionUpdate({
            ...notification,
            update: { sessionUpdate: "config_option_update", configOptions: [] },
          });
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "配置已更新" },
          },
        });
        return { stopReason: "end_turn" };
      }

      if (emitUsage) {
        for (const used of [320, 0]) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "usage_update", used, size: 64_000 },
          });
        }
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: { sessionUpdate: "usage_update", used: 999, size: 64_000 },
        });
        yield* agent.client.sessionUpdate({
          _meta: { isReplay: true },
          sessionId: requestedSessionId,
          update: { sessionUpdate: "usage_update", used: 888, size: 64_000 },
        });
        return { stopReason: "end_turn" };
      }

      if (process.env.CODEWORK_ACP_EMIT_BINARY === "1") {
        // 使用可解码的两秒 PCM WAV，浏览器验收检查原生播放位置。
        const wav = Buffer.alloc(44 + 32_000);
        wav.write("RIFF", 0);
        wav.writeUInt32LE(wav.length - 8, 4);
        wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8_000, 24);
        wav.writeUInt32LE(16_000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36);
        wav.writeUInt32LE(32_000, 40);
        const audio = {
          type: "audio" as const,
          mimeType: "audio/wav",
          data: wav.toString("base64"),
        };
        const blob = {
          type: "resource" as const,
          resource: {
            uri: "file:///workspace/report.bin",
            mimeType: "application/octet-stream",
            blob: Buffer.from("媒体附件下载校验\n").toString("base64"),
          },
        };
        for (const notification of [
          { sessionId: "mock-child-session-1" },
          { sessionId: requestedSessionId, _meta: { isReplay: true } },
        ])
          yield* agent.client.sessionUpdate({
            ...notification,
            update: { sessionUpdate: "agent_message_chunk", content: audio },
          });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: audio },
        });
        for (const content of [
          { type: "text" as const, text: "媒体前文" },
          audio,
          blob,
          { type: "audio" as const, mimeType: "audio/wav", data: "invalid" },
          {
            type: "resource" as const,
            resource: {
              uri: "file:///workspace/x.svg",
              mimeType: "image/svg+xml",
              blob: Buffer.from("<svg></svg>").toString("base64"),
            },
          },
          ...(process.env.CODEWORK_ACP_BINARY_DECODE_ERROR === "1"
            ? [
                {
                  type: "audio" as const,
                  mimeType: "audio/wav",
                  data: Buffer.from("invalid-WAV-header").toString("base64"),
                },
              ]
            : []),
          { type: "text" as const, text: "媒体后文" },
        ])
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content },
          });
        return { stopReason: "end_turn" };
      }

      if (process.env.CODEWORK_ACP_EMIT_IMAGES === "1") {
        const image = {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAIAAACyfKYoAAAAnElEQVR4nO3QMQ0AIAwAsAlBAidyEIKsSZgsTlSQPU2qoDF2tZh5WtxcLUK0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNG/PK9glOBKTMjXAAAAAElFTkSuQmCC",
        } as const;
        for (const notification of [
          { sessionId: "mock-child-session-1" },
          { sessionId: requestedSessionId, _meta: { isReplay: true } },
        ])
          yield* agent.client.sessionUpdate({
            ...notification,
            update: { sessionUpdate: "agent_message_chunk", content: image },
          });
        for (const content of [
          { type: "text", text: "图片前文" },
          image,
          { type: "image", mimeType: "image/png", data: "invalid" },
          { type: "text", text: "图片后文" },
          ...(process.env.CODEWORK_ACP_IMAGE_DECODE_ERROR === "1"
            ? [{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" }]
            : []),
          image,
        ] as const)
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content },
          });
        return { stopReason: "end_turn" };
      }

      if (emitResources) {
        for (const notification of [
          { sessionId: "mock-child-session-1" },
          { sessionId: requestedSessionId, _meta: { isReplay: true } },
        ]) {
          yield* agent.client.sessionUpdate({
            ...notification,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "resource_link",
                uri: "https://example.com/ignored",
                name: "不应出现",
              },
            },
          });
        }
        for (const content of [
          { type: "text", text: "资源开始\n```text\n未闭合代码围栏" },
          {
            type: "resource_link",
            name: "资源报告",
            uri: "https://example.com/report?q=1#section",
            description: "报告说明",
          },
          {
            type: "resource",
            resource: {
              uri: "mcp://example/report",
              mimeType: "text/plain",
              text: "报告正文\n```\n![不是图片](https://example.com/test.png)\n```",
            },
          },
          { type: "text", text: "资源结束" },
        ] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content },
          });
        }
        return { stopReason: "end_turn" };
      }

      if (emitThoughts) {
        for (const update of [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before thought" },
          },
          { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "测试思考" } },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after thought" },
          },
        ] as const) {
          yield* agent.client.sessionUpdate({ sessionId: requestedSessionId, update });
        }
        return { stopReason: "end_turn" };
      }

      if (emitPlanThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Wait for more ACP progress",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        });
        return yield* Effect.never;
      }

      if (emitActiveToolThenHang) {
        const toolCallId = "tool-call-long-running-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Long-running tool",
            kind: "execute",
            status: "pending",
            rawInput: { command: ["long-running-tool"] },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });
        return yield* Effect.never;
      }

      if (emitXAiPromptCompleteThenHang) {
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from " },
          },
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child before completion" },
            },
          });
        }

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: "end_turn" }),
          agentResult: null,
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "child-tool-call-1",
              title: "Child-only tool",
              kind: "other",
              status: "pending",
              rawInput: {},
            },
          });
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child after completion" },
            },
          });
        }

        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "mock" },
          },
        });

        return yield* Effect.never;
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (readTextFilePath) {
        const readResult = yield* agent.client.readTextFile({
          sessionId: clientToolSessionId ?? requestedSessionId,
          path: readTextFilePath,
          line: 2,
          limit: 2,
        });
        logClientToolResult({ method: "fs/read_text_file", result: readResult });
        if (writeTextFilePath) {
          const writeResult = yield* agent.client.writeTextFile({
            sessionId: clientToolSessionId ?? requestedSessionId,
            path: writeTextFilePath,
            content: writeTextFileContent,
          });
          logClientToolResult({ method: "fs/write_text_file", result: writeResult });
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: readResult.content },
          },
        });
        return { stopReason: "end_turn" };
      }

      if (terminalCommand) {
        const terminal = yield* agent.client.createTerminal({
          sessionId: requestedSessionId,
          command: terminalCommand,
          args: terminalArgs,
          ...(terminalCwd ? { cwd: terminalCwd } : {}),
        });
        logClientToolResult({
          method: "terminal/create",
          result: { terminalId: terminal.terminalId },
        });
        if (terminalHangAfterCreate) return yield* Effect.never;
        if (terminalKillBeforeWait) {
          const killed = yield* terminal.kill;
          logClientToolResult({ method: "terminal/kill", result: killed });
        }
        const output = yield* terminal.output;
        logClientToolResult({ method: "terminal/output", result: output });
        const exit = yield* terminal.waitForExit;
        logClientToolResult({ method: "terminal/wait_for_exit", result: exit });
        const released = yield* terminal.release;
        logClientToolResult({ method: "terminal/release", result: released });
        return { stopReason: "end_turn" };
      }

      if (process.env.CODEWORK_ACP_PERMISSION_LIFECYCLE === "1") {
        if (request.prompt.some((block) => block.type === "text" && block.text === "second")) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "reused",
              status: "completed",
            },
          });
          return { stopReason: "end_turn" };
        }
        for (const id of [
          "approval-only",
          "real-before",
          "real-after",
          "real-output",
          "mismatch",
          "foreign",
          "reused",
        ]) {
          const start = {
            sessionUpdate: "tool_call" as const,
            toolCallId: id,
            title: `执行 ${id}`,
            kind: "edit" as const,
            status: "in_progress" as const,
          };
          if (id === "real-before")
            yield* agent.client.sessionUpdate({ sessionId: requestedSessionId, update: start });
          const permission = yield* agent.client.requestPermission({
            sessionId: id === "foreign" ? "other-session" : requestedSessionId,
            toolCall: { toolCallId: id, title: `审批 ${id}`, kind: "edit", status: "pending" },
            options: [
              { optionId: "allow-native", name: "允许", kind: "allow_once" },
              { optionId: "deny-native", name: "拒绝", kind: "reject_once" },
            ],
          });
          if (id === "reused") continue;
          if (id === "real-after")
            yield* agent.client.sessionUpdate({ sessionId: requestedSessionId, update: start });
          const allowed =
            permission.outcome.outcome === "selected" &&
            permission.outcome.optionId === "allow-native";
          const status = (id === "mismatch" ? !allowed : allowed)
            ? ("completed" as const)
            : ("failed" as const);
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: id,
              status,
              ...(id === "real-output"
                ? {
                    content: [
                      {
                        type: "content" as const,
                        content: { type: "text" as const, text: "实际执行结果" },
                      },
                    ],
                  }
                : {}),
            },
          });
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "unknown", status: "completed" },
        });
        return { stopReason: "end_turn" };
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permissionOptions: Array<AcpSchema.PermissionOption> = [
          { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
          ...(omitAllowAlways
            ? []
            : [
                {
                  optionId: permissionOptionIds.allowAlways,
                  name: "Allow always",
                  kind: "allow_always" as const,
                },
              ]),
          { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
        ];

        let cancelled = cancelledSessions.delete(requestedSessionId);
        for (let index = 0; index < permissionRequestCount; index++) {
          const command =
            index > 0
              ? (process.env.CODEWORK_ACP_SECOND_PERMISSION_COMMAND ?? "cat server/package.json")
              : "cat server/package.json";
          if (exitAfterPermissionRequest && index === 0) {
            // Crash after the host has opened the approval, while the agent is
            // still waiting on the permission response (mid-turn disconnect).
            if (crashSignalPath) {
              const poll = setInterval(() => {
                try {
                  if (NodeFS.existsSync(crashSignalPath)) {
                    clearInterval(poll);
                    process.exit(7);
                  }
                } catch {
                  // Keep polling until the host writes the signal.
                }
              }, 25);
            } else {
              // Path-free fixture: give the host time to emit request.opened
              // before the agent process exits mid-permission.
              setTimeout(() => {
                process.exit(7);
              }, 5_000);
            }
          }
          const permission = yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId: index === 0 ? toolCallId : `${toolCallId}-${index + 1}`,
              title: process.env.CODEWORK_ACP_PERMISSION_TITLE ?? `\`${command}\``,
              kind: "execute",
              status: "pending",
              rawInput: {
                variant: "Bash",
                command,
                description: index === 0 ? "Read package metadata" : "Read it again",
              },
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Not in allowlist: ${command}`,
                  },
                },
              ],
            },
            options: permissionOptions,
          });
          logClientToolResult({ method: "session/request_permission", result: permission });
          cancelled =
            cancelled ||
            cancelledSessions.delete(requestedSessionId) ||
            permission.outcome.outcome === "cancelled";
          if (cancelled) {
            break;
          }
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return { stopReason: "end_turn" };
      }

      if (emitXAiAskUserQuestion || emitXAiAskUserQuestionThenHang) {
        const result = yield* agent.client.extRequest("_x.ai/ask_user_question", {
          method: "x.ai/ask_user_question",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "ask-user-question-tool-call-1",
            questions: [
              {
                question: "Which scope should Grok use?",
                multiSelect: null,
                options: [
                  { label: "Workspace", description: "Use the current workspace" },
                  { label: "Session", description: "Only use this session" },
                ],
              },
            ],
            mode: "default",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/ask_user_question response outcome.");
        }
        if (result.outcome === "cancelled") {
          return { stopReason: "end_turn" };
        }
        if (
          result.outcome !== "accepted" ||
          !("answers" in result) ||
          typeof result.answers !== "object" ||
          result.answers === null
        ) {
          throw new Error("Expected accepted _x.ai/ask_user_question response answers.");
        }

        if (emitXAiAskUserQuestionThenHang) {
          return yield* Effect.never;
        }

        return { stopReason: "end_turn" };
      }

      if (emitXAiPlanMdWrite) {
        // Match Grok's real session layout so isGrokPlanMarkdownPath accepts it.
        const planRoot = process.env.CODEWORK_ACP_PLAN_ROOT ?? "/tmp/mock-home/.grok";
        const planPath = `${planRoot}/sessions/${requestedSessionId}/plan.md`;
        const planBody = "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it\n";
        // enter_plan_mode first so the adapter arms planModeActive.
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "enter-plan-mode-1",
            title: "enter_plan_mode",
            kind: "other",
            status: "completed",
            rawInput: { variant: "EnterPlanMode" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "plan-md-write-1",
            title: "write",
            kind: "edit",
            status: "pending",
            rawInput: { file_path: planPath, content: planBody },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "plan-md-write-1",
            kind: "edit",
            status: "completed",
            title: `Write \`${planPath}\``,
            rawInput: { file_path: planPath, content: planBody },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planBody,
              },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }

      if (emitXAiExitPlanMode) {
        const result = yield* agent.client.extRequest("_x.ai/exit_plan_mode", {
          method: "x.ai/exit_plan_mode",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "exit-plan-mode-tool-call-1",
            planContent: "# Exit plan\n\n- Step one\n- Step two\n",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/exit_plan_mode response outcome.");
        }
        if (
          result.outcome !== "abandoned" &&
          result.outcome !== "approved" &&
          result.outcome !== "request_changes"
        ) {
          throw new Error(
            `Expected exit_plan_mode outcome abandoned|approved|request_changes, got ${String(result.outcome)}`,
          );
        }
        return { stopReason: "end_turn" };
      }

      if (emitForeignSessionUpdates) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "root before child" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child content" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "child-tool-call-1",
            title: "Child-only tool",
            kind: "other",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " root after child" },
          },
        });
        return { stopReason: "end_turn" };
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect mock ACP state",
              priority: "high",
              status: "completed",
            },
            {
              content: "Implement the requested change",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      return { stopReason: "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (emitGajaeIdle && method === "_codework.test/gajae-update") {
      return Effect.gen(function* () {
        writeJsonRpcNotification("session/update", params);
        // 顺序通知作为处理屏障，不靠真实睡眠判断通知是否消费。
        yield* agent.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId },
        });
        return {};
      });
    }
    if (emitKiroCommands && method === "_kiro.dev/commands/execute") {
      return Effect.gen(function* () {
        const value = params as {
          sessionId: string;
          command: { command: string; args: { value?: string } };
        };
        if (value.command.args.value === "wait") {
          yield* agent.client.sessionUpdate({
            sessionId: value.sessionId,
            update: { sessionUpdate: "current_mode_update", currentModeId },
          });
          return yield* Effect.never;
        }
        if (value.command.args.value === "invalid") return { unexpected: true };
        if (value.command.args.value === "rpc-error")
          return yield* AcpError.AcpRequestError.internalError("模拟命令 RPC 失败");
        if (value.command.args.value === "reject") return { success: false, message: "命令被拒绝" };
        if (value.command.command === "inspect") {
          writeJsonRpcNotification("_kiro.dev/commands/available", {
            sessionId: value.sessionId,
            commands: [],
            prompts: [],
          });
        }
        return {
          success: true,
          message: "命令执行完成",
          data: { selected: value.command.args.value ?? "none" },
        };
      });
    }
    if (emitKiroCommands && method === "_codework.test/kiro-commands") {
      return Effect.gen(function* () {
        writeJsonRpcNotification("_kiro.dev/commands/available", params);
        // 标准通知作为消费屏障，测试无需依赖固定等待时间。
        yield* agent.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId },
        });
        return {};
      });
    }
    if (method === "cursor/list_available_models") {
      return Effect.succeed({
        models: availableModels(),
      });
    }

    if (method !== "session/mode/set" && method !== "session/set_mode") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }
    if (process.env.CODEWORK_ACP_MODE_FAILURE === "rpc") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }
    if (process.env.CODEWORK_ACP_MODE_FAILURE === "malformed") return Effect.succeed(null);

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
