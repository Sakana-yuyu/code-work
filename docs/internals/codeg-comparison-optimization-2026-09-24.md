# 对照 CodeG 的 Code Work 功能优化清单

> 调研日期：2026-09-24。下方“已有能力与差距判断”记录实施前的基线；本轮实施情况见文末，不应将候选验收条件视为全部已达成。

## 调研范围与依据

- 对照项目：[xintaofei/codeg](https://github.com/xintaofei/codeg)，本地克隆于 `E:\MyProject\codeg`，固定观察提交为 [`f6cffc2894c6edaa5248a3a702ec2b5bca5d0021`](https://github.com/xintaofei/codeg/tree/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021)。只读取公开仓库及其源码，没有运行 CodeG 服务。
- 当前项目：Code Work 工作树提交 `537161f80`，结合本地未提交状态做静态核对；现有未提交改动不属于本文实现范围。
- 检索词：`xintaofei/codeg`（GitHub 页面）；`session import`、`ACP registry`、`work task`、`split view`、`Office preview`（克隆仓库内检索）。访问日期：2026-09-24。采用 CodeG 官方仓库 README 和具体实现文件作为依据，因为它们能同时说明产品行为和代码入口；没有采用第三方介绍作为功能事实。
- 优先级是基于当前代码差距、用户收益和接入风险的建议，不是实测性能或用户需求排序。未进行用户访谈、跨端实机验证或竞品基准测试。

## 已有能力与差距判断

| 主题                | Code Work 当前状态                                                                                                                                                                                           | CodeG 可借鉴的增量                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 对话分屏            | 已有“在旁边打开线程”的双栏布局，状态只记录主、副线程及比例：[ThreadSplitLayout](../../apps/web/src/components/ThreadSplitLayout.tsx)、[threadSplitStore](../../apps/web/src/threadSplitStore.ts)             | 多组横/纵分屏、跨组移动标签、恢复每组布局与草稿          |
| 后台工作与 worktree | 已可从新线程后台启动，选择“新 worktree”时每条后台线程独立创建：[composer 文档](../user/composer.md)                                                                                                          | 把待办、运行、待处理、完成及合并确认串成可追踪的任务流程 |
| 多 Agent 与运行控制 | 已有组合运行时、委派台账和控制中心：[CompositionControlCenterPanel](../../apps/web/src/components/settings/CompositionControlCenterPanel.tsx)                                                                | 将任务排队、worktree 差异和人工接收集中在一个入口        |
| 线程搜索与用量统计  | 已有线程内容搜索契约和命令面板入口；用量页包含趋势、模型占比和活动热力图：[ProjectionSnapshotQuery](../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts)、[usage 文档](../user/usage.md) | 不重复建设搜索和统计页面；优先扩展可搜索数据来源         |
| ACP 扩展            | 可手工配置任意 ACP CLI；文档明确尚无应用内目录：[ACP 文档](../user/providers-pi-ohmypi-acp.md)                                                                                                               | 目录发现、安装前校验、安装后可用性诊断                   |
| 文件预览            | 对话工作区已有文本、Markdown、HTML、图片预览：[FilePreviewPanel](../../apps/web/src/components/files/FilePreviewPanel.tsx)                                                                                   | 对 `.docx`、`.xlsx`、`.pptx` 提供可自动刷新的预览        |

## 候选优化项

### 1. P1：导入并继续使用本机其他 Agent 的历史会话

**用户价值**：换用 Code Work 后能找到以往在 Codex、Claude Code 等 CLI 中完成的工作，减少重复交代背景。CodeG 的[会话扫描与批量导入](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/commands/conversations.rs)、[导入去重与刷新](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/db/service/import_service.rs)、[导入选择界面](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/components/import-sessions/import-sessions-window.tsx)提供了具体参考。

**现状与建议**：Code Work 已能搜索自己的线程，但在当前服务端编排、Provider 和 Web 入口中未找到面向用户的“扫描并导入外部 CLI 历史”流程。建议在服务端为各 Provider 增加只读发现适配器，以 `provider + 原生会话 ID + 环境` 稳定去重；先把历史内容映射成现有线程投影，再在明确支持恢复的 Provider 上开放续聊。把来源、同步时间及“仅可查看/可以继续”状态显示给用户。可复用现有线程分页与搜索契约，避免一次加载完整历史。

**验收条件**：选择指定项目的历史会话后可导入、搜索、打开；重复扫描不会产生重复线程或覆盖用户手工改的标题；CLI 原始文件保持只读；不支持恢复时给出准确提示。验证大历史、损坏记录和多环境同名路径。

**风险与边界**：不同 Provider 的日志格式、附件与恢复语义不一致；导入应在持有文件的环境执行，不把本机路径暴露给其他环境。涉及敏感历史时应沿用现有环境授权与脱敏规则。

### 2. P1：给 ACP Agent 增加目录发现和安装诊断

**用户价值**：免去猜测启动命令和参数，降低添加自定义 Agent 的门槛。CodeG 已有[公开 ACP 目录获取与添加入口](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/commands/custom_agents.rs)和[平台相关分发解析](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/acp/remote_registry.rs)。

**现状与建议**：保留现有手工 ACP 配置作为高级入口；新增目录检索、适用平台筛选、安装预览、可执行文件与协议握手检查。目录只提供推荐配置，实际安装和凭据仍由所连环境负责。先支持可明确校验的分发方式，再扩充其他方式。

**验收条件**：目录不可达时手工入口仍可用；能区分已安装、未安装、不支持当前平台和启动失败；安装失败有可操作的原因；远程环境展示的是远程平台与安装状态，而非浏览器平台。

**风险与边界**：目录内容与安装包来自外部，应校验来源、版本及校验值，并明确执行权限；不要自动把未验证的目录命令写进用户配置。

### 3. P2：把后台线程和控制中心整理成“待办 → 执行 → 待处理 → 完成”任务看板

**用户价值**：用户可先记录任务，按项目并发执行，再集中检查差异和决定是否接收。CodeG 的[任务状态分栏](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/components/tasks/board-columns.ts)、[任务调度与接收](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/work_task/engine.rs)和[Git 合并核验](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/work_task/git.rs)可供参考。

**现状与建议**：Code Work 已有后台线程、worktree、组合任务台账与人工审批，建议优先复用这些实体和命令，在统一视图中补“未开始的待办”、项目并发上限、任务与线程/worktree 的稳定关联、完成后的差异入口。人工接收动作应以真实 Git 状态核验结果为准；遇到冲突回到待处理，不宣称已完成。避免再造一套独立调度器。

**验收条件**：任务从待办到完成可追踪；并发上限生效；取消、失败、重试、审批都有可见反向操作；多个任务不会写入同一 worktree；接收后能验证目标分支确实包含变更。

**风险与边界**：自动接收涉及用户代码和 Git 历史，默认保留人工确认；跨设备同时操作要防重复领取和重复合并。现有控制中心的 `in_review` 语义与 Git 接收不是同一个概念，需在契约中区分。

### 4. P2：扩展对话分屏，并保存布局与草稿

**用户价值**：同时看多个 Agent 的对话与差异，重启后继续之前的工作位置。CodeG 的[分组布局状态](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/stores/tab-store.ts)及[分隔线交互](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/components/conversations/group-split-handle.tsx)展示了实现边界。

**现状与建议**：Code Work 已有两个线程并排和可调比例。可在现有 `ThreadSplitLayout` 上逐步加入纵向分割、第三个分组、分组关闭及布局恢复；草稿继续由现有草稿存储负责，布局只保存引用。Web 与 Desktop 共享布局；移动端沿用单栏导航。

**验收条件**：刷新或重启后恢复有效布局和草稿；线程删除、归档、环境断开时不会留下无法关闭的空分组；拖动分隔线与多个活动流并存时没有明显掉帧。先测双栏恢复，再决定是否需要任意层级分割。

**风险与边界**：增加同时挂载的时间线会提高渲染和 WebSocket 负担，应限制可见分组数，并让隐藏分组使用现有惰性订阅策略。

### 5. P2：在对话文件面板预览 Office 文档的生成结果

**用户价值**：让生成报告、表格和演示文稿的 Agent 工作可以直接检查，无需每次切到外部应用。CodeG 的[Office 预览组件](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/components/files/office-preview.tsx)通过文件监听和预览服务处理 `.docx`、`.xlsx`、`.pptx`。

**现状与建议**：Code Work 对话工作区的文件面板支持代码、Markdown、HTML 与图片，未见上述三类格式的内置预览。建议先做按需打开的只读预览，文件更新后刷新，并复用现有右侧文件面板；服务在项目所在环境运行，预览资源经现有授权链访问。

**验收条件**：三类文件能打开并随保存刷新；大文件和错误格式有清晰失败提示；关闭面板后监听进程释放；远程、配对和本地模式下的访问控制一致。

**风险与边界**：文档渲染依赖及字体会影响包体积、内存和忠实度。先比较已有 Code-OSS 能力与轻量预览方案，不直接引入 CodeG 的整套 Office 服务。

### 6. P3：跨项目或跨 Agent 引用既有会话

**用户价值**：在当前任务中引用之前会话的决策和结果。CodeG 的 [`@` 引用搜索](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/components/chat/composer/use-reference-search.ts)会列出会话，且可与导入的历史结合。

**现状与建议**：先完成第 1 项的可搜索历史，再让 Code Work 输入框选择可访问的线程，并由服务端抽取有限、带来源的摘要或片段供当前 Agent 使用。引用对象应有失效、撤权和来源提示；不要把整条长会话直接塞进 prompt。

**验收条件**：跨 Provider 引用可定位原线程；无权限或已删除的会话不可读取；长会话引用有明确长度上限和截断提示；远程环境不能通过引用越过环境授权。

**风险与边界**：历史内容可能含凭据或过时结论，需要权限复核、脱敏和提示注入边界。

### 7. P3：评估外部消息渠道的远程任务入口

**用户价值**：在 Telegram、飞书或微信中接收任务完成/审批提醒。CodeG 的[消息渠道处理入口](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src-tauri/src/web/handlers/chat_channel.rs)和[配置界面](https://github.com/xintaofei/codeg/blob/f6cffc2894c6edaa5248a3a702ec2b5bca5d0021/src/components/settings/add-chat-channel-dialog.tsx)是参考。

**现状与建议**：Code Work 已有 Web、Desktop、Mobile 的远程控制与配对；当前未发现对应外部聊天渠道。先确认是否有足够用户需求，再限定为通知和打开任务深链；若未来支持发起任务或审批，必须沿用环境身份、作用域、审计和撤销机制。

**验收条件**：可按环境与事件配置通知；撤销渠道后立即停止推送；重复 webhook 不会重复执行命令；消息里不包含敏感 prompt、凭据或完整文件内容。

**风险与边界**：第三方消息平台会扩大数据流出面，开发与运维成本高，因此排在现有客户端体验之后。

**本轮评估结论（2026-09-24）**：暂不新增外部消息渠道。Code Work 已通过[远程配对](../user/remote-access.md)让移动端直接打开环境和线程，服务端也已有移动端 Agent 活动通知与 Live Activity 发布入口；再次接入 Telegram、飞书或微信会引入新的身份绑定、撤销、消息脱敏和 webhook 防重放面。本轮没有用户需求量、通知到达率或渠道成本数据，不能据此判断哪一渠道值得优先建设。后续若有明确需求，第一阶段只发送任务 ID、状态和受控深链，并在环境侧实施作用域检查和撤销；消息发起任务与审批必须另行设计审计及幂等语义。依据为本仓库 `docs/user/remote-access.md`、`apps/server/src/cloud/http.ts`、`apps/mobile/src/widgets/AgentActivity.test.ts`，以及上文引用的 CodeG 官方源码；没有进行渠道 API 的接入测试。

## 建议实施顺序

1. 先做 **ACP 目录与诊断**：边界明确，可在既有 ACP 配置上迭代，能较快验证新增 Agent 的接入体验。
2. 再做 **外部会话导入**：与现有线程搜索、分页和 Provider 适配器结合，先完成只读历史，再逐 Provider 验证续聊。
3. 然后选一条高频工作流深化：后台任务看板、对话分屏持久化或 Office 预览。选择依据应是用户使用频率和实际性能数据。
4. 跨会话引用依赖可靠导入；外部消息渠道先做需求验证。

本文没有复制 CodeG 的实现代码。若后续直接移植 Apache-2.0 代码或资源，需要保留相应许可和声明，并逐项核对 Code Work 的 MIT 许可证、依赖许可及跨端约束。

## 本轮实施状态

| 候选项           | 当前结果                                                                                                                                         | 尚未覆盖的边界                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1. 外部 CLI 会话 | 已实现 Codex 与 Claude Code 历史扫描、项目路径匹配、只读导入、稳定去重、来源提示，以及原 Provider 就绪时的续聊入口。导入与扫描在环境服务端执行。 | 尚未实测有认证的原生会话续聊；其他 Provider 日志格式与附件未接入。                                      |
| 2. ACP 目录      | 已接入官方公开目录、环境平台筛选、固定版本 npx 命令预填、安全字段校验和目录失败时的手工入口。                                                    | 尚未提供目录条目的已安装探测、自动安装、二进制校验值核对；选择条目不会自动执行第三方包。                |
| 3. 任务看板      | 已在既有任务图上显示待办、运行、待处理、完成分栏，并提供 1 至 64 的并发上限设置。                                                                | 尚未增加持久化的预启动待办、任务与 worktree 的稳定关联及 Git 接收核验；因此完整任务状态机验收仍未达成。 |
| 4. 对话分屏      | 已在既有双线程布局加入横纵切换和布局持久化；继续复用现有线程草稿存储。                                                                           | 第三个分组、跨组移动、跨设备同步未实现。                                                                |
| 5. Office 预览   | 已为 `.docx`、`.xlsx`、`.pptx` 增加受授权的只读文字预览、手动刷新与定时变更检查；限制读取与解析规模。                                            | 当前只呈现结构化文字，不能忠实还原排版、图表和图片；三种格式的真实复杂文件仍需手工验收。                |
| 6. 跨会话引用    | 已提供同一环境内可访问线程的选择、有限片段预览、来源标记和插入当前草稿。                                                                         | 暂无跨环境引用；不自动概括整段历史或将历史内容视为可信指令。                                            |
| 7. 外部消息渠道  | 已完成需求与风险评估，本轮不接入。                                                                                                               | 待需求量与渠道成本数据明确后再决定是否启动设计。                                                        |

上述实现位于独立工作树，未合并、推送或部署。原 Code Work 工作目录中的现有修改保持不变。
