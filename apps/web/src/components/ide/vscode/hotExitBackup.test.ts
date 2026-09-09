import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  VSBuffer,
  bufferToReadable,
  streamToBuffer,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/buffer";
import type {
  IWorkingCopy,
  IWorkingCopyIdentifier,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopy";
import type { IWorkingCopyService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyService.service";
import type { VSBufferReadableStream } from "@codingame/monaco-vscode-api/vscode/vs/base/common/buffer";
import {
  HotExitBackupService,
  type StoredWorkingCopyBackup,
  type WorkingCopyBackupStore,
} from "./hotExitBackup";

const TYPE_ID = "workbench.editors.files.textFileEditorModel";

function memoryStore(): WorkingCopyBackupStore & { dump(): Map<string, StoredWorkingCopyBackup> } {
  const records = new Map<string, StoredWorkingCopyBackup>();
  return {
    get: async (key) => records.get(key),
    set: async (key, record) => {
      records.set(key, record);
    },
    delete: async (key) => {
      records.delete(key);
    },
    keys: async () => [...records.keys()],
    dump: () => records,
  };
}

function fakeCopy(content = "abc", overrides: Partial<IWorkingCopy> = {}): IWorkingCopy {
  return {
    typeId: TYPE_ID,
    resource: URI.file("/repo/a.ts"),
    name: "a.ts",
    capabilities: 0,
    onDidChangeDirty: () => ({ dispose() {} }),
    onDidChangeContent: () => ({ dispose() {} }),
    onDidSave: () => ({ dispose() {} }),
    isDirty: () => true,
    isModified: () => true,
    backupDelay: 0,
    backup: async () => ({
      meta: { mtime: 1, ctime: 1, size: content.length, etag: "etag-x" },
      content: bufferToReadable(VSBuffer.fromString(content)),
    }),
    save: async () => true,
    revert: async () => {},
    ...overrides,
  } as unknown as IWorkingCopy;
}

function fakeWorkingCopyService() {
  const handlers: Array<(copy: IWorkingCopy) => void> = [];
  const service = {
    onDidChangeDirty: (fn: (copy: IWorkingCopy) => void) => {
      handlers.push(fn);
      return { dispose() {} };
    },
    fire: (copy: IWorkingCopy) => handlers.forEach((fn) => fn(copy)),
  };
  return service as unknown as IWorkingCopyService & { fire: (copy: IWorkingCopy) => void };
}

const identifier = (resource = "/repo/a.ts"): IWorkingCopyIdentifier => ({
  typeId: TYPE_ID,
  resource: URI.file(resource),
});

async function streamText(stream: VSBufferReadableStream): Promise<string> {
  return (await streamToBuffer(stream)).toString();
}

describe("hot exit 备份服务", () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = memoryStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("脏副本经调度写入备份，resolve 还原内容与元数据", async () => {
    const service = new HotExitBackupService(store, "vscode-remote://env-a/repo");
    const copies = fakeWorkingCopyService();
    service.attach(copies);

    copies.fire(fakeCopy("hello backup"));
    await vi.advanceTimersByTimeAsync(5);

    expect(store.dump().size).toBe(1);
    const backup = await service.resolve(identifier());
    expect(backup).toBeDefined();
    expect(await streamText(backup!.value)).toBe("hello backup");
    expect(backup!.meta?.etag).toBe("etag-x");
  });

  it("副本转干净即清除备份", async () => {
    const service = new HotExitBackupService(store, "vscode-remote://env-a/repo");
    const copies = fakeWorkingCopyService();
    service.attach(copies);
    const copy = fakeCopy();

    copies.fire(copy);
    await vi.advanceTimersByTimeAsync(5);
    expect(service.hasBackupSync(identifier())).toBe(true);

    copy.isModified = () => false;
    copies.fire(copy);
    await vi.advanceTimersByTimeAsync(5);
    expect(store.dump().size).toBe(0);
    expect(service.hasBackupSync(identifier())).toBe(false);
  });

  it("转干净后才到期不写旧内容", async () => {
    const service = new HotExitBackupService(store, "vscode-remote://env-a/repo");
    const copies = fakeWorkingCopyService();
    service.attach(copies);
    const copy = fakeCopy();

    copies.fire(copy);
    copy.isModified = () => false;
    await vi.advanceTimersByTimeAsync(5);

    expect(store.dump().size).toBe(0);
  });

  it("工作区分键互不串扰", async () => {
    const a = new HotExitBackupService(store, "vscode-remote://env-a/repo");
    const b = new HotExitBackupService(store, "vscode-remote://env-b/repo");
    const copiesA = fakeWorkingCopyService();
    const copiesB = fakeWorkingCopyService();
    a.attach(copiesA);
    b.attach(copiesB);

    copiesA.fire(fakeCopy("from-a"));
    copiesB.fire(fakeCopy("from-b"));
    await vi.advanceTimersByTimeAsync(5);

    expect(store.dump().size).toBe(2);
    expect(await streamText((await a.resolve(identifier()))!.value)).toBe("from-a");
    expect(await streamText((await b.resolve(identifier()))!.value)).toBe("from-b");
    expect(await a.getBackups()).toHaveLength(1);
    expect(await b.getBackups()).toHaveLength(1);
  });

  it("discardBackups(except) 保留指定副本", async () => {
    const service = new HotExitBackupService(store, "vscode-remote://env-a/repo");
    const copies = fakeWorkingCopyService();
    service.attach(copies);

    copies.fire(fakeCopy("keep", { resource: URI.file("/repo/keep.ts") }));
    copies.fire(fakeCopy("drop", { resource: URI.file("/repo/drop.ts") }));
    await vi.advanceTimersByTimeAsync(5);
    expect(store.dump().size).toBe(2);

    await service.discardBackups({ except: [identifier("/repo/keep.ts")] });
    expect(store.dump().size).toBe(1);
    expect(await service.resolve(identifier("/repo/keep.ts"))).toBeDefined();
    expect(await service.resolve(identifier("/repo/drop.ts"))).toBeUndefined();
  });

  it("备份在途时的删除胜出，不留陈旧内容", async () => {
    const service = new HotExitBackupService(store, "vscode-remote://env-a/repo");
    const copies = fakeWorkingCopyService();
    service.attach(copies);

    let release: (() => void) | undefined;
    const copy = fakeCopy();
    copy.backup = (() =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            meta: { etag: "etag-x" },
            content: bufferToReadable(VSBuffer.fromString("stale?")),
          });
      })) as IWorkingCopy["backup"];

    copies.fire(copy);
    await vi.advanceTimersByTimeAsync(5); // 写备份开始，卡在 backup() 上
    expect(release).toBeDefined();

    const discard = service.discardBackup(copy);
    release!();
    await discard;
    await vi.advanceTimersByTimeAsync(5);

    expect(store.dump().size).toBe(0);
    expect(service.hasBackupSync(identifier())).toBe(false);
  });
});
