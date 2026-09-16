// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off
/**
 * SshServerConnections - ssh2 客户端的薄封装。
 *
 * 这一层只做协议适配（回调 → Effect、通道生命周期、主机指纹校验），不含
 * 业务规则：服务器解析、路径守卫、限额都留在 SshServerService。测试通过
 * 提供假实现替换本服务（PtyAdapter 同款手法）。
 *
 * @module SshServerConnections
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Client as Ssh2Client, type SFTPWrapper } from "ssh2";

const CONNECT_READY_TIMEOUT_MS = 15_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const EXEC_OUTPUT_CAP_BYTES = 256 * 1024;

export class SshConnectFailure extends Schema.TaggedErrorClass<SshConnectFailure>()(
  "SshConnectFailure",
  {
    kind: Schema.Literals(["connect", "auth", "timeout", "host-key-mismatch"]),
    reason: Schema.String,
    expectedFingerprint: Schema.optional(Schema.String),
    actualFingerprint: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return `SSH connect failed (${this.kind}): ${this.reason}`;
  }
}

export class SshChannelFailure extends Schema.TaggedErrorClass<SshChannelFailure>()(
  "SshChannelFailure",
  {
    kind: Schema.Literals(["exec", "shell", "sftp", "timeout", "aborted", "closed"]),
    reason: Schema.String,
  },
) {
  override get message() {
    return `SSH channel failed (${this.kind}): ${this.reason}`;
  }
}

interface SshConnectOptions {
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** 已记录的主机指纹（sha256 base64）；不匹配则拒绝握手。缺省 = 首连记录。 */
  readonly expectedFingerprint?: string | undefined;
}

interface SshExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface SshShellChannel {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(callback: (data: string) => void): () => void;
  onClose(callback: () => void): () => void;
}

interface SshSftpEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number | null;
  readonly modifiedAt: number | null;
}

export interface SshReadFileOutcome {
  readonly content: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export interface SshSftpSession {
  list(path: string): Effect.Effect<ReadonlyArray<SshSftpEntry>, SshChannelFailure>;
  readFile(path: string, maxBytes: number): Effect.Effect<SshReadFileOutcome, SshChannelFailure>;
  writeFile(path: string, content: string): Effect.Effect<void, SshChannelFailure>;
  unlink(path: string): Effect.Effect<void, SshChannelFailure>;
  rmdir(path: string): Effect.Effect<void, SshChannelFailure>;
  mkdir(path: string): Effect.Effect<void, SshChannelFailure>;
  /** null = 路径不存在。 */
  stat(path: string): Effect.Effect<SshSftpEntry | null, SshChannelFailure>;
}

export interface SshConnection {
  /** 主机公钥指纹（sha256 base64）。首连后由上层写回配置完成 TOFU 记录。 */
  readonly fingerprint: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  exec(
    command: string,
    timeoutMs: number,
  ): Effect.Effect<SshExecResult, SshChannelFailure | SshConnectFailure>;
  openShell(input: {
    readonly cols: number;
    readonly rows: number;
  }): Effect.Effect<SshShellChannel, SshChannelFailure | SshConnectFailure>;
  sftp(): Effect.Effect<SshSftpSession, SshChannelFailure | SshConnectFailure>;
  close(): void;
  isClosed(): boolean;
  onClosed(callback: () => void): () => void;
}

export class SshServerConnections extends Context.Service<
  SshServerConnections,
  {
    readonly connect: (
      options: SshConnectOptions,
    ) => Effect.Effect<SshConnection, SshConnectFailure>;
  }
>()("codework/ssh/SshServerConnection/SshServerConnections") {}

const SFTP_DIRECTORY_MODE = 0o040000;
const SFTP_MODE_TYPE_MASK = 0o170000;

const mapSsh2ErrorKind = (message: string): "connect" | "auth" => {
  if (/authentication|auth methods/i.test(message)) return "auth";
  return "connect";
};

/** ssh2 回调风格的错误信息统一清洗：不带任何凭据。 */
const ssh2ErrorMessage = (error: unknown): string => {
  if (error === null || typeof error !== "object") return String(error ?? "unknown");
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : "unknown ssh2 error";
};

const shellChannel = (stream: {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  write(data: string): unknown;
  setWindow(rows: number, cols: number, height: number, width: number): unknown;
  close(): unknown;
}): SshShellChannel => ({
  write: (data) => stream.write(data),
  resize: (cols, rows) => stream.setWindow(rows, cols, 480, 640),
  close: () => stream.close(),
  onData: (callback) => {
    const data = (...args: unknown[]) => callback(String(args[0] ?? ""));
    stream.on("data", data as never);
    return () => stream.removeListener("data", data as never);
  },
  onClose: (callback) => {
    const close = () => callback();
    stream.on("close", close);
    return () => stream.removeListener("close", close);
  },
});

const sftpSession = (sftp: SFTPWrapper): SshSftpSession => {
  const failure = (operation: string) => (error: unknown) =>
    new SshChannelFailure({
      kind: "sftp",
      reason: `${operation}: ${ssh2ErrorMessage(error)}`,
    });

  const list = (path: string): Effect.Effect<ReadonlyArray<SshSftpEntry>, SshChannelFailure> =>
    Effect.callback((resume) => {
      sftp.readdir(path, (error, entries) => {
        if (error !== null && error !== undefined) {
          resume(Effect.fail(failure(`readdir ${path}`)(error)));
          return;
        }
        const mapped = (entries ?? [])
          .filter((entry) => entry.filename !== "." && entry.filename !== "..")
          .map((entry) => ({
            name: entry.filename,
            isDirectory: (entry.attrs.mode & SFTP_MODE_TYPE_MASK) === SFTP_DIRECTORY_MODE,
            sizeBytes: Number.isFinite(entry.attrs.size) ? entry.attrs.size : null,
            modifiedAt: Number.isFinite(entry.attrs.mtime) ? entry.attrs.mtime * 1000 : null,
          }));
        resume(Effect.succeed(mapped));
      });
      return Effect.sync(() => sftp.end());
    });

  const readFile = (
    path: string,
    maxBytes: number,
  ): Effect.Effect<SshReadFileOutcome, SshChannelFailure> =>
    Effect.callback((resume) => {
      sftp.stat(path, (statError, stats) => {
        if (statError !== null && statError !== undefined) {
          resume(Effect.fail(failure(`stat ${path}`)(statError)));
          return;
        }
        const sizeBytes = Number.isFinite(stats?.size) ? (stats?.size ?? 0) : 0;
        const read = sftp.createReadStream(path, { encoding: "utf8" });
        const chunks: string[] = [];
        let received = 0;
        let truncated = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(idleTimer);
          resume(
            Effect.succeed({
              content: chunks.join(""),
              sizeBytes,
              truncated: truncated || sizeBytes > maxBytes,
            }),
          );
        };
        const idleTimer = setTimeout(() => {
          read.destroy();
          finish();
        }, 30_000);
        read.on("data", (chunk: string) => {
          received += Buffer.byteLength(chunk, "utf8");
          if (received > maxBytes) {
            // 超限即停：按 cap 截断返回，由上层决定是否拒绝。
            truncated = true;
            read.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        read.on("error", (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(idleTimer);
          resume(Effect.fail(failure(`read ${path}`)(error)));
        });
        read.on("close", finish);
      });
      return Effect.sync(() => sftp.end());
    });

  const writeFile = (path: string, content: string): Effect.Effect<void, SshChannelFailure> =>
    Effect.callback((resume) => {
      const write = sftp.createWriteStream(path, { encoding: "utf8" });
      write.on("error", (error: unknown) => {
        resume(Effect.fail(failure(`write ${path}`)(error)));
      });
      write.on("close", () => {
        resume(Effect.void);
      });
      write.end(content);
      return Effect.sync(() => write.destroy());
    });

  const simple = <A>(
    operation: (callback: (error: unknown | null, result?: A) => void) => void,
    label: string,
  ): Effect.Effect<A, SshChannelFailure> =>
    Effect.callback((resume) => {
      operation((error, result) => {
        if (error !== null && error !== undefined) {
          resume(Effect.fail(failure(label)(error)));
          return;
        }
        resume(Effect.succeed(result as A));
      });
      return Effect.void;
    });

  return {
    list,
    readFile,
    writeFile,
    unlink: (path) =>
      simple((callback) => sftp.unlink(path, callback), `unlink ${path}`).pipe(Effect.asVoid),
    rmdir: (path) =>
      simple((callback) => sftp.rmdir(path, callback), `rmdir ${path}`).pipe(Effect.asVoid),
    mkdir: (path) =>
      simple((callback) => sftp.mkdir(path, callback), `mkdir ${path}`).pipe(Effect.asVoid),
    stat: (path) =>
      Effect.callback<SshSftpEntry | null, SshChannelFailure>((resume) => {
        sftp.stat(path, (error, stats) => {
          if (error !== null && error !== undefined) {
            // "No such file" 是查询语义的一部分，不是故障。
            if (/no such file/i.test(ssh2ErrorMessage(error))) {
              resume(Effect.succeed(null));
              return;
            }
            resume(Effect.fail(failure(`stat ${path}`)(error)));
            return;
          }
          resume(
            Effect.succeed({
              name: path.split("/").at(-1) ?? path,
              isDirectory: ((stats?.mode ?? 0) & SFTP_MODE_TYPE_MASK) === SFTP_DIRECTORY_MODE,
              sizeBytes: Number.isFinite(stats?.size) ? (stats?.size ?? 0) : null,
              modifiedAt: Number.isFinite(stats?.mtime) ? (stats?.mtime ?? 0) * 1000 : null,
            }),
          );
        });
        return Effect.void;
      }),
  };
};

const connection = (
  client: Ssh2Client,
  info: {
    readonly fingerprint: string;
    readonly hostname: string;
    readonly port: number;
    readonly username: string;
  },
): SshConnection => {
  const closedListeners = new Set<() => void>();
  let closed = false;
  client.on("close", () => {
    closed = true;
    for (const listener of closedListeners) listener();
  });

  const guard = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SshConnectFailure> =>
    Effect.suspend(
      (): Effect.Effect<A, E | SshConnectFailure> =>
        closed
          ? Effect.fail(
              new SshConnectFailure({
                kind: "connect",
                reason: "connection is closed",
              }),
            )
          : effect,
    );

  return {
    fingerprint: info.fingerprint,
    hostname: info.hostname,
    port: info.port,
    username: info.username,
    exec: (command, timeoutMs) =>
      guard(
        Effect.callback<SshExecResult, SshChannelFailure | SshConnectFailure>((resume) => {
          let settled = false;
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          client.exec(command, (error, stream) => {
            if (settled) return;
            if (error !== null && error !== undefined) {
              settled = true;
              clearTimeout(timer);
              resume(
                Effect.fail(
                  new SshChannelFailure({
                    kind: "exec",
                    reason: ssh2ErrorMessage(error),
                  }),
                ),
              );
              return;
            }
            if (stream === undefined) return;
            stream.on("data", (chunk: Buffer) => {
              if (Buffer.byteLength(stdout.join("")) < EXEC_OUTPUT_CAP_BYTES) stdout.push(chunk);
            });
            stream.stderr?.on("data", (chunk: Buffer) => {
              if (Buffer.byteLength(stderr.join("")) < EXEC_OUTPUT_CAP_BYTES) stderr.push(chunk);
            });
            stream.on("close", (code: number | null) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resume(
                Effect.succeed({
                  stdout: stdout.join("").slice(0, EXEC_OUTPUT_CAP_BYTES),
                  stderr: stderr.join("").slice(0, EXEC_OUTPUT_CAP_BYTES),
                  exitCode: typeof code === "number" ? code : null,
                }),
              );
            });
          });
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resume(
              Effect.fail(
                new SshChannelFailure({
                  kind: "timeout",
                  reason: `exec timed out after ${timeoutMs}ms`,
                }),
              ),
            );
          }, timeoutMs);
          return Effect.sync(() => {
            clearTimeout(timer);
          });
        }),
      ),
    openShell: (input) =>
      guard(
        Effect.callback<SshShellChannel, SshChannelFailure | SshConnectFailure>((resume) => {
          client.shell(
            { term: "xterm-256color", cols: input.cols, rows: input.rows },
            (error, stream) => {
              if (error !== null && error !== undefined) {
                resume(
                  Effect.fail(
                    new SshChannelFailure({
                      kind: "shell",
                      reason: ssh2ErrorMessage(error),
                    }),
                  ),
                );
                return;
              }
              if (stream === undefined) return;
              resume(Effect.succeed(shellChannel(stream)));
            },
          );
          return Effect.void;
        }),
      ),
    sftp: () =>
      guard(
        Effect.callback<SshSftpSession, SshChannelFailure | SshConnectFailure>((resume) => {
          client.sftp((error, sftp) => {
            if (error !== null && error !== undefined) {
              resume(
                Effect.fail(
                  new SshChannelFailure({
                    kind: "sftp",
                    reason: ssh2ErrorMessage(error),
                  }),
                ),
              );
              return;
            }
            if (sftp === undefined) return;
            resume(Effect.succeed(sftpSession(sftp)));
          });
          return Effect.void;
        }),
      ),
    close: () => {
      client.end();
    },
    isClosed: () => closed,
    onClosed: (callback) => {
      closedListeners.add(callback);
      return () => closedListeners.delete(callback);
    },
  };
};

export const SshServerConnectionsLayerLive = Layer.succeed(
  SshServerConnections,
  SshServerConnections.of({
    connect: (options) =>
      Effect.callback<SshConnection, SshConnectFailure>((resume) => {
        let fingerprint: string | null = null;
        let mismatch: { readonly expected: string; readonly actual: string } | null = null;
        const client = new Ssh2Client();
        client.on("ready", () => {
          if (fingerprint === null) {
            client.end();
            resume(
              Effect.fail(
                new SshConnectFailure({
                  kind: "connect",
                  reason: "host key was never presented",
                }),
              ),
            );
            return;
          }
          resume(
            Effect.succeed(
              connection(client, {
                fingerprint,
                hostname: options.hostname,
                port: options.port,
                username: options.username,
              }),
            ),
          );
        });
        client.on("error", (error: unknown) => {
          if (mismatch !== null) {
            resume(
              Effect.fail(
                new SshConnectFailure({
                  kind: "host-key-mismatch",
                  reason: "server host key fingerprint changed",
                  expectedFingerprint: mismatch.expected,
                  actualFingerprint: mismatch.actual,
                }),
              ),
            );
            return;
          }
          const message = ssh2ErrorMessage(error);
          resume(
            Effect.fail(
              new SshConnectFailure({
                kind: mapSsh2ErrorKind(message),
                reason: message,
              }),
            ),
          );
        });
        client.connect({
          host: options.hostname,
          port: options.port,
          username: options.username,
          password: options.password,
          readyTimeout: CONNECT_READY_TIMEOUT_MS,
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          hostHash: "sha256",
          hostVerifier: (hash: Buffer) => {
            // hostHash 已把主机公钥哈希成 sha256 摘要，这里只做编码。
            fingerprint = hash.toString("base64");
            if (options.expectedFingerprint === undefined) return true;
            if (options.expectedFingerprint === fingerprint) return true;
            mismatch = { expected: options.expectedFingerprint, actual: fingerprint };
            return false;
          },
        });
        return Effect.sync(() => client.end());
      }),
  }),
);
