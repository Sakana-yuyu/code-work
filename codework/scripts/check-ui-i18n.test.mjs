import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { expressionStrings } from "./check-ui-i18n.mjs";

const requireFromMobile = NodeModule.createRequire(
  new URL("../apps/mobile/package.json", import.meta.url),
);
const ts = requireFromMobile("typescript");
const scannerPath = NodeURL.fileURLToPath(new URL("./check-ui-i18n.mjs", import.meta.url));
const scannerNodePath = NodePath.dirname(
  NodePath.dirname(requireFromMobile.resolve("typescript/package.json")),
);
const temporaryDirectories = [];

const catalogSource = `
export const en = {
  "fixture.valid": "Valid fixture",
};
export const zhCN = {
  "fixture.valid": "合法测试",
};
`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFixtureFile(repo, relativePath, contents) {
  const file = NodePath.join(repo, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents, "utf8");
}

function makeScannerFixture(files) {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-i18n-scanner-"));
  temporaryDirectories.push(repo);

  writeFixtureFile(repo, "apps/mobile/package.json", "{}\n");
  writeFixtureFile(repo, "apps/web/src/i18n/messages.ts", catalogSource);
  writeFixtureFile(repo, "apps/mobile/src/i18n/messages.ts", catalogSource);
  writeFixtureFile(repo, "apps/desktop/src/i18n.messages.ts", catalogSource);
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFixtureFile(repo, relativePath, contents);
  }
  return repo;
}

function runScanner(repo) {
  return NodeChildProcess.spawnSync(process.execPath, [scannerPath, repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH: [scannerNodePath, process.env.NODE_PATH].filter(Boolean).join(NodePath.delimiter),
    },
    timeout: 10_000,
    windowsHide: true,
  });
}

function diagnostics(result) {
  return result.stderr.trimEnd().split(/\r?\n/);
}

const initializerStrings = (sourceText) => {
  const source = ts.createSourceFile(
    "fixture.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = source.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("测试源码缺少变量声明");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) throw new Error("测试源码缺少变量初始值");

  const strings = [];
  expressionStrings(ts, initializer, strings);
  return strings.map((item) => item.text);
};

describe("UI i18n AST 可见文案提取", () => {
  it("提取对象映射中的可见字符串", () => {
    expect(
      initializerStrings(
        'const actionLabel: Record<string, string> = { download: "Download", install: "Install" };',
      ),
    ).toEqual(["Download", "Install"]);
  });

  it("提取空值回退中的可见字符串", () => {
    expect(
      initializerStrings('const buttonLabel: string = labels[action] ?? "Check for Updates";'),
    ).toEqual(["Check for Updates"]);
    expect(
      initializerStrings('const buttonLabel: string = (labels[action] ?? "Check for Updates");'),
    ).toEqual(["Check for Updates"]);
    expect(
      initializerStrings('const buttonLabel = (labels[action] ?? "Check for Updates") as string;'),
    ).toEqual(["Check for Updates"]);
  });

  it("忽略未显式声明为可见字符串的内部结构", () => {
    expect(initializerStrings('const protocolState = { message: "user" };')).toEqual([]);
    expect(initializerStrings('const internalLabel = labels[action] ?? "user";')).toEqual([]);
  });
});

describe("UI i18n scanner CLI 临时源码树", () => {
  it("报告对象映射中的可见标签并返回非零退出码", () => {
    const repo = makeScannerFixture({
      "apps/web/src/MappedLabels.tsx": `export const actionLabel: Record<string, string> = {
  download: "Download fixture",
  install: "Install fixture",
};
`,
    });

    const result = runScanner(repo);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(diagnostics(result)).toEqual([
      "apps/web/src/MappedLabels.tsx:2:13: visible actionLabel is not translated: Download fixture",
      "apps/web/src/MappedLabels.tsx:3:12: visible actionLabel is not translated: Install fixture",
    ]);
  });

  it("报告类型包装中的可见回退并返回非零退出码", () => {
    const repo = makeScannerFixture({
      "apps/mobile/src/WrappedFallback.tsx": `export function resolveButtonLabel(
  labels: Record<string, string>,
  action: string,
) {
  const buttonLabel = (labels[action] ?? "Check for Updates fixture") as string;
  return buttonLabel;
}
`,
    });

    const result = runScanner(repo);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(diagnostics(result)).toEqual([
      "apps/mobile/src/WrappedFallback.tsx:5:42: visible buttonLabel is not translated: Check for Updates fixture",
    ]);
  });

  it("接受完整使用翻译键的源码树并返回零退出码", () => {
    const repo = makeScannerFixture({
      "apps/desktop/src/ValidFixture.ts": `import { t } from "./i18n";

export function validFixtureLabel() {
  return t("fixture.valid");
}
`,
    });

    const result = runScanner(repo);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("UI i18n check passed for web, mobile, and desktop.\n");
  });
});
