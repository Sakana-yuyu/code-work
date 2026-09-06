import { describe, it, expect } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type TerminalSessionSnapshot,
} from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { providerLoginCommand, startProviderLogin } from "./providerLogin.ts";

describe("供应商原生登录", () => {
  it.effect("使用实例的认证目录、清除 API 覆盖，超时只清理本次终端", () =>
    Effect.gen(function* () {
      const calls: Parameters<TerminalManager["Service"]["runCommand"]>[0][] = [];
      const closed: Parameters<TerminalManager["Service"]["close"]>[0][] = [];
      const instanceId = ProviderInstanceId.make("codex-personal");
      const run = startProviderLogin({
        instanceId,
        terminalId: "login-test",
        deviceCode: true,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                config: {
                  binaryPath: "/opt/codex",
                  homePath: "/shared/codex",
                  shadowHomePath: "/personal/codex",
                },
                environment: [
                  { name: "OPENAI_API_KEY", value: "fixture-secret", sensitive: true },
                  { name: "ANTHROPIC_AUTH_TOKEN", value: "fixture-token", sensitive: true },
                  { name: "KIMI_API_KEY", value: "fixture-kimi", sensitive: true },
                  { name: "KIMI_BASE_URL", value: "https://relay.invalid", sensitive: false },
                  { name: "AGY_API_KEY", value: "fixture-agy", sensitive: true },
                  { name: "AGY_BASE_URL", value: "https://relay.invalid", sensitive: false },
                  { name: "CURSOR_AUTH_TOKEN", value: "fixture-cursor", sensitive: true },
                  { name: "MY_SETTING", value: "preserved", sensitive: false },
                ],
              },
            },
          }),
        } as unknown as ServerSettingsService["Service"]),
        Effect.provideService(ServerConfig, { cwd: "/workspace" } as ServerConfig["Service"]),
        Effect.provideService(TerminalManager, {
          runCommand: (input: Parameters<TerminalManager["Service"]["runCommand"]>[0]) =>
            Effect.sync(() => {
              calls.push(input);
              return {
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd,
                status: "running",
              } as TerminalSessionSnapshot;
            }),
          close: (input: Parameters<TerminalManager["Service"]["close"]>[0]) =>
            Effect.sync(() => {
              closed.push(input);
            }),
        } as unknown as TerminalManager["Service"]),
      );
      yield* run;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "/opt/codex",
        args: ["login", "--device-auth"],
        threadId: "provider-login:codex-personal",
        terminalId: "login-test",
        env: {
          CODEX_HOME: "/personal/codex",
          OPENAI_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          KIMI_API_KEY: "",
          KIMI_BASE_URL: "",
          AGY_API_KEY: "",
          AGY_BASE_URL: "",
          CURSOR_AUTH_TOKEN: "",
          MY_SETTING: "preserved",
        },
      });
      expect(calls[0]?.args?.join(" ")).not.toContain("fixture-secret");
      yield* TestClock.adjust("10 minutes");
      expect(closed).toEqual([
        {
          threadId: "provider-login:codex-personal",
          terminalId: "login-test",
          deleteHistory: true,
        },
      ]);
    }),
  );

  it("只提供已验证的原生命令，不猜测其他 CLI 的 OAuth 支持", () => {
    expect(providerLoginCommand("claudeAgent", false)).toEqual({
      binary: "claude",
      args: ["auth", "login"],
    });
    expect(providerLoginCommand("codex", false)).toEqual({ binary: "codex", args: ["login"] });
    expect(providerLoginCommand("grok", false)).toEqual({ binary: "grok", args: ["login"] });
    expect(providerLoginCommand("grok", true)).toEqual({
      binary: "grok",
      args: ["login", "--device-auth"],
    });
    expect(providerLoginCommand("kimi", false)).toEqual({
      binary: "kimi",
      args: ["login"],
    });
    expect(providerLoginCommand("antigravity", false)).toEqual({
      binary: "agy",
      args: [],
    });
    expect(providerLoginCommand("cursor", false)).toBeNull();
    expect(providerLoginCommand("unknown", false)).toBeNull();
  });

  it.effect("Windows 登录命令解析会继承主机 PATH", () =>
    Effect.gen(function* () {
      let resolvedEnvironment: NodeJS.ProcessEnv | undefined;
      const calls: Parameters<TerminalManager["Service"]["runCommand"]>[0][] = [];
      const instanceId = ProviderInstanceId.make("codex-windows");
      yield* startProviderLogin({
        instanceId,
        terminalId: "login-windows",
        deviceCode: false,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
          resolvedEnvironment = env;
          return "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
        }),
        Effect.provideService(ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
            },
          }),
        } as unknown as ServerSettingsService["Service"]),
        Effect.provideService(ServerConfig, { cwd: "C:\\workspace" } as ServerConfig["Service"]),
        Effect.provideService(TerminalManager, {
          runCommand: (input: Parameters<TerminalManager["Service"]["runCommand"]>[0]) =>
            Effect.sync(() => {
              calls.push(input);
              return {
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd,
                status: "running",
              } as TerminalSessionSnapshot;
            }),
          close: () => Effect.void,
        } as unknown as TerminalManager["Service"]),
      );
      expect(resolvedEnvironment?.PATH).toBeTruthy();
      expect(resolvedEnvironment?.OPENAI_API_KEY).toBe("");
      expect(calls[0]?.command).toBe("cmd.exe");
      expect(calls[0]?.args?.join(" ")).toContain("codex.cmd");
    }),
  );
});
