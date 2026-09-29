// 从 ZCode 源码仓库刷新 vendored 运行时（apps/server/vendor/zcode/）。
//
// 用法：node scripts/vendor-zcode.mjs <ZCode 仓库路径>
//
// 流程：`pnpm install` → `turbo --cwd apps/zcode-cli run build`（产出
// `apps/zcode-cli/packages/cli/dist/zcode.cjs`）→ 拷贝 bundle、
// `provider/zcode-builtin.json`、LICENSE、NOTICE.md、THIRD-PARTY-NOTICES.md。
// ZCode 是 Apache-2.0；再分发必须保留这些声明文件。

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = process.argv[2];
if (!sourceRoot) {
  console.error("usage: node scripts/vendor-zcode.mjs <path-to-zcode-checkout>");
  process.exit(1);
}
const repo = resolve(process.cwd());
const zc = resolve(sourceRoot);
const cliDist = join(zc, "apps/zcode-cli/packages/cli/dist");
const vendor = join(repo, "apps/server/vendor/zcode");

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(cliDist) || !existsSync(join(cliDist, "zcode.cjs"))) {
  console.log("[vendor-zcode] pnpm install…");
  run("pnpm", ["install"], zc);
  console.log("[vendor-zcode] turbo build…");
  run("pnpm", ["exec", "turbo", "--skip-infer", "--cwd", "apps/zcode-cli", "run", "build"], zc);
}

if (!existsSync(join(cliDist, "zcode.cjs"))) {
  console.error(`[vendor-zcode] ${cliDist}/zcode.cjs 未产出`);
  process.exit(1);
}

mkdirSync(join(vendor, "provider"), { recursive: true });
for (const [from, to] of [
  [join(cliDist, "zcode.cjs"), join(vendor, "zcode.cjs")],
  [join(cliDist, "provider/zcode-builtin.json"), join(vendor, "provider/zcode-builtin.json")],
  [join(cliDist, "THIRD-PARTY-NOTICES.md"), join(vendor, "THIRD-PARTY-NOTICES.md")],
  [join(zc, "LICENSE"), join(vendor, "LICENSE")],
  [join(zc, "NOTICE.md"), join(vendor, "NOTICE.md")],
]) {
  if (!existsSync(from)) {
    console.error(`[vendor-zcode] 缺少 ${from}`);
    process.exit(1);
  }
  cpSync(from, to);
  console.log(`[vendor-zcode] ${from} -> ${to}`);
}
console.log("[vendor-zcode] done.");
