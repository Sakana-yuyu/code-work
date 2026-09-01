import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { CompositionRuntimeAdapterFailure } from "./CompositionRuntimeAdapter.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  type MulticaDaemonTaskExecutionBridge,
  type MulticaDaemonTaskExecutionContext,
} from "./MulticaDaemonRuntimeAdapter.ts";

export type MulticaTaskExecutionProcessBridgeOptions = {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly processRunner: Pick<ProcessRunner.ProcessRunner["Service"], "run">;
};

const nonEmpty = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} 不能为空。`);
  return normalized;
};

const normalizeTimeout = (value: number | undefined): number => {
  const timeoutMs = value ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs 必须是大于 0 的整数。");
  }
  return timeoutMs;
};

const extensionMessage = (context: MulticaDaemonTaskExecutionContext): string =>
  `${JSON.stringify({
    schemaVersion: 1,
    type: "multica.task.start",
    context,
  })}\n`;

const processFailureDetail = (error: ProcessRunner.ProcessRunError): string => {
  switch (error._tag) {
    case "ProcessSpawnError":
      return "extension_spawn_failed";
    case "ProcessStdinError":
      return "extension_stdin_failed";
    case "ProcessTimeoutError":
      return "extension_timeout";
    default:
      return "extension_process_failed";
  }
};

/**
 * 通过一次性本地子进程承载 Multica daemon extension。
 *
 * 子进程只接收 start 注入消息；Code Work 不读取或记录 stdout/stderr，扩展失败只暴露稳定错误码，
 * 避免把 task-local MCP credential 或 prompt 传播到普通日志。
 */
export const makeMulticaTaskExecutionProcessBridge = (
  options: MulticaTaskExecutionProcessBridgeOptions,
): MulticaDaemonTaskExecutionBridge => {
  const command = nonEmpty(options.command, "command");
  const args = [...(options.args ?? [])];
  const cwd = options.cwd;
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  const injectTaskStart: MulticaDaemonTaskExecutionBridge["injectTaskStart"] = (context) =>
    options.processRunner
      .run({
        command,
        args,
        ...(cwd === undefined ? {} : { cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        stdin: extensionMessage(context),
        timeout: Duration.millis(timeoutMs),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new CompositionRuntimeAdapterFailure({
              runtimeId: context.runtimeId,
              code: "task_execution_extension_failed",
              detail: processFailureDetail(error),
            }),
        ),
        Effect.flatMap((result) => {
          if (result.timedOut) {
            return Effect.fail(
              new CompositionRuntimeAdapterFailure({
                runtimeId: context.runtimeId,
                code: "task_execution_extension_failed",
                detail: "extension_timeout",
              }),
            );
          }
          if (result.code !== 0) {
            return Effect.fail(
              new CompositionRuntimeAdapterFailure({
                runtimeId: context.runtimeId,
                code: "task_execution_extension_failed",
                detail: `extension_exit_${result.code === null ? "unknown" : result.code}`,
              }),
            );
          }
          return Effect.void;
        }),
      );

  return { injectTaskStart };
};
