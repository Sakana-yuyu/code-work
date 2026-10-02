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
 * Live A-7 **product SSH local-forward** tunnel: real `ssh.exe -N -L` with Code Work
 * askpass packaging (`CODEWORK_SSH_AUTH_SECRET` + Windows askpass scripts matching
 * `packages/ssh/src/auth.ts`), then WS orch through the forwarded port.
 *
 * Windows OpenSSH 9.5p2 pubkey for Administrators fails after key accept
 * (`Unknown error [preauth]` / Permission denied after sign). Product desktop SSH
 * uses password askpass (`BatchMode=no` + SSH_ASKPASS) — that path works here.
 *
 * Evidence: `.t3/a7-live-isolate-r64/a7-ssh-product-tunnel-evidence.json`
 * Kill only captured serve / ssh / agent PIDs — never pkill -f / live ~/.t3.
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

import { initialAgentStreamState, reduceAgentStreamState } from "../cli/agentControlStreamState.ts";
import { openControlClient, type ControlRpcClient } from "../cli/controlClient.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(__dirname, "../../../..");
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const binPath = NodePath.join(__dirname, "../bin.ts");
const isolateHome = NodePath.join(
  repoRoot,
  ".t3",
  `a7-live-isolate-r64-${Date.now().toString(36)}`,
);
const evidenceDir = NodePath.join(repoRoot, ".t3", "a7-live-isolate-r64");
const evidencePath = NodePath.join(evidenceDir, "a7-ssh-product-tunnel-evidence.json");

/** Keep in sync with packages/ssh/src/auth.ts ASKPASS_WINDOWS_*. */
const ASKPASS_WINDOWS_LAUNCHER_SCRIPT = `@echo off\r
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ssh-askpass.ps1" %*\r
`;
const ASKPASS_WINDOWS_SCRIPT = `# Invoked by ssh via SSH_ASKPASS (through ssh-askpass.cmd) when Code Work re-runs\r
# ssh with a cached password from the renderer's in-app prompt. We never expose\r
# a native dialog here - if CODEWORK_SSH_AUTH_SECRET is missing, that's a caller bug\r
# and we fail loudly.\r
if ($null -ne $env:CODEWORK_SSH_AUTH_SECRET) {\r
  [Console]::Out.WriteLine($env:CODEWORK_SSH_AUTH_SECRET)\r
  exit 0\r
}\r
[Console]::Error.WriteLine("Code Work ssh-askpass invoked without CODEWORK_SSH_AUTH_SECRET.")\r
exit 1\r
`;

const SSH_USER = "a7tunnel";

type Evidence = {
  ok: boolean;
  mode: "tunnel-ssh-product-local-forward";
  semantics: string;
  error: string | null;
  servePid: number | null;
  tunnelPid: number | null;
  serveHost: string | null;
  servePort: number | null;
  tunnelListenHost: string | null;
  tunnelListenPort: number | null;
  clientBase: string | null;
  sshUser: string | null;
  authMode: string | null;
  environmentId: string | null;
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

const ensureSshTunnelUser = (password: string) =>
  Effect.promise(async () => {
    // Prefer `net user` — vitest child PowerShell often cannot autoload
    // Microsoft.PowerShell.Security (ConvertTo-SecureString).
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = NodeChildProcess.spawn(args[0]!, args.slice(1), {
          windowsHide: true,
          shell: false,
        });
        let out = "";
        let err = "";
        child.stdout?.on("data", (c: Buffer) => {
          out += c.toString("utf8");
        });
        child.stderr?.on("data", (c: Buffer) => {
          err += c.toString("utf8");
        });
        child.on("exit", (code) => resolve({ code, out, err }));
        child.on("error", (error) => resolve({ code: 1, out, err: String(error) }));
      });

    const existing = await run(["net", "user", SSH_USER]);
    if (existing.code !== 0) {
      const created = await run(["net", "user", SSH_USER, password, "/add", "/y"]);
      if (created.code !== 0) {
        throw new Error(`net user /add failed\n${created.out}\n${created.err}`);
      }
    } else {
      const updated = await run(["net", "user", SSH_USER, password]);
      if (updated.code !== 0) {
        throw new Error(`net user password set failed\n${updated.out}\n${updated.err}`);
      }
    }
    await run(["net", "localgroup", "Administrators", SSH_USER, "/delete"]);
  });

const writeProductAskpass = async (directory: string) => {
  await NodeFSP.mkdir(directory, { recursive: true });
  const launcherPath = NodePath.join(directory, "ssh-askpass.cmd");
  const ps1Path = NodePath.join(directory, "ssh-askpass.ps1");
  await NodeFSP.writeFile(launcherPath, ASKPASS_WINDOWS_LAUNCHER_SCRIPT, "utf8");
  await NodeFSP.writeFile(ps1Path, ASKPASS_WINDOWS_SCRIPT, "utf8");
  return launcherPath;
};

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
          const killer = NodeChildProcess.spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
          });
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
        Stream.runFold(
          () => initialAgentStreamState,
          (current, item) => reduceAgentStreamState(current, item),
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

it.effect.skipIf(process.env.LIVE !== "1")(
  "product SSH -L: reconnect + orchestration late-approval / crash-recover / cancel-restart via ssh.exe forward",
  () =>
    Effect.gen(function* () {
      const serveHost = "127.0.0.1";
      const tunnelListenHost = "127.0.0.1";
      const password = `A7tunnel!${NodeCrypto.randomBytes(4).toString("hex")}`;

      const evidence: Evidence = {
        ok: false,
        mode: "tunnel-ssh-product-local-forward",
        semantics:
          "Product SSH tunnel = packages/ssh startSshTunnel (-N -L) + askpass (CODEWORK_SSH_AUTH_SECRET). Pubkey Administrators path broken on OpenSSH_for_Windows_9.5p2 (Unknown error [preauth]); password askpass works.",
        error: null,
        servePid: null,
        tunnelPid: null,
        serveHost,
        servePort: null,
        tunnelListenHost,
        tunnelListenPort: null,
        clientBase: null,
        sshUser: SSH_USER,
        authMode: "password-askpass-CODEWORK_SSH_AUTH_SECRET",
        environmentId: null,
        scenarios: {},
        steps: [],
      };

      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(evidenceDir, { recursive: true });
        await NodeFSP.mkdir(NodePath.join(isolateHome, "userdata"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(isolateHome, "workspace"), { recursive: true });
      });

      yield* ensureSshTunnelUser(password);
      step(evidence, "ssh-user-ready", { user: SSH_USER, adminGroup: false });

      const askpassDir = NodePath.join(isolateHome, "ssh-askpass");
      const askpassLauncher = yield* Effect.promise(() => writeProductAskpass(askpassDir));
      const knownHostsPath = NodePath.join(isolateHome, "known_hosts");
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = NodeChildProcess.spawn("ssh-keyscan", ["-t", "ed25519", "127.0.0.1"], {
              windowsHide: true,
            });
            const chunks: Buffer[] = [];
            child.stdout?.on("data", (c: Buffer) => chunks.push(c));
            child.on("exit", async (code) => {
              try {
                await NodeFSP.writeFile(knownHostsPath, Buffer.concat(chunks));
                if (code === 0) resolve();
                else reject(new Error(`ssh-keyscan exit ${code}`));
              } catch (error) {
                reject(error);
              }
            });
            child.on("error", reject);
          }),
      );
      step(evidence, "askpass-and-known-hosts", { askpassLauncher, knownHostsPath });

      const servePort = yield* reservePortOnHost(serveHost);
      const tunnelListenPort = yield* reservePortOnHost(tunnelListenHost);
      evidence.servePort = servePort;
      evidence.tunnelListenPort = tunnelListenPort;
      const httpBase = `http://${tunnelListenHost}:${tunnelListenPort}`;
      evidence.clientBase = httpBase;
      assert.notEqual(tunnelListenPort, servePort);

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
          serveHost,
          "--port",
          String(servePort),
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
      step(evidence, "serve-spawn", { pid: child.pid, serveHost, servePort });

      // Mirror packages/ssh/src/tunnel.ts startSshTunnel args (+ product askpass env).
      const sshErrLog = NodePath.join(isolateHome, "ssh.err.log");
      const sshErrHandle = yield* Effect.promise(() => NodeFSP.open(sshErrLog, "w"));
      const tunnelChild = NodeChildProcess.spawn(
        "ssh.exe",
        [
          "-o",
          "BatchMode=no",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "PreferredAuthentications=password",
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "NumberOfPasswordPrompts=1",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${knownHostsPath}`,
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ControlMaster=no",
          "-o",
          "ControlPath=none",
          "-o",
          "ControlPersist=no",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          "-n",
          "-N",
          "-L",
          `${tunnelListenPort}:127.0.0.1:${servePort}`,
          "-l",
          SSH_USER,
          "127.0.0.1",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            SSH_ASKPASS: askpassLauncher,
            SSH_ASKPASS_REQUIRE: "force",
            CODEWORK_SSH_AUTH_SECRET: password,
            DISPLAY: "codework",
          },
          stdio: ["ignore", "ignore", sshErrHandle.fd],
          windowsHide: true,
        },
      );
      evidence.tunnelPid = tunnelChild.pid ?? null;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(isolateHome, "ssh.tunnel.pid.txt"),
          String(tunnelChild.pid ?? ""),
          "utf8",
        ),
      );
      step(evidence, "ssh-tunnel-spawn", {
        pid: tunnelChild.pid,
        listen: `${tunnelListenHost}:${tunnelListenPort}`,
        target: `${serveHost}:${servePort}`,
        authMode: evidence.authMode,
      });

      // Wait until tunnel TCP accepts (or ssh dies).
      yield* Effect.gen(function* () {
        for (let i = 0; i < 60; i++) {
          if (tunnelChild.exitCode !== null) {
            const errText = yield* Effect.promise(() =>
              NodeFSP.readFile(sshErrLog, "utf8").catch(() => ""),
            );
            return yield* Effect.fail(
              new Error(`ssh tunnel exited early code=${tunnelChild.exitCode}\n${errText}`),
            );
          }
          const tcpReady = yield* Effect.promise(
            () =>
              new Promise<boolean>((resolve) => {
                const socket = NodeNet.connect(
                  { host: tunnelListenHost, port: tunnelListenPort },
                  () => {
                    socket.end();
                    resolve(true);
                  },
                );
                socket.on("error", () => resolve(false));
                socket.setTimeout(400, () => {
                  socket.destroy();
                  resolve(false);
                });
              }),
          );
          if (tcpReady) {
            step(evidence, "ssh-tunnel-ready", { tcp: true });
            return;
          }
          yield* sleep(250);
        }
        const errText = yield* Effect.promise(() =>
          NodeFSP.readFile(sshErrLog, "utf8").catch(() => ""),
        );
        return yield* Effect.fail(new Error(`ssh tunnel ready timeout\n${errText}`));
      });
      yield* Effect.promise(() => sshErrHandle.close().catch(() => undefined));

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
        // Serve prints loopback pairing URL; client still reaches it only via tunnel port.
        // Rewrite host/port to tunnel listen endpoint so all HTTP/WS goes through the hop.
        const pairingParsed = new URL(pairingUrl);
        const tokenHash = pairingParsed.hash;
        const tunneledPairingUrl = `${httpBase}/pair${tokenHash}`;
        step(evidence, "pairing-url", {
          hasToken: tokenHash.includes("token="),
          servePrintedHost: pairingParsed.hostname,
          servePrintedPort: pairingParsed.port,
          clientViaTunnel: httpBase,
          tunneledPairingHost: tunnelListenHost,
          tunneledPairingPort: tunnelListenPort,
        });

        // Pairing credentials are single-use; exchange once and reuse the bearer.
        const pairingCredential = tokenHash.startsWith("#token=")
          ? decodeURIComponent(tokenHash.slice("#token=".length))
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
              client_label: "Code Work A7 Tunnel Forward Harness",
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
        step(evidence, "bearer-exchanged", {
          ok: true,
          viaTunnel: httpBase,
          notViaServePort: servePort,
          tunneledPairingUrlHasToken: tunneledPairingUrl.includes("#token="),
        });

        const envRes = yield* Effect.promise(() =>
          fetch(new URL("/.well-known/t3/environment", httpBase)).then(async (r) => ({
            status: r.status,
            json: (await r.json()) as { environmentId?: string },
          })),
        );
        evidence.environmentId = envRes.json.environmentId ?? null;
        step(evidence, "environment", {
          status: envRes.status,
          environmentId: evidence.environmentId,
          viaTunnel: true,
        });

        const withRpc = <A, E, R>(use: (rpc: ControlRpcClient) => Effect.Effect<A, E, R>) =>
          openControlClient({ serverUrl, accessToken }, use);

        // Explicit tunnel WS reconnect before orchestration scenarios.
        yield* withRpc((rpc) =>
          rpc[WS_METHODS.serverGetSettings]({}).pipe(
            Effect.map((settings) => {
              step(evidence, "ws-connected-via-tunnel", {
                hasSettings: settings !== null && typeof settings === "object",
                via: httpBase,
              });
            }),
          ),
        );
        yield* withRpc((rpc) =>
          rpc[WS_METHODS.serverGetSettings]({}).pipe(
            Effect.map(() => {
              step(evidence, "ws-reconnected-via-tunnel", { via: httpBase });
            }),
          ),
        );
        evidence.scenarios.sshTunnelWsReconnect = {
          ok: true,
          clientBase: httpBase,
          servePort,
          tunnelListenPort,
          authMode: evidence.authMode,
        };
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
        const projectId = ProjectId.make(`a7-ssh-${uuid()}`);
        const cursorModel = {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "default",
        } as const;

        yield* withRpc((rpc) =>
          Effect.gen(function* () {
            yield* setCursorBinary(rpc, approvalWrapper);
            yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "project.create",
              commandId: CommandId.make(uuid()),
              projectId,
              title: "A7 SSH Product Tunnel Isolate",
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
        yield* withRpc((rpc) =>
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
        step(evidence, "late-approval-opened", {
          threadId: lateThreadId,
          requestId: lateRequestId,
        });
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
        if (tunnelChild.pid) {
          yield* killPidTree(tunnelChild.pid);
          step(evidence, "ssh-tunnel-teardown", { pid: tunnelChild.pid });
        }
        if (child.pid) {
          yield* killPidTree(child.pid);
          step(evidence, "serve-teardown", { pid: child.pid });
        }
        yield* Effect.promise(() =>
          NodeFSP.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8"),
        );
      }
    }).pipe(TestClock.withLive, Effect.orDie),
  { timeout: 300_000 },
);
