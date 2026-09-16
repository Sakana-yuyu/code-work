import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * 远程服务器（SSH 管理主机）的持久化配置。
 *
 * 与 environment/「连接」是两个概念：environment 是会说 Code Work RPC 的完整服务端，
 * 这里的 SSH 服务器只是被管理的裸主机（IP + 账号 + 密码）。配置进 settings.json，
 * 密码只落在服务端 secret store，对外回传时脱敏。
 */
const SSH_SERVER_ID_MAX_CHARS = 64;
const SSH_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const SshServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SSH_SERVER_ID_MAX_CHARS),
  Schema.isPattern(SSH_SERVER_ID_PATTERN),
).pipe(Schema.brand("SshServerId"));
export type SshServerId = typeof SshServerId.Type;

const SshPort = Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(65_535));

/** 主机指纹（sha256 base64，不含前缀）。首连记录，变更时拒绝连接以拦截中间人。 */
export const SshHostFingerprint = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SshHostFingerprint"),
);
export type SshHostFingerprint = typeof SshHostFingerprint.Type;

export const SshServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  hostname: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  port: SshPort.pipe(Schema.withDecodingDefault(Effect.succeed(22))),
  username: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** 明文只存在于写入 settings patch 的一次性旅程中；持久化后为 ""。 */
  password: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** true 表示密码已在 secret store 里，客户端空值提交表示"保留已存密码"。 */
  passwordRedacted: Schema.optionalKey(Schema.Boolean),
  knownHostFingerprint: Schema.optionalKey(SshHostFingerprint),
  createdAt: Schema.String.check(Schema.isNonEmpty()),
});
export type SshServerConfig = typeof SshServerConfig.Type;

export const SshServerStatus = Schema.Struct({
  serverId: SshServerId,
  online: Schema.Boolean,
  os: Schema.optional(TrimmedString),
  uptimeSeconds: Schema.optional(NonNegativeInt),
  loadAvg: Schema.optional(
    Schema.Array(Schema.Number).check(Schema.isMinLength(1)).check(Schema.isMaxLength(3)),
  ),
  cpuPercent: Schema.optional(Schema.Number),
  memoryUsedMb: Schema.optional(NonNegativeInt),
  memoryTotalMb: Schema.optional(NonNegativeInt),
  diskUsedGb: Schema.optional(Schema.Number),
  diskTotalGb: Schema.optional(Schema.Number),
  error: Schema.optional(TrimmedString),
});
export type SshServerStatus = typeof SshServerStatus.Type;

export const SshServerFileEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** 以 `/` 结尾的绝对路径约定与本地 workspace entries 一致：目录带尾斜杠。 */
  path: TrimmedNonEmptyString,
  isDirectory: Schema.Boolean,
  sizeBytes: Schema.optional(NonNegativeInt),
  modifiedAt: Schema.optional(Schema.String),
});
export type SshServerFileEntry = typeof SshServerFileEntry.Type;

/** 保存前用表单里的临时凭据直连验证；密码不落库。 */
export const SshTestConnectionInput = Schema.Struct({
  hostname: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  port: SshPort,
  username: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  password: Schema.String,
  /** 跳过已知指纹比对（重置指纹后的重新确认）。 */
  expectFingerprint: Schema.optional(SshHostFingerprint),
});
export type SshTestConnectionInput = typeof SshTestConnectionInput.Type;

export const SshTestConnectionResult = Schema.Struct({
  ok: Schema.Boolean,
  os: Schema.optional(TrimmedString),
  fingerprint: SshHostFingerprint,
  error: Schema.optional(TrimmedString),
});
export type SshTestConnectionResult = typeof SshTestConnectionResult.Type;

export const SshServerTarget = Schema.Struct({
  serverId: SshServerId,
});
export type SshServerTarget = typeof SshServerTarget.Type;

/** 绝对路径（POSIX：远程主机按 Linux 优先对待）。 */
const SshAbsolutePath = TrimmedNonEmptyString.check(Schema.isPattern(/^\/[^\\]*$/)).check(
  Schema.isMaxLength(4_096),
);

export const SshListFilesInput = Schema.Struct({
  ...SshServerTarget.fields,
  path: SshAbsolutePath,
});
export type SshListFilesInput = typeof SshListFilesInput.Type;

export const SshListFilesResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  entries: Schema.Array(SshServerFileEntry),
});
export type SshListFilesResult = typeof SshListFilesResult.Type;

export const SshReadFileInput = Schema.Struct({
  ...SshServerTarget.fields,
  path: SshAbsolutePath,
});
export type SshReadFileInput = typeof SshReadFileInput.Type;

export const SshReadFileResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
  sizeBytes: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type SshReadFileResult = typeof SshReadFileResult.Type;

export const SshWriteFileInput = Schema.Struct({
  ...SshServerTarget.fields,
  path: SshAbsolutePath,
  content: Schema.String.check(Schema.isMaxLength(4_194_304)),
});
export type SshWriteFileInput = typeof SshWriteFileInput.Type;

export const SshDeleteFileInput = Schema.Struct({
  ...SshServerTarget.fields,
  path: SshAbsolutePath,
  /** 目录必须显式递归删除。 */
  recursive: Schema.Boolean,
});
export type SshDeleteFileInput = typeof SshDeleteFileInput.Type;

export class SshServerNotFoundError extends Schema.TaggedErrorClass<SshServerNotFoundError>()(
  "SshServerNotFoundError",
  {
    serverId: SshServerId,
    /** 已配置服务器的 label 列表，供 agent 工具自纠错。 */
    availableLabels: Schema.Array(TrimmedNonEmptyString),
  },
) {
  override get message() {
    return `Unknown SSH server: ${this.serverId}`;
  }
}

export class SshHostKeyMismatchError extends Schema.TaggedErrorClass<SshHostKeyMismatchError>()(
  "SshHostKeyMismatchError",
  {
    hostname: TrimmedNonEmptyString,
    expectedFingerprint: TrimmedNonEmptyString,
    actualFingerprint: TrimmedNonEmptyString,
  },
) {
  override get message() {
    return `SSH host key mismatch for ${this.hostname}`;
  }
}

export class SshConnectionError extends Schema.TaggedErrorClass<SshConnectionError>()(
  "SshConnectionError",
  {
    serverId: Schema.optional(SshServerId),
    reason: TrimmedString,
  },
) {
  override get message() {
    return `SSH connection failed: ${this.reason}`;
  }
}

export class SshFileError extends Schema.TaggedErrorClass<SshFileError>()("SshFileError", {
  path: TrimmedString,
  reason: Schema.Literals([
    "not-found",
    "not-a-directory",
    "is-directory",
    "refused-root",
    "too-many-entries",
    "binary-not-supported",
    "too-large",
    "sftp-failed",
  ]),
  detail: Schema.optional(TrimmedString),
}) {
  override get message() {
    return `SSH file operation failed (${this.reason}): ${this.path}`;
  }
}

export const SshError = Schema.Union([
  SshServerNotFoundError,
  SshHostKeyMismatchError,
  SshConnectionError,
  SshFileError,
]);
export type SshError = typeof SshError.Type;
