// @effect-diagnostics nodeBuiltinImport:off - Windows 隔离探针需要设置临时目录的用户所有权与本机模型端点。
/** 官方 Gajae + 本机夹具：连续回合、工具副作用与审批中取消；不代表外部模型或设备验收。 */
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const cliPath = process.env.CODEWORK_GAJAE_CLI_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      stream: Schema.optional(Schema.Boolean),
      tools: Schema.optional(
        Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
      ),
      messages: Schema.Array(
        Schema.Struct({ role: Schema.String, content: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
);

describe.runIf(Boolean(cliPath))("Gajae 官方 CLI + 本地模型工具链路", () => {
  it.live(
    "连续回合、读取/命令、审批中取消补 failed 终态",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-gajae-tools-" });
        const cwd = path.join(root, "workspace");
        const home = path.join(root, "home");
        const agentDir = path.join(home, ".gjc", "agent");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(agentDir, { recursive: true });
        yield* Effect.addFinalizer(() =>
          fs
            .remove(root, { recursive: true })
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "Busy"
                  ? Effect.logWarning(
                      "Gajae 隔离测试目录仍被系统占用，未清除；工具断言与资源回收分别记录。",
                    )
                  : Effect.die(error),
              ),
            ),
        );
        if (platform === "win32") {
          yield* Effect.sync(() =>
            NodeChildProcess.execFileSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                [
                  "$ErrorActionPreference = 'Stop'",
                  "$acl = New-Object Security.AccessControl.DirectorySecurity",
                  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
                  "$acl.SetOwner($identity)",
                  "$acl.SetAccessRuleProtection($true,$false)",
                  "$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
                  "$acl.AddAccessRule($rule)",
                  "[IO.Directory]::SetAccessControl($env:CODEWORK_GAJAE_TEMP_AGENT_DIR, $acl)",
                ].join("; "),
              ],
              {
                env: { ...process.env, CODEWORK_GAJAE_TEMP_AGENT_DIR: agentDir },
                windowsHide: true,
                timeout: 10000,
                stdio: "pipe",
              },
            ),
          );
        }
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "GAJAE_SOURCE_72319");
        yield* fs.writeFileString(
          path.join(agentDir, "settings.json"),
          encodeJson({
            shellPath: process.env.CODEWORK_GAJAE_SHELL_PATH ?? "C:/Program Files/Git/bin/bash.exe",
          }),
        );
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let toolSequence = 0;
        let completionSequence = 0;
        let promptSequence = 0;
        let promptMarker = "";
        const toolResults: unknown[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              try {
                if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
                  response.writeHead(404);
                  response.end("{}");
                  return;
                }
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const body = decodeRequest(raw);
                const completionId = `gajae-probe-${++completionSequence}`;
                for (const message of body.messages)
                  if (message.role === "tool") toolResults.push(message.content);
                const tool =
                  nextTool &&
                  body.messages.at(-1)?.role === "user" &&
                  encodeJson(body.messages.at(-1)?.content).includes(promptMarker) &&
                  body.tools?.some((entry) => entry.function.name === nextTool!.name)
                    ? nextTool
                    : undefined;
                if (tool) nextTool = undefined;
                const message = tool
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          index: 0,
                          id: `gajae-tool-${++toolSequence}`,
                          type: "function",
                          function: {
                            name: tool.name,
                            arguments: encodeJson(tool.args),
                          },
                        },
                      ],
                    }
                  : { role: "assistant", content: "GAJAE_LOOPBACK_OK" };
                const finishReason = tool ? "tool_calls" : "stop";
                if (body.stream) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  for (const chunk of [
                    { choices: [{ index: 0, delta: message, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
                  ]) {
                    response.write(
                      `data: ${encodeJson({ ...chunk, id: completionId, object: "chat.completion.chunk" })}\n\n`,
                    );
                  }
                  response.end("data: [DONE]\n\n");
                  return;
                }
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                  encodeJson({
                    id: completionId,
                    object: "chat.completion",
                    choices: [{ index: 0, message, finish_reason: finishReason }],
                  }),
                );
              } catch (error) {
                response.writeHead(500);
                response.end(encodeJson({ error: String(error) }));
              }
            }),
          ),
          (httpServer) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  httpServer.closeAllConnections();
                  httpServer.close(() => resolve());
                }),
            ),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const listened = server.address();
        if (!listened || typeof listened === "string") throw new Error("模型端点未绑定端口");
        const address = { port: listened.port };
        yield* fs.writeFileString(
          path.join(agentDir, "models.yml"),
          [
            "providers:",
            "  fixture:",
            `    baseUrl: http://127.0.0.1:${address.port}/v1`,
            "    apiKey: fixture-key",
            "    api: openai-completions",
            "    models:",
            "      - id: fixture-model",
            "        name: Fixture Model",
            "        contextWindow: 32768",
            "        maxTokens: 4096",
            "profiles:",
            "  acp-fixture:",
            "    display_name: ACP Fixture",
            "    required_providers: [fixture]",
            "    model_mapping:",
            "      default: fixture/fixture-model",
            "",
          ].join("\n"),
        );
        const systemKeys = new Set([
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "SYSTEMDRIVE",
          "WINDIR",
          "COMSPEC",
          "TEMP",
          "TMP",
        ]);
        const env = Object.fromEntries(
          Object.entries(process.env).map(([key, value]) => [
            key,
            systemKeys.has(key.toUpperCase()) ? value : "",
          ]),
        );
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          let permission: "allow_once" | "reject_once" | "cancel" = "allow_once";
          const decisions: string[] = [];
          const text: string[] = [];
          const tools = new Map<string, AcpToolCallState>();
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              decisions.push(permission);
              if (permission === "cancel") {
                yield* runtime.cancel.pipe(Effect.orDie);
                return { outcome: { outcome: "cancelled" as const } };
              }
              const choice = request.options.find((option) => option.kind === permission);
              if (!choice) throw new Error(`缺少原生 ${permission} 选项`);
              return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
            }),
          );
          const started = yield* runtime.start();
          expect(started.initializeResult.agentInfo).toMatchObject({
            name: "gajae-code",
            version: "0.18.1",
          });
          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                text.push(event.text);
              if (event._tag === "ToolCallUpdated")
                tools.set(event.toolCall.toolCallId, event.toolCall);
              return Effect.void;
            }),
            Effect.forkChild,
          );
          const prompt = () => {
            promptMarker = `GAJAE_ACTION_${++promptSequence}`;
            return runtime.prompt({
              prompt: [{ type: "text", text: `${promptMarker} 执行隔离协议验收动作。` }],
            });
          };
          // 连续两回合：上一回合结束后再发，确认不再出现“仍在发布上一回合最终文本” conflict。
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("GAJAE_LOOPBACK_OK");
          text.length = 0;
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("GAJAE_LOOPBACK_OK");
          nextTool = { name: "read", args: { path: path.join(cwd, "source.txt") } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("GAJAE_SOURCE_72319");
          expect(
            [...tools.values()].some((tool) => tool.kind === "read" && tool.status === "completed"),
          ).toBe(true);
          nextTool = {
            name: "bash",
            args: { command: "echo GAJAE_SHELL_72319", timeout: 10 },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("allow_once");
          expect(
            [...tools.values()].some(
              (tool) => tool.kind === "execute" && tool.status === "completed",
            ),
          ).toBe(true);
          expect([...tools.values()].find((tool) => tool.kind === "execute")?.detail).toContain(
            "GAJAE_SHELL_72319",
          );
          permission = "cancel";
          const beforeCancel = new Set(tools.keys());
          nextTool = {
            name: "bash",
            args: { command: "echo CANCELLED > cancelled.txt", timeout: 10 },
          };
          const cancelled = yield* prompt();
          yield* runtime.drainEvents;
          expect(cancelled.stopReason).toBe("cancelled");
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          const cancelTools = [...tools.values()].filter(
            (tool) => !beforeCancel.has(tool.toolCallId),
          );
          expect(cancelTools.length).toBeGreaterThan(0);
          expect(cancelTools.every((tool) => tool.status === "failed")).toBe(true);
          yield* runtime.close;
          yield* Fiber.interrupt(consumer).pipe(Effect.ignore);
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: ["--mode", "acp", "--mpreset", "acp-fixture"],
                cwd,
                env: {
                  ...env,
                  HOME: home,
                  USERPROFILE: home,
                  APPDATA: home,
                  LOCALAPPDATA: home,
                  GJC_CODING_AGENT_DIR: agentDir,
                  GJC_DISABLE_TELEMETRY: "1",
                  GJC_NO_TITLE: "1",
                  GJC_NOTIFY: "off",
                  GJC_ACP_PERMISSION_MODE: "prompt",
                },
              },
              cwd,
              authMethodId: "agent",
              clientInfo: { name: "codework-gajae-tools", version: "0.0.0" },
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 180000 },
  );
});
