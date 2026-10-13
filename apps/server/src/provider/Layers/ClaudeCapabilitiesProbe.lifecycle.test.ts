import { ClaudeSettings } from "@codework/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@codework/shared/hostProcess";
import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";

const sdk = vi.hoisted(() => ({ query: vi.fn<typeof query>() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
beforeEach(() => {
  sdk.query.mockReset();
});

const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: "/fixture/claude" });
const initialization: SDKControlInitializeResponse = {
  commands: [{ name: "review", description: "检查代码", argumentHint: "[path]" }],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [],
  account: { email: "first@example.test", subscriptionType: "pro", tokenSource: "oauth" },
};
const probe = probeClaudeCapabilities(settings, {}, "/workspace").pipe(
  Effect.provide(Path.layer),
  Effect.provideService(HostProcessPlatform, "linux"),
);

it.effect("成功后先中止再关闭查询，重复执行使用不同信号且不产生用户消息", () =>
  Effect.gen(function* () {
    const signals: Array<AbortSignal> = [];
    const prompts: Array<AsyncIterable<unknown>> = [];
    let closed = 0;
    sdk.query.mockImplementation(({ options, prompt }) => {
      const signal = options!.abortController!.signal;
      expect(signal.aborted).toBe(false);
      expect(options!.persistSession).toBe(false);
      expect(typeof prompt).not.toBe("string");
      signals.push(signal);
      prompts.push(prompt as AsyncIterable<unknown>);
      return {
        initializationResult: () => Promise.resolve(initialization),
        close: () => {
          expect(signal.aborted).toBe(true);
          closed += 1;
        },
      } as Query;
    });
    expect((yield* probe)?.email).toBe("first@example.test");
    expect((yield* probe)?.email).toBe("first@example.test");
    expect(signals[0]).not.toBe(signals[1]);
    expect(closed).toBe(2);
    for (const prompt of prompts) {
      const result = yield* Effect.promise(() => prompt[Symbol.asyncIterator]().next());
      expect(result.done).toBe(true);
    }
  }),
);

it.effect("初始化拒绝仍关闭 SDK 查询，并返回未能验证状态", () =>
  Effect.gen(function* () {
    let closed = false;
    sdk.query.mockImplementation(
      ({ options }) =>
        ({
          initializationResult: () => Promise.reject(new Error("初始化失败")),
          close: () => {
            expect(options!.abortController!.signal.aborted).toBe(true);
            closed = true;
          },
        }) as Query,
    );
    expect(yield* probe).toBeUndefined();
    expect(closed).toBe(true);
  }),
);

it.effect("公开探针保留宿主环境并让实例变量覆盖同名值", () =>
  Effect.gen(function* () {
    sdk.query.mockImplementation(({ options }) => {
      expect(options?.env?.PATH).toBe("/host/bin");
      expect(options?.env?.SYSTEMROOT).toBe("host-system");
      expect(options?.env?.CLAUDE_INSTANCE_FLAG).toBe("instance");
      return {
        initializationResult: () => Promise.resolve(initialization),
        close: () => {},
      } as Query;
    });
    yield* probeClaudeCapabilities(
      settings,
      { CLAUDE_INSTANCE_FLAG: "instance" },
      "/workspace",
    ).pipe(
      Effect.provide(Path.layer),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "/host/bin",
        SYSTEMROOT: "host-system",
        CLAUDE_INSTANCE_FLAG: "host",
      }),
    );
    expect(sdk.query).toHaveBeenCalledTimes(1);
  }),
);

for (const exit of ["取消", "超时"] as const) {
  it.effect(`${exit}未完成的初始化也会关闭 SDK 查询`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      let options: Options | undefined;
      sdk.query.mockImplementation((input) => {
        options = input.options;
        return {
          initializationResult: () => {
            Deferred.doneUnsafe(started, Effect.void);
            return new Promise<SDKControlInitializeResponse>(() => {});
          },
          close: () => {
            closed = true;
          },
        } as Query;
      });
      const fiber = yield* probe.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      if (exit === "取消") yield* Fiber.interrupt(fiber);
      else {
        yield* TestClock.adjust("25 seconds");
        expect(yield* Fiber.join(fiber)).toBeUndefined();
      }
      expect(options?.abortController?.signal.aborted).toBe(true);
      expect(closed).toBe(true);
    }),
  );
}
