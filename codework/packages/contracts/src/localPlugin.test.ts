import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  LOCAL_PLUGIN_HOST_API_VERSION,
  LocalPluginManifest,
  negotiateLocalPluginApiVersion,
  validateLocalPluginManifest,
} from "./localPlugin.ts";

const decodeManifest = Schema.decodeUnknownSync(LocalPluginManifest);

const validManifest = {
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id: "acme.workspace-helper",
  name: "工作区助手",
  version: "1.2.3",
  permissions: [
    "workspace.read",
    "clipboard.write",
    "composer.prompt.write",
    "timeline.write",
    "composer.attachment.add",
  ],
  contributions: {
    workspacePanels: [
      {
        id: "overview",
        title: "工作区概览",
        sections: [{ heading: "当前目录", body: "{{workspace.root}}" }],
        context: ["workspace.name", "workspace.root"],
      },
    ],
    commands: [
      {
        id: "open-overview",
        title: "打开工作区概览",
        action: { type: "workspace.open-panel", panelId: "overview" },
      },
      {
        id: "copy-root",
        title: "复制工作区路径",
        action: { type: "clipboard.write", text: "{{workspace.root}}" },
      },
      {
        id: "insert-review-prompt",
        title: "插入审查提示词",
        action: { type: "composer.prompt.insert", text: "请审查当前改动。" },
      },
      {
        id: "publish-note",
        title: "记录检查结果",
        action: {
          type: "timeline.post",
          timelineId: "checks",
          message: "插件检查已完成。",
        },
      },
    ],
    timeline: [{ id: "checks", title: "插件检查", tone: "info" }],
    attachments: [
      {
        id: "design-image",
        title: "添加设计图",
        accept: ["image/png", "image/jpeg"],
        maxBytes: 5_000_000,
        promptPrefix: "请结合这张设计图分析：",
      },
    ],
  },
} as const;

describe("LocalPluginManifest", () => {
  it("解码受控、版本化的四类贡献声明", () => {
    const manifest = decodeManifest(validManifest);

    expect(manifest.id).toBe("acme.workspace-helper");
    expect(manifest.contributions.commands).toHaveLength(4);
    expect(validateLocalPluginManifest(manifest)).toEqual([]);
  });

  it("协商 API 主版本并拒绝插件要求的更高次版本", () => {
    expect(negotiateLocalPluginApiVersion({ major: 1, minor: 0 })).toEqual({
      compatible: true,
      host: LOCAL_PLUGIN_HOST_API_VERSION,
    });
    expect(negotiateLocalPluginApiVersion({ major: 2, minor: 0 })).toMatchObject({
      compatible: false,
      reason: "unsupported-major",
    });
    expect(negotiateLocalPluginApiVersion({ major: 1, minor: 1 })).toMatchObject({
      compatible: false,
      reason: "requires-newer-minor",
    });
  });

  it("拒绝未知 manifest 版本、非法标识与非语义化插件版本", () => {
    expect(() => decodeManifest({ ...validManifest, manifestVersion: 2 })).toThrow();
    expect(() => decodeManifest({ ...validManifest, id: "Bad Plugin" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "latest" })).toThrow();
  });

  it("报告缺失权限、重复贡献和悬空目标", () => {
    const manifest = decodeManifest({
      ...validManifest,
      permissions: [],
      contributions: {
        ...validManifest.contributions,
        workspacePanels: [
          validManifest.contributions.workspacePanels[0],
          validManifest.contributions.workspacePanels[0],
        ],
        commands: [
          {
            id: "missing-panel",
            title: "打开缺失面板",
            action: { type: "workspace.open-panel", panelId: "missing" },
          },
          {
            id: "missing-timeline",
            title: "写入缺失时间线",
            action: {
              type: "timeline.post",
              timelineId: "missing",
              message: "不会写入",
            },
          },
        ],
      },
    });

    expect(validateLocalPluginManifest(manifest).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "duplicate-contribution-id",
        "missing-permission",
        "missing-workspace-panel",
        "missing-timeline-contribution",
      ]),
    );
  });

  it("拒绝附件越界和不受支持的 MIME 类型", () => {
    expect(() =>
      decodeManifest({
        ...validManifest,
        contributions: {
          ...validManifest.contributions,
          attachments: [
            {
              id: "unsafe",
              title: "不安全附件",
              accept: ["application/octet-stream"],
              maxBytes: 25_000_000,
            },
          ],
        },
      }),
    ).toThrow();
  });
});
