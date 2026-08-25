import type {
  CompositionToolResult,
  ProjectReadFileResult,
  ProjectWriteFileResult,
  ReviewDiffPreviewInput,
  TerminalOpenInput,
  TerminalWriteInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { compositionToolCapabilityId } from "./CompositionToolRegistry.ts";

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

const GitStatusArguments = Schema.Struct({ cwd: Schema.String });

const GitDiffArguments = Schema.Struct({
  cwd: Schema.String,
  baseRef: Schema.optional(Schema.String),
  ignoreWhitespace: Schema.optional(Schema.Boolean),
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

const isToolArgumentsInvalidError = Schema.is(ToolArgumentsInvalidError);
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
            threadId: input.taskId,
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
            threadId: input.taskId,
            terminalId: args.terminalId,
            data: args.data,
          };
          yield* terminalManager.value.write(terminalInput);
          return { threadId: input.taskId, terminalId: args.terminalId, accepted: true };
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
    const known = yield* registry.list({ scope: "task", scopeId: input.taskId });
    if (
      handler === undefined ||
      !known.some(
        (capability) =>
          capability.capabilityId === compositionToolCapabilityId(input.canonicalToolName),
      )
    ) {
      return {
        ...base,
        status: "denied" as const,
        errorCode: handler === undefined ? "tool_unavailable" : "tool_not_registered",
        finishedAtUnixMs: yield* Clock.currentTimeMillis,
      };
    }

    const decision = yield* policy
      .evaluate({
        taskId: input.taskId,
        agentId: input.agentId,
        capabilityId: compositionToolCapabilityId(input.canonicalToolName),
        capabilityGrantIds: [...input.capabilityGrantIds],
        operation: handler.operation,
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

    return yield* handler.execute(input).pipe(
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
      const operation = handlers.get(input.canonicalToolName)?.operation ?? "read";
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
