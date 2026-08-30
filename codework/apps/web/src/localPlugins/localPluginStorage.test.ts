import { describe, expect, it, vi } from "vite-plus/test";

import {
  BrowserLocalPluginStorage,
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
} from "./localPluginStorage";

describe("localPluginStorage", () => {
  it("只读写版本化命名空间，并拒绝未知存储版本", () => {
    const getItem = vi.fn(() => "stored");
    const setItem = vi.fn();
    const storage = new BrowserLocalPluginStorage({ getItem, setItem });

    expect(storage.read()).toBe("stored");
    storage.write("next");
    expect(getItem).toHaveBeenCalledWith("codework:local-plugins:v1");
    expect(setItem).toHaveBeenCalledWith("codework:local-plugins:v1", "next");
    expect(decodeLocalPluginStorageDocument(encodeLocalPluginStorageDocument([]))).toEqual({
      version: 1,
      plugins: [],
    });
    expect(() => decodeLocalPluginStorageDocument('{"version":2,"plugins":[]}')).toThrow();
  });
});
