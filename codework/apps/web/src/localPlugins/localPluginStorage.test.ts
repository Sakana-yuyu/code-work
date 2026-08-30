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

  it("兼容无修订元数据的旧文档，并保留新文档的写入者信息", () => {
    expect(decodeLocalPluginStorageDocument('{"version":1,"plugins":[]}')).toEqual({
      version: 1,
      plugins: [],
    });
    expect(
      decodeLocalPluginStorageDocument(
        encodeLocalPluginStorageDocument([], { revision: 3, writerId: "writer-a" }),
      ),
    ).toEqual({ version: 1, revision: 3, writerId: "writer-a", plugins: [] });
    expect(() =>
      decodeLocalPluginStorageDocument('{"version":1,"revision":3,"plugins":[]}'),
    ).toThrow("本地插件存储修订信息不完整");
  });

  it("只订阅当前命名空间的浏览器存储变化，并支持解除订阅", () => {
    const events = new EventTarget();
    const storage = new BrowserLocalPluginStorage(
      { getItem: vi.fn(() => null), setItem: vi.fn() },
      "codework:local-plugins:v1",
      events,
    );
    const listener = vi.fn();
    const unsubscribe = storage.subscribe(listener);
    const dispatchStorage = (key: string | null) => {
      const event = new Event("storage");
      Object.defineProperty(event, "key", { value: key });
      events.dispatchEvent(event);
    };

    dispatchStorage("other:key");
    dispatchStorage("codework:local-plugins:v1");
    dispatchStorage(null);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    dispatchStorage("codework:local-plugins:v1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("在同源互斥区内同时校验原始值和修订号，再执行比较交换", async () => {
    let value = encodeLocalPluginStorageDocument([], { revision: 7, writerId: "writer-a" });
    const getItem = vi.fn(() => value);
    const setItem = vi.fn((_key: string, nextValue: string) => {
      value = nextValue;
    });
    const requests: Array<{
      readonly name: string;
      readonly options: { readonly mode: "exclusive" };
    }> = [];
    const lockManager = {
      async request<A>(
        name: string,
        options: { readonly mode: "exclusive" },
        callback: () => A | Promise<A>,
      ): Promise<A> {
        requests.push({ name, options });
        return callback();
      },
    };
    const storage = new BrowserLocalPluginStorage(
      { getItem, setItem },
      "codework:local-plugins:v1",
      null,
      lockManager,
    );
    const nextValue = encodeLocalPluginStorageDocument([], {
      revision: 8,
      writerId: "writer-b",
    });

    await expect(
      storage.compareAndSwap({
        expectedValue: value,
        expectedRevision: 7,
        nextValue,
      }),
    ).resolves.toEqual({ swapped: true, currentValue: nextValue });
    await expect(
      storage.compareAndSwap({
        expectedValue: encodeLocalPluginStorageDocument([], {
          revision: 7,
          writerId: "writer-a",
        }),
        expectedRevision: 7,
        nextValue: encodeLocalPluginStorageDocument([], {
          revision: 8,
          writerId: "writer-c",
        }),
      }),
    ).resolves.toEqual({ swapped: false, currentValue: nextValue });

    expect(requests).toEqual([
      { name: "codework:local-plugins:v1:write", options: { mode: "exclusive" } },
      { name: "codework:local-plugins:v1:write", options: { mode: "exclusive" } },
    ]);
    expect(setItem).toHaveBeenCalledTimes(1);
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
