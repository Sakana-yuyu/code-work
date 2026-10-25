// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - 管理上游 Node 进程、启动输出和系统进程树。
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { IdeOpenResult } from "@codework/contracts";

import { installCodeoss, runCodeossCommand } from "./codeossInstall.ts";
import { codeossRelease } from "./codeossRelease.ts";

export interface IdeRuntimeSession {
  id: string;
  capability: string;
  authTicket: string;
  state: IdeOpenResult;
  process?: NodeChildProcess.ChildProcess;
  port?: number;
  ready?: Promise<void>;
}

interface CodeossProduct {
  commit: string;
  version: string;
  quality: string;
}

export function codeossFolderPath(cwd: string) {
  return decodeURIComponent(NodeURL.pathToFileURL(cwd).pathname);
}

export class CodeossRuntime {
  readonly sessions = new Map<string, IdeRuntimeSession>();
  private readonly abort = new AbortController();
  private installation: Promise<string> | undefined;
  private product: Promise<CodeossProduct> | undefined;
  readonly root: string;
  readonly platform: string;
  readonly arch: string;

  constructor(root: string, platform: string, arch: string) {
    this.root = root;
    this.platform = platform;
    this.arch = arch;
  }

  private async resolveProduct(): Promise<CodeossProduct> {
    this.installation ??= installCodeoss(
      this.root,
      this.abort.signal,
      codeossRelease(this.platform, this.arch),
    ).catch((error) => {
      this.installation = undefined;
      throw error;
    });
    this.product ??= this.installation
      .then((runtime) =>
        NodeFSP.readFile(NodePath.join(runtime, "product.json"), "utf8").then((raw) => {
          const parsed = JSON.parse(raw) as { commit?: string; version?: string; quality?: string };
          if (!parsed.commit || !parsed.version || !parsed.quality)
            throw new Error("Code-OSS 运行包缺少版本标识，无法建立远程连接。");
          return { commit: parsed.commit, version: parsed.version, quality: parsed.quality };
        }),
      )
      .catch((error) => {
        this.product = undefined;
        throw error;
      });
    return this.product;
  }

  async open(id: string, authTicket: string, cwd: string, retry = false): Promise<IdeOpenResult> {
    if (!NodePath.isAbsolute(cwd) || !(await NodeFSP.stat(cwd)).isDirectory())
      throw new Error("请选择有效的项目目录。");
    let session = this.sessions.get(id);
    if (session?.state.phase === "error" && retry) {
      await this.close(id);
      session = undefined;
    }
    if (!session) {
      session = {
        id,
        capability: NodeCrypto.randomBytes(32).toString("hex"),
        authTicket,
        state: { phase: "installing", message: "正在准备 Code-OSS 工作台和扩展宿主…" },
      };
      this.sessions.set(id, session);
      const startingSession = session;
      session.ready = this.start(session).catch((error: unknown) => {
        startingSession.state = {
          phase: "error",
          message: error instanceof Error ? error.message : "IDE 启动失败。",
        };
      });
    }
    session.authTicket = authTicket;
    if (session.state.phase !== "ready") return session.state;
    const product = await this.resolveProduct();
    return {
      ...session.state,
      relativeUrl: `/api/ide/${session.capability}/?folder=${encodeURIComponent(codeossFolderPath(cwd))}`,
      connection: {
        webSocketPath: `/api/ide/${session.capability}/`,
        folderPath: codeossFolderPath(cwd),
        commit: product.commit,
        version: product.version,
        quality: product.quality,
      },
    };
  }

  find(capability: string) {
    return [...this.sessions.values()].find(
      (session) => session.capability === capability && session.state.phase === "ready",
    );
  }

  private async start(session: IdeRuntimeSession) {
    this.installation ??= installCodeoss(
      this.root,
      this.abort.signal,
      codeossRelease(this.platform, this.arch),
    ).catch((error) => {
      this.installation = undefined;
      throw error;
    });
    const runtime = await this.installation;
    if (this.abort.signal.aborted || this.sessions.get(session.id) !== session) return;
    session.state = { phase: "starting", message: "正在启动 Code-OSS 工作台…" };
    const profile = NodePath.join(
      this.root,
      "profiles",
      NodeCrypto.createHash("sha256").update(session.id).digest("hex"),
    );
    await NodeFSP.mkdir(profile, { recursive: true });
    const secret = NodePath.join(profile, "connection-token");
    await NodeFSP.writeFile(secret, session.capability, { mode: 0o600 });
    if (this.abort.signal.aborted || this.sessions.get(session.id) !== session) return;
    const executable = NodePath.join(runtime, this.platform === "win32" ? "node.exe" : "node");
    const child = NodeChildProcess.spawn(
      executable,
      [
        NodePath.join(runtime, "out/server-main.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--server-base-path",
        `/api/ide/${session.capability}`,
        "--connection-token-file",
        secret,
        "--server-data-dir",
        profile,
        "--extensions-dir",
        NodePath.join(this.root, "extensions"),
        "--disable-telemetry",
        "--disable-experiments",
        "--disable-websocket-compression",
        "--disable-extension",
        "GitHub.copilot",
        "--disable-extension",
        "GitHub.copilot-chat",
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // node --watch 的依赖上报会向扩展子进程的原生 IPC 混入对象消息。
          WATCH_REPORT_DEPENDENCIES: undefined,
          VSCODE_AGENT_FOLDER: profile,
        },
      },
    );
    session.process = child;
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => {
        void this.stopChild(child);
        reject(new Error("Code-OSS 启动超时，请重试。"));
      }, 60_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const match = /Extension host agent listening on (\d+)/.exec(output);
        if (match) {
          session.port = Number(match[1]);
          finish();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", () => finish(new Error("无法启动 Code-OSS 运行时。")));
      child.once("exit", (code) => {
        session.state = {
          phase: "error",
          message: `Code-OSS 已退出（${code ?? "signal"}），可重试启动。`,
        };
        finish(new Error(session.state.message));
      });
    });
    if (this.sessions.get(session.id) !== session) {
      await this.stopChild(child);
      return;
    }
    session.state = { phase: "ready", message: "Code-OSS 已就绪" };
  }

  private async stopChild(child: NodeChildProcess.ChildProcess) {
    if (child.exitCode !== null || !child.pid) return;
    if (this.platform === "win32") {
      // 只终止本实例捕获的 PID 及其扩展/终端子进程。
      await runCodeossCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => {});
    } else child.kill("SIGTERM");
  }

  async close(id: string) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session?.process) await this.stopChild(session.process);
  }

  async dispose() {
    this.abort.abort();
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
