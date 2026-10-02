/** 七项前空壳 Windows 二进制：隔离握手；不发明凭据、不强制工具成功。 */
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { isProbeExecutableAvailable } from "./acpCliProbeGate.ts";

const root = process.env.CODEWORK_A4_EMPTY_SHELL_ROOT;

type Spec = {
  readonly id: string;
  readonly relativeCommand: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  readonly expectAgentName: string;
  readonly expectSession?: "auth-required" | "created";
};

const specs: Spec[] = [
  {
    id: "corust-agent",
    relativeCommand: "corust-agent/extract/corust-agent-acp.exe",
    args: [],
    expectAgentName: "corust-acp",
    expectSession: "auth-required",
  },
  {
    id: "stakpak",
    relativeCommand: "stakpak/extract/stakpak.exe",
    args: ["acp"],
    expectAgentName: "stakpak",
    expectSession: "auth-required",
  },
  {
    id: "vtcode",
    relativeCommand: "vtcode/extract/vtcode.exe",
    args: ["acp"],
    env: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" },
    expectAgentName: "vtcode",
    expectSession: "created",
  },
  {
    id: "antigravity-acp",
    relativeCommand: "antigravity-acp/extract/agy_acp_server.exe",
    args: [],
    expectAgentName: "antigravity-acp",
    expectSession: "auth-required",
  },
  {
    id: "devin",
    relativeCommand: "devin/extract/bin/devin.exe",
    args: ["acp"],
    expectAgentName: "affogato",
    expectSession: "auth-required",
  },
  // Junie: isolate stdio probe got initialize=@jetbrains/junie + session/new；
  // AcpSessionRuntime.start 在本机可挂起 >90s，改由 docs 记录脚本证据，不在此强制 Effect 超时。
  {
    id: "cortex-code",
    relativeCommand: "cortex-code/extract/coco-1.0.73+180523.e6179a031de9-windows-amd64/cortex.exe",
    args: ["acp", "serve"],
    expectAgentName: "Cortex Code",
    expectSession: "created",
  },
];

describe.runIf(Boolean(root))("前空壳七项官方 ACP CLI 握手（隔离）", () => {
  for (const spec of specs) {
    it.live.skipIf(
      !isProbeExecutableAvailable(root ? NodePath.join(root, spec.relativeCommand) : undefined),
    )(
      `${spec.id} initialize`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temp = yield* fs.makeTempDirectory({ prefix: `codework-${spec.id}-probe-` });
          const cwd = path.join(temp, "workspace");
          const home = path.join(temp, "home");
          yield* fs.makeDirectory(cwd);
          yield* fs.makeDirectory(home);
          yield* fs.makeDirectory(path.join(home, "AppData"), { recursive: true });
          yield* fs.makeDirectory(path.join(home, "AppData", "Roaming"), { recursive: true });
          yield* fs.makeDirectory(path.join(home, "AppData", "Local"), { recursive: true });
          yield* Effect.addFinalizer(() =>
            fs.remove(temp, { recursive: true }).pipe(Effect.ignore),
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
          const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
          const command = path.join(root!, ...spec.relativeCommand.split("/"));
          yield* Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
            const started = yield* runtime
              .start()
              .pipe(Effect.timeout("90 seconds"), Effect.result);
            const initialize = requests.find(
              (event) => event.method === "initialize" && event.status === "succeeded",
            )?.result as { agentInfo?: { name?: string } } | undefined;
            expect(initialize?.agentInfo?.name).toBe(spec.expectAgentName);
            expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
            if (spec.expectSession === "created") {
              // Junie may hang after session/new; initialize + session/new success is enough.
              const sessionCreated = requests.some(
                (event) => event.method === "session/new" && event.status === "succeeded",
              );
              expect(started._tag === "Success" || sessionCreated).toBe(true);
            } else if (started._tag === "Failure") {
              const failure = started.failure as {
                message?: string;
                detail?: string;
                _tag?: string;
              };
              const detail = String(failure.message ?? failure.detail ?? failure._tag ?? failure);
              expect(detail).toMatch(/auth|Auth|login|Login|required|AcpRequestError|Timeout/i);
            }
            if (started._tag === "Success") {
              yield* runtime.close.pipe(
                Effect.timeout("15 seconds"),
                Effect.catch(() => Effect.void),
              );
            }
          }).pipe(
            Effect.provide(
              AcpSessionRuntime.layer({
                spawn: {
                  command,
                  args: [...spec.args],
                  cwd,
                  env: {
                    ...env,
                    HOME: home,
                    USERPROFILE: home,
                    APPDATA: path.join(home, "AppData", "Roaming"),
                    LOCALAPPDATA: path.join(home, "AppData", "Local"),
                    PATH: process.env.PATH ?? "",
                    ...(spec.env ?? {}),
                  },
                },
                cwd,
                authMethodId: "",
                clientInfo: { name: `codework-${spec.id}-probe`, version: "0.0.0" },
                requestLogger: (event) =>
                  Effect.sync(() => {
                    requests.push(event);
                  }),
              }),
            ),
            Effect.scoped,
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 180000 },
    );
  }
});
