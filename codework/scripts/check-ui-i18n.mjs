import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(SCRIPT_DIR, "..");

const SURFACES = {
  web: {
    root: "apps/web/src",
    catalog: "apps/web/src/i18n/messages.ts",
  },
  mobile: {
    root: "apps/mobile/src",
    catalog: "apps/mobile/src/i18n/messages.ts",
  },
  desktop: {
    root: "apps/desktop/src",
    catalog: "apps/desktop/src/i18n.messages.ts",
  },
};

const VISIBLE_ATTRIBUTES = new Set([
  "accessibilityHint",
  "accessibilityLabel",
  "alt",
  "aria-label",
  "description",
  "detail",
  "emptyText",
  "eyebrow",
  "helperText",
  "label",
  "placeholder",
  "subtitle",
  "title",
  "tooltip",
]);

const VISIBLE_PROPERTIES = new Set([
  ...VISIBLE_ATTRIBUTES,
  "cancelLabel",
  "confirmLabel",
  "headerSubtitle",
  "headerTitle",
  "message",
]);

const VISIBLE_PROPERTY_SUFFIX =
  /^(?:caption|description|eyebrow|hint|label|message|placeholder|subtitle|summary|text|title|tooltip|.*(?:Caption|Description|Eyebrow|Hint|Label|Message|Placeholder|Subtitle|Summary|Text|Title|Tooltip))$/;

const SOURCE_EXEMPTIONS = new Set([
  "Code Work",
  "Code Work Connect",
  "Cursor BYOK",
  "Ctrl-C",
  "Git",
  "Git URL",
  "GitHub",
  "GitLab",
  "Bitbucket",
  "IntelliJ IDEA",
  "macOS",
  "Windows",
  "Linux",
  "Android",
  "iOS",
  "Pi Agent",
  "Pocket Pi",
  "Ultrathink",
  "VS Code",
]);

const SAME_VALUE_EXEMPTIONS = new Set([
  ...SOURCE_EXEMPTIONS,
  "Google Gemini",
  "Git URL",
  "IDE Profile",
  "Session ID",
  "Tailscale HTTPS",
  "Tailscale IP",
  "Ultrathink",
  "WebSocket URL",
  "ab",
  "codework",
  "ide_local",
  "root",
]);
const SAME_VALUE_EXEMPTION =
  /^(?:[A-Z0-9_ .:/@#$%+(){}\[\],~'"\\|-]+|Claude|Codex|Cursor|Grok|OpenCode|OpenAI|Anthropic|Gemini|DeepSeek|OpenRouter|Git|GitHub|GitLab|Bitbucket|macOS|Windows|Linux|Android|iOS|Tailscale|WSL|SSH|CPU|GPU|PID|URL|ID|PR|MCP|BYOK|ACP|Code Work(?: Connect)?|Sidecar|Span|Trace|Base URL|Tailnet|MagicDNS|PhpStorm|VSCodium|English)$/;
const TECHNICAL_LITERAL =
  /^(?:https?:\/\/\S+|wss?:\/\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}|[A-Z0-9_]{3,}|ERR_\{\{\w+\}\}|PR\s+#\{\{\w+\}\}|[a-z0-9_.-]+\/[a-z0-9_./-]+|[A-Za-z]:[\\/]|\.\.?[\\/]|[#.:/@$][^ ]+|--[^ ]+|[a-z]+(?::[a-z0-9-]+)+|[a-z]+(?:-[a-z0-9]+){2,}|\d+(?:\.\d+)?(?:ms|s|m|h)|\{\{\w+\}\}\s+(?:tokens?|\([A-Za-z0-9+ -]+\))|\{.*\}|git:\(|VITE\s.+|WSL\s*\([^)]*\)|[✓△✗].*)$/;
const BAD_TRANSLATION_PATTERNS = [
  /分支es/u,
  /工作树s/u,
  /拉取请求s/u,
  /差异erent/u,
  /[Uu]n提交ted/u,
  /正在再生/u,
  /结算\s*\{\{/u,
  /存档\s*\{\{/u,
  /开关型号/u,
  /VS钠|VS代码|尾鳞|继电器|袖珍圆周率/u,
];

const EXCLUDED_FILE =
  /(?:^|[\\/])(?:i18n|__fixtures__|fixtures)(?:[\\/])|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/;

function makeTypescript(repo) {
  const requireFromMobile = createRequire(pathToFileURL(join(repo, "apps/mobile/package.json")));
  return requireFromMobile("typescript");
}

function propertyName(ts, node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function readCatalog(ts, file) {
  const sourceText = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result = { en: new Map(), zhCN: new Map(), duplicateKeys: [] };

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "en" || node.name.text === "zhCN") &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const target = result[node.name.text];
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
          continue;
        }
        const key = propertyName(ts, property.name);
        if (key === undefined) continue;
        if (target.has(key)) result.duplicateKeys.push(`${node.name.text}.${key}`);
        target.set(key, property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return result;
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...listSourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry) && !EXCLUDED_FILE.test(path)) files.push(path);
  }
  return files;
}

function normalized(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isTechnicalExample(file) {
  return file.includes(join("features", "showcase")) || file.endsWith("AppearancePreviews.tsx");
}

function isCandidate(file, text, catalogKeys) {
  const value = normalized(text);
  const visibleWords = value.replace(/\{\{\w+\}\}/g, "").trim();
  if (SOURCE_EXEMPTIONS.has(value) || catalogKeys.has(value) || isTechnicalExample(file)) {
    return false;
  }
  if (visibleWords.length < 2 || !/[A-Za-z\p{Script=Han}]/u.test(visibleWords)) return false;
  return !TECHNICAL_LITERAL.test(value);
}

function isInsideTranslation(ts, node) {
  let current = node;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "t"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isFunctionLike(ts, node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isModuleLevel(ts, node, source) {
  let current = node.parent;
  while (current && current !== source) {
    if (isFunctionLike(ts, current)) return false;
    current = current.parent;
  }
  return true;
}

function isStringRecordLiteral(ts, node) {
  const parent = node.parent;
  const typeNode =
    ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)
      ? parent.type
      : ts.isSatisfiesExpression(parent) || ts.isAsExpression(parent)
        ? parent.type
        : undefined;
  return Boolean(
    typeNode &&
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "Record" &&
    typeNode.typeArguments?.length === 2 &&
    typeNode.typeArguments.every((argument) => argument.kind === ts.SyntaxKind.StringKeyword),
  );
}

function isExplicitStringValue(ts, node) {
  if (
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)) &&
    node.type.kind === ts.SyntaxKind.StringKeyword
  ) {
    return true;
  }
  const parent = node.parent;
  const typeNode =
    ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)
      ? parent.type
      : ts.isSatisfiesExpression(parent) || ts.isAsExpression(parent)
        ? parent.type
        : undefined;
  return typeNode?.kind === ts.SyntaxKind.StringKeyword;
}

export function expressionStrings(ts, node, output, allowNullishFallback = false) {
  if (isInsideTranslation(ts, node)) return;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    output.push({ node, text: node.text });
    return;
  }
  if (ts.isTemplateExpression(node)) {
    output.push({
      node,
      text: [
        node.head.text,
        ...node.templateSpans.map((span) => `{{value}}${span.literal.text}`),
      ].join(""),
    });
    return;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    expressionStrings(
      ts,
      node.expression,
      output,
      allowNullishFallback || isExplicitStringValue(ts, node),
    );
    return;
  }
  if (ts.isConditionalExpression(node)) {
    expressionStrings(ts, node.whenTrue, output, allowNullishFallback);
    expressionStrings(ts, node.whenFalse, output, allowNullishFallback);
    return;
  }
  if (ts.isObjectLiteralExpression(node) && isStringRecordLiteral(ts, node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (
          !ts.isObjectLiteralExpression(property.initializer) &&
          !ts.isArrayLiteralExpression(property.initializer)
        ) {
          expressionStrings(ts, property.initializer, output, true);
        }
      } else if (ts.isSpreadAssignment(property)) {
        expressionStrings(ts, property.expression, output, true);
      }
    }
    return;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    (allowNullishFallback || isExplicitStringValue(ts, node))
  ) {
    expressionStrings(ts, node.left, output, true);
    expressionStrings(ts, node.right, output, true);
  }
}

function visibleCallArgumentIndexes(ts, node) {
  const expression = node.expression;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Alert" &&
    expression.name.text === "alert"
  ) {
    return [0, 1];
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "confirm" &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "dialogs"
  ) {
    return [0];
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "window" &&
    (expression.name.text === "alert" || expression.name.text === "confirm")
  ) {
    return [0];
  }
  return [];
}

function placeholders(value) {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

function sameItems(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function collectI18nErrors(repo = DEFAULT_REPO) {
  const ts = makeTypescript(repo);
  const errors = [];

  for (const [surface, config] of Object.entries(SURFACES)) {
    const catalogPath = join(repo, config.catalog);
    const catalog = readCatalog(ts, catalogPath);
    const enKeys = new Set(catalog.en.keys());
    const zhKeys = new Set(catalog.zhCN.keys());

    for (const duplicate of catalog.duplicateKeys) {
      errors.push(`${config.catalog}: duplicate catalog key ${duplicate}`);
    }
    for (const key of enKeys) {
      if (!zhKeys.has(key)) errors.push(`${config.catalog}: zh-CN is missing key ${key}`);
    }
    for (const key of zhKeys) {
      if (!enKeys.has(key)) errors.push(`${config.catalog}: zh-CN has extra key ${key}`);
    }
    for (const [key, english] of catalog.en) {
      const chinese = catalog.zhCN.get(key);
      if (chinese === undefined || chinese.trim().length === 0) continue;
      if (!sameItems(placeholders(english), placeholders(chinese))) {
        errors.push(`${config.catalog}: placeholder mismatch for ${key}`);
      }
      if (
        english === chinese &&
        !SAME_VALUE_EXEMPTIONS.has(english) &&
        !SAME_VALUE_EXEMPTION.test(english) &&
        !TECHNICAL_LITERAL.test(english)
      ) {
        errors.push(`${config.catalog}: untranslated zh-CN value for ${key}: ${english}`);
      }
      for (const pattern of BAD_TRANSLATION_PATTERNS) {
        if (pattern.test(chinese)) {
          errors.push(`${config.catalog}: suspicious zh-CN value for ${key}: ${chinese}`);
          break;
        }
      }
    }

    for (const file of listSourceFiles(join(repo, config.root))) {
      const sourceText = readFileSync(file, "utf8");
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const relativeFile = relative(repo, file).replaceAll("\\", "/");
      const report = (node, message) => {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        errors.push(`${relativeFile}:${position.line + 1}:${position.character + 1}: ${message}`);
      };

      function visit(node) {
        if (ts.isJsxText(node) && isCandidate(file, node.text, enKeys)) {
          report(node, `visible text is not translated: ${normalized(node.text)}`);
        }
        if (
          ts.isJsxExpression(node) &&
          node.expression &&
          (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
        ) {
          const strings = [];
          expressionStrings(ts, node.expression, strings);
          for (const item of strings) {
            if (isCandidate(file, item.text, enKeys)) {
              report(item.node, `visible expression is not translated: ${normalized(item.text)}`);
            }
          }
        }
        if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.text)) {
          const initializer = node.initializer;
          const strings = [];
          if (initializer && ts.isStringLiteral(initializer)) {
            strings.push({ node: initializer, text: initializer.text });
          } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
            expressionStrings(ts, initializer.expression, strings);
          }
          for (const item of strings) {
            if (isCandidate(file, item.text, enKeys)) {
              report(
                item.node,
                `visible ${node.name.text} is not translated: ${normalized(item.text)}`,
              );
            }
          }
        }
        if (ts.isPropertyAssignment(node)) {
          const name = propertyName(ts, node.name);
          if (name && (VISIBLE_PROPERTIES.has(name) || VISIBLE_PROPERTY_SUFFIX.test(name))) {
            const strings = [];
            expressionStrings(ts, node.initializer, strings);
            for (const item of strings) {
              if (isCandidate(file, item.text, enKeys)) {
                report(item.node, `visible ${name} is not translated: ${normalized(item.text)}`);
              }
            }
          }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const name = node.name.text;
          if (
            node.initializer &&
            (VISIBLE_PROPERTIES.has(name) || VISIBLE_PROPERTY_SUFFIX.test(name))
          ) {
            const strings = [];
            expressionStrings(ts, node.initializer, strings);
            for (const item of strings) {
              if (isCandidate(file, item.text, enKeys)) {
                report(item.node, `visible ${name} is not translated: ${normalized(item.text)}`);
              }
            }
          }
        }
        if (ts.isCallExpression(node)) {
          for (const index of visibleCallArgumentIndexes(ts, node)) {
            const argument = node.arguments[index];
            if (!argument) continue;
            const strings = [];
            expressionStrings(ts, argument, strings);
            for (const item of strings) {
              if (isCandidate(file, item.text, enKeys)) {
                report(
                  item.node,
                  `visible dialog text is not translated: ${normalized(item.text)}`,
                );
              }
            }
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "t" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const key = node.arguments[0].text;
          const template = catalog.en.get(key);
          if (template === undefined) {
            report(node.arguments[0], `unknown translation key: ${key}`);
          } else {
            const required = [...new Set(placeholders(template))];
            if (required.length > 0) {
              const params = node.arguments[1];
              const supplied =
                params && ts.isObjectLiteralExpression(params)
                  ? params.properties.flatMap((property) => {
                      if (
                        !ts.isPropertyAssignment(property) &&
                        !ts.isShorthandPropertyAssignment(property)
                      )
                        return [];
                      const name = propertyName(ts, property.name);
                      return name ? [name] : [];
                    })
                  : [];
              const missing = required.filter((name) => !supplied.includes(name));
              if (missing.length > 0) {
                report(node, `translation ${key} is missing params: ${missing.join(", ")}`);
              }
            }
          }
          if (surface !== "desktop" && isModuleLevel(ts, node, source)) {
            report(
              node,
              "translation is evaluated at module load; use a stable key, factory, or getter",
            );
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(source);
    }
  }

  return errors;
}

export function runI18nCheck(repo = DEFAULT_REPO) {
  const errors = collectI18nErrors(repo);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    return false;
  }
  process.stdout.write("UI i18n check passed for web, mobile, and desktop.\n");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!runI18nCheck(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_REPO))
    process.exitCode = 1;
}
