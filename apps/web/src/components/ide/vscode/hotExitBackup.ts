// 上游 hot exit 依赖的两个部件在嵌入形态里都缺失：
// 1. `IWorkingCopyBackupService` 被 monaco-vscode-api 的 missing-services 注册成
//    no-op（`backup` 直接返回），而恢复链路是活的——textFileEditorModel 首次
//    resolve 会先问这里，有备份就带着脏状态加载。
// 2. 周期备份调度（上游 WorkingCopyBackupTracker）没有装配。
// 这里用 IndexedDB 补齐两者：脏内容约 1s 后写入备份，保存/还原/丢弃即清除；
// 标签恢复时模型从备份加载并保持脏状态，未保存内容跨页重载与环境切换存活。
// 备份按工作区身份分键，多个环境各自恢复各自的缓冲。

import { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import {
  VSBuffer,
  bufferToStream,
  readableToBuffer,
  streamToBuffer,
  type VSBufferReadable,
  type VSBufferReadableStream,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/buffer";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { IWorkingCopyBackupService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyBackup.service";
import type { IResolvedWorkingCopyBackup } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyBackup";
import type {
  IWorkingCopy,
  IWorkingCopyBackupMeta,
  IWorkingCopyIdentifier,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopy";
import type { IWorkingCopyService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyService.service";

const BACKUP_DB = "codework:ide-hotexit";
const BACKUP_STORE = "backups";
const DEFAULT_BACKUP_DELAY_MS = 1000;
const KEY_SEP = "|";

export interface StoredWorkingCopyBackup {
  typeId: string;
  resource: string;
  content: Uint8Array;
  meta?: IWorkingCopyBackupMeta;
}

export interface WorkingCopyBackupStore {
  get(key: string): Promise<StoredWorkingCopyBackup | undefined>;
  set(key: string, record: StoredWorkingCopyBackup): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function createIndexedDbBackupStore(dbName = BACKUP_DB): WorkingCopyBackupStore {
  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(BACKUP_STORE)) {
          request.result.createObjectStore(BACKUP_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  };
  const transact = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      void open().then((db) => {
        const tx = db.transaction(BACKUP_STORE, mode);
        const request = run(tx.objectStore(BACKUP_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }, reject);
    });
  return {
    get: (key) =>
      transact(
        "readonly",
        (store) => store.get(key) as IDBRequest<StoredWorkingCopyBackup | undefined>,
      ),
    set: (key, record) =>
      transact("readwrite", (store) => store.put(record, key)).then(() => undefined),
    delete: (key) => transact("readwrite", (store) => store.delete(key)).then(() => undefined),
    keys: () =>
      transact("readonly", (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>).then(
        (keys) => keys.map(String),
      ),
  };
}

export class HotExitBackupService implements IWorkingCopyBackupService {
  declare readonly _serviceBrand: undefined;

  private readonly known = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queue = new Map<string, Promise<void>>();
  private readonly prefix: string;
  private copies: IWorkingCopyService | undefined;

  constructor(
    private readonly store: WorkingCopyBackupStore,
    workspaceKey: string,
  ) {
    this.prefix = workspaceKey + KEY_SEP;
    void this.preload();
  }

  private async preload(): Promise<void> {
    try {
      for (const key of await this.store.keys()) {
        if (key.startsWith(this.prefix)) this.known.add(key);
      }
    } catch {
      // 备份库打不开只降级为无备份，不阻塞工作台启动。
    }
  }

  /** initialize() 之后调用：订阅工作副本服务，脏内容进调度、转干净即清除。 */
  attach(workingCopies: IWorkingCopyService): void {
    this.copies = workingCopies;
    workingCopies.onDidChangeDirty((copy) => {
      if (copy.isModified()) {
        this.scheduleBackup(copy);
      } else {
        void this.discardBackup(copy);
      }
    });
  }

  /** 页面卸载前尽力补写：跳过防抖直接写所有未保存副本。 */
  async flushDirty(): Promise<void> {
    const modified = this.copies?.modifiedWorkingCopies ?? [];
    await Promise.all(modified.map((copy) => this.writeBackup(copy).catch(() => {})));
  }

  private scheduleBackup(copy: IWorkingCopy): void {
    const key = this.keyOf(copy);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.writeBackup(copy).catch(() => {});
    }, copy.backupDelay ?? DEFAULT_BACKUP_DELAY_MS);
    this.timers.set(key, timer);
  }

  private writeBackup(copy: IWorkingCopy): Promise<void> {
    const key = this.keyOf(copy);
    // 整个「查脏→收集→落盘」作为一个队列操作，之后排队的删除才能把它清掉；
    // 反之若先收集后入队，保存触发的删除会先执行，陈旧备份随即复活。
    return this.enqueue(key, async () => {
      // 排队期间可能已保存/还原：此刻不再脏就别写旧内容。
      if (!copy.isModified()) return;
      const backup = await copy.backup(CancellationToken.None);
      const content = backup.content
        ? readableToBuffer(backup.content as VSBufferReadable)
        : VSBuffer.alloc(0);
      const record: StoredWorkingCopyBackup = {
        typeId: copy.typeId,
        resource: copy.resource.toString(),
        content: content.buffer,
        ...(backup.meta === undefined ? {} : { meta: backup.meta }),
      };
      await this.store.set(key, record);
      this.known.add(key);
    });
  }

  hasBackupSync(identifier: IWorkingCopyIdentifier): boolean {
    return this.known.has(this.keyOf(identifier));
  }

  /** 接口规定的直接写入入口（上游 tracker 的调用形态）；调度走 writeBackup。 */
  async backup(
    identifier: IWorkingCopyIdentifier,
    content?: VSBufferReadable | VSBufferReadableStream,
    _versionId?: number,
    meta?: IWorkingCopyBackupMeta,
    token?: CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested) return;
    const buffer = content
      ? "read" in content
        ? readableToBuffer(content)
        : await streamToBuffer(content)
      : VSBuffer.alloc(0);
    const key = this.keyOf(identifier);
    const record: StoredWorkingCopyBackup = {
      typeId: identifier.typeId,
      resource: identifier.resource.toString(),
      content: buffer.buffer,
      ...(meta === undefined ? {} : { meta }),
    };
    await this.enqueue(key, async () => {
      await this.store.set(key, record);
      this.known.add(key);
    });
  }

  async getBackups(): Promise<readonly IWorkingCopyIdentifier[]> {
    const out: IWorkingCopyIdentifier[] = [];
    for (const key of this.known) {
      if (!key.startsWith(this.prefix)) continue;
      const identifier = this.identifierFromKey(key);
      if (identifier) out.push(identifier);
    }
    return out;
  }

  async resolve<T extends IWorkingCopyBackupMeta>(
    identifier: IWorkingCopyIdentifier,
  ): Promise<IResolvedWorkingCopyBackup<T> | undefined> {
    const record = await this.store.get(this.keyOf(identifier));
    if (!record) return undefined;
    return {
      value: bufferToStream(VSBuffer.wrap(record.content)),
      ...(record.meta === undefined ? {} : { meta: record.meta as T }),
    };
  }

  async discardBackup(identifier: IWorkingCopyIdentifier): Promise<void> {
    const key = this.keyOf(identifier);
    this.cancelScheduled(key);
    await this.enqueue(key, async () => {
      try {
        await this.store.delete(key);
      } finally {
        this.known.delete(key);
      }
    });
  }

  async discardBackups(filter?: { except: IWorkingCopyIdentifier[] }): Promise<void> {
    const except = new Set((filter?.except ?? []).map((identifier) => this.keyOf(identifier)));
    await Promise.all(
      [...this.known]
        .filter((key) => key.startsWith(this.prefix) && !except.has(key))
        .map((key) => {
          const identifier = this.identifierFromKey(key);
          return identifier ? this.discardBackup(identifier) : Promise.resolve();
        }),
    );
  }

  private cancelScheduled(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  // 同一键上的写/删串行，避免「保存触发的删除」和「在途备份写」竞态后留下陈旧备份。
  private enqueue(key: string, op: () => Promise<void>): Promise<void> {
    const prev = this.queue.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.queue.set(key, tail);
    void tail.finally(() => {
      if (this.queue.get(key) === tail) this.queue.delete(key);
    });
    return next;
  }

  private keyOf(identifier: IWorkingCopyIdentifier): string {
    // URI.toString 会转义 "|"，typeId 又是上游点分标识符，三段拼键不歧义。
    return this.prefix + identifier.typeId + KEY_SEP + identifier.resource.toString();
  }

  private identifierFromKey(key: string): IWorkingCopyIdentifier | undefined {
    const rest = key.slice(this.prefix.length);
    const sep = rest.indexOf(KEY_SEP);
    if (sep < 0) return undefined;
    return { typeId: rest.slice(0, sep), resource: URI.parse(rest.slice(sep + 1)) };
  }
}
