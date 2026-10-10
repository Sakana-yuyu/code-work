import { describe, expect, it } from "@effect/vitest";

import {
  extractAskUserQuestionsFromText,
  formatAskUserAnswers,
  parseAskUserToolArguments,
} from "./ByokAskUser.ts";

const CONFIRMATION_REPLY = `规划已放到右侧面板。简要总结一下方案：

## 方案概述

**架构**：Vue 3 + Vite 构建移动端优先的静态站点。

## 开工前需要你确认 4 件事

1. **产品类型**：工具/商城/预约/内容？——决定演示页要模拟哪些核心流程
2. **是否已有后端 API**：没有的话真实模式先和演示共用 mock，后续再接
3. **有无现有素材**：产品截图、Logo、品牌色？没有的话需要先出视觉设计
4. **小程序技术倾向**：uni-app 还是原生微信小程序？如果倾向 uni-app，演示页组件结构可以直接对齐

回复这几个问题后，我就可以开始初始化项目了。`;

const FOLLOW_UP_REPLY = `## 开工前只差两个信息

1. **品牌/产品名**：演示里要出现的名字（没有的话我先起一个占位）
2. **色系偏好**：比如科技蓝 / 暖橙 / 黑白极简 / 让 AI 自由发挥

回复后我就从生成设计稿开始动手。`;

describe("extractAskUserQuestionsFromText", () => {
  it("turns a numbered confirmation list into questions", () => {
    const questions = extractAskUserQuestionsFromText(CONFIRMATION_REPLY);
    expect(questions?.map((question) => question.header)).toEqual([
      "产品类型",
      "是否已有后端 API",
      "有无现有素材",
      "小程序技术倾向",
    ]);
    expect(questions?.[0]?.options.map((option) => option.label)).toEqual([
      "工具",
      "商城",
      "预约",
      "内容",
    ]);
    expect(questions?.[1]?.options).toEqual([]);
    expect(questions?.[3]?.options.map((option) => option.label)).toEqual([
      "uni-app",
      "原生微信小程序",
    ]);
    expect(questions?.map((question) => question.id)).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("extracts a later confirmation even after a plan summary", () => {
    const questions = extractAskUserQuestionsFromText(FOLLOW_UP_REPLY);
    expect(questions?.map((question) => question.header)).toEqual(["品牌/产品名", "色系偏好"]);
    expect(questions?.[1]?.options.map((option) => option.label)).toEqual([
      "科技蓝",
      "暖橙",
      "黑白极简",
    ]);
  });

  it("ignores numbered steps that are not waiting on the user", () => {
    const text = `## 实施步骤

1. 初始化 Vite 项目
2. 写首页

完成后我会把结果发回来。`;
    expect(extractAskUserQuestionsFromText(text)).toBeUndefined();
  });

  it("ignores numbered lists that only appear inside code fences", () => {
    const text = `\`\`\`md
## 开工前需要你确认
1. 产品类型：工具/商城？
回复后继续。
\`\`\`

方案已经放在右侧。`;
    expect(extractAskUserQuestionsFromText(text)).toBeUndefined();
  });
});

describe("parseAskUserToolArguments", () => {
  it("accepts structured questions and fills missing option descriptions", () => {
    const questions = parseAskUserToolArguments({
      questions: [
        {
          header: "产品类型",
          question: "演示页要模拟哪一类产品？",
          options: [{ label: "商城" }, { label: "工具", description: "工具类流程" }],
        },
      ],
    });
    expect(questions).toEqual([
      {
        id: "q1",
        header: "产品类型",
        question: "演示页要模拟哪一类产品？",
        options: [
          { label: "商城", description: "商城" },
          { label: "工具", description: "工具类流程" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("rejects an empty question list", () => {
    expect(parseAskUserToolArguments({ questions: [] })).toBeUndefined();
    expect(parseAskUserToolArguments({ questions: [{ header: "缺问题" }] })).toBeUndefined();
  });
});

describe("formatAskUserAnswers", () => {
  it("renders card answers in question order", () => {
    const questions = extractAskUserQuestionsFromText(CONFIRMATION_REPLY);
    expect(questions).toBeDefined();
    if (questions === undefined) return;
    expect(
      formatAskUserAnswers(questions, {
        q1: "商城",
        q2: "没有",
        q4: ["uni-app", "先对齐组件"],
      }),
    ).toContain("1. 产品类型：商城");
    expect(
      formatAskUserAnswers(questions, {
        q1: "商城",
        q2: "没有",
        q4: ["uni-app", "先对齐组件"],
      }),
    ).toContain("4. 小程序技术倾向：uni-app、先对齐组件");
  });
});
