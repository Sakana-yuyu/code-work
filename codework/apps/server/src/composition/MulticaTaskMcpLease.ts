import { randomBytes } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CompositionRuntimeCapabilityHandshakeRequest } from "@codework/contracts";

import type {
  CompositionRuntimeMcpBinding,
  CompositionRuntimeMcpSessionRegistryShape,
} from "../mcp/CompositionRuntimeMcpSessionRegistry.ts";

export type MulticaTaskMcpLeaseRequest = CompositionRuntimeCapabilityHandshakeRequest & {
  readonly endpoint: string;
  readonly expiresAtUnixMs: number;
};

export type MulticaTaskMcpLease = MulticaTaskMcpLeaseRequest & {
  readonly capabilityHandshakeId: string;
  /** 只供 claim/start 注入层读取，不写入配置、日志或审计正文。 */
  readonly rawToken: string;
  readonly binding: CompositionRuntimeMcpBinding;
  readonly mcpConfig: {
    readonly mcpServers: {
      readonly "t3-composition-runtime": {
        readonly type: "http";
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
      };
    };
  };
};

export class MulticaTaskMcpLeaseError extends Schema.TaggedErrorClass<MulticaTaskMcpLeaseError>()(
  "MulticaTaskMcpLeaseError",
  { code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Multica 每 Run MCP Lease 失败：${this.code}：${this.detail}`;
  }
}

export type MulticaTaskMcpLeaseStore = {
  readonly issue: (
    input: MulticaTaskMcpLeaseRequest,
  ) => Effect.Effect<MulticaTaskMcpLease, MulticaTaskMcpLeaseError>;
  readonly get: (capabilityHandshakeId: string) => Effect.Effect<MulticaTaskMcpLease | undefined>;
  readonly revokeHandshake: (capabilityHandshakeId: string) => Effect.Effect<void>;
  readonly revokeRuntime: (runtimeId: string) => Effect.Effect<void>;
};

type Options = {
  readonly registry: Pick<
    CompositionRuntimeMcpSessionRegistryShape,
    "activate" | "revokeHandshake" | "revokeRuntime"
  >;
  readonly tokenFactory?: () => string;
  readonly now?: () => number;
};

const nonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} 不能为空。`);
  return trimmed;
};

const makeToken = (): string => `t3mcp_${randomBytes(32).toString("base64url")}`;

const normalizeEndpoint = (value: string): string => {
  const endpoint = nonEmpty(value, "endpoint").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error("endpoint 必须是 HTTP 或 HTTPS URL。");
  }
  return endpoint;
};

export const makeMulticaTaskMcpLeaseStore = (options: Options): MulticaTaskMcpLeaseStore => {
  const leases = new Map<string, MulticaTaskMcpLease>();
  const tokenFactory = options.tokenFactory ?? makeToken;
  const now = options.now ?? Date.now;

  const issue: MulticaTaskMcpLeaseStore["issue"] = (input) =>
    Effect.gen(function* () {
      const normalized = yield* Effect.try({
        try: () => ({
          runtimeId: nonEmpty(input.runtimeId, "runtimeId"),
          taskId: nonEmpty(input.taskId, "taskId"),
          runId: nonEmpty(input.runId, "runId"),
          agentId: nonEmpty(input.agentId, "agentId"),
          endpoint: normalizeEndpoint(input.endpoint),
          rawToken: nonEmpty(tokenFactory(), "token"),
        }),
        catch: (cause) =>
          new MulticaTaskMcpLeaseError({
            code: "invalid_input",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      if (input.expiresAtUnixMs <= now()) {
        return yield* new MulticaTaskMcpLeaseError({
          code: "lease_expired",
          detail: "Lease 过期时间必须晚于当前时间。",
        });
      }
      const binding = yield* options.registry
        .activate({
          rawToken: normalized.rawToken,
          runtimeId: normalized.runtimeId,
          taskId: normalized.taskId,
          runId: normalized.runId,
          agentId: normalized.agentId,
          capabilityGrantIds: input.capabilityGrantIds,
          expiresAtUnixMs: input.expiresAtUnixMs,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MulticaTaskMcpLeaseError({
                code: cause.code,
                detail: "MCP credential 无法绑定到当前 Task/Run/Agent。",
              }),
          ),
        );
      const lease: MulticaTaskMcpLease = {
        ...input,
        runtimeId: normalized.runtimeId,
        taskId: normalized.taskId,
        runId: normalized.runId,
        agentId: normalized.agentId,
        endpoint: normalized.endpoint,
        capabilityHandshakeId: binding.capabilityHandshakeId,
        rawToken: normalized.rawToken,
        binding,
        mcpConfig: {
          mcpServers: {
            "t3-composition-runtime": {
              type: "http",
              url: normalized.endpoint,
              headers: { Authorization: `Bearer ${normalized.rawToken}` },
            },
          },
        },
      };
      leases.set(binding.capabilityHandshakeId, lease);
      return lease;
    });

  return {
    issue,
    get: (capabilityHandshakeId) => Effect.sync(() => leases.get(capabilityHandshakeId.trim())),
    revokeHandshake: (capabilityHandshakeId) =>
      options.registry
        .revokeHandshake(capabilityHandshakeId)
        .pipe(Effect.ensuring(Effect.sync(() => leases.delete(capabilityHandshakeId)))),
    revokeRuntime: (runtimeId) =>
      options.registry.revokeRuntime(runtimeId).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const [handshakeId, lease] of leases) {
              if (lease.runtimeId === runtimeId) leases.delete(handshakeId);
            }
          }),
        ),
      ),
  };
};
