// @effect-diagnostics nodeBuiltinImport:off - 通过原生 tar 与临时目录验证安装边界。
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import {
  placeTypeScriptLibrary,
  resolveTarExecutable,
  supplyTypeScriptLibrary,
  typescriptLibUrl,
} from "./codeossInstall.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function createFakeTypescriptTarball(
  dir: string,
): Promise<{ archive: string; sha256: string }> {
  const source = NodePath.join(dir, "package");
  await NodeFSP.mkdir(NodePath.join(source, "lib"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(source, "package.json"),
    JSON.stringify({ name: "typescript", version: "6.0.3" }),
  );
  await NodeFSP.writeFile(NodePath.join(source, "lib", "tsserver.js"), "// tsserver entry");
  await NodeFSP.writeFile(NodePath.join(source, "lib", "typescript.js"), "// compiler");
  const archive = NodePath.join(dir, "typescript.tgz");
  await execFile(resolveTarExecutable(), ["-czf", archive, "package"], {
    cwd: dir,
    windowsHide: true,
  });
  const sha256 = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(archive))
    .digest("hex");
  return { archive, sha256 };
}

it("typescript 库 URL 固定在 npm registry 的版本化 tgz", () => {
  expect(typescriptLibUrl()).toBe("https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz");
});

it("placeTypeScriptLibrary 解包到 extensions/node_modules/typescript 并写 marker", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-ts-lib-"));
  const installRoot = NodePath.join(root, "runtimes", "x");
  const { archive, sha256 } = await createFakeTypescriptTarball(root);
  try {
    await placeTypeScriptLibrary(archive, installRoot, sha256);
    const destination = NodePath.join(installRoot, "extensions", "node_modules", "typescript");
    expect((await NodeFSP.stat(NodePath.join(destination, "lib", "tsserver.js"))).isFile()).toBe(
      true,
    );
    expect(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(destination, "codework-typescript.json"), "utf8"),
      ),
    ).toEqual({ version: "6.0.3", sha256 });
    // staging 目录不残留
    expect(await NodeFSP.readdir(NodePath.join(installRoot, "extensions", "node_modules"))).toEqual(
      ["typescript"],
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("placeTypeScriptLibrary 校验 sha256，不匹配时拒绝落位", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-ts-lib-"));
  const installRoot = NodePath.join(root, "runtimes", "x");
  const { archive } = await createFakeTypescriptTarball(root);
  try {
    await expect(placeTypeScriptLibrary(archive, installRoot, "0".repeat(64))).rejects.toThrow(
      /下载校验失败/,
    );
    // 校验不过不落任何东西
    const destination = NodePath.join(installRoot, "extensions", "node_modules", "typescript");
    expect(NodeFS.existsSync(destination)).toBe(false);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("supplyTypeScriptLibrary 在 marker 与 tsserver 齐备时跳过下载", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-ts-lib-"));
  const installRoot = NodePath.join(root, "runtimes", "x");
  const destination = NodePath.join(installRoot, "extensions", "node_modules", "typescript");
  await NodeFSP.mkdir(NodePath.join(destination, "lib"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(destination, "lib", "tsserver.js"), "// tsserver entry");
  const marker = {
    version: "6.0.3",
    sha256: "33cd0ee1beaa8c9e9d15a9da836c62ddea4c34a42d7c2d349dbc80d94165d22a",
  };
  await NodeFSP.writeFile(
    NodePath.join(destination, "codework-typescript.json"),
    JSON.stringify(marker),
  );
  try {
    // 未提供网络桩：若尝试下载会因无效 URL/无桩失败，这里以不抛错为通过。
    await supplyTypeScriptLibrary(installRoot, new AbortController().signal);
    expect(await NodeFSP.readdir(destination)).toContain("lib");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
