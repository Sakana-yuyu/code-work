// 从 ZCode 源码仓库刷新 vendored 运行时（apps/server/vendor/zcode/）。
//
// 用法：node scripts/vendor-zcode.mjs <ZCode 仓库路径> [--manifest-only]
//
// 流程：`pnpm install` → `turbo --cwd apps/zcode-cli run build`（产出
// `apps/zcode-cli/packages/cli/dist/zcode.cjs`）→ 拷贝 bundle、
// `provider/zcode-builtin.json`、LICENSE、NOTICE.md、THIRD-PARTY-NOTICES.md，
// 再写 `VERSION.json` 记录上游版本/提交，供服务端把"内置运行时是哪一版"显示给用户。
// ZCode 是 Apache-2.0；再分发必须保留这些声明文件。

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const args = process.argv.slice(2);
const manifestOnly = args.includes("--manifest-only");
const sourceRefIndex = args.indexOf("--source-ref");
const explicitSourceRef =
  sourceRefIndex >= 0 && args[sourceRefIndex + 1] !== undefined
    ? args[sourceRefIndex + 1].trim()
    : undefined;
const sourceRoot = args.find((arg, index) => {
  if (arg.startsWith("--")) return false;
  // `--source-ref` 的取值不是位置参数。
  return !(sourceRefIndex >= 0 && index === sourceRefIndex + 1);
});
if (!sourceRoot) {
  console.error(
    "usage: node scripts/vendor-zcode.mjs <path-to-zcode-checkout> " +
      "[--manifest-only] [--source-ref <branch|tarball|commit>]",
  );
  process.exit(1);
}
const repo = NodePath.resolve(process.cwd());
const zc = NodePath.resolve(sourceRoot);
const cliDist = NodePath.join(zc, "apps/zcode-cli/packages/cli/dist");
const vendor = NodePath.join(repo, "apps/server/vendor/zcode");

const run = (cmd, cmdArgs, cwd) => {
  const r = NodeChildProcess.spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const readJson = (filePath) => JSON.parse(NodeFS.readFileSync(filePath, "utf8"));

const gitOut = (cwd, args) =>
  NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).stdout?.trim() ||
  undefined;

/**
 * 源目录里的真实 commit。tarball 解包出来的上游目录**没有** `.git`，此时
 * `git -C <dir> rev-parse HEAD` 不会失败，而是继续向上找到外层仓库（也就是本仓库），
 * 于是清单里会写进一个和 ZCode 毫无关系的 commit。先确认 `--show-toplevel`
 * 就是源目录本身，否则宁可不写：清单里的每个字段都必须能被独立核对。
 */
const readUpstreamCommit = () => {
  const topLevel = gitOut(zc, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return {};
  const samePath = (a, b) =>
    NodePath.resolve(a).toLowerCase() === NodePath.resolve(b).toLowerCase();
  if (!samePath(topLevel, zc)) {
    console.warn(
      `[vendor-zcode] ${zc} 不在 git 工作树根（toplevel=${topLevel}），跳过 commit 记录`,
    );
    return {};
  }
  const commit = gitOut(zc, ["rev-parse", "HEAD"]);
  const commitDate = gitOut(zc, ["log", "-1", "--format=%cI"]);
  return { ...(commit ? { commit } : {}), ...(commitDate ? { commitDate } : {}) };
};

/**
 * 构建产物里的内置 Provider 配置体检。CLI 的 dist 可能混入 test 环境的配置叠加，
 * 表现为同一条规则出现两次；这种副本没有语义价值，却会让清单里的版本看起来
 * 比源码更新。这里只报警不回写——上游数据不该被本仓库悄悄改写。
 */
const checkBuiltinConfig = (builtinConfigPath) => {
  if (!NodeFS.existsSync(builtinConfigPath)) return undefined;
  const config = readJson(builtinConfigPath);
  const modelRules = config?.config?.modelConfigRules?.[0];
  const providerRules = config?.config?.providerConfigRules?.[0];
  for (const [label, entries] of [
    ["modelConfigRules.providerSiteRules", modelRules?.providerSiteRules],
    ["modelConfigRules.modelRules", modelRules?.modelRules],
    ["modelConfigRules.modelApiRules", modelRules?.modelApiRules],
    ["modelConfigRules.templateModelRules", modelRules?.templateModelRules],
    ["providerConfigRules.templateRules", providerRules?.templateRules],
    ["providerConfigRules.providerRules", providerRules?.providerRules],
  ]) {
    if (!Array.isArray(entries)) continue;
    const unique = new Set(entries.map((entry) => JSON.stringify(entry))).size;
    if (unique !== entries.length) {
      console.warn(
        `[vendor-zcode] ${label}: ${entries.length} 条里有 ${entries.length - unique} 条重复` +
          "（test 环境配置叠加的迹象，非源码内容）",
      );
    }
  }
  return config?.revision;
};

/**
 * 上游版本三元组：产品版本（仓库根）、CLI 版本、Built-in Provider 配置 revision。
 * `sourceRef` 用能独立核对的形态记录来源：git 工作树就写 `<toplevel>@<commit>`，
 * 否则要求调用方用 `--source-ref` 写明 tarball/分支，绝不猜。
 */
const readUpstreamVersion = () => {
  const productVersion = readJson(NodePath.join(zc, "package.json")).version;
  const cliVersion = readJson(NodePath.join(zc, "apps/zcode-cli/package.json")).version;
  const builtinConfigRevision = checkBuiltinConfig(
    NodePath.join(cliDist, "provider/zcode-builtin.json"),
  );
  const commit = readUpstreamCommit();
  const sourceRef =
    commit.commit === undefined
      ? explicitSourceRef
      : `${NodePath.basename(zc)}@${commit.commit}${commit.commitDate === undefined ? "" : ` (${commit.commitDate})`}`;
  return {
    schemaVersion: 1,
    productVersion,
    cliVersion,
    builtinConfigRevision,
    ...(sourceRef === undefined ? {} : { sourceRef }),
  };
};

const writeVersionManifest = () => {
  const upstream = readUpstreamVersion();
  const manifest = {
    ...upstream,
    vendoredAt: new Date().toISOString(),
  };
  NodeFS.writeFileSync(
    NodePath.join(vendor, "VERSION.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `[vendor-zcode] VERSION.json → ZCode ${manifest.productVersion} (cli ${manifest.cliVersion}, built-in revision ${manifest.builtinConfigRevision ?? "?"})`,
  );
  if (manifest.sourceRef === undefined) {
    console.log(
      "[vendor-zcode] 未记录 sourceRef：源目录不是 git 工作树根。请补 --source-ref " +
        "<branch|tarball|commit>，否则清单无法被独立核对。",
    );
  }
};

if (manifestOnly) {
  writeVersionManifest();
  console.log("[vendor-zcode] done (manifest only).");
  process.exit(0);
}

if (!NodeFS.existsSync(cliDist) || !NodeFS.existsSync(NodePath.join(cliDist, "zcode.cjs"))) {
  console.log("[vendor-zcode] pnpm install…");
  run("pnpm", ["install"], zc);
  console.log("[vendor-zcode] turbo build…");
  run("pnpm", ["exec", "turbo", "--skip-infer", "--cwd", "apps/zcode-cli", "run", "build"], zc);
}

if (!NodeFS.existsSync(NodePath.join(cliDist, "zcode.cjs"))) {
  console.error(`[vendor-zcode] ${cliDist}/zcode.cjs 未产出`);
  process.exit(1);
}

NodeFS.mkdirSync(NodePath.join(vendor, "provider"), { recursive: true });
for (const [from, to] of [
  [NodePath.join(cliDist, "zcode.cjs"), NodePath.join(vendor, "zcode.cjs")],
  [
    NodePath.join(cliDist, "provider/zcode-builtin.json"),
    NodePath.join(vendor, "provider/zcode-builtin.json"),
  ],
  [
    NodePath.join(cliDist, "THIRD-PARTY-NOTICES.md"),
    NodePath.join(vendor, "THIRD-PARTY-NOTICES.md"),
  ],
  [NodePath.join(zc, "LICENSE"), NodePath.join(vendor, "LICENSE")],
  [NodePath.join(zc, "NOTICE.md"), NodePath.join(vendor, "NOTICE.md")],
]) {
  if (!NodeFS.existsSync(from)) {
    console.error(`[vendor-zcode] 缺少 ${from}`);
    process.exit(1);
  }
  NodeFS.copyFileSync(from, to);
  console.log(`[vendor-zcode] ${from} -> ${to}`);
}
writeVersionManifest();
console.log("[vendor-zcode] done.");
