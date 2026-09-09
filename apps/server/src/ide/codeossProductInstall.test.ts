// @effect-diagnostics nodeBuiltinImport:off - 用最小发行包验证实际安装与缓存迁移，不访问网络。
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { installCodeoss, resolveTarExecutable, runCodeossCommand } from "./codeossInstall.ts";
import { CODEOSS_VERSION } from "./codeossRelease.ts";
import { CODEOSS_CHAT_MANIFEST } from "./codeossChatExtension.ts";

it("迁移旧运行包缓存，保留扩展卸载所需元数据并移除死菜单", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-product-install-"));
  const source = NodePath.join(root, "source");
  const defaults = { extensionId: "GitHub.copilot", chatExtensionId: "GitHub.copilot-chat" };
  const library = NodePath.join(source, "extensions/node_modules/typescript");
  try {
    await NodeFSP.mkdir(NodePath.join(source, "out"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "out/server-main.js"), "// REH 测试入口");
    await NodeFSP.writeFile(
      NodePath.join(source, "product.json"),
      JSON.stringify({ defaultChatAgent: defaults }),
    );
    await NodeFSP.mkdir(NodePath.join(library, "lib"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(library, "lib/tsserver.js"), "// 测试 SDK");
    await NodeFSP.writeFile(
      NodePath.join(library, "codework-typescript.json"),
      JSON.stringify({
        version: "6.0.3",
        sha256: "33cd0ee1beaa8c9e9d15a9da836c62ddea4c34a42d7c2d349dbc80d94165d22a",
      }),
    );
    const archive = NodePath.join(root, "runtime.tgz");
    await runCodeossCommand(resolveTarExecutable(), ["-czf", archive, "-C", source, "."], {
      windowsHide: true,
    });
    const bytes = await NodeFSP.readFile(archive);
    const release = {
      target: "win32-x64",
      url: "https://example.invalid/runtime.tgz",
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
    const old = NodePath.join(root, "runtimes", `${CODEOSS_VERSION}-${release.target}-3`);
    await NodeFSP.mkdir(NodePath.join(old, "out"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(old, "out/server-main.js"), "旧会话仍可使用");
    await NodeFSP.writeFile(
      NodePath.join(old, "codework-install.json"),
      JSON.stringify({ sha256: release.sha256 }),
    );
    const download = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url !== release.url) throw new Error("测试不允许访问额外下载地址");
      return new Response(bytes);
    });
    const installed = await installCodeoss(root, new AbortController().signal, release);
    expect(installed).not.toBe(old);
    const product = JSON.parse(
      await NodeFSP.readFile(NodePath.join(installed, "product.json"), "utf8"),
    );
    expect(product.defaultChatAgent).toEqual(defaults);
    expect(product.nameShort).toBe("Code Work IDE");
    expect(
      JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(installed, "extensions/codework-chat-bridge/package.json"),
          "utf8",
        ),
      ),
    ).toEqual(CODEOSS_CHAT_MANIFEST);
    expect(CODEOSS_CHAT_MANIFEST).not.toHaveProperty("contributes");
    expect(await NodeFSP.readFile(NodePath.join(old, "out/server-main.js"), "utf8")).toBe(
      "旧会话仍可使用",
    );
    expect(await installCodeoss(root, new AbortController().signal, release)).toBe(installed);
    expect(download).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
