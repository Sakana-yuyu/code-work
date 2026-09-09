import * as Schema from "effect/Schema";

export const IdeOpenInput = Schema.Struct({
  cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  retry: Schema.optionalKey(Schema.Boolean),
});

// 页面内工作台（@codingame/monaco-vscode-api）连接远程扩展宿主所需的全部参数。
// commit/version/quality 必须与宿主 product.json 一致，否则远程握手按版本不匹配拒绝。
export const IdeConnectionInfo = Schema.Struct({
  webSocketPath: Schema.String.check(Schema.isMinLength(1)),
  folderPath: Schema.String.check(Schema.isMinLength(1)),
  commit: Schema.String.check(Schema.isMinLength(1)),
  version: Schema.String.check(Schema.isMinLength(1)),
  quality: Schema.String.check(Schema.isMinLength(1)),
});
export type IdeConnectionInfo = typeof IdeConnectionInfo.Type;

export const IdeOpenResult = Schema.Struct({
  phase: Schema.Literals(["installing", "starting", "ready", "error"]),
  message: Schema.String,
  relativeUrl: Schema.optionalKey(Schema.String),
  connection: Schema.optionalKey(IdeConnectionInfo),
});
export type IdeOpenResult = typeof IdeOpenResult.Type;

export const IdeCodeSelection = Schema.Struct({
  filePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  text: Schema.String.check(Schema.isMaxLength(200_000)),
  language: Schema.String.check(Schema.isMaxLength(100)),
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type IdeCodeSelection = typeof IdeCodeSelection.Type;

export class IdeError extends Schema.TaggedErrorClass<IdeError>()("IdeError", {
  message: Schema.String,
}) {}
