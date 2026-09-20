/**
 * Rendering tests for the code-index project status row: live progress text
 * replaces the half-built stats while indexing, and the settled row shows the
 * familiar stats line.
 *
 * @module CodeIndexSettings
 */
import type { CodeIndexProjectStatus } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage, t } from "~/i18n/runtime";

import { ProjectStatusRow } from "./CodeIndexSettings";

const lastIndexedAt = "2026-09-20T03:00:00.000Z";

const baseProject: CodeIndexProjectStatus = {
  projectId: "project-1" as never,
  workspaceRoot: "E:\\MyProject\\demo",
  state: "idle",
  fileCount: 12,
  symbolCount: 340,
  lastIndexedAt,
};

const renderRow = (overrides: Partial<CodeIndexProjectStatus> = {}) =>
  renderToStaticMarkup(<ProjectStatusRow project={{ ...baseProject, ...overrides }} />);

describe("代码索引状态行", () => {
  it("空闲行显示统计与索引时间", () => {
    setCurrentLanguage("zh-CN");
    const markup = renderRow();
    expect(markup).toContain(t("codeIndex.projectStats", { files: "12", symbols: "340" }));
    expect(markup).toContain(
      t("codeIndex.lastIndexed", { time: new Date(lastIndexedAt).toLocaleString() }),
    );
  });

  it("提取中显示 X / Y 实时进度并隐藏半成品统计", () => {
    setCurrentLanguage("zh-CN");
    const markup = renderRow({
      state: "indexing",
      progress: { phase: "extracting", processedFiles: 1234, totalFiles: 5678 },
    });
    expect(markup).toContain(
      t("codeIndex.progressExtracting", { processed: "1,234", total: "5,678" }),
    );
    expect(markup).not.toContain(t("codeIndex.neverIndexed"));
    expect(markup).not.toContain(t("codeIndex.projectStats", { files: "12", symbols: "340" }));
  });

  it("扫描阶段尚无总量时显示扫描文案", () => {
    setCurrentLanguage("zh-CN");
    const markup = renderRow({
      state: "indexing",
      progress: { phase: "scanning", processedFiles: 0, totalFiles: null },
    });
    expect(markup).toContain(t("codeIndex.progressScanning"));
  });

  it("进度文案三语齐备", () => {
    for (const language of ["zh-CN", "en", "ja"] as const) {
      setCurrentLanguage(language);
      expect(t("codeIndex.progressScanning")).not.toBe("codeIndex.progressScanning");
      expect(t("codeIndex.progressExtracting")).not.toBe("codeIndex.progressExtracting");
    }
    setCurrentLanguage("zh-CN");
  });
});
