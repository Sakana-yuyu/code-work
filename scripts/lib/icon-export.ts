import { PNG } from "pngjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export interface PngIconImage {
  readonly size: number;
  readonly contents: Buffer;
}

export function resizePng(contents: Buffer, size: number): Buffer {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`PNG output size must be a positive integer, got ${size}.`);
  }

  const source = PNG.sync.read(contents);
  const target = new PNG({ width: size, height: size });
  const xScale = source.width / size;
  const yScale = source.height / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const targetIndex = (y * size + x) * 4;
      const sourceLeft = x * xScale;
      const sourceRight = (x + 1) * xScale;
      const sourceTop = y * yScale;
      const sourceBottom = (y + 1) * yScale;
      const firstSourceX = Math.floor(sourceLeft);
      const lastSourceX = Math.min(source.width - 1, Math.ceil(sourceRight) - 1);
      const firstSourceY = Math.floor(sourceTop);
      const lastSourceY = Math.min(source.height - 1, Math.ceil(sourceBottom) - 1);

      // 按覆盖面积混合，并以预乘 alpha 计算，避免透明边缘把隐藏颜色带进图标。
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sourceY = firstSourceY; sourceY <= lastSourceY; sourceY += 1) {
        const overlapY = Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY);
        if (overlapY <= 0) continue;
        for (let sourceX = firstSourceX; sourceX <= lastSourceX; sourceX += 1) {
          const overlapX = Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX);
          const area = overlapX * overlapY;
          if (area <= 0) continue;
          const sourceIndex = (sourceY * source.width + sourceX) * 4;
          const sourceAlpha = (source.data[sourceIndex + 3] ?? 0) / 255;
          const weightedAlpha = sourceAlpha * area;
          red += (source.data[sourceIndex] ?? 0) * weightedAlpha;
          green += (source.data[sourceIndex + 1] ?? 0) * weightedAlpha;
          blue += (source.data[sourceIndex + 2] ?? 0) * weightedAlpha;
          alpha += weightedAlpha;
        }
      }

      const outputAlpha = Math.round((alpha / (xScale * yScale)) * 255);
      target.data[targetIndex + 3] = outputAlpha;
      if (alpha === 0) {
        target.data[targetIndex] = 0;
        target.data[targetIndex + 1] = 0;
        target.data[targetIndex + 2] = 0;
      } else {
        target.data[targetIndex] = Math.round(red / alpha);
        target.data[targetIndex + 1] = Math.round(green / alpha);
        target.data[targetIndex + 2] = Math.round(blue / alpha);
      }
    }
  }

  return PNG.sync.write(target);
}

export function readPngDimensions(contents: Buffer): {
  readonly width: number;
  readonly height: number;
} {
  if (
    contents.length < 24 ||
    !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Icon Composer produced an invalid PNG.");
  }

  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

/** Encodes PNG renditions directly into a modern, multi-resolution ICO file. */
export function encodePngIco(images: ReadonlyArray<PngIconImage>): Buffer {
  if (images.length === 0) {
    throw new Error("An ICO file requires at least one PNG rendition.");
  }

  const seenSizes = new Set<number>();
  for (const image of images) {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new Error(`ICO rendition size must be an integer from 1 to 256, got ${image.size}.`);
    }
    if (seenSizes.has(image.size)) {
      throw new Error(`ICO rendition size ${image.size} was provided more than once.`);
    }
    if (image.contents.length === 0) {
      throw new Error(`ICO rendition ${image.size}x${image.size} is empty.`);
    }
    seenSizes.add(image.size);
  }

  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = directoryEntrySize * images.length;
  const header = Buffer.alloc(headerSize + directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = header.length;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * directoryEntrySize;
    const encodedSize = image.size === 256 ? 0 : image.size;
    header.writeUInt8(encodedSize, entryOffset);
    header.writeUInt8(encodedSize, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.contents.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.contents.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.contents)]);
}
