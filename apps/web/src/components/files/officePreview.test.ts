import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vite-plus/test";

import { MAX_OFFICE_PREVIEW_BYTES, parseOfficePreview } from "./officePreview";

Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true });

async function officeBytes(parts: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(parts)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

describe("Office 内容预览", () => {
  it("提取 DOCX 段落，不把 XML 标记作为内容显示", async () => {
    const bytes = await officeBytes({
      "word/document.xml":
        '<w:document xmlns:w="urn:test"><w:p><w:r><w:t>你好</w:t></w:r></w:p></w:document>',
    });
    expect(await parseOfficePreview("report.docx", bytes)).toEqual([
      { title: "report.docx", lines: ["你好"] },
    ]);
  });

  it("解析 XLSX 共享字符串和数值单元格", async () => {
    const bytes = await officeBytes({
      "xl/sharedStrings.xml": "<sst><si><t>收入</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></worksheet>',
    });
    expect(await parseOfficePreview("data.xlsx", bytes)).toEqual([
      { title: "xl/worksheets/sheet1.xml", lines: ["A1: 收入  |  B1: 42"] },
    ]);
  });

  it("按页顺序提取 PPTX 文字", async () => {
    const bytes = await officeBytes({
      "ppt/slides/slide2.xml":
        '<p:sld xmlns:a="urn:a" xmlns:p="urn:p"><a:p><a:t>第二页</a:t></a:p></p:sld>',
      "ppt/slides/slide1.xml":
        '<p:sld xmlns:a="urn:a" xmlns:p="urn:p"><a:p><a:t>第一页</a:t></a:p></p:sld>',
    });
    expect(await parseOfficePreview("deck.pptx", bytes)).toEqual([
      { title: "ppt/slides/slide1.xml", lines: ["第一页"] },
      { title: "ppt/slides/slide2.xml", lines: ["第二页"] },
    ]);
  });

  it("拒绝过大或损坏的文件", async () => {
    await expect(
      parseOfficePreview("report.docx", new Uint8Array(MAX_OFFICE_PREVIEW_BYTES + 1)),
    ).rejects.toThrow("exceeds preview limit");
    await expect(parseOfficePreview("report.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
