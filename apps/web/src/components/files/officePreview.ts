import type { JSZipObject, JSZipStreamHelper } from "jszip";

export const MAX_OFFICE_PREVIEW_BYTES = 12 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 80_000;

export interface OfficePreviewSection {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly table?: {
    readonly columns: ReadonlyArray<string>;
    readonly rows: ReadonlyArray<{
      readonly index: number;
      readonly values: ReadonlyArray<string>;
    }>;
    readonly truncated: boolean;
  };
}

type BoundedZipEntry = JSZipObject & {
  _data?: { uncompressedSize?: unknown };
  internalStream(type: "uint8array"): JSZipStreamHelper<Uint8Array>;
};

function xmlDocument(value: string): Document {
  const document = new DOMParser().parseFromString(value, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Invalid Office XML");
  }
  return document;
}

function textIn(element: Element, tag: string): string {
  return Array.from(element.getElementsByTagName(tag), (node) => node.textContent ?? "").join("");
}

async function readEntry(entry: BoundedZipEntry): Promise<string> {
  if (
    typeof entry._data?.uncompressedSize !== "number" ||
    entry._data.uncompressedSize > MAX_ENTRY_BYTES
  ) {
    throw new Error("Office part exceeds preview limit");
  }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const stream = entry.internalStream("uint8array");
    stream.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_ENTRY_BYTES) {
        settled = true;
        stream.pause();
        reject(new Error("Office part exceeds preview limit"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (error) => {
      if (!settled) reject(error);
      settled = true;
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      const output = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(new TextDecoder().decode(output));
    });
    stream.resume();
  });
}

function boundedLines(lines: ReadonlyArray<string>, budget: { remaining: number }): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (budget.remaining <= 0) break;
    const normalized = line.trim();
    if (!normalized) continue;
    const bounded = normalized.slice(0, budget.remaining);
    result.push(bounded);
    budget.remaining -= bounded.length;
  }
  return result;
}

function columnOrdinal(column: string): number {
  return [...column].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function workbookSheetNames(workbook: Document | null, relationships: Document | null) {
  const names = new Map<string, string>();
  if (!workbook || !relationships) return names;
  const targets = new Map(
    Array.from(relationships.getElementsByTagName("Relationship"), (relation) => [
      relation.getAttribute("Id"),
      relation.getAttribute("Target"),
    ]),
  );
  for (const sheet of Array.from(workbook.getElementsByTagName("sheet"))) {
    const target = targets.get(sheet.getAttribute("r:id"));
    const matched = target?.match(/^(?:\/?xl\/)?worksheets\/([a-z0-9_-]+\.xml)$/i);
    const title = sheet.getAttribute("name");
    if (matched && title) names.set(`xl/worksheets/${matched[1]}`, title.slice(0, 120));
  }
  return names;
}

/** 仅提取可见文字与单元格值，不执行文档中的宏、链接或脚本。 */
export async function parseOfficePreview(
  path: string,
  bytes: Uint8Array,
): Promise<ReadonlyArray<OfficePreviewSection>> {
  if (bytes.byteLength > MAX_OFFICE_PREVIEW_BYTES) {
    throw new Error("Office file exceeds preview limit");
  }
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  if (Object.keys(zip.files).length > 2_000) throw new Error("Office archive has too many parts");
  const budget = { remaining: MAX_OUTPUT_CHARS };
  const part = async (name: string): Promise<Document | null> => {
    const entry = zip.file(name) as BoundedZipEntry | null;
    return entry ? xmlDocument(await readEntry(entry)) : null;
  };

  if (/\.docx$/i.test(path)) {
    const document = await part("word/document.xml");
    if (!document) throw new Error("Office document body is missing");
    const paragraphs = Array.from(document.getElementsByTagName("w:p"), (element) =>
      textIn(element, "w:t"),
    );
    return [{ title: path, lines: boundedLines(paragraphs, budget) }];
  }
  if (/\.pptx$/i.test(path)) {
    const names = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
      .slice(0, 100);
    if (names.length === 0) throw new Error("Office slides are missing");
    const slides: OfficePreviewSection[] = [];
    for (const name of names) {
      if (budget.remaining <= 0) break;
      const slide = await part(name);
      if (!slide) continue;
      const lines = Array.from(slide.getElementsByTagName("a:p"), (element) =>
        textIn(element, "a:t"),
      );
      slides.push({ title: name, lines: boundedLines(lines, budget) });
    }
    return slides;
  }
  if (/\.xlsx$/i.test(path)) {
    const workbook = await part("xl/workbook.xml");
    const relationships = await part("xl/_rels/workbook.xml.rels");
    const sheetNames = workbookSheetNames(workbook, relationships);
    const sharedStrings = await part("xl/sharedStrings.xml");
    const strings = sharedStrings
      ? Array.from(sharedStrings.getElementsByTagName("si"), (element) => textIn(element, "t"))
      : [];
    const fallbackNames = Object.keys(zip.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    const mappedNames = [...sheetNames.keys()].filter((name) => zip.file(name) !== null);
    const allNames = mappedNames.length > 0 ? mappedNames : fallbackNames;
    const names = allNames.slice(0, 50);
    if (names.length === 0) throw new Error("Office worksheets are missing");
    const sheets: OfficePreviewSection[] = [];
    for (const name of names) {
      if (budget.remaining <= 0) break;
      const sheet = await part(name);
      if (!sheet) continue;
      const columns = new Set<string>();
      const sourceRows = Array.from(sheet.getElementsByTagName("row"));
      let truncatedCells = false;
      const sparseRows = sourceRows.slice(0, 500).map((row, rowIndex) => {
        const index = Number(row.getAttribute("r")) || rowIndex + 1;
        const values = new Map<string, string>();
        const cells = Array.from(row.getElementsByTagName("c"));
        if (cells.length > 100) truncatedCells = true;
        for (const cell of cells.slice(0, 100)) {
          if (budget.remaining <= 0) break;
          const column = cell
            .getAttribute("r")
            ?.match(/^([A-Z]+)\d+$/i)?.[1]
            ?.toUpperCase();
          if (!column) continue;
          const raw = cell.getElementsByTagName("v")[0]?.textContent ?? textIn(cell, "t");
          const value = cell.getAttribute("t") === "s" ? (strings[Number(raw)] ?? "") : raw;
          const bounded = value.slice(0, budget.remaining);
          budget.remaining -= bounded.length;
          columns.add(column);
          values.set(column, bounded);
        }
        return { index, values };
      });
      const allColumns = [...columns].sort(
        (left, right) => columnOrdinal(left) - columnOrdinal(right),
      );
      const orderedColumns = allColumns.slice(0, 50);
      const visibleRows = sparseRows.slice(
        0,
        Math.max(1, Math.floor(2_000 / Math.max(1, orderedColumns.length))),
      );
      sheets.push({
        title: sheetNames.get(name) ?? name,
        lines: [],
        table: {
          columns: orderedColumns,
          rows: visibleRows.map((row) => ({
            index: row.index,
            values: orderedColumns.map((column) => row.values.get(column) ?? ""),
          })),
          truncated:
            allNames.length > names.length ||
            sourceRows.length > sparseRows.length ||
            truncatedCells ||
            allColumns.length > orderedColumns.length ||
            sparseRows.length > visibleRows.length ||
            budget.remaining <= 0,
        },
      });
    }
    return sheets;
  }
  throw new Error("Unsupported Office file type");
}
