// @effect-diagnostics nodeBuiltinImport:off - Windows 隔离探针需要设置临时目录的用户所有权。
/** 显式提供固定官方 CLI；隔离凭据并关闭隐式本地发现，检查未配置模型的失败合同。 */
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
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

import { isProbeExecutableAvailable } from "./acpCliProbeGate.ts";

const cliPath = process.env.CODEWORK_GAJAE_CLI_PATH;

describe.runIf(isProbeExecutableAvailable(cliPath))("Gajae 官方 ACP 认证与会话生命周期", () => {
  for (const scenario of ["login", "agent", "session"]) {
    const authMethodId = scenario === "login" ? "login" : "agent";
    it.live(
      scenario === "session"
        ? "模式拒绝和缺模型失败后仍能明确关闭会话"
        : authMethodId === "login"
          ? "拒绝未广告的 login"
          : "接受广告的 agent，但不证明模型可用",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const platform = yield* HostProcessPlatform;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-gajae-probe-" });
          const cwd = path.join(root, "workspace");
          const home = path.join(root, "home");
          const agentDir = path.join(home, ".gjc", "agent");
          yield* fs.makeDirectory(cwd);
          yield* fs.makeDirectory(agentDir, { recursive: true });
          if (platform === "win32") {
            // 提升权限的 Windows 进程可能默认由管理员组拥有目录；上游要求当前用户所有。
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
          const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
          yield* Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
            if (scenario === "session") {
              expect(yield* fs.readDirectory(agentDir)).toEqual([]);
              // 空目录仍会发现本机 Ollama 等服务；使用上游设置关闭发现，不触碰宿主服务。
              yield* fs.writeFileString(
                path.join(agentDir, "settings.json"),
                '{"disabledProviders":["ollama","llama.cpp","lm-studio","omlx","vllm","sglang"]}',
              );
              const output: string[] = [];
              const consumer = yield* runtime.getEvents().pipe(
                Stream.runForEach((event) => {
                  if (event._tag === "EventStreamBarrier")
                    return Deferred.succeed(event.acknowledge, undefined);
                  if (event._tag === "ContentDelta") output.push(event.text);
                  return Effect.void;
                }),
                Effect.forkChild,
              );
              const started = yield* runtime.start();
              // 前置条件失败时也明确关闭；不得先发送探针正文给意外发现的真实模型。
              yield* Effect.sync(() => {
                expect(started.initializeResult).toMatchObject({
                  agentInfo: { name: "gajae-code", version: "0.18.1" },
                  authMethods: [{ id: "agent" }],
                });
                expect(started.sessionSetupResult.models).toBeUndefined();
                expect(
                  started.sessionSetupResult.configOptions?.some(
                    (option) => option.category === "model",
                  ),
                ).toBe(false);
              }).pipe(Effect.onError(() => runtime.close.pipe(Effect.orDie)));
              const mode = yield* runtime.setMode("plan").pipe(Effect.result);
              // 再次请求仍需明确失败；不得重试缺配置或把空闲阶段当作推理成功。
              const prompts = [];
              for (const text of ["GAJAE_EMPTY_CONFIG_PROBE", "GAJAE_EMPTY_CONFIG_SECOND"]) {
                prompts.push(
                  yield* runtime.prompt({ prompt: [{ type: "text", text }] }).pipe(Effect.result),
                );
              }
              yield* runtime.drainEvents;
              // 在断言之前收尾，避免失败断言让独立后台会话留存。
              yield* runtime.close;
              yield* Fiber.interrupt(consumer);
              expect(
                requests.find(
                  (event) => event.method === "session/close" && event.status === "succeeded",
                )?.payload,
              ).toEqual({ sessionId: started.sessionId });
              expect(mode).toMatchObject({
                _tag: "Failure",
                failure: { code: -32602, data: { code: "unsupported" } },
              });
              for (const prompt of prompts) {
                expect(prompt).toMatchObject({
                  _tag: "Failure",
                  failure: {
                    code: -32603,
                    method: "session/prompt",
                    data: { code: "model_not_selected" },
                  },
                });
              }
              expect(
                requests.filter(
                  (event) => event.method === "session/prompt" && event.status === "started",
                ),
              ).toHaveLength(2);
              expect(
                requests.filter(
                  (event) => event.method === "session/prompt" && event.status === "failed",
                ),
              ).toHaveLength(2);
              expect(output).toEqual([]);
              expect((yield* runtime.getModeState)?.currentModeId).toBe("default");
              return;
            }
            const initialized = yield* runtime.request("initialize", {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: "codework-gajae-probe", version: "0.0.0" },
            });
            expect(initialized).toMatchObject({
              agentInfo: { name: "gajae-code", version: "0.18.1" },
              authMethods: [{ id: "agent" }],
            });
            const authenticated = yield* runtime
              .request("authenticate", { methodId: authMethodId })
              .pipe(Effect.result);
            // 建会话会启动上游独立的后台主机，本探针只验证认证方法，不创建该资源。
            expect(requests.some((event) => event.method === "session/new")).toBe(false);
            if (authMethodId === "login") {
              expect(authenticated).toMatchObject({ _tag: "Failure", failure: { code: -32603 } });
              return;
            }
            expect(authenticated).toMatchObject({ _tag: "Success", success: {} });
          }).pipe(
            Effect.provide(
              AcpSessionRuntime.layer({
                spawn: {
                  command: cliPath!,
                  args: ["acp"],
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
                authMethodId,
                clientInfo: { name: "codework-gajae-probe", version: "0.0.0" },
                requestLogger: (event) =>
                  Effect.sync(() => {
                    requests.push(event);
                  }),
              }),
            ),
            Effect.scoped,
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 60000 },
    );
  }
});
