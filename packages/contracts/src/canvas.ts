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

export const CanvasBlock = Schema.Union([
  CanvasSectionBlock,
  CanvasStatBlock,
  CanvasFileBlock,
  CanvasTableBlock,
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
