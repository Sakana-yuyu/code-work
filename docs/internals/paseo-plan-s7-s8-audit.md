# Paseo 接入计划 §7 / §8 历史审计线索（R101）

2026-10-01 更正：本页是历史方法记录，本轮未重新运行所列250项或重新审查全部原日志。当前 A-8 仍未完成；不以方法约定、旧勾选或豁免marker代替当前证据。稳定方法见 [Agent入口与验收合同](./acp-provider-validation.md)。

核对日期：2026-09-30。权威计划：`C:/Users/Administrator/Documents/Codex/plans/2026-09-29-codework-paseo-provider-integration.md`。  
本页审计**计划第 7、8 节**在当前工作树中的落实情况。它**不是** loop `A-8` 通过证明。

## 计划原文摘要（完整段落见计划文件）

### §7 定向验证方法

- 优先复用现有测试；不跑全仓。
- 给出四组 `vp test run` 文件清单（AcpRuntimeModel / CoreRuntimeEvents / RegistryCatalog；GenericAcpDriver / CursorAdapter / ToolBroker e2e；ProviderRuntimeIngestion activity+approval；MessagesTimeline logic+performance / Mobile threadActivity）。
- `e2e` 文件名≠真实官方服务联调。
- 改动范围做 `tsgo --noEmit` / Mobile `tsc`；lint 只列改动文件。
- 异步测试等 receipt/barrier/drain，不用固定睡眠。
- 每个 Agent 验收记录字段：`provider/profile、CLI version、OS/arch、transport、authentication、models/modes、text/reasoning、read/write/exec、approval/question、MCP、cancel/resume、Web/Desktop/Mobile、local/remote、evidence、limitations`。不支持写原因；没测写未验证，不能写通过。

### §8 风险、范围与回滚（回滚句）

> 回滚：新 profile 可逐个禁用，不删除历史；目录与可选合同增量保持旧命令兼容；事件解析和 UI 分阶段提交，可按提交撤回。停用进程仅针对本次启动并持有的 PID，不按名称批量结束。

其余条款为版本漂移、Windows、工具副作用、审批、认证与余额、许可、以及计划撰写当轮的调研边界说明。

## R101 §7 执行证据

| Atom | 状态 | 证据 |
| --- | --- | --- |
| §7 四组定向测试 | **proven** | `%TEMP%/codework-paseo-unblock/r101-s7-tests.log`：Batch1 80、Batch2 52、Batch3 11、Batch4 107；**合计 250 passed**；`ALL_OK=True` |
| 不全仓 | **proven** | 仅跑计划列出的文件 |
| Agent 记录字段 / 未验证≠通过 | **proven（登记层）** | `paseo-provider-catalog.md` A-3 矩阵 + A-4 四态；各 `*-acp-provider.md`；未实测不当成通过 |
| 异步等 receipt | **partial→proven for listed suites** | 上述定向测试沿用项目既有 barrier/drain 惯例；本轮未改测试基建 |

`tsgo`/改动文件 lint：本轮未宣称全仓 typecheck；按 AGENTS.md 仅对触及范围定向验证。§7 写的是「按实际改动选择」，不是每次强制全仓。

## R101 §8 执行证据

| Atom | 状态 | 证据 |
| --- | --- | --- |
| profile 可逐个禁用、不删历史 | **proven（产品能力）** | Provider 实例启停/禁用走既有 settings；见 `docs/internals/providers.md` |
| 目录/合同旧命令兼容 | **proven** | catalog / contracts 保留旧 `command`；向导增量字段可选 |
| 分阶段提交可 `git revert` | **proven（方法）** | 多轮 ledger 记录单主题提交；本页不要求本轮提交 |
| 停用仅 PID、不按名杀 | **proven（工程约定）** | `AGENTS.md`「The three ways to hurt yourself」 |
| 风险条款（Windows/副作用/审批/余额） | **documented** | generic-acp / catalog / byok-gateway 等 internals |

## 与 loop A-8 的关系（裁决）

loop A-8 书面条：

> 稳定实现文档、用户说明、44 入口能力记录与回滚方法齐全，**全部范围经过最终独立审计**。(verify: 对照计划 P0–P5 逐条证据审查；源文件定向 lint/typecheck/tests；**新鲜 spec-verifier 审核所有 A-N，未证实项保持未完成**。)

裁决：

1. 计划 **没有** 名为 A-8 的验收框；§7/§8 是验证方法与风险/回滚约束。
2. loop A-8 明确要求 **全部范围** 独立审计 + **所有 A-N** 经 verifier，且未证实项保持未完成。
3. 因此：**即使 §7/§8 方法原子已落实，只要 A-3（P2 Gemini）仍开，不得勾选 A-8。**  
   （旧 R107 报告记载设备范围调整；其原始用户消息及适用门槛须核对，本页不自行授予豁免。）
4. A-8 是 **loop 相对计划的 super-gate**，不是「§7/§8 做完即可勾」。

当前标记：§7/§8 是历史方法线索；**A-8 未完成**。缺口包括新鲜全部范围独立审核及逐项证据复核，不能断言只剩 Gemini。

A-N 历史线索见 `docs/internals/paseo-a8-independent-audit.md`；它同样不构成当前完成证明。

## R101 的 P0–P5 历史判定（待最终复核）

| 计划桶 | 判定 | 说明 |
| --- | --- | --- |
| P0 fixture / CLI 记录方法 | proven / partial | fixture proven；CLI 表有，Gemini 等仍未验证成功路径 |
| P1 通用 ACP | proven | A-1 `[x]` |
| P2 目录 | proven | A-2 `[x]` |
| P2 首批五 CLI | **open** | Gemini 成功路径缺 key → A-3 `[ ]` |
| P3 其余目录登记 | proven | A-4 `[x]`（P3 允许未实测登记） |
| P4 原生回归 | proven | A-6 `[x]` |
| P5 真机/多端 | **open** | 真实手机未出现 → A-5 `[ ]`；远程桶已由 A-7 覆盖 |

## 回滚（本审计页）

撤回本文件即可；不改动运行时或数据库。不表示撤回 A-4 勾选或其它 ledger 结论。
