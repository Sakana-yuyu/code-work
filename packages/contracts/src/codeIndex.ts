import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * 代码符号索引（可丢弃缓存，独立于事件库）的状态查询合同。
 *
 * 索引数据只包含声明级符号（名称/种类/行号）与文件 mtime 元数据，不含
 * 任何文件内容；客户端只能读取统计与状态，重建由服务端自行调度。
 */

export const CodeIndexProjectState = Schema.Literals(["idle", "indexing", "off"]);
export type CodeIndexProjectState = typeof CodeIndexProjectState.Type;

export const CodeIndexProjectStatus = Schema.Struct({
  projectId: ProjectId,
  /** 索引状态行对应的工作区根目录（绝对路径，仅展示用）。 */
  workspaceRoot: Schema.String,
  state: CodeIndexProjectState,
  fileCount: NonNegativeInt,
  symbolCount: NonNegativeInt,
  /** 最近一次完成（增量的或全量的）索引时间；从未索引过为 null。 */
  lastIndexedAt: Schema.NullOr(IsoDateTime),
});
export type CodeIndexProjectStatus = typeof CodeIndexProjectStatus.Type;

export const CodeIndexStatusInput = Schema.Struct({});
export type CodeIndexStatusInput = typeof CodeIndexStatusInput.Type;

export const CodeIndexStatusResult = Schema.Struct({
  enabled: Schema.Boolean,
  projects: Schema.Array(CodeIndexProjectStatus),
});
export type CodeIndexStatusResult = typeof CodeIndexStatusResult.Type;

/** agent 经 MCP 查询索引时的匹配条目。 */
export const CodeIndexSymbolMatch = Schema.Struct({
  /** 工作区相对路径（正斜杠）。 */
  path: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  /** 1-based 声明行号。 */
  line: NonNegativeInt,
  /** 成员声明的所属声明名（如方法所属的类）。 */
  parent: Schema.optionalKey(Schema.String),
});
export type CodeIndexSymbolMatch = typeof CodeIndexSymbolMatch.Type;

/** MCP index_search 入参。 */
export const CodeIndexSearchToolInput = Schema.Struct({
  /** 符号名子串（大小写不敏感）。 */
  query: Schema.String,
  /** 按声明种类过滤（function/method/class/interface/struct/enum/trait/type/module/constant）。 */
  kind: Schema.optionalKey(Schema.String),
  /** 返回上限，默认 25。 */
  limit: Schema.optionalKey(NonNegativeInt),
});
export type CodeIndexSearchToolInput = typeof CodeIndexSearchToolInput.Type;

/** MCP index_search 返回。 */
export const CodeIndexSearchToolResult = Schema.Struct({
  matches: Schema.Array(CodeIndexSymbolMatch),
});
export type CodeIndexSearchToolResult = typeof CodeIndexSearchToolResult.Type;

/** MCP index_file_symbols 入参。 */
export const CodeIndexFileSymbolsToolInput = Schema.Struct({
  /** 工作区相对路径（正斜杠），拒绝越出项目根目录。 */
  path: Schema.String,
});
export type CodeIndexFileSymbolsToolInput = typeof CodeIndexFileSymbolsToolInput.Type;

/** MCP index_file_symbols 返回。 */
export const CodeIndexFileSymbolsToolResult = Schema.Struct({
  symbols: Schema.Array(CodeIndexSymbolMatch),
});
export type CodeIndexFileSymbolsToolResult = typeof CodeIndexFileSymbolsToolResult.Type;

/**
 * 索引工具的统一失败：能力未授予、线程没有所属项目、索引未开启或为空结果。
 * 一个类型便于 agent 判断「该换个方式找符号」而不是重试。
 */
export class CodeIndexUnavailableError extends Schema.TaggedErrorClass<CodeIndexUnavailableError>()(
  "CodeIndexUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Code index unavailable: ${this.reason}`;
  }
}
export type CodeIndexUnavailableErrorType = Schema.Schema.Type<typeof CodeIndexUnavailableError>;
