// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";

const HostLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcessPlatform, process.platform),
  Layer.succeed(HostProcessArchitecture, process.arch),
);

const TestLayer = Layer.mergeAll(HostLayer, ProcessRunner.layer.pipe(Layer.provide(HostLayer)));

it.effect("真实 PTY 命令进程保留输出和退出码直到显式 release", () =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-terminal-command-e2e-")),
    );
    const scriptPath = NodePath.join(baseDir, "command.cjs");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        scriptPath,
        'process.stdout.write("real-terminal-output\\n"); process.exitCode = 7;\n',
        "utf8",
      ),
    );
    const ptyAdapter = yield* NodePtyAdapter.make();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: NodePath.join(baseDir, "logs"),
      ptyAdapter,
      subprocessInspector: () =>
        Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
      processKillGraceMs: 50,
    });
    const exited = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      event.type === "exited" && event.terminalId === "real-command"
        ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    yield* manager
      .runCommand({
        threadId: "real-run",
        terminalId: "real-command",
        cwd: baseDir,
        command: process.execPath,
        args: [scriptPath],
      })
      .pipe(Effect.timeout("5 seconds"));
    yield* Deferred.await(exited).pipe(Effect.timeout("10 seconds"));

    let snapshot: import("@codework/contracts").TerminalSessionSnapshot | undefined;
    const detach = yield* manager
      .attachStream({ threadId: "real-run", terminalId: "real-command" }, (event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") snapshot = event.snapshot;
        }),
      )
      .pipe(Effect.timeout("5 seconds"));
    detach();
    assert.include(snapshot?.history ?? "", "real-terminal-output");
    assert.equal(snapshot?.status, "exited");
    assert.equal(snapshot?.exitCode, 7);

    yield* manager
      .close({ threadId: "real-run", terminalId: "real-command" })
      .pipe(Effect.timeout("5 seconds"));
    const released = yield* manager
      .write({ threadId: "real-run", terminalId: "real-command", data: "ignored" })
      .pipe(Effect.flip);
    assert.equal(released._tag, "TerminalSessionLookupError");
  }).pipe(Effect.provide(TestLayer)),
);
