// @effect-diagnostics nodeBuiltinImport:off - 校验原生运行包和平台路径边界。
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, WS_METHODS } from "@codework/contracts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { codeossRelease, CODEOSS_COMMIT, CODEOSS_VERSION } from "./codeossRelease.ts";
import { verifyCodeossArchive } from "./codeossInstall.ts";
import { CodeossRuntime, codeossFolderPath } from "./codeossRuntime.ts";
import { parseCodeossPath } from "./codeossHttp.ts";

describe("Code-OSS 集成边界", () => {
  it("校验和不匹配时拒绝运行，匹配时才允许解包", async () => {
    const temporary = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "codework-codeoss-hash-"),
    );
    try {
      const file = NodePath.join(temporary, "archive");
      await NodeFSP.writeFile(file, "runtime");
      await expect(verifyCodeossArchive(file, "0".repeat(64))).rejects.toThrow("校验失败");
      await expect(
        verifyCodeossArchive(file, NodeCrypto.createHash("sha256").update("runtime").digest("hex")),
      ).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  });

  it("原生目录只编码一次，中文、空格和百分号可正确打开", () => {
    const cwd = NodePath.join(NodeOS.tmpdir(), "目录 A%20");
    expect(codeossFolderPath(cwd)).toContain("目录 A%20");
    expect(
      new URLSearchParams(`folder=${encodeURIComponent(codeossFolderPath(cwd))}`).get("folder"),
    ).toBe(codeossFolderPath(cwd));
  });

  it("IDE 入口需要操作权限且不能使用无效能力路径", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.ideOpen)).toBe(AuthOrchestrationOperateScope);
    expect(parseCodeossPath(`/api/ide/${"a".repeat(64)}/static/file.js`)).toBe("a".repeat(64));
    for (const path of [
      "/api/ide/abc/",
      `/api/ide/${"a".repeat(65)}/`,
      "https://attacker.test/api/ide/abc/",
    ])
      expect(parseCodeossPath(path)).toBeUndefined();
  });

  it("无效目录不启动后台进程，非就绪会话不可代理", async () => {
    const runtime = new CodeossRuntime(
      NodePath.join(NodeOS.tmpdir(), "unused-codeoss-test"),
      "win32",
      "x64",
    );
    await expect(runtime.open("session", "ticket", "relative/path")).rejects.toThrow();
    expect(runtime.sessions.size).toBe(0);
    expect(runtime.find("missing")).toBeUndefined();
    await runtime.dispose();
  });

  it("支持的平台均有固定校验值，未验证平台明确拒绝", () => {
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["darwin", "arm64"],
    ] as const) {
      expect(codeossRelease(platform, arch).sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(() => codeossRelease("win32", "arm64")).toThrow("已验证运行包");
  });

  it("扩展宿主与 @codingame/monaco-vscode-api 33.0.9（VS Code 1.121.0）保持同一基线", () => {
    expect(CODEOSS_VERSION).toMatch(/^1\.121\./);
    expect(CODEOSS_COMMIT).toMatch(/^[a-f0-9]{40}$/);
  });
});
