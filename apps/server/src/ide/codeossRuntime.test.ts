// @effect-diagnostics nodeBuiltinImport:off - 验证开发服务与原生工作台的进程边界。
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { CodeossRuntime } from "./codeossRuntime.ts";
import { installCodeoss } from "./codeossInstall.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof NodeChildProcess>()),
  spawn: vi.fn(),
}));
vi.mock("./codeossInstall.ts", async (original) => ({
  ...(await original<typeof import("./codeossInstall.ts")>()),
  installCodeoss: vi.fn(async () => NodeOS.tmpdir()),
}));

it("开发监控标记不进入原生 IPC，其他工作区环境仍保留", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-ide-env-"));
  const runtime = new CodeossRuntime(root, "win32", "x64");
  const child = new NodeChildProcess.ChildProcess();
  child.stdout = new NodeStream.PassThrough();
  vi.stubEnv("WATCH_REPORT_DEPENDENCIES", "1");
  vi.stubEnv("CODEWORK_IDE_ENV_TEST", "preserved");
  vi.mocked(NodeChildProcess.spawn).mockImplementation(() => {
    queueMicrotask(() =>
      child.stdout?.emit("data", Buffer.from("Extension host agent listening on 12345")),
    );
    return child;
  });
  try {
    await runtime.open("test", "test-ticket", root);
    await runtime.sessions.get("test")?.ready;
    expect(runtime.sessions.get("test")?.state.phase).toBe("ready");
    expect(NodeChildProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ CODEWORK_IDE_ENV_TEST: "preserved" }),
      }),
    );
    const options = vi.mocked(NodeChildProcess.spawn).mock.calls[0]?.[2];
    expect(options?.env?.WATCH_REPORT_DEPENDENCIES).toBeFalsy();
    expect(process.env.WATCH_REPORT_DEPENDENCIES).toBe("1");
  } finally {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await runtime.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("REH 退出后 retry 关闭旧会话并以新 capability 重建", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-ide-env-"));
  const runtimeDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-ide-rt-"));
  await NodeFSP.writeFile(
    NodePath.join(runtimeDir, "product.json"),
    JSON.stringify({ commit: "c".repeat(40), version: "1.121.0", quality: "stable" }),
  );
  const runtime = new CodeossRuntime(root, "win32", "x64");
  const children: NodeChildProcess.ChildProcess[] = [];
  vi.mocked(NodeChildProcess.spawn).mockImplementation(() => {
    const child = new NodeChildProcess.ChildProcess();
    child.stdout = new NodeStream.PassThrough();
    children.push(child);
    queueMicrotask(() =>
      child.stdout?.emit("data", Buffer.from("Extension host agent listening on 12345")),
    );
    return child;
  });
  vi.mocked(installCodeoss).mockImplementation(async () => runtimeDir);
  try {
    await runtime.open("test", "ticket-1", root);
    await runtime.sessions.get("test")?.ready;
    const healthy = await runtime.open("test", "ticket-1", root);
    expect(healthy.phase).toBe("ready");
    const firstPath = healthy.connection?.webSocketPath;
    expect(firstPath).toMatch(/^\/api\/ide\/[0-9a-f]{64}\/$/);

    children[0]?.emit("exit", 137);
    await runtime.sessions.get("test")?.ready;
    expect(runtime.sessions.get("test")?.state.phase).toBe("error");

    const rebuilt = await runtime.open("test", "ticket-2", root, true);
    expect(rebuilt.phase).toBe("installing");
    await runtime.sessions.get("test")?.ready;
    const afterRebuild = await runtime.open("test", "ticket-2", root);
    expect(afterRebuild.phase).toBe("ready");
    expect(afterRebuild.connection?.webSocketPath).toBeDefined();
    expect(afterRebuild.connection?.webSocketPath).not.toBe(firstPath);
    expect(NodeChildProcess.spawn).toHaveBeenCalledTimes(2);
  } finally {
    vi.clearAllMocks();
    vi.mocked(installCodeoss).mockImplementation(async () => NodeOS.tmpdir());
    await runtime.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
    await NodeFSP.rm(runtimeDir, { recursive: true, force: true });
  }
});
