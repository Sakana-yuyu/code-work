import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MulticaDaemonProtocolFailure extends Schema.TaggedErrorClass<MulticaDaemonProtocolFailure>()(
  "MulticaDaemonProtocolFailure",
  {
    operation: Schema.String,
    code: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    const suffix = this.status === undefined ? "" : `（HTTP ${this.status}）`;
    return `Multica daemon 协议操作失败：${this.operation}${suffix}：${this.detail}`;
  }
}

export type MulticaHttpMethod = "GET" | "POST";

export type MulticaHttpRequest = {
  readonly method: MulticaHttpMethod;
  readonly path: string;
  readonly url?: string;
  readonly body?: unknown;
};

export type MulticaHttpResponse<T> = {
  readonly status: number;
  readonly body: T;
};

export interface MulticaHttpTransport {
  readonly request: <T>(
    request: MulticaHttpRequest,
  ) => Effect.Effect<MulticaHttpResponse<T>, MulticaDaemonProtocolFailure>;
}

type MulticaRuntimeRegistration = {
  readonly name: string;
  readonly type: string;
  readonly version: string;
  readonly status: string;
  readonly profileId?: string;
};

export type MulticaRegisterRequest = {
  readonly workspaceId: string;
  readonly daemonId: string;
  readonly legacyDaemonIds?: ReadonlyArray<string>;
  readonly deviceName: string;
  readonly cliVersion: string;
  readonly launchedBy: string;
  readonly runtimes: ReadonlyArray<MulticaRuntimeRegistration>;
  readonly failedProfiles?: ReadonlyArray<{
    readonly profileId: string;
    readonly commandName: string;
    readonly reason: string;
  }>;
};

export type MulticaRegisteredRuntime = {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly status: string;
  readonly profileId?: string;
};

export type MulticaRegisterResponse = {
  readonly runtimes: ReadonlyArray<MulticaRegisteredRuntime>;
  readonly repos?: ReadonlyArray<unknown>;
  readonly reposVersion?: string;
  readonly settings?: unknown;
};

export type MulticaHeartbeatResponse = {
  readonly runtimeId: string;
  readonly status: string;
  readonly serverCapabilities: ReadonlyArray<string>;
  readonly runtimeGone: boolean;
  readonly pendingUpdate?: unknown;
  readonly pendingModelList?: unknown;
  readonly pendingLocalSkills?: unknown;
  readonly pendingLocalSkillImport?: unknown;
  readonly pendingLocalSkillImports?: ReadonlyArray<unknown>;
};

export type MulticaTask = {
  readonly id: string;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly status: string;
  readonly issueId?: string;
  readonly workspaceId?: string;
  readonly agent?: unknown;
  readonly [key: string]: unknown;
};

export type MulticaTaskStatusResponse = {
  readonly status: string;
};

export type MulticaTaskProgressInput = {
  readonly summary: string;
  readonly step: number;
  readonly total: number;
};

export type MulticaTaskCompleteInput = {
  readonly output: string;
  readonly branchName?: string;
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly durableWorkDir?: string;
  readonly sessionRolloutMissing?: boolean;
  readonly retiredSessionId?: string;
};

export type MulticaTaskFailInput = {
  readonly error: string;
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly durableWorkDir?: string;
  readonly branchName?: string;
  readonly failureReason?: string;
  readonly sessionRolloutMissing?: boolean;
  readonly retiredSessionId?: string;
};

export type MulticaTaskCancelAckInput = {
  readonly branchName?: string;
  readonly durableWorkDir?: string;
  readonly errorMessage?: string;
  readonly failureReason?: string;
};

export type MulticaWebSocketFrame = {
  readonly type: string;
  readonly payload: unknown;
};

export const MulticaDaemonCapability = {
  rpcV1: "rpc-v1",
} as const;

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJson = Schema.encodeUnknownSync(UnknownJson);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const isMulticaDaemonProtocolFailure = Schema.is(MulticaDaemonProtocolFailure);

const trimRequired = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} 不能为空。`);
  return trimmed;
};

const encodePathSegment = (value: string, field: string): string =>
  encodeURIComponent(trimRequired(value, field));

const withOptional = (
  body: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => {
  if (value !== undefined) body[key] = value;
  return body;
};

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) throw new Error("Multica baseUrl 不能为空。");
  return trimmed.replace(/\/+$/, "");
};

const bodyFromRegisterRequest = (input: MulticaRegisterRequest): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    workspace_id: trimRequired(input.workspaceId, "workspaceId"),
    daemon_id: trimRequired(input.daemonId, "daemonId"),
    device_name: input.deviceName,
    cli_version: input.cliVersion,
    launched_by: input.launchedBy,
    runtimes: input.runtimes.map((runtime) => ({
      name: runtime.name,
      type: runtime.type,
      version: runtime.version,
      status: runtime.status,
      ...(runtime.profileId === undefined ? {} : { profile_id: runtime.profileId }),
    })),
    failed_profiles: (input.failedProfiles ?? []).map((profile) => ({
      profile_id: profile.profileId,
      command_name: profile.commandName,
      reason: profile.reason,
    })),
  };
  withOptional(body, "legacy_daemon_ids", input.legacyDaemonIds);
  return body;
};

const bodyFromCompleteInput = (input: MulticaTaskCompleteInput): Record<string, unknown> => {
  const body = withOptional({ output: input.output }, "branch_name", input.branchName);
  withOptional(body, "session_id", input.sessionId);
  withOptional(body, "work_dir", input.workDir);
  withOptional(body, "durable_work_dir", input.durableWorkDir);
  withOptional(
    body,
    "session_rollout_missing",
    input.sessionRolloutMissing === true ? true : undefined,
  );
  withOptional(body, "retired_session_id", input.retiredSessionId);
  return body;
};

const bodyFromFailInput = (input: MulticaTaskFailInput): Record<string, unknown> => {
  const body = withOptional({ error: input.error }, "session_id", input.sessionId);
  withOptional(body, "work_dir", input.workDir);
  withOptional(body, "durable_work_dir", input.durableWorkDir);
  withOptional(body, "branch_name", input.branchName);
  withOptional(body, "failure_reason", input.failureReason);
  withOptional(
    body,
    "session_rollout_missing",
    input.sessionRolloutMissing === true ? true : undefined,
  );
  withOptional(body, "retired_session_id", input.retiredSessionId);
  return body;
};

const bodyFromCancelAckInput = (input: MulticaTaskCancelAckInput): Record<string, unknown> => {
  const body = withOptional({}, "branch_name", input.branchName);
  withOptional(body, "durable_work_dir", input.durableWorkDir);
  withOptional(body, "error_message", input.errorMessage);
  withOptional(body, "failure_reason", input.failureReason);
  return body;
};

const normalizeHeartbeatResponse = (body: unknown): MulticaHeartbeatResponse => {
  if (typeof body !== "object" || body === null) {
    throw new Error("heartbeat 响应必须是对象。");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.runtime_id !== "string" || typeof record.status !== "string") {
    throw new Error("heartbeat 响应缺少 runtime_id 或 status。");
  }
  const capabilities = record.server_capabilities;
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    throw new Error("heartbeat.server_capabilities 必须是数组。");
  }
  return {
    runtimeId: record.runtime_id,
    status: record.status,
    serverCapabilities: (capabilities ?? []).filter(
      (capability): capability is string => typeof capability === "string",
    ),
    runtimeGone: record.runtime_gone === true,
    ...(record.pending_update === undefined ? {} : { pendingUpdate: record.pending_update }),
    ...(record.pending_model_list === undefined
      ? {}
      : { pendingModelList: record.pending_model_list }),
    ...(record.pending_local_skills === undefined
      ? {}
      : { pendingLocalSkills: record.pending_local_skills }),
    ...(record.pending_local_skill_import === undefined
      ? {}
      : { pendingLocalSkillImport: record.pending_local_skill_import }),
    ...(Array.isArray(record.pending_local_skill_imports)
      ? { pendingLocalSkillImports: record.pending_local_skill_imports }
      : {}),
  };
};

const normalizeTask = (body: unknown): MulticaTask | null => {
  if (typeof body !== "object" || body === null) {
    throw new Error("task 响应必须是对象或 null。");
  }
  const record = body as Record<string, unknown>;
  if (record.task === null) return null;
  const task = (record.task ?? body) as Record<string, unknown>;
  if (
    typeof task.id !== "string" ||
    typeof task.agent_id !== "string" ||
    typeof task.runtime_id !== "string" ||
    typeof task.status !== "string"
  ) {
    throw new Error("task 响应缺少 id、agent_id、runtime_id 或 status。");
  }
  const normalized: Record<string, unknown> = {
    ...task,
    id: task.id,
    agentId: task.agent_id,
    runtimeId: task.runtime_id,
    status: task.status,
  };
  delete normalized.agent_id;
  delete normalized.runtime_id;
  if (typeof task.issue_id === "string") normalized.issueId = task.issue_id;
  if (typeof task.workspace_id === "string") normalized.workspaceId = task.workspace_id;
  delete normalized.issue_id;
  delete normalized.workspace_id;
  return normalized as MulticaTask;
};

const normalizeRegisterResponse = (body: unknown): MulticaRegisterResponse => {
  if (typeof body !== "object" || body === null) {
    throw new Error("register 响应必须是对象。");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.runtimes)) throw new Error("register 响应缺少 runtimes 数组。");
  const runtimes = record.runtimes.map((runtime) => {
    if (typeof runtime !== "object" || runtime === null) {
      throw new Error("register.runtimes 包含无效项。");
    }
    const item = runtime as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.provider !== "string" ||
      typeof item.status !== "string"
    ) {
      throw new Error("register runtime 缺少 id、name、provider 或 status。");
    }
    return {
      id: item.id,
      name: item.name,
      provider: item.provider,
      status: item.status,
      ...(typeof item.profile_id === "string" ? { profileId: item.profile_id } : {}),
    };
  });
  return {
    runtimes,
    ...(Array.isArray(record.repos) ? { repos: record.repos } : {}),
    ...(typeof record.repos_version === "string" ? { reposVersion: record.repos_version } : {}),
    ...(record.settings === undefined ? {} : { settings: record.settings }),
  };
};

const normalizeTaskStatusResponse = (body: unknown): MulticaTaskStatusResponse => {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { status?: unknown }).status !== "string"
  ) {
    throw new Error("task status 响应缺少 status。");
  }
  return { status: (body as { status: string }).status };
};

export type MulticaDaemonProtocol = {
  readonly register: (
    input: MulticaRegisterRequest,
  ) => Effect.Effect<MulticaRegisterResponse, MulticaDaemonProtocolFailure>;
  readonly heartbeat: (
    runtimeId: string,
  ) => Effect.Effect<MulticaHeartbeatResponse, MulticaDaemonProtocolFailure>;
  readonly claimTask: (
    runtimeId: string,
  ) => Effect.Effect<MulticaTask | null, MulticaDaemonProtocolFailure>;
  readonly startTask: (taskId: string) => Effect.Effect<void, MulticaDaemonProtocolFailure>;
  readonly reportProgress: (
    taskId: string,
    input: MulticaTaskProgressInput,
  ) => Effect.Effect<void, MulticaDaemonProtocolFailure>;
  readonly completeTask: (
    taskId: string,
    input: MulticaTaskCompleteInput,
  ) => Effect.Effect<void, MulticaDaemonProtocolFailure>;
  readonly failTask: (
    taskId: string,
    input: MulticaTaskFailInput,
  ) => Effect.Effect<void, MulticaDaemonProtocolFailure>;
  readonly acknowledgeCancellation: (
    taskId: string,
    input: MulticaTaskCancelAckInput,
  ) => Effect.Effect<void, MulticaDaemonProtocolFailure>;
  readonly getTaskStatus: (
    taskId: string,
  ) => Effect.Effect<MulticaTaskStatusResponse, MulticaDaemonProtocolFailure>;
};

export type MulticaDaemonProtocolOptions = {
  readonly baseUrl: string;
  readonly transport: MulticaHttpTransport;
};

export const makeMulticaDaemonProtocol = (
  options: MulticaDaemonProtocolOptions,
): MulticaDaemonProtocol => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  const request = <T>(
    operation: string,
    method: MulticaHttpMethod,
    path: string,
    body?: unknown,
    normalize?: (value: unknown) => T,
  ): Effect.Effect<T, MulticaDaemonProtocolFailure> =>
    options.transport
      .request<unknown>({
        method,
        path,
        url: `${baseUrl}${path}`,
        ...(body === undefined ? {} : { body }),
      })
      .pipe(
        Effect.flatMap((response) => {
          if (response.status < 200 || response.status >= 300) {
            const detail =
              typeof response.body === "object" && response.body !== null
                ? encodeUnknownJson(response.body)
                : String(response.body);
            return Effect.fail(
              new MulticaDaemonProtocolFailure({
                operation,
                code: "http_error",
                status: response.status,
                detail,
              }),
            );
          }
          try {
            return Effect.succeed(
              normalize === undefined ? (response.body as T) : normalize(response.body),
            );
          } catch (cause) {
            return Effect.fail(
              new MulticaDaemonProtocolFailure({
                operation,
                code: "invalid_response",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
            );
          }
        }),
        Effect.mapError((failure) =>
          isMulticaDaemonProtocolFailure(failure)
            ? failure
            : new MulticaDaemonProtocolFailure({
                operation,
                code: "transport_error",
                detail: String(failure),
              }),
        ),
      );

  const noContent = (operation: string, method: MulticaHttpMethod, path: string, body?: unknown) =>
    request(operation, method, path, body, () => undefined).pipe(Effect.asVoid);

  return {
    register: (input) =>
      request(
        "register",
        "POST",
        "/api/daemon/register",
        bodyFromRegisterRequest(input),
        normalizeRegisterResponse,
      ),
    heartbeat: (runtimeId) =>
      request(
        "heartbeat",
        "POST",
        "/api/daemon/heartbeat",
        { runtime_id: trimRequired(runtimeId, "runtimeId"), supports_batch_import: true },
        normalizeHeartbeatResponse,
      ),
    claimTask: (runtimeId) =>
      request(
        "claimTask",
        "POST",
        `/api/daemon/runtimes/${encodePathSegment(runtimeId, "runtimeId")}/tasks/claim`,
        {},
        normalizeTask,
      ),
    startTask: (taskId) =>
      noContent(
        "startTask",
        "POST",
        `/api/daemon/tasks/${encodePathSegment(taskId, "taskId")}/start`,
        {},
      ),
    reportProgress: (taskId, input) =>
      noContent(
        "reportProgress",
        "POST",
        `/api/daemon/tasks/${encodePathSegment(taskId, "taskId")}/progress`,
        { summary: input.summary, step: input.step, total: input.total },
      ),
    completeTask: (taskId, input) =>
      noContent(
        "completeTask",
        "POST",
        `/api/daemon/tasks/${encodePathSegment(taskId, "taskId")}/complete`,
        bodyFromCompleteInput(input),
      ),
    failTask: (taskId, input) =>
      noContent(
        "failTask",
        "POST",
        `/api/daemon/tasks/${encodePathSegment(taskId, "taskId")}/fail`,
        bodyFromFailInput(input),
      ),
    acknowledgeCancellation: (taskId, input) =>
      noContent(
        "acknowledgeCancellation",
        "POST",
        `/api/daemon/tasks/${encodePathSegment(taskId, "taskId")}/cancel-ack`,
        bodyFromCancelAckInput(input),
      ),
    getTaskStatus: (taskId) =>
      request(
        "getTaskStatus",
        "GET",
        `/api/daemon/tasks/${encodePathSegment(taskId, "taskId")}/status`,
        undefined,
        normalizeTaskStatusResponse,
      ),
  };
};

export type MulticaFetchHttpTransportOptions = {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
};

export const makeMulticaFetchHttpTransport = (
  options: MulticaFetchHttpTransportOptions,
): MulticaHttpTransport => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前运行时没有可用的 fetch 实现。");

  return {
    request: <T>(request: MulticaHttpRequest) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(`${baseUrl}${request.path}`, {
            method: request.method,
            headers: {
              accept: "application/json",
              ...(request.body === undefined ? {} : { "content-type": "application/json" }),
              ...options.headers,
            },
            ...(request.body === undefined ? {} : { body: encodeUnknownJson(request.body) }),
          });
          const text = await response.text();
          if (text.trim().length === 0) return { status: response.status, body: undefined as T };
          try {
            return { status: response.status, body: decodeUnknownJson(text) as T };
          } catch (cause) {
            throw new MulticaDaemonProtocolFailure({
              operation: `${request.method} ${request.path}`,
              code: "invalid_json",
              status: response.status,
              detail: cause instanceof Error ? cause.message : String(cause),
            });
          }
        },
        catch: (cause) =>
          isMulticaDaemonProtocolFailure(cause)
            ? cause
            : new MulticaDaemonProtocolFailure({
                operation: `${request.method} ${request.path}`,
                code: "transport_error",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
      }),
  };
};

export const encodeMulticaWebSocketFrame = (frame: MulticaWebSocketFrame): string => {
  const type = trimRequired(frame.type, "frame.type");
  return encodeUnknownJson({ type, payload: frame.payload });
};

export const decodeMulticaWebSocketFrame = (input: string | Uint8Array): MulticaWebSocketFrame => {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const value: unknown = decodeUnknownJson(text);
  if (typeof value !== "object" || value === null) throw new Error("WebSocket frame 必须是对象。");
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.trim().length === 0) {
    throw new Error("WebSocket frame.type 不能为空。");
  }
  return { type: record.type, payload: record.payload };
};
