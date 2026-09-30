import * as Schema from "effect/Schema";
import { ProviderInstanceEnvironment } from "./providerInstance.ts";

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\//));

/** 当前服务端平台的官方二进制分发；仅在官方给出 sha256 时出现，下载后必须校验。 */
export const AcpRegistryBinaryDistribution = Schema.Struct({
  platform: Schema.String,
  archiveUrl: HttpsUrl,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  cmd: Schema.String,
  args: Schema.Array(Schema.String),
});
export type AcpRegistryBinaryDistribution = typeof AcpRegistryBinaryDistribution.Type;

export const AcpRegistryCatalogEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  version: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  /** 官方目录 CDN 图标；Web 优先使用同 ID 的内置副本。 */
  iconUrl: Schema.optional(HttpsUrl),
  /** 已核对的原生认证方法；选择目录时预填，实例中仍可修改。 */
  authMethodId: Schema.optional(Schema.String),
  environment: Schema.optional(ProviderInstanceEnvironment),
  /** 经核对的兼容默认；用户可按实际 CLI 版本调整实例设置。 */
  supportsMcpServers: Schema.optional(Schema.Boolean),
  setup: Schema.optional(
    Schema.Struct({
      documentationUrl: HttpsUrl,
      installationUrl: HttpsUrl,
      verifiedAt: Schema.String,
    }),
  ),
  binaryDistribution: Schema.optional(AcpRegistryBinaryDistribution),
  availability: Schema.Literals(["installable", "manual", "unsupported-platform"]),
  configuredStatus: Schema.optional(
    Schema.Literals(["not-configured", "checking", "ready", "missing", "error", "disabled"]),
  ),
});
export type AcpRegistryCatalogEntry = typeof AcpRegistryCatalogEntry.Type;

export const AcpRegistryCatalogResult = Schema.Struct({
  entries: Schema.Array(AcpRegistryCatalogEntry),
  error: Schema.NullOr(Schema.String),
  source: Schema.optional(Schema.Literals(["registry", "bundled"])),
  snapshotDate: Schema.optional(Schema.String),
});
export type AcpRegistryCatalogResult = typeof AcpRegistryCatalogResult.Type;

/** 服务端按条目 ID 重新解析目录后下载；客户端不能提交下载地址或校验值。 */
export const AcpRegistryBinaryInstallInput = Schema.Struct({
  entryId: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,119}$/i)),
});
export type AcpRegistryBinaryInstallInput = typeof AcpRegistryBinaryInstallInput.Type;

export const AcpRegistryBinaryInstallResult = Schema.Struct({
  entryId: Schema.String,
  version: Schema.NullOr(Schema.String),
  command: Schema.String,
  installPath: Schema.String,
});
export type AcpRegistryBinaryInstallResult = typeof AcpRegistryBinaryInstallResult.Type;

export const AcpRegistryBinaryInstallErrorCode = Schema.Literals([
  "not-downloadable",
  "download-failed",
  "checksum-mismatch",
  "extract-failed",
  "command-missing",
]);
export type AcpRegistryBinaryInstallErrorCode = typeof AcpRegistryBinaryInstallErrorCode.Type;

export class AcpRegistryBinaryInstallError extends Schema.TaggedErrorClass<AcpRegistryBinaryInstallError>()(
  "AcpRegistryBinaryInstallError",
  {
    code: AcpRegistryBinaryInstallErrorCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ACP Agent 下载失败：${this.code}: ${this.detail}`;
  }
}
