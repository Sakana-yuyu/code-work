import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { exportThemeMediaPackage, importThemeMediaPackage } from "./themeMediaArchive";
import { parseThemeFile } from "./themePalette";
import { themeAssetIds } from "./themeDecoration";
import type { ThemeAsset } from "./themeMedia";
import JSZip from "jszip";

const assets = vi.hoisted(() => new Map<string, ThemeAsset>());
vi.mock("./themeMedia", () => ({
  readThemeAsset: async (id: string) => {
    const asset = assets.get(id);
    if (!asset) throw new Error("资源不存在");
    return asset;
  },
  prepareThemeAsset: async (file: File) => ({ blob: file, name: file.name, kind: "video" }),
  writeThemeAsset: async (asset: ThemeAsset) => {
    const value = `00000000-0000-4000-8000-${String(assets.size + 1).padStart(12, "0")}`;
    assets.set(value, asset);
    return { source: "asset", value, kind: asset.kind, name: asset.name };
  },
  removeThemeAsset: async (id: string) => assets.delete(id),
}));
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  assets.clear();
  assets.set(id, {
    blob: new Blob(["测试视频字节"], { type: "video/mp4" }),
    kind: "video",
    name: "test.mp4",
  });
});
const theme = () =>
  parseThemeFile({
    version: 1,
    name: "媒体往返",
    appearance: "light",
    colors: { canvas: "#ffffff" },
    decorations: {
      light: { global: { media: { kind: "video", source: "asset", value: id }, dim: 45 } },
    },
  });

describe("主题包导入导出", () => {
  it("真实 ZIP 往返保留媒体，导入分配新资源而不覆盖原文件", async () => {
    const exported = await exportThemeMediaPackage(theme());
    const zip = await JSZip.loadAsync(await exported.arrayBuffer());
    expect(await zip.file(`assets/${id}`)!.async("string")).toBe("测试视频字节");
    const imported = await importThemeMediaPackage(new File([exported], "theme.zip"));
    const [newId] = themeAssetIds(imported.decorations);
    expect(newId).not.toBe(id);
    expect(assets.size).toBe(2);
    expect(await assets.get(newId!)!.blob.text()).toBe("测试视频字节");
    expect(imported.decorations?.light?.global?.dim).toBe(45);
  });
  it("缺失媒体不会返回半成品主题或改动原资源", async () => {
    const zip = new JSZip();
    zip.file("theme.json", JSON.stringify({ ...theme(), version: 1, name: "缺失媒体" }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(
      importThemeMediaPackage(new File([bytes as Uint8Array<ArrayBuffer>], "broken.zip")),
    ).rejects.toThrow();
    expect([...assets.keys()]).toEqual([id]);
  });
});
