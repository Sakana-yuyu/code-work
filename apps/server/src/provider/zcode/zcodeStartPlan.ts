// @effect-diagnostics preferSchemaOverJson:off - 与 ZCode 平台通信的响应形状由对方定义。
// @effect-diagnostics globalDate:off - 套餐过期判断按墙上时间（与上游桌面端一致）。
// @effect-diagnostics globalDateInEffect:off - 配置缓存 TTL 与过期判断用墙上时间。
/**
 * ZCode 体验套餐（Start Plan）与平台活动的读取。
 *
 * 端点与响应形状一一对照 ZCode 桌面端 3.14.4（host/index.js）：
 *  - `GET /api/v1/zcode-plan/billing/balance?app_version=`（Bearer zcodejwttoken）：
 *    `data.plans[{plan_id,user_plan_id,name,status,ends_at}]` +
 *    `data.balances[{entitlement_id,show_name,plan_id,user_plan_id,meter,unit_type,
 *    capabilities["model:GLM-5.3"],total_units,used_units,remaining_units,expires_at}]` +
 *    `server_time`（秒）。`ends_at<=now` 的 active 套餐按过期处理。
 *  - `GET /api/v1/zcode-plan/billing/preview?app_version=&platform=`（Bearer JWT）：
 *    可领取活动 `data.plans[{plan_id,name,description,entitlements[...]}]`。
 *  - `GET /api/v1/client/configs?app_version=&platform=`（匿名）：`configs.codingPlanBillingDiscount`
 *    的「150% 配额活动」文案与 `configs.captcha` 验证码配置；桌面端缓存 1 小时，这里同款。
 *
 * 领取（`POST /api/v1/zcode-plan/billing/claim`）需要阿里云验证码参数，由客户端弹窗
 * 完成后经 claimLocalAccountOffer 提交，不在本模块。
 *
 * @module provider/zcode/zcodeStartPlan
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import type { CliProxyAccountCampaign, CliProxyAccountOffer } from "@codework/contracts";

import type { UsageWindowView } from "../localAccountUsage.ts";

export const ZCODE_ORIGIN = "https://zcode.z.ai";

/** 平台 API 要求的客户端版本号（query `app_version`，对照桌面端 3.14.4）。 */
export const ZCODE_APP_VERSION = "3.14.4";

/** 平台标识 query `platform`：`<process.platform>-<arch>`（上游 resolveClientPlatformKey）。 */
export const zcodePlatformKey = Effect.map(
  Effect.all([HostProcessPlatform, HostProcessArchitecture]),
  ([platform, arch]) => `${platform}-${arch}` as string,
);

const REQUEST_TIMEOUT_MS = 15_000;
const CONFIGS_CACHE_TTL_MS = 3_600_000;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface ZCodeStartPlanPlan {
  readonly name: string;
  readonly planId?: string;
  readonly status: "active" | "expired";
  readonly endsAt?: string;
}

export interface ZCodeStartPlanView {
  readonly plan?: ZCodeStartPlanPlan;
  readonly windows: ReadonlyArray<UsageWindowView>;
  /** 余额桶 capabilities 声明的模型（保序去重），Start Plan 通道发布用。 */
  readonly models: ReadonlyArray<string>;
  /** 有套餐记录但没有 active 套餐（全部过期/未生效）。 */
  readonly expired: boolean;
}

export interface ZCodeCaptchaConfig {
  readonly enabled: boolean;
  readonly prefix: string;
  readonly sceneId: string;
  readonly region?: string;
}

export interface ZCodeClientConfigs {
  readonly campaign?: CliProxyAccountCampaign;
  readonly captcha?: ZCodeCaptchaConfig;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (record: Record<string, unknown> | undefined, key: string): string | undefined =>
  record !== undefined && typeof record[key] === "string" && record[key].trim().length > 0
    ? (record[key] as string).trim()
    : undefined;

const readNumber = (record: Record<string, unknown> | undefined, key: string): number | undefined =>
  record !== undefined && typeof record[key] === "number" && Number.isFinite(record[key])
    ? (record[key] as number)
    : undefined;

const epochSecondsToIso = (value: number | undefined): string | undefined =>
  value === undefined || !Number.isFinite(value) || value <= 0
    ? undefined
    : new Date(value * 1000).toISOString();

const formatTokenCount = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);

const getJson = (input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly failure: string;
}): Effect.Effect<Record<string, unknown>, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(input.url).pipe(HttpClientRequest.setHeaders(input.headers)))
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.mapError(() => input.failure),
      );
    if (response.status === 401 || response.status === 403)
      return yield* Effect.fail(`${input.failure}（登录已失效，请重新登录）`);
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(`${input.failure}（HTTP ${response.status}）`);
    const text = yield* response.text.pipe(Effect.mapError(() => `${input.failure}（响应不可读）`));
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(() => `${input.failure}（响应不是 JSON）`),
    );
    const record = asRecord(decoded);
    return record === undefined
      ? yield* Effect.fail(`${input.failure}（响应不是 JSON 对象）`)
      : record;
  });

/** 上游 isZaiStartPlanIdentity：plan_id/name 含 start-plan/start plan 即认。 */
const isStartPlanIdentity = (value: string | undefined): boolean =>
  value === undefined ? false : value.includes("start-plan") || value.includes("start plan");

const capabilityModels = (record: Record<string, unknown> | undefined): string[] => {
  const capabilities = record?.capabilities;
  if (!Array.isArray(capabilities)) return [];
  const models: string[] = [];
  for (const entry of capabilities) {
    if (typeof entry !== "string") continue;
    const model = (entry.toLowerCase().startsWith("model:") ? entry.slice(6) : entry).trim();
    if (model !== "" && !models.includes(model)) models.push(model);
  }
  return models;
};

const startPlanWindowOf = (record: Record<string, unknown>): UsageWindowView | undefined => {
  const total = readNumber(record, "total_units");
  const used = readNumber(record, "used_units");
  const remaining = readNumber(record, "remaining_units");
  if (total === undefined && used === undefined && remaining === undefined) return undefined;
  const models = capabilityModels(record);
  const showName = readString(record, "show_name");
  const label =
    models.length > 0 ? models.join("/") : (showName ?? readString(record, "meter") ?? "体验套餐");
  const percent =
    total !== undefined && total > 0 && used !== undefined ? (used / total) * 100 : undefined;
  const remainingText =
    remaining === undefined
      ? undefined
      : total === undefined
        ? formatTokenCount(remaining)
        : `${formatTokenCount(remaining)}/${formatTokenCount(total)}`;
  const resetsAt = epochSecondsToIso(readNumber(record, "expires_at"));
  if (percent === undefined && remainingText === undefined) return undefined;
  return {
    label,
    ...(percent === undefined ? {} : { percent }),
    ...(remainingText === undefined ? {} : { remaining: `${remainingText} tokens` }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
};

/**
 * 归一化 billing/balance 响应；信封非法或没有套餐+余额时 undefined。
 * 上游 normalizeStartPlanExpiry 语义：active 但 ends_at 已过 → 视为 expired，
 * 其余额桶不再展示。
 */
export const normalizeStartPlanBalance = (
  payload: unknown,
  nowSec: number,
): ZCodeStartPlanView | undefined => {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data);
  if (data === undefined) return undefined;
  const plans = (Array.isArray(data.plans) ? data.plans : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const activePlan = plans.find((plan) => {
    if ((readString(plan, "status") ?? "").toLowerCase() !== "active") return false;
    // 与上游一致：只有 Start Plan 身份的套餐才驱动体验套餐展示。
    if (
      !isStartPlanIdentity(readString(plan, "plan_id")) &&
      !isStartPlanIdentity(readString(plan, "name"))
    )
      return false;
    const endsAt = readNumber(plan, "ends_at");
    return endsAt === undefined || endsAt > nowSec;
  });
  const expiredPlanIds = new Set(
    plans
      .filter(
        (plan) =>
          (readString(plan, "status") ?? "").toLowerCase() === "active" &&
          (readNumber(plan, "ends_at") ?? Number.POSITIVE_INFINITY) <= nowSec,
      )
      .map((plan) => readString(plan, "user_plan_id") ?? readString(plan, "plan_id") ?? "")
      .filter((id) => id !== ""),
  );
  const balances = (Array.isArray(data.balances) ? data.balances : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .filter((balance) => {
      const planId = readString(balance, "user_plan_id") ?? readString(balance, "plan_id") ?? "";
      return planId === "" || !expiredPlanIds.has(planId);
    });
  const windows = balances
    .map(startPlanWindowOf)
    .filter((entry): entry is UsageWindowView => entry !== undefined);
  const models = [...new Set(balances.flatMap((balance) => capabilityModels(balance)))];
  const planName = activePlan === undefined ? undefined : readString(activePlan, "name");
  const plan =
    planName === undefined
      ? undefined
      : {
          name: planName,
          ...(readString(activePlan, "plan_id") === undefined
            ? {}
            : { planId: readString(activePlan, "plan_id")! }),
          status: "active" as const,
          ...(epochSecondsToIso(readNumber(activePlan, "ends_at")) === undefined
            ? {}
            : { endsAt: epochSecondsToIso(readNumber(activePlan, "ends_at"))! }),
        };
  if (plan === undefined && windows.length === 0 && models.length === 0 && plans.length === 0)
    return undefined;
  return {
    ...(plan === undefined ? {} : { plan }),
    windows,
    models,
    expired: plan === undefined && plans.length > 0,
  };
};

/** 归一化 billing/preview 的可领取活动列表；空活动返回空数组。 */
export const normalizeClaimOffers = (payload: unknown): ReadonlyArray<CliProxyAccountOffer> => {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data);
  const plans = Array.isArray(data?.plans) ? data.plans : [];
  const offers: CliProxyAccountOffer[] = [];
  for (const raw of plans) {
    const plan = asRecord(raw);
    const planId = readString(plan, "plan_id");
    if (planId === undefined) continue;
    const entitlements = (Array.isArray(plan?.entitlements) ? plan.entitlements : [])
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .flatMap((entitlement): CliProxyAccountOffer["entitlements"] => {
        const amount = readNumber(entitlement, "grant_units");
        if (amount === undefined) return [];
        const models = capabilityModels(entitlement);
        const showName = readString(entitlement, "show_name");
        return [
          {
            ...(models.length > 0
              ? { model: models.join("/") }
              : showName === undefined
                ? {}
                : { model: showName }),
            amount: formatTokenCount(amount),
            ...(readString(entitlement, "unit_type") === undefined
              ? {}
              : { unit: readString(entitlement, "unit_type")! }),
            ...(readString(entitlement, "period") === undefined
              ? {}
              : { period: readString(entitlement, "period")! }),
          },
        ];
      });
    offers.push({
      planId,
      // 上游 name 缺省时用 plan_id 兜底（桌面端同款）。
      name: readString(plan, "name") ?? planId,
      ...(readString(plan, "description") === undefined
        ? {}
        : { description: readString(plan, "description")! }),
      entitlements,
    });
  }
  return offers;
};

const pickCampaignCopy = (
  discount: Record<string, unknown>,
): { badge?: string; title?: string; info?: string } | undefined => {
  // 产品 zh 优先，缺 zh 用 en 兜底；两个语言都没有时视为无活动。
  for (const locale of ["zh-CN", "en-US"]) {
    const copy = asRecord(discount[locale]);
    if (copy === undefined) continue;
    const badge = readString(copy, "badgeBody");
    const title = readString(copy, "cardTitle");
    const info = readString(copy, "infoBody");
    if (badge === undefined && title === undefined && info === undefined) continue;
    return {
      ...(badge === undefined ? {} : { badge }),
      ...(title === undefined ? {} : { title }),
      ...(info === undefined ? {} : { info }),
    };
  }
  return undefined;
};

/** 从 client/configs 抽活动文案与验证码配置；没有活动/配置时字段省略。 */
export const normalizeClientConfigs = (payload: unknown): ZCodeClientConfigs => {
  const envelope = asRecord(payload);
  const configs = asRecord(asRecord(envelope?.data)?.configs);
  if (configs === undefined) return {};
  const discount = asRecord(configs.codingPlanBillingDiscount);
  const campaign = discount === undefined ? undefined : pickCampaignCopy(discount);
  const captchaRecord = asRecord(configs.captcha);
  const captchaEnabled = captchaRecord?.enabled === true;
  const captchaPrefix = readString(captchaRecord, "prefix");
  const captchaSceneId = readString(captchaRecord, "sceneId");
  const captcha =
    captchaEnabled && captchaPrefix !== undefined && captchaSceneId !== undefined
      ? {
          enabled: true,
          prefix: captchaPrefix,
          sceneId: captchaSceneId,
          ...(readString(captchaRecord, "region") === undefined
            ? {}
            : { region: readString(captchaRecord, "region")! }),
        }
      : undefined;
  return {
    ...(campaign === undefined ? {} : { campaign }),
    ...(captcha === undefined ? {} : { captcha }),
  };
};

/** client/configs 模块级缓存（1 小时，与桌面端同款 TTL）。 */
let configsCache: { readonly expiresAtMs: number; readonly value: ZCodeClientConfigs } | undefined;

export const resetZCodeClientConfigsCacheForTest = (): void => {
  configsCache = undefined;
};

export const fetchZCodeClientConfigs = (): Effect.Effect<
  ZCodeClientConfigs,
  never,
  HttpClient.HttpClient
> => {
  const now = Date.now();
  if (configsCache !== undefined && configsCache.expiresAtMs > now)
    return Effect.succeed(configsCache.value);
  return Effect.flatMap(zcodePlatformKey, (platform) =>
    getJson({
      url:
        `${ZCODE_ORIGIN}/api/v1/client/configs?app_version=${encodeURIComponent(ZCODE_APP_VERSION)}` +
        `&platform=${encodeURIComponent(platform)}`,
      headers: {},
      failure: "ZCode 平台配置查询失败",
    }),
  ).pipe(
    Effect.map(normalizeClientConfigs),
    Effect.tap((value) =>
      Effect.sync(() => {
        configsCache = { expiresAtMs: Date.now() + CONFIGS_CACHE_TTL_MS, value };
      }),
    ),
    // 配置是可选数据面：拿不到不影响套餐/额度展示。
    Effect.orElseSucceed(() => ({})),
  );
};

export const fetchZCodeStartPlanBalance = (
  jwt: string,
): Effect.Effect<ZCodeStartPlanView, string, HttpClient.HttpClient> => {
  const url = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`;
  return getJson({
    url,
    headers: { Authorization: `Bearer ${jwt}` },
    failure: "ZCode 体验套餐查询失败",
  }).pipe(
    Effect.map(
      (payload) =>
        normalizeStartPlanBalance(payload, Date.now() / 1000) ?? {
          windows: [],
          models: [],
          expired: false,
        },
    ),
  );
};

export const fetchZCodeClaimOffers = (
  jwt: string,
): Effect.Effect<ReadonlyArray<CliProxyAccountOffer>, string, HttpClient.HttpClient> =>
  Effect.flatMap(zcodePlatformKey, (platform) =>
    getJson({
      url:
        `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(ZCODE_APP_VERSION)}` +
        `&platform=${encodeURIComponent(platform)}`,
      headers: { Authorization: `Bearer ${jwt}` },
      failure: "ZCode 领取活动查询失败",
    }),
  ).pipe(Effect.map(normalizeClaimOffers));

/** 领取活动的归一化结果；失败带上游原始 code 与 message（上游文案优先展示）。 */
export interface ZCodeClaimOutcome {
  readonly success: boolean;
  readonly code?: number;
  readonly message?: string;
  readonly planName?: string;
  readonly endsAt?: string;
}

/** 上游响应形状（桌面端 claimManualPlan 同款解析）：{code,msg,data:{plan,server_time,message}}。 */
export const normalizeClaimResult = (payload: unknown): ZCodeClaimOutcome => {
  const record = asRecord(payload);
  if (record === undefined) return { success: false };
  const rawCode = record.code;
  const code =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d+$/u.test(rawCode)
        ? Number(rawCode)
        : -1;
  const data = asRecord(record.data);
  const plan = asRecord(data?.plan);
  const endsAtMs = readNumber(plan, "ends_at");
  const message =
    readString(data, "message") ??
    (typeof record.msg === "string" && record.msg.trim().length > 0
      ? record.msg.trim()
      : undefined);
  const success = code === 0 && plan !== undefined;
  return {
    success,
    // 成功时 code 恒为 0、msg 是 "ok" 之类的噪音，都省略；失败才回传上游原始码与文案。
    ...(success || code === -1 ? {} : { code }),
    ...(success || message === undefined ? {} : { message }),
    ...(plan === undefined
      ? {}
      : {
          ...(readString(plan, "name") === undefined
            ? {}
            : { planName: readString(plan, "name")! }),
          ...(endsAtMs === undefined ? {} : { endsAt: new Date(endsAtMs * 1000).toISOString() }),
        }),
  };
};

const postJson = (input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly failure: string;
}): Effect.Effect<Record<string, unknown>, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(input.url).pipe(
          HttpClientRequest.setHeaders({
            "Content-Type": "application/json",
            ...input.headers,
          }),
          HttpClientRequest.bodyText(input.body),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.mapError(() => input.failure),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(`${input.failure}（HTTP ${response.status}）`);
    const text = yield* response.text.pipe(Effect.mapError(() => `${input.failure}（响应不可读）`));
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      text,
    ).pipe(Effect.mapError(() => `${input.failure}（响应不是 JSON）`));
    const record = asRecord(decoded);
    return record === undefined
      ? yield* Effect.fail(`${input.failure}（响应不是 JSON 对象）`)
      : record;
  });

/**
 * 领取体验套餐活动（桌面端 manualClaimPlan 同款请求）。captchaVerifyParam 由
 * 客户端渲染阿里云验证码拿到；code!=0 时原样回传上游 code/message。
 */
export const fetchZCodeClaimOffer = (input: {
  readonly jwt: string;
  readonly planId: string;
  readonly captchaVerifyParam: string;
  readonly captchaRegion?: string;
}): Effect.Effect<ZCodeClaimOutcome, string, HttpClient.HttpClient> =>
  Effect.flatMap(zcodePlatformKey, (platform) =>
    postJson({
      url: `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`,
      headers: {
        Authorization: `Bearer ${input.jwt}`,
        "X-Aliyun-Captcha-Verify-Param": input.captchaVerifyParam,
        ...(input.captchaRegion === undefined
          ? {}
          : { "X-Aliyun-Captcha-Verify-Region": input.captchaRegion }),
        "X-ZCode-App-Version": ZCODE_APP_VERSION,
        "X-Platform": platform,
      },
      body: JSON.stringify({ plan_id: input.planId }),
      failure: "ZCode 活动领取失败",
    }),
  ).pipe(
    Effect.map(normalizeClaimResult),
    // 传输层失败（超时/非 JSON）也归一成失败结果：message 带原因，客户端照常展示。
    Effect.catch((detail: string) =>
      Effect.succeed<ZCodeClaimOutcome>({ success: false, message: detail }),
    ),
  );
