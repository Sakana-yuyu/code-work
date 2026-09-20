/**
 * 「子代理模式」对原生 provider（codex/claude）的提示词指引。
 *
 * 原生 agent 自带子代理能力（Claude Code 的 Task 工具、Codex 的 collab
 * agents），开关打开时把这段指引注入 developer instructions（codex）或
 * system prompt append（claude），引导模型主动把可独立的子任务派给原生子
 * 代理；关闭时不注入，模型按自己的默认判断行事。
 *
 * @module SubagentModeGuidance
 */

export const SUBAGENT_MODE_GUIDANCE_PROMPT =
  "子代理模式已开启：遇到可以独立执行的子任务（代码库探索、方案调研、多个互不依赖的修改、" +
  "批量验证与测试）时，主动使用你的原生子代理能力（如 Task 工具、collab agents）并行推进，" +
  "并为每个子代理写清楚任务背景、目标与验收标准；编排决策、跨结果整合与最终交付保留在主线程" +
  "完成。子代理返回的结果必须先复核再采纳，你仍是最终责任人。琐碎的单文件小修改、简单查询、" +
  "或依赖前序结果的串行任务不要派发子代理，直接自己完成。";
