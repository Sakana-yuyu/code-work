// @effect-diagnostics nodeBuiltinImport:off
import type { CanvasBlock, CanvasCreateInput } from "@codework/contracts";

/**
 * 画布文本抢救：模型偶尔会把组织好的画布 JSON 以 ```json 代码块写进回复
 * 正文，而不是调用 canvas.create 工具（工具清单很大时部分端点会出现这种
 * 绑定失败）。这里从正文里提取画布形状的代码块，并按契约白名单规范化成
 * 可以直接交给 canvas.create 工具的入参；解析不出来就返回 undefined，让
 * 原文原样保留。规范化是适配器边界的宽容层：数字字符串转数值、缺失的
 * 枚举补默认值、未知字段与非法块直接丢弃——严格校验仍由工具的解码器把关。
 */

const FENCED_JSON_BLOCK = /```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)```/g;

const BLOCK_ARRAY_LIMITS = {
  table: { columns: 12, rows: 100, cells: 12 },
  todo: { items: 24 },
  badges: { items: 12 },
  usage: { segments: 12 },
  chart_bar: { points: 24 },
  chart_line: { labels: 48, series: 4, points: 48 },
  chart_pie: { slices: 8 },
  diff: { lines: 200 },
} as const;

const MAX_BLOCKS = 32;

const trimmed = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (value.trim().length > 0 && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asPositive = (value: unknown): number | undefined => {
  const parsed = asNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

const asPositiveInt = (value: unknown): number | undefined => {
  const parsed = asPositive(value);
  return parsed !== undefined ? Math.trunc(parsed) : undefined;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return undefined;
};

const cap = <T>(items: readonly T[], limit: number): T[] => items.slice(0, limit);

const stringArray = (value: unknown, limit: number): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const texts: string[] = [];
  for (const item of value) {
    const text = trimmed(item);
    if (text === undefined) return undefined;
    texts.push(text);
  }
  return texts.length > 0 ? cap(texts, limit) : undefined;
};

const normalizeBlock = (value: unknown): CanvasBlock | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case "section": {
      const heading = trimmed(raw.heading);
      const body = trimmed(raw.body);
      return heading !== undefined && body !== undefined
        ? { type: "section", heading, body }
        : undefined;
    }
    case "stat": {
      const label = trimmed(raw.label);
      const value2 = trimmed(raw.value);
      return label !== undefined && value2 !== undefined
        ? { type: "stat", label, value: value2 }
        : undefined;
    }
    case "file": {
      const path = trimmed(raw.path);
      if (path === undefined) return undefined;
      const line = asPositiveInt(raw.line);
      const note = trimmed(raw.note);
      return {
        type: "file",
        path,
        ...(line === undefined ? {} : { line }),
        ...(note === undefined ? {} : { note }),
      };
    }
    case "table": {
      const columns = stringArray(raw.columns, BLOCK_ARRAY_LIMITS.table.columns);
      if (columns === undefined || !Array.isArray(raw.rows)) return undefined;
      const rows: string[][] = [];
      for (const row of raw.rows) {
        const cells = stringArray(row, BLOCK_ARRAY_LIMITS.table.cells);
        if (cells === undefined) return undefined;
        rows.push(cells);
      }
      return rows.length > 0
        ? { type: "table", columns, rows: cap(rows, BLOCK_ARRAY_LIMITS.table.rows) }
        : undefined;
    }
    case "callout": {
      const body = trimmed(raw.body);
      if (body === undefined) return undefined;
      const tone = oneOf(raw.tone, ["info", "success", "warning", "risk"] as const) ?? "info";
      const title = trimmed(raw.title);
      return { type: "callout", tone, ...(title === undefined ? {} : { title }), body };
    }
    case "todo": {
      if (!Array.isArray(raw.items)) return undefined;
      const items = cap(raw.items, BLOCK_ARRAY_LIMITS.todo.items)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const text = trimmed(record.text);
          if (text === undefined) return undefined;
          return {
            text,
            status: oneOf(record.status, ["done", "in_progress", "pending"] as const) ?? "pending",
          };
        })
        .filter(
          (item): item is { text: string; status: "done" | "in_progress" | "pending" } =>
            item !== undefined,
        );
      if (items.length === 0) return undefined;
      const title = trimmed(raw.title);
      return { type: "todo", ...(title === undefined ? {} : { title }), items };
    }
    case "code": {
      const code = trimmed(raw.code);
      if (code === undefined) return undefined;
      const language = trimmed(raw.language);
      return { type: "code", ...(language === undefined ? {} : { language }), code };
    }
    case "divider":
      return { type: "divider" };
    case "badges": {
      if (!Array.isArray(raw.items)) return undefined;
      const items = cap(raw.items, BLOCK_ARRAY_LIMITS.badges.items)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const label = trimmed(record.label);
          if (label === undefined) return undefined;
          const tone = oneOf(record.tone, [
            "neutral",
            "info",
            "success",
            "warning",
            "risk",
            "accent",
          ] as const);
          return { label, ...(tone === undefined ? {} : { tone }) };
        })
        .filter((item) => item !== undefined);
      return items.length > 0 ? { type: "badges", items } : undefined;
    }
    case "usage": {
      if (!Array.isArray(raw.segments)) return undefined;
      const segments = cap(raw.segments, BLOCK_ARRAY_LIMITS.usage.segments)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const label = trimmed(record.label);
          const segmentValue = asPositive(record.value);
          if (label === undefined || segmentValue === undefined) return undefined;
          const tone = oneOf(record.tone, [
            "neutral",
            "info",
            "success",
            "warning",
            "risk",
            "accent",
          ] as const);
          return { label, value: segmentValue, ...(tone === undefined ? {} : { tone }) };
        })
        .filter((item) => item !== undefined);
      if (segments.length === 0) return undefined;
      const label = trimmed(raw.label);
      return { type: "usage", ...(label === undefined ? {} : { label }), segments };
    }
    case "chart_bar": {
      if (!Array.isArray(raw.points)) return undefined;
      const points = cap(raw.points, BLOCK_ARRAY_LIMITS.chart_bar.points)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const label = trimmed(record.label);
          const pointValue = asNumber(record.value);
          return label !== undefined && pointValue !== undefined
            ? { label, value: pointValue }
            : undefined;
        })
        .filter((item) => item !== undefined);
      if (points.length === 0) return undefined;
      const title = trimmed(raw.title);
      const unit = trimmed(raw.unit);
      return {
        type: "chart_bar",
        ...(title === undefined ? {} : { title }),
        ...(unit === undefined ? {} : { unit }),
        points,
      };
    }
    case "chart_line": {
      const labels = stringArray(raw.labels, BLOCK_ARRAY_LIMITS.chart_line.labels);
      if (labels === undefined || !Array.isArray(raw.series)) return undefined;
      const series = cap(raw.series, BLOCK_ARRAY_LIMITS.chart_line.series)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const label = trimmed(record.label);
          if (label === undefined || !Array.isArray(record.points)) return undefined;
          const points = cap(record.points, BLOCK_ARRAY_LIMITS.chart_line.points)
            .map((point) => asNumber(point))
            .filter((point): point is number => point !== undefined);
          return points.length >= 2 ? { label, points } : undefined;
        })
        .filter((item) => item !== undefined);
      if (series.length === 0) return undefined;
      const title = trimmed(raw.title);
      return { type: "chart_line", ...(title === undefined ? {} : { title }), labels, series };
    }
    case "chart_pie": {
      if (!Array.isArray(raw.slices)) return undefined;
      const slices = cap(raw.slices, BLOCK_ARRAY_LIMITS.chart_pie.slices)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const label = trimmed(record.label);
          const sliceValue = asPositive(record.value);
          return label !== undefined && sliceValue !== undefined
            ? { label, value: sliceValue }
            : undefined;
        })
        .filter((item) => item !== undefined);
      if (slices.length < 2) return undefined;
      const title = trimmed(raw.title);
      return { type: "chart_pie", ...(title === undefined ? {} : { title }), slices };
    }
    case "diff": {
      if (!Array.isArray(raw.lines)) return undefined;
      const lines = cap(raw.lines, BLOCK_ARRAY_LIMITS.diff.lines)
        .map((item) => {
          const record =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const text = trimmed(record.text) ?? (typeof item === "string" ? item.trim() : undefined);
          if (text === undefined) return undefined;
          const declared = oneOf(record.type, ["add", "del", "context"] as const);
          const inferred = text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "context";
          return { type: declared ?? inferred, text };
        })
        .filter((item) => item !== undefined);
      if (lines.length === 0) return undefined;
      const path = trimmed(raw.path);
      return { type: "diff", ...(path === undefined ? {} : { path }), lines };
    }
    case "disclose": {
      const summary = trimmed(raw.summary);
      const body = trimmed(raw.body);
      return summary !== undefined && body !== undefined
        ? { type: "disclose", summary, body }
        : undefined;
    }
    default:
      return undefined;
  }
};

const sanitizeCanvasId = (value: string): string | undefined => {
  const id = value
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return id.length > 0 ? id : undefined;
};

export const extractRescuableCanvas = (text: string): unknown => {
  for (const match of text.matchAll(FENCED_JSON_BLOCK)) {
    const body = match[1];
    if (body === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).blocks)
    ) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.title !== "string" && typeof record.canvasId !== "string") continue;
    return parsed;
  }
  return undefined;
};

export const normalizeRescuedCanvas = (
  raw: unknown,
  cwd: string,
): CanvasCreateInput | undefined => {
  const rawBlocks =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).blocks : undefined;
  if (!Array.isArray(rawBlocks)) return undefined;
  const record = raw as Record<string, unknown>;
  const blocks = cap(
    rawBlocks.flatMap((block: unknown) => {
      const normalized = normalizeBlock(block);
      return normalized === undefined ? [] : [normalized];
    }),
    MAX_BLOCKS,
  );
  if (blocks.length === 0) return undefined;
  const title = trimmed(record.title) ?? trimmed(record.canvasId) ?? "Canvas";
  const canvasId =
    typeof record.canvasId === "string" ? sanitizeCanvasId(record.canvasId) : undefined;
  const summary = trimmed(record.summary);
  return {
    cwd,
    title: title.slice(0, 160),
    ...(canvasId === undefined ? {} : { canvasId }),
    ...(summary === undefined ? {} : { summary: summary.slice(0, 12_000) }),
    blocks,
  };
};
