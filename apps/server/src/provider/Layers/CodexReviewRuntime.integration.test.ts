// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert } from "vite-plus/test";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

it.effect("原生 review 使用 review/start 并保留同一对话的完成事件", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-review-"));
    const scriptPath = NodePath.join(directory, "script.json");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const path of [scriptPath, `${scriptPath}.requests`])
          NodeFS.rmSync(path, { force: true });
        NodeFS.rmdirSync(directory);
      }),
    );
    // 测试进程仅重放协议，不登录、不访问上游、不扫描用户项目。
    NodeFS.writeFileSync(
      scriptPath,
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({
        rootThreadId: wireFixture.rootThreadId,
        recordTurnRequests: true,
        notifications: [],
      }),
      "utf8",
    );
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("review-runtime"),
      binaryPath: NodePath.join(
        import.meta.dirname,
        `../testFixtures/codexCollabMockPeer.${platform === "win32" ? "cmd" : "sh"}`,
      ),
      cwd: directory,
      runtimeMode: "approval-required",
      environment: { ...process.env, CODEWORK_CODEX_COLLAB_SCRIPT: scriptPath },
    });
    yield* runtime.start();
    const completed = yield* runtime.events.pipe(
      Stream.filter((event) => event.method === "turn/completed"),
      Stream.runHead,
      Effect.forkScoped,
    );
    const result = yield* runtime.sendTurn({
      input: "/review",
      reviewTarget: { type: "uncommittedChanges" },
    });
    assert.equal(result.turnId, wireFixture.responses.turnStart.turn.id);
    assert.equal((yield* Fiber.join(completed))._tag, "Some");
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const request = JSON.parse(NodeFS.readFileSync(`${scriptPath}.requests`, "utf8"));
    assert.deepEqual(request, {
      method: "review/start",
      params: {
        threadId: wireFixture.rootThreadId,
        delivery: "inline",
        target: { type: "uncommittedChanges" },
      },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
