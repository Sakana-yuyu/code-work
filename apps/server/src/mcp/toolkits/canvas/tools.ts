import { CanvasCreateInput, CanvasReference, PreviewAutomationError } from "@codework/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

export const CanvasCreateTool = Tool.make("canvas_create", {
  description:
    "Create a durable, polished, information-dense structured Code Work Canvas the user can open beside the chat. You MUST use it whenever the task produces a standalone analytical artifact: architecture reviews, audits, codebase maps, quantitative analyses, data-heavy findings, comparisons, flows, timelines, and risks. When the data itself is the deliverable, render it as a Canvas instead of dumping it into a markdown table or a long code block. Prefer charts (chart_bar, chart_line, chart_pie) or tables for quantitative data, callouts for the key conclusions and risks, and todo lists for follow-up actions. Multiple calls are allowed: create from the evidence you have, then update the same Canvas by reusing its canvasId as the task progresses, or author separate Canvases for different topics. The Canvas is created exclusively through this tool invocation: writing the canvas JSON into your reply text does not produce a Canvas panel. Ground every block in inspected evidence, keep the ordering hierarchical, omit empty or speculative blocks, and do not call the tool when there is no real content. Make every table self-describing with specific column names and units, source, or time range when applicable. The Canvas supports only non-empty blocks from the parameter schema (sections, stats, file references, tables, callouts, todo lists, code, dividers, badges, usage bars, charts, diffs, disclose sections); do not create files yourself or generate executable UI code.",
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
