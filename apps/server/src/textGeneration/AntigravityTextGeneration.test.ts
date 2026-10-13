import { AntigravitySettings, ProviderInstanceId } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { makeAntigravityTextGeneration } from "./AntigravityTextGeneration.ts";

const decodeSettings = Schema.decodeUnknownEffect(AntigravitySettings);

const input = {
  cwd: "/tmp/antigravity-argv-generation",
  message: "生成短标题",
  modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "agy-fast" },
};

describe("Antigravity生成路径的argv守卫", () => {
  it.effect("短正文保留实际生成与解码入口", () =>
    Effect.gen(function* () {
      const spawn = vi.fn(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make('{"title":"短标题"}')),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: "agy.exe",
        customModels: ["agy-fast"],
      });
      const generate = yield* makeAntigravityTextGeneration(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(spawn),
        ),
      );
      expect(yield* generate.generateThreadTitle(input)).toEqual({ title: "短标题" });
      expect(spawn).toHaveBeenCalledTimes(1);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, (command) => command),
    ),
  );

  it.effect("超限不调用生成进程，TextGenerationError保留统一码与建议", () =>
    Effect.gen(function* () {
      const spawn = vi.fn(() => Effect.die("生成守卫前调用了spawner"));
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: "agy.exe",
      });
      const generate = yield* makeAntigravityTextGeneration(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(spawn),
        ),
      );
      const result = yield* Effect.result(
        generate.generateCommitMessage({
          cwd: input.cwd,
          branch: "main",
          stagedSummary: "受控大补丁",
          stagedPatch: '"'.repeat(20_000),
          modelSelection: input.modelSelection,
        }),
      );
      if (Result.isSuccess(result)) throw Error("生成prompt应该超限");
      expect(result.failure._tag).toBe("TextGenerationError");
      expect(result.failure.detail).toContain("AGENT_PROMPT_TOO_LARGE");
      expect(result.failure.detail).toContain("请缩短输入");
      expect(spawn).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, (command) => command),
    ),
  );

  it.effect("生成的多行正文不能交给cmd时保留直接exe的操作建议", () =>
    Effect.gen(function* () {
      const spawn = vi.fn(() => Effect.die("不支持的cmd不应启动"));
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: "agy.cmd",
      });
      const generate = yield* makeAntigravityTextGeneration(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(spawn),
        ),
      );
      const result = yield* Effect.result(generate.generateThreadTitle(input));
      if (Result.isSuccess(result)) throw Error("cmd不能传多行生成正文");
      expect(result.failure.detail).toContain("AGENT_PROMPT_UNSUPPORTED");
      expect(result.failure.detail).toContain("请改用 .exe 或内置运行时");
      expect(spawn).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, (command) => command),
    ),
  );
});
