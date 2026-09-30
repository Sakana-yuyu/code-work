import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { stableStringify } from "@codework/shared/relaySigning";

import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  toAcpModeOption,
  toAcpConfigOptions,
  parseSessionModels,
  parsePermissionRequest,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

interface AcpToolCallTrackedState {
  readonly state: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
  readonly permissionStatus?: "pending" | "completed" | "failed";
}

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

export interface AcpSessionEventStreamBarrier {
  readonly _tag: "EventStreamBarrier";
  readonly acknowledge: Deferred.Deferred<void>;
}

export type AcpSessionRuntimeEvent = AcpParsedSessionEvent | AcpSessionEventStreamBarrier;

const defaultSessionLoadTimeout = Duration.seconds(90);
const decodeSetModeResponse = Schema.decodeUnknownEffect(EffectAcpSchema.SetSessionModeResponse);
const defaultSessionLoadReplayIdleGap = Duration.seconds(2);

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export class AcpSessionRuntime extends Context.Service<
  AcpSessionRuntime,
  {
    /**
     * Registers a handler for `session/request_permission`.
     * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
     */
    readonly handleRequestPermission: EffectAcpClient.AcpClient["Service"]["handleRequestPermission"];
    /**
     * Registers a handler for `session/elicitation`.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
     */
    readonly handleElicitation: EffectAcpClient.AcpClient["Service"]["handleElicitation"];
    /**
     * Registers a handler for `fs/read_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
     */
    readonly handleReadTextFile: EffectAcpClient.AcpClient["Service"]["handleReadTextFile"];
    /**
     * Registers a handler for `fs/write_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
     */
    readonly handleWriteTextFile: EffectAcpClient.AcpClient["Service"]["handleWriteTextFile"];
    /**
     * Registers a handler for `terminal/create`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/create
     */
    readonly handleCreateTerminal: EffectAcpClient.AcpClient["Service"]["handleCreateTerminal"];
    /**
     * Registers a handler for `terminal/output`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/output
     */
    readonly handleTerminalOutput: EffectAcpClient.AcpClient["Service"]["handleTerminalOutput"];
    /**
     * Registers a handler for `terminal/wait_for_exit`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
     */
    readonly handleTerminalWaitForExit: EffectAcpClient.AcpClient["Service"]["handleTerminalWaitForExit"];
    /**
     * Registers a handler for `terminal/kill`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
     */
    readonly handleTerminalKill: EffectAcpClient.AcpClient["Service"]["handleTerminalKill"];
    /**
     * Registers a handler for `terminal/release`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/release
     */
    readonly handleTerminalRelease: EffectAcpClient.AcpClient["Service"]["handleTerminalRelease"];
    /**
     * Registers a handler for `session/update`.
     * @see https://agentclientprotocol.com/protocol/schema#session/update
     */
    readonly handleSessionUpdate: EffectAcpClient.AcpClient["Service"]["handleSessionUpdate"];
    /**
     * Registers a handler for `session/elicitation/complete`.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
     */
    readonly handleElicitationComplete: EffectAcpClient.AcpClient["Service"]["handleElicitationComplete"];
    /**
     * Registers a fallback extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtRequest: EffectAcpClient.AcpClient["Service"]["handleUnknownExtRequest"];
    /**
     * Registers a fallback extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtNotification: EffectAcpClient.AcpClient["Service"]["handleUnknownExtNotification"];
    /**
     * Registers a typed extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtRequest: EffectAcpClient.AcpClient["Service"]["handleExtRequest"];
    /**
     * Registers a typed extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtNotification: EffectAcpClient.AcpClient["Service"]["handleExtNotification"];
    /**
     * Initializes the ACP connection, authenticates, and loads, resumes, or creates the session.
     * Concurrent calls share the same in-flight startup and a failed startup may be retried.
     */
    readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    /** Stream of parsed ACP session events emitted after startup. */
    readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
    /** Waits until the current event consumer has processed every queued event. */
    readonly drainEvents: Effect.Effect<void>;
    /** Latest mode state observed from session setup and `session/update` notifications. */
    readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
    /** 会话建立、主动写入和配置通知共同维护的最新配置。 */
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    /** 当前会话广告的命令；空列表表示未提供或已撤回。 */
    readonly getAvailableCommands: Effect.Effect<
      ReadonlyArray<import("@codework/contracts").ServerProviderSlashCommand>
    >;
    readonly getAvailableModels: Effect.Effect<ReturnType<typeof parseSessionModels>>;
    /**
     * Sends a prompt turn to the active session.
     * @see https://agentclientprotocol.com/protocol/schema#session/prompt
     */
    readonly prompt: (
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a real ACP `session/cancel` notification for the active session.
     * @see https://agentclientprotocol.com/protocol/schema#session/cancel
     */
    readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
    /** 在释放进程之前关闭已建立且广告了关闭能力的会话；不会为关闭而启动新会话。 */
    readonly close: Effect.Effect<void, EffectAcpErrors.AcpError>;
    /**
     * Selects the active mode through the negotiated `mode` configuration option.
     * This is a no-op when the requested mode is already active.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setMode: (
      modeId: string,
    ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
    /**
     * Updates a session configuration option and the runtime configuration snapshot.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setConfigOption: (
      configId: string,
      value: string | boolean,
    ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
    /**
     * Selects the base model through the negotiated model configuration option.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    /**
     * Selects the active model through the unstable ACP `session/set_model` capability.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_model
     */
    readonly setSessionModel: (
      modelId: string,
      meta?: EffectAcpSchema.SetSessionModelRequest["_meta"],
    ) => Effect.Effect<EffectAcpSchema.SetSessionModelResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a generic ACP extension request and records it through the request logger.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    /**
     * Sends a generic ACP extension notification.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly notify: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  }
>()("codework/provider/acp/AcpSessionRuntime") {}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export const make = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallTrackedState>());
    const assistantItemRuntimeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to generate an ACP assistant item runtime identifier.",
            cause,
          }),
      ),
    );
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const modelsRef = yield* Ref.make<ReturnType<typeof parseSessionModels>>(null);
    const commandsRef = yield* Ref.make<
      ReadonlyArray<import("@codework/contracts").ServerProviderSlashCommand>
    >([]);
    const pendingMetadata = new Map<
      string,
      {
        commands?: {
          notification: EffectAcpSchema.SessionNotification;
        };
        configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
      }
    >();
    const updateConfigOptions = (response: {
      readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
    }) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(configOptionsRef);
        const configOptions = sessionConfigOptionsFromSetup(response);
        yield* Ref.set(configOptionsRef, configOptions);
        const descriptors = toAcpConfigOptions(configOptions);
        if (stableStringify(toAcpConfigOptions(previous)) !== stableStringify(descriptors)) {
          yield* Queue.offer(eventQueue, {
            _tag: "ConfigOptionsUpdated",
            configOptions: descriptors,
            rawPayload: response,
          });
        }
        const previousModels = yield* Ref.get(modelsRef);
        const models =
          parseSessionModels({
            configOptions: configOptions.length > 0 ? configOptions : null,
          }) ?? (previous.some((option) => option.category === "model") ? [] : previousModels);
        yield* Ref.set(modelsRef, models);
        if (
          models !== null &&
          (previousModels === null ||
            previousModels.length !== models.length ||
            models.some((model, index) => {
              const previousModel = previousModels[index];
              return (
                model.slug !== previousModel?.slug ||
                model.name !== previousModel.name ||
                model.isDefault !== previousModel.isDefault
              );
            }))
        )
          yield* Queue.offer(eventQueue, { _tag: "ModelsUpdated", models, rawPayload: response });
        const modeState = parseSessionModeState(response);
        // 完整快照移除模式时清理派生状态；未使用配置模式的旧协议仍保留 modes。
        if (
          modeState ||
          previous.some((option) => option.category === "mode" && option.type === "select")
        ) {
          const previousMode = yield* Ref.get(modeStateRef);
          yield* Ref.set(modeStateRef, modeState);
          if (stableStringify(previousMode ?? null) !== stableStringify(modeState ?? null)) {
            yield* Queue.offer(eventQueue, {
              _tag: "ModesUpdated",
              mode: toAcpModeOption(modeState),
              rawPayload: response,
            });
          }
        }
      });
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    const promptSerializationSemaphore = yield* Semaphore.make(1);
    const activePromptFiberRef = yield* Ref.make<
      Option.Option<Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>>
    >(Option.none());
    const sessionLoadGateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(Option.none());

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const spawnCommand = yield* resolveSpawnCommand(
      options.spawn.command,
      options.spawn.args,
      options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {},
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {}),
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    if (spawnCommand.shell) {
      yield* Effect.addFinalizer(() =>
        Effect.scoped(
          spawner
            .spawn(
              ChildProcess.make("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
                stdout: "ignore",
                stderr: "ignore",
              }),
            )
            .pipe(
              Effect.flatMap((taskkill) => taskkill.exitCode),
              Effect.asVoid,
              Effect.ignore,
            ),
        ),
      );
    }

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    const acceptSessionUpdate = (notification: EffectAcpSchema.SessionNotification) =>
      Effect.gen(function* () {
        const gate = yield* Ref.get(sessionLoadGateRef);
        if (Option.isSome(gate) && gate.value.active) {
          if (notification.sessionId !== options.resumeSessionId) return;
          const lastActivityAtMillis = yield* Clock.currentTimeMillis;
          yield* Ref.set(
            sessionLoadGateRef,
            Option.some({
              ...gate.value,
              lastActivityAtMillis,
            }),
          );
        }
        if (sessionUpdateIsReplay(notification)) {
          return;
        }
        const startState = yield* Ref.get(startStateRef);
        if (startState._tag === "Starting") {
          const pending = pendingMetadata.get(notification.sessionId);
          if (notification.update.sessionUpdate === "available_commands_update") {
            pendingMetadata.set(notification.sessionId, {
              ...pending,
              commands: { notification },
            });
          } else if (notification.update.sessionUpdate === "config_option_update") {
            pendingMetadata.set(notification.sessionId, {
              ...pending,
              configOptions: notification.update.configOptions,
            });
          }
          return;
        }
        // One runtime projects one root ACP session. Child-session updates need
        // explicit lineage routing and must never be flattened into this stream.
        if (
          (Option.isSome(gate) && gate.value.active) ||
          startState._tag !== "Started" ||
          notification.sessionId !== startState.result.sessionId
        ) {
          return;
        }
        if (notification.update.sessionUpdate === "config_option_update") {
          yield* updateConfigOptions(notification.update);
          return;
        }
        if (notification.update.sessionUpdate === "available_commands_update") {
          for (const event of parseSessionUpdateEvent(notification).events) {
            if (event._tag !== "CommandsUpdated") continue;
            yield* Ref.set(commandsRef, event.commands);
            yield* Queue.offer(eventQueue, event);
          }
          return;
        }
        if (notification.update.sessionUpdate === "current_mode_update") {
          const currentValue = notification.update.currentModeId.trim();
          if (currentValue) {
            yield* Ref.update(configOptionsRef, (configOptions) =>
              configOptions.map((option) =>
                option.category === "mode" && option.type === "select"
                  ? { ...option, currentValue }
                  : option,
              ),
            );
          }
        }
        yield* handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          toolCallsRef,
          assistantSegmentRef,
          assistantItemRuntimeId,
          params: notification,
        });
      });
    yield* acp.handleSessionUpdate(acceptSessionUpdate);
    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: "ACP session runtime has not been started",
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    const setSessionModel = (
      modelId: string,
      meta?: EffectAcpSchema.SetSessionModelRequest["_meta"],
    ) =>
      Effect.gen(function* () {
        const started = yield* getStartedState;
        const requestPayload = {
          sessionId: started.sessionId,
          modelId,
          ...(meta !== undefined ? { _meta: meta } : {}),
        } satisfies EffectAcpSchema.SetSessionModelRequest;
        const response = yield* runLoggedRequest(
          "session/set_model",
          requestPayload,
          acp.agent.setSessionModel(requestPayload),
        );
        const previous = yield* Ref.get(modelsRef);
        if (previous && !previous.some((model) => model.slug === modelId && model.isDefault)) {
          const models = previous.map((model) => ({ ...model, isDefault: model.slug === modelId }));
          // 旧式接口可以接受目录外自定义模型；成功响应后保留请求 ID，不推测展示名或能力。
          if (!models.some((model) => model.slug === modelId))
            models.push({
              slug: modelId,
              name: modelId,
              isDefault: true,
              isCustom: true,
              capabilities: null,
            });
          yield* Ref.set(modelsRef, models);
          yield* Queue.offer(eventQueue, { _tag: "ModelsUpdated", models, rawPayload: response });
        }
        return response;
      });

    const startOnce = Effect.gen(function* () {
      pendingMetadata.clear();
      yield* Ref.set(configOptionsRef, []);
      yield* Ref.set(modelsRef, null);
      yield* Ref.set(modeStateRef, undefined);
      yield* Ref.set(commandsRef, []);
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );

      // 空方法显式选择 CLI 已有凭据；是否可建会话仍由上游校验。
      if (options.authMethodId.trim()) {
        const authenticatePayload = {
          methodId: options.authMethodId,
        } satisfies EffectAcpSchema.AuthenticateRequest;
        yield* runLoggedRequest(
          "authenticate",
          authenticatePayload,
          acp.agent.authenticate(authenticatePayload),
        );
      }

      let sessionId: string;
      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;
      if (options.resumeSessionId) {
        const loadPayload = {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
        } satisfies EffectAcpSchema.LoadSessionRequest;
        const sessionLoadTimeout = Duration.fromInputUnsafe(
          options.sessionLoadTimeout ?? defaultSessionLoadTimeout,
        );
        const sessionLoadReplayIdleGap = Duration.fromInputUnsafe(
          options.sessionLoadReplayIdleGap ?? defaultSessionLoadReplayIdleGap,
        );

        yield* Ref.set(
          sessionLoadGateRef,
          Option.some({
            active: true,
            lastActivityAtMillis: undefined,
            idleGap: sessionLoadReplayIdleGap,
            initializeResult,
          }),
        );

        sessionId = options.resumeSessionId;
        sessionSetupResult = yield* Effect.gen(function* () {
          yield* logRequest({
            method: "session/load",
            payload: loadPayload,
            status: "started",
          });

          const idleFiber = yield* waitForSessionLoadReplayIdle({
            gateRef: sessionLoadGateRef,
          }).pipe(Effect.forkIn(runtimeScope));
          const loaded = yield* Effect.raceFirst(
            acp.agent.loadSession(loadPayload),
            Fiber.join(idleFiber),
          ).pipe(
            Effect.ensuring(Fiber.interrupt(idleFiber).pipe(Effect.ignore)),
            Effect.timeoutOption(sessionLoadTimeout),
            Effect.flatMap((result) =>
              Option.match(result, {
                onNone: () =>
                  Effect.fail(
                    new EffectAcpErrors.AcpTransportError({
                      operation: "call-rpc",
                      method: "session/load",
                      detail: "session/load timed out waiting for RPC response or replay idle gap",
                      cause: undefined,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
            Effect.tap((result) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "failed",
                cause,
              }),
            ),
          );

          return loaded;
        }).pipe(Effect.ensuring(Ref.set(sessionLoadGateRef, Option.none())));
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }

      // 响应携带明确快照时优先采用；未提供配置时保留握手期间的最后一次有效广告。
      const initialMetadata = pendingMetadata.get(sessionId);
      if (
        sessionSetupResult.configOptions == null &&
        initialMetadata?.configOptions !== undefined
      ) {
        sessionSetupResult = {
          ...sessionSetupResult,
          configOptions: initialMetadata.configOptions,
        };
      }
      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));
      yield* Ref.set(modelsRef, parseSessionModels(sessionSetupResult));
      const initialCommands = initialMetadata?.commands;
      if (initialCommands) {
        for (const event of parseSessionUpdateEvent(initialCommands.notification).events) {
          if (event._tag === "CommandsUpdated") yield* Ref.set(commandsRef, event.commands);
        }
      }
      pendingMetadata.clear();

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
      } satisfies AcpStartedState;
      return nextState;
    });

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
                Effect.tap((result) =>
                  Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, result)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    return {
      handleRequestPermission: (handler) =>
        acp.handleRequestPermission((request) =>
          Effect.gen(function* () {
            const started = yield* Ref.get(startStateRef);
            const rootSession =
              started._tag === "Started" && request.sessionId === started.result.sessionId;
            const toolCall = parsePermissionRequest(request).toolCall;
            if (rootSession && toolCall) {
              yield* Ref.update(toolCallsRef, (current) => {
                if (current.has(toolCall.toolCallId)) return current;
                return new Map(current).set(toolCall.toolCallId, {
                  state: toolCall,
                  lastEmittedDetailLength: undefined,
                  skippedSinceEmit: 0,
                  permissionStatus: "pending",
                });
              });
            }
            const response = yield* handler(request);
            if (rootSession && toolCall) {
              const outcome = response.outcome;
              const choice =
                outcome.outcome === "selected"
                  ? request.options.find((option) => option.optionId === outcome.optionId)
                  : undefined;
              const permissionStatus =
                outcome.outcome === "cancelled" || choice?.kind.startsWith("reject")
                  ? ("failed" as const)
                  : choice?.kind.startsWith("allow")
                    ? ("completed" as const)
                    : ("pending" as const);
              yield* Ref.update(toolCallsRef, (current) => {
                const tracked = current.get(toolCall.toolCallId);
                if (tracked?.permissionStatus !== "pending") return current;
                return new Map(current).set(toolCall.toolCallId, { ...tracked, permissionStatus });
              });
            }
            return response;
          }),
        ),
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      start: () => start,
      getEvents: () => Stream.fromQueue(eventQueue),
      drainEvents: Effect.gen(function* () {
        const acknowledge = yield* Deferred.make<void>();
        yield* Queue.offer(eventQueue, {
          _tag: "EventStreamBarrier",
          acknowledge,
        });
        yield* Deferred.await(acknowledge);
      }),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      getAvailableCommands: Ref.get(commandsRef),
      getAvailableModels: Ref.get(modelsRef),
      prompt: (payload) =>
        promptSerializationSemaphore.withPermit(
          Effect.gen(function* () {
            const started = yield* getStartedState;
            // 审批身份只用于当前回合，未发送终态的权限请求不占用后续回合的工具 ID。
            yield* Ref.update(
              toolCallsRef,
              (current) =>
                new Map(
                  [...current].filter(([, tracked]) => tracked.permissionStatus === undefined),
                ),
            );
            yield* closeActiveAssistantSegment({
              queue: eventQueue,
              assistantSegmentRef,
            });
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest;
            const cancelledResponse = {
              stopReason: "cancelled",
            } satisfies EffectAcpSchema.PromptResponse;
            const promptRpcFiber = yield* runLoggedRequest(
              "session/prompt",
              requestPayload,
              acp.agent.prompt(requestPayload),
            ).pipe(Effect.forkIn(runtimeScope));
            yield* Ref.set(activePromptFiberRef, Option.some(promptRpcFiber));
            return yield* Fiber.join(promptRpcFiber).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.succeed(cancelledResponse)
                  : Effect.failCause(cause),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Fiber.interrupt(promptRpcFiber).pipe(Effect.ignore);
                  yield* Ref.set(activePromptFiberRef, Option.none());
                }),
              ),
              Effect.tap((result) =>
                Effect.gen(function* () {
                  if (result.stopReason === "cancelled") {
                    // 客户端中断时上游可能不发工具终态；把已展示的进行中工具结束为 failed。
                    const openTools = yield* Ref.get(toolCallsRef);
                    const toFail = [...openTools.values()].filter(
                      (tracked) =>
                        (tracked.state.status === "pending" ||
                          tracked.state.status === "inProgress") &&
                        (tracked.permissionStatus === undefined ||
                          tracked.lastEmittedDetailLength !== undefined),
                    );
                    if (toFail.length > 0) {
                      yield* closeActiveAssistantSegment({
                        queue: eventQueue,
                        assistantSegmentRef,
                      });
                      for (const tracked of toFail) {
                        yield* Queue.offer(eventQueue, {
                          _tag: "ToolCallUpdated" as const,
                          toolCall: { ...tracked.state, status: "failed" as const },
                          rawPayload: {
                            sessionId: started.sessionId,
                            update: {
                              sessionUpdate: "tool_call_update",
                              toolCallId: tracked.state.toolCallId,
                              status: "failed",
                              ...(tracked.state.title ? { title: tracked.state.title } : {}),
                            },
                          },
                        });
                      }
                    }
                    yield* Ref.set(toolCallsRef, new Map());
                  }
                  yield* closeActiveAssistantSegment({
                    queue: eventQueue,
                    assistantSegmentRef,
                  });
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) =>
          Effect.gen(function* () {
            const activePromptFiber = yield* Ref.get(activePromptFiberRef);
            if (Option.isSome(activePromptFiber)) {
              yield* Fiber.interrupt(activePromptFiber.value).pipe(Effect.ignore);
            }
            yield* acp.agent
              .cancel({ sessionId: started.sessionId })
              .pipe(Effect.ignore, Effect.forkIn(runtimeScope));
          }),
        ),
      ),

      close: Effect.gen(function* () {
        const state = yield* Ref.get(startStateRef);
        if (
          state._tag !== "Started" ||
          state.result.initializeResult.agentCapabilities?.sessionCapabilities?.close == null
        )
          return;
        const payload = { sessionId: state.result.sessionId };
        yield* runLoggedRequest(
          "session/close",
          payload,
          acp.agent.closeSession(payload).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap((response) =>
              Option.isSome(response)
                ? Effect.succeed(response.value)
                : Effect.fail(
                    new EffectAcpErrors.AcpRequestError({
                      code: -32000,
                      errorMessage: "ACP 会话关闭等待超过 5 秒，远端关闭状态未知。",
                      method: "session/close",
                    }),
                  ),
            ),
          ),
        );
      }),
      setMode: (modeId) =>
        Effect.gen(function* () {
          const modeState = yield* Ref.get(modeStateRef);
          if (!modeState?.availableModes.some((mode) => mode.id === modeId)) {
            return yield* new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: "所选 ACP 模式已失效或未由当前会话提供，请重新选择。",
            });
          }
          if (modeState.currentModeId === modeId) return {};
          const configOptions = yield* Ref.get(configOptionsRef);
          const modeConfig = configOptions.find(
            (option) => option.category === "mode" && option.type === "select",
          );
          if (modeConfig) {
            yield* setConfigOption(modeConfig.id, modeId);
          } else {
            const started = yield* getStartedState;
            const payload = { sessionId: started.sessionId, modeId };
            yield* runLoggedRequest(
              "session/set_mode",
              payload,
              acp.raw.request("session/set_mode", payload).pipe(
                Effect.flatMap((result) =>
                  decodeSetModeResponse(result).pipe(
                    Effect.mapError(
                      (cause) =>
                        new EffectAcpErrors.AcpTransportError({
                          detail: "ACP 模式响应格式无效",
                          cause,
                        }),
                    ),
                  ),
                ),
              ),
            );
            yield* updateCurrentModeId(modeId);
            yield* Queue.offer(eventQueue, {
              _tag: "ModesUpdated",
              mode: toAcpModeOption(yield* Ref.get(modeStateRef)),
              rawPayload: payload,
            });
          }
          return {} satisfies EffectAcpSchema.SetSessionModeResponse;
        }),
      setConfigOption,
      setModel: (model) =>
        Effect.gen(function* () {
          const configOptions = yield* Ref.get(configOptionsRef);
          const modelConfigId = extractModelConfigId({ configOptions });
          const started = yield* getStartedState;
          // 模型配置与旧式模型广告是两个接口，不能把成功保存任意配置当作模型切换。
          if (!modelConfigId && started.sessionSetupResult.models != null) {
            yield* setSessionModel(model);
          } else {
            yield* setConfigOption(modelConfigId ?? "model", model);
          }
        }),
      setSessionModel,
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntime["Service"];
  });

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> => Layer.effect(AcpSessionRuntime, make(options));

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  assistantItemRuntimeId,
  params,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallTrackedState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly assistantItemRuntimeId: string;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        const { merged, decision, approvalOnly } = yield* Ref.modify(toolCallsRef, (current) => {
          const tracked = current.get(event.toolCall.toolCallId);
          // 仅审批身份的无内容终态关闭权限气泡；输出、执行更新或不匹配的失败均属于工具证据。
          if (
            tracked?.permissionStatus !== undefined &&
            tracked.permissionStatus !== "pending" &&
            params.update.sessionUpdate === "tool_call_update" &&
            event.toolCall.status === tracked.permissionStatus &&
            Object.keys(params.update).every((key) =>
              ["sessionUpdate", "toolCallId", "status"].includes(key),
            )
          ) {
            const next = new Map(current);
            next.delete(event.toolCall.toolCallId);
            const result = {
              merged: event.toolCall,
              decision: { emit: false, skippedSinceEmit: 0 },
              approvalOnly: true,
            };
            return [result, next] as const;
          }
          const previous = tracked?.state;
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const decision = decideToolCallUpdateEmission({
            previous,
            next: nextToolCall,
            lastEmittedDetailLength: tracked?.lastEmittedDetailLength,
            skippedSinceEmit: tracked?.skippedSinceEmit ?? 0,
          });
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, {
              state: nextToolCall,
              lastEmittedDetailLength: decision.emit
                ? toolCallProgressLength(nextToolCall)
                : tracked?.lastEmittedDetailLength,
              skippedSinceEmit: decision.skippedSinceEmit,
            });
          }
          return [{ merged: nextToolCall, decision, approvalOnly: false }, next] as const;
        });
        if (!approvalOnly) yield* closeActiveAssistantSegment({ queue, assistantSegmentRef });
        if (!decision.emit) {
          continue;
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.streamKind === "reasoning_text") {
          // 思考单独传递，正文不能跨过思考段合并。
          yield* closeActiveAssistantSegment({ queue, assistantSegmentRef });
          yield* Queue.offer(queue, event);
          continue;
        }
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        if (event.standalone) {
          yield* closeActiveAssistantSegment({ queue, assistantSegmentRef });
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          assistantItemRuntimeId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        if (event.standalone) {
          yield* closeActiveAssistantSegment({ queue, assistantSegmentRef });
        }
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

const assistantItemId = (sessionId: string, runtimeId: string, segmentIndex: number) =>
  `assistant:${sessionId}:runtime:${runtimeId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
  assistantItemRuntimeId,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly assistantItemRuntimeId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, assistantItemRuntimeId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
