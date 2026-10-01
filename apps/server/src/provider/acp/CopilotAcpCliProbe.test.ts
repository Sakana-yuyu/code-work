/** 官方 CLI 探针：显式提供 CODEWORK_COPILOT_CLI_PATH 才运行，会调用已登录账号的模型。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { toAcpConfigOptions, type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { applyAcpConfigSelections } from "./AcpAdapterSupport.ts";

const cliPath = process.env.CODEWORK_COPILOT_CLI_PATH;
const agentMode = "https://agentclientprotocol.com/protocol/session-modes#agent";
const planMode = "https://agentclientprotocol.com/protocol/session-modes#plan";

describe.runIf(Boolean(cliPath))("Copilot 官方 ACP CLI", () => {
  it.effect(
    "隔离会话验证模式、真实工具、拒绝、取消与恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-copilot-live-" });
        const cwd = path.join(root, "workspace");
        const home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* fs.makeDirectory(path.join(home, "agents"));
        yield* fs.writeFileString(
          path.join(home, "agents", "codework-profile.agent.md"),
          "---\nname: codework-profile\ndescription: Code Work 协议验证使用的无工具角色\ntools: []\n---\n仅回复 CODEWORK_PROFILE_OK，不调用工具。\n",
        );
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "CODEWORK_SOURCE_73918");
        const runtimeOptions: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: cliPath!,
            args: [
              "--acp",
              "--no-auto-update",
              "--no-custom-instructions",
              "--disable-builtin-mcps",
              "--log-level",
              "error",
            ],
            cwd,
            env: { ...process.env, COPILOT_HOME: home },
          },
          cwd,
          authMethodId: "copilot-login",
          clientInfo: { name: "codework-copilot-probe", version: "0.0.0" },
        };
        const sessionId = yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          let approve = true;
          let cancelNext = false;
          const permissions: string[] = [];
          const cancelPermissionSeen = yield* Deferred.make<void>();
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              if (cancelNext) {
                permissions.push("cancel");
                yield* Deferred.succeed(cancelPermissionSeen, undefined).pipe(Effect.ignore);
                yield* runtime.cancel.pipe(Effect.orDie);
                return { outcome: { outcome: "cancelled" as const } };
              }
              const choice = request.options.find(
                (option) => option.kind === (approve ? "allow_once" : "reject_once"),
              );
              permissions.push(approve ? "allow" : "reject");
              return choice
                ? { outcome: { outcome: "selected" as const, optionId: choice.optionId } }
                : { outcome: { outcome: "cancelled" as const } };
            }),
          );
          const started = yield* runtime.start();
          expect(started.initializeResult.agentInfo?.name).toBe("Copilot");
          expect(started.initializeResult.agentInfo?.version).toBeTruthy();
          const options = yield* runtime.getConfigOptions;
          expect(options.find((option) => option.id === "allow_all")?.currentValue).toBe("off");
          expect(
            toAcpConfigOptions(options).find((option) => option.id === "acpConfig:agent")
              ?.currentValue,
          ).toBe("value:");
          expect(yield* runtime.getAvailableModels).toBeNull();
          for (const [agent, permission] of [
            ["codework-profile", "on"],
            ["", "off"],
          ]) {
            yield* applyAcpConfigSelections(runtime, [
              { id: "acpConfig:agent", value: `value:${agent}` },
              { id: "acpConfig:allow_all", value: `value:${permission}` },
            ]);
            const current = yield* runtime.getConfigOptions;
            expect(current.find((option) => option.id === "agent")?.currentValue).toBe(agent);
            expect(current.find((option) => option.id === "allow_all")?.currentValue).toBe(
              permission,
            );
            expect((yield* runtime.getModeState)?.currentModeId).toBe(agentMode);
            expect(yield* runtime.getAvailableModels).toBeNull();
          }
          expect(
            (yield* applyAcpConfigSelections(runtime, [
              { id: "acpConfig:agent", value: "value:missing" },
            ]).pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* runtime.setMode(planMode);
          expect((yield* runtime.getModeState)?.currentModeId).toBe(planMode);
          yield* runtime.setMode(agentMode);
          expect((yield* runtime.getModeState)?.currentModeId).toBe(agentMode);
          const chunks: string[] = [];
          const toolCalls = new Map<string, AcpToolCallState>();
          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                chunks.push(event.text);
              if (event._tag === "ToolCallUpdated")
                toolCalls.set(event.toolCall.toolCallId, event.toolCall);
              return Effect.void;
            }),
            Effect.forkChild,
          );
          const text = yield* runtime.prompt({
            prompt: [
              { type: "text", text: "Reply exactly CODEWORK_COPILOT_OK. Do not call tools." },
            ],
          });
          yield* runtime.drainEvents;
          expect(text.stopReason).toBe("end_turn");
          expect(chunks.join("")).toContain("CODEWORK_COPILOT_OK");
          expect(
            (yield* runtime.getAvailableCommands).some((command) => command.name === "usage"),
          ).toBe(true);
          chunks.length = 0;
          const tools = yield* runtime.prompt({
            prompt: [
              {
                type: "text",
                text: "Only work in this current workspace. Read source.txt and create approved.txt containing its exact contents. Use your file tools. Then reply with the contents you actually read. Do not inspect other paths or use the network.",
              },
            ],
          });
          yield* runtime.drainEvents;
          expect(tools.stopReason).toBe("end_turn");
          expect(chunks.join("")).toContain("CODEWORK_SOURCE_73918");
          expect((yield* fs.readFileString(path.join(cwd, "approved.txt"))).trim()).toBe(
            "CODEWORK_SOURCE_73918",
          );
          expect(permissions).toContain("allow");
          expect([...toolCalls.values()].some((tool) => tool.status === "completed")).toBe(true);
          chunks.length = 0;
          yield* runtime.prompt({
            prompt: [
              {
                type: "text",
                text: "Use your PowerShell terminal tool to execute exactly Write-Output 'CODEWORK_SHELL_51937' in the current workspace. Do not run any other commands. Reply with the actual output.",
              },
            ],
          });
          yield* runtime.drainEvents;
          expect(chunks.join("")).toContain("CODEWORK_SHELL_51937");
          expect(
            [...toolCalls.values()].some(
              (tool) => tool.kind === "execute" && tool.status === "completed",
            ),
          ).toBe(true);
          approve = false;
          yield* runtime.prompt({
            prompt: [
              {
                type: "text",
                text: "Create denied.txt containing DENIED in the current workspace using your create file tool. If permission is refused, stop; do not retry or use another tool.",
              },
            ],
          });
          yield* runtime.drainEvents;
          expect(permissions).toContain("reject");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          cancelNext = true;
          const cancelPrompt = yield* runtime
            .prompt({
              prompt: [
                {
                  type: "text",
                  text: "You must use your create file tool now. Create cancelled.txt containing CANCELLED in the current workspace. Do not reply with text first; call the create/write tool so the host receives a permission request.",
                },
              ],
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(cancelPermissionSeen).pipe(Effect.timeout("90 seconds"));
          const cancelled = yield* Fiber.join(cancelPrompt);
          yield* runtime.drainEvents;
          expect(permissions).toContain("cancel");
          expect(cancelled.stopReason).toBe("cancelled");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          yield* Fiber.interrupt(consumer);
          return started.sessionId;
        }).pipe(Effect.provide(AcpSessionRuntime.layer(runtimeOptions)), Effect.scoped);
        yield* Effect.gen(function* () {
          const resumed = yield* AcpSessionRuntime.AcpSessionRuntime;
          yield* resumed.handleRequestPermission(() =>
            Effect.succeed({ outcome: { outcome: "cancelled" } }),
          );
          expect((yield* resumed.start()).sessionId).toBe(sessionId);
          const chunks: string[] = [];
          const consumer = yield* resumed.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                chunks.push(event.text);
              return Effect.void;
            }),
            Effect.forkChild,
          );
          const result = yield* resumed.prompt({
            prompt: [
              {
                type: "text",
                text: "Without calling tools, repeat the exact contents of source.txt that you read earlier in this conversation.",
              },
            ],
          });
          yield* resumed.drainEvents;
          expect(result.stopReason).toBe("end_turn");
          expect(chunks.join("")).toContain("CODEWORK_SOURCE_73918");
          yield* Fiber.interrupt(consumer);
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({ ...runtimeOptions, resumeSessionId: sessionId }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 180000 },
  );
});
