import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Net from "@codework/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import { FetchHttpClient } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

const TEST_PORT = 43_127;

const makeLayer = (listenerPid: () => number) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.sync(() => ({
              stdout: `p${listenerPid()}\ncnode\nn*:${TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            })),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, ((
              _input: Parameters<typeof globalThis.fetch>[0],
            ) =>
              Promise.resolve(
                new Response("app", { headers: { "content-type": "text/html" } }),
              )) as typeof globalThis.fetch),
          ),
        ),
      ),
    ),
  );

const makeIdentity = (
  registrationRevision: number,
  processGeneration: number,
  owner: PortScanner.TerminalProcessRegistrationIdentity["owner"] = null,
): PortScanner.TerminalProcessRegistrationIdentity => ({
  registrationRevision,
  processGeneration,
  owner,
});

const expectTerminalOwner = (
  terminal: { readonly threadId: string; readonly terminalId: string } | null | undefined,
) => {
  expect(terminal).toEqual({ threadId: "thread-registration", terminalId: "terminal-1" });
};

effectIt.effect("旧 revision 的迟到注册和注销不得覆盖新注册", () => {
  let listenerPid = 202;
  const currentIdentity = makeIdentity(2, 2);
  const staleIdentity = makeIdentity(1, 1);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: currentIdentity,
      processIds: [202],
    });
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: staleIdentity,
      processIds: [101],
    });

    expectTerminalOwner((yield* scanner.scan())[0]?.terminal);

    yield* scanner.unregisterTerminal({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: staleIdentity,
    });
    expectTerminalOwner((yield* scanner.scan())[0]?.terminal);

    listenerPid = 101;
    expect((yield* scanner.scan())[0]?.terminal).toBeNull();
  }).pipe(Effect.provide(makeLayer(() => listenerPid)));
});

effectIt.effect("相同 revision 但进程或 owner 身份不同时拒绝覆盖", () => {
  let listenerPid = 303;
  const currentIdentity = makeIdentity(3, 4, {
    workspaceScriptRunId: "run-current",
    generation: 7,
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: currentIdentity,
      processIds: [303],
    });
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: makeIdentity(3, 5, currentIdentity.owner),
      processIds: [404],
    });
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: makeIdentity(3, 4, {
        workspaceScriptRunId: "run-other",
        generation: 7,
      }),
      processIds: [505],
    });
    yield* scanner.unregisterTerminal({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: makeIdentity(3, 4, {
        workspaceScriptRunId: "run-other",
        generation: 7,
      }),
    });

    expectTerminalOwner((yield* scanner.scan())[0]?.terminal);
    listenerPid = 404;
    expect((yield* scanner.scan())[0]?.terminal).toBeNull();
    listenerPid = 505;
    expect((yield* scanner.scan())[0]?.terminal).toBeNull();
  }).pipe(Effect.provide(makeLayer(() => listenerPid)));
});

effectIt.effect("更高 revision 可用更小 generation 替换并抵御旧 exit", () => {
  const listenerPid = 606;
  const staleIdentity = makeIdentity(4, 9);
  const currentIdentity = makeIdentity(5, 1);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: staleIdentity,
      processIds: [listenerPid],
    });
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: currentIdentity,
      processIds: [listenerPid],
    });
    yield* scanner.unregisterTerminal({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity: staleIdentity,
    });

    expectTerminalOwner((yield* scanner.scan())[0]?.terminal);
  }).pipe(Effect.provide(makeLayer(() => listenerPid)));
});

effectIt.effect("相同注册身份可幂等更新 PID 且可精确注销", () => {
  let listenerPid = 707;
  const identity = makeIdentity(6, 3);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity,
      processIds: [707],
    });
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity,
      processIds: [808],
    });

    expect((yield* scanner.scan())[0]?.terminal).toBeNull();
    listenerPid = 808;
    expectTerminalOwner((yield* scanner.scan())[0]?.terminal);

    yield* scanner.unregisterTerminal({
      threadId: "thread-registration",
      terminalId: "terminal-1",
      identity,
    });
    expect((yield* scanner.scan())[0]?.terminal).toBeNull();
  }).pipe(Effect.provide(makeLayer(() => listenerPid)));
});
