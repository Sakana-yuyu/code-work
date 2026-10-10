import type { ProviderUserInputAnswers, UserInputQuestion } from "@codework/contracts";

import type { ByokAgentTool } from "../../composition/ByokAgentLoop.ts";

/**
 * 自定义模型服务的问答。
 *
 * 模型应调用 `ask_user` 把需要用户拍板的问题交给输入框上方的问答卡片。
 * 实际对话里模型经常不调用工具，而是在正文末尾写「需要你确认 N 件事」
 * 加编号列表后直接结束。`extractAskUserQuestionsFromText` 识别这种收尾，
 * 让适配器在回合结束前补发 `user-input.requested`。
 */

export const BYOK_ASK_USER_TOOL_NAME = "ask_user";

const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 6;
const MAX_QUESTION_CHARS = 500;
const MAX_HEADER_CHARS = 24;

const NUMBERED_ITEM = /^[ \t]*(\d{1,2})[.、)][ \t]+(\S.*?)\s*$/;
const ASK_CUE =
  /需要你确认|请你确认|请确认|确认\s*\d+\s*件|回复这|回复后|回答后|只差.{0,8}信息|开工前需要|开工前只差|need you to confirm|please confirm|please reply|once you (?:reply|answer|confirm)/i;
const CHOICE_TOKEN = "[\\u4e00-\\u9fffA-Za-z0-9_+-]{2,12}";
const OR_CHOICES = new RegExp(`(${CHOICE_TOKEN})\\s*还是\\s*(${CHOICE_TOKEN})`);
const SLASH_CHOICES = new RegExp(`(${CHOICE_TOKEN}(?:\\s*/\\s*${CHOICE_TOKEN}){1,5})`);

export const BYOK_ASK_USER_TOOL: ByokAgentTool = {
  canonicalToolName: BYOK_ASK_USER_TOOL_NAME,
  description:
    "向用户发起问答并等待回答。需要用户确认无法从工作区得到的决定、假设或缺失信息时必须调用本工具，不要只在正文里列出编号问题后结束。questions 为 1 到 6 个问题；能枚举的选项放进 options，开放问题可以不给 options。",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: "需要用户回答的问题。",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "卡片短标题，24 字以内。" },
            question: { type: "string", description: "完整问题。" },
            multiSelect: { type: "boolean", description: "是否允许多选。" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项短标签。" },
                  description: { type: "string", description: "选项说明。省略时与 label 相同。" },
                },
                required: ["label"],
              },
            },
          },
          required: ["header", "question"],
        },
      },
    },
    required: ["questions"],
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const optionFrom = (value: unknown): UserInputQuestion["options"][number] | undefined => {
  if (!isRecord(value)) return undefined;
  const label = nonEmpty(value.label);
  if (label === undefined || label.length > MAX_HEADER_CHARS) return undefined;
  const description = nonEmpty(value.description) ?? label;
  return { label, description };
};

const questionFromTool = (value: unknown, index: number): UserInputQuestion | undefined => {
  if (!isRecord(value)) return undefined;
  const question = nonEmpty(value.question);
  const header = nonEmpty(value.header);
  if (question === undefined || header === undefined) return undefined;
  const options: UserInputQuestion["options"][number][] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.options)) {
    for (const entry of value.options) {
      const option = optionFrom(entry);
      if (option === undefined || seen.has(option.label)) continue;
      seen.add(option.label);
      options.push(option);
      if (options.length >= MAX_OPTIONS) break;
    }
  }
  return {
    id: nonEmpty(value.id) ?? `q${index}`,
    header: header.slice(0, MAX_HEADER_CHARS),
    question: question.slice(0, MAX_QUESTION_CHARS),
    options,
    multiSelect: value.multiSelect === true,
  };
};

/** 把 `ask_user` 参数收成问答卡片能直接展示的问题；形状不对时返回 undefined。 */
export function parseAskUserToolArguments(args: unknown): readonly UserInputQuestion[] | undefined {
  if (!isRecord(args) || !Array.isArray(args.questions)) return undefined;
  const questions: UserInputQuestion[] = [];
  for (const entry of args.questions) {
    const question = questionFromTool(entry, questions.length + 1);
    if (question === undefined) continue;
    questions.push(question);
    if (questions.length >= MAX_QUESTIONS) break;
  }
  return questions.length > 0 ? questions : undefined;
}

const withoutFences = (text: string): string => text.replace(/```[\s\S]*?```/g, "\n");

interface NumberedList {
  readonly items: readonly string[];
  readonly firstLine: number;
  readonly lastLine: number;
}

function findLastNumberedList(lines: readonly string[]): NumberedList | undefined {
  let best: NumberedList | undefined;
  let items: string[] = [];
  let firstLine = -1;
  let lastLine = -1;
  let blanks = 0;

  const close = () => {
    if (items.length > 0) {
      best = { items: [...items], firstLine, lastLine };
    }
    items = [];
    firstLine = -1;
    lastLine = -1;
    blanks = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(NUMBERED_ITEM);
    const body = match?.[2];
    if (body !== undefined) {
      if (items.length > 0 && blanks > 1) close();
      if (items.length === 0) firstLine = index;
      items.push(body);
      lastLine = index;
      blanks = 0;
      continue;
    }
    if ((lines[index]?.trim().length ?? 0) === 0) {
      if (items.length > 0) blanks += 1;
      continue;
    }
    if (items.length > 0) close();
  }
  close();
  return best;
}

function hasAskCue(lines: readonly string[], list: NumberedList): boolean {
  const before: string[] = [];
  for (let index = list.firstLine - 1; index >= 0 && before.length < 2; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) continue;
    before.push(line);
  }
  const after: string[] = [];
  for (let index = list.lastLine + 1; index < lines.length && after.length < 3; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) continue;
    if (/^#{1,6}\s/u.test(line)) break;
    after.push(line);
  }
  return ASK_CUE.test([...before, ...after].join("\n"));
}

function headerFrom(text: string, index: number): string {
  const colon = text.search(/[：:]/u);
  const raw = (colon > 0 ? text.slice(0, colon) : text).replace(/[？?].*$/u, "").trim();
  if (raw.length >= 2 && raw.length <= MAX_HEADER_CHARS) return raw;
  return `问题 ${index}`;
}

function choicesFrom(text: string): UserInputQuestion["options"] {
  const head = text.split(/——|—/u)[0] ?? text;
  const orMatch = head.match(OR_CHOICES);
  if (orMatch?.[1] !== undefined && orMatch[2] !== undefined) {
    return [orMatch[1], orMatch[2]].map((label) => ({ label, description: label }));
  }
  const slash = head.match(SLASH_CHOICES);
  if (slash?.[1] === undefined) return [];
  const parts = [
    ...new Set(
      slash[1]
        .split(/\s*\/\s*/u)
        .map((part) => part.replace(/^(?:比如|例如)\s*/u, "").trim())
        .filter((part) => part.length >= 2 && part.length <= 12),
    ),
  ];
  if (parts.length < 2) return [];
  return parts.slice(0, MAX_OPTIONS).map((label) => ({ label, description: label }));
}

function questionFromText(raw: string, index: number): UserInputQuestion | undefined {
  const text = raw.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return undefined;
  return {
    id: `q${index}`,
    header: headerFrom(text, index),
    question: text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS - 1)}…` : text,
    options: choicesFrom(text),
    multiSelect: false,
  };
}

/**
 * 从助手正文末尾的确认清单提取问答。
 * 只认最后一组编号列表，并且它紧邻的标题或收尾句要表明模型在等用户回答。
 */
export function extractAskUserQuestionsFromText(
  text: string,
): readonly UserInputQuestion[] | undefined {
  const lines = withoutFences(text).split(/\r?\n/u);
  const list = findLastNumberedList(lines);
  if (list === undefined || !hasAskCue(lines, list)) return undefined;
  const questions: UserInputQuestion[] = [];
  for (const item of list.items) {
    const question = questionFromText(item, questions.length + 1);
    if (question === undefined) continue;
    questions.push(question);
    if (questions.length >= MAX_QUESTIONS) break;
  }
  return questions.length > 0 ? questions : undefined;
}

export function formatAskUserAnswers(
  questions: readonly UserInputQuestion[],
  answers: ProviderUserInputAnswers,
): string {
  const lines = questions.map((question, index) => {
    const value = answers[question.id];
    const rendered = Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .join("、")
      : typeof value === "string"
        ? value.trim()
        : "";
    return `${index + 1}. ${question.header}：${rendered.length > 0 ? rendered : "（未回答）"}`;
  });
  return [
    "用户已通过问答卡片回答：",
    ...lines,
    "请根据这些回答继续完成任务，不要再重复刚才的问题。",
  ].join("\n");
}
