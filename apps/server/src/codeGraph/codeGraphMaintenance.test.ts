// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  getCodeGraphInstallState,
  installCodeGraphCli,
  parseCodeGraphStatusJson,
  readCodeGraphCliVersion,
  reindexCodeGraph,
  syncCodeGraphIndex,
  type CodeGraphMaintSpawnImpl,
  type CodeGraphMaintSpawnedChild,
} from "./codeGraphMaintenance.ts";
import {
  isCodeGraphInitInFlight,
  spawnCodeGraphIndexInit,
  type CodeGraphSpawnImpl,
} from "./codeGraphIndex.ts";
import { getCodeGraphIndexProgress, setCodeGraphProgress } from "./codeGraphProgress.ts";

type FakeMaintChild = {
  readonly child: CodeGraphMaintSpawnedChild;
  readonly emit: (event: "error" | "close", ...args: ReadonlyArray<unknown>) => void;
  readonly emitStdout: (chunk: unknown) => void;
  readonly emitStderr: (chunk: unknown) => void;
};

const makeMaintChild = (): FakeMaintChild => {
  const childListeners = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
  const stdoutListeners: Array<(chunk: unknown) => void> = [];
  const stderrListeners: Array<(chunk: unknown) => void> = [];
  const onChildEvent = (event: string, callback: (...args: ReadonlyArray<unknown>) => void) => {
    const existing = childListeners.get(event) ?? [];
    existing.push(callback);
    childListeners.set(event, existing);
  };
  return {
    child: {
      on: onChildEvent as unknown as CodeGraphMaintSpawnedChild["on"],
      stdout: { on: (_event, callback) => void stdoutListeners.push(callback) },
      stderr: { on: (_event, callback) => void stderrListeners.push(callback) },
    },
    emit: (event, ...args) => {
      for (const callback of childListeners.get(event) ?? []) callback(...args);
    },
    emitStdout: (chunk) => {
      for (const callback of stdoutListeners) callback(chunk);
    },
    emitStderr: (chunk) => {
      for (const callback of stderrListeners) callback(chunk);
    },
  };
};

/** spawnImpl 注入：spawnImpl 抛错即「CLI/npm 无法启动」。 */
const maintSpawnThrowing =
  (cause: unknown): CodeGraphMaintSpawnImpl =>
  () => {
    throw cause;
  };

/** spawnImpl 的脚本在微任务里执行：先吐流再退出，保证监听器已注册。 */
const maintSpawnScripted = (
  script: (child: FakeMaintChild) => void,
  record?: Array<{ command: string }>,
): CodeGraphMaintSpawnImpl => {
  const child = makeMaintChild();
  queueMicrotask(() => script(child));
  return (command) => {
    record?.push({ command });
    return child.child;
  };
};

const failing = maintSpawnThrowing(new Error("spawn codegraph ENOENT"));

describe("parseCodeGraphStatusJson", () => {
  it("reads the full status payload", () => {
    const status = parseCodeGraphStatusJson(
      JSON.stringify({
        initialized: true,
        version: "1.5.0",
        fileCount: 120,
        nodeCount: 340,
        edgeCount: 300,
        dbSizeBytes: 204800,
        languages: ["ts", "tsx"],
        lastIndexed: "2026-09-20T00:00:00.000Z",
        pendingChanges: { added: 1, modified: 2, removed: 3 },
        index: { reindexRecommended: false },
      }),
    );
    expect(status.initialized).toBe(true);
    expect(status.cliVersion).toBe("1.5.0");
    expect(status.fileCount).toBe(120);
    expect(status.nodeCount).toBe(340);
    expect(status.edgeCount).toBe(300);
    expect(status.dbSizeBytes).toBe(204800);
    expect(status.languages).toEqual(["ts", "tsx"]);
    expect(status.lastIndexed).toBe("2026-09-20T00:00:00.000Z");
    expect(status.pendingChanges).toEqual({ added: 1, modified: 2, removed: 3 });
    expect(status.reindexRecommended).toBe(false);
  });

  it("degrades every field on garbage input instead of throwing", () => {
    const status = parseCodeGraphStatusJson("not json at all");
    expect(status.initialized).toBe(false);
    expect(status.cliVersion).toBeNull();
    expect(status.fileCount).toBeNull();
    expect(status.languages).toEqual([]);
    expect(status.pendingChanges).toBeNull();
    expect(status.reindexRecommended).toBe(false);
  });

  it("drops mistyped fields but keeps well-typed neighbours", () => {
    const status = parseCodeGraphStatusJson(
      JSON.stringify({
        initialized: "yes",
        fileCount: -5,
        nodeCount: 12,
        languages: ["ts", 42],
        pendingChanges: { added: "x", modified: 1, removed: 0 },
        index: { reindexRecommended: true },
      }),
    );
    expect(status.initialized).toBe(false);
    expect(status.fileCount).toBeNull();
    expect(status.nodeCount).toBe(12);
    expect(status.languages).toEqual(["ts"]);
    expect(status.pendingChanges).toEqual({ added: 0, modified: 1, removed: 0 });
    expect(status.reindexRecommended).toBe(true);
  });
});

describe("readCodeGraphCliVersion", () => {
  it("caches the probe and refreshes it after a successful install", async () => {
    let spawnCount = 0;
    const spawnCounting: CodeGraphMaintSpawnImpl = () => {
      spawnCount += 1;
      const child = makeMaintChild();
      queueMicrotask(() => {
        child.emitStdout("1.5.0\n");
        child.emit("close", 0);
      });
      return child.child;
    };
    // 第一次拉子进程探测；60s 缓存内的第二次轮询不再拉。
    expect(await readCodeGraphCliVersion({ spawnImpl: spawnCounting })).toBe("1.5.0");
    expect(await readCodeGraphCliVersion({ spawnImpl: spawnCounting })).toBe("1.5.0");
    expect(spawnCount).toBe(1);
    // 安装成功清掉版本缓存：下一次探测重新拉子进程（这里走 CLI 缺失路径得 null）。
    await installCodeGraphCli({
      spawnImpl: maintSpawnScripted((child) => child.emit("close", 0)),
    });
    expect(await readCodeGraphCliVersion({ spawnImpl: failing })).toBeNull();
  });
});

describe("installCodeGraphCli", () => {
  it("reports success on npm exit 0", async () => {
    const state = await installCodeGraphCli({
      spawnImpl: maintSpawnScripted((child) => child.emit("close", 0)),
    });
    expect(state.status).toBe("succeeded");
    expect(getCodeGraphInstallState().status).toBe("succeeded");
  });

  it("reports failure with the exit code on npm exit 1", async () => {
    const state = await installCodeGraphCli({
      spawnImpl: maintSpawnScripted((child) => child.emit("close", 1)),
    });
    expect(state.status).toBe("failed");
    expect(state.message).toContain("1");
  });

  it("reports failure when npm itself is missing", async () => {
    const state = await installCodeGraphCli({
      spawnImpl: maintSpawnThrowing(new Error("spawn npm ENOENT")),
    });
    expect(state.status).toBe("failed");
    expect(state.message).toContain("npm");
  });

  it("dedupes concurrent installs behind a single npm process", async () => {
    let spawnCount = 0;
    const child = makeMaintChild();
    const spawnImpl: CodeGraphMaintSpawnImpl = () => {
      spawnCount += 1;
      return child.child;
    };
    const first = installCodeGraphCli({ spawnImpl });
    // 第一条 install 的同步前缀已把状态推进到 running；第二条只登记不重复拉起。
    const second = installCodeGraphCli({ spawnImpl });
    expect(spawnCount).toBe(1);
    expect(getCodeGraphInstallState().status).toBe("running");
    child.emit("close", 0);
    const firstState = await first;
    // 去重方返回的是登记时的快照；最终态经状态查询（getCodeGraphInstallState）读取。
    const secondState = await second;
    expect(firstState.status).toBe("succeeded");
    expect(secondState.status).toBe("running");
    expect(getCodeGraphInstallState().status).toBe("succeeded");
    expect(spawnCount).toBe(1);
  });
});

describe("syncCodeGraphIndex", () => {
  it("fails with the manual-install hint when the CLI is missing", async () => {
    const result = await syncCodeGraphIndex("Z:\\codegraph-sync-missing", { spawnImpl: failing });
    expect(result.succeeded).toBe(false);
    expect(result.message).toContain("npm i -g");
  });

  it("surfaces the first stderr line on nonzero exit", async () => {
    const result = await syncCodeGraphIndex("Z:\\codegraph-sync-fail", {
      spawnImpl: maintSpawnScripted((child) => {
        child.emitStderr("index locked by another process\n");
        child.emit("close", 1);
      }),
    });
    expect(result.succeeded).toBe(false);
    expect(result.message).toContain("index locked");
  });

  it("returns the summary line on success", async () => {
    const result = await syncCodeGraphIndex("Z:\\codegraph-sync-ok", {
      spawnImpl: maintSpawnScripted((child) => {
        child.emitStdout("Synced 3 changed files\n");
        child.emit("close", 0);
      }),
    });
    expect(result.succeeded).toBe(true);
    expect(result.message).toBe("Synced 3 changed files");
  });
});

describe("reindexCodeGraph", () => {
  it("feeds phase output into the shared progress store and completes", async () => {
    const root =
      process.platform === "win32" ? "Z:\\codegraph-reindex-ok" : "/tmp/codegraph-reindex-ok";
    setCodeGraphProgress(root, "queued");
    const result = await reindexCodeGraph(root, {
      spawnImpl: maintSpawnScripted((child) => {
        child.emitStdout("Scanning files...\nParsing code...\n");
        child.emitStdout("● 11 nodes, 9 edges in 300ms\n└ Done\n");
        child.emit("close", 0);
      }),
    });
    expect(result.succeeded).toBe(true);
    const progress = getCodeGraphIndexProgress(root);
    expect(progress?.phase).toBe("complete");
    expect(progress?.detail).toContain("11 nodes");
  });

  it("returns the failure reason on nonzero exit", async () => {
    const result = await reindexCodeGraph("Z:\\codegraph-reindex-fail", {
      spawnImpl: maintSpawnScripted((child) => {
        child.emitStderr("no index to rebuild; run codegraph init first\n");
        child.emit("close", 1);
      }),
    });
    expect(result.succeeded).toBe(false);
    expect(result.message).toContain("init");
  });
});

/** 记录 spawn 实参的脚本桩：断言命令选择时用。 */
const maintSpawnRecordingArgs = (
  script: (child: FakeMaintChild) => void,
  calls: Array<{ command: string; args: ReadonlyArray<string> }>,
): CodeGraphMaintSpawnImpl => {
  const child = makeMaintChild();
  queueMicrotask(() => script(child));
  return (command, args) => {
    calls.push({ command, args });
    return child.child;
  };
};

describe("reindexCodeGraph command choice", () => {
  it("runs `init` for a project without an existing index", async () => {
    const root =
      process.platform === "win32" ? "Z:\\codegraph-init-first" : "/tmp/codegraph-init-first";
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const result = await reindexCodeGraph(root, {
      spawnImpl: maintSpawnRecordingArgs((child) => {
        child.emitStdout("● 5 nodes, 3 edges\n└ Done\n");
        child.emit("close", 0);
      }, calls),
    });
    expect(result.succeeded).toBe(true);
    const flat = calls[0]!.args.map((arg) => arg.replaceAll('"', ""));
    expect(flat).toEqual(["init", root]);
  });

  it("runs `index` for a project that already has an index", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codegraph-reindex-"));
    try {
      await NodeFS.mkdir(NodePath.join(root, ".codegraph"));
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const result = await reindexCodeGraph(root, {
        spawnImpl: maintSpawnRecordingArgs((child) => {
          child.emit("close", 0);
        }, calls),
      });
      expect(result.succeeded).toBe(true);
      expect(calls[0]!.args.map((arg) => arg.replaceAll('"', ""))).toEqual(["index"]);
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("does not spawn a second build while the background init is in flight", async () => {
    const root =
      process.platform === "win32" ? "Z:\\codegraph-init-inflight" : "/tmp/codegraph-init-inflight";
    const hangingChild = {
      on: () => ({}),
      stdout: null,
      stderr: null,
      unref: () => {},
    };
    spawnCodeGraphIndexInit({ root, spawnImpl: () => hangingChild as never });
    expect(isCodeGraphInitInFlight(root)).toBe(true);
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const result = await reindexCodeGraph(root, {
      spawnImpl: (command, args) => {
        calls.push({ command, args });
        return makeMaintChild().child;
      },
    });
    expect(result.succeeded).toBe(true);
    expect(result.message).toContain("后台");
    expect(calls).toHaveLength(0);
  });
});
