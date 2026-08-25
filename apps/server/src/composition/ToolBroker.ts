import type {
  CompositionToolResult,
  ProjectReadFileResult,
  ProjectWriteFileResult,
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

const make = Effect.gen(function* () {
  const policy = yield* CapabilityPolicy.CapabilityPolicy;
  const registry = yield* CapabilityRegistry.CapabilityRegistry;
  const grantRegistry = yield* Effect.serviceOption(
    CapabilityGrantRegistry.CapabilityGrantRegistry,
  );
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const completed = new Set<string>();

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

    const known = yield* registry.list({ scope: "task", scopeId: input.taskId });
    if (!known.some((capability) => capability.capabilityId === `t3.${input.canonicalToolName}`)) {
      return {
        ...base,
        status: "denied" as const,
        errorCode: "tool_not_registered",
        finishedAtUnixMs: yield* Clock.currentTimeMillis,
      };
    }

    const decision = yield* policy
      .evaluate({
        taskId: input.taskId,
        agentId: input.agentId,
        capabilityId: `t3.${input.canonicalToolName}`,
        capabilityGrantIds: [...input.capabilityGrantIds],
        operation: input.canonicalToolName === "workspace.write_file" ? "mutate" : "read",
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

    return yield* Effect.gen(function* () {
      if (input.canonicalToolName === "workspace.read_file") {
        const args = yield* Schema.decodeUnknownEffect(WorkspaceReadArguments)(
          input.arguments,
        ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
        if (args.cwd !== input.workspaceRoot) {
          return yield* new ToolArgumentsInvalidError(input);
        }
        const value = limitReadResult(yield* workspaceFileSystem.readFile(args));
        completed.add(input.idempotencyKey);
        return {
          ...base,
          status: "succeeded" as const,
          result: value,
          finishedAtUnixMs: yield* Clock.currentTimeMillis,
        };
      }
      if (input.canonicalToolName === "workspace.write_file") {
        const args = yield* Schema.decodeUnknownEffect(WorkspaceWriteArguments)(
          input.arguments,
        ).pipe(Effect.mapError(() => new ToolArgumentsInvalidError(input)));
        if (args.cwd !== input.workspaceRoot) {
          return yield* new ToolArgumentsInvalidError(input);
        }
        const value = yield* workspaceFileSystem.writeFile(args);
        completed.add(input.idempotencyKey);
        return {
          ...base,
          status: "succeeded" as const,
          result: value,
          finishedAtUnixMs: yield* Clock.currentTimeMillis,
        };
      }
      return yield* new ToolNotRegisteredError({ canonicalToolName: input.canonicalToolName });
    }).pipe(
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
      const operation = input.canonicalToolName === "workspace.write_file" ? "mutate" : "read";
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
          capabilityId: `t3.${input.canonicalToolName}`,
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
