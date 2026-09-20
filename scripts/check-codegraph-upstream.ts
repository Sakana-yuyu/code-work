#!/usr/bin/env node
/**
 * Check the upstream CodeGraph CLI (@colbymchenry/codegraph on npm) for
 * releases newer than the version this integration was validated against.
 *
 * Run before every release (see docs/operations/release.md, pre-release
 * checklist). Exit code 1 means the upstream moved and the integration needs
 * a human review pass: verify `codegraph init --yes` and `codegraph explore`
 * behavior/output still match what apps/server/src/codeGraph expects, then
 * bump CODEGRAPH_VALIDATED_CLI_VERSION.
 */

import { CODEGRAPH_VALIDATED_CLI_VERSION } from "../apps/server/src/codeGraph/codeGraphIndex.ts";

const PACKAGE = "@colbymchenry/codegraph";
const UPSTREAM_REPO = "https://github.com/colbymchenry/codegraph";

const compareSemver = (a: string, b: string): number => {
  const parse = (value: string) => value.replace(/^v/u, "").split(".").map(Number);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  for (const [left, right] of [
    [aMajor, bMajor],
    [aMinor, bMinor],
    [aPatch, bPatch],
  ] as const) {
    if (left !== right) return (left ?? 0) - (right ?? 0);
  }
  return 0;
};

const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}`);
if (!response.ok) {
  console.error(`✗ npm registry lookup failed for ${PACKAGE}: HTTP ${response.status}`);
  // 用 exitCode + 自然退出，避免 Windows 上 process.exit 与 keep-alive
  // socket 竞争触发 libuv 断言崩溃。
  process.exitCode = 2;
} else {
  const metadata = (await response.json()) as {
    readonly "dist-tags"?: { readonly latest?: string };
  };
  const latest = metadata["dist-tags"]?.latest;
  if (latest === undefined) {
    console.error(`✗ npm registry metadata for ${PACKAGE} has no latest dist-tag.`);
    process.exitCode = 2;
  } else {
    console.log(`集成基线（CODEGRAPH_VALIDATED_CLI_VERSION）：${CODEGRAPH_VALIDATED_CLI_VERSION}`);
    console.log(`npm latest：${latest}`);

    if (compareSemver(latest, CODEGRAPH_VALIDATED_CLI_VERSION) > 0) {
      console.log(`\n✗ 上游有新版本。发布前需要人工审阅：`);
      console.log(
        `  1. 对照变更：${UPSTREAM_REPO}/compare/v${CODEGRAPH_VALIDATED_CLI_VERSION}...v${latest}`,
      );
      console.log(
        `  2. 验证 \`codegraph init --yes\` 与 \`codegraph explore <query> --path <root>\` 的行为/输出未破坏集成；`,
      );
      console.log(
        `  3. 更新 apps/server/src/codeGraph/codeGraphIndex.ts 里的 CODEGRAPH_VALIDATED_CLI_VERSION；`,
      );
      console.log(`  4. 跑 apps/server/src/codeGraph 的聚焦测试。`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ 上游没有超出基线的新版本，无需动作。`);
    }
  }
}
