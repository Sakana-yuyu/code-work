import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BrowserLocalPluginStorage,
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
  LocalPluginStorageDuplicateIdError,
  type StoredLocalPlugin,
} from "./localPluginStorage";

const storedPlugin = (id: string): StoredLocalPlugin => ({
  manifest: {
    manifestVersion: 1,
    apiVersion: { major: 1, minor: 0 },
    id,
    name: id,
    version: "1.0.0",
    permissions: [],
    contributions: {},
  } satisfies LocalPluginManifest,
  enabled: true,
  installedAtUnixMs: 1,
  updatedAtUnixMs: 1,
});

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

  it("编码和解码都以专用错误拒绝重复插件 ID", () => {
    const plugins = [storedPlugin("acme.duplicate"), storedPlugin("acme.duplicate")];

    expect(() => encodeLocalPluginStorageDocument(plugins)).toThrowError(
      expect.objectContaining({
        name: LocalPluginStorageDuplicateIdError.name,
        pluginId: "acme.duplicate",
      }),
    );
    expect(() =>
      decodeLocalPluginStorageDocument(JSON.stringify({ version: 1, plugins })),
    ).toThrowError(
      expect.objectContaining({
        name: LocalPluginStorageDuplicateIdError.name,
        pluginId: "acme.duplicate",
      }),
    );
  });
});
