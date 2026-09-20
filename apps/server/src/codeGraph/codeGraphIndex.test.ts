import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  CODEGRAPH_GUIDANCE_PROMPT,
  hasCodeGraphIndex,
  spawnCodeGraphIndexInit,
  unsafeCodeGraphIndexRootReason,
  type CodeGraphSpawnImpl,
  type SpawnCodeGraphInitOptions,
} from "./codeGraphIndex.ts";
import { getCodeGraphIndexProgress, setCodeGraphProgress } from "./codeGraphProgress.ts";

const makeTempRoot = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codegraph-test-"));

type FakeChild = {
  readonly child: {
    on(event: string, callback: (cause?: unknown, ...rest: ReadonlyArray<unknown>) => void): void;
    unref(): void;
    stdout: { on(event: string, callback: (chunk: unknown) => void): void };
    stderr: { on(event: string, callback: (chunk: unknown) => void): void };
  };
  readonly emit: (event: string, ...args: ReadonlyArray<unknown>) => void;
  readonly emitStdout: (chunk: unknown) => void;
  readonly emitStderr: (chunk: unknown) => void;
};

const makeFakeChild = (): FakeChild => {
  const listeners = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
  const stdoutListeners: Array<(chunk: unknown) => void> = [];
  const stderrListeners: Array<(chunk: unknown) => void> = [];
  const on = (event: string, callback: (...args: ReadonlyArray<unknown>) => void): void => {
    const existing = listeners.get(event) ?? [];
    existing.push(callback);
    listeners.set(event, existing);
  };
  return {
    child: {
      on,
      unref: () => {},
      stdout: { on: (_event, callback) => void stdoutListeners.push(callback) },
      stderr: { on: (_event, callback) => void stderrListeners.push(callback) },
    },
    emit: (event, ...args) => {
      for (const callback of listeners.get(event) ?? []) callback(...args);
    },
    emitStdout: (chunk) => {
      for (const callback of stdoutListeners) callback(chunk);
    },
    emitStderr: (chunk) => {
      for (const callback of stderrListeners) callback(chunk);
    },
  };
};

const fakeSpawnImpl =
  (
    child: FakeChild,
    record?: Array<{ command: string; args: ReadonlyArray<string> }>,
  ): CodeGraphSpawnImpl =>
  (command, args) => {
    record?.push({ command, args });
    return child.child;
  };

const spawnOptions = (root: string, child: FakeChild): SpawnCodeGraphInitOptions => ({
  root,
  homeDir: NodeOS.tmpdir(),
  spawnImpl: fakeSpawnImpl(child),
});

describe("unsafeCodeGraphIndexRootReason", () => {
  it("rejects drive roots and the home directory itself", () => {
    const homeDir = NodeOS.tmpdir();
    expect(unsafeCodeGraphIndexRootReason({ root: homeDir, homeDir })).toBe("用户主目录");
    const driveRoot = NodePath.parse(NodePath.resolve(homeDir)).root;
    expect(unsafeCodeGraphIndexRootReason({ root: driveRoot, homeDir })).toBe("盘符根目录");
  });

  it("accepts ordinary project directories, case-insensitively on Windows", () => {
    const homeDir = NodePath.join(NodeOS.tmpdir(), "projects");
    const projectDir = NodePath.join(homeDir, "demo");
    expect(unsafeCodeGraphIndexRootReason({ root: projectDir, homeDir })).toBeNull();
    if (process.platform === "win32") {
      expect(
        unsafeCodeGraphIndexRootReason({ root: projectDir.toUpperCase(), homeDir }),
      ).toBeNull();
    }
  });
});

describe("hasCodeGraphIndex", () => {
  it("is false without the directory and true once .codegraph exists", () => {
    const root = makeTempRoot();
    expect(hasCodeGraphIndex(root)).toBe(false);
    NodeFS.mkdirSync(NodePath.join(root, ".codegraph"));
    expect(hasCodeGraphIndex(root)).toBe(true);
  });
});

describe("spawnCodeGraphIndexInit", () => {
  it("spawns init once per root, dedupes while in flight, and releases on close", () => {
    const root = makeTempRoot();
    const child = makeFakeChild();
    const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const options: SpawnCodeGraphInitOptions = {
      ...spawnOptions(root, child),
      spawnImpl: fakeSpawnImpl(child, spawned),
    };

    expect(spawnCodeGraphIndexInit(options)).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe("codegraph");
    // Windows 走 shell 派生时模块会给参数包裹双引号；剥掉引号后应与原始参数一致。
    expect((spawned[0]?.args ?? []).map((arg) => arg.replaceAll('"', ""))).toEqual([
      "init",
      "--yes",
      root,
    ]);

    // 同一 root 在 init 进行中不重复拉起。
    expect(spawnCodeGraphIndexInit(options)).toBe(false);
    expect(spawned).toHaveLength(1);

    // 进程退出后释放占用；索引仍不存在，允许再次补建。
    child.emit("close");
    expect(spawnCodeGraphIndexInit(options)).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it("refuses unsafe roots and roots that already carry an index", () => {
    const child = makeFakeChild();
    const spawned: Array<unknown> = [];
    const spawnImpl: CodeGraphSpawnImpl = () => {
      spawned.push(1);
      return child.child;
    };

    expect(
      spawnCodeGraphIndexInit({
        root: NodeOS.tmpdir(),
        homeDir: NodeOS.tmpdir(),
        spawnImpl,
      }),
    ).toBe(false);

    const indexed = makeTempRoot();
    NodeFS.mkdirSync(NodePath.join(indexed, ".codegraph"));
    expect(
      spawnCodeGraphIndexInit({
        root: indexed,
        spawnImpl,
      }),
    ).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it("stops retrying a root after a spawn error and reports through logWarning", () => {
    const root = makeTempRoot();
    const child = makeFakeChild();
    const warnings: string[] = [];
    const options: SpawnCodeGraphInitOptions = {
      ...spawnOptions(root, child),
      logWarning: (message) => warnings.push(message),
    };

    expect(spawnCodeGraphIndexInit(options)).toBe(true);
    child.emit("error", new Error("ENOENT"));
    expect(warnings).toHaveLength(1);

    // 失败根在进程生命周期内不再重试，避免每个回合刷警告。
    expect(spawnCodeGraphIndexInit(options)).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe("CODEGRAPH_GUIDANCE_PROMPT", () => {
  it("carries both the positive scope and the fallback instruction", () => {
    expect(CODEGRAPH_GUIDANCE_PROMPT).toContain("codegraph.explore");
    expect(CODEGRAPH_GUIDANCE_PROMPT).toContain("不要调用 codegraph.explore");
    expect(CODEGRAPH_GUIDANCE_PROMPT).toContain("改用常规工具");
  });
});

describe("spawnCodeGraphIndexInit progress capture", () => {
  it("walks queued → phase lines → complete from init stdout", () => {
    const root = makeTempRoot();
    const child = makeFakeChild();
    setCodeGraphProgress(root, "queued");
    expect(spawnCodeGraphIndexInit(spawnOptions(root, child))).toBe(true);

    child.emitStdout("\x1b[36m◆  Scanning files...\x1b[39m\nParsing code...\n");
    expect(getCodeGraphIndexProgress(root)?.phase).toBe("parsing");

    child.emitStderr("Resolving refs...\n");
    expect(getCodeGraphIndexProgress(root)?.phase).toBe("resolving");

    child.emitStdout("● 13 nodes, 10 edges in 948ms\n└ Done\n");
    child.emit("close");
    const progress = getCodeGraphIndexProgress(root);
    expect(progress?.phase).toBe("complete");
    expect(progress?.detail).toContain("13 nodes");
  });

  it("marks the phase failed when init exits without a completion summary", () => {
    const root = makeTempRoot();
    const child = makeFakeChild();
    expect(spawnCodeGraphIndexInit(spawnOptions(root, child))).toBe(true);

    child.emitStdout("Scanning files...\n");
    child.emit("close");
    const progress = getCodeGraphIndexProgress(root);
    expect(progress?.phase).toBe("failed");
    // 释放 in-flight 的既有语义不变：仍允许下一次回合补建。
    expect(spawnCodeGraphIndexInit(spawnOptions(root, makeFakeChild()))).toBe(true);
  });

  it("marks the phase failed on spawn errors without throwing", () => {
    const root = makeTempRoot();
    const child = makeFakeChild();
    const warnings: string[] = [];
    expect(
      spawnCodeGraphIndexInit({
        ...spawnOptions(root, child),
        logWarning: (m) => warnings.push(m),
      }),
    ).toBe(true);
    child.emit("error", new Error("ENOENT"));
    const progress = getCodeGraphIndexProgress(root);
    expect(progress?.phase).toBe("failed");
    expect(warnings).toHaveLength(1);
  });
});
