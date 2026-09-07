/**
 * 代码索引的声明级符号提取器：纯函数，按扩展名选择语言模式，
 * 从文件文本中提取顶层（部分语言含一级成员）声明的名称/种类/行号。
 *
 * v1 刻意保持轻量（正则模式、零依赖、单遍扫描）：agent 的高频查询是
 * 「这个符号在哪定义」「这个文件有什么结构」，声明级精度已经足够；
 * 接口是纯的，后续可整体换成 tree-sitter 而不动存储与查询层。
 */

export type CodeIndexSymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "trait"
  | "type"
  | "module"
  | "constant";

export interface ExtractedSymbol {
  readonly name: string;
  readonly kind: CodeIndexSymbolKind;
  /** 1-based 声明行号。 */
  readonly line: number;
  /** 成员声明的所属声明名（如方法所属的类）；顶层声明没有。 */
  readonly parent?: string | undefined;
}

interface LanguagePattern {
  readonly regex: RegExp;
  readonly kind: CodeIndexSymbolKind;
  /** 捕获组序号：声明名所在组（默认 1）。 */
  readonly nameGroup?: number;
  /** 该模式只在缩进不超过该值的行匹配（0 = 仅顶层）。 */
  readonly maxIndent?: number;
}

const tsPatterns: ReadonlyArray<LanguagePattern> = [
  {
    regex: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  { regex: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { regex: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { regex: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  {
    regex: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: "function",
  },
  // 顶层 const 声明：只取箭头函数/显式标注形态，避免把每个常量都算成符号。
  {
    regex:
      /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    kind: "function",
  },
  // 类/对象内的一级方法与字段函数（缩进 2）。
  {
    regex:
      /^\s{2}(?:public|private|protected|static|async|readonly|\s)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{/,
    kind: "method",
    maxIndent: 2,
  },
];

const pythonPatterns: ReadonlyArray<LanguagePattern> = [
  { regex: /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/, kind: "function", nameGroup: 2 },
  { regex: /^(\s*)async\s+def\s+([A-Za-z_]\w*)\s*\(/, kind: "function", nameGroup: 2 },
  { regex: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 2 },
];

const goPatterns: ReadonlyArray<LanguagePattern> = [
  { regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function" },
  { regex: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, kind: "struct" },
  { regex: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type" },
];

const rustPatterns: ReadonlyArray<LanguagePattern> = [
  { regex: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { regex: /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { regex: /^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  { regex: /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
  { regex: /^(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module" },
  { regex: /^\s{4}(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, kind: "method", maxIndent: 4 },
];

const cFamilyPatterns: ReadonlyArray<LanguagePattern> = [
  // C/C++/C#/Java/Kotlin/Swift 共用的保守顶层函数模式。
  { regex: /^(?:[\w:<>*&]+\s+)+\*?([A-Za-z_]\w*)\s*\([^;]{0,200}\)\s*\{?/, kind: "function" },
  {
    regex:
      /^(?:export\s+)?(?:abstract\s+|final\s+|sealed\s+|public\s+|private\s+|internal\s+)*(?:class|struct)\s+([A-Za-z_]\w*)/,
    kind: "class",
  },
  {
    regex: /^(?:public\s+|private\s+|internal\s+)*(?:interface|protocol)\s+([A-Za-z_]\w*)/,
    kind: "interface",
  },
  {
    regex: /^(?:public\s+|private\s+|internal\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)/,
    kind: "enum",
  },
];

const rubyPatterns: ReadonlyArray<LanguagePattern> = [
  { regex: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: "function" },
  { regex: /^module\s+([A-Za-z_]\w*)/, kind: "module" },
  { regex: /^\s*class\s+([A-Z]\w*)/, kind: "class" },
];

const phpPatterns: ReadonlyArray<LanguagePattern> = [
  { regex: /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
  { regex: /^interface\s+([A-Za-z_]\w*)/, kind: "interface" },
  {
    regex: /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/,
    kind: "function",
  },
];

const extensionPatterns: Readonly<Record<string, ReadonlyArray<LanguagePattern>>> = {
  ts: tsPatterns,
  tsx: tsPatterns,
  mts: tsPatterns,
  cts: tsPatterns,
  js: tsPatterns,
  jsx: tsPatterns,
  mjs: tsPatterns,
  cjs: tsPatterns,
  py: pythonPatterns,
  go: goPatterns,
  rs: rustPatterns,
  java: cFamilyPatterns,
  kt: cFamilyPatterns,
  kts: cFamilyPatterns,
  c: cFamilyPatterns,
  h: cFamilyPatterns,
  cc: cFamilyPatterns,
  cpp: cFamilyPatterns,
  cxx: cFamilyPatterns,
  hpp: cFamilyPatterns,
  cs: cFamilyPatterns,
  swift: cFamilyPatterns,
  rb: rubyPatterns,
  php: phpPatterns,
};

/** 参与索引的扩展名集合（对外暴露给枚举层复用）。 */
export const codeIndexExtensions: ReadonlySet<string> = new Set(Object.keys(extensionPatterns));

export const codeIndexLanguageOf = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = path.slice(dot + 1).toLowerCase();
  return extensionPatterns[extension] === undefined ? undefined : extension;
};

/**
 * 提取一个文件的声明符号。行遍历单遍扫描，模式的缩进上限用来区分
 * 顶层声明与类成员；不解析语法树，字符串/注释里的同名模式会偶发误报，
 * 属于 v1 已接受的精度取舍。
 */
export const extractSymbols = (path: string, text: string): ReadonlyArray<ExtractedSymbol> => {
  const language = codeIndexLanguageOf(path);
  if (language === undefined) return [];
  const patterns = extensionPatterns[language];
  if (patterns === undefined) return [];

  const symbols: ExtractedSymbol[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (match === null) continue;
      const nameIndex = pattern.nameGroup ?? 1;
      const rawName = match[nameIndex];
      if (rawName === undefined || rawName.length === 0) continue;
      if (pattern.maxIndent !== undefined) {
        const indent = line.length - line.trimStart().length;
        if (indent > pattern.maxIndent) continue;
      }
      let parent: string | undefined;
      if (pattern.kind === "method" || (language === "py" && line.startsWith(" "))) {
        parent = findEnclosingDeclaration(symbols, index);
      }
      symbols.push({
        name: rawName,
        kind: pattern.kind,
        line: index + 1,
        ...(parent === undefined ? {} : { parent }),
      });
      break;
    }
  }
  return symbols;
};

/** 当前行之前最近的类形声明，视作当前成员的所属声明。 */
const findEnclosingDeclaration = (
  symbols: ReadonlyArray<ExtractedSymbol>,
  lineIndex: number,
): string | undefined => {
  for (let cursor = symbols.length - 1; cursor >= 0; cursor -= 1) {
    const candidate = symbols[cursor];
    if (candidate === undefined) continue;
    if (candidate.line - 1 >= lineIndex) continue;
    if (
      candidate.kind === "class" ||
      candidate.kind === "struct" ||
      candidate.kind === "interface"
    ) {
      return candidate.name;
    }
  }
  return undefined;
};
