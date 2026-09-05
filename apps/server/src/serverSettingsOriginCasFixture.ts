import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

import {
  commitServerSettingsOriginCas,
  readServerSettingsOriginSnapshot,
} from "./serverSettingsOriginCas.ts";
import { encodeServerSettingsOriginCasFixtureMessage } from "./serverSettingsOriginCasFixtureProtocol.ts";

const [settingsPath, candidate] = process.argv.slice(2);
if (settingsPath === undefined || candidate === undefined) {
  throw new Error("缺少 settingsPath 或 candidate 参数。");
}

const awaitCommitSignal = Effect.promise(
  () =>
    new Promise<void>((resolve, reject) => {
      process.stdin.once("data", () => resolve());
      process.stdin.once("error", reject);
      process.stdin.once("end", () => reject(new Error("父进程未发送提交信号。")));
    }),
);

const program = Effect.gen(function* () {
  const initial = yield* readServerSettingsOriginSnapshot(settingsPath);
  process.stdout.write(
    `${encodeServerSettingsOriginCasFixtureMessage({ type: "ready", token: initial.token })}\n`,
  );
  yield* awaitCommitSignal;
  const result = yield* commitServerSettingsOriginCas({
    settingsPath,
    expectedToken: initial.token,
    prepare: Effect.succeed({
      contents: candidate,
      value: candidate,
      compensate: Effect.void,
    }),
  });
  process.stdout.write(
    `${encodeServerSettingsOriginCasFixtureMessage({
      type: "result",
      tag: result._tag,
      ...(result._tag === "Committed" ? { value: result.value } : {}),
    })}\n`,
  );
}).pipe(Effect.provide(NodeServices.layer));

// stdout 专用于协议，诊断信息写入 stderr，保留真正的锁错误供父进程报告。
NodeRuntime.runMain(
  program.pipe(
    Effect.onError((cause) => Effect.sync(() => process.stderr.write(`${Cause.pretty(cause)}\n`))),
    Effect.provideService(Logger.LogToStderr, true),
  ),
  { disableErrorReporting: true },
);
