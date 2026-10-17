import { PNG } from "pngjs";
import { assert, describe, it } from "@effect/vitest";

import { encodePngIco, readPngDimensions, resizePng } from "./icon-export.ts";

const pngHeader = (width: number, height: number) => {
  const contents = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(contents);
  contents.write("IHDR", 12, "ascii");
  contents.writeUInt32BE(width, 16);
  contents.writeUInt32BE(height, 20);
  return contents;
};

describe("icon export", () => {
  it("reads dimensions from a PNG IHDR chunk", () => {
    assert.deepEqual(readPngDimensions(pngHeader(1024, 512)), { width: 1024, height: 512 });
  });

  it("resizes a PNG deterministically", () => {
    const png = new PNG({ width: 4, height: 4 });
    png.data.fill(255);
    const source = PNG.sync.write(png);
    const resized = resizePng(source, 2);
    assert.deepEqual(readPngDimensions(resized), { width: 2, height: 2 });
    assert.deepEqual(resizePng(source, 2), resized);
  });

  it("缩小时保留细线的像素覆盖率，避免最近邻采样丢失细节", () => {
    const png = new PNG({ width: 4, height: 4 });
    for (let index = 0; index < 16; index += 1) {
      const value = index % 2 === 0 ? 0 : 255;
      png.data.set([value, value, value, 255], index * 4);
    }
    const resized = PNG.sync.read(resizePng(PNG.sync.write(png), 2));
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual([...resized.data.subarray(index * 4, index * 4 + 4)], [128, 128, 128, 255]);
    }
  });

  it("透明区域的隐藏颜色不污染白色标识边缘", () => {
    const png = new PNG({ width: 2, height: 2 });
    png.data.set([255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
    const resized = PNG.sync.read(resizePng(PNG.sync.write(png), 1));
    assert.deepEqual([...resized.data], [255, 255, 255, 64]);
  });

  it("非整数缩放按实际覆盖面积混合像素", () => {
    const png = new PNG({ width: 3, height: 3 });
    for (let index = 0; index < 9; index += 1) {
      const value = index % 3 === 1 ? 255 : 0;
      png.data.set([value, value, value, 255], index * 4);
    }
    const resized = PNG.sync.read(resizePng(PNG.sync.write(png), 2));
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual([...resized.data.subarray(index * 4, index * 4 + 4)], [85, 85, 85, 255]);
    }
  });

  it("encodes PNG renditions into an ICO directory", () => {
    const small = pngHeader(16, 16);
    const large = pngHeader(256, 256);
    const ico = encodePngIco([
      { size: 16, contents: small },
      { size: 256, contents: large },
    ]);

    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(22), 0);
    assert.equal(ico.readUInt32LE(18), 38);
    assert.equal(ico.readUInt32LE(34), 38 + small.length);
    assert.deepEqual(ico.subarray(38, 38 + small.length), small);
    assert.deepEqual(ico.subarray(38 + small.length), large);
  });

  it("rejects duplicate ICO rendition sizes", () => {
    assert.throws(
      () =>
        encodePngIco([
          { size: 32, contents: pngHeader(32, 32) },
          { size: 32, contents: pngHeader(32, 32) },
        ]),
      /provided more than once/,
    );
  });
});
