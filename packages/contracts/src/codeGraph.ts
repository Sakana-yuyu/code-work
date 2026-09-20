import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * CodeGraph 代码知识图谱（上游 @colbymchenry/codegraph CLI）的管理合同。
 *
 * 索引本体与索引数据都留在项目的 `.codegraph/` 目录；这里的合同只承载
 * 设置页需要的安装状态、建索引阶段进度和 `codegraph status --json` 的
 * 统计投影，不含任何索引内容。CLI 未安装时一切读取都按「未安装」降级，
 * 不抛错（fail-open）。
 */

export const CodeGraphInstallStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type CodeGraphInstallStatus = typeof CodeGraphInstallStatus.Type;

export const CodeGraphInstallState = Schema.Struct({
  status: CodeGraphInstallStatus,
  /** 失败原因或成功摘要（如安装后的版本号）。 */
  message: Schema.NullOr(Schema.String),
  updatedAt: NonNegativeInt,
});
export type CodeGraphInstallState = typeof CodeGraphInstallState.Type;

/** 后台 `codegraph init` 的阶段进度；只反应阶段，不做百分比。 */
export const CodeGraphIndexPhase = Schema.Literals([
  "queued",
  "scanning",
  "parsing",
  "resolving",
  "linking",
  "complete",
  "failed",
]);
export type CodeGraphIndexPhase = typeof CodeGraphIndexPhase.Type;

export const CodeGraphIndexProgress = Schema.Struct({
  phase: CodeGraphIndexPhase,
  /** 阶段补充说明（完成的统计摘要或失败原因）。 */
  detail: Schema.NullOr(Schema.String),
  updatedAt: NonNegativeInt,
});
export type CodeGraphIndexProgress = typeof CodeGraphIndexProgress.Type;

export const CodeGraphProjectIndexStatus = Schema.Struct({
  projectId: ProjectId,
  /** 工作区根目录（绝对路径，仅展示用）。 */
  workspaceRoot: Schema.String,
  /** CLI 在 PATH 上是否可用；不可用时其余字段按未安装降级。 */
  cliInstalled: Schema.Boolean,
  cliVersion: Schema.NullOr(Schema.String),
  /** 项目是否已有 `.codegraph/` 索引。 */
  initialized: Schema.Boolean,
  fileCount: Schema.NullOr(NonNegativeInt),
  nodeCount: Schema.NullOr(NonNegativeInt),
  edgeCount: Schema.NullOr(NonNegativeInt),
  dbSizeBytes: Schema.NullOr(NonNegativeInt),
  languages: Schema.Array(Schema.String),
  /** 上游 status 的 ISO 时间戳；从未索引过为 null。 */
  lastIndexed: Schema.NullOr(Schema.String),
  /** 距上次索引的待同步变更数；无法获取时为 null。 */
  pendingChanges: Schema.NullOr(
    Schema.Struct({
      added: NonNegativeInt,
      modified: NonNegativeInt,
      removed: NonNegativeInt,
    }),
  ),
  /** 上游建议重建索引（如索引由旧版本 CLI 建立）。 */
  reindexRecommended: Schema.Boolean,
  /** init/reindex 正在后台推进时的阶段进度。 */
  progress: Schema.optionalKey(CodeGraphIndexProgress),
});
export type CodeGraphProjectIndexStatus = typeof CodeGraphProjectIndexStatus.Type;

export const CodeGraphStatusResult = Schema.Struct({
  enabled: Schema.Boolean,
  install: CodeGraphInstallState,
  /** codegraph CLI 在服务器 PATH 上是否可用（60s 缓存探测；未开启时恒 false）。 */
  cliInstalled: Schema.Boolean,
  cliVersion: Schema.NullOr(Schema.String),
  projects: Schema.Array(CodeGraphProjectIndexStatus),
});
export type CodeGraphStatusResult = typeof CodeGraphStatusResult.Type;

export const CodeGraphStatusInput = Schema.Struct({});
export type CodeGraphStatusInput = typeof CodeGraphStatusInput.Type;

export const CodeGraphInstallInput = Schema.Struct({});
export type CodeGraphInstallInput = typeof CodeGraphInstallInput.Type;

export const CodeGraphProjectActionInput = Schema.Struct({
  projectId: ProjectId,
});
export type CodeGraphProjectActionInput = typeof CodeGraphProjectActionInput.Type;

export const CodeGraphActionResult = Schema.Struct({
  /** 人类可读的结果摘要；失败时为原因。 */
  message: Schema.NullOr(Schema.String),
  succeeded: Schema.Boolean,
});
export type CodeGraphActionResult = typeof CodeGraphActionResult.Type;
