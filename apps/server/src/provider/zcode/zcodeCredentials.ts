// @effect-diagnostics preferSchemaOverJson:off - 读取的是 ZCode 自有的凭据 JSON，形状由对方定义。
// @effect-diagnostics nodeBuiltinImport:off - 凭据解密必须复刻 ZCode 的 node:crypto 实现。
/**
 * ZCode 官方账号凭据（`<ZCODE_DATA_BASE_DIR>/.zcode/v2/credentials.json`）的读取与解密。
 *
 * `zcode login` 完成后，凭据文件里同时存在 OAuth 令牌和兑换出的 Coding Plan
 * API Key（`account-provider:coding-plan:*:api-key`）。每个值用 AES-256-GCM
 * 加密成 `enc:v1:<iv>.<tag>.<密文>`（base64url），密钥是
 * `sha256(ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:<platform>:<homedir>:<username>")`。
 * 本模块与 ZCode 的 `credential-cipher.ts` / `shared-credentials.ts` 一一对应：
 * 同一台机器、同一个 OS 用户跑登录终端与 Code Work 服务，密钥必然一致。
 *
 * @module provider/zcode/zcodeCredentials
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

/** `oauth:active_provider` 的取值；决定 Coding Plan 网关路径与官方 Provider ID。 */
export type ZCodeFamily = "zai" | "bigmodel";

/** 官方 Individual Coding Plan 的内置 Provider ID（zcode-builtin.json 的 providerRules）。 */
export const ZCODE_OFFICIAL_PROVIDER_ID: Record<ZCodeFamily, string> = {
  zai: "account:zai-individual-coding-plan",
  bigmodel: "account:bigmodel-individual-coding-plan",
};

/** Individual Coding Plan 开放的官方模型（builtinProviderModelRules 中 enabled 的集合）。 */
export { ZCODE_OFFICIAL_MODELS } from "@codework/contracts";

/**
 * Coding Plan 请求的实际上游：ZCode CLI 发往 `https://api.z.ai/api/anthropic`
 * （或 `open.bigmodel.cn`）的请求会被它自己的 fetch 包装改写到 ZCode 平台网关。
 * 号池转发直接命中改写后的网关地址，行为与 CLI 一致。
 */
export const ZCODE_PLAN_GATEWAY_ANTHROPIC_BASE: Record<ZCodeFamily, string> = {
  zai: "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
  bigmodel: "https://zcode.z.ai/api/v1/ultra/anthropic",
};

export class ZCodeCredentialError extends Schema.TaggedErrorClass<ZCodeCredentialError>()(
  "ZCodeCredentialError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const zcodeCredentialSecret = (env: Readonly<Record<string, string | undefined>>): string => {
  const configured = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configured) return configured;
  let username = "unknown";
  try {
    username = NodeOs.userInfo().username;
  } catch {
    // 与 ZCode 相同：拿不到 OS 用户信息时退回 unknown。
  }
  return `zcode-credential-fallback:${NodeOs.platform()}:${NodeOs.homedir()}:${username}`;
};

const cipherKey = (env: Readonly<Record<string, string | undefined>>) =>
  NodeCrypto.createHash("sha256").update(zcodeCredentialSecret(env)).digest();

export const isEncryptedZCodeCredentialValue = (value: string): boolean =>
  value.startsWith(ENCRYPTED_VALUE_PREFIX);

/** 与 ZCode `cipher.encrypt` 等价：AES-256-GCM → `enc:v1:<iv>.<tag>.<密文>`。 */
export const encryptZCodeValue = (
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", cipherKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return `${ENCRYPTED_VALUE_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
};

/** 与 ZCode `cipher.decrypt` 等价：非 `enc:v1:` 值原样返回。 */
export const decryptZCodeValue = (
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  if (!isEncryptedZCodeCredentialValue(value)) return value;
  const parts = value.slice(ENCRYPTED_VALUE_PREFIX.length).split(".");
  const [ivRaw, authTagRaw, cipherRaw] = parts;
  if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
    throw new ZCodeCredentialError({ detail: "ZCode 凭据密文格式无效。" });
  }
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    cipherKey(env),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagRaw, "base64url"));
  try {
    return Buffer.concat([decipher.update(cipherRaw, "base64url"), decipher.final()]).toString(
      "utf-8",
    );
  } catch {
    throw new ZCodeCredentialError({
      detail: "ZCode 凭据解密失败：密钥不匹配或密文已损坏。",
    });
  }
};

const CREDENTIAL_RECORD_PATH = [".zcode", "v2", "credentials.json"] as const;
export const ZCODE_CREDENTIAL_RELATIVE_PATH = CREDENTIAL_RECORD_PATH.join("/");

export const zcodeCredentialsPath = (dataDir: string): string =>
  `${dataDir.replace(/[\\/]+$/u, "")}/${CREDENTIAL_RECORD_PATH.join("/")}`;

/** 解密后的凭据条目集合。 */
export type ZCodeCredentialRecord = Readonly<Record<string, string>>;

export const decryptZCodeCredentialRecord = (
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ZCodeCredentialRecord => {
  const decrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || value.length === 0) continue;
    decrypted[key] = decryptZCodeValue(value, env);
  }
  return decrypted;
};

/** 读取并解密 `<dataDir>/.zcode/v2/credentials.json`；文件不存在时返回 none。 */
export const readZCodeCredentials = (
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<Option.Option<ZCodeCredentialRecord>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(zcodeCredentialsPath(dataDir))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) return Option.none<ZCodeCredentialRecord>();
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Option.none<ZCodeCredentialRecord>();
    }
    const record = yield* Effect.try({
      try: () => decryptZCodeCredentialRecord(parsed as Record<string, unknown>, env),
      catch: () =>
        new ZCodeCredentialError({ detail: "ZCode 凭据解密失败：密钥不匹配或密文已损坏。" }),
    }).pipe(Effect.orElseSucceed(() => undefined));
    return record === undefined ? Option.none() : Option.some(record);
  });

export const zcodeFamilyOf = (record: ZCodeCredentialRecord): ZCodeFamily | undefined => {
  const active = record["oauth:active_provider"]?.trim();
  return active === "zai" || active === "bigmodel" ? active : undefined;
};

/** 登录 mint 出的 Coding Plan API Key；可能同时存在 zai 与 bigmodel 两条，按 active_provider 取。 */
export const zcodePlanApiKey = (record: ZCodeCredentialRecord): string | undefined => {
  const active = zcodeFamilyOf(record);
  const candidates = Object.entries(record).filter(
    ([key, value]) =>
      key.startsWith("account-provider:coding-plan:") && key.endsWith(":api-key") && value !== "",
  );
  if (candidates.length === 0) return undefined;
  if (active !== undefined) {
    const providerId = ZCODE_OFFICIAL_PROVIDER_ID[active];
    const preferred = candidates.find(([key]) => key.includes(`:${providerId}:`));
    if (preferred !== undefined) return preferred[1];
  }
  return candidates[0]?.[1];
};

/** 账号展示名：`oauth:<family>:user_info`（zai 与 bigmodel 的字段形状不同）。 */
export const zcodeAccountLabel = (record: ZCodeCredentialRecord): string | undefined => {
  const active = zcodeFamilyOf(record);
  const families: readonly ZCodeFamily[] =
    active === undefined ? ["zai", "bigmodel"] : [active, active === "zai" ? "bigmodel" : "zai"];
  for (const family of families) {
    const raw = record[`oauth:${family}:user_info`];
    if (raw === undefined) continue;
    try {
      const user: unknown = JSON.parse(raw);
      if (user === null || typeof user !== "object" || Array.isArray(user)) continue;
      const value = user as Record<string, unknown>;
      const label = [
        value.name,
        value.displayName,
        value.username,
        value.email,
        value.user_id,
      ].find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      if (label !== undefined) return label.trim();
    } catch {
      // 单个 user_info 损坏不阻塞凭据导入。
    }
  }
  return undefined;
};

export const zcodeAccountEmail = (record: ZCodeCredentialRecord): string | undefined => {
  for (const family of ["zai", "bigmodel"] as const) {
    const raw = record[`oauth:${family}:user_info`];
    if (raw === undefined) continue;
    try {
      const user: unknown = JSON.parse(raw);
      if (user === null || typeof user !== "object" || Array.isArray(user)) continue;
      const email = (user as Record<string, unknown>).email;
      if (typeof email === "string" && email.trim().length > 0) return email.trim();
    } catch {
      // 同上。
    }
  }
  return undefined;
};

/**
 * 把凭据文件归一化为号池凭据：只保留真正发请求用的 API Key 与路由元数据。
 * OAuth access/refresh token 不进入号池（Coding Plan Key 长效，失效应重新登录）。
 */
export const normalizeZCodePoolCredential = (
  record: ZCodeCredentialRecord,
): Record<string, unknown> | undefined => {
  const apiKey = zcodePlanApiKey(record);
  if (apiKey === undefined) return undefined;
  const family = zcodeFamilyOf(record) ?? "zai";
  const label = zcodeAccountLabel(record);
  const email = zcodeAccountEmail(record);
  // 顺带保留 zcodejwttoken：MCP 额度接口（/api/v1/mcp/usage）用它做 Bearer。
  const jwt = record["zcodejwttoken"];
  return {
    api_key: apiKey,
    auth_kind: "api-key",
    zcode_family: family,
    ...(typeof jwt === "string" && jwt.trim() !== "" ? { zcode_jwt: jwt.trim() } : {}),
    ...(label === undefined ? {} : { account_label: label }),
    ...(email === undefined ? {} : { account_email: email }),
  };
};
