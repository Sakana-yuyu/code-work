// @effect-diagnostics globalDate:off globalDateInEffect:off
/**
 * SshServerService - 远程服务器管理的业务层。
 *
 * 连接池按 serverId 多路复用一条 SSH 连接（shell/exec/SFTP 都是它上面的通道），
 * 空闲 5 分钟回收；首连记录主机指纹（TOFU），指纹变更时拒绝连接。路径守卫、
 * 读取上限、递归删除限额都在这一层，协议细节全部留在 SshServerConnections。
 *
 * @module SshServerService
 */
import {
  SshFileError,
  SshHostFingerprint,
  SshHostKeyMismatchError,
  type SshServerConfig,
  type SshServerFileEntry,
  type SshServerId,
  SshServerNotFoundError,
  type SshServerStatus,
  SshConnectionError,
  type SshTestConnectionInput,
  type SshTestConnectionResult,
  type SshError,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ServerSettings from "../serverSettings.ts";
import {
  type SshChannelFailure,
  type SshConnection,
  type SshSftpSession,
  SshConnectFailure,
  SshServerConnections,
  SshServerConnectionsLayerLive,
} from "./SshServerConnection.ts";
import { SSH_STATUS_COMMAND, parseSshStatusOutput } from "./SshServerStatus.ts";

const CONNECTION_IDLE_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const READ_FILE_MAX_BYTES = 1024 * 1024;
const DELETE_ENTRY_LIMIT = 10_000;
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 15_000;
const BINARY_SNIFF_BYTES = 8_192;

export interface SshResolvedServer {
  readonly serverId: SshServerId;
  readonly config: SshServerConfig;
}

export class SshServerService extends Context.Service<
  SshServerService,
  {
    /** 按 id 或 label 解析服务器；失败时携带可用列表供调用方自纠错。 */
    readonly resolveServer: (query: string) => Effect.Effect<SshResolvedServer, SshError>;

    readonly listServers: Effect.Effect<ReadonlyArray<SshResolvedServer>, SshError>;

    /** 取（或建立）该服务器的复用连接；TOFU 指纹记录在建立路径上完成。 */
    readonly acquireConnection: (serverId: SshServerId) => Effect.Effect<SshConnection, SshError>;

    /**
     * 带引用计数的连接持有：活跃 SSH 终端会话 pin 住连接，空闲回收器
     * 会跳过 pin 数大于 0 的连接。release 幂等。
     */
    readonly pinConnection: (
      serverId: SshServerId,
    ) => Effect.Effect<
      { readonly connection: SshConnection; readonly release: () => void },
      SshError
    >;

    readonly exec: (
      serverId: SshServerId,
      command: string,
      timeoutMs?: number | undefined,
    ) => Effect.Effect<
      { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null },
      SshError
    >;

    readonly status: (serverId: SshServerId) => Effect.Effect<SshServerStatus, SshError>;

    readonly testConnection: (
      input: SshTestConnectionInput,
    ) => Effect.Effect<SshTestConnectionResult>;

    readonly listFiles: (
      serverId: SshServerId,
      path: string,
    ) => Effect.Effect<ReadonlyArray<SshServerFileEntry>, SshError>;

    readonly readFile: (
      serverId: SshServerId,
      path: string,
    ) => Effect.Effect<
      { readonly content: string; readonly sizeBytes: number; readonly truncated: boolean },
      SshError
    >;

    readonly writeFile: (
      serverId: SshServerId,
      path: string,
      content: string,
    ) => Effect.Effect<void, SshError>;

    readonly deleteFile: (
      serverId: SshServerId,
      path: string,
      recursive: boolean,
    ) => Effect.Effect<void, SshError>;
  }
>()("codework/ssh/SshServerService") {}

/** 规整远端绝对路径：折叠 `//`、`.`、`..`；非法输入返回 null。 */
export function normalizeRemotePath(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

const toSshError = (
  hostname: string,
  failure: SshConnectFailure,
  serverId?: SshServerId,
): SshError =>
  failure.kind === "host-key-mismatch"
    ? new SshHostKeyMismatchError({
        hostname,
        expectedFingerprint: failure.expectedFingerprint ?? "",
        actualFingerprint: failure.actualFingerprint ?? "",
      })
    : new SshConnectionError({
        ...(serverId === undefined ? {} : { serverId }),
        reason: failure.message,
      });

const isSshConnectFailure = (failure: unknown): failure is SshConnectFailure =>
  typeof failure === "object" &&
  failure !== null &&
  (failure as { readonly _tag?: unknown })._tag === "SshConnectFailure";

const isSshChannelFailure = (
  failure: unknown,
): failure is { readonly _tag: "SshChannelFailure"; readonly message: string } =>
  typeof failure === "object" &&
  failure !== null &&
  (failure as { readonly _tag?: unknown })._tag === "SshChannelFailure";

/**
 * 通道/连接失败统一映射。acquireConnection 已产出的契约错误原样透传，
 * 协议层失败（连接/通道）换算成契约错误。
 */
const mapOperationFailure = (
  path: string,
  failure: SshError | SshChannelFailure | SshConnectFailure,
): SshError => {
  if (isSshConnectFailure(failure)) return toSshError("", failure);
  if (isSshChannelFailure(failure)) {
    return new SshFileError({
      path,
      reason: "sftp-failed",
      ...(failure.message.length > 0 ? { detail: failure.message } : {}),
    });
  }
  return failure;
};

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const connections = yield* SshServerConnections;

  const pool = new Map<
    string,
    { readonly connection: SshConnection; lastUsedAt: number; pins: number }
  >();
  const connecting = new Map<string, Deferred.Deferred<SshConnection, SshError>>();

  const notFound = (
    current: { readonly sshServers: Record<string, SshServerConfig> },
    query: string,
  ) =>
    new SshServerNotFoundError({
      serverId: query as SshServerId,
      availableLabels: Object.values(current.sshServers).map((config) => config.label),
    });

  const readConfig = (serverId: SshServerId): Effect.Effect<SshServerConfig, SshError> =>
    settings.getSettings.pipe(
      Effect.flatMap((current) => {
        const config = current.sshServers[serverId];
        return config === undefined
          ? Effect.fail(notFound(current, serverId))
          : Effect.succeed(config);
      }),
      Effect.mapError(
        (error) =>
          new SshConnectionError({
            serverId,
            reason: error.message,
          }),
      ),
    );

  /** 首连指纹写回配置（TOFU）。基于磁盘态同条目补一个字段，密码保持脱敏语义。 */
  const recordFingerprint = (serverId: SshServerId, fingerprint: string) =>
    Effect.gen(function* () {
      if (fingerprint.length === 0 || fingerprint.length > 128) return;
      const value = fingerprint as SshHostFingerprint;
      yield* settings.updateSettings((current) => {
        const existing = current.sshServers[serverId];
        if (existing === undefined || existing.knownHostFingerprint !== undefined) return current;
        return {
          ...current,
          sshServers: Object.fromEntries(
            Object.entries(current.sshServers).map(([id, config]) =>
              id === serverId ? [id, { ...config, knownHostFingerprint: value }] : [id, config],
            ),
          ),
        };
      });
    }).pipe(
      Effect.ignore,
      Effect.catchCause(() => Effect.logWarning("ssh: failed to record host fingerprint")),
    );

  const connect = (serverId: SshServerId, config: SshServerConfig) =>
    connections
      .connect({
        hostname: config.hostname,
        port: config.port,
        username: config.username,
        password: config.password,
        ...(config.knownHostFingerprint === undefined
          ? {}
          : { expectedFingerprint: config.knownHostFingerprint }),
      })
      .pipe(
        Effect.mapError((failure) => toSshError(config.hostname, failure, serverId)),
        Effect.tap((connection) => {
          connection.onClosed(() => {
            pool.delete(serverId);
            connecting.delete(serverId);
          });
          return config.knownHostFingerprint === undefined
            ? recordFingerprint(serverId, connection.fingerprint)
            : Effect.void;
        }),
      );

  const acquireConnection = (serverId: SshServerId) =>
    Effect.suspend(() => {
      const key = serverId as string;
      const cached = pool.get(key);
      if (cached !== undefined && !cached.connection.isClosed()) {
        cached.lastUsedAt = Date.now();
        return Effect.succeed(cached.connection);
      }
      if (cached !== undefined) pool.delete(key);

      const inFlight = connecting.get(key);
      if (inFlight !== undefined) return Deferred.await(inFlight);

      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<SshConnection, SshError>();
        connecting.set(key, deferred);
        const config = yield* readConfig(serverId).pipe(
          Effect.tapError((error) => Deferred.fail(deferred, error)),
        );
        const connection = yield* connect(serverId, config).pipe(
          Effect.tapError((error) => Deferred.fail(deferred, error)),
        );
        pool.set(key, { connection, lastUsedAt: Date.now(), pins: 0 });
        yield* Deferred.succeed(deferred, connection);
        return connection;
      }).pipe(Effect.ensuring(Effect.sync(() => connecting.delete(key))));
    });

  const pinConnection = (serverId: SshServerId) =>
    Effect.gen(function* () {
      const connection = yield* acquireConnection(serverId);
      const key = serverId as string;
      const entry = pool.get(key);
      if (entry === undefined) {
        // acquireConnection 刚放入后不可能缺失；防御性兜底。
        return { connection, release: () => undefined };
      }
      entry.pins += 1;
      let released = false;
      return {
        connection,
        release: () => {
          if (released) return;
          released = true;
          entry.pins = Math.max(0, entry.pins - 1);
        },
      };
    });

  // 空闲回收：连接上可能还挂着 shell/exec/sftp 通道，长时间不用就该放掉；
  // 被 SSH 终端会话 pin 住的连接不回收。
  const sweepConnections = Effect.sync(() => {
    const now = Date.now();
    for (const [serverId, entry] of pool) {
      if (
        entry.connection.isClosed() ||
        (now - entry.lastUsedAt > CONNECTION_IDLE_MS && entry.pins === 0)
      ) {
        pool.delete(serverId);
        entry.connection.close();
      }
    }
  });
  yield* Effect.forkScoped(
    Effect.forever(Effect.sleep(SWEEP_INTERVAL_MS).pipe(Effect.andThen(sweepConnections))),
  );

  const withSftp = <A>(
    serverId: SshServerId,
    path: string,
    operation: (
      sftp: SshSftpSession,
    ) => Effect.Effect<A, SshError | SshChannelFailure | SshConnectFailure>,
  ): Effect.Effect<A, SshError> =>
    acquireConnection(serverId).pipe(
      Effect.flatMap((connection) => connection.sftp()),
      Effect.flatMap(operation),
      Effect.mapError((failure) => mapOperationFailure(path, failure)),
    );

  const assertResolvedPath = (path: string): Effect.Effect<string, SshFileError> =>
    Effect.suspend(() => {
      const normalized = normalizeRemotePath(path);
      if (normalized === null) {
        return Effect.fail(
          new SshFileError({ path, reason: "not-found", detail: "path must be absolute" }),
        );
      }
      return Effect.succeed(normalized);
    });

  const entryPath = (directory: string, name: string): string =>
    directory === "/" ? `/${name}` : `${directory}/${name}`;

  return SshServerService.of({
    resolveServer: (query: string) =>
      settings.getSettings.pipe(
        Effect.flatMap((current) => {
          const byId = current.sshServers[query as SshServerId];
          if (byId !== undefined) {
            return Effect.succeed({ serverId: query as SshServerId, config: byId });
          }
          const lowered = query.toLowerCase();
          const matches = Object.entries(current.sshServers).filter(
            ([, config]) =>
              config.label === query ||
              config.label.toLowerCase() === lowered ||
              config.hostname === query,
          );
          if (matches.length === 1) {
            const [serverId, config] = matches[0]!;
            return Effect.succeed({ serverId: serverId as SshServerId, config });
          }
          return Effect.fail(notFound(current, query));
        }),
        Effect.mapError((error) =>
          error._tag === "SshServerNotFoundError"
            ? error
            : new SshConnectionError({ reason: error.message }),
        ),
      ),
    listServers: settings.getSettings.pipe(
      Effect.map((current) =>
        Object.entries(current.sshServers).map(([serverId, config]) => ({
          serverId: serverId as SshServerId,
          config,
        })),
      ),
      Effect.mapError((error) => new SshConnectionError({ reason: error.message })),
    ),
    acquireConnection,
    pinConnection,
    exec: (serverId, command, timeoutMs) =>
      acquireConnection(serverId).pipe(
        Effect.flatMap((connection) =>
          connection.exec(
            command,
            Math.min(timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS),
          ),
        ),
        Effect.mapError((failure) => mapOperationFailure("", failure)),
      ),
    status: (serverId) =>
      Effect.gen(function* () {
        const outcome = yield* acquireConnection(serverId).pipe(
          Effect.flatMap((connection) => connection.exec(SSH_STATUS_COMMAND, STATUS_TIMEOUT_MS)),
          Effect.mapError((failure) => mapOperationFailure("", failure)),
          Effect.result,
        );
        if (Result.isFailure(outcome)) {
          return {
            serverId,
            online: false,
            error: outcome.failure.message,
          } satisfies SshServerStatus;
        }
        const sample = parseSshStatusOutput(outcome.success.stdout);
        return {
          serverId,
          online: true,
          ...(sample.os === undefined ? {} : { os: sample.os }),
          ...(sample.uptimeSeconds === undefined ? {} : { uptimeSeconds: sample.uptimeSeconds }),
          ...(sample.loadAvg === undefined ? {} : { loadAvg: [...sample.loadAvg] }),
          ...(sample.cpuPercent === undefined ? {} : { cpuPercent: sample.cpuPercent }),
          ...(sample.memoryUsedMb === undefined ? {} : { memoryUsedMb: sample.memoryUsedMb }),
          ...(sample.memoryTotalMb === undefined ? {} : { memoryTotalMb: sample.memoryTotalMb }),
          ...(sample.diskUsedGb === undefined ? {} : { diskUsedGb: sample.diskUsedGb }),
          ...(sample.diskTotalGb === undefined ? {} : { diskTotalGb: sample.diskTotalGb }),
        } satisfies SshServerStatus;
      }),
    testConnection: (input) =>
      connections
        .connect({
          hostname: input.hostname,
          port: input.port,
          username: input.username,
          password: input.password,
          ...(input.expectFingerprint === undefined
            ? {}
            : { expectedFingerprint: input.expectFingerprint }),
        })
        .pipe(
          Effect.flatMap((connection) =>
            connection.exec("uname -a", 10_000).pipe(
              Effect.map(
                (result): SshTestConnectionResult => ({
                  ok: true,
                  fingerprint: connection.fingerprint as SshHostFingerprint,
                  ...(result.stdout.trim().length > 0 ? { os: result.stdout.trim() } : {}),
                }),
              ),
              Effect.ensuring(Effect.sync(() => connection.close())),
            ),
          ),
          Effect.catch(
            (failure): Effect.Effect<SshTestConnectionResult> =>
              Effect.succeed({
                ok: false,
                fingerprint: "" as SshHostFingerprint,
                error: failure.message,
              }),
          ),
        ),
    listFiles: (serverId, path) =>
      Effect.gen(function* () {
        const normalized = yield* assertResolvedPath(path);
        return yield* withSftp(serverId, normalized, (sftp) =>
          Effect.map(sftp.list(normalized), (entries) =>
            entries.map(
              (entry): SshServerFileEntry => ({
                name: entry.name,
                path: entryPath(normalized, entry.name),
                isDirectory: entry.isDirectory,
                ...(entry.sizeBytes === null ? {} : { sizeBytes: entry.sizeBytes }),
                ...(entry.modifiedAt === null
                  ? {}
                  : { modifiedAt: new Date(entry.modifiedAt).toISOString() }),
              }),
            ),
          ),
        );
      }),
    readFile: (serverId, path) =>
      Effect.gen(function* () {
        const normalized = yield* assertResolvedPath(path);
        return yield* withSftp(serverId, normalized, (sftp) =>
          sftp.readFile(normalized, READ_FILE_MAX_BYTES).pipe(
            Effect.flatMap((outcome) => {
              if (outcome.content.slice(0, BINARY_SNIFF_BYTES).includes("\0")) {
                return Effect.fail(
                  new SshFileError({ path: normalized, reason: "binary-not-supported" }),
                );
              }
              return Effect.succeed(outcome);
            }),
          ),
        );
      }),
    writeFile: (serverId, path, content) =>
      Effect.gen(function* () {
        const normalized = yield* assertResolvedPath(path);
        return yield* withSftp(serverId, normalized, (sftp) =>
          Effect.gen(function* () {
            // 逐级补父目录：已存在且是目录则跳过，存在但是文件则报错。
            const segments = normalized
              .slice(1)
              .split("/")
              .filter((s) => s.length > 0);
            for (let depth = 1; depth < segments.length; depth += 1) {
              const prefix = `/${segments.slice(0, depth).join("/")}`;
              const existing = yield* sftp.stat(prefix);
              if (existing !== null) {
                if (!existing.isDirectory) {
                  return yield* new SshFileError({ path: prefix, reason: "not-a-directory" });
                }
                continue;
              }
              yield* sftp.mkdir(prefix);
            }
            yield* sftp.writeFile(normalized, content);
          }),
        );
      }),
    deleteFile: (serverId, path, recursive) =>
      Effect.gen(function* () {
        const normalized = yield* assertResolvedPath(path);
        if (normalized === "/") {
          return yield* new SshFileError({ path: normalized, reason: "refused-root" });
        }
        return yield* withSftp(serverId, normalized, (sftp) =>
          Effect.gen(function* () {
            const stat = yield* sftp.stat(normalized);
            if (stat === null) {
              return yield* new SshFileError({ path: normalized, reason: "not-found" });
            }
            if (!stat.isDirectory) {
              yield* sftp.unlink(normalized);
              return;
            }
            if (!recursive) {
              return yield* new SshFileError({ path: normalized, reason: "is-directory" });
            }
            // 先数后删：超限中止在动手之前，不留半删状态。
            type TreeError = SshError | SshChannelFailure | SshConnectFailure;
            const countTree = (directory: string): Effect.Effect<number, TreeError> =>
              Effect.flatMap(sftp.list(directory), (entries) =>
                Effect.forEach(entries, (entry) =>
                  entry.isDirectory
                    ? countTree(entryPath(directory, entry.name))
                    : Effect.succeed(1),
                ).pipe(Effect.map((counts) => counts.reduce((total, n) => total + n, 0) + 1)),
              );
            if ((yield* countTree(normalized)) > DELETE_ENTRY_LIMIT) {
              return yield* new SshFileError({ path: normalized, reason: "too-many-entries" });
            }
            const removeTree = (directory: string): Effect.Effect<void, TreeError> =>
              Effect.flatMap(sftp.list(directory), (entries) =>
                Effect.forEach(
                  entries,
                  (entry): Effect.Effect<void, TreeError> =>
                    entry.isDirectory
                      ? removeTree(entryPath(directory, entry.name))
                      : sftp.unlink(entryPath(directory, entry.name)),
                  { discard: true },
                ),
              ).pipe(Effect.andThen(sftp.rmdir(directory)));
            yield* removeTree(normalized);
          }),
        );
      }),
  });
});

export const SshServerServiceLayer = Layer.effect(SshServerService, make).pipe(
  Layer.provide(SshServerConnectionsLayerLive),
);
