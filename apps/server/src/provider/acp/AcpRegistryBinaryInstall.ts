// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - 官方二进制的流式下载、校验和解包边界。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  AcpRegistryBinaryInstallError,
  type AcpRegistryBinaryDistribution,
  type AcpRegistryBinaryInstallErrorCode,
  type AcpRegistryBinaryInstallResult,
} from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../../config.ts";
import { resolveTarExecutable, runCodeossCommand } from "../../ide/codeossInstall.ts";
import { acpArchiveFormat, getAcpRegistryCatalog } from "./AcpRegistryCatalog.ts";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

class InstallFailure extends Error {
  readonly code: AcpRegistryBinaryInstallErrorCode;
  constructor(code: AcpRegistryBinaryInstallErrorCode, detail: string) {
    super(detail);
    this.code = code;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function isInside(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

async function resolveCommandFile(root: string, cmd: string): Promise<string | null> {
  const candidate = NodePath.resolve(root, cmd.replaceAll("\\", "/"));
  if (!isInside(root, candidate)) return null;
  try {
    const [realRoot, realCandidate] = await Promise.all([
      NodeFSP.realpath(root),
      NodeFSP.realpath(candidate),
    ]);
    if (!isInside(realRoot, realCandidate)) return null;
    return (await NodeFSP.stat(realCandidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function formatCommand(file: string, args: ReadonlyArray<string>): string {
  return [`"${file}"`, ...args].join(" ");
}

export interface InstallAcpRegistryBinaryInput {
  readonly root: string;
  readonly entryId: string;
  readonly version: string | null;
  readonly distribution: AcpRegistryBinaryDistribution;
  readonly platform: NodeJS.Platform;
  readonly signal: AbortSignal;
}

/**
 * 下载官方归档、校验 sha256 后解包到 `<root>/<entryId>/<version>-<platform>-<sha8>`。
 * 已安装且标记一致时直接复用；失败只清理本次临时目录。
 */
export async function installAcpRegistryBinary(
  input: InstallAcpRegistryBinaryInput,
): Promise<Omit<AcpRegistryBinaryInstallResult, "entryId" | "version">> {
  const { distribution } = input;
  const format = acpArchiveFormat(distribution.archiveUrl, distribution.cmd);
  if (format === null) throw new InstallFailure("not-downloadable", "不支持的归档格式。");
  const root = NodePath.resolve(input.root);
  let parent = NodePath.resolve(root, input.entryId);
  if (!NodePath.isAbsolute(input.root) || !isInside(root, parent))
    throw new InstallFailure("not-downloadable", "安装条目路径超出安装根目录。");
  await NodeFSP.mkdir(parent, { recursive: true });
  const [realRoot, realParent] = await Promise.all([
    NodeFSP.realpath(root),
    NodeFSP.realpath(parent),
  ]);
  if (!isInside(realRoot, realParent))
    throw new InstallFailure("not-downloadable", "安装条目实际路径超出安装根目录。");
  parent = realParent;
  const destination = NodePath.join(
    parent,
    `${(input.version ?? "unversioned").replace(/[^a-z0-9._-]/gi, "_")}-${distribution.platform}-${distribution.sha256.slice(0, 8)}`,
  );
  if (NodePath.dirname(destination) !== parent || !isInside(parent, destination))
    throw new InstallFailure("not-downloadable", "安装版本路径超出条目目录。");
  if (destination.includes('"')) throw new InstallFailure("extract-failed", "安装路径含引号。");
  const marker = NodePath.join(destination, "codework-install.json");
  const installed = async () => {
    try {
      const saved = JSON.parse(await NodeFSP.readFile(marker, "utf8"));
      if (saved.sha256 !== distribution.sha256) return null;
      return await resolveCommandFile(destination, distribution.cmd);
    } catch {
      return null;
    }
  };
  const existing = await installed();
  if (existing) {
    return { command: formatCommand(existing, distribution.args), installPath: destination };
  }

  const temporary = NodePath.join(parent, `.install-${NodeCrypto.randomUUID()}`);
  await NodeFSP.mkdir(temporary);
  try {
    const download = NodePath.join(temporary, "download");
    let response: Response;
    try {
      response = await fetch(distribution.archiveUrl, {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(600_000)]),
      });
    } catch (error) {
      throw new InstallFailure("download-failed", String(error));
    }
    if (!response.ok || !response.body) {
      throw new InstallFailure("download-failed", `HTTP ${response.status}`);
    }
    let bytes = 0;
    try {
      await NodeStreamPromises.pipeline(
        NodeStream.Readable.fromWeb(response.body),
        new NodeStream.Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > MAX_ARCHIVE_BYTES ? new Error("归档超出大小限制。") : null, chunk);
          },
        }),
        NodeFS.createWriteStream(download),
        { signal: input.signal },
      );
    } catch (error) {
      throw new InstallFailure("download-failed", String(error));
    }
    if ((await sha256File(download)) !== distribution.sha256) {
      throw new InstallFailure("checksum-mismatch", "下载内容与目录 sha256 不一致。");
    }

    const extracted = NodePath.join(temporary, "package");
    await NodeFSP.mkdir(extracted);
    try {
      if (format === "raw") {
        await NodeFSP.rename(
          download,
          NodePath.join(extracted, NodePath.posix.basename(distribution.cmd.replaceAll("\\", "/"))),
        );
      } else if (format === "zip" && input.platform === "linux") {
        // GNU tar 不读 zip；Windows/macOS 自带 bsdtar 可直接解 zip。
        await runCodeossCommand("unzip", ["-q", download, "-d", extracted], {
          windowsHide: true,
          signal: input.signal,
        });
      } else {
        await runCodeossCommand(resolveTarExecutable(), ["-xf", download, "-C", extracted], {
          windowsHide: true,
          signal: input.signal,
        });
      }
    } catch (error) {
      throw new InstallFailure("extract-failed", String(error));
    }
    const command = await resolveCommandFile(extracted, distribution.cmd);
    if (command === null) {
      throw new InstallFailure("command-missing", `归档内未找到 ${distribution.cmd}。`);
    }
    if (input.platform !== "win32") await NodeFSP.chmod(command, 0o755);
    await NodeFSP.writeFile(
      NodePath.join(extracted, "codework-install.json"),
      JSON.stringify({
        entryId: input.entryId,
        version: input.version,
        platform: distribution.platform,
        archiveUrl: distribution.archiveUrl,
        sha256: distribution.sha256,
        cmd: distribution.cmd,
      }),
    );
    // 只发布新目录；并发安装成功时复用，损坏缓存保留现场而非删除原内容。
    try {
      await NodeFSP.rename(extracted, destination);
    } catch (error) {
      if (!(await installed()))
        throw new InstallFailure(
          "extract-failed",
          `不能发布安装包，原安装目录保持不变：${String(error)}`,
        );
    }
    const final = await installed();
    if (final === null) throw new InstallFailure("command-missing", "安装后未找到启动文件。");
    return { command: formatCommand(final, distribution.args), installPath: destination };
  } finally {
    // temporary 是本次创建的绝对目录，不清理其他版本或用户数据。
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

/** 按 ID 重新解析服务端目录后安装，客户端提交的内容只用于查找条目。 */
export const installAcpRegistryCatalogBinary = (entryId: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const platform = yield* HostProcessPlatform;
    const catalog = yield* getAcpRegistryCatalog;
    const entry = catalog.entries.find((candidate) => candidate.id === entryId);
    const distribution = entry?.binaryDistribution;
    if (!entry || !distribution) {
      return yield* new AcpRegistryBinaryInstallError({
        code: "not-downloadable",
        detail: "当前平台没有带 sha256 的官方二进制分发。",
      });
    }
    const installed = yield* Effect.tryPromise({
      try: (signal) =>
        installAcpRegistryBinary({
          root: NodePath.join(config.baseDir, "acp-agents"),
          entryId: entry.id,
          version: entry.version,
          distribution,
          platform,
          signal,
        }),
      catch: (error) =>
        new AcpRegistryBinaryInstallError(
          error instanceof InstallFailure
            ? { code: error.code, detail: error.message }
            : { code: "extract-failed", detail: String(error) },
        ),
    });
    return { entryId: entry.id, version: entry.version, ...installed };
  });
