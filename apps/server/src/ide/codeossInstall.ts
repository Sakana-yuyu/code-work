// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - 原生运行包的流式下载、校验和解包边界。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import { CODEOSS_VERSION, codeossRelease } from "./codeossRelease.ts";
import { CODEOSS_CHAT_EXTENSION, CODEOSS_CHAT_MANIFEST } from "./codeossChatExtension.ts";

export const runCodeossCommand = NodeUtil.promisify(NodeChildProcess.execFile);
// 4：保留扩展卸载所需产品元数据，并更新已移除无效发送菜单的桥接扩展。
// 独立运行包目录让旧会话继续使用原版本，不在运行中覆盖其文件。
const PATCH_REVISION = 4;

// VSCodium REH 包为瘦身不含 typescript 库；typescript-language-features 固定在
// `extensions/node_modules/typescript` 解析内置 tsserver，缺库时扩展激活后起不了
// 语言服务（无诊断/补全）。安装期从 npm registry 供库并落独立 marker，与运行包
// 更新互不绑定。
const TYPESCRIPT_VERSION = "6.0.3";
const TYPESCRIPT_SHA256 = "33cd0ee1beaa8c9e9d15a9da836c62ddea4c34a42d7c2d349dbc80d94165d22a";

export function typescriptLibUrl(version: string = TYPESCRIPT_VERSION): string {
  return `https://registry.npmjs.org/typescript/-/typescript-${version}.tgz`;
}

export async function placeTypeScriptLibrary(
  archive: string,
  installRoot: string,
  expectedSha256: string,
  version: string = TYPESCRIPT_VERSION,
) {
  await verifyCodeossArchive(archive, expectedSha256);
  const nodeModules = NodePath.join(installRoot, "extensions", "node_modules");
  const staging = NodePath.join(nodeModules, `.ts-lib-${NodeCrypto.randomUUID()}`);
  await NodeFSP.mkdir(staging, { recursive: true });
  try {
    await runCodeossCommand(resolveTarExecutable(), ["-xzf", archive, "-C", staging], {
      windowsHide: true,
    });
    const destination = NodePath.join(nodeModules, "typescript");
    await NodeFSP.rm(destination, { recursive: true, force: true });
    await NodeFSP.rename(NodePath.join(staging, "package"), destination);
    await NodeFSP.writeFile(
      NodePath.join(destination, "codework-typescript.json"),
      JSON.stringify({ version, sha256: expectedSha256 }),
    );
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

export async function supplyTypeScriptLibrary(installRoot: string, signal: AbortSignal) {
  const destination = NodePath.join(installRoot, "extensions", "node_modules", "typescript");
  const marker = NodePath.join(destination, "codework-typescript.json");
  try {
    const saved = JSON.parse(await NodeFSP.readFile(marker, "utf8"));
    if (
      saved.version === TYPESCRIPT_VERSION &&
      saved.sha256 === TYPESCRIPT_SHA256 &&
      (await NodeFSP.stat(NodePath.join(destination, "lib", "tsserver.js"))).isFile()
    ) {
      return;
    }
  } catch {
    // 首次供给或 marker 损坏：走完整下载。
  }
  const temporary = NodePath.join(
    NodePath.dirname(destination),
    `.ts-download-${NodeCrypto.randomUUID()}`,
  );
  await NodeFSP.mkdir(temporary, { recursive: true });
  try {
    const archive = NodePath.join(temporary, "typescript.tgz");
    const response = await fetch(typescriptLibUrl(), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    });
    if (!response.ok || !response.body)
      throw new Error(`typescript 库下载失败（HTTP ${response.status}）。`);
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      NodeFS.createWriteStream(archive),
      { signal },
    );
    await placeTypeScriptLibrary(archive, installRoot, TYPESCRIPT_SHA256);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

// PATH 里的 MSYS tar 会把 "C:\..." 当作远程主机；Windows 10+ 自带的 bsdtar 没有
// 这个歧义，优先固定使用它，避免安装成败取决于启动 shell。
export function resolveTarExecutable(): string {
  if (process.platform !== "win32") return "tar";
  const systemTar = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return NodeFS.existsSync(systemTar) ? systemTar : "tar";
}

export async function verifyCodeossArchive(file: string, sha256: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== sha256) throw new Error("Code-OSS 下载校验失败，请重试。");
}

export async function installCodeoss(
  root: string,
  signal: AbortSignal,
  release: ReturnType<typeof codeossRelease>,
) {
  const parent = NodePath.join(root, "runtimes");
  const destination = NodePath.join(
    parent,
    `${CODEOSS_VERSION}-${release.target}-${PATCH_REVISION}`,
  );
  const marker = NodePath.join(destination, "codework-install.json");
  const installed = async () => {
    try {
      const saved = JSON.parse(await NodeFSP.readFile(marker, "utf8"));
      return (
        saved.sha256 === release.sha256 &&
        (await NodeFSP.stat(NodePath.join(destination, "out/server-main.js"))).isFile()
      );
    } catch {
      return false;
    }
  };
  if (await installed()) {
    // 既有安装只补库，不因 registry 暂时不可达而拖垮已可用的会话。
    try {
      await supplyTypeScriptLibrary(destination, signal);
    } catch {
      // 语言服务降级为无 tsserver；下次会话再试。
    }
    return destination;
  }
  await NodeFSP.mkdir(parent, { recursive: true });
  const temporary = NodePath.join(parent, `.install-${NodeCrypto.randomUUID()}`);
  await NodeFSP.mkdir(temporary);
  try {
    const archive = NodePath.join(temporary, "runtime.tar.gz");
    const response = await fetch(release.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
    });
    if (!response.ok || !response.body)
      throw new Error(`Code-OSS 下载失败（HTTP ${response.status}）。`);
    let bytes = 0;
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      new NodeStream.Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > 400 * 1024 * 1024 ? new Error("Code-OSS 运行包超出大小限制。") : null,
            chunk,
          );
        },
      }),
      NodeFS.createWriteStream(archive),
      { signal },
    );
    await verifyCodeossArchive(archive, release.sha256);
    const extracted = NodePath.join(temporary, "runtime");
    await NodeFSP.mkdir(extracted);
    await runCodeossCommand(resolveTarExecutable(), ["-xzf", archive, "-C", extracted], {
      windowsHide: true,
      signal,
    });
    const productPath = NodePath.join(extracted, "product.json");
    const product = JSON.parse(await NodeFSP.readFile(productPath, "utf8"));
    // 上游扩展卸载服务仍读取 defaultChatAgent；禁用 Agent 由启动参数控制。
    product.nameShort = "Code Work IDE";
    product.nameLong = "Code Work IDE";
    await NodeFSP.writeFile(productPath, JSON.stringify(product, null, 2) + "\n");
    const chatExtension = NodePath.join(extracted, "extensions/codework-chat-bridge");
    await NodeFSP.mkdir(chatExtension);
    await NodeFSP.writeFile(
      NodePath.join(chatExtension, "package.json"),
      JSON.stringify(CODEOSS_CHAT_MANIFEST),
    );
    await NodeFSP.writeFile(NodePath.join(chatExtension, "extension.cjs"), CODEOSS_CHAT_EXTENSION);
    await NodeFSP.writeFile(
      NodePath.join(extracted, "codework-install.json"),
      JSON.stringify({ version: CODEOSS_VERSION, sha256: release.sha256, patch: PATCH_REVISION }),
    );
    try {
      await NodeFSP.rename(extracted, destination);
    } catch (error) {
      if (!(await installed())) throw error;
    }
    // 全新安装属完整装配的一部分：库缺失等于语言服务不可用，失败要显式暴露。
    await supplyTypeScriptLibrary(destination, signal);
    return destination;
  } finally {
    // temporary 是本次创建的绝对目录，不清理其他运行包或用户数据。
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
