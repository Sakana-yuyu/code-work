/**
 * Gating tests for the CodeGraph project health card actions: rebuild is the
 * manual path to the FIRST index build, so it must stay clickable for
 * never-indexed projects; sync only makes sense once an index exists.
 *
 * @module CodeGraphSettings
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage, t } from "~/i18n/runtime";

import { ProjectStatusRow } from "./CodeGraphSettings";

const baseProject = {
  projectId: "project-1" as never,
  workspaceRoot: "E:\\MyProject\\demo",
  cliInstalled: true,
  cliVersion: "1.5.0",
  initialized: false,
  fileCount: null,
  nodeCount: null,
  edgeCount: null,
  dbSizeBytes: null,
  languages: [] as ReadonlyArray<string>,
  lastIndexed: null,
  pendingChanges: null,
  reindexRecommended: false,
};

const renderRow = (overrides: Partial<typeof baseProject> = {}) =>
  renderToStaticMarkup(
    <ProjectStatusRow
      project={{ ...baseProject, ...overrides }}
      busy={false}
      onSync={() => {}}
      onReindex={() => {}}
    />,
  );

describe("CodeGraph 项目卡操作门控", () => {
  it("未建索引时同步禁用、建立索引可点", () => {
    setCurrentLanguage("zh-CN");
    const markup = renderRow();
    expect(markup).toContain(`aria-label="${t("codeGraph.sync")}"`);
    expect(markup).toContain(`aria-label="${t("codeGraph.buildIndex")}"`);
    expect(markup).not.toContain(`aria-label="${t("codeGraph.reindex")}"`);
    // 恰好一个禁用按钮（同步）；建立索引保持可点。
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("已建索引时同步与重建都可点", () => {
    setCurrentLanguage("zh-CN");
    const markup = renderRow({ initialized: true });
    expect(markup).toContain(`aria-label="${t("codeGraph.reindex")}"`);
    expect(markup.match(/disabled=""/g) ?? []).toHaveLength(0);
  });

  it("CLI 缺失时两个操作都禁用", () => {
    setCurrentLanguage("zh-CN");
    expect(renderRow({ cliInstalled: false }).match(/disabled=""/g)).toHaveLength(2);
  });

  it("建立索引文案三语齐备", () => {
    for (const language of ["zh-CN", "en", "ja"] as const) {
      setCurrentLanguage(language);
      expect(t("codeGraph.buildIndex")).not.toBe("codeGraph.buildIndex");
    }
    setCurrentLanguage("zh-CN");
  });
});
