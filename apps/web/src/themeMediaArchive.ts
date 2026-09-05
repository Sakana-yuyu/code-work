import type { JSZipObject, JSZipStreamHelper } from "jszip";
import { parseThemeFile, serializeThemeFile, type ThemeDefinition } from "./themePalette";
import { themeAssetIds, type ThemeDecorations, type ThemeMedia } from "./themeDecoration";
import { prepareThemeAsset, readThemeAsset, removeThemeAsset, writeThemeAsset } from "./themeMedia";
import { t } from "./i18n/runtime";

export const MAX_THEME_PACKAGE_BYTES = 220 * 1024 * 1024;
const invalidPackage = () => new Error(t("themeMedia.packageInvalid"));

export function mapThemeMedia(
  theme: ThemeDefinition,
  map: (media: ThemeMedia) => ThemeMedia | undefined,
): ThemeDefinition {
  if (!theme.decorations) return theme;
  const decorations = Object.fromEntries(
    Object.entries(theme.decorations).map(([mode, regions]) => [
      mode,
      Object.fromEntries(
        Object.entries(regions).map(([region, surface]) => {
          const { media, ...rest } = surface;
          const mapped = media ? map(media) : undefined;
          return [region, { ...rest, ...(mapped ? { media: mapped } : {}) }];
        }),
      ),
    ]),
  ) as ThemeDecorations;
  return { ...theme, decorations };
}

export async function exportThemeMediaPackage(theme: ThemeDefinition): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const mediaTypes: Record<string, string> = {};
  let bytes = 0;
  for (const id of themeAssetIds(theme.decorations)) {
    const asset = await readThemeAsset(id);
    bytes += asset.blob.size;
    if (bytes > MAX_THEME_PACKAGE_BYTES - 1024 * 1024) throw invalidPackage();
    mediaTypes[id] = asset.blob.type;
    zip.file(`assets/${id}`, await asset.blob.arrayBuffer());
  }
  zip.file("theme.json", JSON.stringify({ ...JSON.parse(serializeThemeFile(theme)), mediaTypes }));
  // 图片和视频已经压缩，直接存储避免为了几 KB 占用 CPU 再压一遍。
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

/** 在解压流上限制实际字节数，不信任 ZIP 中声明的大小。 */
export function readThemeZipEntry(entry: JSZipObject, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // JSZip 3.10 已实现此流接口，但文件对象的类型声明漏掉了它。
    const stream = (
      entry as JSZipObject & { internalStream(type: "uint8array"): JSZipStreamHelper<Uint8Array> }
    ).internalStream("uint8array");
    stream.on("data", (chunk: Uint8Array) => {
      bytes += chunk.length;
      if (bytes > limit) {
        stream.pause();
        reject(invalidPackage());
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () => reject(invalidPackage()));
    stream.on("end", () => {
      const output = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(output);
    });
    stream.resume();
  });
}

export async function importThemeMediaPackage(file: File): Promise<ThemeDefinition> {
  if (file.size > MAX_THEME_PACKAGE_BYTES) throw invalidPackage();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifest = zip.file("theme.json");
  if (!manifest || Object.keys(zip.files).length > 16) throw invalidPackage();
  const value: unknown = JSON.parse(
    new TextDecoder().decode(await readThemeZipEntry(manifest, 256 * 1024)),
  );
  const theme = parseThemeFile(value);
  const mediaTypes =
    typeof value === "object" &&
    value !== null &&
    "mediaTypes" in value &&
    typeof value.mediaTypes === "object" &&
    value.mediaTypes !== null
      ? (value.mediaTypes as Record<string, unknown>)
      : {};
  const replacements = new Map<string, ThemeMedia>();
  let bytes = 0;
  try {
    for (const id of themeAssetIds(theme.decorations)) {
      const entry = zip.file(`assets/${id}`);
      if (!entry) throw invalidPackage();
      const data = await readThemeZipEntry(entry, MAX_THEME_PACKAGE_BYTES - bytes);
      bytes += data.byteLength;
      const media = Object.values(theme.decorations ?? {})
        .flatMap(Object.values)
        .find((surface) => surface.media?.value === id)?.media;
      if (!media) throw invalidPackage();
      const mime = mediaTypes[id];
      if (typeof mime !== "string" || !/^(image|video)\/[a-z0-9.+-]+$/i.test(mime))
        throw invalidPackage();
      const asset = await prepareThemeAsset(
        new File(
          [data as Uint8Array<ArrayBuffer>],
          media.name ?? (media.kind === "video" ? "background.mp4" : "background.webp"),
          { type: mime },
        ),
      );
      if (asset.kind !== media.kind) throw invalidPackage();
      replacements.set(id, await writeThemeAsset(asset));
    }
    return mapThemeMedia(theme, (media) =>
      media.source === "asset" ? replacements.get(media.value) : media,
    );
  } catch (cause) {
    await Promise.all(
      [...replacements.values()].map((media) =>
        removeThemeAsset(media.value).catch(() => undefined),
      ),
    );
    throw cause;
  }
}
