import { prepareImageForAttachment, isHeicImageFile } from "./lib/imageCompression";
import { isThemeAssetId, type ThemeMedia } from "./themeDecoration";
import { t } from "./i18n/runtime";
import { randomUUID } from "./lib/utils";

export const MAX_BACKGROUND_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_BACKGROUND_VIDEO_BYTES = 200 * 1024 * 1024;
export const THEME_MEDIA_ACCEPT =
  "image/*,video/*,.heic,.heif,.avif,.svg,.bmp,.ico,.tif,.tiff,.mov,.mkv,.m4v";
export type ThemeAsset = { blob: Blob; name: string; kind: "image" | "video" };

/** 独立的客户端资源库，不经过供应商、服务器或聊天附件上传通道。 */
async function mediaDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("codework-theme-media", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("assets"));
    request.addEventListener("error", () => reject(new Error(t("themeMedia.storageFailed"))));
    request.addEventListener("blocked", () => reject(new Error(t("themeMedia.storageFailed"))));
    request.addEventListener("success", () => resolve(request.result));
  });
}

async function assetTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await mediaDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("assets", mode);
      const request = operation(tx.objectStore("assets"));
      tx.addEventListener("complete", () => resolve(request.result));
      tx.addEventListener("error", () => reject(new Error(t("themeMedia.storageFailed"))));
      tx.addEventListener("abort", () => reject(new Error(t("themeMedia.storageFailed"))));
    });
  } finally {
    db.close();
  }
}

export async function readThemeAsset(id: string): Promise<ThemeAsset> {
  if (!isThemeAssetId(id)) throw new Error(t("themeMedia.missing"));
  const asset: unknown = await assetTransaction("readonly", (store) => store.get(id));
  if (
    !asset ||
    typeof asset !== "object" ||
    !("blob" in asset) ||
    !(asset.blob instanceof Blob) ||
    !("kind" in asset) ||
    (asset.kind !== "image" && asset.kind !== "video")
  )
    throw new Error(t("themeMedia.missing"));
  return {
    blob: asset.blob,
    kind: asset.kind,
    name: "name" in asset && typeof asset.name === "string" ? asset.name : "background",
  };
}

export async function writeThemeAsset(asset: ThemeAsset): Promise<ThemeMedia> {
  const id = randomUUID();
  await assetTransaction("readwrite", (store) => store.put(asset, id));
  return { kind: asset.kind, source: "asset", value: id, name: asset.name };
}

export async function removeThemeAsset(id: string) {
  if (isThemeAssetId(id)) await assetTransaction("readwrite", (store) => store.delete(id));
}

export function backgroundFileKind(file: Pick<File, "name" | "type" | "size">): "image" | "video" {
  const kind =
    file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(file.name)
      ? "video"
      : "image";
  if (
    !file.size ||
    file.size > (kind === "video" ? MAX_BACKGROUND_VIDEO_BYTES : MAX_BACKGROUND_IMAGE_BYTES)
  ) {
    throw new Error(t(kind === "video" ? "themeMedia.videoSize" : "themeMedia.imageSize"));
  }
  if (
    kind === "image" &&
    !file.type.startsWith("image/") &&
    !/\.(png|jpe?g|webp|gif|avif|svg|bmp|ico|hei[cf]|tiff?)$/i.test(file.name)
  )
    throw new Error(t("themeMedia.unsupportedImage"));
  return kind;
}

/** 真正尝试解码，不把扩展名当作编码受支持的证明；所有对象 URL 都有释放路径。 */
export async function prepareThemeAsset(file: File): Promise<ThemeAsset> {
  const kind = backgroundFileKind(file);
  if (kind === "video") {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(t("themeMedia.unsupportedVideo"))),
          15_000,
        );
        video.addEventListener(
          "loadedmetadata",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        video.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error(t("themeMedia.unsupportedVideo")));
          },
          { once: true },
        );
        video.src = url;
      });
      if (!video.videoWidth || !video.videoHeight)
        throw new Error(t("themeMedia.unsupportedVideo"));
      return { blob: file, name: file.name, kind };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }
  let source = file;
  if (isHeicImageFile(file)) {
    const converted = await prepareImageForAttachment(file, 12 * 1024 * 1024);
    if (!converted.ok) throw new Error(t("themeMedia.unsupportedImage"));
    source = converted.file;
  }
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(t("themeMedia.unsupportedImage"))), 15_000);
      image.addEventListener(
        "load",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error(t("themeMedia.unsupportedImage")));
        },
        { once: true },
      );
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 64_000_000
    )
      throw new Error(t("themeMedia.imageSize"));
    const scale = Math.min(1, 3840 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("themeMedia.unsupportedImage"));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error(t("themeMedia.unsupportedImage")))),
        "image/webp",
        0.9,
      ),
    );
    return { blob, name: file.name, kind };
  } finally {
    URL.revokeObjectURL(url);
  }
}
