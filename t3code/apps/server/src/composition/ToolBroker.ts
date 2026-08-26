import {
  CompositionToolResult,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  ProjectReadFileResult,
  ProjectWriteFileResult,
  ReviewDiffPreviewInput,
  TerminalOpenInput,
  type TerminalSessionSnapshot,
  TerminalWriteInput,
  type PreviewTabId,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { normalizePreviewOpenInput } from "../mcp/toolkits/preview/handlers.ts";
import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import { makeCompositionBrowserScope } from "./CompositionBrowserContext.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { compositionToolCapabilityId } from "./CompositionToolRegistry.ts";
import * as CompositionIdeSessionRegistry from "./CompositionIdeSessionRegistry.ts";
import * as CompositionMcpToolRegistry from "./CompositionMcpToolRegistry.ts";

const WorkspaceReadArguments = Schema.Struct({
  cwd: Schema.String,
  relativePath: Schema.String,
});
type WorkspaceReadArguments = typeof WorkspaceReadArguments.Type;

const WorkspaceWriteArguments = Schema.Struct({
  cwd: Schema.String,
  relativePath: Schema.String,
  contents: Schema.String,
});
type WorkspaceWriteArguments = typeof WorkspaceWriteArguments.Type;

const TerminalOpenArguments = Schema.Struct({
  cwd: Schema.String,
  terminalId: Schema.String,
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const TerminalWriteArguments = Schema.Struct({
  terminalId: Schema.String,
  data: Schema.String,
});

const TerminalExecArguments = Schema.Struct({
  cwd: Schema.String,
  terminalId: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const TerminalSnapshotArguments = Schema.Struct({
  terminalId: Schema.String,
});

const TerminalCloseArguments = Schema.Struct({
  terminalId: Schema.String,
  deleteHistory: Schema.optional(Schema.Boolean),
});

const GitStatusArguments = Schema.Struct({ cwd: Schema.String });

const GitDiffArguments = Schema.Struct({
  cwd: Schema.String,
  baseRef: Schema.optional(Schema.String),
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});

const IdeInvokeArguments = Schema.Struct({
  sessionId: Schema.String,
  handshakeId: Schema.String,
  operation: Schema.String,
  arguments: Schema.Unknown,
});

export type ToolBrokerInput = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly canonicalToolName: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly capabilityGrantIds: readonly string[];
  readonly approvalRequestId?: string;
  readonly workspaceRoot: string;
  readonly runtimeId?: string;
  readonly threadId?: string;
  readonly providerInstanceId?: string;
};

export type ToolBrokerResult = CompositionToolResult & {
  readonly approvalRequestId?: string;
};

export class ToolNotRegisteredError extends Schema.TaggedErrorClass<ToolNotRegisteredError>()(
  "ToolNotRegisteredError",
  { canonicalToolName: Schema.String },
) {
  override get message(): string {
    return `Tool '${this.canonicalToolName}' is not registered.`;
  }
}

export class ToolArgumentsInvalidError extends Schema.TaggedErrorClass<ToolArgumentsInvalidError>()(
  "ToolArgumentsInvalidError",
  { canonicalToolName: Schema.String },
) {
  override get message(): string {
    return `Arguments for tool '${this.canonicalToolName}' are invalid.`;
  }
}

export class ToolScopeMissingError extends Schema.TaggedErrorClass<ToolScopeMissingError>()(
  "ToolScopeMissingError",
  { canonicalToolName: Schema.String },
) {
  override get message(): string {
    return `Tool '${this.canonicalToolName}' is missing a trusted runtime scope.`;
  }
}

const isToolArgumentsInvalidError = Schema.is(ToolArgumentsInvalidError);
const isToolScopeMissingError = Schema.is(ToolScopeMissingError);
const isIdeSessionFailure = Schema.is(CompositionIdeSessionRegistry.CompositionIdeSessionFailure);
const MAX_RESULT_BYTES = 64 * 1024;
const secretPatterns = [
  /(api[_-]?key\s*[:=]\s*)([^\s\n]+)/gi,
  /(authorization\s*:\s*bearer\s+)([^\s\n]+)/gi,
  /(token\s*[:=]\s*)([^\s\n]+)/gi,
];

const redact = (value: string): string =>
  secretPatterns.reduce((current, pattern) => current.replace(pattern, "$1[REDACTED]"), value);

const limitReadResult = (result: ProjectReadFileResult): ProjectReadFileResult => {
  const redacted = redact(result.contents);
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.byteLength <= MAX_RESULT_BYTES) {
    return { ...result, contents: redacted };
  }
  const contents = new TextDecoder().decode(encoded.slice(0, MAX_RESULT_BYTES));
  return { ...result, contents, truncated: true };
};

export class ToolBroker extends Context.Service<
  ToolBroker,
  {
    readonly invoke: (input: ToolBrokerInput) => Effect.Effect<ToolBrokerResult>;
    readonly cancel: (input: { readonly idempotencyKey: string }) => Effect.Effect<void>;
  }
>()("t3/composition/ToolBroker") {}

type ToolOperation = "read" | "execute" | "mutate";

type ToolHandler = {
  readonly operation: ToolOperation;
  readonly execute: (input: ToolBrokerInput) => Effect.Effect<unknown, Error, never>;
};

const make = Effect.gen(function* () {
  const policy = yield* CapabilityPolicy.CapabilityPolicy;
  const registry = yield* CapabilityRegistry.CapabilityRegistry;
  const grantRegistry = yield* Effect.serviceOption(
    CapabilityGrantRegistry.CapabilityGrantRegistry,
  );
  const terminalManager = yield* Effect.serviceOption(TerminalManager.TerminalManager);
  const gitVcsDriver = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  const previewBroker = yield* Effect.serviceOption(
    PreviewAutomationBroker.PreviewAutomationBroker,
  );
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const ideSessionRegistry = yield* Effect.serviceOption(
    CompositionIdeSessionRegistry.CompositionIdeSessionRegistryService,
  );
  const mcpToolRegistry = yield* Effect.serviceOption(
    CompositionMcpToolRegistry.CompositionMcpToolRegistry,
  );
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const completed = new Set<string>();

  const handlers = new Map<string, ToolHandler>([
    [
      "workspace.read_file",
      {
        operation: "read",
        execute: (input) =>
          Effect.gen(function* () {
            const args = yield* Schema.decodeUnknownEffect(WorkspaceReadArguments)(
              input.arguments,
            ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
            if (args.cwd !== input.workspaceRoot)
              return yield* new ToolArgumentsInvalidError(input);
            return limitReadResult(yield* workspaceFileSystem.readFile(args));
          }),
      },
    ],
    [
      "workspace.write_file",
      {
        operation: "mutate",
        execute: (input) =>
          Effect.gen(function* () {
            const args = yield* Schema.decodeUnknownEffect(WorkspaceWriteArguments)(
              input.arguments,
            ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
            if (args.cwd !== input.workspaceRoot)
              return yield* new ToolArgumentsInvalidError(input);
            return yield* workspaceFileSystem.writeFile(args);
          }),
      },
    ],
  ]);

  if (Option.isSome(terminalManager)) {
    handlers.set("terminal.open", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(TerminalOpenArguments)(
            input.arguments,
          ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
          if (args.cwd !== input.workspaceRoot) return yield* new ToolArgumentsInvalidError(input);
          const terminalInput: TerminalOpenInput = {
            threadId: input.runId,
            terminalId: args.terminalId,
            cwd: input.workspaceRoot,
            ...(args.cols === undefined ? {} : { cols: args.cols }),
            ...(args.rows === undefined ? {} : { rows: args.rows }),
            ...(args.worktreePath === undefined ? {} : { worktreePath: args.worktreePath }),
            ...(args.env === undefined ? {} : { env: args.env }),
          };
          return yield* terminalManager.value.open(terminalInput);
        }),
    });
    handlers.set("terminal.write", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(TerminalWriteArguments)(
            input.arguments,
          ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
          const terminalInput: TerminalWriteInput = {
            threadId: input.runId,
            terminalId: args.terminalId,
            data: args.data,
          };
          yield* terminalManager.value.write(terminalInput);
          return { runId: input.runId, terminalId: args.terminalId, accepted: true };
        }),
    });
    handlers.set("terminal.exec", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(TerminalExecArguments)(
            input.arguments,
          ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
          if (args.cwd !== input.workspaceRoot) return yield* new ToolArgumentsInvalidError(input);
          return yield* terminalManager.value.runCommand({
            threadId: input.runId,
            terminalId: args.terminalId,
            cwd: input.workspaceRoot,
            command: args.command,
            ...(args.args === undefined ? {} : { args: [...args.args] }),
            ...(args.cols === undefined ? {} : { cols: args.cols }),
            ...(args.rows === undefined ? {} : { rows: args.rows }),
            ...(args.worktreePath === undefined ? {} : { worktreePath: args.worktreePath }),
            ...(args.env === undefined ? {} : { env: args.env }),
          });
        }),
    });
    handlers.set("terminal.snapshot", {
      operation: "read",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(TerminalSnapshotArguments)(
            input.arguments,
          ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
          let snapshot: TerminalSessionSnapshot | undefined;
          const unsubscribe = yield* terminalManager.value.attachStream(
            { threadId: input.runId, terminalId: args.terminalId },
            (event) =>
              Effect.sync(() => {
                if (event.type === "snapshot") snapshot = event.snapshot;
              }),
          );
          unsubscribe();
          if (snapshot === undefined) return yield* new ToolArgumentsInvalidError(input);
          return snapshot;
        }),
    });
    handlers.set("terminal.kill", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(TerminalSnapshotArguments)(
            input.arguments,
          ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
          yield* terminalManager.value.kill({
            threadId: input.runId,
            terminalId: args.terminalId,
          });
          return { runId: input.runId, terminalId: args.terminalId, killed: true };
        }),
    });
    handlers.set("terminal.close", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(TerminalCloseArguments)(
            input.arguments,
          ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
          yield* terminalManager.value.close({
            threadId: input.runId,
            terminalId: args.terminalId,
            ...(args.deleteHistory === undefined ? {} : { deleteHistory: args.deleteHistory }),
          });
          return { runId: input.runId, terminalId: args.terminalId, closed: true };
        }),
    });
  }

  if (Option.isSome(gitVcsDriver)) {
    handlers.set("git.status", {
      operation: "read",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(GitStatusArguments)(input.arguments).pipe(
            Effect.mapError(() => new ToolArgumentsInvalidError(input)),
          );
          if (args.cwd !== input.workspaceRoot) return yield* new ToolArgumentsInvalidError(input);
          return yield* gitVcsDriver.value.statusDetailsLocal(input.workspaceRoot);
        }),
    });
    handlers.set("git.diff", {
      operation: "read",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(GitDiffArguments)(input.arguments).pipe(
            Effect.mapError(() => new ToolArgumentsInvalidError(input)),
          );
          if (args.cwd !== input.workspaceRoot) return yield* new ToolArgumentsInvalidError(input);
          const diffInput: ReviewDiffPreviewInput = {
            cwd: input.workspaceRoot,
            ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }),
            ...(args.ignoreWhitespace === undefined
              ? {}
              : { ignoreWhitespace: args.ignoreWhitespace }),
          };
          return yield* gitVcsDriver.value.getReviewDiffPreview(diffInput);
        }),
    });
  }

  if (Option.isSome(previewBroker) && Option.isSome(serverEnvironment)) {
    const previewScope = Effect.fn("ToolBroker.previewScope")(function* (input: ToolBrokerInput) {
      const runtimeId = input.runtimeId ?? input.providerInstanceId;
      if (runtimeId === undefined || runtimeId.trim().length === 0) {
        return yield* new ToolScopeMissingError({ canonicalToolName: input.canonicalToolName });
      }
      const environmentId = yield* serverEnvironment.value.getEnvironmentId;
      return makeCompositionBrowserScope({
        environmentId,
        taskId: input.taskId,
        runId: input.runId,
        runtimeId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        issuedAt: yield* Clock.currentTimeMillis,
      });
    });

    const decodePreviewStatus = (input: ToolBrokerInput) =>
      Schema.decodeUnknownEffect(PreviewAutomationTabTargetInput)(input.arguments).pipe(
        Effect.mapError(() => new ToolArgumentsInvalidError(input)),
      );
    const decodePreviewOpen = (input: ToolBrokerInput) =>
      Schema.decodeUnknownEffect(PreviewAutomationOpenInput)(input.arguments).pipe(
        Effect.mapError(() => new ToolArgumentsInvalidError(input)),
      );
    const decodePreviewNavigate = (input: ToolBrokerInput) =>
      Schema.decodeUnknownEffect(PreviewAutomationNavigateInput)(input.arguments).pipe(
        Effect.mapError(() => new ToolArgumentsInvalidError(input)),
      );

    const withoutTabId = <A extends { readonly tabId?: PreviewTabId | undefined }>(input: A) => {
      const { tabId, ...operationInput } = input;
      return { tabId, operationInput };
    };

    const invokePreview = <A>(
      input: ToolBrokerInput,
      operation: PreviewAutomationBroker.PreviewAutomationInvokeInput["operation"],
      operationInput: unknown,
      tabId: PreviewTabId | undefined,
      timeoutMs?: number,
    ) =>
      Effect.gen(function* () {
        const scope = yield* previewScope(input);
        return yield* previewBroker.value.invoke<A>({
          scope,
          operation,
          input: operationInput,
          ...(tabId === undefined ? {} : { tabId }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      });

    handlers.set("preview_status", {
      operation: "read",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* decodePreviewStatus(input);
          const target = withoutTabId(args);
          return yield* invokePreview<PreviewAutomationStatus>(
            input,
            "status",
            target.operationInput,
            target.tabId,
          );
        }),
    });
    handlers.set("preview_open", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* decodePreviewOpen(input);
          const normalized = normalizePreviewOpenInput(args);
          const target = withoutTabId(normalized);
          return yield* invokePreview<PreviewAutomationStatus>(
            input,
            "open",
            target.operationInput,
            target.tabId,
          );
        }),
    });
    handlers.set("preview_navigate", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* decodePreviewNavigate(input);
          const target = withoutTabId(args);
          return yield* invokePreview<PreviewAutomationStatus>(
            input,
            "navigate",
            target.operationInput,
            target.tabId,
            args.timeoutMs,
          );
        }),
    });
    handlers.set("preview_snapshot", {
      operation: "read",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* decodePreviewStatus(input);
          const target = withoutTabId(args);
          return yield* invokePreview<PreviewAutomationSnapshot>(
            input,
            "snapshot",
            target.operationInput,
            target.tabId,
          );
        }),
    });
  }

  if (Option.isSome(ideSessionRegistry)) {
    handlers.set("ide.invoke", {
      operation: "execute",
      execute: (input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(IdeInvokeArguments)(input.arguments).pipe(
            Effect.mapError(() => new ToolArgumentsInvalidError(input)),
          );
          if (
            args.sessionId.trim().length === 0 ||
            args.handshakeId.trim().length === 0 ||
            args.operation.trim().length === 0
          ) {
            return yield* new ToolArgumentsInvalidError(input);
          }
          return yield* ideSessionRegistry.value.invoke({
            sessionId: args.sessionId,
            handshakeId: args.handshakeId,
            taskId: input.taskId,
            runId: input.runId,
            agentId: input.agentId,
            operation: args.operation,
            arguments: args.arguments,
          });
        }),
    });
  }

  const resultBase = (input: ToolBrokerInput, startedAtUnixMs: number) => ({
    invocationId: `invocation-${input.idempotencyKey}`,
    taskId: input.taskId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    canonicalToolName: input.canonicalToolName,
    startedAtUnixMs,
  });

  const invokeInternal = Effect.fn("ToolBroker.invokeInternal")(function* (input: ToolBrokerInput) {
    const startedAtUnixMs = yield* Clock.currentTimeMillis;
    const base = resultBase(input, startedAtUnixMs);

    if (policy.isCancelled(input.idempotencyKey)) {
      return {
        ...base,
        status: "cancelled" as const,
        errorCode: "tool_cancelled",
        finishedAtUnixMs: yield* Clock.currentTimeMillis,
      };
    }
    if (completed.has(input.idempotencyKey)) {
      return {
        ...base,
        status: "denied" as const,
        errorCode: "tool_duplicate_invocation",
        finishedAtUnixMs: yield* Clock.currentTimeMillis,
      };
    }

    const handler = handlers.get(input.canonicalToolName);
    const dynamicMcpDescriptor =
      handler === undefined && Option.isSome(mcpToolRegistry)
        ? yield* mcpToolRegistry.value.get(input.canonicalToolName)
        : undefined;
    const resolvedHandler =
      handler ??
      (dynamicMcpDescriptor === undefined || !Option.isSome(mcpToolRegistry)
        ? undefined
        : {
            operation: dynamicMcpDescriptor.operation,
            execute: (toolInput: ToolBrokerInput) =>
              mcpToolRegistry.value.invoke({
                canonicalToolName: dynamicMcpDescriptor.canonicalToolName,
                serverId: dynamicMcpDescriptor.serverId,
                toolName: dynamicMcpDescriptor.toolName,
                taskId: toolInput.taskId,
                runId: toolInput.runId,
                agentId: toolInput.agentId,
                workspaceRoot: toolInput.workspaceRoot,
                ...(toolInput.runtimeId === undefined ? {} : { runtimeId: toolInput.runtimeId }),
                idempotencyKey: toolInput.idempotencyKey,
                arguments: toolInput.arguments,
              }),
          });
    const known = yield* registry.list({ scope: "task", scopeId: input.taskId });
    if (
      resolvedHandler === undefined ||
      !known.some(
        (capability) =>
          capability.capabilityId === compositionToolCapabilityId(input.canonicalToolName),
      )
    ) {
      return {
        ...base,
        status: "denied" as const,
        errorCode: resolvedHandler === undefined ? "tool_unavailable" : "tool_not_registered",
        finishedAtUnixMs: yield* Clock.currentTimeMillis,
      };
    }

    const decision = yield* policy
      .evaluate({
        taskId: input.taskId,
        agentId: input.agentId,
        capabilityId: compositionToolCapabilityId(input.canonicalToolName),
        capabilityGrantIds: [...input.capabilityGrantIds],
        operation: resolvedHandler.operation,
        approvalRequestId: input.approvalRequestId,
      })
      .pipe(
        Effect.catchTags({
          CapabilityNotGrantedError: () =>
            Effect.succeed({ decision: "deny" as const, reasonCode: "capability_not_granted" }),
          CapabilityPolicyInvalidError: (error) =>
            Effect.succeed({ decision: "deny" as const, reasonCode: error.reason }),
        }),
      );

    if (decision.decision !== "allow") {
      const approvalRequestId =
        decision.decision === "approval_required" ? decision.approvalRequestId : undefined;
      return {
        ...base,
        status: "denied" as const,
        errorCode:
          decision.decision === "approval_required"
            ? "tool_approval_required"
            : decision.reasonCode,
        ...(approvalRequestId ? { approvalRequestId } : {}),
        finishedAtUnixMs: yield* Clock.currentTimeMillis,
      };
    }

    return yield* resolvedHandler.execute(input).pipe(
      Effect.flatMap((value) =>
        Effect.map(Clock.currentTimeMillis, (finishedAtUnixMs) => {
          completed.add(input.idempotencyKey);
          return {
            ...base,
            status: "succeeded" as const,
            result: value,
            finishedAtUnixMs,
          };
        }),
      ),
      Effect.catch((error) =>
        Effect.map(Clock.currentTimeMillis, (finishedAtUnixMs) => ({
          ...base,
          status: "failed" as const,
          errorCode: isToolArgumentsInvalidError(error)
            ? "tool_arguments_invalid"
            : isToolScopeMissingError(error)
              ? "tool_scope_missing"
              : isIdeSessionFailure(error)
                ? error.code
                : Schema.is(CompositionMcpToolRegistry.CompositionMcpToolTrustError)(error)
                  ? error.code
                  : Schema.is(CompositionMcpToolRegistry.CompositionMcpToolFailure)(error)
                    ? error.code
                    : "tool_execution_failed",
          finishedAtUnixMs,
        })),
      ),
    );
  });

  const invoke: ToolBroker["Service"]["invoke"] = (input) =>
    Effect.gen(function* () {
      const result = yield* invokeInternal(input).pipe(
        Effect.catch(() =>
          Effect.map(Clock.currentTimeMillis, (finishedAtUnixMs) => ({
            ...resultBase(input, finishedAtUnixMs),
            status: "failed" as const,
            errorCode: "tool_execution_failed",
            finishedAtUnixMs,
          })),
        ),
      );
      if (Option.isNone(grantRegistry)) return result;
      const operation =
        handlers.get(input.canonicalToolName)?.operation ??
        (Option.isSome(mcpToolRegistry)
          ? yield* mcpToolRegistry.value
              .get(input.canonicalToolName)
              .pipe(Effect.map((descriptor) => descriptor?.operation ?? "read"))
          : "read");
      const errorCode = "errorCode" in result ? result.errorCode : undefined;
      const outcome =
        result.status === "succeeded"
          ? "allowed"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "failed"
              ? "failed"
              : errorCode === "tool_approval_required"
                ? "approval_required"
                : "denied";
      const grantId = input.capabilityGrantIds[0] ?? `legacy:${input.canonicalToolName}`;
      yield* grantRegistry.value
        .recordAudit({
          grantId,
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          capabilityId: compositionToolCapabilityId(input.canonicalToolName),
          operation,
          outcome,
          ...(errorCode === undefined ? {} : { errorCode }),
        })
        .pipe(Effect.catch(() => Effect.void));
      return result;
    });

  const cancel: ToolBroker["Service"]["cancel"] = Effect.fn("ToolBroker.cancel")(function* (input) {
    yield* policy.cancel(input);
  });

  return ToolBroker.of({ invoke, cancel });
});

export const layer = Layer.effect(ToolBroker, make);
