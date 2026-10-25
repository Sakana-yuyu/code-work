export type SupplierType = "openai" | "anthropic" | "gemini";
export type ModelCatalogStatus = "openai_models" | "gemini_models" | "custom_url" | "manual_only";
export type UsageStatus = "fixed" | "token_plan" | "newapi" | "general" | "custom_only" | "none";

export interface SupplierModelCatalog {
  readonly status: ModelCatalogStatus;
  readonly urls: readonly string[];
  readonly appendCandidates: boolean;
  readonly source: string;
}

export interface SupplierUsage {
  readonly status: UsageStatus;
  readonly provider: string;
  readonly source: string;
}

export interface SupplierTemplate {
  readonly id: string;
  readonly supplierID: string;
  readonly label: string;
  readonly iconURL: string;
  readonly iconLight: boolean;
  readonly websiteURL: string;
  readonly apiKeyURL: string;
  readonly type: SupplierType;
  readonly baseURL: string;
  readonly endpoint: string;
  readonly requestGroup: string;
  readonly models: readonly string[];
  readonly presets: readonly unknown[];
  readonly allowCustomURL: boolean;
  readonly modelCatalog: SupplierModelCatalog;
  readonly usage: SupplierUsage;
  readonly verification: string;
}

export interface SupplierTemplateDefinition {
  readonly id?: string;
  readonly label?: string;
  readonly iconURL?: string;
  readonly iconLight?: boolean;
  readonly websiteURL?: string;
  readonly apiKeyURL?: string;
  readonly type?: SupplierType;
  readonly baseURL?: string;
  readonly endpoint?: string;
  readonly requestGroup?: string;
  readonly models?: readonly string[];
  readonly presets?: readonly unknown[];
  readonly allowCustomURL?: boolean;
  readonly modelCatalogStatus?: ModelCatalogStatus;
  readonly modelCatalogURLs?: readonly (string | null | undefined | false)[];
  readonly appendCandidates?: boolean;
  readonly source?: string;
  readonly usageStatus?: UsageStatus;
  readonly usageProvider?: string;
  readonly usageSource?: string;
  readonly verification?: string;
}

export interface SupplierSelectOption {
  readonly value: string;
  readonly label: string;
  readonly iconURL: string;
  readonly iconLight: boolean;
}

export interface SupplierUsageAdapter {
  readonly supplierID?: unknown;
  readonly balanceProfile?: unknown;
  readonly balanceQueryURL?: unknown;
  readonly balanceQueryField?: unknown;
  readonly balanceCodingPlanProvider?: unknown;
}

export interface SupplierUsageRequest {
  readonly status: UsageStatus;
  readonly provider: string;
}

type SupplierCatalogRow = readonly [
  id: string,
  label: string,
  type: SupplierType,
  websiteURL: string,
  apiKeyURL: string,
  baseURL: string,
  models: readonly string[],
  options: Omit<
    SupplierTemplateDefinition,
    "id" | "label" | "type" | "websiteURL" | "apiKeyURL" | "baseURL" | "models"
  >,
];

// Data-driven supplier presets. supplierID stays stable across saved adapters and backend routing.
const MODEL_CATALOG_STATUSES = new Set([
  "openai_models",
  "gemini_models",
  "custom_url",
  "manual_only",
]);
const USAGE_STATUSES = new Set(["fixed", "token_plan", "newapi", "general", "custom_only", "none"]);
const SUPPLIER_ICON_LIGHT_IDS = new Set(["custom", "openai", "codex", "github_copilot"]);
const SUPPLIER_ICON_FILES: Readonly<Record<string, string>> = Object.freeze({
  custom: "openai.svg",
  openai: "openai.svg",
  anthropic: "anthropic.svg",
  gemini: "gemini.svg",
  kimi: "kimi.svg",
  kimi_coding: "kimi.svg",
  packycode: "packycode.svg",
  apinebula: "apinebula_icon.png",
  aicodemirror: "aicodemirror.svg",
  patewayai: "pateway.jpg",
  fennoai: "fenno-icon.webp",
  runapi: "runapi.jpg",
  shengsuanyun: "shengsuanyun.svg",
  aigocode: "aigocode.svg",
  aicoding: "aicoding.svg",
  subrouter: "subrouter.svg",
  apikeyfun: "apikeyfun.png",
  claudeapi: "ClaudeApi.png",
  code0: "code0.png",
  teamorouter: "TeamoRouter-icon-dark.png",
  claudecn: "claudecn.png",
  volcengine_agent: "huoshan.png",
  byteplus: "byteplus.png",
  doubaoseed: "doubao.svg",
  siliconflow: "siliconflow.svg",
  siliconflow_en: "siliconflow.svg",
  nekocode: "nekocode-icon.png",
  a6api: "a6-icon.png",
  atlascloud: "atlascloud_icon.png",
  ucloud: "ucloud.svg",
  ucloud_coding: "ucloud.svg",
  ccsub: "ccsub.svg",
  sssaicode: "sssaicode.svg",
  micu: "micu.svg",
  rightcode: "rc.svg",
  cubence: "cubence.svg",
  crazyrouter: "crazyrouter.svg",
  dmxapi: "qiniu.png",
  qiniu: "qiniu.png",
  sudocode_chat: "sudocode.png",
  sudocode_us: "sudocode-us.png",
  aihubmix: "aihubmix-color.svg",
  amux: "amuxapi-icon.svg",
  qianfan_coding: "baidu.svg",
  bailian: "bailian.svg",
  bailian_coding: "bailian.svg",
  bailing: "aihubmix-color.svg",
  cherryin: "cherryin.png",
  codex: "openai.svg",
  deepseek: "deepseek.svg",
  gemini_native: "gemini.svg",
  github_copilot: "github.svg",
  longcat: "longcat-color.svg",
  minimax: "minimax.svg",
  minimax_en: "minimax.svg",
  modelscope: "modelscope-color.svg",
  novita: "novita.svg",
  nvidia: "nvidia.svg",
  opencode_go: "opencode-logo-light.svg",
  openrouter: "openrouter.svg",
  pipellm: "pipellm.png",
  relaxycode: "relaxcode.png",
  eflowcode: "eflowcode.png",
  stepfun: "stepfun.svg",
  stepfun_en: "stepfun.svg",
  stepfun_api: "stepfun.svg",
  stepfun_api_en: "stepfun.svg",
  therouter: "novita.svg",
  xai: "xai.svg",
  xiaomi_mimo: "xiaomimimo.svg",
  xiaomi_mimo_token_plan_cn: "xiaomimimo.svg",
  zhipu_glm: "zhipu.svg",
  zhipu_glm_en: "zhipu.svg",
  moonshot: "kimi.svg",
  zhipu: "zhipu.svg",
  zhipu_team: "zhipu.svg",
  zenmux: "newapi.svg",
  volcengine: "huoshan.png",
  unity2: "unity2.png",
});

function supplierIconURL(id: string): string {
  const fileName = SUPPLIER_ICON_FILES[id];
  return fileName ? `/supplier-icons/${fileName}` : "";
}

export function createTemplate(definition: SupplierTemplateDefinition): SupplierTemplate {
  const id = String(definition.id || "custom")
    .trim()
    .toLowerCase();
  const type = definition.type || "anthropic";
  const modelCatalogURLs = Array.isArray(definition.modelCatalogURLs)
    ? definition.modelCatalogURLs.filter((url): url is string => Boolean(url))
    : [];
  const requestedCatalogStatus = definition.modelCatalogStatus;
  const catalogStatus: ModelCatalogStatus =
    requestedCatalogStatus && MODEL_CATALOG_STATUSES.has(requestedCatalogStatus)
      ? requestedCatalogStatus
      : type === "gemini"
        ? "gemini_models"
        : type === "openai" || modelCatalogURLs.length > 0
          ? "openai_models"
          : "manual_only";
  const requestedUsageStatus = definition.usageStatus;
  const usageStatus: UsageStatus =
    requestedUsageStatus && USAGE_STATUSES.has(requestedUsageStatus)
      ? requestedUsageStatus
      : "none";
  const baseURL = String(definition.baseURL || "").trim();
  return {
    id,
    supplierID: id,
    label: definition.label || id,
    iconURL: definition.iconURL || supplierIconURL(id),
    iconLight: definition.iconLight ?? SUPPLIER_ICON_LIGHT_IDS.has(id),
    websiteURL: definition.websiteURL || "",
    apiKeyURL: definition.apiKeyURL || definition.websiteURL || "",
    type,
    baseURL,
    endpoint: definition.endpoint || (type === "openai" ? "/v1/chat/completions" : ""),
    requestGroup:
      definition.requestGroup ||
      (type === "openai" ? "chat_completions" : type === "gemini" ? "gemini_native" : ""),
    models: Array.isArray(definition.models) ? definition.models : [],
    presets: Array.isArray(definition.presets) ? definition.presets : [],
    allowCustomURL: definition.allowCustomURL !== false,
    modelCatalog: {
      status: catalogStatus,
      urls: modelCatalogURLs,
      appendCandidates: definition.appendCandidates !== false,
      source: definition.source || "cc_switch",
    },
    usage: {
      status: usageStatus,
      provider: definition.usageProvider || "",
      source:
        definition.usageSource ||
        (usageStatus === "none" ? "未核验公开用量接口" : "cc_switch / 官方接口"),
    },
    verification:
      definition.verification ||
      (definition.source === "official_docs" ? "official_docs" : "cc_switch"),
  };
}

const coreTemplates: SupplierTemplate[] = [
  createTemplate({
    id: "custom",
    label: "自定义供应商",
    type: "openai",
    modelCatalogStatus: "custom_url",
    usageStatus: "custom_only",
    usageSource: "自定义查询模板",
    source: "manual",
  }),
  createTemplate({
    id: "openai",
    label: "OpenAI",
    type: "openai",
    websiteURL: "https://platform.openai.com",
    apiKeyURL: "https://platform.openai.com/api-keys",
    baseURL: "https://api.openai.com/v1",
    endpoint: "/v1/responses",
    requestGroup: "responses",
    models: ["gpt-5", "gpt-4.1"],
    usageStatus: "none",
    usageSource: "官方模型目录可用；公开用量接口未接入",
    source: "official_docs",
    verification: "official_docs",
  }),
  createTemplate({
    id: "anthropic",
    label: "Anthropic",
    type: "anthropic",
    websiteURL: "https://www.anthropic.com",
    apiKeyURL: "https://console.anthropic.com/settings/keys",
    baseURL: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    modelCatalogStatus: "custom_url",
    modelCatalogURLs: ["https://api.anthropic.com/v1/models"],
    usageStatus: "none",
    usageSource: "官方模型目录未提供统一公开余额接口",
    source: "official_docs",
    verification: "official_docs",
  }),
  createTemplate({
    id: "gemini",
    label: "Gemini",
    type: "gemini",
    websiteURL: "https://ai.google.dev/gemini-api",
    apiKeyURL: "https://aistudio.google.com/app/apikey",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    usageStatus: "none",
    usageSource: "官方模型目录可用；公开用量接口未接入",
    source: "official_docs",
    verification: "official_docs",
  }),
];

// The following rows mirror cc-switch's provider preset catalog. Unknown usage APIs intentionally stay none.
// 2026-10-26 resync: upstream removed ETok.ai / ZetaAPI (expired sponsor slots); added their 2026-10 preset wave
// (coding-plan relays, Tencent/Qwen/Vertex-style token plans, inference clouds, and local runtimes like Ollama/vLLM).
const catalogRows: SupplierCatalogRow[] = [
  [
    "kimi",
    "Kimi",
    "anthropic",
    "https://platform.kimi.com?aff=cc-switch",
    "https://platform.kimi.com?aff=cc-switch",
    "https://api.moonshot.cn/anthropic",
    ["kimi-k2.7-code"],
    {
      usageStatus: "fixed",
      usageProvider: "moonshot",
      modelCatalogURLs: ["https://api.moonshot.cn/anthropic/v1/models"],
    },
  ],
  [
    "kimi_coding",
    "Kimi For Coding",
    "anthropic",
    "https://www.kimi.com/code/?aff=cc-switch",
    "https://www.kimi.com/code/?aff=cc-switch",
    "https://api.kimi.com/coding",
    [],
    {
      usageStatus: "none",
      usageSource: "Kimi Coding 套餐用量接口尚未接入",
      modelCatalogURLs: ["https://api.kimi.com/coding/v1/models"],
    },
  ],
  [
    "packycode",
    "PackyCode",
    "anthropic",
    "https://www.packyapi.ai",
    "https://www.packyapi.ai/register?aff=cc-switch",
    "https://www.packyapi.ai/v1",
    [],
    {
      modelCatalogURLs: [
        "https://www.packyapi.ai/v1/models",
        "https://cf.api.fan/v1/models",
        "https://slb-v1.api.fan/v1/models",
      ],
    },
  ],
  [
    "apinebula",
    "APINebula",
    "anthropic",
    "https://apinebula.ai",
    "https://apinebula.ai/VjM74M",
    "https://apinebula.ai/v1",
    [],
    {},
  ],
  [
    "aicodemirror",
    "AICodeMirror",
    "anthropic",
    "https://www.aicodemirror.ai",
    "https://www.aicodemirror.ai/register?invitecode=9915W3",
    "https://api.aicodemirror.ai/api/claudecode",
    [],
    {},
  ],
  [
    "patewayai",
    "PatewayAI",
    "anthropic",
    "https://pateway.ai",
    "https://pateway.ai/?ch=etzpm8&aff=WB6M6F67#/",
    "https://api.pateway.ai/v1",
    [],
    {},
  ],
  [
    "fennoai",
    "FennoAI",
    "anthropic",
    "https://api.fenno.ai",
    "https://api.fenno.ai/register?redirect=/purchase?tab=subscription%26group=16&aff=P9MR3D3PLCNL",
    "https://api.fenno.ai/v1",
    [],
    {},
  ],
  [
    "runapi",
    "RunAPI",
    "anthropic",
    "https://runapi.co",
    "https://runapi.co/register?aff=iOKB",
    "https://runapi.co/v1",
    [],
    {},
  ],
  [
    "shengsuanyun",
    "Shengsuanyun",
    "anthropic",
    "https://www.shengsuanyun.com/?from=CH_4HHXMRYF",
    "https://www.shengsuanyun.com/?from=CH_4HHXMRYF",
    "https://router.shengsuanyun.com/api",
    ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "anthropic/claude-haiku-4.5"],
    {},
  ],
  [
    "aigocode",
    "AIGoCode",
    "anthropic",
    "https://aigocode.app",
    "https://aigocode.app/invite/CC-SWITCH",
    "https://api.aigocode.app/v1",
    [],
    {},
  ],
  [
    "aicoding",
    "AICoding",
    "anthropic",
    "https://aicoding.inc",
    "https://aicoding.inc/i/CCSWITCH",
    "https://api.aicoding.inc/v1",
    [],
    {},
  ],
  [
    "subrouter",
    "SubRouter",
    "anthropic",
    "https://subrouter.ai",
    "https://subrouter.ai/register?aff=l3ri",
    "https://subrouter.ai/v1",
    [],
    {},
  ],
  [
    "apikeyfun",
    "APIKEY.FUN",
    "anthropic",
    "https://apikey.fun",
    "https://apikey.fun/register?aff=CCSwitch",
    "https://api.apikey.fun/v1",
    [],
    { modelCatalogURLs: ["https://api.apikey.fun/v1/models", "https://slb.apikey.fun/v1/models"] },
  ],
  [
    "claudeapi",
    "ClaudeAPI",
    "anthropic",
    "https://www.apito.ai",
    "https://console.apito.ai/agent/register/pQBql2buaqiX3dDS",
    "https://gw.apito.ai/v1",
    [],
    {},
  ],
  [
    "code0",
    "Code0",
    "anthropic",
    "https://code0.ai",
    "https://code0.ai/agent/register/B2XHxGjGmRvqgznY",
    "https://code0.ai/v1",
    [],
    {},
  ],
  [
    "teamorouter",
    "TeamoRouter",
    "anthropic",
    "https://teamorouter.com",
    "https://teamorouter.com/?utm_source=cc_switch&utm_medium=referral&utm_campaign=ai_directory",
    "https://api.teamorouter.com/v1",
    [],
    {},
  ],
  [
    "claudecn",
    "ClaudeCN",
    "anthropic",
    "https://claudecn.top",
    "https://claudecn.ai/register?aff=HEL9",
    "https://claudecn.top/v1",
    [],
    {},
  ],
  [
    "volcengine_agent",
    "火山Agent Plan",
    "anthropic",
    "https://www.volcengine.com/activity/codingplan",
    "https://www.volcengine.com/activity/codingplan",
    "https://ark.cn-beijing.volces.com/api/coding",
    ["ark-code-latest"],
    {
      usageStatus: "none",
      usageSource: "火山 Agent Plan 套餐用量接口尚未接入",
      modelCatalogURLs: ["https://ark.cn-beijing.volces.com/api/coding/v1/models"],
    },
  ],
  [
    "byteplus",
    "BytePlus",
    "anthropic",
    "https://www.byteplus.com/en/product/modelark",
    "https://www.byteplus.com/en/product/modelark",
    "https://ark.ap-southeast.bytepluses.com/api/coding",
    ["ark-code-latest"],
    {},
  ],
  [
    "doubaoseed",
    "DouBaoSeed",
    "anthropic",
    "https://console.volcengine.com/ark",
    "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    "https://ark.cn-beijing.volces.com/api/compatible",
    ["doubao-seed-2-1-pro-260628"],
    {},
  ],
  [
    "siliconflow",
    "SiliconFlow",
    "openai",
    "https://siliconflow.cn",
    "https://cloud.siliconflow.cn/i/YflgU2Ve",
    "https://api.siliconflow.cn/v1",
    ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
    {
      usageStatus: "none",
      usageSource: "官方 /user/info 已停用；替代账号接口尚未公告",
      modelCatalogURLs: ["https://api.siliconflow.cn/v1/models"],
    },
  ],
  [
    "siliconflow_en",
    "SiliconFlow en",
    "openai",
    "https://siliconflow.com",
    "https://cloud.siliconflow.cn/i/YflgU2Ve",
    "https://api.siliconflow.com/v1",
    ["MiniMaxAI/MiniMax-M2.7"],
    {
      usageStatus: "none",
      usageSource: "官方 /user/info 已停用；替代账号接口尚未公告",
      modelCatalogURLs: ["https://api.siliconflow.com/v1/models"],
    },
  ],
  [
    "nekocode",
    "NekoCode",
    "anthropic",
    "https://nekocode.ai",
    "https://nekocode.ai?aff=CCSWITCH",
    "https://nekocode.ai/v1",
    [],
    {},
  ],
  [
    "a6api",
    "A6API",
    "anthropic",
    "https://www.a6api.com",
    "https://a6api.com/register?aff=AqNr",
    "https://api.a6api.com/v1",
    [],
    {},
  ],
  [
    "atlascloud",
    "AtlasCloud",
    "anthropic",
    "https://www.atlascloud.ai/console/coding-plan",
    "https://www.atlascloud.ai/console/coding-plan",
    "https://api.atlascloud.ai/v1",
    [],
    {},
  ],
  [
    "ucloud",
    "Compshare",
    "anthropic",
    "https://www.compshare.cn",
    "https://www.compshare.cn/coding-plan",
    "https://api.modelverse.cn/v1",
    [],
    {},
  ],
  [
    "ucloud_coding",
    "Compshare Coding Plan",
    "anthropic",
    "https://www.compshare.cn",
    "https://www.compshare.cn/coding-plan",
    "https://cp.compshare.cn/v1",
    [],
    {},
  ],
  [
    "ccsub",
    "CCSub",
    "anthropic",
    "https://www.ccsub.net",
    "https://www.ccsub.net/register?ref=Y6Z8DXEA",
    "https://www.ccsub.net/v1",
    [],
    {},
  ],
  [
    "sssaicode",
    "SSSAiCode",
    "anthropic",
    "https://sssaicodeapi.com",
    "https://sssaicodeapi.com/register?ref=DCP0SM",
    "https://node-hk.sssaicodeapi.com/api",
    [],
    {
      modelCatalogURLs: [
        "https://node-hk.sssaicodeapi.com/api/v1/models",
        "https://node-hk.sssaiapi.com/api/v1/models",
        "https://node-cf.sssaicodeapi.com/api/v1/models",
      ],
    },
  ],
  [
    "micu",
    "Micu",
    "anthropic",
    "https://www.micuapi.ai",
    "https://www.micuapi.ai/register?aff=aOYQ",
    "https://www.micuapi.ai/v1",
    [],
    {},
  ],
  [
    "rightcode",
    "RightCode",
    "anthropic",
    "https://www.rightapi.ai",
    "https://www.rightapi.ai/register?aff=CCSWITCH",
    "https://www.rightapi.ai/claude",
    [],
    {},
  ],
  [
    "cubence",
    "Cubence",
    "anthropic",
    "https://cubence.com",
    "https://cubence.com/signup?code=CCSWITCH&source=ccs",
    "https://api.cubence.com/v1",
    [],
    {
      modelCatalogURLs: [
        "https://api.cubence.com/v1/models",
        "https://api-cf.cubence.com/v1/models",
        "https://api-dmit.cubence.com/v1/models",
        "https://api-bwg.cubence.com/v1/models",
      ],
    },
  ],
  [
    "crazyrouter",
    "CrazyRouter",
    "anthropic",
    "https://www.crazyrouter.com",
    "https://www.crazyrouter.com/register?aff=OZcm&ref=cc-switch",
    "https://cn.crazyrouter.com/v1",
    [],
    {},
  ],
  [
    "dmxapi",
    "DMXAPI",
    "anthropic",
    "https://www.dmxapi.cn",
    "https://www.dmxapi.cn",
    "https://www.dmxapi.cn/v1",
    [],
    { modelCatalogURLs: ["https://www.dmxapi.cn/v1/models", "https://api.dmxapi.cn/v1/models"] },
  ],
  [
    "qiniu",
    "Qiniu",
    "anthropic",
    "https://s.qiniu.com/nMvAvy",
    "https://s.qiniu.com/nMvAvy",
    "https://api.qnaigc.com/v1",
    [],
    { modelCatalogURLs: ["https://api.qnaigc.com/v1/models", "https://api.modelink.ai/v1/models"] },
  ],
  [
    "sudocode_chat",
    "SudoCode.chat",
    "anthropic",
    "https://sudocode.chat",
    "https://sudocode.chat/sign-up?aff=CC-SWITCH",
    "https://api.sudocode.chat/v1",
    [],
    {},
  ],
  [
    "sudocode_us",
    "SudoCode.us",
    "anthropic",
    "https://sudocode.us",
    "https://sudocode.us",
    "https://sudocode.us/v1",
    [],
    { modelCatalogURLs: ["https://sudocode.us/v1/models", "https://sudocode.run/v1/models"] },
  ],
  [
    "aihubmix",
    "AiHubMix",
    "anthropic",
    "https://aihubmix.com",
    "https://aihubmix.com",
    "https://aihubmix.com/v1",
    [],
    { modelCatalogURLs: ["https://aihubmix.com/v1/models", "https://api.aihubmix.com/v1/models"] },
  ],
  [
    "amux",
    "Amux",
    "anthropic",
    "https://amux.ai",
    "https://amux.ai",
    "https://api.amux.ai/v1",
    [],
    {},
  ],
  [
    "qianfan_coding",
    "Baidu Qianfan Coding Plan",
    "anthropic",
    "https://cloud.baidu.com/product/qianfan_modelbuilder",
    "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    "https://qianfan.baidubce.com/anthropic/coding",
    ["qianfan-code-latest"],
    {},
  ],
  [
    "bailian",
    "Bailian",
    "anthropic",
    "https://bailian.console.aliyun.com",
    "https://bailian.console.aliyun.com",
    "https://dashscope.aliyuncs.com/apps/anthropic",
    [],
    {},
  ],
  [
    "bailian_coding",
    "Bailian For Coding",
    "anthropic",
    "https://bailian.console.aliyun.com",
    "https://bailian.console.aliyun.com",
    "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    [],
    {},
  ],
  [
    "bailing",
    "BaiLing",
    "anthropic",
    "https://alipaytbox.yuque.com/sxs0ba/ling/get_started",
    "https://alipaytbox.yuque.com/sxs0ba/ling/get_started",
    "https://api.tbox.cn/api/anthropic",
    ["Ling-2.5-1T"],
    {},
  ],
  [
    "cherryin",
    "CherryIN",
    "anthropic",
    "https://open.cherryin.ai",
    "https://open.cherryin.ai/console/token",
    "https://open.cherryin.net",
    ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "anthropic/claude-haiku-4.5"],
    { modelCatalogURLs: ["https://open.cherryin.net/v1/models"] },
  ],
  [
    "codex",
    "Codex",
    "openai",
    "https://openai.com/chatgpt/pricing",
    "https://chatgpt.com",
    "https://chatgpt.com/backend-api/codex",
    ["gpt-5.6-sol", "gpt-5.6-luna"],
    {
      modelCatalogStatus: "manual_only",
      usageStatus: "none",
      usageSource: "OAuth 专用入口，不走普通 API Key 余额查询",
    },
  ],
  [
    "deepseek",
    "DeepSeek",
    "openai",
    "https://platform.deepseek.com",
    "https://platform.deepseek.com/api_keys",
    "https://api.deepseek.com/v1",
    ["deepseek-v4-flash", "deepseek-v4-pro"],
    {
      usageStatus: "fixed",
      usageProvider: "deepseek",
      modelCatalogURLs: [
        "https://api.deepseek.com/v1/models",
        "https://api.deepseek.com/anthropic/v1/models",
      ],
    },
  ],
  [
    "eflowcode",
    "E-FlowCode",
    "anthropic",
    "https://e-flowcode.cc",
    "https://e-flowcode.cc",
    "https://e-flowcode.cc/v1",
    [],
    {},
  ],
  [
    "gemini_native",
    "Gemini Native",
    "gemini",
    "https://ai.google.dev/gemini-api",
    "https://aistudio.google.com/app/apikey",
    "https://generativelanguage.googleapis.com/v1beta",
    ["gemini-2.5-pro", "gemini-2.5-flash"],
    {
      modelCatalogStatus: "gemini_models",
      modelCatalogURLs: ["https://generativelanguage.googleapis.com/v1beta/models"],
      usageStatus: "none",
      usageSource: "Google 官方模型目录；公开用量接口未接入",
    },
  ],
  [
    "github_copilot",
    "GitHub Copilot",
    "openai",
    "https://github.com/features/copilot",
    "https://github.com/settings/copilot",
    "https://api.githubcopilot.com",
    ["claude-sonnet-4-5", "gpt-4.1"],
    {
      modelCatalogStatus: "manual_only",
      usageStatus: "none",
      usageSource: "OAuth 专用入口，不走普通 API Key 余额查询",
    },
  ],
  [
    "longcat",
    "Longcat",
    "anthropic",
    "https://longcat.chat/platform",
    "https://longcat.chat/platform/api_keys",
    "https://api.longcat.chat/anthropic",
    ["LongCat-2.0"],
    {},
  ],
  [
    "minimax",
    "MiniMax",
    "anthropic",
    "https://platform.minimaxi.com",
    "https://platform.minimaxi.com/subscribe/coding-plan",
    "https://api.minimaxi.com/anthropic",
    ["MiniMax-M2.7"],
    { usageStatus: "none", usageSource: "MiniMax Coding Plan 用量接口尚未接入" },
  ],
  [
    "minimax_en",
    "MiniMax en",
    "anthropic",
    "https://platform.minimax.io",
    "https://platform.minimax.io/subscribe/coding-plan",
    "https://api.minimax.io/anthropic",
    ["MiniMax-M2.7"],
    { usageStatus: "none", usageSource: "MiniMax Coding Plan 用量接口尚未接入" },
  ],
  [
    "modelscope",
    "ModelScope",
    "anthropic",
    "https://modelscope.cn",
    "https://modelscope.cn",
    "https://api-inference.modelscope.cn",
    ["ZhipuAI/GLM-5.1"],
    {},
  ],
  [
    "novita",
    "Novita AI",
    "anthropic",
    "https://novita.ai",
    "https://novita.ai",
    "https://api.novita.ai/anthropic",
    ["zai-org/glm-5.1"],
    {
      usageStatus: "fixed",
      usageProvider: "novita",
      usageSource: "Novita 官方 CLI /v3/user 账户余额接口",
      source: "official_cli",
      verification: "official_cli",
      modelCatalogURLs: ["https://api.novita.ai/anthropic/v1/models"],
    },
  ],
  [
    "nvidia",
    "Nvidia",
    "openai",
    "https://build.nvidia.com",
    "https://build.nvidia.com/settings/api-keys",
    "https://integrate.api.nvidia.com/v1",
    ["moonshotai/kimi-k2.5"],
    {},
  ],
  [
    "opencode_go",
    "OpenCode Go",
    "openai",
    "https://opencode.ai/go",
    "https://opencode.ai/go?ref=2YTRG2NGTX",
    "https://opencode.ai/zen/go",
    ["deepseek-v4-flash"],
    { modelCatalogURLs: ["https://opencode.ai/zen/go/v1/models"] },
  ],
  [
    "openrouter",
    "OpenRouter",
    "openai",
    "https://openrouter.ai",
    "https://openrouter.ai/keys",
    "https://openrouter.ai/api/v1",
    ["openai/gpt-4.1", "anthropic/claude-sonnet-4"],
    {
      usageStatus: "fixed",
      usageProvider: "openrouter",
      modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
    },
  ],
  [
    "pipellm",
    "PIPELLM",
    "anthropic",
    "https://code.pipellm.ai",
    "https://code.pipellm.ai/login?ref=uvw650za",
    "https://cc-api.pipellm.ai/v1",
    [],
    {},
  ],
  [
    "relaxycode",
    "RelaxyCode",
    "anthropic",
    "https://www.relaxycode.com",
    "https://www.relaxycode.com/register",
    "https://www.relaxycode.com/v1",
    [],
    {},
  ],
  [
    "stepfun",
    "StepFun Step Plan",
    "openai",
    "https://platform.stepfun.com/step-plan",
    "https://platform.stepfun.com/interface-key",
    "https://api.stepfun.com/step_plan",
    ["step-3.5-flash-2603"],
    {
      usageStatus: "none",
      usageSource: "StepFun 余额接口尚未接入",
      modelCatalogURLs: [
        "https://api.stepfun.com/step_plan/v1/models",
        "https://api.stepfun.com/v1/models",
      ],
    },
  ],
  [
    "stepfun_en",
    "StepFun Step Plan en",
    "openai",
    "https://platform.stepfun.ai/step-plan",
    "https://platform.stepfun.ai/interface-key",
    "https://api.stepfun.ai/step_plan",
    ["step-3.5-flash-2603"],
    {
      usageStatus: "none",
      usageSource: "StepFun 余额接口尚未接入",
      modelCatalogURLs: [
        "https://api.stepfun.ai/step_plan/v1/models",
        "https://api.stepfun.ai/v1/models",
      ],
    },
  ],
  [
    "stepfun_api",
    "StepFun API (China)",
    "openai",
    "https://platform.stepfun.com",
    "https://platform.stepfun.com/interface-key",
    "https://api.stepfun.com/v1",
    [],
    {
      modelCatalogURLs: ["https://api.stepfun.com/v1/models"],
      usageStatus: "fixed",
      usageProvider: "stepfun",
      usageSource: "StepFun 官方 /v1/accounts 账户余额接口",
      source: "official_docs",
      verification: "official_docs",
    },
  ],
  [
    "stepfun_api_en",
    "StepFun API (International)",
    "openai",
    "https://platform.stepfun.ai",
    "https://platform.stepfun.ai/interface-key",
    "https://api.stepfun.ai/v1",
    [],
    {
      modelCatalogURLs: ["https://api.stepfun.ai/v1/models"],
      usageStatus: "fixed",
      usageProvider: "stepfun",
      usageSource: "StepFun 官方 /v1/accounts 账户余额接口",
      source: "official_docs",
      verification: "official_docs",
    },
  ],
  [
    "therouter",
    "TheRouter",
    "anthropic",
    "https://therouter.ai",
    "https://dashboard.therouter.ai",
    "https://api.therouter.ai/v1",
    ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"],
    {},
  ],
  [
    "xai",
    "xAI (Grok)",
    "openai",
    "https://x.ai/grok",
    "https://console.x.ai",
    "https://api.x.ai/v1",
    ["grok-4.5"],
    {},
  ],
  [
    "xiaomi_mimo",
    "Xiaomi MiMo",
    "anthropic",
    "https://platform.xiaomimimo.com",
    "https://platform.xiaomimimo.com/#/console/api-keys",
    "https://api.xiaomimimo.com/anthropic",
    ["mimo-v2.5-pro"],
    {},
  ],
  [
    "xiaomi_mimo_token_plan_cn",
    "Xiaomi MiMo Token Plan (China)",
    "anthropic",
    "https://platform.xiaomimimo.com/#/token-plan",
    "https://platform.xiaomimimo.com/#/console/plan-manage",
    "https://token-plan-cn.xiaomimimo.com/anthropic",
    ["mimo-v2.5-pro"],
    { usageStatus: "none", usageSource: "Token Plan 用量接口未在当前后端核验" },
  ],
  [
    "zhipu_glm",
    "Zhipu GLM",
    "anthropic",
    "https://open.bigmodel.cn",
    "https://www.bigmodel.cn/claude-code?ic=RRVJPB5SII",
    "https://open.bigmodel.cn/api/anthropic",
    ["glm-5.1"],
    {
      usageStatus: "token_plan",
      usageProvider: "zhipu",
      modelCatalogURLs: ["https://open.bigmodel.cn/api/anthropic/v1/models"],
    },
  ],
  [
    "zhipu_glm_en",
    "Zhipu GLM en",
    "anthropic",
    "https://z.ai",
    "https://z.ai/subscribe?ic=8JVLJQFSKB",
    "https://api.z.ai/api/anthropic",
    ["glm-5.1"],
    {
      usageStatus: "token_plan",
      usageProvider: "zhipu",
      modelCatalogURLs: ["https://api.z.ai/api/anthropic/v1/models"],
    },
  ],
  [
    "kimi-global",
    "Kimi Global",
    "openai",
    "",
    "https://platform.kimi.ai/console/api-keys?aff=cc-switch",
    "https://api.moonshot.ai/v1",
    ["kimi-k3"],
    {
      modelCatalogURLs: ["https://api.moonshot.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "hao-ai",
    "hao.ai",
    "openai",
    "https://hao.ai",
    "https://hao.ai/invite/DTBZS3OR",
    "https://api.hao.ai/v1",
    ["openai/gpt-5.6-sol"],
    {
      modelCatalogURLs: ["https://api.hao.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "openmodel",
    "OpenModel",
    "openai",
    "https://www.openmodel.ai",
    "https://www.openmodel.ai?ref=cc-switch",
    "https://api.openmodel.ai/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.openmodel.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "grooroute-pro",
    "GrooRoute Pro",
    "openai",
    "https://grooroute.pro",
    "https://grooroute.pro/sign-up?aff=qqm9",
    "https://grooroute.pro/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://grooroute.pro/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "dit-ai",
    "DIT.ai",
    "openai",
    "https://dit.ai",
    "https://dit.ai?utm_source=ccswitch",
    "https://api.dit.ai/v1",
    ["gpt-5.6-sol"],
    {
      modelCatalogURLs: ["https://api.dit.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "buytoken",
    "BuyToken",
    "openai",
    "https://buytoken.work",
    "https://buytoken.work/sign-up?aff=cc-switch",
    "https://api.buytoken.work/v1",
    ["gpt-5.6-sol"],
    {
      modelCatalogURLs: ["https://api.buytoken.work/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "v-api",
    "V-API",
    "openai",
    "https://gpt.ge",
    "https://gpt.ge/signup?aff=URNP",
    "https://api.gpt.ge/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.gpt.ge/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "tokenfactory",
    "TokenFactory",
    "openai",
    "https://tokenfactory.cn",
    "https://console.tokenfactory.cn/login",
    "https://api.tokenfactory.cn/v1",
    ["glm-5.3"],
    {
      modelCatalogURLs: ["https://api.tokenfactory.cn/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "fluxa-token-plan",
    "FluxA Token Plan",
    "openai",
    "https://agentmarket.fluxapay.xyz/",
    "https://agentmarket.fluxapay.xyz/marketplace/tokenplans",
    "https://api.baiduqianfan.ai/v2/tokenplan/team",
    ["deepseek-v4-pro"],
    {
      usageStatus: "none",
    },
  ],
  [
    "88api",
    "88API",
    "openai",
    "https://88api.ai",
    "https://88api.ai/sign-up?aff=HSGY",
    "https://api.88api.ai/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.88api.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "9527code",
    "9527CODE",
    "openai",
    "https://9527.codes",
    "https://9527.codes/register?aff=e5zI",
    "https://9527.codes/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://9527.codes/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "ppio",
    "PPIO",
    "openai",
    "https://ppio.com",
    "https://ppio.com/activity/ccswitch",
    "https://api.ppio.com/openai/v1",
    ["deepseek/deepseek-v4.1-flash"],
    {
      modelCatalogURLs: ["https://api.ppio.com/openai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "coding-plan",
    "火山 Coding Plan",
    "openai",
    "",
    "",
    "https://ark.cn-beijing.volces.com/api/coding/v3",
    ["ark-code-latest"],
    {
      usageStatus: "none",
    },
  ],
  [
    "volcengine-doubao",
    "Volcengine Doubao",
    "openai",
    "",
    "",
    "https://ark.cn-beijing.volces.com/api/v3",
    ["doubao-seed-2-1-pro-260915"],
    {
      usageStatus: "none",
    },
  ],
  [
    "soleapi",
    "SoleAPI",
    "openai",
    "https://soleapi.com",
    "https://soleapi.com/r/ccswitch",
    "https://soleapi.com/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://soleapi.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "xycai",
    "XycAi",
    "openai",
    "https://xycai.us",
    "https://xycai.us/register?aff=Uhu9",
    "https://apicdn.xycai.us/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://apicdn.xycai.us/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "modelflare",
    "Modelflare",
    "openai",
    "https://modelflare.dev",
    "https://modelflare.dev",
    "https://modelflare.dev/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://modelflare.dev/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "alltokens",
    "AllTokens",
    "openai",
    "https://alltokens.cc",
    "https://alltokens.cc/register",
    "https://alltokens.cc/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://alltokens.cc/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "alltokens-si",
    "AllTokens SI",
    "openai",
    "https://alltokens.si",
    "https://alltokens.si/enterprise-register",
    "https://alltokens.si/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://alltokens.si/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "tu-zi",
    "Tu-zi",
    "openai",
    "https://api.tu-zi.com",
    "https://api.tu-zi.com/token",
    "https://api.tu-zi.com/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.tu-zi.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "soshow",
    "Soshow",
    "openai",
    "https://aimarket.so-show.com",
    "https://aimarket.so-show.com/workbench/access-key",
    "https://maas.so-show.com/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://maas.so-show.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "baidu-qianfan",
    "Baidu Qianfan",
    "openai",
    "https://cloud.baidu.com/product/qianfan_modelbuilder",
    "https://cloud.baidu.com/product/qianfan_modelbuilder",
    "https://qianfan.baidubce.com/v2",
    ["deepseek-v4-pro"],
    {
      usageStatus: "none",
    },
  ],
  [
    "baidu-qianfan-token-plan",
    "Baidu Qianfan Token Plan",
    "openai",
    "https://cloud.baidu.com/product/codingplan.html",
    "https://console.bce.baidu.com/qianfan/resource/token-plan",
    "https://qianfan.baidubce.com/v2/tokenplan/personal",
    ["deepseek-v4-pro"],
    {
      usageStatus: "none",
    },
  ],
  [
    "qwencloud-cn",
    "千问AI平台",
    "openai",
    "https://platform.qianwenai.com/?utm_content=g_20000002971",
    "https://platform.qianwenai.com/?utm_content=g_20000002971",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ["qwen3.8-max"],
    {
      modelCatalogURLs: ["https://dashscope.aliyuncs.com/compatible-mode/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "qwencloud-cn-token-plan",
    "千问AI平台 Token Plan",
    "openai",
    "",
    "",
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    ["qwen3.8-max"],
    {
      modelCatalogURLs: [
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models",
      ],
      usageStatus: "none",
    },
  ],
  [
    "qwencloud",
    "QwenCloud",
    "openai",
    "https://home.qwencloud.com/?utm_content=g_20000002974",
    "https://home.qwencloud.com/api-keys?utm_content=g_20000002975",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ["qwen3.8-max"],
    {
      modelCatalogURLs: ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "qwencloud-for-coding",
    "QwenCloud For Coding",
    "openai",
    "https://www.qwencloud.com",
    "https://home.qwencloud.com/api-keys",
    "https://coding-intl.dashscope.aliyuncs.com/v1",
    ["qwen3.7-plus"],
    {
      modelCatalogURLs: ["https://coding-intl.dashscope.aliyuncs.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "qwencloud-token-plan",
    "QwenCloud Token Plan",
    "openai",
    "",
    "https://home.qwencloud.com/api-keys?utm_content=g_20000002981",
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ["qwen3.8-max"],
    {
      modelCatalogURLs: [
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
      ],
      usageStatus: "none",
    },
  ],
  [
    "tencent-hunyuan",
    "Tencent Hunyuan",
    "openai",
    "https://cloud.tencent.com/product/tokenhub",
    "https://console.cloud.tencent.com/tokenhub/apikey",
    "https://tokenhub.tencentmaas.com/v1",
    ["hy3"],
    {
      modelCatalogURLs: ["https://tokenhub.tencentmaas.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "tencent-token-plan",
    "Tencent Token Plan",
    "openai",
    "https://cloud.tencent.com/product/tokenhub",
    "https://console.cloud.tencent.com/tokenhub/tokenplan",
    "https://api.lkeap.cloud.tencent.com/plan/v3",
    ["tc-code-latest"],
    {
      usageStatus: "none",
    },
  ],
  [
    "tencent-token-plan-intl",
    "Tencent Token Plan (Intl)",
    "openai",
    "https://www.tencentcloud.com/products/tokenhub",
    "https://console.tencentcloud.com/tokenhub/tokenplan",
    "https://tokenhub-intl.tencentcloudmaas.com/plan/v3",
    ["auto"],
    {
      usageStatus: "none",
    },
  ],
  [
    "tencent-token-plan-enterprise-pro",
    "Tencent Token Plan Enterprise Pro",
    "openai",
    "https://cloud.tencent.com/product/tokenhub",
    "https://console.cloud.tencent.com/tokenhub/tokenplan-e",
    "https://tokenhub.tencentmaas.com/plan/v3",
    ["auto"],
    {
      usageStatus: "none",
    },
  ],
  [
    "tencent-token-plan-enterprise-pro-intl",
    "Tencent Token Plan Enterprise Pro (Intl)",
    "openai",
    "https://www.tencentcloud.com/products/tokenhub",
    "https://console.tencentcloud.com/tokenhub/tokenplan-e",
    "https://tokenhub-intl.tencentcloudmaas.com/plan/v3",
    ["auto"],
    {
      usageStatus: "none",
    },
  ],
  [
    "tencent-token-plan-enterprise-lite",
    "Tencent Token Plan Enterprise Lite",
    "openai",
    "https://cloud.tencent.com/product/tokenhub",
    "https://console.cloud.tencent.com/tokenhub/tokenplan-e",
    "https://tokenhub.tencentmaas.com/plan/v3",
    ["auto"],
    {
      usageStatus: "none",
    },
  ],
  [
    "tencent-token-plan-enterprise-lite-intl",
    "Tencent Token Plan Enterprise Lite (Intl)",
    "openai",
    "https://www.tencentcloud.com/products/tokenhub",
    "https://console.tencentcloud.com/tokenhub/tokenplan-e",
    "https://tokenhub-intl.tencentcloudmaas.com/plan/v3",
    ["auto"],
    {
      usageStatus: "none",
    },
  ],
  [
    "streamlake",
    "StreamLake",
    "openai",
    "https://www.streamlake.com",
    "https://console.streamlake.com/console/wanqing/api-key",
    "https://wanqing.streamlakeapi.com/api/gateway/v1/endpoints",
    ["kat-coder-pro-v2.5"],
    {
      usageStatus: "none",
    },
  ],
  [
    "streamlake-en",
    "StreamLake en",
    "openai",
    "https://console.streamlake.ai",
    "https://console.streamlake.ai/console/api-key",
    "https://vanchin.streamlake.ai/api/gateway/v1/endpoints",
    ["kat-coder-pro-v2.5"],
    {
      usageStatus: "none",
    },
  ],
  [
    "astron-coding-plan",
    "Astron Coding Plan",
    "openai",
    "https://maas.xfyun.cn/packageSubscription",
    "https://maas.xfyun.cn/packageSubscription",
    "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1",
    ["astron-code-latest"],
    {
      modelCatalogURLs: ["https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "baseten",
    "Baseten",
    "openai",
    "https://www.baseten.co",
    "https://app.baseten.co/settings/api_keys",
    "https://inference.baseten.co/v1",
    ["zai-org/GLM-5.3"],
    {
      modelCatalogURLs: ["https://inference.baseten.co/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "ollama-cloud",
    "Ollama Cloud",
    "openai",
    "https://ollama.com",
    "https://ollama.com/settings/keys",
    "https://ollama.com/v1",
    ["glm-5.3"],
    {
      modelCatalogURLs: ["https://ollama.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "ollama",
    "Ollama",
    "openai",
    "https://ollama.com",
    "https://ollama.com",
    "http://localhost:11434/v1",
    ["gpt-oss:20b"],
    {
      usageStatus: "none",
    },
  ],
  [
    "lm-studio",
    "LM Studio",
    "openai",
    "https://lmstudio.ai",
    "https://lmstudio.ai",
    "http://localhost:1234/v1",
    ["openai/gpt-oss-20b"],
    {
      usageStatus: "none",
    },
  ],
  [
    "llama-cpp",
    "llama.cpp",
    "openai",
    "https://github.com/ggml-org/llama.cpp",
    "https://github.com/ggml-org/llama.cpp",
    "http://127.0.0.1:9931/v1",
    ["ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF"],
    {
      usageStatus: "none",
    },
  ],
  [
    "vllm",
    "vLLM",
    "openai",
    "https://vllm.ai",
    "https://vllm.ai",
    "http://localhost:8000/v1",
    ["Qwen/Qwen3.6-27B"],
    {
      usageStatus: "none",
    },
  ],
  [
    "meta-model-api",
    "Meta Model API",
    "openai",
    "https://dev.meta.ai",
    "https://dev.meta.ai",
    "https://api.meta.ai/v1",
    ["muse-wonder-1.0"],
    {
      modelCatalogURLs: ["https://api.meta.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "deepinfra",
    "DeepInfra",
    "openai",
    "https://deepinfra.com",
    "https://deepinfra.com/dash/api_keys",
    "https://api.deepinfra.com/v1",
    ["deepseek-ai/DeepSeek-V4.1-Flash-1017"],
    {
      modelCatalogURLs: ["https://api.deepinfra.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "vercel-ai-gateway",
    "Vercel AI Gateway",
    "openai",
    "https://vercel.com/ai-gateway",
    "https://vercel.com/ai-gateway",
    "https://ai-gateway.vercel.sh/codex/v1",
    ["openai/gpt-6-astra"],
    {
      modelCatalogURLs: ["https://ai-gateway.vercel.sh/codex/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "nebius-token-factory",
    "Nebius Token Factory",
    "openai",
    "https://nebius.com/token-factory",
    "https://tokenfactory.nebius.com/project/api-keys",
    "https://api.tokenfactory.nebius.com/v1",
    ["zai-org/GLM-5.3"],
    {
      modelCatalogURLs: ["https://api.tokenfactory.nebius.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "groq",
    "Groq",
    "openai",
    "https://groq.com",
    "https://console.groq.com/keys",
    "https://api.groq.com/openai/v1",
    ["openai/gpt-oss-120b"],
    {
      modelCatalogURLs: ["https://api.groq.com/openai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "sambanova",
    "SambaNova",
    "openai",
    "https://sambanova.ai",
    "https://cloud.sambanova.ai/apis",
    "https://api.sambanova.ai/v1",
    ["MiniMax-M3"],
    {
      modelCatalogURLs: ["https://api.sambanova.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "digitalocean",
    "DigitalOcean",
    "openai",
    "https://www.digitalocean.com/products/ai-platform",
    "https://cloud.digitalocean.com/model-studio/manage-keys",
    "https://inference.do-ai.run/v1",
    ["openai-gpt-6-1-sol"],
    {
      modelCatalogURLs: ["https://inference.do-ai.run/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "hugging-face",
    "Hugging Face",
    "openai",
    "https://huggingface.co/inference/models",
    "https://huggingface.co/inference/models",
    "https://router.huggingface.co/v1",
    ["zai-org/GLM-5.3:baseten"],
    {
      modelCatalogURLs: ["https://router.huggingface.co/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "fireworks-ai",
    "Fireworks AI",
    "openai",
    "https://fireworks.ai",
    "https://app.fireworks.ai/settings/users/api-keys",
    "https://api.fireworks.ai/inference/v1",
    ["accounts/fireworks/models/glm-5p3"],
    {
      modelCatalogURLs: ["https://api.fireworks.ai/inference/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "mistral-ai",
    "Mistral AI",
    "openai",
    "https://mistral.ai",
    "https://console.mistral.ai/api-keys",
    "https://api.mistral.ai/v1",
    ["mistral-medium-3-5"],
    {
      modelCatalogURLs: ["https://api.mistral.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "cloudflare-ai-gateway",
    "Cloudflare AI Gateway",
    "openai",
    "https://developers.cloudflare.com/ai-gateway/",
    "https://dash.cloudflare.com/profile/api-tokens",
    "https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/default/openai",
    ["gpt-6.1-sol"],
    {
      usageStatus: "none",
    },
  ],
  [
    "opencode-zen",
    "OpenCode Zen",
    "openai",
    "https://opencode.ai/zen",
    "https://opencode.ai/auth",
    "https://opencode.ai/zen/v1",
    ["gpt-6-sol"],
    {
      modelCatalogURLs: ["https://opencode.ai/zen/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "jiekou-ai",
    "JieKou AI",
    "openai",
    "https://jiekou.ai/#model-library",
    "https://jiekou.ai/settings/key-management",
    "https://api.jiekou.ai/openai/v1",
    ["claude-fable-5-1"],
    {
      modelCatalogURLs: ["https://api.jiekou.ai/openai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "aicodewith",
    "AICodeWith",
    "openai",
    "https://aicodewith.ai",
    "https://aicodewith.ai/login?tab=register",
    "https://api.aicodewith.ai/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.aicodewith.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "command-code",
    "Command Code",
    "openai",
    "https://commandcode.ai",
    "https://commandcode.ai/settings/keys",
    "https://api.commandcode.ai/provider/v1",
    ["deepseek/deepseek-v4.1-flash"],
    {
      modelCatalogURLs: ["https://api.commandcode.ai/provider/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "moark",
    "模力方舟",
    "openai",
    "https://moark.com",
    "https://moark.com/dashboard/tokens",
    "https://moark.com/v1",
    ["deepseek-v4.1-flash"],
    {
      modelCatalogURLs: ["https://moark.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "soruxgpt",
    "SoruxGPT",
    "openai",
    "https://ai.soruxgpt.com",
    "https://ai.soruxgpt.com/console/token",
    "https://ai.soruxgpt.com/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://ai.soruxgpt.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "soruxgpt-coding-plan",
    "SoruxGPT Coding Plan",
    "openai",
    "https://app.soruxgpt.com",
    "https://app.soruxgpt.com",
    "https://app.soruxgpt.com/api/codex",
    ["gpt-6.1-sol"],
    {
      usageStatus: "none",
    },
  ],
  [
    "ikuncode",
    "IKunCode",
    "openai",
    "https://api.ikuncode.ai",
    "https://api.ikuncode.ai/console/token",
    "https://api.ikuncode.ai/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.ikuncode.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "runtoken",
    "RunToken",
    "openai",
    "https://www.runtoken.ai",
    "https://www.runtoken.ai/console/token",
    "https://www.runtoken.ai/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://www.runtoken.ai/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "botcf",
    "BotCF",
    "openai",
    "https://botcf.com",
    "https://botcf.com/console/token",
    "https://botcf.com/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://botcf.com/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "yylx",
    "YYLX",
    "openai",
    "https://yylx.io",
    "https://app.yylx.io/keys",
    "https://app.yylx.io/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://app.yylx.io/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "tokenflux",
    "TokenFlux",
    "openai",
    "https://tokenflux.dev",
    "https://tokenflux.dev/keys",
    "https://tokenflux.dev/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://tokenflux.dev/v1/models"],
      usageStatus: "none",
    },
  ],
  [
    "aicoming",
    "AIComing",
    "openai",
    "https://aicoming.top",
    "https://aicoming.top/console#keys",
    "https://api.aicoming.top/v1",
    ["gpt-6.1-sol"],
    {
      modelCatalogURLs: ["https://api.aicoming.top/v1/models"],
      usageStatus: "none",
    },
  ],
];

const SUPPLIER_LABEL_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function compareSupplierRows(left: SupplierCatalogRow, right: SupplierCatalogRow): number {
  const labelOrder = SUPPLIER_LABEL_COLLATOR.compare(left[1], right[1]);
  return labelOrder || String(left[0]).localeCompare(String(right[0]));
}

const supplierRows = catalogRows
  .slice()
  .sort(compareSupplierRows)
  .map(([id, label, type, websiteURL, apiKeyURL, baseURL, models, options]) =>
    createTemplate({ id, label, type, websiteURL, apiKeyURL, baseURL, models, ...options }),
  );

export const SUPPLIER_TEMPLATES: readonly SupplierTemplate[] = [...coreTemplates, ...supplierRows];

const customTemplate = coreTemplates[0]!;
const supplierByID = new Map<string, SupplierTemplate>(
  SUPPLIER_TEMPLATES.map((item) => [item.id, item]),
);
const compatibilityTemplates = new Map<string, SupplierTemplate>([
  [
    "moonshot",
    createTemplate({
      id: "moonshot",
      label: "Kimi / Moonshot（兼容配置）",
      type: "openai",
      baseURL: "https://api.moonshot.cn/v1",
      models: ["kimi-k2.5", "moonshot-v1-128k"],
      usageStatus: "fixed",
      usageProvider: "moonshot",
      modelCatalogURLs: ["https://api.moonshot.cn/v1/models"],
    }),
  ],
  [
    "zhipu",
    createTemplate({
      id: "zhipu",
      label: "Zhipu GLM（兼容配置）",
      type: "openai",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      models: ["glm-4.5", "glm-4.6"],
      usageStatus: "token_plan",
      usageProvider: "zhipu",
    }),
  ],
  [
    "zhipu_team",
    createTemplate({
      id: "zhipu_team",
      label: "Zhipu GLM Team（兼容配置）",
      type: "openai",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      models: ["glm-4.5", "glm-4.6"],
      usageStatus: "token_plan",
      usageProvider: "zhipu_team",
    }),
  ],
  [
    "zenmux",
    createTemplate({
      id: "zenmux",
      label: "ZenMux（兼容配置）",
      type: "anthropic",
      baseURL: "https://zenmux.ai/api/anthropic",
      usageStatus: "none",
      usageSource: "ZenMux 套餐用量接口尚未接入",
    }),
  ],
  [
    "volcengine",
    createTemplate({
      id: "volcengine",
      label: "火山方舟（兼容配置）",
      type: "openai",
      baseURL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      models: ["doubao-seed-code"],
      usageStatus: "none",
      usageSource: "火山方舟套餐用量接口尚未接入",
    }),
  ],
  [
    "unity2",
    createTemplate({
      id: "unity2",
      label: "Unity2.ai（兼容配置）",
      type: "anthropic",
      baseURL: "https://api.unity2.ai/v1",
    }),
  ],
]);

export function supplierTemplate(id: unknown): SupplierTemplate {
  const normalizedID =
    String(id || "custom")
      .trim()
      .toLowerCase() || "custom";
  const direct = supplierByID.get(normalizedID);
  if (direct) return direct;
  return compatibilityTemplates.get(normalizedID) ?? customTemplate;
}

export function supplierSelectOptions(currentID: unknown = ""): SupplierSelectOption[] {
  const options = SUPPLIER_TEMPLATES.map(({ id, label, iconURL, iconLight }) => ({
    value: id,
    label,
    iconURL,
    iconLight,
  }));
  const normalizedID = String(currentID || "")
    .trim()
    .toLowerCase();
  const compatibility = compatibilityTemplates.get(normalizedID);
  if (compatibility) {
    options.push({
      value: compatibility.id,
      label: compatibility.label,
      iconURL: compatibility.iconURL,
      iconLight: compatibility.iconLight,
    });
  }
  return options;
}

export function supplierUsageStatus(id: unknown): SupplierUsage {
  return supplierTemplate(id)?.usage || supplierTemplate("custom").usage;
}

export function supplierUsageRequest(adapterOrID: unknown): SupplierUsageRequest {
  const adapter =
    adapterOrID && typeof adapterOrID === "object" ? (adapterOrID as SupplierUsageAdapter) : null;
  const id =
    String(adapter ? adapter.supplierID : adapterOrID || "custom")
      .trim()
      .toLowerCase() || "custom";
  if (adapter) {
    const profile = String(adapter.balanceProfile || "")
      .trim()
      .toLowerCase();
    if (profile === "none") return { status: "none", provider: "" };
    if (profile === "custom") return { status: "custom_only", provider: "" };
    if (profile === "" || profile === "auto") {
      const queryURL = String(adapter.balanceQueryURL || "").trim();
      const queryField = String(adapter.balanceQueryField || "").trim();
      if (queryURL && queryField) return { status: "custom_only", provider: "" };
    }
    if (profile === "general") return { status: "general", provider: "" };
    if (profile === "newapi") return { status: "newapi", provider: "" };
    if (profile === "token_plan") {
      const usage = supplierUsageStatus(id);
      return {
        status: "token_plan",
        provider: String(adapter.balanceCodingPlanProvider || usage.provider || ""),
      };
    }
    if (profile === "official") {
      const usage = supplierUsageStatus(id);
      return { status: "fixed", provider: usage.provider || "" };
    }
  }
  const usage = supplierUsageStatus(id);
  return { status: usage.status || "", provider: usage.provider || "" };
}

export function supplierModelCatalog(id: unknown): SupplierModelCatalog {
  return supplierTemplate(id)?.modelCatalog || supplierTemplate("custom").modelCatalog;
}
