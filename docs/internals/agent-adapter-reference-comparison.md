# 参考项目对照：Agent 接入、IDE、输出流畅度与上游 T3 Code 差距

本页汇总对 [open-design](https://github.com/nexu-io/open-design)、[Paseo](https://github.com/getpaseo/paseo)、[BaoCode](https://github.com/baocode-dev/baocode) 和上游 [T3 Code](https://github.com/pingdotgg/t3code) 的阅读结论，目的是给 Code Work 后续优化提供一份带证据的候选清单。它不是排期，也不代表已验证的实现；条目落地时在对应 issue 中跟踪，成立的结论再迁入 `docs/internals/providers.md` 等主题文档。

核验日期 **2026-10-12**。参考仓库克隆在工作区之外的 `E:\MyProject\_refs\`（`open-design`、`paseo`、`baocode`、`t3code`），均为只读参考。

## 0. 阅读前提

- Code Work 已有的相关文档：[paseo-multica-clean-room-architecture.md](./paseo-multica-clean-room-architecture.md)（对 Paseo/Multica 的 clean-room 迁移，2026-08-28 基线）、[workspace-ide.md](./workspace-ide.md)（内嵌 VS Code 工作台）、[byok-gateway.md](./byok-gateway.md)、[agent-provider-product-comparison.md](./agent-provider-product-comparison.md)。本页不重复它们，只补充新增发现。
- 许可：BaoCode 主体为 GPL-3.0-only，editor/xterm/pty 子包为 MIT；Paseo 主体为 Apache-2.0；open-design 与 T3 Code 的许可需在引用代码前单独核对。**默认只吸收行为、约束与失败模式，不复制源码。** 需要移植代码的项必须先检查原文件许可与 NOTICE。
- 判断 Code Work 现状时，下文的“现状”列来自对源码的关键字探测或直接读取，标注“需核对”的条目没有读过实现，落地前必须先读代码。

## 1. 各项目的接入模型对照

| 维度        | open-design                          | Paseo                                                                                                            | BaoCode                                                                                                                 | Code Work                                                               |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 定位        | 设计产物生成，CLI 是执行引擎         | 手机/CLI 远程监控本机 agent                                                                                      | Claude Code 的原生桌面 UI（Flutter），自带 IDE                                                                          | 通用编码 agent GUI（web / desktop / mobile）                            |
| agent 数量  | 约二十余个 CLI                       | Claude、Codex、Copilot、OpenCode、Pi、OMP、Cursor、Kimi、Kiro、通用 ACP，插件 provider（Antigravity、Muse Code） | `claude_code`、`codex`（`AgentKernel` 接口，另有 mock）                                                                 | 多 Provider + ACP 家族 + BYOK                                           |
| 适配器形态  | 声明式数据 `RuntimeAgentDef`，无方法 | `AgentClient` + `AgentSession` 命令式接口                                                                        | `AgentKernel` 小接口 + **能力接口**（`SelectsModel`、`SelectsMode`、`ConfirmsModelSwitch`…），UI 只显示内核声明了的能力 | `ProviderAdapterShape` + `ProviderDriver` 生成多实例 `ProviderInstance` |
| 输出归一    | 扁平 SSE 事件                        | `AgentStreamEvent` + 结构化 timeline 项                                                                          | `KernelEvent`（带 `seq`），经 `Transcript` 幂等应用                                                                     | `ProviderRuntimeEvent` → 事件溯源读模型                                 |
| 权限        | 全部免交互放权                       | 保留交互，ACP 原样回传 `optionId`                                                                                | 保留交互（`answer(requestId, …)`，`interaction_panel`）                                                                 | 保留交互（`respondToRequest` / `respondToUserInput`）                   |
| 会话续接    | 各 CLI 原生 resume                   | `resumeSession`、`listImportableSessions` / `importSession`                                                      | `KernelContext.resume`（会话目录记录）、`prepare()` / `release()` 管理内核生命周期                                      | `readThread`、`externalSessions`                                        |
| 模型/供应商 | 每 CLI 自己发现；BYOK 走 OpenCode    | `fetchCatalog` 统一发现，`config.json` 的 provider/profile/`extends`                                             | 本机代理把 Anthropic Messages 翻译到 OpenAI Chat/Responses，密钥在系统钥匙串                                            | 服务端 BYOK 网关 + `CliProxy` + `LocalAccountPool`                      |
| 回滚/审查   | 无                                   | `revertConversation` / `revertFiles` / `revertBoth`                                                              | 逐文件 Keep/Undo，检查点放在 BaoCode 自己的数据目录，不污染仓库 `.git`                                                  | git 隐藏 ref 检查点 + `rollbackThread`                                  |
| 远程        | 无                                   | 中继 + E2E 加密                                                                                                  | SSH：界面在本机，文件/Git/搜索/终端/LSP/Claude Code 都在远端                                                            | Connect/中继/隧道                                                       |

输出适配的核心差异：open-design 把所有协议拍平成一套事件；Paseo 在适配器边界翻译成带类型的 timeline 并由 manager 统一合并、持久化；BaoCode 让每个内核自己翻译，并要求事件带单调 `seq`、按 id 与偏移幂等应用；Code Work 的事件进入 decider/projector。

## 2. 可借鉴点：agent 接入（来自 open-design 与 Paseo）

### 2.1 来自 open-design

1. **降低新增 ACP 类 CLI 的成本。** open-design 新增 CLI 是“一个 def 文件加一行注册”。Code Work 已有 `GenericAcpDriver` 与 `AcpRegistryCatalog`，可评估把更多纯 ACP CLI 收敛到配置驱动，而不是每个 CLI 一套 Adapter/Provider/测试。
2. **argv 长度守卫。** 对以命令行参数传 prompt 的 CLI，在 spawn 之前检查原始字节、Windows `.cmd` 外壳展开后的命令行、直接 exe 的命令行三层，统一返回可操作错误（open-design 的 `AGENT_PROMPT_TOO_LARGE`），避免裸露的 `spawn ENAMETOOLONG`。Code Work 主要运行在 Windows 上，这一项对使用方有直接价值；需核对哪些 provider 走 argv。
3. **help 探测能力标志。** 解析 `--help` 决定是否传某个 flag，避免旧版 CLI 因未知参数失败。
4. **纯文本 CLI 兜底。** 无结构化输出的 CLI，运行结束后扫描 `<artifact>` 块落盘。仅在确实要支持这类 CLI 时再做。
5. **不要照搬：** 全局免交互放权（`--yolo` 等）与 Code Work 的审批模型冲突。

### 2.2 来自 Paseo

1. **统一 `fetchCatalog` 与缓存键。** 模型与模式由一个入口发现，调用方不得单独探测；`getCatalogCacheKey` 让等价配置共享结果，“键只决定存储，不决定执行”；刷新使用共享 AbortSignal 与单一 deadline，多请求不各自累计超时。用于收敛 Code Work 各 Provider 里分散的探测与缓存。
2. **`steerActiveTurn` 契约。** 回合进行中追加指令：适配器声明是否支持，不支持则由 manager 回退为“打断后替换”；适配器出错时不得自动重试（结果不明确）；打断时必须丢弃尚未被 provider 读取的 steer。上游 T3 Code 已有“排队或 steer”的 UI（见 §5），后端契约可参考 Paseo。
3. **用户消息的规范身份。** manager 为前台 prompt 记录唯一规范 timeline 行，`messageId` 与 `clientMessageId` 一致，provider 回显只用于对账，不做全局文本去重。
4. **终态前清理瞬态行。** 适配器在发出 `turn_completed/failed/canceled` 前，必须终结所有仍在 loading 的行（例如 Codex 的 `contextCompaction`）。2026-10-12 全部 canonical 发射入口已接入同一 item 与交互边界，终态前整批补齐完成通知；Codex 原生遗漏完成通知的三种终态回归已通过。遗漏的审批以 cancel、提问以空答案关闭客户端等待，真实回应保持原结果，不调用 provider 或扩大授权。原生 adapter、公共活动投影及两端状态定向验证通过，第 7 项完成；独立后台 task 保持实际生命周期，hook 没有 loading 投影且保留原生结果。真实连接/设备与性能按相应条目继续验收，证据及回退范围见 [port-progress](./port-progress.md)。
5. **草稿阶段不创建 provider session。** 查模型/命令/feature 用 client 级 API，避免产生空的原生会话污染 provider 自己的历史界面。
6. **更细的能力声明。** rewind 拆成 conversation / files / both，另有 streaming、reasoning stream、MCP、persistence 等标志；设置页只展示真实可用控制。
7. **managed-process registry。** provider 衍生的长寿命 helper 进程登记 PID、命令与平台进程身份，启动后后台对账；身份不匹配只删记录不杀进程。与仓库“不要按名称杀进程”规则同向。
8. **provider 配置的深度合并。** `options` 对象递归合并，数组/标量/`null` 替换，只持久化 agent 自己的部分，provider 默认值改动在下次启动生效，profile 继承基础 provider。
9. **插件化 provider。** 新 provider 作为 `plugins/<id>/` 通过 SDK 注册，自带图标、传输与能力声明。对 fork 生态有价值，但需先定边界与安全模型，成本高。
10. **失败关闭的 MCP 预批准。** 新 provider 在无法对“某个精确注入的 MCP server 与工具”预批准之前，无人值守执行必须拒绝。

### 2.3 来自 BaoCode

1. **能力接口而非巨型接口。** `AgentKernel` 本体只有 `send/answer/cancel/restart/prepare/release/dispose/stopped`，其余（选模型、选模式、选权限、选 effort、选上下文、确认切模型会重启）各是独立接口，UI 仅渲染内核声明的部分。与 Paseo 的能力标志同方向，但把“能做什么”绑定到类型上。可作为细化 `ProviderAdapterCapabilities` 的参考。
2. **`prepare()` / `release()` 生命周期。** 对话显示时提前准备（内核可启动并上报选项），空闲且不可见时释放资源，再次使用时重启。对多线程、多 provider 的内存占用有直接帮助，需核对 Code Work 是否已有等价的空闲回收。
3. **`stopped` Future。** `dispose` 之后可等待“它运行的东西已完全停止”，保证没有任何东西再写入会话文件。可用于重启、回滚、切换前的安全等待。
4. **切模型会重启会话时先询问。** `ConfirmsModelSwitch.switchRestarts(model)`：例如选到由另一供应商服务的模型，会重启 agent 并续接对话，先让用户确认。与 Code Work 的 `sessionModelSwitch: "in-session" | "unsupported"` 互补，可补第三态“需要重启续接”。
5. **事件带 `seq`，按 id 与偏移幂等应用。** `KernelEvent.seq` 单调递增，低于等于已应用值的事件视为重复，条目按 id 替换，文本增量落在指定偏移。重连或重放不会改变状态。对 Code Work 的 WebSocket 重连与历史重放是稳健性参考，需核对现有 projector 是否已保证等价幂等。
6. **Transcript 只存已上报内容，其余是投影。** 状态、任务、待处理变更都由 Transcript 投影得到，用 `version` 缓存。与 Code Work 事件溯源方向一致。
7. **`/goal`。** BaoCode 不信任输出（输出几乎不提 goal），而是从两处读取：会话 hooks 里的 Stop hook（type prompt）与会话文件里的 `goal_status` 行。Code Work 已有 goal 相关实现（上游 T3 Code 已做原生 `/goal`），此处值得借鉴的是“状态每次从权威来源重新计算，不依赖之前的推断”。
8. **本机代理的安全姿态。** 只监听 127.0.0.1，随机端口，每次运行重新生成令牌，只应答带令牌的请求，密钥读取发生在每次请求发出时，所以改密钥立即生效。Code Work 的 `CliProxy` / `LocalGatewayKey` 可对照检查。
9. **协议翻译与思考预算。** Anthropic Messages 与 OpenAI Chat/Responses 之间双向翻译（含流式）；`thinking budget → level` 映射（≤512 minimal、≤1024 low、≤8192 medium、≤24576 high，之上 xhigh）；`count_tokens` 在上游没有时用估算。翻译器来自 CLIProxyAPI（MIT，需保留 NOTICE）。可作为 `modelGateway` 协议兼容的测试清单。
10. **账号均衡与会话粘滞。** `CodexBalancer` 让同一会话尽量停在同一账号（提示缓存与加密推理都绑定账号），额度用尽才切换，记忆 2000 个会话。Code Work 已有 `LocalAccountPool`，对照其粘滞与切换规则。
11. **一键导入上游。** `baocode://provider/import` 只接受 `url`、`protocol`、`name`、`key` 几个字段，不允许经链接写入 `env`、认证方式或模型列表（因为 env 会成为环境变量，可执行代码）；参数放在 URL `#` 之后，浏览器不会发给服务器；同一协议同一 Base URL 已存在时让用户选择“更新密钥”还是“另存”。可作为 Code Work 的 BYOK 导入入口设计参考，安全边界尤其值得照搬。

## 3. 可借鉴点：IDE 与对话体验（来自 BaoCode）

Code Work 的 IDE 是内嵌 VS Code 工作台（`@codingame/monaco-vscode-api` + 服务端 VSCodium REH），与 BaoCode 的“原生 Flutter 自绘 IDE”路线不同，**不建议照搬实现**，只吸收体验和约束。

| 编号   | BaoCode 做法                                                                                                                                | 对 Code Work 的启发                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| IDE-1  | 读/搜/命令折叠成单行，一轮结束后的工作折叠成一行（`StepFolds`，“Worked for 4m 32s”）；编辑、子 agent、agent 的话打断折叠；计划卡片永不折叠  | 长任务时间线更易读。上游 T3 Code 也有 turn fold 与时间戳（§5）。对照 `MessagesTimeline` 的折叠规则  |
| IDE-2  | 逐文件 Keep/Undo，检查点存放在应用数据目录而不是仓库 `.git`                                                                                 | Code Work 用仓库内隐藏 git ref。可评估对只读仓库、worktree 与远程项目的影响；先不迁移，仅作取舍记录 |
| IDE-3  | 输入框是富文本：从编辑器复制的代码以“文件+行号引用”形式进入；粘贴图片、拖入文件落在句子中的位置                                             | 对照 Code Work 的 composer。上游已默认启用 rich text composer、折叠大段粘贴为文本附件               |
| IDE-4  | 目标面板、队列面板、待办面板、上下文用量面板、MCP 面板、健康横幅、活动条，都位于输入框上方，状态来自内核                                    | 把“agent 在忙什么”集中到输入框上方，减少滚动时间线找状态。对照现有 composer 上方区域                |
| IDE-5  | 源代码管理含提交图，用 Claude 起草提交信息；Git 变更、提交框在侧边面板                                                                      | 对照现有 diff 面板与提交流程                                                                        |
| IDE-6  | 复用 VS Code 主题，编辑器、对话、侧栏同时跟随；VS Code/IntelliJ/Sublime/Atom 键位                                                           | Code Work 已用 VS Code 工作台并有 `themeSync`。键位方案是否暴露给用户需核对                         |
| IDE-7  | 调试适配器（DAP）UI、LSP、终端（自研 xterm 与 pty 子包）                                                                                    | 工作台已有这些通用能力，不重复造轮子                                                                |
| IDE-8  | SSH 远程项目：侧栏按“环境”切换，主机是一级概念，状态圆点绿/黄/红/空心；别的环境有待确认对话时在切换器上显示徽标；移除主机只隐藏项目不删对话 | Code Work 已有多环境模型。这些细节（跨环境徽标、移除不删数据、新对话默认落在当前环境）可作为检查表  |
| IDE-9  | 通知：agent 需要你或完成时发系统通知、声音与角标；关闭窗口后 agent 在托盘继续跑                                                             | 上游 T3 Code 已加线程通知、声音与桌面角标（§5）                                                     |
| IDE-10 | 自动更新、托盘常驻、Windows 安装器带 SSH 远程服务端                                                                                         | 对照桌面发布流程                                                                                    |

BaoCode 的速度优势来自原生渲染（启动约 0.18 秒、单窗口约 120 MB），这是 Flutter 与 Electron 的架构差异，Code Work 无法靠局部修改获得；能做的是减少渲染进程负担，见 §4。

## 4. 模型输出与调用更丝滑

### 4.1 现状与最大缺口

2026-10-12 已落地 `responseStreamingMode`（`turn` / `paragraph` / `token`），未配置的新环境默认 `paragraph`，Web/Desktop 与 Mobile 设置提供三态选择，`token` 标为遗留模式。显式旧键 `enableLegacyTokenStreaming: true/false` 保留为 token/turn，随后新旧客户端的明确修改均可覆盖前次选择；没有重置已有用户的明确选择。服务端通过可选 `features.responseStreamingModes` 声明支持，旧服务端的三态控制禁用。段落模式按闭合段落、围栏代码块和紧凑列表项输出，小标题与其正文一起出现；终态、工具与审批边界刷新剩余文本。具体证据与剩余增量渲染、合并、选区和性能工作见 [port-progress](./port-progress.md)。上游行为参考为 `1bbca0e782`、`c07575f573`、`b5b29e7b8b`、`a36af0637a`；实现未复制参考源码。

### 4.2 候选优化（按预期收益排序）

1. **输出模式改三态，默认段落级。** 服务端只在一个段落或一个代码块闭合后下发；紧凑列表逐项下发；流式小标题等到其下文本出现再发。收益：消息速率下降一个数量级，闪烁与重排明显减少。改动面：contracts 设置、`ProviderRuntimeIngestion`、web 与 mobile 设置页、迁移策略。注意上游用“全新键名”来重置旧用户，需决定 Code Work 是否也重置。
2. **客户端增量渲染。** 上游一系列性能提交：复用已完成的 Markdown 前缀（`a9dabbf100`）、保留已完成代码行的 DOM（`8078c532ce`）、流式期间复用时间线行（`19c1710a88`、`aefef95ffc`）、保持 Markdown 挂载不重建（`887ece3071`、`355fbd96d5`）、投影与活动追加改为增量（`c2283ce146`）、流式期间保持 turn 与检查点引用稳定（`6866fd6b5c`）、流式期间跳过检查点 map 重建（`076d753ae6`）、不用的线程流停止订阅（`d7cf8aaa8d`）；移动端同理（`44dc8ae259`、`7bd7f99e6c`）。应逐项核对 Code Work 是否包含这些修复，缺的优先补。
3. **服务端合并 + 客户端节奏揭示（Paseo 做法）。** 合并窗口是 leading + trailing：空闲后第一个 delta 立即发出，其余等尾部计时；每个 agent 每 60ms 至多一条；客户端每帧只提交一次 reducer；渲染层按积压量调节揭示速度，store 保存完整文本，只对渲染切片限速；首次看到的文本整体显示，完成后立即吸附，保证复制、选择、滚动几何读到同一份文本。缩短窗口只会让波动变小变频繁，不能解决问题。与 §4.2-1 互补：段落级降低条数，节奏揭示消除到达的块状感。
4. **流式期间选择不跳。** BaoCode 的 `LiveSelectableText` 为流入文本保持选区落在相同字符上，因为 Flutter 的 `Text` 每次变更都会重建选区，导致高亮闪烁和滑动。浏览器里对应的问题是流式重渲染破坏用户选区；Code Work 若在 Markdown 重建时丢选区，可参考其“只追加不替换节点”的思路（与 §4.2-2 一致）。

   2026-10-12，Android 的 Nitro 普通段落没有原生选区入口，新增消息旁的“选择文本”作为等价方案。独立于虚拟列表的原生 TextView 固定打开时收到的完整正文，保留 Markdown 与代码原文；流式 store 与会话几何继续更新，选择页不随尾文或终态替换。关闭并重新打开取最新全文，环境或线程切换关闭旧选区。实际配对 Android 会话已验证系统选区菜单、选中范围复制和全文复制，流式更新与最终性能的设备矩阵继续记录于 [port-progress](./port-progress.md)。Web/Desktop 保留既有 DOM 选区冻结，iOS 保留既有原生正文路径；无新增协议、权限或 provider 分支，没有复制参考源码。

5. **减少不必要的持久化与重复拷贝。** 上游：ACP 工具更新不再每个流式块都持久化快照（`10e29a26c2`）；Codex 流式文本只保留一份拷贝、外壳刷新更便宜、MCP 等待不再轮询（`c138163c8c`）；服务端读取不再在流式期间全量读消息（`e86604d337`）。对照 `ProviderRuntimeIngestion` 与 ACP 适配层。
6. **事件幂等与重连。** BaoCode 的 `seq` + 按 id/偏移应用，使重连重放安全；上游同时修了“关闭忙碌流不再断开连接”（`eac52f0087`）、“打开运行中线程时同步状态不再闪烁”（`ab70c8943f`）。2026-10-12 已修复线程订阅未立即接入实时总线、导致同步游标读取期间尾文可能丢失的竞态，旧行为红/新行为绿；线程真实 RPC 6 项与共享同步/挂载/分页/RPC 会话 43 项通过。运行正文在替换连接时保持身份和最新游标，重叠与过期序号忽略，不按文本全局去重。公共 ingestion 现按复合身份在合并前过滤最近 10000 个 canonical 事件的重投，跨窗口和终态后重投不重复入库，新的身份即使文字相同仍保留。该有界内存防护不跨服务重启；客户端网络恢复继续回放按持久化序号应用的领域事件，不重新执行 provider 命令。设备/连接全路径继续核验，见 [port-progress](./port-progress.md)。
7. **思考内容可见。** 上游 `feat(chat): show provider thinking traces`（2026-09-16）与 `feat(clients): live row shows the agent's latest thought`（2026-10-07）：运行中那一行显示 agent 最新的思考片段，减少“没反应”的感觉。Code Work 未探测到对应实现（需核对）。
8. **跨 provider 的统一回合语义。** 终态前清理瞬态行（Paseo）、`TurnStarted(unprompted)` 区分“用户发起”与“agent 自行接手后台子 agent 报告”（BaoCode）、`ActivityReported` 表示不可见的忙碌状态。三者结合后，UI 的 spinner 才不会撒谎。
9. **BYOK 调用链。** 对照 BaoCode 的翻译清单为 `modelGateway` 补兼容测试：流式分块边界、思考块与签名处理、工具调用 id 往返、`count_tokens` 估算、上游无 usage 时的兜底；账号粘滞与额度用尽切换对照 `LocalAccountPool`。
10. **性能验收口径。** Code Work 在 `agent-provider-product-comparison.md` 中已有 Web 长流的帧间隔验收；落地 §4.2-1 到 §4.2-3 后应重新测量同一口径（1280×720、1200 条活动、四组上滚/下滚各 20 页），并补桌面独立外壳与手机实机。

2026-10-13 的连续 Android 录像发现，已有缓存详情的忙碌线程重开时仍可能暂时空白。移动端已复用最近一次同窗口、同布局的实测视口，减少从零宽度开始的排版修正；仅保存一条尺寸记录，不保留额外线程流。82 项列表定向测试与纯候选目标类型检查通过。去探针录像仍记录了约 0.25 秒的初次挂载空白，因此没有把本项标为无闪烁完成，也不把录屏编码帧当成 UI 帧率。原始失败、诊断与候选记录见 [port-progress](./port-progress.md)。

随后对照完整原始基线 `d588bee5e` 加原始 98 项工作区快照，Android 24 个 UI 窗口与 FrameTimeline 校验通过，两当前轮的 16 个对应窗口三项指标均不高于基线。结合既有 Web/Desktop 生产静态证据，同口径静态性能要求已通过；原始失败记录保留，真实流式节奏、忙碌重开与连接矩阵仍独立核验，详见 [性能对照](./agent-provider-product-comparison.md)。

2026-10-12 服务端已加入 ingestion 前的 60ms leading/trailing 窗口及带可选完整正文的原子收尾，原始总线和 checkpoint 保留原包，工具/审批/终态保持顺序，非法包隔离与顺序停机纳入测试。客户端线程与环境的 UI 状态已按主机帧合并发布，原始事件仍全部进入完整状态机，缓存与游标不受显示节奏影响。三端渲染层已接入完整来源与自适应字素切片，首段全文、结束吸附、复制与全文几何分离于显示节奏；可选 `features.responseTextReveal` 一次门控可选 `responseTextPacing`，默认开启，旧环境保持原行为。Web 实际选区在未闭合段落追加与终态后保持，清除选区再追上尾文；实际代码复制与设置持久化已验收。第 5/6 项仍需 Native 选区、连接模式矩阵与最终性能证据。完整证据与 Android 构建/设备验收边界见 [port-progress](./port-progress.md)。独立实现行为，没有复制 Paseo 源码。

## 5. 与上游 T3 Code 的差距

### 5.1 同步状态

- 上次合并是 `t3code/main@b0ae3f3a8`（2026-08-27，对应 0.0.36 nightly，见 `composition-runtime-progress.md`）。之后仓库已扁平化，**当前 Code Work 与上游没有共同的 git 祖先**（`git merge-base` 无结果），不能用常规 merge 获得差异，只能按功能挑选、手工移植。
- 截至 2026-10-11，上游在该点之后新增 **2493 个提交**，其中约 381 个 `feat`、1468 个 `fix`，发布号推进到 0.0.46 preview。
- 下表“现状”列来自在 `apps`、`packages` 中对关键字做文件数统计，只能说明“有没有相关代码”，不能说明“完整程度”。凡标“需核对”都必须读代码后再决定。

### 5.2 候选移植（按主题）

| 主题       | 上游新增（日期 / 说明）                                                                                                 | Code Work 现状（探测）                                              | 建议                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 输出模式   | `responseStreamingMode` 三态，默认段落级（09-13）                                                                       | 仍是 `enableLegacyTokenStreaming` 布尔，默认开                      | P0，见 §4                                                                 |
| 回合控制   | 排队或 steer 的后续消息、客户端排队、发送快捷键、上箭头召回已发送 prompt（09-04～09-16）                                | 未探测到 steer 选择与后续消息行为设置（`steer` 一词有出现，需核对） | P1                                                                        |
| 回滚       | 回滚对话但保留文件改动（09-12）                                                                                         | `rewind` 相关代码已有                                               | 需核对是否含“保留文件”变体                                                |
| 上下文     | provider 上下文压缩命令、跨 harness 压缩、发送前压缩芯片显示 token 数、旧 Claude 线程发送时自动压缩（09-02～10-08）     | 有 compaction 相关代码                                              | 需核对发送前提示与自动压缩                                                |
| 斜杠命令   | 跨客户端暴露原生斜杠命令（09-16）                                                                                       | 有 slash commands 相关代码，含 `ByokSlashCommands`                  | 需核对是否覆盖各 provider                                                 |
| 目标       | 原生 `/goal`（Codex 与 Claude），UI 显示目标状态（10-05）                                                               | 有 `/goal` 出现的文件，需核对                                       | 需核对                                                                    |
| 问题       | agent 异步提问、可不回复直接关闭、回答可附文件、通过私密卡片请求 secret（09-03～10-05）                                 | 未探测到                                                            | P1                                                                        |
| 配额       | 订阅额度与 Limits 页、`/usage-limits`、按 provider 跨账号与环境汇总、显示剩余额度（09-03～10-11）                       | 未探测到订阅额度；已有 BYOK 余额看板                                | P2，需区分订阅额度与 BYOK 余额，见 `agent-provider-product-comparison.md` |
| 设置       | 项目级设置覆盖（`PROJECT_SCOPED_SERVER_SETTING_KEYS`）、设置按环境/项目两个选择器、默认权限、`t3.json` 限制子模块初始化 | 未探测到项目级覆盖                                                  | P1                                                                        |
| 线程管理   | 撤销结案/贪睡/归档（Mod+Z）、手动排序持久化、紧凑线程列表、侧栏紧凑栏、在另一台机器上的项目标记                         | 有 snooze 相关代码；其余需核对                                      | P2                                                                        |
| 通知       | 线程通知与声音、桌面与 Web 角标、应用内通知                                                                             | 需核对                                                              | P1，与 BaoCode 通知一致                                                   |
| 多模型     | 一次用多个模型在各自 worktree 里开线程                                                                                  | 未探测到                                                            | P2                                                                        |
| worktree   | 选择新 worktree 的位置、异步初始化脚本与逐步进度、可取消、`t3/` 短分支前缀、结案后运行项目动作                          | 未探测到“选择位置”                                                  | P2                                                                        |
| 文件与附件 | PDF/ZIP 等任意文件上传（50MB）、内联文件预览与附件芯片、HTML/PDF 查看、大段粘贴折叠为附件                               | 需核对                                                              | P1                                                                        |
| MCP        | MCP 应用在线程内渲染与运行、MCP 工具声明调用者权限、外部 agent 通过 OAuth 登录、可复制环境 MCP URL                      | 有 MCP OAuth 相关代码；其余需核对                                   | P1，注意权限边界                                                          |
| 认证权限   | 把终端观察、文件读写、源码控制写入、环境管理、浏览器预览控制等拆成独立语义权限                                          | 有 `RpcAuthorization`                                               | 需核对粒度                                                                |
| 源码托管   | 用 GitHub API 而非 `gh`、多账号路由、Forgejo/Gitea（`fj`/`tea`）、GitCafe、PR 引导式评审（10-11）、评审指南 MCP 工具    | 未探测到 GitCafe 与评审指南                                         | P2，是否需要取决于用户群                                                  |
| 模型目录   | 从远程清单发现 Claude 模型、CLI 更新解锁新模型时提示、模型收藏与可见性跨客户端同步                                      | 有模型清单 `ModelManifest`                                          | 需核对远程清单                                                            |
| 设备       | 模拟器与设备流、3D 设备工作区、远程 Mac 更新                                                                            | 未探测到                                                            | P3，非核心                                                                |
| 可观测     | 通过 OTLP 导出日志与主进程遥测、尊重 OTel 开关、诊断页配置导出                                                          | 有 OpenTelemetry 相关文件                                           | 需核对                                                                    |
| 协议兼容   | 客户端容忍未知联合成员（09-05）、provider 远程兼容范围检查                                                              | 有 `tolerate`/未知成员相关代码                                      | 需核对覆盖面                                                              |
| 其他       | 安装 `t3` 命令、`t3 update`/`restart`、WSL 后端用 Linux CLI 归档运行、服务器更新后继续活动线程、自动存储清理            | 未探测到“更新后继续线程”与存储清理                                  | P2                                                                        |

### 5.3 同步方式建议

1. 不做整体 merge。按上表主题逐项挑，每项一个 PR（一个关注点一个 PR），保留 Code Work 的品牌键与迁移，例如 `codework:` 与历史 `t3code:` 存储键。
2. 以 contracts 为先：设置、事件、RPC 的 schema 变化先落 `packages/contracts`，再让 server、web、mobile、desktop 跟随。
3. 对每个条目写明：provider 差异（每个 adapter 一个决定）、客户端覆盖（web/desktop/mobile）、连接模式（本地/远程/隧道）、反向状态（有进入就有退出）、文档位置（`docs/user/` 与 `docs/internals/`），这正是仓库 `AGENTS.md` 的“Hit every surface”清单。
4. 在 `docs/internals/` 记录“已移植/不移植”的决定，避免下次重复评估。

## 6. 综合优先级建议

| 优先级 | 事项                                                                           | 理由                                                       |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| P0     | 输出模式改三态 + 核对客户端增量渲染修复（§4.2-1、§4.2-2）                      | 直接决定“输出是否丝滑”，且上游已有成熟方案与回归测试可参考 |
| P0     | Windows argv 长度守卫（§2.1-2）；需核对哪些 provider 走 argv                   | 用户在 Windows 上，错误是确定性的                          |
| P0     | 各 Adapter 的“终态前清理瞬态行”断言（§2.2-4）                                  | 成本低，防止卡住的 spinner                                 |
| P1     | 统一 `fetchCatalog` 与缓存键、共享 deadline（§2.2-1）                          | 收敛分散探测，降低启动与刷新抖动                           |
| P1     | steer 契约与后续消息“排队/steer”选择（§2.2-2、§5.2）                           | 与 UI 行为配套                                             |
| P1     | 服务端合并 + 客户端节奏揭示（§4.2-3）                                          | 在段落级之上进一步消除块状感                               |
| P1     | 项目级设置覆盖、通知、文件附件、异步提问                                       | 日常使用价值高                                             |
| P1     | 事件幂等与重连测试（§2.3-5、§4.2-6）                                           | 稳健性                                                     |
| P2     | 能力接口细化、`prepare/release` 空闲回收、`ConfirmsModelSwitch` 第三态（§2.3） | 架构整洁与资源占用                                         |
| P2     | BYOK 导入链接与安全边界、协议翻译测试清单（§2.3-9、§2.3-11）                   | 提升 BYOK 可用性                                           |
| P2     | 配额页、多模型开线程、worktree 位置                                            | 体验增强                                                   |
| P3     | 插件化 provider、设备工作区、更多托管平台                                      | 成本高或非核心                                             |

## 7. 落地约束

- 通用约束见仓库 `AGENTS.md`：Effect 风格、contracts 先行、三端同步、反向状态、性能不可退化（不引入持续重绘的动画，避免高刷屏 GPU 占用）。
- 合同变更保持向后兼容；Paseo 的做法是“协议永远兼容，功能按 `server_info.features.*` 一次性门控”，可参考。
- 引用任何参考项目的源码前先核对许可（见 §0）。
- 验证只跑受影响文件的测试与目标 lint/typecheck，不跑全仓检查。
- 本页的“需核对”条目是后续工作的第一步，在读过代码之前不要把它们当成缺口。

### 移动端真实 UI 帧补齐（2026-10-13）

§4.2-3 的每帧发布在 Mobile 改用 `NativeFrameScheduler` 与统一 Native frame queue，绕过 RN 0.85.3 bridgeless 的零延时 rAF。实际 Android 24 组各 8 次更新合并为 24 次发布，各自对应不同 UI 帧；取消、空闲停止与返回前台的回执通过，56 项定向回归通过。Web/Desktop 保持默认浏览器时钟，协议与完整数据来源没有变化。

实测 Hermes 没有 `Intl.Segmenter`，旧文字揭示会降级为全文直接显示，不能据时钟适配宣称三端渐进文字均验收完成。该兼容缺口与真实流式矩阵继续在 [移植进度](./port-progress.md) 第 5 项追踪；原生探针已按 SHA 移除。

### Hermes 字素兼容补齐（2026-10-13）

§4.2-3 的 Native 文字节奏缺口已补齐：共享揭示器缺少原生 Segmenter 时使用固定 `unicode-segmenter 0.17.3` 字素入口，继续复用稳定前缀，不修改全局 Intl。47 项定向测试、共享/Mobile 纯候选类型及 lint 通过。真实 Android 无原生 Segmenter 时，1249 字符正文的 43 次前缀揭示均对应不同 UI 帧并保持完整字素；无 CDP 的私有文件回执保留。纯产品受控回合验证 4800 字符原生选区在追加和完成时保留，重新打开获得与 provider/持久化一致的 4833 字符全文。服务端合并与三端揭示（进度第5项）完成；增量清单和 Native 重开/锚点矩阵另随第4/8项继续，不宣称完整目标已完成。
