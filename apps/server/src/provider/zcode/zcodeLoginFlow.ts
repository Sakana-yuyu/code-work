// @effect-diagnostics preferSchemaOverJson:off - 与 ZCode 服务端通信的响应形状由对方定义。
// @effect-diagnostics nodeBuiltinImport:off - 凭据加密复刻 ZCode 的 node:crypto 实现。
/**
 * ZCode 官方账号登录流程的服务端移植（不依赖 zcode CLI）。
 *
 * 与上游 `zcode login [zai|bigmodel]` 一一对应：
 *   1. `POST <origin>/api/v1/oauth/cli/init`（Bearer 随机 pollToken）→ `authorize_url`；
 *   2. `GET oauth/cli/poll/<flow_id>` 轮询到 `ready`，拿到 OAuth token 与用户信息；
 *   3. 用 OAuth access token 在对方 biz 体系里找/建 `zcode-api-key` 并取回 secretKey，
 *      拼出 Coding Plan 长效 Key（zai 还需先用 `/api/auth/z/login` 换 biz token）；
 *   4. 把 OAuth token、user_info、identity 和 API key 按 ZCode 凭据文件的格式写入
 *      `<dataBaseDir>/.zcode/v2/credentials.json`（enc:v1 加密，与 CLI 完全兼容）。
 *
 * 端点默认值来自上游 `zcodeEndpoint.ts`：`zcode.z.ai`、`api.z.ai`、`bigmodel.cn`。
 *
 * @module provider/zcode/zcodeLoginFlow
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  encryptZCodeValue,
  ZCODE_OFFICIAL_PROVIDER_ID,
  type ZCodeFamily,
} from "./zcodeCredentials.ts";

const ZCODE_OAUTH_API_BASE = "https://zcode.z.ai/api/v1";
const ZAI_API_HOST = "https://api.z.ai";
const BIGMODEL_API_HOST = "https://bigmodel.cn";
const ZCODE_API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const OAUTH_SUCCESS_CODES: ReadonlySet<number> = new Set([0]);
const BIZ_SUCCESS_CODES: ReadonlySet<number> = new Set([0, 200]);

export class ZCodeLoginError extends Schema.TaggedErrorClass<ZCodeLoginError>()("ZCodeLoginError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
export const isZCodeLoginError = Schema.is(ZCodeLoginError);

export interface ZCodeLoginInitResult {
  readonly sessionId: string;
  readonly authorizeUrl: string;
  readonly expiresAtSec: number;
  readonly flowId: string;
  readonly pollIntervalSec: number;
  readonly pollToken: string;
}

export interface ZCodeLoginReadyResult {
  readonly userId: string;
  readonly email?: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly jwtToken: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * 与上游 `requestJsonEnvelope` 等价：HTTP 2xx + `{code, data, msg}` 封套；
 * `successCodes` 表达对方业务"成功码"集合（oauth 为 0，biz 为 0/200/字符串同值）。
 */
const requestJsonEnvelope = (input: {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly bearerToken?: string | undefined;
  /** `Authorization` 的完整值（bigmodel biz 直接放 access token，不带 Bearer）。 */
  readonly authorizationHeader?: string | undefined;
  readonly body?: unknown;
  readonly successCodes: ReadonlySet<number>;
  readonly failureDetail: string;
  /**
   * 瞬时错误分类（OAuth 轮询语义）：`retry` 的 HTTP 状态与网络错误都返回
   * `"transient"` 而非失败，调用方按原间隔继续——与上游一致，4xx 除
   * 408/429 才终态失败，429/5xx/断网只记为重试。
   */
  readonly transientPolicy?: ((status: number) => "fail" | "retry") | undefined;
}): Effect.Effect<unknown | "transient", ZCodeLoginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = (
      input.method === "POST" ? HttpClientRequest.post(input.url) : HttpClientRequest.get(input.url)
    ).pipe(
      input.bearerToken === undefined
        ? (req) => req
        : HttpClientRequest.setHeader("Authorization", `Bearer ${input.bearerToken}`),
      input.authorizationHeader === undefined
        ? (req) => req
        : HttpClientRequest.setHeader("Authorization", input.authorizationHeader),
      input.body === undefined
        ? (req) => req
        : HttpClientRequest.bodyText(JSON.stringify(input.body), "application/json"),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeout(HTTP_REQUEST_TIMEOUT_MS),
      Effect.catchIf(
        () => input.transientPolicy !== undefined,
        () => Effect.succeed("transient" as const),
      ),
      Effect.mapError(
        () => new ZCodeLoginError({ detail: `${input.failureDetail}，请稍后重试。` }),
      ),
    );
    if (response === "transient") return "transient" as const;
    if (response.status < 200 || response.status >= 300) {
      if (input.transientPolicy?.(response.status) === "retry") return "transient" as const;
      return yield* new ZCodeLoginError({
        detail: `${input.failureDetail}（HTTP ${response.status}）。`,
      });
    }
    const raw = yield* response.text.pipe(
      Effect.mapError(
        () => new ZCodeLoginError({ detail: `${input.failureDetail}（无法读取响应体）。` }),
      ),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => new ZCodeLoginError({ detail: `${input.failureDetail}（响应不是合法 JSON）。` }),
    });
    const envelope = asRecord(parsed);
    const code = envelope?.code;
    const codeOk =
      (typeof code === "number" && input.successCodes.has(code)) ||
      (typeof code === "string" &&
        Number.isInteger(Number(code)) &&
        input.successCodes.has(Number(code)));
    if (!envelope || code === undefined || !codeOk) {
      const msg = readString(envelope?.msg);
      return yield* new ZCodeLoginError({
        detail: `${input.failureDetail}${msg === undefined ? "" : `：${msg}`}`,
      });
    }
    return envelope.data;
  });

/** OAuth init；返回 authorize_url 与轮询参数。 */
export const initZCodeOAuth = (
  family: ZCodeFamily,
): Effect.Effect<ZCodeLoginInitResult, ZCodeLoginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pollToken = NodeCrypto.randomBytes(32).toString("hex");
    const data = yield* requestJsonEnvelope({
      method: "POST",
      url: `${ZCODE_OAUTH_API_BASE}/oauth/cli/init`,
      bearerToken: pollToken,
      body: { provider: family },
      successCodes: OAUTH_SUCCESS_CODES,
      failureDetail: "ZCode OAuth 初始化失败",
    });
    const record = asRecord(data);
    const authorizeUrl = readString(record?.authorize_url);
    const flowId = readString(record?.flow_id);
    const expiresAtSec = record?.expires_at;
    const pollIntervalSec = record?.poll_interval_sec;
    if (
      !authorizeUrl ||
      !flowId ||
      typeof expiresAtSec !== "number" ||
      !Number.isFinite(expiresAtSec) ||
      typeof pollIntervalSec !== "number" ||
      pollIntervalSec < 1
    ) {
      return yield* new ZCodeLoginError({ detail: "ZCode OAuth 初始化响应无效。" });
    }
    return {
      sessionId: NodeCrypto.randomUUID(),
      authorizeUrl,
      expiresAtSec,
      flowId,
      pollIntervalSec,
      pollToken,
    };
  });

/** 单次轮询：`pending` 继续、`failed`/`ready` 终止。 */
export const pollZCodeOAuthOnce = (
  init: ZCodeLoginInitResult,
  family: ZCodeFamily,
): Effect.Effect<"pending" | ZCodeLoginReadyResult, ZCodeLoginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const data = yield* requestJsonEnvelope({
      method: "GET",
      url: `${ZCODE_OAUTH_API_BASE}/oauth/cli/poll/${encodeURIComponent(init.flowId)}`,
      bearerToken: init.pollToken,
      successCodes: OAUTH_SUCCESS_CODES,
      failureDetail: "ZCode OAuth 轮询失败",
      // 与上游一致：4xx（除 408/429）才终态失败；429/5xx/超时/断网按原间隔继续。
      transientPolicy: (status) =>
        status >= 400 && status < 500 && status !== 408 && status !== 429 ? "fail" : "retry",
    });
    if (data === "transient") return "pending" as const;
    const record = asRecord(data);
    const status = record?.status;
    if (status === "pending") return "pending" as const;
    if (status === "failed") {
      return yield* new ZCodeLoginError({ detail: "ZCode 授权被拒绝或已失败，请重新登录。" });
    }
    if (status !== "ready") {
      return yield* new ZCodeLoginError({ detail: "ZCode OAuth 轮询响应无效。" });
    }
    const user = asRecord(record?.user);
    const provider = asRecord(record?.[family]);
    const accessToken = readString(provider?.access_token) ?? readString(provider?.accessToken);
    const refreshToken = readString(provider?.refresh_token) ?? readString(provider?.refreshToken);
    const jwtToken = readString(record?.token);
    const userId = readString(user?.user_id);
    if (!jwtToken || !userId || !accessToken) {
      return yield* new ZCodeLoginError({ detail: "ZCode OAuth ready 响应缺少必要字段。" });
    }
    return {
      userId,
      ...(readString(user?.email) === undefined ? {} : { email: readString(user?.email)! }),
      ...(readString(user?.name) === undefined ? {} : { name: readString(user?.name)! }),
      ...(readString(user?.avatar) === undefined ? {} : { avatar: readString(user?.avatar)! }),
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      jwtToken,
    };
  });

/**
 * 兑换 Coding Plan API Key：与上游 `coding-plan-api-key.ts` 等价。
 * zai：OAuth token → `api.z.ai/api/auth/z/login` 换 biz token → biz 流程。
 * bigmodel：直接以 OAuth token 为 Authorization 走 biz 流程（secretKey 可缺省）。
 */
export const resolveCodingPlanApiKey = (
  family: ZCodeFamily,
  accessToken: string,
): Effect.Effect<string, ZCodeLoginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const requestBiz = (init: {
      readonly method: "GET" | "POST";
      readonly url: string;
      readonly authorizationHeader: string;
      readonly body?: unknown;
    }) =>
      requestJsonEnvelope({
        method: init.method,
        url: init.url,
        authorizationHeader: init.authorizationHeader,
        body: init.body,
        successCodes: BIZ_SUCCESS_CODES,
        failureDetail: "Coding Plan API Key 获取失败",
      });
    let authorization = accessToken;
    let host = BIGMODEL_API_HOST;
    let requireSecretKey = false;
    if (family === "zai") {
      const biz = asRecord(
        yield* requestBiz({
          method: "POST",
          url: `${ZAI_API_HOST}/api/auth/z/login`,
          authorizationHeader: "",
          body: { token: accessToken },
        }),
      );
      const bizToken = readString(biz?.access_token) ?? readString(biz?.accessToken) ?? "";
      if (!bizToken) {
        return yield* new ZCodeLoginError({ detail: "Z.AI biz token 响应缺少 access_token。" });
      }
      authorization = `Bearer ${bizToken}`;
      host = ZAI_API_HOST;
      requireSecretKey = true;
    }
    const customer = asRecord(
      yield* requestBiz({
        method: "GET",
        url: `${host}/api/biz/customer/getCustomerInfo`,
        authorizationHeader: authorization,
      }),
    );
    const organizations = Array.isArray(customer?.organizations)
      ? (customer.organizations as Array<Record<string, unknown>>)
      : [];
    const org =
      organizations.find((item) => readString(item.organizationName)?.includes(DEFAULT_ORG_NAME)) ??
      organizations[0];
    const projects = Array.isArray(org?.projects)
      ? (org.projects as Array<Record<string, unknown>>)
      : [];
    const project =
      projects.find((item) => readString(item.projectName)?.includes(DEFAULT_PROJECT_NAME)) ??
      projects[0];
    const organizationId = readString(org?.organizationId);
    const projectId = readString(project?.projectId);
    if (!organizationId || !projectId) {
      return yield* new ZCodeLoginError({ detail: "无法解析 Coding Plan 的机构与项目。" });
    }
    const listUrl = `${host}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
    const keyList = yield* requestBiz({
      method: "GET",
      url: listUrl,
      authorizationHeader: authorization,
    });
    const entries = Array.isArray(keyList) ? (keyList as Array<Record<string, unknown>>) : [];
    let keyEntry = entries.find((item) => item.name === ZCODE_API_KEY_NAME);
    if (keyEntry === undefined) {
      keyEntry = asRecord(
        yield* requestBiz({
          method: "POST",
          url: listUrl,
          authorizationHeader: authorization,
          body: { name: ZCODE_API_KEY_NAME },
        }),
      );
    }
    const apiKey = readString(keyEntry?.apiKey) ?? "";
    if (!apiKey) {
      return yield* new ZCodeLoginError({ detail: "Coding Plan API Key 创建响应缺少 apiKey。" });
    }
    const secret = asRecord(
      yield* requestBiz({
        method: "GET",
        url: `${listUrl}/copy/${encodeURIComponent(apiKey)}`,
        authorizationHeader: authorization,
      }),
    );
    const secretKey = readString(secret?.secretKey) ?? "";
    if (!secretKey) {
      if (requireSecretKey) {
        return yield* new ZCodeLoginError({
          detail: "Coding Plan API Key copy 响应缺少 secretKey。",
        });
      }
      return apiKey;
    }
    return `${apiKey}.${secretKey}`;
  });

/**
 * 把登录结果按 ZCode 凭据文件格式写进 `<dataBaseDir>/.zcode/v2/credentials.json`：
 * 与 `loginZCodeCli` 的凭据写入一一对应（zai 无 refresh token；bigmodel 有）。
 * `account-provider:*` 条目让 ZCode CLI 自己也能识别这套凭据。
 */
export const writeZCodeLoginCredentials = (input: {
  readonly dataBaseDir: string;
  readonly family: ZCodeFamily;
  readonly ready: ZCodeLoginReadyResult;
  readonly apiKey: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}): Effect.Effect<string, ZCodeLoginError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.env ?? process.env;
    const credentialsDir = path.join(input.dataBaseDir, ".zcode", "v2");
    const filePath = path.join(credentialsDir, "credentials.json");
    yield* fs
      .makeDirectory(credentialsDir, { recursive: true })
      .pipe(
        Effect.mapError(
          (error) => new ZCodeLoginError({ detail: `无法创建 ZCode 凭据目录：${error.message}` }),
        ),
      );
    const userInfo =
      input.family === "zai"
        ? JSON.stringify({
            user_id: input.ready.userId,
            ...(input.ready.email ? { email: input.ready.email } : {}),
            ...(input.ready.name ? { name: input.ready.name } : {}),
            ...(input.ready.avatar ? { avatar: input.ready.avatar } : {}),
          })
        : JSON.stringify({
            id: input.ready.userId,
            username: input.ready.name ?? input.ready.email ?? input.ready.userId,
            displayName: input.ready.name ?? input.ready.email ?? input.ready.userId,
            rawProfile: {
              user_id: input.ready.userId,
              ...(input.ready.email ? { email: input.ready.email } : {}),
              ...(input.ready.name ? { name: input.ready.name } : {}),
              ...(input.ready.avatar ? { avatar: input.ready.avatar } : {}),
            },
          });
    const familyPrefix = input.family === "zai" ? "oauth:zai" : "oauth:bigmodel";
    const providerId = ZCODE_OFFICIAL_PROVIDER_ID[input.family];
    const entries: Record<string, string> = {
      "oauth:active_provider": input.family,
      zcodejwttoken: input.ready.jwtToken,
      [`${familyPrefix}:access_token`]: input.ready.accessToken,
      [`${familyPrefix}:user_info`]: userInfo,
      [`account-provider:${providerId}:identity`]: input.ready.userId,
      [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(input.ready.userId)}:api-key`]:
        input.apiKey,
      ...(input.ready.refreshToken === undefined
        ? {}
        : { [`${familyPrefix}:refresh_token`]: input.ready.refreshToken }),
    };
    const existingContent = yield* fs
      .readFileString(filePath)
      .pipe(Effect.orElseSucceed(() => undefined));
    let merged: Record<string, string> = {};
    if (existingContent !== undefined) {
      const parsed = yield* Effect.try(() => JSON.parse(existingContent) as unknown).pipe(
        Effect.option,
      );
      if (Option.isSome(parsed)) {
        const record = asRecord(parsed.value);
        if (record !== undefined) {
          merged = Object.fromEntries(
            Object.entries(record).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          );
        }
      }
    }
    const encrypted = yield* Effect.try({
      try: () =>
        Object.fromEntries(
          Object.entries(entries).map(([key, value]) => [key, encryptZCodeValue(value, env)]),
        ),
      catch: (error) =>
        new ZCodeLoginError({
          detail: `ZCode 凭据加密失败：${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    for (const [key, value] of Object.entries(encrypted)) {
      merged[key] = value;
    }
    yield* fs
      .writeFileString(filePath, `${JSON.stringify(merged, null, 2)}\n`)
      .pipe(
        Effect.mapError(
          (error) => new ZCodeLoginError({ detail: `ZCode 凭据写入失败：${error.message}` }),
        ),
      );
    return filePath;
  });

export const ZCODE_LOGIN_TIMEOUT_MS = LOGIN_TIMEOUT_MS;
