import type {
  CompositionCapabilityDescriptor,
  CompositionCapabilityOperation,
  CompositionCapabilitySource,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const SECRET_KEY_PATTERN = /api[_-]?key|access[_-]?token|authorization|password|secret|token/i;
const SECRET_VALUE_PATTERNS = [
  /(api[_-]?key\s*[:=]\s*)([^\s\n]+)/gi,
  /(authorization\s*:\s*bearer\s+)([^\s\n]+)/gi,
  /(token\s*[:=]\s*)([^\s\n]+)/gi,
];

export type CompositionMcpToolStatus = "available" | "degraded" | "unavailable";

export type CompositionMcpToolInvocation = {
  readonly canonicalToolName: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly runtimeId?: string;
  readonly idempotencyKey?: string;
  readonly arguments: unknown;
};

export type CompositionMcpToolRegistration = {
  readonly serverId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly operation: CompositionCapabilityOperation;
  readonly trusted: boolean;
  readonly status?: CompositionMcpToolStatus;
  readonly source?: CompositionCapabilitySource;
  readonly timeoutMs?: number;
  readonly invoke: (input: CompositionMcpToolInvocation) => Effect.Effect<unknown, Error, never>;
};

export type CompositionMcpToolDescriptor = {
  readonly canonicalToolName: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly operation: CompositionCapabilityOperation;
  readonly trusted: boolean;
  readonly status: CompositionMcpToolStatus;
  readonly capabilityDescriptor: CompositionCapabilityDescriptor;
};

export class CompositionMcpToolRegistrationError extends Schema.TaggedErrorClass<CompositionMcpToolRegistrationError>()(
  "CompositionMcpToolRegistrationError",
  { code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `MCP 工具注册失败：${this.code}: ${this.detail}`;
  }
}

export class CompositionMcpToolTrustError extends Schema.TaggedErrorClass<CompositionMcpToolTrustError>()(
  "CompositionMcpToolTrustError",
  { canonicalToolName: Schema.String, code: Schema.String },
) {
  override get message(): string {
    return `MCP 工具未通过信任校验：${this.canonicalToolName}`;
  }
}

export class CompositionMcpToolFailure extends Schema.TaggedErrorClass<CompositionMcpToolFailure>()(
  "CompositionMcpToolFailure",
  { canonicalToolName: Schema.String, code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `MCP 工具执行失败：${this.canonicalToolName}: ${this.code}`;
  }
}

export type CompositionMcpToolRegistryOptions = {
  readonly maxPayloadBytes?: number;
  readonly maxResultBytes?: number;
};

export type CompositionMcpToolRegistryShape = {
  readonly register: (
    input: CompositionMcpToolRegistration,
  ) => Effect.Effect<void, CompositionMcpToolRegistrationError>;
  readonly unregister: (canonicalToolName: string) => Effect.Effect<boolean>;
  readonly get: (
    canonicalToolName: string,
  ) => Effect.Effect<CompositionMcpToolDescriptor | undefined>;
  readonly list: () => Effect.Effect<ReadonlyArray<CompositionMcpToolDescriptor>>;
  readonly listCapabilityDescriptors: () => Effect.Effect<
    ReadonlyArray<CompositionCapabilityDescriptor>
  >;
  readonly invoke: (
    input: CompositionMcpToolInvocation,
  ) => Effect.Effect<unknown, CompositionMcpToolFailure | CompositionMcpToolTrustError>;
};

export class CompositionMcpToolRegistry extends Context.Service<
  CompositionMcpToolRegistry,
  CompositionMcpToolRegistryShape
>()("codework/composition/CompositionMcpToolRegistry") {}

type StoredRegistration = CompositionMcpToolRegistration & {
  readonly canonicalToolName: string;
  readonly normalizedServerId: string;
  readonly normalizedToolName: string;
  readonly descriptor: CompositionMcpToolDescriptor;
};

const normalizeSegment = (
  value: string,
  field: "serverId" | "toolName",
): string | CompositionMcpToolRegistrationError => {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    return new CompositionMcpToolRegistrationError({
      code: "mcp_identifier_invalid",
      detail: `${field} must contain only letters, numbers, '.', '_' or '-'`,
    });
  }
  return normalized;
};

const jsonBytes = (value: unknown): Uint8Array | undefined => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : new TextEncoder().encode(encoded);
  } catch {
    return undefined;
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateJsonSchema = (inputSchema: unknown): string | undefined => {
  if (!isPlainRecord(inputSchema)) return "schema_must_be_an_object";
  if ("type" in inputSchema && typeof inputSchema.type !== "string") {
    return "schema_type_must_be_a_string";
  }
  if (typeof inputSchema.type === "string" && !JSON_SCHEMA_TYPES.has(inputSchema.type)) {
    return "schema_type_not_supported";
  }
  if ("properties" in inputSchema && !isPlainRecord(inputSchema.properties)) {
    return "schema_properties_must_be_an_object";
  }
  if (
    "required" in inputSchema &&
    (!Array.isArray(inputSchema.required) ||
      inputSchema.required.some((item) => typeof item !== "string"))
  ) {
    return "schema_required_must_be_a_string_array";
  }
  return undefined;
};

const validateJsonValue = (
  inputSchema: unknown,
  value: unknown,
  path = "$",
): string | undefined => {
  if (!isPlainRecord(inputSchema)) return "schema_must_be_an_object";
  if (Array.isArray(inputSchema.enum) && !inputSchema.enum.some((item) => Object.is(item, value))) {
    return `${path}_enum_invalid`;
  }
  const type = typeof inputSchema.type === "string" ? inputSchema.type : undefined;
  if (type !== undefined) {
    const validType =
      (type === "object" && isPlainRecord(value)) ||
      (type === "array" && Array.isArray(value)) ||
      (type === "string" && typeof value === "string") ||
      (type === "boolean" && typeof value === "boolean") ||
      (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "null" && value === null);
    if (!validType) return `${path}_type_invalid`;
  }
  if (typeof value === "string" && typeof inputSchema.minLength === "number") {
    if (value.length < inputSchema.minLength) return `${path}_min_length_invalid`;
  }
  if (Array.isArray(value) && inputSchema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const error = validateJsonValue(inputSchema.items, item, `${path}[${index}]`);
      if (error !== undefined) return error;
    }
  }
  if (isPlainRecord(value) && isPlainRecord(inputSchema.properties)) {
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    for (const key of required) {
      if (!(key in value)) return `${path}.${key}_required`;
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = inputSchema.properties[key];
      if (propertySchema === undefined) {
        if (inputSchema.additionalProperties === false) return `${path}.${key}_unknown`;
        continue;
      }
      const error = validateJsonValue(propertySchema, item, `${path}.${key}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};

const redactString = (value: string): string =>
  SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "$1[REDACTED]"),
    value,
  );

const sanitizeJsonValue = (value: unknown, seen: Set<object>): unknown => {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeJsonValue(item, seen);
  }
  return output;
};

const sanitizeResult = (
  value: unknown,
  maxResultBytes: number,
  canonicalToolName: string,
): Effect.Effect<unknown, CompositionMcpToolFailure> =>
  Effect.try({
    try: () => {
      const sanitized = sanitizeJsonValue(value, new Set());
      const bytes = jsonBytes(sanitized);
      if (bytes === undefined) {
        throw new Error("result is not JSON serializable");
      }
      if (bytes.byteLength <= maxResultBytes) return sanitized;
      return {
        truncated: true,
        content: new TextDecoder().decode(bytes.slice(0, maxResultBytes)),
      };
    },
    catch: () =>
      new CompositionMcpToolFailure({
        canonicalToolName,
        code: "mcp_result_invalid",
        detail: "result is not JSON serializable",
      }),
  });

const operationGrants = (operation: CompositionCapabilityOperation) => ({
  read: operation === "read",
  execute: operation === "execute",
  mutate: operation === "mutate",
});

const make = (options: CompositionMcpToolRegistryOptions = {}): CompositionMcpToolRegistryShape => {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const registrations = new Map<string, StoredRegistration>();

  const register: CompositionMcpToolRegistryShape["register"] = Effect.fn(
    "CompositionMcpToolRegistry.register",
  )(function* (input) {
    const serverId = normalizeSegment(input.serverId, "serverId");
    // @effect-diagnostics-next-line instanceOfSchema:off
    if (serverId instanceof CompositionMcpToolRegistrationError) return yield* serverId;
    const toolName = normalizeSegment(input.toolName, "toolName");
    // @effect-diagnostics-next-line instanceOfSchema:off
    if (toolName instanceof CompositionMcpToolRegistrationError) return yield* toolName;
    if (input.description.trim().length === 0) {
      return yield* new CompositionMcpToolRegistrationError({
        code: "mcp_description_invalid",
        detail: "description is required",
      });
    }
    if (input.description.length > 4096) {
      return yield* new CompositionMcpToolRegistrationError({
        code: "mcp_description_too_large",
        detail: "description exceeds the 4096 character limit",
      });
    }
    if (
      input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)
    ) {
      return yield* new CompositionMcpToolRegistrationError({
        code: "mcp_timeout_invalid",
        detail: "timeoutMs must be a positive integer",
      });
    }
    const schemaError = validateJsonSchema(input.inputSchema);
    const schemaBytes = jsonBytes(input.inputSchema);
    if (schemaError !== undefined || schemaBytes === undefined) {
      return yield* new CompositionMcpToolRegistrationError({
        code: "mcp_input_schema_invalid",
        detail: schemaError ?? "schema is not JSON serializable",
      });
    }
    if (schemaBytes.byteLength > maxPayloadBytes) {
      return yield* new CompositionMcpToolRegistrationError({
        code: "mcp_input_schema_too_large",
        detail: `schema exceeds ${maxPayloadBytes} bytes`,
      });
    }

    const canonicalToolName = `mcp.${serverId}.${toolName}`;
    if (registrations.has(canonicalToolName)) {
      return yield* new CompositionMcpToolRegistrationError({
        code: "mcp_tool_duplicate",
        detail: canonicalToolName,
      });
    }
    const status = input.trusted ? (input.status ?? "available") : "unavailable";
    const capabilityDescriptor = {
      capabilityId: `t3.${canonicalToolName}`,
      kind: "mcp",
      version: "1",
      status,
      grants: operationGrants(input.operation),
      approval: input.operation === "read" ? "never" : "on_first_use",
      source: input.source ?? "runtime",
    } satisfies CompositionCapabilityDescriptor;
    registrations.set(canonicalToolName, {
      ...input,
      canonicalToolName,
      normalizedServerId: serverId,
      normalizedToolName: toolName,
      descriptor: {
        canonicalToolName,
        serverId,
        toolName,
        description: input.description.trim(),
        inputSchema: structuredClone(input.inputSchema),
        operation: input.operation,
        trusted: input.trusted,
        status,
        capabilityDescriptor,
      },
    });
  });

  const list = (): Effect.Effect<ReadonlyArray<CompositionMcpToolDescriptor>> =>
    Effect.succeed(
      [...registrations.values()]
        .sort((left, right) => left.canonicalToolName.localeCompare(right.canonicalToolName))
        .map((registration) => ({
          ...registration.descriptor,
          capabilityDescriptor: {
            ...registration.descriptor.capabilityDescriptor,
            grants: { ...registration.descriptor.capabilityDescriptor.grants },
          },
        })),
    );

  const get: CompositionMcpToolRegistryShape["get"] = (canonicalToolName) =>
    Effect.succeed(registrations.get(canonicalToolName.trim())?.descriptor);

  const invoke: CompositionMcpToolRegistryShape["invoke"] = Effect.fn(
    "CompositionMcpToolRegistry.invoke",
  )(function* (input) {
    const registration = registrations.get(input.canonicalToolName.trim());
    if (registration === undefined) {
      return yield* new CompositionMcpToolFailure({
        canonicalToolName: input.canonicalToolName,
        code: "mcp_tool_unavailable",
        detail: "tool is not registered",
      });
    }
    if (!registration.trusted || registration.descriptor.status === "unavailable") {
      return yield* new CompositionMcpToolTrustError({
        canonicalToolName: registration.canonicalToolName,
        code: "mcp_tool_untrusted",
      });
    }
    const argumentBytes = jsonBytes(input.arguments);
    if (argumentBytes === undefined || argumentBytes.byteLength > maxPayloadBytes) {
      return yield* new CompositionMcpToolFailure({
        canonicalToolName: registration.canonicalToolName,
        code: "mcp_payload_too_large",
        detail: `arguments exceed ${maxPayloadBytes} bytes or are not JSON serializable`,
      });
    }
    const argumentError = validateJsonValue(registration.inputSchema, input.arguments);
    if (argumentError !== undefined) {
      return yield* new CompositionMcpToolFailure({
        canonicalToolName: registration.canonicalToolName,
        code: "mcp_arguments_invalid",
        detail: argumentError,
      });
    }
    const timed = yield* registration
      .invoke({
        ...input,
        canonicalToolName: registration.canonicalToolName,
        serverId: registration.normalizedServerId,
        toolName: registration.normalizedToolName,
      })
      .pipe(
        Effect.timeoutOption(Duration.millis(registration.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
        Effect.catch((error) =>
          Schema.is(CompositionMcpToolFailure)(error)
            ? Effect.fail(error)
            : Effect.fail(
                new CompositionMcpToolFailure({
                  canonicalToolName: registration.canonicalToolName,
                  code: "mcp_invocation_failed",
                  detail: error instanceof Error ? error.message : String(error),
                }),
              ),
        ),
      );
    if (Option.isNone(timed)) {
      return yield* new CompositionMcpToolFailure({
        canonicalToolName: registration.canonicalToolName,
        code: "mcp_timeout",
        detail: `tool exceeded ${registration.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      });
    }
    const value = timed.value;
    return yield* sanitizeResult(value, maxResultBytes, registration.canonicalToolName);
  });

  return {
    register,
    unregister: (canonicalToolName) =>
      Effect.succeed(registrations.delete(canonicalToolName.trim())),
    get,
    list,
    listCapabilityDescriptors: () =>
      list().pipe(Effect.map((items) => items.map((item) => item.capabilityDescriptor))),
    invoke,
  };
};

export const makeCompositionMcpToolRegistry = (
  options: CompositionMcpToolRegistryOptions = {},
): CompositionMcpToolRegistryShape => make(options);

export const layer = Layer.effect(
  CompositionMcpToolRegistry,
  Effect.sync(() => makeCompositionMcpToolRegistry()),
);
