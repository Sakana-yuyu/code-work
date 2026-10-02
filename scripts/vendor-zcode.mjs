// 从 ZCode 源码仓库刷新 vendored 运行时（apps/server/vendor/zcode/）。
//
// 用法：node scripts/vendor-zcode.mjs <ZCode 仓库路径>
//
// 流程：`pnpm install` → `turbo --cwd apps/zcode-cli run build`（产出
// `apps/zcode-cli/packages/cli/dist/zcode.cjs`）→ 拷贝 bundle、
// `provider/zcode-builtin.json`、LICENSE、NOTICE.md、THIRD-PARTY-NOTICES.md。
// ZCode 是 Apache-2.0；再分发必须保留这些声明文件。

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const sourceRoot = process.argv[2];
if (!sourceRoot) {
  console.error("usage: node scripts/vendor-zcode.mjs <path-to-zcode-checkout>");
  process.exit(1);
}
const repo = NodePath.resolve(process.cwd());
const zc = NodePath.resolve(sourceRoot);
const cliDist = NodePath.join(zc, "apps/zcode-cli/packages/cli/dist");
const vendor = NodePath.join(repo, "apps/server/vendor/zcode");

const run = (cmd, args, cwd) => {
  const r = NodeChildProcess.spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

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
  NodeFS.cpSync(from, to);
  console.log(`[vendor-zcode] ${from} -> ${to}`);
}
console.log("[vendor-zcode] done.");
