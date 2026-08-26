import { describe, expect, it } from "vite-plus/test";

import {
  applyPromptTemplate,
  isSafeGitHubOwnerRepo,
  isSafeMarkdownTemplateName,
  MANAGED_PROMPT_BEGIN,
  MANAGED_PROMPT_END,
  normalizePromptTemplateConfig,
  preparePromptTemplate,
  renderPromptTemplate,
  sanitizePromptDocumentationLines,
  SOFTWARE_CHINESE_PROMPT,
} from "./PromptTemplate.ts";

describe("normalizePromptTemplateConfig", () => {
  it("applies defaults and migrates the legacy single prompt into a template list", () => {
    expect(
      normalizePromptTemplateConfig({
        enabled: true,
        mode: "unknown",
        selectedTemplate: " legacy.md ",
        localContent: "legacy prompt",
      }),
    ).toMatchObject({
      enabled: true,
      mode: "replace",
      repo: "yynxxxxx/Codex-X",
      ref: "main",
      selectedTemplate: "legacy.md",
      templates: [{ name: "legacy.md", content: "legacy prompt", enabled: true }],
    });
  });

  it("keeps an explicit multi-template list and trims names", () => {
    expect(
      normalizePromptTemplateConfig({
        enabled: true,
        localContent: "legacy",
        templates: [{ name: " first.md ", content: "one", enabled: true }],
      }).templates,
    ).toEqual([{ name: "first.md", content: "one", enabled: true }]);
  });
});

describe("applyPromptTemplate", () => {
  it("returns disabled prompts byte-for-byte", () => {
    expect(applyPromptTemplate(" base \n", {})).toBe(" base \n");
  });

  it("joins enabled templates in order and replaces the base", () => {
    expect(
      applyPromptTemplate("base", {
        enabled: true,
        mode: "replace",
        templates: [
          { name: "one.md", content: " one ", enabled: true },
          { name: "off.md", content: "ignored", enabled: false },
          { name: "two.md", content: " two ", enabled: true },
        ],
      }),
    ).toBe("one\n\ntwo");
  });

  it("appends managed content, then custom content, then Chinese policy", () => {
    expect(
      applyPromptTemplate("base", {
        enabled: true,
        mode: "append",
        localContent: " managed ",
        customEnabled: true,
        customContent: " custom ",
        softwareChineseEnabled: true,
      }),
    ).toBe(
      `base\n\n${MANAGED_PROMPT_BEGIN}\nmanaged\n${MANAGED_PROMPT_END}\n\ncustom\n\n${SOFTWARE_CHINESE_PROMPT}`,
    );
  });

  it("uses cache fallback only when the legacy template list is absent", () => {
    expect(applyPromptTemplate("base", { enabled: true, cacheContent: " cached " })).toBe("cached");
    expect(
      applyPromptTemplate("base", {
        enabled: true,
        cacheContent: "cached",
        templates: [{ name: "empty.md", content: " ", enabled: true }],
      }),
    ).toBe("base");
  });
});

describe("prompt rendering", () => {
  it("replaces every fake model ID and uses the Chinese fallback for blank names", () => {
    expect(renderPromptTemplate("{{FAKE_MODEL_ID}} / {{FAKE_MODEL_ID}}", " gpt-5 ")).toBe(
      "gpt-5 / gpt-5",
    );
    expect(renderPromptTemplate("model={{FAKE_MODEL_ID}}", " ")).toBe("model=当前请求模型");
  });

  it("removes only known documentation lines before rendering", () => {
    const input = `# 通用系统提示词\nkeep\n---\n# 模式静态补充\nmodel={{FAKE_MODEL_ID}}\n# Real heading`;
    expect(sanitizePromptDocumentationLines(input)).toBe(
      "keep\nmodel={{FAKE_MODEL_ID}}\n# Real heading",
    );
    expect(preparePromptTemplate(input, "claude")).toBe("keep\nmodel=claude\n# Real heading");
  });
});

describe("safe source validation", () => {
  it("accepts a strict GitHub owner/repository pair", () => {
    expect(isSafeGitHubOwnerRepo("yynxxxxx/Codex-X")).toBe(true);
    expect(isSafeGitHubOwnerRepo("owner/repo.js")).toBe(true);
    for (const value of ["owner", "owner/repo/extra", "/repo", "owner/..", "owner/repo name"]) {
      expect(isSafeGitHubOwnerRepo(value)).toBe(false);
    }
  });

  it("accepts only basename Markdown templates", () => {
    expect(isSafeMarkdownTemplateName(" gpt5.5-unrestricted.MD ")).toBe(true);
    for (const value of [
      "",
      ".md",
      "prompt.txt",
      "../prompt.md",
      "dir/prompt.md",
      "dir\\prompt.md",
    ]) {
      expect(isSafeMarkdownTemplateName(value)).toBe(false);
    }
  });
});
