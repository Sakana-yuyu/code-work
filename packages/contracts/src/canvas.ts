import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const CanvasText = TrimmedNonEmptyString.check(Schema.isMaxLength(12_000));
const CanvasTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const CanvasPath = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).check(
  Schema.makeFilter(
    (value) =>
      !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) &&
      !value.split(/[\\/]/u).some((part) => part === ".."),
  ),
);

const CanvasId = TrimmedNonEmptyString.check(Schema.isMaxLength(96)).check(
  Schema.makeFilter((value) => !/[\\/]/u.test(value)),
);

export const CanvasSectionBlock = Schema.Struct({
  type: Schema.Literal("section"),
  heading: CanvasTitle,
  body: CanvasText,
});
export type CanvasSectionBlock = typeof CanvasSectionBlock.Type;

export const CanvasStatBlock = Schema.Struct({
  type: Schema.Literal("stat"),
  label: CanvasTitle,
  value: CanvasText,
});
export type CanvasStatBlock = typeof CanvasStatBlock.Type;

export const CanvasFileBlock = Schema.Struct({
  type: Schema.Literal("file"),
  path: CanvasPath,
  line: Schema.optional(PositiveInt),
  note: Schema.optional(CanvasText),
});
export type CanvasFileBlock = typeof CanvasFileBlock.Type;

export const CanvasTableBlock = Schema.Struct({
  type: Schema.Literal("table"),
  columns: Schema.Array(CanvasTitle).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  rows: Schema.Array(
    Schema.Array(CanvasText).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type CanvasTableBlock = typeof CanvasTableBlock.Type;

const CanvasTodoItemText = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

export const CanvasCalloutBlock = Schema.Struct({
  type: Schema.Literal("callout"),
  tone: Schema.Literals(["info", "success", "warning", "risk"]),
  title: Schema.optional(CanvasTitle),
  body: CanvasText,
});
export type CanvasCalloutBlock = typeof CanvasCalloutBlock.Type;

export const CanvasTodoBlock = Schema.Struct({
  type: Schema.Literal("todo"),
  title: Schema.optional(CanvasTitle),
  items: Schema.Array(
    Schema.Struct({
      text: CanvasTodoItemText,
      status: Schema.Literals(["done", "in_progress", "pending"]),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
});
export type CanvasTodoBlock = typeof CanvasTodoBlock.Type;

const CanvasChartTone = Schema.optional(
  Schema.Literals(["neutral", "info", "success", "warning", "risk", "accent"]),
);

export const CanvasCodeBlock = Schema.Struct({
  type: Schema.Literal("code"),
  language: Schema.optional(Schema.String.check(Schema.isMaxLength(24))),
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
});
export type CanvasCodeBlock = typeof CanvasCodeBlock.Type;

export const CanvasDividerBlock = Schema.Struct({
  type: Schema.Literal("divider"),
});
export type CanvasDividerBlock = typeof CanvasDividerBlock.Type;

export const CanvasBadgesBlock = Schema.Struct({
  type: Schema.Literal("badges"),
  items: Schema.Array(
    Schema.Struct({
      label: CanvasTitle,
      tone: CanvasChartTone,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
});
export type CanvasBadgesBlock = typeof CanvasBadgesBlock.Type;

export const CanvasUsageBlock = Schema.Struct({
  type: Schema.Literal("usage"),
  label: Schema.optional(CanvasTitle),
  segments: Schema.Array(
    Schema.Struct({
      label: CanvasTitle,
      value: Schema.Number.check(Schema.isGreaterThan(0)),
      tone: CanvasChartTone,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
});
export type CanvasUsageBlock = typeof CanvasUsageBlock.Type;

const CanvasChartPoint = Schema.Struct({
  label: CanvasTitle,
  value: Schema.Number,
});

export const CanvasBarChartBlock = Schema.Struct({
  type: Schema.Literal("chart_bar"),
  title: Schema.optional(CanvasTitle),
  unit: Schema.optional(Schema.String.check(Schema.isMaxLength(16))),
  points: Schema.Array(CanvasChartPoint).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
});
export type CanvasBarChartBlock = typeof CanvasBarChartBlock.Type;

export const CanvasLineChartBlock = Schema.Struct({
  type: Schema.Literal("chart_line"),
  title: Schema.optional(CanvasTitle),
  labels: Schema.Array(CanvasTitle).check(Schema.isMinLength(2), Schema.isMaxLength(48)),
  series: Schema.Array(
    Schema.Struct({
      label: CanvasTitle,
      points: Schema.Array(Schema.Number).check(Schema.isMinLength(2), Schema.isMaxLength(48)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
export type CanvasLineChartBlock = typeof CanvasLineChartBlock.Type;

export const CanvasPieChartBlock = Schema.Struct({
  type: Schema.Literal("chart_pie"),
  title: Schema.optional(CanvasTitle),
  slices: Schema.Array(
    Schema.Struct({
      label: CanvasTitle,
      value: Schema.Number.check(Schema.isGreaterThan(0)),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
});
export type CanvasPieChartBlock = typeof CanvasPieChartBlock.Type;

const CanvasDiffLine = Schema.Struct({
  type: Schema.Literals(["add", "del", "context"]),
  text: Schema.String.check(Schema.isMaxLength(500)),
});

export const CanvasDiffBlock = Schema.Struct({
  type: Schema.Literal("diff"),
  path: Schema.optional(CanvasPath),
  lines: Schema.Array(CanvasDiffLine).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type CanvasDiffBlock = typeof CanvasDiffBlock.Type;

export const CanvasDiscloseBlock = Schema.Struct({
  type: Schema.Literal("disclose"),
  summary: CanvasTitle,
  body: CanvasText,
});
export type CanvasDiscloseBlock = typeof CanvasDiscloseBlock.Type;

export const CanvasBlock = Schema.Union([
  CanvasSectionBlock,
  CanvasStatBlock,
  CanvasFileBlock,
  CanvasTableBlock,
  CanvasCalloutBlock,
  CanvasTodoBlock,
  CanvasCodeBlock,
  CanvasDividerBlock,
  CanvasBadgesBlock,
  CanvasUsageBlock,
  CanvasBarChartBlock,
  CanvasLineChartBlock,
  CanvasPieChartBlock,
  CanvasDiffBlock,
  CanvasDiscloseBlock,
]);
export type CanvasBlock = typeof CanvasBlock.Type;

export const CanvasReference = Schema.Struct({
  canvasId: CanvasId,
  title: CanvasTitle,
  summary: Schema.optional(CanvasText),
  relativePath: CanvasPath,
});
export type CanvasReference = typeof CanvasReference.Type;

export const CanvasDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  canvasId: CanvasId,
  title: CanvasTitle,
  summary: Schema.optional(CanvasText),
  blocks: Schema.Array(CanvasBlock).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  relativePath: CanvasPath,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
});
export type CanvasDocument = typeof CanvasDocument.Type;

export const CanvasCreateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  canvasId: Schema.optional(CanvasId),
  title: CanvasTitle,
  summary: Schema.optional(CanvasText),
  blocks: Schema.Array(CanvasBlock).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type CanvasCreateInput = typeof CanvasCreateInput.Type;
