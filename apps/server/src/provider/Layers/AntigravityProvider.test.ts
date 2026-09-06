import { describe, expect, it } from "@effect/vitest";
import { AntigravitySettings } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkAntigravityProviderStatus } from "./AntigravityProvider.ts";

// Pin a non-win32 platform so resolveSpawnCommand passes the command through
// without PATH resolution — the stub spawner answers for it deterministically.
const NonWindowsPlatform = Layer.succeed(HostProcessPlatform, "linux");

const makeStubSpawner = (result: { readonly code: number; readonly stdout: string }) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(result.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const check = (input: {
  readonly enabled: boolean;
  readonly spawner: ReturnType<typeof makeStubSpawner>;
}) =>
  Effect.map(
    checkAntigravityProviderStatus(
      Schema.decodeSync(AntigravitySettings)({ enabled: input.enabled }),
      {},
    ),
    (draft) => draft,
  ).pipe(
    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.spawner)),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

describe("checkAntigravityProviderStatus", () => {
  it.effect("禁用实例也如实探测安装状态：CLI 存在时不再显示未安装", () =>
    Effect.gen(function* () {
      const draft = yield* check({
        enabled: false,
        spawner: makeStubSpawner({ code: 0, stdout: "agy 1.1.27" }),
      });
      expect(draft.installed).toBe(true);
      expect(draft.enabled).toBe(false);
      expect(draft.status).toBe("disabled");
      expect(draft.message).toContain("禁用");
    }),
  );

  it.effect("禁用且 CLI 缺失时保持未安装", () =>
    Effect.gen(function* () {
      const draft = yield* check({
        enabled: false,
        spawner: makeStubSpawner({ code: 9009, stdout: "" }),
      });
      expect(draft.installed).toBe(false);
      expect(draft.status).toBe("disabled");
    }),
  );
});
