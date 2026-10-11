# Agent 接入与上游行为移植进度

本页是用户明确要求保留的逐项验收记录。权威范围是 [参考项目对照](./agent-adapter-reference-comparison.md) 的全部可借鉴点、上游差距候选和用户目标文件中的 39 项；不能用本页已经完成的部分重新定义目标。核对日期：2026-10-12。基线 HEAD：`d588bee5e`。

## 记录口径与工作区保护

- “已实现 / 部分实现 / 缺失”是源码基线结论；“完成 / 已具备 / 不做”是最终验收结论，两者不能混用。未运行的测试、真实 provider、真实客户端与性能测量不能写成通过。
- 本轮开始时有 98 个已有改动文件，包含 BYOK、Agent 工具、IDE、品牌和文档；已在工作区外保存字节快照、SHA-256 和原始 Git diff。新增移植不得覆盖或提交这些无关改动。
- 原目标明确要求本页，优先于仓库不保留一般临时研究清单的默认规则。临时脚本和实现计划仍放在工作区外。
- 参考克隆只读；自主实现行为和测试，不复制受限源码，不整体 merge，不提交参考目录。保留交互审批与 `runtimeMode`。
- Web 与 Desktop 共用 Web 渲染层；Mobile 使用共享 `client-runtime` 和独立 React Native 界面。服务端设置与事件均属于具体环境，本地、远程和隧道客户端消费同一协议。共享源码不等于三端真实运行已验收。

## 阶段 0：源码基线

指定文档已通读：仓库 `AGENTS.md`、本次 comparison、`paseo-multica-clean-room-architecture.md`、`workspace-ide.md`、`byok-gateway.md`、`providers.md`、`agent-provider-product-comparison.md`。下表结论来自读取实现，搜索仅用于定位。

| 编号 | 需核对事项                       | 准确现状 | 源码证据与边界                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01  | steer 契约                       | 缺失     | `provider/Services/ProviderAdapter.ts` 只有 `sendTurn/interruptTurn`，没有可选 steer 操作；`ProviderCommandReactor.ts` 处理 turn-start 请求与排队。尚无统一准入、回显对账和未读 steer 清理契约。                                                                                                                               |
| B02  | rewind 保留文件                  | 部分实现 | `contracts/src/orchestration.ts` 的 `ThreadCheckpointRevertCommand` 仅有 `turnCount`；`CheckpointReactor.ts:923` 总是先恢复文件检查点，再回退 provider 对话。Codex 支持对话回退，但缺保留文件变体。                                                                                                                            |
| B03  | 发送前压缩                       | 部分实现 | `ChatComposer.tsx:2491` 手动注入 `/compact`；`ClaudeAdapter.ts` 接收 compact boundary 和自动压缩上下文用量，BYOK 有摘要命令。没有等价的发送前压缩 token 芯片和旧线程发送提示。                                                                                                                                                 |
| B04  | provider 原生斜杠命令            | 部分实现 | `ClaudeProvider.ts:789` 从 SDK initialization commands 读取；Cursor/Grok 在会话加载时读 ACP available commands；BYOK 有独立命令表；`CodexProvider.ts:686` 仅固定 review/feedback。需要统一发现并补齐客户端与 provider 支持决定。                                                                                               |
| B05  | `/goal` 与权威状态               | 部分实现 | 有 `ThreadGoalStore`、类型化 RPC、Web `ThreadGoalStatusBar` 和 Mobile `ThreadGoalRouteScreen`；`ProviderRuntimeIngestion.ts:1423` 用 `scanGoalMarkers(text)` 决定终止，完成后清除 goal。不是 Codex/Claude 原生 hooks/会话文件状态。                                                                                            |
| B06  | 思考轨迹                         | 部分实现 | Web `MessagesTimeline.logic.ts:1287` 渲染 reasoning-summary；Mobile `threadActivity.ts:362` 明确跳过 `reasoning.summary.delta`。共用事件已存在，但最新思考与三端展示不完整。                                                                                                                                                   |
| B07  | 订阅额度页                       | 部分实现 | `usage/AccountQuota.ts` 从 Codex/Claude rate-limit 事件归一化并持久化；Web `UsageSubscriptionPanel`、Mobile `UsageRouteScreen` 使用账号额度；跨环境有 `shared/accountQuotaMerge`。当前按 provider 合并、主要展示已用，尚缺独立 Limits、跨账号身份和完整剩余视图。不是缺少所有订阅额度能力。                                    |
| B08  | 项目级设置覆盖                   | 部分实现 | `ProjectSettingsPanel` 和 Mobile `ProjectSettingsRouteScreen` 有项目默认模型、工作区模式与脚本；`orchestration.ts` project 字段不包含通用 server settings override。缺 scopable server settings、环境/项目双选择器与新线程默认权限覆盖。                                                                                       |
| B09  | 通知 / 声音 / 角标 / 托盘        | 部分实现 | Mobile `features/agent-awareness` 有通知注册、权限和导航；Web 侧栏有完成/唤醒标记；Desktop `ElectronTray` 与 `DesktopWindow.ts:600` 支持关闭窗口隐藏到托盘。缺三端统一的完成/需要输入系统通知、声音与系统角标链。                                                                                                              |
| B10  | 附件类型与预览                   | 部分实现 | 合同已有 image/audio/file 与 provider 输出二进制附件；`ChatFileAttachment` 上限沿用 10 MiB，发送上传形状主要是图片。`AttachmentUpload` 有签名上传与过期清理。缺用户任意文件 50 MB、完整 PDF/ZIP 发送与 HTML/PDF 内联预览、大粘贴文本附件。                                                                                     |
| B11  | MCP 应用渲染                     | 缺失     | `McpHttpServer` 提供 provider-scoped bearer 工具，现有 canvas/preview 不是通用 MCP Apps 的 `ui/resource` 宿主；当前客户端没有 MCP Apps 生命周期和 HTML 应用 RPC 桥。                                                                                                                                                           |
| B12  | MCP OAuth / URL / caller 权限    | 部分实现 | 已有 provider-scoped MCP 凭据与 `McpInvocationContext`；现有外部 MCP 配置/认证能力不能代替环境 MCP 的外部 agent OAuth、可复制 URL 与逐工具 caller 权限声明。需补完整入站链。                                                                                                                                                   |
| B13  | RPC 权限粒度                     | 部分实现 | `auth.ts` 的 read/operate、terminal:operate、review:write、access 与 relay scopes 已完整映射 RPC；`RpcAuthorization.ts` 把文件写、VCS、设置、浏览器控制等放在 orchestration:operate，终端观察也用 terminal:operate。缺目标要求的独立语义 scopes。                                                                              |
| B14  | 远程模型清单                     | 部分实现 | `ModelManifest.ts:33` 远程拉取清单，远程/磁盘/内置三级、TTL、并发刷新；用于现有模型 current/legacy 分类，不等于从远程发现全部新 Claude 模型。CLI 升级通知已有，模型收藏/可见性同步仍需核对补齐。                                                                                                                               |
| B15  | 协议未知联合成员                 | 部分实现 | ACP `protocol.ts:316` 有 Harn/CodeBuddy 特定扩展；其余 SessionNotification 严格解码，未知 union 变为 parse error。WebSocket 的 `OrchestrationThreadStreamItem` 同样是闭合 union。`server.ts` 已对 config issues、editor、remote targets 使用 `ForwardCompatibleArray` 丢弃未知成员，不能据此认为 thread/ACP 联合成员均可容忍。 |
| B16  | 更新后活动线程恢复               | 部分实现 | `serverRuntimeStartup.ts:530` 检查原生会话是否仍活着，孤儿会话标 error、活动 goal 暂停；Composition 有 startup recovery，但不会自动续接普通活跃 provider 线程。                                                                                                                                                                |
| B17  | 存储清理                         | 部分实现 | `attachmentStore.ts:216` 清理过期 pending/.part 上传；投影在删除/回退时清附件，checkpoint 有清理。缺按机器/项目的自动存储保留策略与用户设置。                                                                                                                                                                                  |
| B18  | 空闲会话回收与预热               | 部分实现 | provider instance 子 scope 关闭会等待其 finalizers；会话有 stopSession/stopAll，结案有条件停止。没有“空闲且不可见 release / 展示前 prepare”的统一 lifecycle 契约。不能把网络 idle timeout 当作 provider 会话回收。                                                                                                             |
| B19  | 用户消息身份与回显               | 部分实现 | `decider.ts:1023` 用 `command.message.messageId` 写唯一用户行，规范身份已具备；provider user item 不被当成助手正文。缺统一显式 `clientMessageId` 对账与 steer 回显合同，不应增加全局文本去重。                                                                                                                                 |
| B20  | 事件幂等重连                     | 部分实现 | 共享 `state/threads.ts:341` 拒绝 `sequence <= lastSequence`，`afterSequence` 续订，snapshot 重置 history epoch；server command id 保证持久幂等。已有核心序号防重，缺目标要求的完整断线/关闭忙碌流/打开运行线程定向矩阵与实际测量。                                                                                             |
| B21  | argv 与 Windows 路径             | 部分实现 | `AntigravityAdapter.ts:203` 用 `-p prompt`；`ZCodeAdapter.ts:578` 用 `--prompt=text`，其余主传输为 SDK/stdio/HTTP。已有 resolveSpawnCommand 分 `.cmd` 与 exe，但未做 prompt 三层长度守卫。                                                                                                                                     |
| B22  | IDE 键位 / 线程管理 / 可观测补充 | 部分实现 | 工作台有 VS Code keybinding service 与应用快捷键编辑器，未见 IntelliJ/Sublime/Atom 方案选择；线程有结案/贪睡/归档和手动排序设置，但全入口撤销与跨机器标记待补；`observability/Layers/Observability.ts` 已按配置导出 OTLP trace/metrics，需继续核对主进程日志、总开关与诊断导出。                                               |

“缺失”只针对该行描述的行为，不是否定其相邻能力；以上是静态源码核对，不是功能完成验收。

## 阶段 1—5：完整交付与验收台账

| 项  | 主题                                                        | 当前状态                                     | 实现 / 验收入口                                                                                | 验证结果                                                                                                              |
| --- | ----------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 通读指定文档与约束                                          | 完成                                         | 上述七篇文档、根 AGENTS                                                                        | 2026-10-12 完整阅读                                                                                                   |
| 2   | 全部需核对条目源码基线                                      | 完成                                         | B01—B22                                                                                        | 已读取源码并明确边界；不把静态核对当成实现完成                                                                        |
| 3   | 三态输出、默认 paragraph、旧键策略、三端设置                | 完成（本主题定向验收）                       | settings / AssistantTextBuffer / ProviderRuntimeIngestion / Web/Desktop 设置 / Mobile 设置     | 工作区 10 文件 / 273 项通过；纯暂存候选 35 项与五个目标类型检查通过；当前脏工作区的完整模块诊断仍记录为未通过，见下文 |
| 4   | 全部客户端增量渲染清单与上游对应提交                        | 部分完成，继续补齐                           | 闭合 Markdown 前缀 / 固定 Web 渲染身份 / 逐行高亮 / 共享回合与检查点引用 / Mobile 块键         | 8 文件 / 188 项通过；Web DOM 追加与终态选区保持；完整清单见下文，未完成项保留                                         |
| 5   | 60 ms leading+trailing、每帧提交、完整 store 与揭示切片     | 合并、按帧发布与三端切片已落地，最终验收开放 | ProviderRuntimeEventCoalescer / ProviderRuntimeIngestion / latestFrame / textReveal / 三端渲染 | 节奏开关、首段全文、字素边界、完成吸附及全文复制与几何已覆盖；Native 与最终性能仍开放                                 |
| 6   | 流式选区与滚动锚点                                          | Web 代码及普通文字已验证，其余继续验收       | 真实 StreamingChatMarkdown 临时交互夹具 / Mobile 原生 Markdown                                 | 未闭合段落追加、终态与清除选区均保持既有节点；滚动锚点与原生设备仍待矩阵验证                                          |
| 7   | 每个 adapter 终态无 loading                                 | 在途条目已补齐，交互边界继续验收             | 共享 runtimeTurnItems / 全部 canonical 发射入口 / Codex 原生映射                               | 13 份 adapter/driver 文件 311 项通过；终态、Codex 与 ingestion 补充 163 项通过；详细边界见下文                        |
| 8   | 重连不重不丢不乱、关闭忙碌流、打开运行线程                  | 订阅竞态已修复，继续验收完整矩阵             | ws 立即订阅 / state/threads / 运行中正文与缓存游标                                             | 真实 RPC 订阅 6 项、共享同步/挂载/分页/RPC 会话 43 项通过；设备与原始 provider 回放继续核验                           |
| 9   | 同口径帧间隔性能无回归                                      | 本增量通过，阶段最终仍需复测                 | 1280×720、1202 活动、上下各 20 页 ×4 组                                                        | 2026-10-12 修改前后 p95 均 16.8 ms；滚动窗口最大 66.7→50.0 ms，最高窗口 >50 ms 数 1→0；后续改变渲染仍须重跑           |
| 10  | Windows argv 三层守卫                                       | 待实施                                       | Antigravity / ZCode / resolveSpawnCommand                                                      | 尚未运行                                                                                                              |
| 11  | 统一 catalog、缓存键、deadline、AbortSignal、无草稿 session | 待实施                                       | ProviderDriver / provider snapshot 探测                                                        | 尚未运行                                                                                                              |
| 12  | steer 全契约与排队/steer UI                                 | 待实施                                       | ProviderAdapter / ProviderService / reactor / 三端 composer                                    | 尚未运行                                                                                                              |
| 13  | 规范消息身份与回显对账                                      | 待核验补齐                                   | decider / normalizer / provider echo                                                           | B19 为部分底座，验收尚未运行                                                                                          |
| 14  | 细化 rewind/streaming/reasoning/MCP/persistence/切模型能力  | 待实施                                       | ProviderAdapterCapabilities / server config / 三端控制                                         | 尚未运行                                                                                                              |
| 15  | prepare/release/dispose 完全停止                            | 待实施                                       | 生命周期与可见性报告                                                                           | 尚未运行                                                                                                              |
| 16  | managed-process registry 身份核验与启动对账                 | 待实施                                       | provider process / persistence / diagnostics                                                   | 尚未运行                                                                                                              |
| 17  | ACP 配置驱动收敛与 help flags                               | 待核验补齐                                   | GenericAcpDriver / AcpRegistryCatalog / ACP transport                                          | 尚未运行                                                                                                              |
| 18  | 草稿无 session、MCP 失败关闭、options/profile 深度合并      | 待核验补齐                                   | 探测 / MCP 注入 / settings 配置                                                                | 尚未运行                                                                                                              |
| 19  | 排队、快捷键、召回、异步问题、文件回答、secret              | 待核验补齐                                   | Web/Mobile composer / 用户问题 RPC                                                             | 尚未运行                                                                                                              |
| 20  | 原生/跨 harness 压缩、发送前 token 芯片、旧线程提示         | 待实施                                       | B03 / 上下文控制                                                                               | 尚未运行                                                                                                              |
| 21  | Codex/Claude 原生 goal 与权威状态                           | 待实施                                       | B05 / provider hooks 或会话状态                                                                | 尚未运行                                                                                                              |
| 22  | 项目设置覆盖、双选择器、默认权限、子模块限制                | 待实施                                       | B08 / CodeworkProjectFileLoader / ProjectSetupScriptRunner                                     | 尚未运行                                                                                                              |
| 23  | 全入口撤销、排序、通知角标、远端项目标记                    | 待核验补齐                                   | Sidebar / Mobile shelves / 通知服务                                                            | 尚未运行                                                                                                              |
| 24  | 50 MB 任意附件、HTML/PDF 预览、大粘贴折叠                   | 待实施                                       | B10 / assets / 三端附件                                                                        | 尚未运行                                                                                                              |
| 25  | MCP Apps、caller scopes、外部 OAuth、URL                    | 待实施                                       | B11 / B12                                                                                      | 尚未运行                                                                                                              |
| 26  | 独立语义权限                                                | 待实施                                       | B13 / auth / RPC/MCP                                                                           | 尚未运行                                                                                                              |
| 27  | Limits、跨账号环境、剩余额度与 provider 接入                | 待核验补齐                                   | B07 / AccountQuota / quota merge / 三端用量                                                    | 尚未运行                                                                                                              |
| 28  | worktree 位置、可取消异步初始化、分支前缀、结案动作         | 待核验补齐                                   | VCS / setup script / composer bootstrap                                                        | 尚未运行                                                                                                              |
| 29  | 远程目录、新模型提示、收藏可见性同步                        | 待核验补齐                                   | B14 / ModelManifest / provider update / settings                                               | 尚未运行                                                                                                              |
| 30  | 更新续接、按机器项目清理、未知 union、远程兼容范围          | 待实施                                       | B15 / B16 / B17                                                                                | 尚未运行                                                                                                              |
| 31  | BYOK 翻译兼容五项清单                                       | 待核验补齐                                   | modelGateway / AnthropicBridge / ResponsesBridge                                               | 尚未运行                                                                                                              |
| 32  | 账号粘滞、额度切换、记忆容量                                | 待核验补齐                                   | LocalAccountPool / modelGateway 本地线路                                                       | 尚未运行                                                                                                              |
| 33  | 回环随机端口、每运行令牌、请求时密钥                        | 待核验补齐                                   | CliProxy / LocalGatewayKey / modelGateway                                                      | 现网关复用 HTTP listener、令牌持久化；尚未满足全部要求                                                                |
| 34  | fragment 四字段导入、重复来源选择                           | 待实施                                       | Desktop deep link / Web/Mobile 导入 / server import                                            | 尚未运行                                                                                                              |
| 35  | StepFolds 与编辑/子 agent/计划边界                          | 待核验补齐                                   | MessagesTimeline.logic / Mobile threadActivity                                                 | 尚未运行                                                                                                              |
| 36  | 富文本代码行引用、句内附件、大粘贴                          | 待核验补齐                                   | Composer / IDE 选区桥 / Mobile composer                                                        | 尚未运行                                                                                                              |
| 37  | composer 上方状态集中与真实来源                             | 待核验补齐                                   | goal / queue / context / health                                                                | 尚未运行                                                                                                              |
| 38  | 系统通知、声音、角标、托盘后台                              | 待核验补齐                                   | B09 / Desktop IPC / Web / Mobile awareness                                                     | 尚未运行                                                                                                              |
| 39  | 跨环境徽标、移除只隐藏、默认当前环境                        | 待核验补齐                                   | 环境注册表 / 选择器 / 项目与草稿状态                                                           | 尚未运行                                                                                                              |

## comparison 中未被编号遗漏的候选

这些候选仍属于完整目标，不因优先级低而自动排除。

| 对照条目                            | 状态 / 决定 | 依据与下一验收入口                                                                                                                    |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1 纯文本 CLI artifact 兜底       | 不做        | 当前支持的 provider 均有结构化 SDK/stdio/HTTP/stream-json；原文仅在确实支持纯文本 CLI 时要求。不能为了兜底扫描任意 agent 输出并落盘。 |
| §2.1 全局免交互放权                 | 不做        | 原文明确“不要照搬”，与交互审批和用户横切要求冲突。                                                                                    |
| §2.2 provider 插件化 SDK            | 待核验补齐  | 当前注册 driver 与本地 UI 插件不等价；须在既有注册表与安全模型内实现或给出经行为核对成立的决定。                                      |
| §2.3 transcript 投影与版本缓存      | 待核验补齐  | 已有事件溯源；随第 4/8 项核对去重、稳定引用和缓存。                                                                                   |
| IDE-2 checkpoint 移出 `.git`        | 不做        | 原文要求先不迁移；保留隐藏 refs，随第 14/28 项核对只读仓库、worktree 和远程边界。                                                     |
| IDE-5 SCM 提交图与 agent 起草       | 待核验补齐  | Git 与工作台能力可复用；需核对提交图、起草入口和三端边界。                                                                            |
| IDE-6 主题与键位方案                | 待核验补齐  | 已有 themeSync 和快捷键编辑；需核对预设方案与用户入口。                                                                               |
| IDE-7 DAP/LSP/终端                  | 待核验补齐  | 不重复造工作台底座；核对实际入口、远程和 Mobile 的决定。                                                                              |
| IDE-10 更新/安装器/SSH 服务端       | 待核验补齐  | 现有桌面发布与 SSH 能力需读链路，不以构建代替安装/更新验收。                                                                          |
| §4.2 减少 ACP 持久化与流式全量读取  | 待核验补齐  | 随第 4/5 项核对 ingestion、projector 和 ACP 快照写入。                                                                                |
| §4.2 unprompted/不可见忙碌语义      | 待核验补齐  | 随第 7 项核对 native 后台报告与终态。                                                                                                 |
| §5.2 多模型各 worktree 开线程       | 待核验补齐  | 须复用 bootstrap 和模型选择，三端明确入口。                                                                                           |
| §5.2 托管平台与 PR 评审指南         | 待核验补齐  | 核对现有 GitHub API/多账号/Forgejo/Gitea 等支持，不以关键字决定缺失。                                                                 |
| §5.2 设备与远程 Mac 更新            | 待核验补齐  | 低优先级不是排除理由；必须给出源码与适用边界。                                                                                        |
| §5.2 OTLP/主进程遥测/诊断导出       | 待核验补齐  | B22 已确认服务端 trace/metrics 底座，日志与客户端诊断仍须补齐。                                                                       |
| §5.2 CLI install/update/restart/WSL | 待核验补齐  | CLI 与 service launcher 链路需逐项验证。                                                                                              |

## 验证与完成门禁

### 第 3 项：三态回复输出

- 未配置的环境由共享 `resolveResponseStreamingMode` 解析为 paragraph；可选新字段不破坏旧环境配置解码。显式旧键 true/false 继续对应 token/turn，新旧客户端交替写入时明确的最后一次选择生效。新模式写入同步旧布尔值，恢复默认明确写 paragraph。
- 缓冲只扫描新到的行。段落、反引号/波浪号围栏、引用和缩进代码块按闭合边界输出，ATX/setext 小标题与正文一起出现；紧凑列表确认下一项正文时发出上一项，嵌套项归属父项。长代码块不会被原 24K 溢出规则提前切开；完整回复模式也保留整个消息。终态、工具、审批边界仍刷新尾段，中途切 token 先发已有缓存，完成事件的全文回显不会重复已发前缀。
- Web/Desktop 共用通用设置选择器与恢复默认入口，Mobile 在对应服务器设置中选择三态；token 文案标为遗留模式。服务端 `getConfig` 返回可选 `features.responseStreamingModes`，两端只对声明支持的环境发新字段，缺失声明的旧服务端控制禁用。设置搜索保留原锚点并加入段落/完整回复/遗留关键词。
- 所有现有 provider 的标准 assistant 增量均经过同一 ingestion 层，三态不依赖特定 adapter，保留 provider 原生消息/工具边界与交互审批。协议与服务器设置按环境生效，本地/远程/隧道的客户端消费相同文本事件；没有新增聊天、命令面板或快捷键专属控制。反向状态是切换任意其它模式或恢复 paragraph。用户说明：[回复输出方式](../user/assistant-output.md)。

本次定向验证（2026-10-12）：

| 命令 / 范围                                                                                                                                                                                                                                                                                           | 结果与边界                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vp test run apps/server/src/provider/ModelManifest.test.ts apps/server/src/usage/AccountQuota.test.ts packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                                       | 3 文件 / 54 项通过；仅基线模型清单、额度与 reducer，不代表新增功能已验收                                                                                                                                           |
| `vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts apps/web/src/components/settings/ResponseStreamingModeControl.test.tsx apps/web/src/components/settings/settingsSearch.test.ts` | 5 文件 / 231 项通过；当时尚未载入新增的 7 项事件链测试                                                                                                                                                             |
| `vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t '模式通过\|paragraph 模式\|回合中从\|long\|oversized\|长回复'`                                                                                                                                                  | 8 项通过 / 98 跳过；三态分段、全文回显、失败/取消、中途切换与长回复，使用 worker drain，没有新增等待轮询                                                                                                           |
| `vp test run apps/server/src/orchestration/AssistantTextBuffer.test.ts packages/contracts/src/settings.streaming.test.ts packages/shared/src/serverSettings.streaming.test.ts apps/web/src/components/settings/ResponseStreamingModeControl.test.tsx`                                                 | 4 文件 / 27 项通过；围栏、标题、列表、缩进代码、任意切片、兼容 patch 与 Web 控制禁用状态；随后新增的 features 解码测试另行通过                                                                                     |
| `vp test run apps/mobile/src/features/settings/SettingsServerRouteScreen.streaming.test.ts apps/mobile/src/features/settings/SettingsServerRouteScreen.logic.test.ts packages/contracts/src/settings.streaming.test.ts`                                                                               | 3 文件 / 19 项通过；Mobile 三态 patch 与旧环境能力门控、现有后台活动逻辑、新字段和 features 解码                                                                                                                   |
| 上述所有本主题相关测试合并运行（10 个文件）                                                                                                                                                                                                                                                           | 最后一次完整定向运行 273 项全部通过，包含新增事件链与全部缓冲边界用例；未运行全仓测试                                                                                                                              |
| `vp lint` 精确列出的本主题 17 个 TS/TSX 文件                                                                                                                                                                                                                                                          | 退出码 0，无诊断；不检查全仓                                                                                                                                                                                       |
| 扩展到全部 22 个涉及的 TS/TSX 文件                                                                                                                                                                                                                                                                    | 退出码 0；现有 `settings.test.ts` 中四条 inline-schema 编译警告；纯暂存候选中两条原 HEAD 已有警告，不属于新模式实现                                                                                                |
| `tsgo --noEmit`，分别在 `packages/contracts`、`packages/shared` 执行                                                                                                                                                                                                                                  | 均退出码 0；shared 有一条已有的类型查询建议，不是错误                                                                                                                                                              |
| `tsgo --noEmit`，分别在 `apps/server`、`apps/web` 执行                                                                                                                                                                                                                                                | 未通过：server 的 AgentHooks/AgentMemory/WebSearch、ToolBroker、ByokAdapter 中有诊断，Web 的 WorkspaceLayout/useResizableWidth/AgentToolsSettings 中有诊断；本主题增量文件没有剩余诊断。不能写成模块类型检查已通过 |
| `tsc --noEmit`，在 `apps/mobile` 执行                                                                                                                                                                                                                                                                 | 未通过：已有 `SettingsByokRouteScreen` 的 847/866 行导航参数不匹配；本主题文件没有诊断                                                                                                                             |
| 纯暂存候选的五个目标类型检查                                                                                                                                                                                                                                                                          | contracts/shared/server/web 用 `tsgo --noEmit`，Mobile 用 `tsc --noEmit`，全部退出码 0；只包含本主题文件及其传递依赖，排除无关测试                                                                                 |
| 纯暂存候选的五个新增测试文件                                                                                                                                                                                                                                                                          | 35 项通过；Vite 工作区包别名固定到候选源码，没有借用主目录的未提交包源码                                                                                                                                           |
| 纯暂存候选的 ingestion 事件链定向测试                                                                                                                                                                                                                                                                 | 8 项通过 / 98 跳过；再次确认该主题可脱离此前未提交的源码运行                                                                                                                                                       |
| 纯暂存候选的 `vp fmt`（22 个 TS/TSX 文件）                                                                                                                                                                                                                                                            | 通过；仅把本主题五个文件中的新增关键词/文案格式补丁回写主目录和暂存区，没有格式化原有无关改动                                                                                                                      |

候选用 `git checkout-index` 导出到工作区外，仅包含 HEAD 加精确暂存的本主题改动；第三方依赖只复用已安装目录。独立临时配置使用源码别名与目标文件清单，并关闭 composite/incremental 的导出目录记账（避免路径别名导致 TS6307）；其余应用编译选项与 Effect 诊断保留。这些临时配置和脚本不提交。

以上为第 3 项提交时的证据；当时三端设置操作、真实 provider 联调与帧间隔回归尚未运行。下方第 4 项增量已补 Web Markdown 交互和新帧间隔数据。当前脏工作区的完整模块检查问题仍开放，不能将“纯候选定向类型检查通过”写成“当前工作区完整模块通过”。完整目标仍未完成。

- 后端行为变更必须带定向测试；前端带定向测试或真实集成验证。使用仓库本地 `node_modules/.bin/vp.cmd`，只跑触及文件和目标 lint/typecheck，不跑全仓检查。
- 每个实现主题必须附 Web/Desktop/Mobile、全部 provider 的支持决定，本地/远程/隧道、聊天/设置/命令面板/快捷键适用入口、反向状态和用户文档位置。
- 性能必须有修改前/后的同环境测量；本次增量见下方记录，后续影响渲染仍需复测。Web 代码选区已验证；完整选区矩阵、滚动锚点和 Mobile/独立 Desktop 的真实运行仍未验收。
- 一个主题一个 conventional commit，精确暂存；不把初始脏文件整份加入提交。当前未创建 PR、未推送、未部署。
- 只有第 1/2 项全部核对、阶段 1—5 每项完成或有成立的不做理由、所有定向测试与目标 lint/typecheck 通过、性能无回归、文档与实际行为一致，才可宣布完整目标完成。当前目标未完成。

## 第 4 项：Markdown 与共享元数据的可验收增量

此增量对应上游行为约束，自主编写实现与测试；只阅读参考提交的变更范围和行为测试，没有复制参考实现。以下子项分别记录，不能据部分完成把第 4 项整体标为完成。

| 子项 / 参考提交                              | 当前结果                                     | 证据与剩余边界                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完成 Markdown 前缀 / `a9dabbf100`            | Web/Desktop 与 Mobile 解析缓存已补；设备待测 | Web 包装现有解析器冻结闭合顶层块。Mobile 的 `nativeMarkdownPrefixCache.ts` 复用闭合段落、标题和围栏，按 UTF-8 字节平移尾部，保留原生位置占位值；引用定义、文本替换和无法可靠定位的空代码采用完整解析。iOS 接原生选区组件，Android 聊天接 `IncrementalMarkdown` 的 `sourceAst`。 |
| 完成代码行 DOM / `8078c532ce`                | Web 已完成；iOS 身份与异步高亮已补，设备待测 | Web 由 Shiki tokens 构造 React 行节点，比较文字及颜色/字体而复用完成行，移除整段高亮 HTML 替换。iOS 高亮等待期间沿用已着色行并追加普通尾部；块键不包含不断增长的 `end`。Android 独立回退路径和原生选区尚需验证。                                                                |
| 时间线行复用 / `19c1710a88`、`aefef95ffc`    | Web 基础与 Mobile 正文/活动复用已实现        | Web 稳定行测试覆盖折叠/活动/正文；Mobile selector 在正文更新与单调活动追加中复用历史行、活动与回调。1200 活动正文零重读，追加旧字段读取少于 20 次，已展开的其他工具行同引用；实际设备矩阵待验收。                                                                               |
| 回合/检查点引用 / `6866fd6b5c`               | 共享 reducer 已补齐文本 delta 路径           | `threadReducer.ts` 在字段不变时复用 `latestTurn`；没有需要重绑的 checkpoint 时沿用原数组与条目。测试验证连续 delta、完成状态与新消息绑定更新，不冻结实际元数据变化。Web/Desktop/Mobile 共用该 reducer。                                                                         |
| Markdown 挂载 / `887ece3071`、`355fbd96d5`   | Web 固定身份；Mobile 块身份已补              | Markdown renderer 回调通过 context 更新，供 ReactMarkdown 使用的组件身份固定。真实 ChatMarkdown 交互夹具验证流式追加和 streaming→false 后段落及第一行代码节点相同。Mobile 块及嵌套节点的键保留起始位置，不再使用变化的结束位置。                                                |
| 投影/活动追加 / `c2283ce146`                 | 客户端、服务端消息与活动已增量；摘要继续核验 | 共享 reducer 保留首次快照规范化、迟到插入、重复替换和用量淘汰；Mobile 仅派生新事件并复用历史行。服务端消息在 SQLite 原子追加/替换；内存活动尾追加/二分插入保留缺省序号在前和 500 条上限。用户/计划/生命周期摘要读取继续核验。                                                   |
| 跳过 checkpoint map / `076d753ae6`           | Web 检查点与用户回退 map 已补；Mobile 待核对 | 检查点推导使用稳定数组；`revertTargets.ts` 的线程私有 selector 只在可见消息身份/角色/顺序、检查点元数据或失败回退状态变化时重建。正文与活动 delta 保留 map 引用，不再次读取历史检查点；新检查点、回退和错误恢复仍即时更新。Mobile 派生仍需核对。                                |
| 无用线程订阅 / `d7cf8aaa8d`                  | 共享运行时生命周期已实现，真实连接矩阵待验收 | 实时详情与所有派生 atom 在最后一个消费者退出后释放；内容、分页边界与重放游标由 registry 内的纯数据节点成对保留 5 分钟。定向挂载测试覆盖共享、取消、忙碌缓存、重放去重、到期、分页取消、持久化补写和旧作用域；真实 provider、relay/tunnel 和移动设备仍待验收。                   |
| Mobile 同步核对 / `44dc8ae259`、`7bd7f99e6c` | 渲染与活动目标用例已落地；原生验收继续       | 共享 reducer、块键、双路径解析缓存、正文和活动 feed/展示复用已覆盖定向测试；iOS/Android 异步高亮复用完成行，全文与当前尾部保留。Android 原生 TextView 选区和设备帧率仍须实际验证。                                                                                              |

Web/Desktop 使用相同 Markdown 实现；共享 reducer 适用于所有 provider 的标准消息事件。本地、远程和隧道通过现有消息合同获益，未新增 RPC、设置或能力门控，也未改变 provider 审批。聊天、历史与预览中的共用 Markdown 入口保持原行为；运行模式切换、回复完成、文本替换和迟到引用仍更新实际内容。用户说明更新在 `docs/user/assistant-output.md`。

### 定向验证与运行证据

- 本增量 8 个测试文件共 188 项通过：Web 前缀缓存、代码行、现有 ChatMarkdown、列表恢复、时间线逻辑/性能；Mobile 原生 Markdown 工具函数；共享 thread reducer。未运行全仓测试。
- 仅暂存的 15 文件候选导出到工作区外，工作区包与原生 Markdown 模块的 151 个别名均固定到候选源码；同一 188 项全部通过。Web、Mobile 与 client-runtime 的目标类型检查均通过，12 个 TS/TSX 的目标 lint 无诊断、格式检查通过。Web 定向配置显式载入既有 Node/Vite 环境类型以覆盖剪贴板 hook 的 `NodeJS.Timeout`；未修改产品编译配置。
- 真实 Web 浏览器的临时交互夹具使用实际 `ChatMarkdown`、应用 atom registry 和高亮器。选中 `const stable = 1;` 后追加代码行，再结束回复：`paragraphSame=true`、`lineSame=true`，`selectionBefore` 与 `selectionAfter` 相同。该证据证明渲染路径，不代表真实 provider 或原生设备联调。
- 1280×720 / 1202 活动 / 上下各 20 页 ×4 组的修改前后复测无回归：稳态 p95 16.8 ms；八个滚动窗口最高 p95 16.8 ms；最大间隔 66.7→50.0 ms；单个窗口 >50 ms 的最高数量 1→0。原始间隔保存在工作区外的 `rendering-baseline.json` 与 `rendering-post.json`；冷启动预热差异和窗口重叠边界见 `agent-provider-product-comparison.md`。
- 临时测量脚本与交互面板只在隔离 `.t3/port-rendering` 中运行，入口受开发模式和查询参数限制；测量后恢复 `apps/web/src/main.tsx` 的原始字节。夹具数据库仅用于 UI，未写实时用户数据库或事件日志。临时脚本、配对 token 和截图不提交。
- 另补第 3 项真实 Web 设置操作：初始显示按段落，依次选择完整回复、遗留 token、按段落；每次均检查服务端隔离 `settings.json` 的真实持久值，最后恢复按段落。Desktop 共用该控制；独立 Electron 和原生 Mobile 设置页面仍未实机运行。
- 当前工作区完整 Web 类型检查仍报告既有 `WorkspaceLayout/useResizableWidth` 和 `AgentToolsSettings` 问题；Mobile 完整检查仍报告既有导航/Stack 类型问题。新增源文件和测试须另由纯候选目标检查证明，不把全模块失败遮掩为通过。

### 第 4 项后续增量：移动端前缀解析与共享活动排序

- 本次复用已安装 `react-native-nitro-markdown@0.5.8` 的 MD4C 核心进行 Windows C++ 对照，不更改依赖源码，也不复制参考项目实现。22 组正文在每个 UTF-16 增量边界比较完整 AST，覆盖中文/emoji、LF/CRLF/CR、围栏、列表、表格、HTML、后置定义和空代码行，全部通过。代码块和行内代码的数组方括号不会禁用前缀复用；原生 AST 未保留链接来源类别，实际链接/图片和未解析方括号保守地解析全文。普通 CI 测试使用自行生成的 32 份原生 AST 样本，不要求额外编译器。
- Web 另发现单个 CRLF 被正则回溯拆成两个换行的错误：新增测试先失败，同一段落被错误分开；限制单独 CR 的匹配后，9 项 Web 前缀测试全部通过。Mobile 同样拒绝这种错误分隔。
- 当前主目录与纯暂存候选的 7 个定向测试文件共 158 项全部通过。共享 reducer 包含 1200 条活动、旧快照规范化、迟到插入、同序号按时间/ID 排序、重复替换与历史引用保留；正常追加读取历史排序键少于 20 次，迟到插入少于 30 次。原有上下文用量淘汰用例继续通过。
- 本次 14 文件候选的工作区依赖仍固定到候选源码，10 个 TS/TSX 的 lint 无诊断，源文件与样本格式检查通过。Web/client-runtime 用 `tsgo --noEmit` 通过；Mobile 使用项目声明的 `tsc --noEmit` 通过，临时目标配置还载入现有 `Stack.tsx`，以包含导航参数表的类型增广。`tsgo` 在同一 Mobile 范围出现导航 `never` 诊断，不能计为通过；未改产品编译配置或导航实现。
- 新模块建立后，使用 `vp install --frozen-lockfile --offline --ignore-scripts --filter '@codework/mobile...'` 刷新现有注入式工作区依赖，没有下载或修改清单/锁文件；没有执行安装生命周期脚本。
- 同一 1280×720 / 1202 活动 / 上下各 20 页 ×4 组复测：稳态及八窗口最高 p95 仍为 16.8 ms，八窗口最大 50.1 ms，单窗口 >50 ms 的最高数量为 1；与原始 `7ffa6f2b4` 基线的 66.7 ms / 1 对照没有持续帧间隔回归。前一增量为 50.0 ms / 0，本次边界多出一帧，不能宣称完全重复该较小数值。窗口可能重叠，虚拟列表测量后的完整高度由 42445 变为 41905 px；不据此认定行高或滚动锚点已全部验收。原始数据为工作区外 `native-rendering-post.json`，临时入口已恢复原始字节。

此证据不代表实际 Nitro 绑定、UIKit 选区或 Android 设备验收。第 4、6 项仍未整体完成，第 9 项最终门禁仍开放。接下来继续核验 Mobile feed、派生 checkpoint map 和线程订阅，再推进第 5 项节奏合并与第 7/8 项事件状态矩阵。

### 第 4 项用户回退 map 的增量核验

Web/Desktop 的 `ChatView` 使用每个作用域线程独享的回退目标 selector，消息正文、思考和工具活动变化不重建 map。回退目标继续使用用户消息之后、下一个用户消息之前的首个对应检查点；缺少计数时不能越过该检查点选择后续回合。失败只为没有检查点的最后用户消息提供清除入口，错误恢复后移除。未新增 RPC 或能力声明，所有 provider 的标准时间线共享该逻辑；本地/远程/隧道和聊天/历史入口一致，Mobile 的对应派生尚待核对。

`revertTargets.test.ts` 的五项用例已通过，覆盖正文增量不读检查点、计数更新、回合边界、失败恢复和消息加入/删除/重排/角色变更。上方帧间隔记录覆盖此前的移动端解析与活动追加增量，本次 map 改动须在后续第 9 项完整验收时复测。

纯暂存候选连同既有时间线逻辑/性能测试共 3 文件 / 71 项通过，Web 目标 `tsgo --noEmit`、3 个源文件的 lint 和 6 文件格式检查通过。候选依赖继续固定到自身源码；`ChatView` 只暂存本主题两处改动，原有 BYOK 压缩与 IDE 改动保留在主目录。内部 selector 使用所需的最小检查点输入形状以覆盖既有缺少计数时的推导边界，没有改变线上的合同解码。

真实 Web 刷新后，隔离线程的历史、代码块与发送入口可见，环境连接恢复；仅为入口与已完成历史的集成观察，没有执行回退，也不能据此通过运行中线程不闪烁的第 8 项。

### 第 4 项线程订阅生命周期的增量核验

共享运行时把实时详情与缓存分开：所有仍挂载的消费者共享一条详情订阅，最后退出后立即安排释放，所有派生详情 atom 同步结束持有；隐藏但仍挂载的消费者继续计入持有者。registry 内的缓存保留内容、分页边界和重放游标 5 分钟，不持有网络订阅。短时间内重新打开运行线程，先显示内存缓存，再用 `afterSequence` 追赶；磁盘仍只保存已停止运行的线程。Web/Desktop 与 Mobile 共享此状态实现，未修改 RPC 合同和 provider adapter，也没有新增旧服务器无法识别的能力字段。

退出先停止详情、连接状态观察、分页和后台持久化，再补写最终快照。已成功保存且内容/游标/分页边界未变的快照不重复写入；后台保存失败仍在退出尝试补写。新旧详情作用域在最终写入期间可能重叠，共用缓存节点的写入锁防止新快照先落盘后被旧补写覆盖；所有者身份防止旧作用域覆盖新内存缓存。释放详情没有调用共享环境连接的 `disconnect`，不向 provider 发送中断命令。

- 新增 8 项实际挂载行为测试，另保留 atom 身份用例；覆盖多消费者、忙碌线程缓存与配对游标、重复序号忽略、5 分钟到期、registry/环境隔离、分页取消与边界恢复、后台/最终保存、写入失败重试和旧作用域晚完成。scheduler 任务显式排空，虚拟时钟仅用于 TTL/debounce，不依赖真实等待或轮询。
- 使用 `875f8b539` 原实现替换纯候选中的三个状态源文件运行对照，最后消费者退出后取消订阅用例失败；恢复修复版本后，共同运行线程同步、历史分页与实体投影的 4 文件 / 42 项全部通过。候选依赖均固定到候选源码；共享运行时目标 `tsgo --noEmit`、4 文件 lint 无诊断。
- 隔离真实 Web 中从详情进入草稿页，再打开原历史线程，标题、601 次检查的完成记录、代码块和发送入口恢复，未出现断开提示。该观察覆盖已完成线程的入口恢复，没有启动本轮真实 provider；不据此通过运行线程、relay/tunnel、桌面外壳或移动设备的第 8 项完整矩阵。

此改动与此前回退 map 均尚未纳入最终第 9 项帧间隔验收。Mobile feed 稳定引用、Android 已完成代码行与设备选区仍开放，第 4 项整体继续保持部分完成。

### 第 4 项移动端正文 feed 与展示复用

`useThreadComposerState` 为每个环境/线程创建独享的 feed selector，本地反馈消息单独推导，正文变化不重建反馈对象。活动集合、加载窗口、消息身份/排序/可见性和语言不变时，只替换变化的消息行，保留历史工具组、展开与复制回调。`ThreadFeed` 的展示 selector 复用折叠、工具和工作指示行；回合终态、已结束消息时间、展开控制和分组改变时重新推导。重复消息身份不做全局去重，按既有排序语义回退；环境切换重新创建两个 selector，避免跨环境混用同名线程。

新增 7 项行为用例覆盖 1200 活动正文更新零历史重读、历史与回调身份、本地反馈、空白/附件可见性、新增/移除/重排/重复身份、窗口/活动/线程/语言变化、折叠/展开/终态/工作指示变化；当前主目录的 `threadActivity.test.ts` 共 48 项通过。纯候选与共享 reducer 的两文件共 90 项通过，Mobile 项目指定的 `tsc --noEmit`、4 源文件 lint 和 7 文件格式检查通过；候选载入现有 `Stack.tsx` 的导航类型增广，未修改产品编译或导航配置。

另运行实际 `features/threads/thread-feed-live-follow.test.ts` 的 12 项列表跟随测试通过，三份定向文件合计 102 项。没有运行仓库级测试，也没有把纯候选类型检查算作当前脏工作区全模块通过。

活动集合改变时仍使用现有完整活动推导，因此本增量只证明正文流式路径与展示复用；不能据此宣称移动端活动追加全链路或实际设备帧率已验收。Android 已完成代码行、真实选区、第 8 项连接矩阵及第 9 项最终复测继续开放。

### 第 4 项移动端活动追加与历史行复用

后续增量补齐上述活动集合变化路径。活动源前缀身份不变且新增事件在排序尾部时，仅翻译/解析新事件，复用工具与子 agent 的归并索引。工具的更新与完成保留原有非相邻归并语义；初始快照、迟到、替换、重排或语言变化重新规范化，复用语义相同的当前结果。缓存不保存整条中间合并链，避免累计文件列表等中间值长期保留。

活动展示对象与复制/展开函数按不可变的派生行弱缓存。feed 与展示层按类型/身份及完整显示字段复用历史行；重复身份保守地走既有排序，不做全局去重。新增 6 项定向行为用例：1200 活动后的工具追加旧字段读取少于 20 次、已展开其他工具行同引用、隐藏配置事件复用整条 feed、工具/子 agent 非相邻状态归并、旧显示不可变、迟到/替换/重排/空快照、重复/缺省序号与生命周期排名、语言变化。当前主目录的活动测试共 54 项通过。

纯暂存候选的移动端活动、列表跟随与共享 thread reducer 三份测试共 108 项通过，另补共享实体缓存的 8 项测试通过；Mobile 指定的 `tsc --noEmit`、3 源文件 lint 和 6 文件格式检查通过。初次类型检查指出测试夹具的可选序号不能为 `null`，已改为省略字段后复核通过。回退候选中的 selector 到上一提交，同一工具追加用例因读取 45,599 次历史字段而失败；恢复本次实现后通过，证明新增路径的收益来自此改动。未运行全仓检查，未改变产品编译配置。

真实 Native 列表/设备帧率、Android 已完成代码行与选区、服务端热路径快照读取、完整第 8 项连接矩阵和第 9 项最终复测仍开放；第 4 项保持部分完成。

### 第 4 项服务端流式消息投影

源码核对确认 `ProviderRuntimeIngestion` 的普通 delta 已读取轻量线程外壳，`ProjectionPipeline` 也已跳过 assistant 消息和常规活动的完整摘要刷新，不能把这些现有能力标为缺失。但消息投影此前仍每次 `getByMessageId` 读取累积正文后拼接再 upsert；现通过仓储的 `applyMessage` 在 SQLite 内原子追加。首次消息、空完成保留旧正文、明确终态正文替换、首次 `createdAt/firstSequence`、来源与附件省略保留、显式空附件清除均沿用原行为，普通 `upsert` 仍可直接替换正文与时间。

新增 6 项仓储用例覆盖上述边界、并发 30 片段不丢失、事务失败回滚；新增真实 SQLite 投影用例从长回复追加两段到空完成，再重复 bootstrap，断言消息正文与历史列表读取均为零且最终内容、位置和状态正确。初次运行暴露新夹具污染既有共享数据库，已改为独立测试层；主目录两份定向文件共 36 项通过，5 源文件 lint 无诊断。

纯暂存候选固定 151 个工作区别名：仓储、投影与完整 `ProviderRuntimeIngestion.test.ts` 三份定向文件共 142 项通过（172 秒），5 源文件目标 `tsgo --noEmit`、lint 和 7 文件格式检查通过。仅把候选 pipeline 回退到上一提交，同一无正文回读用例因发生 3 次正文读取而失败，恢复本次实现后通过。7 文件候选一致，88 个无关原始文件哈希与 ChatView 原始用户补丁保持不变；未运行全仓检查，未修改 Git 配置或持久化结构。

此内部持久化增量适用于所有 adapter 的标准消息事件，Web/Desktop/Mobile、本地/远程/隧道仍消费原合同；没有新增 RPC、设置、权限或能力字段。数据库结构与迁移不变，回退对应提交即可恢复应用层拼接。计划/部分生命周期的摘要全历史读取、服务端内存活动排序、Android 与真实设备、完整重连及最终性能矩阵继续开放。

### 第 4 项服务端内存活动增量

服务端 `projector.ts` 仅标记自己产出的有序活动数组，后续单调事件在尾部追加，迟到或身份替换按原比较器二分定位；外部快照和回退后的新集合首次追加仍完整规范化。保留服务器缺省 `sequence` 在前的旧排序，与客户端缺省序号在后不同，因此没有共用不相容的排序器。上限仍为 500，缓存只持有弱标记，不保留跨线程身份或已淘汰活动；历史对象和数组不被修改。

新增 4 项公共投影入口用例覆盖 500 条历史追加只读取少于 25 次排序字段、其他线程和 turn/checkpoint/message 引用、旧快照、缺省/重复序号、时间与身份并列排序、迟到、重复身份替换、重载数组、500 上限及淘汰身份重现。主目录与既有结案/置顶投影的三份文件共 17 项通过；将测试中的数组反转改为 `toReversed` 后目标 lint 无诊断。

纯暂存候选的同三份文件 17 项通过，2 源文件目标 `tsgo --noEmit`、lint 和 4 文件格式检查通过。回退候选的 `projector.ts` 到上一提交，同一追加用例发生 2,991 次旧排序字段读取，超过 25 的阈值而失败；恢复本次实现后通过。4 文件候选一致，88 个无关原始文件及 ChatView 原始补丁保持，未运行全仓检查。

该纯内存增量适用于所有 provider、客户端和连接模式的共同事件，不改变协议、持久化表、设置或能力控制。用户/计划/生命周期摘要读取、Android 与实际 Native 设备，以及完整第 8/9 项继续开放。

### 第 4 项 Android 代码高亮等待路径

Android 聊天代码块使用 `ThreadFeed` 的 `MarkdownCodeBlock` 和 `useMarkdownCodeHighlight`。此前新代码对应 atom 尚未成功时返回 `null`，整个代码块会从 token 行切回纯文本；现每个代码块独享显示 selector，首次也生成完整行结构，异步等待或失败继续复用已着色完成行并追加普通尾部。高亮完成后按实际 token 样式更新，语义相同的行仍复用；语言/主题/开关或非追加替换不沿用旧颜色。不一致的高亮数据不会截断当前正文，复制继续读取完整代码。

新增 6 项显示行为用例覆盖首次行结构、异步等待/失败、尾部追加、完成行身份、着色返回与颜色变化、语言/主题/开关/替换、旧高亮、中文/emoji/空行/CRLF、代码块隔离；与既有原生 Markdown 工具函数两份文件共 41 项通过，3 源文件 lint 无诊断。

纯暂存候选的显示 selector、原生 Markdown 与前缀缓存三份文件共 54 项通过；Mobile 指定的 `tsc --noEmit`、3 源文件 lint 与 6 文件格式检查通过。目标类型配置额外载入真实 `ThreadFeed.tsx` 调用方和现有 `Stack.tsx` 导航增广，没有修改产品编译配置。6 文件候选一致，88 个无关原始文件与 ChatView 原始补丁保持；没有把这些结果算作 Android 原生构建或运行通过。

此改动补 Android 的既有渲染入口，iOS 原生分支保持自己的同等尾部处理；服务器、Web/Desktop、provider 和连接协议不变。SDK 探测确认本机有 Android adb/emulator 及一个现有 AVD，目前没有连接设备；没有启动或改写现有 AVD。React Native Android 的 `ReactTextView.setText` 路径也需要核验原生选区，第 6 项不会仅凭 React 行身份或这些纯函数测试宣称通过。真实 Android 构建、原生设备帧率和最终性能矩阵继续开放。

### Android 独立开发客户端构建与设备边界

随后从提交 `01d67f5bc` 导出独立源码到 `E:/cw-port-01a12bdd`，开发变体 `com.codework.mobile.dev` 的 x86_64 APK 已实际构建成功。命令为 `gradlew.bat :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=3 --console=plain --init-script <工作区外的 native-short-build.gradle>`；结果 `BUILD SUCCESSFUL in 2m 33s`，837 个任务，产物 120900267 字节。CMake 构建目录与 Ninja 选择仅在该次 init script 生效，用已安装的 Ninja 1.13.2 和独立短路径解决 Ninja 1.10.2 的重复 manifest/路径失败；未修改依赖源码、主工作区 Android 工程或全局 Gradle 配置。

只为本次验收创建 `CodeworkPort_01a12bdd` AVD 与独立模拟器目录；原有 `Medium_Phone` 未启动或改写。原 SDK 模拟器 37.1.11 和独立官方稳定版 37.2.12 均未启动到 adb 可连接状态，记录了 DLL 初始化和图形初始化退出/停滞日志；停止了本轮登记且核对身份的进程，没有按名称清扫。稳定版来自 Google [SDK 仓库清单](https://dl.google.com/android/repository/repository2-3.xml)，2026-10-12 以 `emulator windows channel-0` 核对稳定渠道，下载大小及官方 SHA-1 校验通过。独立 Metro 8087 可用，但没有安装到运行设备、没有配对或观察 Native 界面。此处仅通过构建；Android 原生选区、设备帧率和实机验收继续开放，不能用 APK 成功替代。

### 第 5 项服务端 leading/trailing 与原子收尾

`ProviderRuntimeEventCoalescer` 接在 ingestion 入队之前。按线程维护 60ms 窗口，空闲后的首包立即入队，后续相邻且 provider/实例/回合/条目/请求/原生引用/正文索引/摘要索引相同的纯文本合为尾包；正文、思考、媒体的不同流保持顺序，每个窗口最多一组文字。工具、审批和终态不能越过前面的文字，其他线程独立推进。原 provider 总线、日志和 checkpoint 输入保留原包；合并包不冒充原始 checkpoint 摘要。窗口空闲后停止，无持续轮询。非法 delta 继续进入已有 ingestion 错误隔离，不会终止整个订阅。

完成命令新增可选内部 `text`，一次提交完整已投影前缀与缓存尾文；旧的无正文完成命令仍有效，外部 `thread.message-sent` 合同不变。正常完成、失败、取消、工具边界和审批收尾不再额外派发尾部 delta。暂停保留段序号，回答后续接使用新的消息段；部分回复不执行成功结果中的 Goal/Spec 指令。ingestion 的独立顺序作用域先刷新窗口并等待持久化，再关闭 worker，显式 `drain` 同样刷新尾包。

虚拟时钟测试覆盖 leading/trailing、持续突发、不同线程和索引隔离、Unicode/CRLF、媒体、控制顺序、原始 checkpoint 保留、错误包隔离、drain、停机与取消计时，共 12 项通过。旧 ingestion 加载同一实际入库用例时，completed/failed/cancelled 三项均红于预期 2 条消息事件而实际 3 条；新实现对应三项通过，并保留首段时间和完整前缀。合同兼容、SQLite 消息投影及 engine 三份定向文件共 77 项通过。完整 ingestion 文件 109 项通过，包括思考边界、审批/提问后续接、Goal、失败隔离与媒体。纯候选共 198 项通过，命令为 `vp test run --config .candidate-test.config.ts` 加上述 5 份具体文件；server/contracts 目标 `tsgo --noEmit` 与新 helper/相关生产文件 lint 通过。首次完整回归暴露的非法包订阅退出已修复，思考增量断言按合并后的完整文字更新并通过；没有掩盖失败。

此内部路径适用于所有 provider 的标准内容事件，Web/Desktop/Mobile 与本地/远程/隧道继续消费相同持久化事件；没有新增外部权限或 RPC。三态设置仍由已有 `features.responseStreamingModes` 门控。第 5 项整体继续部分完成：客户端每帧提交、完整 store 的节奏切片、节奏开关、复制/选区/滚动一致性和最终性能尚待实施与验收。第 7/8 项 adapter 终态及重连完整矩阵也不能以这些测试替代。回退本主题提交即可恢复原始 ingestion 节奏与独立尾部 delta，不涉及数据库迁移。

### 第 5 项客户端完整状态按帧发布

`latestFrame` 接在共享线程/环境完整状态机之后：原始事件仍一一按序进入现有 reducer、游标、分页和缓存逻辑；只有向 UI atom 发布的累积快照在主机一帧内取最新值。首次状态立即发布，后续等待 Web/Desktop/React Native 主机的 `requestAnimationFrame`；消费较慢时最多保留一份未消费的累积快照，不能将这个 helper 用在独立 delta 上。仅有待发布状态时，100ms 的 Effect 兜底防止后台浏览器暂停 rAF 后无限等待；空闲没有刷新循环。作用域关闭取消待发布帧，真实源流结束/失败前刷新最后完整状态并传播原错误。

`vp test run --config .candidate-test.config.ts` 加 `latestFrame`、`threads-atoms`、`threads-sync`、`threads-pagination`、`shell`、`shell-sync` 与两个 reducer 的 8 份指定测试文件，纯候选共 98 项通过。主机帧/后台兜底、首次全文、每帧最新状态、慢消费、错误/结束和取消共 8 项；实际 atom 订阅用例验证一帧内两段正文只发布一次完整文字，未显示的完成事件在退出后仍与游标 10 一起保留，重新打开恢复完成正文且不关闭环境连接。client-runtime 目标 `tsgo --noEmit`、5 源文件/测试 lint 通过。

保留的隔离 Web 环境实际重新加载后，1202 条活动线程的标题、601 次完成记录、代码块与发送入口恢复；进入草稿再返回历史线程也恢复正确内容，无断开提示。工作区外保存 `frame-publication-ui.png`；没有临时源探针或提交截图。此次观察是已完成历史线程导航，不代表真实 provider 连续流、完整重连矩阵、Desktop 外壳、Native 设备或最终帧率通过。

该共享发布层覆盖 Web/Desktop/Mobile 所有线程与侧栏环境入口、本地/远程/隧道及所有 provider；不改合同、设置、RPC、权限和原始状态机。回退本主题提交恢复逐状态发布，不改持久化数据。第 5 项的渲染揭示切片与节奏开关，以及复制/选区/滚动一致性和第 9 项最终性能仍继续实施。

### 2026-10-12：三端完整来源与自适应文字揭示增量

`textReveal` 只保存完整输入和显示切片，不参与累积消息或去重。首个非空正文整体显示，新增尾文按字素边界和积压量逐帧追赶；只在积压存在时请求帧，后台使用既有 `FrameClock` 的单次 100ms 兜底并取消败方，恢复前台也不会凭长间隔一次跳过全部积压。仅重新分段上一字素与新增尾文，已完成历史不扫描字素。完成、失败、取消、关闭节奏或重新进入正文均追上完整来源。React StrictMode 的挂载清理重放和过期帧不会丢正文。

Web/Desktop 的 `StreamingChatMarkdown` 与 Mobile 的 `StreamingMarkdown` 始终保留显示挂载；只有积压时增加不可交互、不可访问的完整几何层。开始选择或复制前追上完整来源。Web 在选区存在期间冻结已选正文，完整来源和几何继续更新；清除选区后吸附全文，终态也不替换正在选择的 DOM。原生代码复制索引按完整 AST 的起始字节位置对应，嵌套代码和相同代码前缀不会互相覆盖。iOS 的原生路径及 Android 回退路径都使用该来源；已完成历史不增加完整解析层。

设置新增可选 `responseTextPacing`，仅在可选 `features.responseTextReveal === true` 时启用和展示，未设置默认开启；旧环境不写入新键。Web/Desktop 通用设置支持搜索、恢复默认与服务器持久化；Mobile 的环境设置使用相同键和服务器更新入口。新的能力与设置均保持旧消息和旧服务端的解码兼容。各 provider 的决定一致：只在公共客户端呈现层处理完整正文，不改变 adapter 的原始事件或审批。

- 纯候选 `vp test run --config .candidate-test.config.ts` 指定 `textReveal`、`settings.reveal`、`serverSettings.streaming`、`StreamingChatMarkdown`、`MessagesTimeline`、`ChatMarkdown`、两端 streaming 设置、`markdownCodeCopy` 与 `settingsSearch` 的 10 份文件，共 141 项通过。包含 28 项时钟/字素/终态/选区控制、7 项兼容合同、2 项嵌套和 CRLF 代码复制用例，其余覆盖已有渲染和设置入口。
- 共享客户端、Web 与 Mobile 的本批目标类型检查通过；合同与服务器目标类型检查沿用本批已通过的结果。只检查触及源文件的 lint，不运行全仓检查。
- 真实 Web 本地隔离环境的未闭合末段选区为“末段文字可选择”：追加 250 段后完整输入 2557 字符，显示正文保持原选区；完成后输入 2561 字符，原段落、末段文字节点及代码行保持身份，完整几何高度均为 1120px，清除选区后显示全部尾文。鼠标复制触发后读回包含完整尾文；键盘 Enter 复制逐字符匹配 2517 字符，包括既有解析器保留的内部 CRLF 和末尾 LF。关闭节奏立即显示全文。
- 实际设置入口默认开启，关闭后重载仍关闭；恢复默认预览仅列出“平滑显示文字”，确认后恢复开启。搜索“节奏”找到并定位相同行。以上操作仅写入本次隔离环境，临时 `main.tsx` 入口已恢复原始字节；截图与夹具不提交。

Web 实际证据覆盖本地模式；Desktop 复用同一呈现与设置组件，独立 Electron、远程/隧道及 Native 设备仍需补充。全文几何相同不代表完整滚动锚点矩阵或最终第 9 项性能通过；iOS/Android 原生选区也不能由纯函数测试或 APK 构建替代。第 4/5/6/9 项继续保留相应验收边界。回退本主题提交即可恢复原有直接显示；可选持久化设置允许旧客户端忽略，不涉及数据库迁移。

### 2026-10-12：Adapter 在途条目的终态收尾

新增 `runtimeTurnItems`，在 Adapter 的 canonical 发射边界追踪同一线程和回合的在途 item。正常完成、失败、取消、打断和会话退出前，先发布缺失的 `item.completed`，再发布终态；每一批进入同一个 Queue/PubSub，状态只在实际执行发布时改变。明确的 `inProgress` 仍属于在途状态，包括以 `item.completed` 承载进度的 Omp 事件；没有 status 的真正完成通知会解除追踪。成功收尾为 completed，其他结束使用既有 failed 状态，不新增或收窄协议枚举。

Codex、Claude、OpenCode、Cursor、Grok、BYOK、Antigravity 与 Pi/Omp/ZCode 的公共队列均接入此边界；Kimi 和配置型 ACP 沿用 Cursor/GenericAcpDriver 的发射入口。原生日志先保留实际事件，合成通知只补 canonical 生命周期，不改 CLI 参数、权限、原生审批或执行结果。遗漏完成通知的 Codex `contextCompaction` 已有真实适配映射测试：旧实现只出现 started 后直接终态，新实现先关闭该条目。

追踪保留原 item、回合、provider 实例和子 agent 归属；不同线程或回合的相同 item ID 不混用。没有回合 ID 的结束通知不会关闭当前工作，旧回合结束不会误关新回合。文本条目收尾不带开始通知的旧正文，完整文本继续由 ingestion 累积来源完成；工具详情与元数据保留。重复结束不会再补完成行，刚结束回合的迟到运行中通知不能重新点亮，真正的最终结果继续通过；下一回合可复用 item ID，会话重新启动清空追踪。独立后台 task 保持自身生命周期，不能以主回合结束冒充任务成功。

- 纯候选的 13 份 adapter/driver 定向文件共 311 项通过，包含共享边界 14 项、Codex 39 项及其余 adapter/GenericAcpDriver 的原有回归。随后增加无回合归属的结束保护，运行 `vp test run --config .candidate-test.config.ts apps/server/src/provider/runtimeTurnItems.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`，共 163 项通过（15 + 39 + 109）。
- 服务器本批目标 `tsgo --noEmit` 通过；14 份源文件目标 lint 通过，保留 4 条已有提示（对象/数组 spread 和原 Codex 测试可选链），没有新增错误；目标格式检查通过。只运行上述具体文件，不运行全仓检查。
- Web/Desktop 的 `session-logic` 与 Mobile 的 `threadActivity` 均使用 canonical 工具 status，完成事件更新相同工具行；所有 provider 与本地/远程/隧道消费相同持久化事件。本批没有新增 UI 入口、设置、RPC 或能力，逆向状态为下一回合或重新启动会话。

第 7 项保留交互边界验收：原生 hook 事件目前不投影为工具 loading 行，仍以 provider 的实际 hooks 为准；审批/补充信息不能通过伪造响应来解除。独立后台任务、原生设备及连接模式的完整可见性矩阵继续验证。此处仅保留最近结束回合的轻量墓碑，不替代第 8 项持久化幂等与跨重连回放验证。回退本主题提交恢复原发射顺序，无数据库迁移；原有 BYOK 用户改动通过精确补丁保留。

### 2026-10-12：线程恢复订阅的同步游标竞态

源码核对发现 `subscribeThread` 虽在读取游标前 fork 实时缓冲，但未立即启动该 fiber；`latestSequence` 是同步读取已提交内存状态，因此同一调度片段中发布的后续事件可能既不在固定回放范围内，也尚未进入实时订阅。线程发射现与既有 shell 路径一致，使用 `startImmediately: true` 在读取回放游标或快照前接入实时总线。保留固定回放上限、超大/超前游标的快照替换、完成标记、原序号防重与订阅作用域清理。

真实 WebSocket RPC 回归在读取游标时同步发布新的 assistant 尾文，并让固定回放为空；旧代码缺少该事件而触发失败，新代码按“尾文 → synchronized”交付。原快照加载测试去掉人为的 25ms 延迟，直接同步发布也通过。运行 `vp test run --config .reconnect-test.config.ts apps/server/src/server.test.ts`，配置仅选择线程订阅相关 6 项，全部通过（其余 133 项未运行）。它们同时覆盖初始快照/完成标记、同步期间事件、超大间隔、超前游标和固定 head 回放；没有以睡眠或轮询让成功路径通过。

共享 `threads-sync` 新增新旧完成标记能力各一项运行中正文恢复测试：重复与过期序号不追加文字，其他线程造成的全局序号间隔仍接受；断线及替换连接期间保留同一完整线程对象，重新订阅使用最新实际应用游标。新的合法 delta 即使文本与前段相同也保留，Unicode/CRLF 与最终全文正确，仅一条规范消息，无冷快照读取。订阅回执用 Queue 等待，不新增轮询。运行 `vp test run --config .candidate-test.config.ts packages/client-runtime/src/state/threads-sync.test.ts packages/client-runtime/src/state/threads-atoms.test.ts packages/client-runtime/src/state/threads-pagination.test.ts packages/client-runtime/src/rpc/session.test.ts`，共 43 项通过；包含既有关闭忙碌详情不调用环境 disconnect、帧内未发布完成仍配对缓存游标、重开立即恢复运行正文、5 分钟缓存及分页竞态。

server/client-runtime 的本批目标 `tsgo --noEmit` 通过，3 份源文件 lint 通过（原 server 测试 2 条未使用标识符提示保留），目标格式检查通过。三端共享相同状态机与 RPC，本地/远程/relay/隧道均使用相同订阅合同；没有新增权限、设置、能力字段或 UI 入口，离开和重开继续沿用已有反向路径。回退本主题提交恢复原订阅启动时序，不改变数据库。

以上验证是本机真实 RPC 与共享客户端测试；独立 Electron/Native 与真实连接中断的全路径观察、原始 provider 事件重新进入 ingestion 的持久化身份继续核验。客户端网络恢复只回放已经持久化的领域事件，不重新执行 provider 命令；现有 `providerCommandId` 含随机后缀，因此不能把 engine 的 command receipt 防重直接等同于原始 provider 包去重。第 8 项继续保留这些边界，最终性能仍按第 9 项验收。
