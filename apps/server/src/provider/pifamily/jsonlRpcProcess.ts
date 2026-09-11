// @effect-diagnostics preferSchemaOverJson:off - JSONL 帧序列化/响应透传，解析侧由 JsonlFrameDecoder 承担。
/**
 * JsonlRpcProcess — pi-family（Pi / OhMyPi）子进程的 JSONL RPC 传输层。
 *
 * wire 格式（两家用同一族协议）：客户端写出 `{...command, id}` 单行 JSON；
 * 子进程回 `{type:"response", id, success, data, error}`（按 id 关联），其余
 * JSON 帧全部是事件通知。进程退出、stdout 结束、坏帧都有明确处理：
 * 挂起请求统一 fail，事件流以合成的 `{type:"process_exit", error}` 帧收尾
 * ——上层适配器因此永远拿得到终态信号。
 *
 * @module provider/pifamily/jsonlRpcProcess
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessPlatform } from "@codework/shared/hostProcess";

import { JsonlFrameDecoder, type JsonlFrameProblem } from "./jsonlFrameDecoder.ts";

/** 控制面请求的默认超时；长阻塞 RPC（如 compact）显式传 null。 */
export const JSONL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
export const JSONL_RPC_NO_TIMEOUT: null = null;

const STDERR_RING_BYTES = 8192;

export class JsonlRpcProcessError extends Schema.TaggedErrorClass<JsonlRpcProcessError>()(
  "JsonlRpcProcessError",
  {
    diagnosticName: Schema.String,
    kind: Schema.Literals(["spawn", "write", "timeout", "request-failed", "exited"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.diagnosticName} JSONL RPC ${this.kind}: ${this.detail}`;
  }
}

export interface JsonlRpcProcessExit {
  readonly type: "process_exit";
  readonly error: string;
}

interface JsonlRpcResponseFrame {
  readonly type: "response";
  readonly id?: string;
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

function isResponseFrame(frame: unknown): frame is JsonlRpcResponseFrame {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as Record<string, unknown>).type === "response"
  );
}

export interface JsonlRpcProcess {
  /** 发送带 id 的请求并等待应答；timeoutMs 为 null 表示不限时。 */
  readonly request: (
    command: Record<string, unknown>,
    timeoutMs?: number | null,
  ) => Effect.Effect<unknown, JsonlRpcProcessError>;
  /** 发送无 id 的通知帧（steer / host_tool_result / extension_ui_response 等）。 */
  readonly send: (frame: Record<string, unknown>) => Effect.Effect<void, JsonlRpcProcessError>;
  /** 事件流（子进程通知 + 收尾的 process_exit 哨兵帧），随 close 结束。 */
  readonly streamEvents: Stream.Stream<unknown, never>;
  /** 进程是否已经退出（发出 process_exit 哨兵后为 true）。 */
  readonly hasExited: Effect.Effect<boolean>;
  /** 终止进程并结束事件流；幂等。 */
  readonly close: (reason: string) => Effect.Effect<void>;
  readonly pid: number | undefined;
}

export interface JsonlRpcProcessOptions {
  readonly diagnosticName: string;
  /** 在传入的 scope 内完成 spawn（进程生命周期归本传输层所有）。 */
  readonly spawn: (
    scope: Scope.Scope,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, Error>;
  readonly defaultRequestTimeoutMs?: number | null;
  readonly onProblem?: ((problem: JsonlFrameProblem) => void) | undefined;
  /** win32 默认树杀（cmd shim 会引入 shell 包装进程）；posix 只杀直接子进程。 */
  readonly killTree?: boolean;
}

export const makeJsonlRpcProcess = Effect.fn("pifamily.makeJsonlRpcProcess")(function* (
  options: JsonlRpcProcessOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const defaultTimeout = options.defaultRequestTimeoutMs ?? JSONL_RPC_DEFAULT_TIMEOUT_MS;
  const killTree = options.killTree ?? platform === "win32";

  // 子进程句柄绑定在私有 scope 上：close() 或外层 scope 释放时统一清理。
  const childScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const handle = yield* options.spawn(childScope).pipe(
    Effect.mapError(
      (cause) =>
        new JsonlRpcProcessError({
          diagnosticName: options.diagnosticName,
          kind: "spawn",
          detail: cause.message,
        }),
    ),
  );

  const events = yield* Queue.unbounded<unknown, Cause.Done<void>>();
  const outbox = yield* Queue.bounded<Record<string, unknown>, Cause.Done<void>>(256);

  const pending = new Map<string, Deferred.Deferred<unknown, JsonlRpcProcessError>>();
  let requestCounter = 0;
  let closed = false;
  let exitNotified = false;
  let stderrRing = "";

  const appendStderr = (text: string): void => {
    stderrRing = (stderrRing + text).slice(-STDERR_RING_BYTES);
  };

  const exitErrorText = (code: number | null): string =>
    `${options.diagnosticName} process exited with code ${code ?? "unknown"}${stderrRing.trim().length > 0 ? `\n${stderrRing.trim()}` : ""}`;

  const pendingEntries = (): ReadonlyArray<Deferred.Deferred<unknown, JsonlRpcProcessError>> => {
    const entries = [...pending.values()];
    pending.clear();
    return entries;
  };

  const failAllPending = (error: JsonlRpcProcessError): Effect.Effect<void> =>
    Effect.sync(pendingEntries).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, (deferred) => Deferred.fail(deferred, error), { discard: true }),
      ),
    );

  const notifyExit = (error: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (exitNotified) return;
      exitNotified = true;
      yield* failAllPending(
        new JsonlRpcProcessError({
          diagnosticName: options.diagnosticName,
          kind: "exited",
          detail: error,
        }),
      );
      yield* Queue.offer(events, { type: "process_exit", error } satisfies JsonlRpcProcessExit);
      yield* Queue.end(events);
      yield* Queue.end(outbox);
    });

  const handleResponse = (frame: JsonlRpcResponseFrame): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = typeof frame.id === "string" ? frame.id : null;
      if (id === null) return;
      const deferred = pending.get(id);
      if (deferred === undefined) return;
      pending.delete(id);
      if (frame.success === false) {
        yield* Deferred.fail(
          deferred,
          new JsonlRpcProcessError({
            diagnosticName: options.diagnosticName,
            kind: "request-failed",
            detail: frame.error ?? `${options.diagnosticName} request ${id} failed`,
          }),
        );
        return;
      }
      yield* Deferred.succeed(deferred, frame.data);
    });

  const decoder = new JsonlFrameDecoder({ onProblem: options.onProblem });

  const dispatchFrame = (frame: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (isResponseFrame(frame)) {
        yield* handleResponse(frame);
        return;
      }
      yield* Queue.offer(events, frame);
    });

  const dispatchFrames = (frames: ReadonlyArray<unknown>): Effect.Effect<void> =>
    Effect.forEach(frames, dispatchFrame, { discard: true });

  // stdout → 行解码 → 分发；解码失败只上报，不中断。
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => decoder.push(`${line}\n`)).pipe(Effect.flatMap(dispatchFrames)),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(Effect.sync(() => decoder.finish()).pipe(Effect.flatMap(dispatchFrames))),
    Effect.forkScoped,
  );

  // stderr 只进环形缓冲，用于退出诊断。
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((text) => Effect.sync(() => appendStderr(text))),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  // 进程退出 → fail 挂起请求 + process_exit 哨兵。
  yield* handle.exitCode.pipe(
    Effect.flatMap((code) => notifyExit(exitErrorText(code))),
    Effect.catchCause((cause) =>
      notifyExit(`${options.diagnosticName} process exit status unavailable: ${String(cause)}`),
    ),
    Effect.forkScoped,
  );

  // outbox → stdin。
  yield* Stream.fromQueue(outbox).pipe(
    Stream.map((frame) => `${JSON.stringify(frame)}\n`),
    Stream.encodeText,
    Stream.run(handle.stdin),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  // Windows 上 cmd shim 会引入 shell 包装进程，普通 kill 杀不干净子树。
  const killTreeWindows: Effect.Effect<void> = Effect.gen(function* () {
    if (handle.pid === undefined) return;
    yield* spawner
      .spawn(
        ChildProcess.make("taskkill.exe", ["/pid", String(handle.pid), "/t", "/f"], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.flatMap((killer) => killer.exitCode),
        Effect.catchCause(() => Effect.void),
        Effect.scoped,
      );
  });

  const closeInternal = (reason: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (closed) return;
      closed = true;
      yield* failAllPending(
        new JsonlRpcProcessError({
          diagnosticName: options.diagnosticName,
          kind: "exited",
          detail: reason,
        }),
      );
      const kill =
        killTree && platform === "win32"
          ? killTreeWindows
          : handle.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.catchCause(() => Effect.void));
      yield* kill;
      yield* Scope.close(childScope, Exit.void);
      yield* notifyExit(reason);
    });

  yield* Effect.addFinalizer(() =>
    closeInternal(`${options.diagnosticName} RPC session is closed`),
  );

  const send = (frame: Record<string, unknown>): Effect.Effect<void, JsonlRpcProcessError> =>
    Effect.gen(function* () {
      if (closed) {
        return yield* new JsonlRpcProcessError({
          diagnosticName: options.diagnosticName,
          kind: "write",
          detail: `${options.diagnosticName} RPC session already closed`,
        });
      }
      yield* Queue.offer(outbox, frame);
    });

  const request = (
    command: Record<string, unknown>,
    timeoutMs?: number | null,
  ): Effect.Effect<unknown, JsonlRpcProcessError> =>
    Effect.gen(function* () {
      if (closed) {
        return yield* new JsonlRpcProcessError({
          diagnosticName: options.diagnosticName,
          kind: "write",
          detail: `${options.diagnosticName} RPC session already closed`,
        });
      }
      requestCounter += 1;
      const id = `req_${requestCounter}`;
      const deferred = yield* Deferred.make<unknown, JsonlRpcProcessError>();
      yield* Effect.sync(() => {
        pending.set(id, deferred);
      });
      yield* send({ ...command, id });

      const timeout = timeoutMs === undefined ? defaultTimeout : timeoutMs;
      const wait = Deferred.await(deferred);
      const guarded =
        timeout === null
          ? wait
          : Effect.raceFirst(
              wait,
              Effect.sleep(timeout).pipe(
                Effect.andThen(
                  new JsonlRpcProcessError({
                    diagnosticName: options.diagnosticName,
                    kind: "timeout",
                    detail: `${options.diagnosticName} request ${String(command.type ?? id)} timed out after ${timeout}ms`,
                  }),
                ),
              ),
            );
      return yield* guarded.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });

  return {
    request,
    send,
    streamEvents: Stream.fromQueue(events),
    hasExited: Effect.sync(() => exitNotified),
    close: closeInternal,
    pid: handle.pid,
  };
});
