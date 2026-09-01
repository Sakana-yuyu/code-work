import * as Schema from "effect/Schema";

export const PROMPT_INJECTION_MODE_REPLACE = "replace" as const;
export const PROMPT_INJECTION_MODE_APPEND = "append" as const;
export const MANAGED_PROMPT_BEGIN = "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->";
export const MANAGED_PROMPT_END = "<!-- CODEX-X:INSTRUCTIONS:END -->";
export const FAKE_MODEL_ID_PLACEHOLDER = "{{FAKE_MODEL_ID}}";

export const SOFTWARE_CHINESE_PROMPT = `语言策略（软件中文化）：
- 默认使用简体中文回答用户，并使用中文解释思路、状态、计划和结果。
- 如果用户明确要求其他语言，遵循用户的语言要求；不要擅自改写或翻译用户原文。
- 代码、代码标识符、函数名、变量名、文件名、路径、命令、API 名称、JSON/schema、协议字段和错误原文必须保持准确；除非用户明确要求，不要翻译或改动这些技术内容。
- 工具调用的名称、参数、JSON 结构和 schema 必须保持不变；不要在工具调用中加入解释性文本。
- 面向用户的说明可以中文化，但引用的日志、错误、命令输出和代码片段应保留原文；不要改变响应解析所需的格式。`;

export const PromptInjectionMode = Schema.Literals([
  PROMPT_INJECTION_MODE_REPLACE,
  PROMPT_INJECTION_MODE_APPEND,
]);
export type PromptInjectionMode = typeof PromptInjectionMode.Type;

export const PromptTemplateEntry = Schema.Struct({
  name: Schema.String,
  content: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
});
export type PromptTemplateEntry = typeof PromptTemplateEntry.Type;

export const PromptTemplateConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  softwareChineseEnabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
  selectedTemplate: Schema.optional(Schema.String),
  localContent: Schema.optional(Schema.String),
  cacheContent: Schema.optional(Schema.String),
  templates: Schema.optional(Schema.Array(PromptTemplateEntry)),
  customEnabled: Schema.optional(Schema.Boolean),
  customContent: Schema.optional(Schema.String),
});
export type PromptTemplateConfig = typeof PromptTemplateConfig.Type;

export interface NormalizedPromptTemplateConfig {
  readonly enabled: boolean;
  readonly softwareChineseEnabled: boolean;
  readonly mode: PromptInjectionMode;
  readonly repo: string;
  readonly ref: string;
  readonly sourceUrl: string;
  readonly selectedTemplate: string;
  readonly localContent: string;
  readonly cacheContent: string;
  readonly templates: readonly PromptTemplateEntry[];
  readonly customEnabled: boolean;
  readonly customContent: string;
}

export const DEFAULT_PROMPT_TEMPLATE_CONFIG = {
  enabled: false,
  softwareChineseEnabled: false,
  mode: PROMPT_INJECTION_MODE_REPLACE,
  repo: "yynxxxxx/Codex-X",
  ref: "main",
  sourceUrl: "",
  selectedTemplate: "gpt5.5-unrestricted.md",
  localContent: "",
  cacheContent: "",
  templates: [],
  customEnabled: false,
  customContent: "",
} as const satisfies NormalizedPromptTemplateConfig;

const DOCUMENTATION_ONLY_LINES = new Set(["# 通用系统提示词", "# 模式静态补充", "---"]);

export function normalizePromptTemplateConfig(
  config: PromptTemplateConfig,
): NormalizedPromptTemplateConfig {
  const selectedTemplate =
    nonEmpty(config.selectedTemplate) ?? DEFAULT_PROMPT_TEMPLATE_CONFIG.selectedTemplate;
  const localContent = config.localContent ?? "";
  const templates =
    (config.templates?.length ?? 0) > 0
      ? config.templates!.map((template) => ({ ...template, name: template.name.trim() }))
      : localContent.trim()
        ? [{ name: selectedTemplate, content: localContent, enabled: config.enabled ?? false }]
        : [];

  return {
    enabled: config.enabled ?? false,
    softwareChineseEnabled: config.softwareChineseEnabled ?? false,
    mode:
      config.mode?.trim() === PROMPT_INJECTION_MODE_APPEND
        ? PROMPT_INJECTION_MODE_APPEND
        : PROMPT_INJECTION_MODE_REPLACE,
    repo: nonEmpty(config.repo) ?? DEFAULT_PROMPT_TEMPLATE_CONFIG.repo,
    ref: nonEmpty(config.ref) ?? DEFAULT_PROMPT_TEMPLATE_CONFIG.ref,
    sourceUrl: config.sourceUrl?.trim() ?? "",
    selectedTemplate,
    localContent,
    cacheContent: config.cacheContent ?? "",
    templates,
    customEnabled: config.customEnabled ?? false,
    customContent: config.customContent ?? "",
  };
}

export function applyPromptTemplate(base: string, input: PromptTemplateConfig): string {
  const config = normalizePromptTemplateConfig(input);
  if (!config.enabled && !config.customEnabled && !config.softwareChineseEnabled) return base;

  let result = base;
  if (config.enabled) {
    const content = templateContent(config);
    if (content) {
      result =
        config.mode === PROMPT_INJECTION_MODE_APPEND
          ? `${result}\n\n${MANAGED_PROMPT_BEGIN}\n${content}\n${MANAGED_PROMPT_END}`
          : content;
    }
  }
  if (config.customEnabled && config.customContent.trim()) {
    result = `${result.trim()}\n\n${config.customContent.trim()}`;
  }
  if (config.softwareChineseEnabled) {
    result = `${result.trim()}\n\n${SOFTWARE_CHINESE_PROMPT}`;
  }
  return result;
}

export function renderPromptTemplate(text: string, modelName: string): string {
  const replacement = modelName.trim() || "当前请求模型";
  return text.replaceAll(FAKE_MODEL_ID_PLACEHOLDER, replacement);
}

export function sanitizePromptDocumentationLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !DOCUMENTATION_ONLY_LINES.has(line.trim()))
    .join("\n")
    .trim();
}

export function preparePromptTemplate(text: string, modelName: string): string {
  return renderPromptTemplate(sanitizePromptDocumentationLines(text), modelName);
}

export function isSafeGitHubOwnerRepo(value: string): boolean {
  const parts = value.trim().split("/");
  return parts.length === 2 && parts.every(isSafeGitHubPathSegment);
}

export function isSafeMarkdownTemplateName(value: string): boolean {
  const name = value.trim();
  return (
    name.length > 3 &&
    name.toLowerCase().endsWith(".md") &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

function templateContent(config: NormalizedPromptTemplateConfig): string {
  if (config.templates.length > 0) {
    return config.templates
      .filter((template) => template.enabled && template.content?.trim())
      .map((template) => template.content!.trim())
      .join("\n\n");
  }
  return config.localContent.trim() || config.cacheContent.trim();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isSafeGitHubPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(value)
  );
}
