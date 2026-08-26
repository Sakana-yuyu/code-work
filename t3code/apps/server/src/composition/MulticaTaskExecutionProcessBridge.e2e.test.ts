import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

import {
  makeMulticaTaskExecutionProcessBridge,
  type MulticaTaskExecutionProcessBridgeOptions,
} from "./MulticaTaskExecutionProcessBridge.ts";
import type { MulticaDaemonTaskExecutionContext } from "./MulticaDaemonRuntimeAdapter.ts";

const extensionPath = `${import.meta.dirname}/testFixtures/multicaTaskExecutionExtension.mjs`;

const TestLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

const context: MulticaDaemonTaskExecutionContext = {
  runtimeId: "multica:daemon-1:runtime-1",
  daemonId: "daemon-1",
  daemonRuntimeId: "runtime-1",
  runtimeTaskId: "remote-task-1",
  taskId: "t3-task-1",
  runId: "run-1",
  agentId: "agent-1",
  capabilityGrantIds: ["grant-1"],
  capabilityHandshakeId: "handshake-1",
  task: {
    id: "remote-task-1",
    agentId: "remote-agent-1",
    runtimeId: "runtime-1",
    status: "dispatched",
  },
  mcpConfig: {
    mcpServers: {
      "t3-composition-runtime": {
        type: "http",
        url: "http://127.0.0.1:4317/mcp/composition-runtime",
        headers: { Authorization: "Bearer fixture-credential" },
      },
    },
  },
};

describe("MulticaTaskExecutionProcessBridge", () => {
  it("启动真实本地子进程并注入 canonical task-local MCP overlay", async () => {
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const processRunner = yield* ProcessRunner.ProcessRunner;
          const bridgeOptions: MulticaTaskExecutionProcessBridgeOptions = {
            command: process.execPath,
            args: [extensionPath],
            timeoutMs: 5_000,
            processRunner,
          };
          const bridge = makeMulticaTaskExecutionProcessBridge(bridgeOptions);
          yield* bridge.injectTaskStart(context);
        }).pipe(Effect.provide(TestLayer)),
      ),
    ).resolves.toBeUndefined();
  });

  it("扩展进程非零退出时返回稳定错误，不泄露执行上下文", async () => {
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const processRunner = yield* ProcessRunner.ProcessRunner;
          const bridge = makeMulticaTaskExecutionProcessBridge({
            command: process.execPath,
            args: ["-e", "process.exit(7)"],
            timeoutMs: 5_000,
            processRunner,
          });
          yield* bridge.injectTaskStart(context);
        }).pipe(Effect.provide(TestLayer)),
      ),
    ).rejects.toMatchObject({
      code: "task_execution_extension_failed",
      detail: "extension_exit_7",
    });
  });
});
