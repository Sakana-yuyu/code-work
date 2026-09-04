import { CanvasCreateInput, CanvasReference, PreviewAutomationError } from "@codework/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

export const CanvasCreateTool = Tool.make("canvas_create", {
  description:
    "Create a durable, polished structured Code Work Canvas only when the user wants a standalone analytical artifact. Use it for architecture reviews, audits, codebase maps, data-heavy findings, comparisons, flows, and risks; skip it for targeted implementation, debugging, or another specific deliverable. Prefer a concise summary, 2-4 meaningful stats when supported, sections for relationships/flow and risks, file references with line numbers, and compact tables for useful comparisons. Ground every block in inspected project evidence, keep the ordering hierarchical, omit empty or speculative blocks, and do not call the tool when there is no real content. Make every table self-describing with specific column names and units, source, or time range when applicable. The Canvas supports only non-empty sections, stats, file references, and tables; do not create files yourself or generate executable UI code.",
  parameters: CanvasCreateInput,
  success: CanvasReference,
  failure: Schema.Union([
    PreviewAutomationError,
    WorkspaceFileSystem.WorkspaceFileSystemError,
    WorkspacePaths.WorkspacePathOutsideRootError,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkspaceFileSystem.WorkspaceFileSystem,
  ],
})
  .annotate(Tool.Title, "Create code analysis Canvas")
  .annotate(Tool.Destructive, false);

export const CanvasToolkit = Toolkit.make(CanvasCreateTool);
