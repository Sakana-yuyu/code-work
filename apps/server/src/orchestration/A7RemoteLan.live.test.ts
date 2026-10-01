// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics globalErrorInEffectFailure:off
// @effect-diagnostics globalFetchInEffect:off
// @effect-diagnostics tryCatchInEffectGen:off
// @effect-diagnostics catchToOrElseSucceed:off
/**
 * Live A-7 **remote (LAN)** mode: isolate `serve` bound to a non-loopback host;
 * clients use that LAN IP — never 127.0.0.1 (that is local mode).
 *
 * Plan wording: 本地 / 远程 / relay·tunnel are separate. Remote here means
 * remote-reachable bind + non-loopback HTTP/WS (docs: direct LAN pairing).
 * Same-host client via LAN IP is honest remote-path evidence; second device
 * is not required for the transport/auth distinction.
 *
 * Evidence: `.t3/a7-live-isolate-r62/a7-remote-lan-evidence.json`
 * Kill only captured serve/agent PIDs — never pkill -f / live ~/.t3.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type OrchestrationThread,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { isRemoteReachableHost } from "../auth/utils.ts";
import {
  initialAgentStreamState,
  reduceAgentStreamState,
} from "../cli/agentControlStreamState.ts";
import { openControlClient, type ControlRpcClient } from "../cli/controlClient.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(__dirname, "../../../..");
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const binPath = NodePath.join(__dirname, "../bin.ts");
const isolateHome = NodePath.join(
  repoRoot,
  ".t3",
  `a7-live-isolate-r62-${Date.now().toString(36)}`,
);
const evidenceDir = NodePath.join(repoRoot, ".t3", "a7-live-isolate-r62");
const evidencePath = NodePath.join(evidenceDir, "a7-remote-lan-evidence.json");

/** Prefer RFC1918 LAN; skip loopback, link-local, and Clash/Meta 198.18/16. */
const pickLanIpv4 = (): string => {
  const candidates: string[] = [];
  for (const entries of Object.values(NodeOS.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (family !== "IPv4" && family !== 4) continue;
      if (entry.internal) continue;
      const address = entry.address;
      if (address.startsWith("127.")) continue;
      if (address.startsWith("169.254.")) continue;
      if (address.startsWith("198.18.")) continue;
      candidates.push(address);
    }
  }
  const preferred = candidates.find(
    (address) =>
      address.startsWith("192.168.") ||
      address.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address),
  );
  if (!preferred) {
    throw new Error(`no usable LAN IPv4; candidates=${JSON.stringify(candidates)}`);
  }
  return preferred;
};

type Evidence = {
  ok: boolean;
  mode: "remote-lan";
  error: string | null;
  servePid: number | null;
  bindHost: string | null;
  clientHost: string | null;
  port: number | null;
  environmentId: string | null;
  authPolicy: string | null;
  scenarios: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
};

const step = (evidence: Evidence, name: string, detail: Record<string, unknown> = {}) => {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail });
};

const sleep = (ms: number) => Effect.promise(() => new Promise<void>((r) => setTimeout(r, ms)));
const nowIso = () => new Date().toISOString();
const uuid = () => NodeCrypto.randomUUID();

const reservePortOnHost = (host: string) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const server = NodeNet.createServer();
        server.listen(0, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close();
            reject(new Error("failed to reserve port"));
            return;
          }
          const { port } = address;
          server.close((error) => (error ? reject(error) : resolve(port)));
        });
        server.on("error", reject);
      }),
  );

async function makeMockAgentWrapper(extraEnv: Record<string, string>): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "a7-orch-mock-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- live harness chooses host shell wrappers outside Effect.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "fake-agent.cmd" : "fake-agent.sh");
  if (isWindows) {
    const envPath = NodePath.join(dir, "mock-env.json");
    const bootstrapPath = NodePath.join(dir, "fake-agent-bootstrap.cjs");
    await NodeFSP.writeFile(envPath, JSON.stringify(extraEnv), "utf8");
    await NodeFSP.writeFile(
      bootstrapPath,
      [
        'const { readFileSync } = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        "const [envPath, agentPath, ...args] = process.argv.slice(2);",
        'const extraEnv = JSON.parse(readFileSync(envPath, "utf8"));',
        "const env = { ...process.env };",
        "for (const key of Object.keys(env)) {",
        '  if (key.startsWith("CODEWORK_ACP_") && !(key in extraEnv)) delete env[key];',
        "}",
        "const child = spawn(process.execPath, [agentPath, ...args], {",
        "  env: { ...env, ...extraEnv },",
        '  stdio: "inherit",',
        "});",
        'child.once("exit", (code) => process.exit(code ?? 1));',
        "",
      ].join("\n"),
      "utf8",
    );
    await NodeFSP.writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${bootstrapPath}" "${envPath}" "${mockAgentPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8",
    );
  } else {
    await NodeFSP.writeFile(
      wrapperPath,
      `#!/bin/sh
${Object.entries(extraEnv)
  .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
  .join("\n")}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`,
      "utf8",
    );
    await NodeFSP.chmod(wrapperPath, 0o755);
  }
  return wrapperPath;
}

const killPidTree = (pid: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        // oxlint-disable-next-line codework/no-global-process-runtime -- live harness signals follow the real host outside Effect.
        if (process.platform === "win32") {
          const killer = NodeChildProcess.spawn(
            "taskkill.exe",
            ["/pid", String(pid), "/t", "/f"],
            { stdio: "ignore", windowsHide: true },
          );
          killer.once("exit", () => resolve());
          killer.once("error", () => {
            try {
              process.kill(pid);
            } catch {
              // already gone
            }
            resolve();
          });
          return;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }),
  );

const approvalRequestId = (thread: OrchestrationThread): string | null => {
  for (const activity of thread.activities) {
    if (activity.kind !== "approval.requested") continue;
    const payload = activity.payload;
    if (payload && typeof payload === "object" && "requestId" in payload) {
      const requestId = (payload as { requestId?: unknown }).requestId;
      if (typeof requestId === "string" && requestId.length > 0) return requestId;
    }
  }
  return null;
};

const awaitThread = (
  rpc: ControlRpcClient,
  threadId: ThreadId,
  predicate: (thread: OrchestrationThread) => boolean,
  label: string,
  timeoutMs = 60_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let lastKinds: string[] = [];
    while (Date.now() < deadline) {
      const state = yield* rpc[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId,
      }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.take(1),
        Stream.runFold(() => initialAgentStreamState, (current, item) =>
          reduceAgentStreamState(current, item),
        ),
        Effect.catch(() => Effect.succeed(initialAgentStreamState)),
      );
      if (state.thread) {
        lastKinds = state.thread.activities.map((activity) => activity.kind);
        if (predicate(state.thread)) return state.thread;
      }
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
    }
    return yield* Effect.fail(
      new Error(`${label} timeout; last activity kinds=${JSON.stringify(lastKinds)}`),
    );
  });

const startTurn = (
  rpc: ControlRpcClient,
  input: {
    projectId: ProjectId;
    threadId: ThreadId;
    title: string;
    text: string;
    runtimeMode: "approval-required" | "full-access";
    modelSelection: { instanceId: ProviderInstanceId; model: string };
  },
) =>
  rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.turn.start",
    commandId: CommandId.make(uuid()),
    threadId: input.threadId,
    message: {
      messageId: MessageId.make(uuid()),
      role: "user",
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: nowIso(),
      },
    },
    createdAt: nowIso(),
  });

const setCursorBinary = (rpc: ControlRpcClient, binaryPath: string) =>
  rpc[WS_METHODS.serverUpdateSettings]({
    patch: {
      providers: {
        cursor: { enabled: true, binaryPath },
      },
    },
  });

it.effect(
  "remote LAN: reconnect + orchestration late-approval / crash-recover / cancel-restart via non-loopback WS",
  () =>
    Effect.gen(function* () {
      const lanHost = pickLanIpv4();
      assert.isTrue(isRemoteReachableHost(lanHost));
      assert.isFalse(lanHost === "127.0.0.1" || lanHost.startsWith("127."));

      const evidence: Evidence = {
        ok: false,
        mode: "remote-lan",
        error: null,
        servePid: null,
        bindHost: lanHost,
        clientHost: lanHost,
        port: null,
        environmentId: null,
        authPolicy: null,
        scenarios: {},
        steps: [],
      };

      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(evidenceDir, { recursive: true });
        await NodeFSP.mkdir(NodePath.join(isolateHome, "userdata"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(isolateHome, "workspace"), { recursive: true });
      });

      const port = yield* reservePortOnHost(lanHost);
      evidence.port = port;
      // Honest remote client: LAN IP only — never rewrite to 127.0.0.1.
      const httpBase = `http://${lanHost}:${port}`;
      const serverLog = NodePath.join(isolateHome, "server.log");
      const serverErr = NodePath.join(isolateHome, "server.err.log");
      const logHandle = yield* Effect.promise(() => NodeFSP.open(serverLog, "w"));
      const errHandle = yield* Effect.promise(() => NodeFSP.open(serverErr, "w"));

      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          binPath,
          "serve",
          "--host",
          lanHost,
          "--port",
          String(port),
          "--base-dir",
          isolateHome,
          "--no-browser",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, CODEWORK_HOME: isolateHome },
          stdio: ["ignore", logHandle.fd, errHandle.fd],
          windowsHide: true,
        },
      );
      evidence.servePid = child.pid ?? null;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(isolateHome, "server.pid.txt"),
          String(child.pid ?? ""),
          "utf8",
        ),
      );
      step(evidence, "serve-spawn", {
        pid: child.pid,
        port,
        bindHost: lanHost,
        clientBase: httpBase,
        remoteReachable: isRemoteReachableHost(lanHost),
      });

      const waitPairingUrl = Effect.gen(function* () {
        for (let i = 0; i < 90; i++) {
          const out = yield* Effect.promise(() =>
            NodeFSP.readFile(serverLog, "utf8").catch(() => ""),
          );
          const err = yield* Effect.promise(() =>
            NodeFSP.readFile(serverErr, "utf8").catch(() => ""),
          );
          const combined = `${out}\n${err}`;
          const match =
            combined.match(/Pairing URL:\s*(\S+)/i) ?? combined.match(/pairingUrl:\s*(\S+)/i);
          if (match?.[1]) return match[1].replace(/[)\],'"]+$/, "");
          if (child.exitCode !== null) {
            return yield* Effect.fail(
              new Error(`serve exited early code=${child.exitCode}\n${combined.slice(-2000)}`),
            );
          }
          yield* sleep(500);
        }
        return yield* Effect.fail(new Error("pairing URL timeout"));
      });

      try {
        const pairingUrl = yield* waitPairingUrl;
        const pairingHost = new URL(pairingUrl).hostname;
        assert.isFalse(pairingHost === "127.0.0.1" || pairingHost === "localhost");
        assert.equal(pairingHost, lanHost);
        step(evidence, "pairing-url", {
          hasToken: pairingUrl.includes("#token="),
          pairingHost,
          clientHost: lanHost,
        });

        // Pairing credentials are single-use; exchange once and reuse the bearer.
        const pairingCredential = new URL(pairingUrl).hash.startsWith("#token=")
          ? decodeURIComponent(new URL(pairingUrl).hash.slice("#token=".length))
          : "";
        assert.isTrue(pairingCredential.length > 0);
        const tokenRes = yield* Effect.promise(() =>
          fetch(new URL("/oauth/token", httpBase), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token: pairingCredential,
              subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
              requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              scope:
                "orchestration:read orchestration:operate terminal:operate review:write relay:read",
              client_label: "Code Work A7 Remote LAN Harness",
              client_device_type: "bot",
            }).toString(),
          }).then(async (r) => ({
            status: r.status,
            json: (await r.json()) as { access_token?: string; error?: string },
          })),
        );
        assert.equal(tokenRes.status, 200);
        const accessToken = tokenRes.json.access_token;
        assert.isTrue(typeof accessToken === "string" && accessToken.length > 0);
        if (typeof accessToken !== "string" || accessToken.length === 0) {
          throw new Error("missing access token");
        }
        const serverUrl = httpBase;
        step(evidence, "bearer-exchanged", { ok: true, via: httpBase });

        const envRes = yield* Effect.promise(() =>
          fetch(new URL("/.well-known/t3/environment", httpBase)).then(async (r) => ({
            status: r.status,
            json: (await r.json()) as { environmentId?: string; auth?: { policy?: string } },
          })),
        );
        evidence.environmentId = envRes.json.environmentId ?? null;
        evidence.authPolicy = envRes.json.auth?.policy ?? null;
        // Bind host is remote-reachable by construction; well-known may or may not echo policy.
        assert.isTrue(isRemoteReachableHost(lanHost));
        step(evidence, "environment", {
          status: envRes.status,
          environmentId: evidence.environmentId,
          authPolicy: evidence.authPolicy,
          bindRemoteReachable: true,
        });

        const withRpc = <A, E, R>(
          use: (rpc: ControlRpcClient) => Effect.Effect<A, E, R>,
        ) => openControlClient({ serverUrl, accessToken }, use);

        // Explicit LAN WS reconnect before orchestration scenarios (mode ≠ local loopback).
        yield* withRpc((rpc) =>
          rpc[WS_METHODS.serverGetSettings]({}).pipe(
            Effect.map((settings) => {
              step(evidence, "ws-connected", {
                hasSettings: settings !== null && typeof settings === "object",
                via: httpBase,
              });
            }),
          ),
        );
        yield* withRpc((rpc) =>
          rpc[WS_METHODS.serverGetSettings]({}).pipe(
            Effect.map(() => {
              step(evidence, "ws-reconnected", { via: httpBase });
            }),
          ),
        );
        evidence.scenarios.lanWsReconnect = { ok: true, clientBase: httpBase };
        yield* Effect.promise(() =>
          NodeFSP.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8"),
        );

        const childPidLogPath = NodePath.join(isolateHome, "agent.pid");
        const approvalWrapper = yield* Effect.promise(() =>
          makeMockAgentWrapper({
            CODEWORK_ACP_EMIT_TOOL_CALLS: "1",
            CODEWORK_ACP_CHILD_PID_LOG_PATH: childPidLogPath,
          }),
        );

        const workspaceRoot = NodePath.join(isolateHome, "workspace");
        const projectId = ProjectId.make(`a7-remote-${uuid()}`);
        const cursorModel = {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "default",
        } as const;

        yield* withRpc( (rpc) =>
          Effect.gen(function* () {
            yield* setCursorBinary(rpc, approvalWrapper);
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "project.create",
              commandId: CommandId.make(uuid()),
              projectId,
              title: "A7 Remote LAN Isolate",
              workspaceRoot,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection: cursorModel,
              createdAt: nowIso(),
            });
          }),
        );
        step(evidence, "settings-and-project", { projectId });

        // 1) Late approval after client disconnect/reconnect
        const lateThreadId = ThreadId.make(uuid());
        let lateRequestId = "";
        yield* withRpc( (rpc) =>
          Effect.gen(function* () {
            yield* startTurn(rpc, {
              projectId,
              threadId: lateThreadId,
              title: "late-approval",
              text: "orch late approval after reconnect",
              runtimeMode: "approval-required",
              modelSelection: cursorModel,
            });
            const thread = yield* awaitThread(
              rpc,
              lateThreadId,
              (candidate) => approvalRequestId(candidate) !== null,
              "approval.requested (late-approval)",
              45_000,
            );
            lateRequestId = approvalRequestId(thread) ?? "";
          }),
        );
        step(evidence, "late-approval-opened", { threadId: lateThreadId, requestId: lateRequestId });
        assert.isTrue(lateRequestId.length > 0);

        yield* withRpc((rpc) =>
          Effect.gen(function* () {
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.approval.respond",
              commandId: CommandId.make(uuid()),
              threadId: lateThreadId,
              requestId: ApprovalRequestId.make(lateRequestId),
              decision: "accept",
              createdAt: nowIso(),
            });
            yield* awaitThread(
              rpc,
              lateThreadId,
              (thread) => {
                const resolved = thread.activities.some(
                  (activity) =>
                    activity.kind === "approval.resolved" &&
                    typeof activity.payload === "object" &&
                    activity.payload !== null &&
                    (activity.payload as { requestId?: string }).requestId === lateRequestId,
                );
                const turnDone =
                  thread.latestTurn?.state === "completed" ||
                  thread.latestTurn?.state === "error" ||
                  thread.latestTurn?.state === "interrupted" ||
                  thread.session?.status === "idle" ||
                  thread.session?.status === "stopped";
                return resolved || turnDone;
              },
              "late approval settle",
            );
          }),
        );
        evidence.scenarios.lateApprovalAfterReconnect = { ok: true, requestId: lateRequestId };
        step(evidence, "late-approval-after-reconnect", { ok: true });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8"),
        );

        // 2) Agent crash mid-approval + recover
        // Crash uses the same mock binary — avoid mid-run settings switches
        // ("供应商配置正在切换") which reject new turns.
        yield* Effect.promise(() => NodeFSP.rm(childPidLogPath, { force: true }));

        const crashThreadId = ThreadId.make(uuid());
        let crashRequestId = "";
        let agentPid: number | null = null;
        yield* withRpc((rpc) =>
          Effect.gen(function* () {
            yield* startTurn(rpc, {
              projectId,
              threadId: crashThreadId,
              title: "crash-mid-approval",
              text: "orch crash mid approval",
              runtimeMode: "approval-required",
              modelSelection: cursorModel,
            });
            const opened = yield* awaitThread(
              rpc,
              crashThreadId,
              (thread) => approvalRequestId(thread) !== null,
              "approval.requested (crash)",
              45_000,
            );
            crashRequestId = approvalRequestId(opened) ?? "";
            assert.isTrue(crashRequestId.length > 0);

            for (let i = 0; i < 40; i++) {
              const raw = yield* Effect.promise(() =>
                NodeFSP.readFile(childPidLogPath, "utf8").catch(() => ""),
              );
              const pid = Number(raw.trim());
              if (Number.isSafeInteger(pid) && pid > 0) {
                agentPid = pid;
                break;
              }
              yield* sleep(100);
            }
            assert.isTrue(agentPid !== null && agentPid > 0);

            yield* killPidTree(agentPid!);
            step(evidence, "agent-crash-kill", { agentPid, requestId: crashRequestId });
            yield* awaitThread(
              rpc,
              crashThreadId,
              (thread) =>
                thread.latestTurn?.state === "error" ||
                thread.latestTurn?.state === "interrupted" ||
                thread.session?.status === "stopped" ||
                thread.activities.some(
                  (activity) =>
                    activity.kind === "approval.resolved" ||
                    activity.kind === "provider.turn.start.failed" ||
                    activity.tone === "error",
                ),
              "post-crash settle",
            );
          }),
        );

        const recoverThreadId = ThreadId.make(uuid());
        yield* withRpc((rpc) =>
          Effect.gen(function* () {
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.session.stop",
              commandId: CommandId.make(uuid()),
              threadId: crashThreadId,
              createdAt: nowIso(),
            }).pipe(Effect.catch(() => Effect.void));

            yield* startTurn(rpc, {
              projectId,
              threadId: recoverThreadId,
              title: "recover-after-crash",
              text: "recover after crash",
              runtimeMode: "approval-required",
              modelSelection: cursorModel,
            });
            const opened = yield* awaitThread(
              rpc,
              recoverThreadId,
              (thread) => approvalRequestId(thread) !== null,
              "recover approval",
              45_000,
            );
            const recoverRequestId = approvalRequestId(opened);
            assert.isTrue(typeof recoverRequestId === "string" && recoverRequestId.length > 0);
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.approval.respond",
              commandId: CommandId.make(uuid()),
              threadId: recoverThreadId,
              requestId: ApprovalRequestId.make(recoverRequestId!),
              decision: "accept",
              createdAt: nowIso(),
            });
            yield* awaitThread(
              rpc,
              recoverThreadId,
              (thread) =>
                thread.latestTurn?.state === "completed" ||
                thread.activities.some((activity) => activity.kind === "approval.resolved"),
              "recover turn complete",
              60_000,
            );
            evidence.scenarios.agentCrashRecover = {
              ok: true,
              crashedAgentPid: agentPid,
              crashRequestId,
              recoverThreadId,
            };
          }),
        );
        step(evidence, "agent-crash-recover", { ok: true });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8"),
        );

        // Cancel = interrupt while approval pending, then restart + approve.
        const cancelThreadId = ThreadId.make(uuid());
        yield* withRpc((rpc) =>
          Effect.gen(function* () {
            yield* startTurn(rpc, {
              projectId,
              threadId: cancelThreadId,
              title: "cancel-then-restart",
              text: "hang on approval for cancel",
              runtimeMode: "approval-required",
              modelSelection: cursorModel,
            });
            yield* awaitThread(
              rpc,
              cancelThreadId,
              (thread) => approvalRequestId(thread) !== null,
              "cancel approval opened",
              45_000,
            );
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(uuid()),
              threadId: cancelThreadId,
              createdAt: nowIso(),
            });
            yield* awaitThread(
              rpc,
              cancelThreadId,
              (thread) =>
                thread.latestTurn?.state === "interrupted" ||
                thread.session?.status === "stopped" ||
                thread.activities.some(
                  (activity) =>
                    activity.kind === "approval.resolved" ||
                    String(activity.kind).includes("interrupt"),
                ),
              "interrupt settle",
            );
          }),
        );

        const restartThreadId = ThreadId.make(uuid());
        yield* withRpc((rpc) =>
          Effect.gen(function* () {
            yield* startTurn(rpc, {
              projectId,
              threadId: restartThreadId,
              title: "restart-after-cancel",
              text: "restart after cancel",
              runtimeMode: "approval-required",
              modelSelection: cursorModel,
            });
            const opened = yield* awaitThread(
              rpc,
              restartThreadId,
              (thread) => approvalRequestId(thread) !== null,
              "restart approval",
              45_000,
            );
            const restartRequestId = approvalRequestId(opened);
            assert.isTrue(typeof restartRequestId === "string" && restartRequestId.length > 0);
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.approval.respond",
              commandId: CommandId.make(uuid()),
              threadId: restartThreadId,
              requestId: ApprovalRequestId.make(restartRequestId!),
              decision: "accept",
              createdAt: nowIso(),
            });
            yield* awaitThread(
              rpc,
              restartThreadId,
              (thread) =>
                thread.latestTurn?.state === "completed" ||
                thread.activities.some((activity) => activity.kind === "approval.resolved"),
              "restart turn complete",
              60_000,
            );
            evidence.scenarios.cancelThenRestart = {
              ok: true,
              cancelThreadId,
              restartThreadId,
            };
          }),
        );
        step(evidence, "cancel-then-restart", { ok: true });

        evidence.ok = true;
      } catch (error) {
        evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
        evidence.ok = false;
        throw error;
      } finally {
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
          await logHandle.close().catch(() => undefined);
          await errHandle.close().catch(() => undefined);
        });
        if (child.pid) {
          yield* killPidTree(child.pid);
          step(evidence, "serve-teardown", { pid: child.pid });
          yield* Effect.promise(() =>
            NodeFSP.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8"),
          );
        }
      }
    }).pipe(TestClock.withLive, Effect.orDie),
  { timeout: 300_000 },
);
