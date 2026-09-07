import {
  CodeIndexFileSymbolsToolInput,
  CodeIndexFileSymbolsToolResult,
  CodeIndexSearchToolInput,
  CodeIndexSearchToolResult,
  CodeIndexUnavailableError,
} from "@codework/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { CodeIndexError, CodeIndexRootMap } from "../../../codeIndex/CodeIndexService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

export const IndexSearchTool = Tool.make("index_search", {
  description:
    "Search the Code Work code symbol index of the current project by declaration name (substring, case-insensitive). Returns file path, name, kind (function/method/class/interface/struct/enum/trait/type/module/constant), 1-based line, and the owning declaration for members. Use it before grepping for where a symbol is defined or what a file declares; it is a declaration index only, so it will not find comments, strings, or call sites. An empty query returns nothing useful; pass a symbol fragment such as 'goal' or 'Store'.",
  parameters: CodeIndexSearchToolInput,
  success: CodeIndexSearchToolResult,
  failure: Schema.Union([CodeIndexUnavailableError, CodeIndexError]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    CodeIndexRootMap,
  ],
})
  .annotate(Tool.Title, "Search indexed code symbols")
  .annotate(Tool.Readonly, true);

export const IndexFileSymbolsTool = Tool.make("index_file_symbols", {
  description:
    "List the declarations (functions, classes, methods, types, and similar) that the Code Work code index recorded for one file of the current project, ordered by line. Path is relative to the project root. Use it to understand a file's structure before reading it. The path must point inside the project root.",
  parameters: CodeIndexFileSymbolsToolInput,
  success: CodeIndexFileSymbolsToolResult,
  failure: Schema.Union([
    CodeIndexUnavailableError,
    CodeIndexError,
    WorkspacePaths.WorkspacePathOutsideRootError,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    CodeIndexRootMap,
    WorkspacePaths.WorkspacePaths,
  ],
})
  .annotate(Tool.Title, "List declarations of an indexed file")
  .annotate(Tool.Readonly, true);

export const IndexToolkit = Toolkit.make(IndexSearchTool, IndexFileSymbolsTool);
