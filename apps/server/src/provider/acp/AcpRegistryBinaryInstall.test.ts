// @effect-diagnostics nodeBuiltinImport:off - 本机 HTTP 与文件夹具验证原生流式下载和解包副作用。
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { acpArchiveFormat } from "./AcpRegistryCatalog.ts";
import { installAcpRegistryBinary } from "./AcpRegistryBinaryInstall.ts";
import { resolveTarExecutable } from "../../ide/codeossInstall.ts";

describe("AcpRegistryBinaryInstall", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true })));
  });

  it("识别官方归档格式，拒绝未知扩展名", () => {
    expect(acpArchiveFormat("https://example.com/agent.zip", "agent.exe")).toBe("zip");
    expect(acpArchiveFormat("https://example.com/agent.tar.gz", "./agent")).toBe("tar");
    expect(acpArchiveFormat("https://example.com/agent.exe", "agent.exe")).toBe("raw");
    expect(acpArchiveFormat("https://example.com/agent.bin", "./agent")).toBeNull();
  });

  it("下载 raw 官方二进制、校验 sha256 并复用已安装目录", async () => {
    const payload = Buffer.from("codework-acp-binary-fixture\n");
    const sha256 = NodeCrypto.createHash("sha256").update(payload).digest("hex");
    const server = NodeHttp.createServer((request, response) => {
      if (request.url !== "/tool.exe") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少监听端口");
    // fetch 走本地 HTTP：用临时改写的真实可下载 URL（https 校验在目录层，安装层接受传入的 distribution）。
    const httpUrl = `http://127.0.0.1:${address.port}/tool.exe`;
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-acp-install-"));
    roots.push(root);
    try {
      const first = await installAcpRegistryBinary({
        root,
        entryId: "fixture-agent",
        version: "1.0.0",
        distribution: {
          platform: "windows-x86_64",
          archiveUrl: httpUrl,
          sha256,
          cmd: "tool.exe",
          args: ["--acp"],
        },
        platform: "win32",
        signal: AbortSignal.timeout(30_000),
      });
      const commandFile = /^"([^"]+)" --acp$/.exec(first.command)?.[1];
      expect(commandFile).toBeTruthy();
      expect(await NodeFSP.readFile(commandFile!, "utf8")).toBe("codework-acp-binary-fixture\n");
      const second = await installAcpRegistryBinary({
        root,
        entryId: "fixture-agent",
        version: "1.0.0",
        distribution: {
          platform: "windows-x86_64",
          archiveUrl: httpUrl,
          sha256,
          cmd: "tool.exe",
          args: ["--acp"],
        },
        platform: "win32",
        signal: AbortSignal.timeout(30_000),
      });
      expect(second.installPath).toBe(first.installPath);
      expect(second.command).toBe(first.command);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("sha256 不一致时拒绝安装", async () => {
    const payload = Buffer.from("tampered\n");
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200);
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少监听端口");
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-acp-badhash-"));
    roots.push(root);
    try {
      await expect(
        installAcpRegistryBinary({
          root,
          entryId: "bad-hash",
          version: "1.0.0",
          distribution: {
            platform: "windows-x86_64",
            archiveUrl: `http://127.0.0.1:${address.port}/tool.exe`,
            sha256: "0".repeat(64),
            cmd: "tool.exe",
            args: [],
          },
          platform: "win32",
          signal: AbortSignal.timeout(30_000),
        }),
      ).rejects.toMatchObject({ code: "checksum-mismatch" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("损坏的已安装目录不能被重新下载静默删除", async () => {
    const payload = Buffer.from("cache-fixture\n");
    const sha256 = NodeCrypto.createHash("sha256").update(payload).digest("hex");
    const server = NodeHttp.createServer((_request, response) => response.end(payload));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少监听端口");
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-acp-cache-"));
    roots.push(root);
    const input = {
      root,
      entryId: "cache-agent",
      version: "1.0.0",
      distribution: {
        platform: "windows-x86_64",
        archiveUrl: `http://127.0.0.1:${address.port}/tool.exe`,
        sha256,
        cmd: "tool.exe",
        args: [],
      },
      platform: "win32" as const,
      signal: AbortSignal.timeout(30000),
    };
    try {
      const installed = await installAcpRegistryBinary(input);
      const retained = NodePath.join(installed.installPath, "retained.txt");
      await NodeFSP.writeFile(retained, "原内容必须保留");
      await NodeFSP.unlink(NodePath.join(installed.installPath, "tool.exe"));
      await expect(installAcpRegistryBinary(input)).rejects.toMatchObject({
        code: "extract-failed",
      });
      expect(await NodeFSP.readFile(retained, "utf8")).toBe("原内容必须保留");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("目录 ID 越界时在下载和写入之前拒绝", async () => {
    const workspace = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "codework-acp-boundary-"),
    );
    roots.push(workspace);
    const root = NodePath.join(workspace, "managed");
    await NodeFSP.mkdir(root);
    await expect(
      installAcpRegistryBinary({
        root,
        entryId: "../outside",
        version: "1.0.0",
        distribution: {
          platform: "windows-x86_64",
          archiveUrl: "http://127.0.0.1:1/tool.exe",
          sha256: "0".repeat(64),
          cmd: "tool.exe",
          args: [],
        },
        platform: "win32",
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toMatchObject({ code: "not-downloadable" });
    expect(await NodeFSP.readdir(workspace)).toEqual(["managed"]);
  });

  it("两个下载同时到达时原子发布同一安装并清理各自临时目录", async () => {
    const payload = Buffer.from("concurrent-fixture\n");
    const responses: NodeHttp.ServerResponse[] = [];
    const server = NodeHttp.createServer((_request, response) => {
      responses.push(response);
      if (responses.length === 2) for (const pending of responses) pending.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少监听端口");
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-acp-concurrent-"));
    roots.push(root);
    const input = {
      root,
      entryId: "concurrent-agent",
      version: "1.0.0",
      distribution: {
        platform: "windows-x86_64",
        archiveUrl: `http://127.0.0.1:${address.port}/tool.exe`,
        sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
        cmd: "tool.exe",
        args: [],
      },
      platform: "win32" as const,
      signal: AbortSignal.timeout(30000),
    };
    try {
      const [first, second] = await Promise.all([
        installAcpRegistryBinary(input),
        installAcpRegistryBinary(input),
      ]);
      expect(first).toEqual(second);
      expect(responses).toHaveLength(2);
      expect(await NodeFSP.readFile(NodePath.join(first.installPath, "tool.exe"), "utf8")).toBe(
        payload.toString(),
      );
      expect(
        (await NodeFSP.readdir(NodePath.dirname(first.installPath))).filter((name) =>
          name.startsWith(".install-"),
        ),
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("校验真实 tar.gz 归档后解包并解析嵌套启动路径", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-acp-archive-"));
    roots.push(root);
    const fixture = NodePath.join(root, "input");
    await NodeFSP.mkdir(NodePath.join(fixture, "package"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(fixture, "package", "tool.exe"), "archive-fixture\n");
    const archive = NodePath.join(root, "fixture.tar.gz");
    NodeChildProcess.execFileSync(
      resolveTarExecutable(),
      ["-czf", archive, "-C", fixture, "package"],
      { windowsHide: true, timeout: 10000 },
    );
    const payload = await NodeFSP.readFile(archive);
    const server = NodeHttp.createServer((_request, response) => response.end(payload));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少监听端口");
    try {
      const installed = await installAcpRegistryBinary({
        root: NodePath.join(root, "managed"),
        entryId: "archive-agent",
        version: "1.0.0",
        distribution: {
          platform: "windows-x86_64",
          archiveUrl: `http://127.0.0.1:${address.port}/tool.tar.gz`,
          sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
          cmd: "package/tool.exe",
          args: [],
        },
        platform: "win32",
        signal: AbortSignal.timeout(30000),
      });
      expect(
        await NodeFSP.readFile(NodePath.join(installed.installPath, "package", "tool.exe"), "utf8"),
      ).toBe("archive-fixture\n");
      expect(installed.command).toBe(
        `"${NodePath.join(installed.installPath, "package", "tool.exe")}"`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
