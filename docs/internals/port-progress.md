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

| 项  | 主题                                                        | 当前状态                                                                               | 实现 / 验收入口                                                                                                                                            | 验证结果                                                                                                                                                                    |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 通读指定文档与约束                                          | 完成                                                                                   | 上述七篇文档、根 AGENTS                                                                                                                                    | 2026-10-12 完整阅读                                                                                                                                                         |
| 2   | 全部需核对条目源码基线                                      | 完成                                                                                   | B01—B22                                                                                                                                                    | 已读取源码并明确边界；不把静态核对当成实现完成                                                                                                                              |
| 3   | 三态输出、默认 paragraph、旧键策略、三端设置                | 完成（本主题定向验收）                                                                 | settings / AssistantTextBuffer / ProviderRuntimeIngestion / Web/Desktop 设置 / Mobile 设置                                                                 | 工作区 10 文件 / 273 项通过；纯暂存候选 35 项与五个目标类型检查通过；当前脏工作区的完整模块诊断仍记录为未通过，见下文                                                       |
| 4   | 全部客户端增量渲染清单与上游对应提交                        | 完成（九项源码清单、目标验证与代表三端运行）                                           | 前缀/代码行/时间线/turn/checkpoint/挂载/投影活动/map/订阅/Mobile                                                                                           | 最新151+56项相关测试；9子项逐一对齐，三端实测与iOS设备边界见第41主题                                                                                                        |
| 5   | 60 ms leading+trailing、每帧提交、完整 store 与揭示切片     | 完成；增量清单、重开与滚动锚点继续随第4/8项验收                                        | ProviderRuntimeEventCoalescer / ProviderRuntimeIngestion / latestFrame / textReveal / NativeFrameScheduler                                                 | 定向与三端受控管线通过；Android 24 帧发布、43 帧字素揭示、全文/选区/终态通过，详见第34/35主题                                                                               |
| 6   | 流式选区与滚动锚点                                          | 完成（DOM保留与手机固定全文等价选择页）                                                | Web/Desktop StreamingChatMarkdown；Android/iOS 选择页                                                                                                      | Web/Android实际选区与三端锚点通过，iOS同入口20项/类型通过；UIKit设备未实测，见第35/38/40主题                                                                                |
| 7   | 每个 adapter 终态无 loading                                 | 完成：公共条目与交互终态、定向验证                                                     | 共享 runtimeTurnItems / 全部 canonical 发射入口 / 原生 Codex 与公共投影                                                                                    | item、审批与提问均先收尾；两端状态、原生 adapter 及投影定向验证通过；详见下文                                                                                               |
| 8   | 重连不重不丢不乱、关闭忙碌流、打开运行线程                  | 完成（共享协议矩阵与三端受控运行验收）                                                 | ws/state/threads/缓存游标/复合身份/Mobile ThreadFeed                                                                                                       | 五种已准备连接×完成标记两态通过；三端关闭/重开/断线重投、锚点与回尾通过，首绘采用用户确认标准，见第38/39主题                                                                |
| 9   | 同口径帧间隔性能无回归                                      | 三端同口径静态滚动验收通过；流式与连接矩阵归相应条目继续核验                           | 1280×720、实际组件输入 1202 活动、上下各 20 页 ×4 组                                                                                                       | Web/Desktop 原 72 窗口保留；Android 原始基线新 24 窗口与 FrameTimeline 通过，两当前轮 16 对应窗口均无回归                                                                   |
| 10  | Windows argv 三层守卫                                       | 完成（入口清点与定向验收）                                                             | promptArgv / Antigravity 对话及文本生成 / ZCode 最终 spawn                                                                                                 | 4文件26项、旧版失败对照、纯候选目标类型通过；Windows shell边界实测与证据边界见第42主题                                                                                      |
| 11  | 统一 catalog、缓存键、deadline、AbortSignal、无草稿 session | 进行中（十二类刷新、完整预算、共享home及实例模式入口已验证）                           | ProviderCatalogCache / ByokProviderCatalog / GrokHomeAccess / CliProviderCatalog / OpenCodeCatalog / NativeProviderCatalog / client-runtime/providerModels | 第43—76主题补齐共享刷新、预算、配置所有权、模式发现/发送与Web/Android实际入口；完整入口/三端/连接矩阵仍开放                                                                 |
| 12  | steer 全契约与排队/steer UI                                 | 完成                                                                                   | ProviderAdapter / ProviderService / reactor / 三端 composer                                                                                                | reactor 73 项全绿（含 5 项新契约用例）；能力矩阵 6 声明/4 不声明；Web/Mobile 能力门                                                                                         |
| 13  | 规范消息身份与回显对账                                      | 待核验补齐                                                                             | decider / normalizer / provider echo                                                                                                                       | B19 为部分底座，验收尚未运行                                                                                                                                                |
| 14  | 细化 rewind/streaming/reasoning/MCP/persistence/切模型能力  | 完成（全部声明落地为真实适配器能力并透出快照）                                         | ProviderAdapterCapabilities / ServerProvider 快照 / ProviderService MCP 门控 / 三端控制                                                                    | 第63主题模式控制；第79主题 rewind 三态；第80主题切模型三态与两端确认；第81主题四项能力声明与 MCP 凭据门控                                                                   |
| 15  | prepare/release/dispose 完全停止                            | 待实施                                                                                 | 生命周期与可见性报告                                                                                                                                       | 尚未运行                                                                                                                                                                    |
| 16  | managed-process registry 身份核验与启动对账                 | 完成（账本+平台身份核验+启动对账落地，登记点覆盖全部直接句柄会话传输与 helper server） | ManagedProcessRegistry / spawn 点 owner 透传 / reconcileProviderSessions                                                                                   | 第88主题：10例测试全绿；身份不匹配只删不杀、检查/终止失败保留记录                                                                                                           |
| 17  | ACP 配置驱动收敛与 help flags                               | 待核验补齐                                                                             | GenericAcpDriver / AcpRegistryCatalog / ACP transport                                                                                                      | 尚未运行                                                                                                                                                                    |
| 18  | 草稿无 session、MCP 失败关闭、options/profile 深度合并      | 完成（第86主题落地 MCP 失败关闭；其余两子项核对为已有等价/有意不适用）                 | ProviderService / McpSessionRegistry / deepMerge / providerInstance config blob                                                                            | 草稿无 session 见第43主题；MCP 凭据签发失败现在拒绝启动（ProviderAdapterProcessError）；深合并经 deepMerge+不透明 config blob 等价成立                                      |
| 19  | 排队、快捷键、召回、异步问题、文件回答、secret              | 待核验补齐                                                                             | Web/Mobile composer / 用户问题 RPC                                                                                                                         | 尚未运行                                                                                                                                                                    |
| 20  | 原生/跨 harness 压缩、发送前 token 芯片、旧线程提示         | 待实施                                                                                 | B03 / 上下文控制                                                                                                                                           | 尚未运行                                                                                                                                                                    |
| 21  | Codex/Claude 原生 goal 与权威状态                           | 待实施                                                                                 | B05 / provider hooks 或会话状态                                                                                                                            | 尚未运行                                                                                                                                                                    |
| 22  | 项目设置覆盖、双选择器、默认权限、子模块限制                | 待实施                                                                                 | B08 / CodeworkProjectFileLoader / ProjectSetupScriptRunner                                                                                                 | 尚未运行                                                                                                                                                                    |
| 23  | 全入口撤销、排序、通知角标、远端项目标记                    | 待核验补齐                                                                             | Sidebar / Mobile shelves / 通知服务                                                                                                                        | 尚未运行                                                                                                                                                                    |
| 24  | 50 MB 任意附件、HTML/PDF 预览、大粘贴折叠                   | 待实施                                                                                 | B10 / assets / 三端附件                                                                                                                                    | 尚未运行                                                                                                                                                                    |
| 25  | MCP Apps、caller scopes、外部 OAuth、URL                    | 待实施                                                                                 | B11 / B12                                                                                                                                                  | 尚未运行                                                                                                                                                                    |
| 26  | 独立语义权限                                                | 待实施                                                                                 | B13 / auth / RPC/MCP                                                                                                                                       | 尚未运行                                                                                                                                                                    |
| 27  | Limits、跨账号环境、剩余额度与 provider 接入                | 待核验补齐                                                                             | B07 / AccountQuota / quota merge / 三端用量                                                                                                                | 尚未运行                                                                                                                                                                    |
| 28  | worktree 位置、可取消异步初始化、分支前缀、结案动作         | 待核验补齐                                                                             | VCS / setup script / composer bootstrap                                                                                                                    | 尚未运行                                                                                                                                                                    |
| 29  | 远程目录、新模型提示、收藏可见性同步                        | 待核验补齐                                                                             | B14 / ModelManifest / provider update / settings                                                                                                           | 尚未运行                                                                                                                                                                    |
| 30  | 更新续接、按机器项目清理、未知 union、远程兼容范围          | 待实施                                                                                 | B15 / B16 / B17                                                                                                                                            | 尚未运行                                                                                                                                                                    |
| 31  | BYOK 翻译兼容五项清单                                       | 完成（第85主题核对五项并补无 usage 兜底用例）                                          | modelGateway / AnthropicBridge / ResponsesBridge                                                                                                           | 分块边界/思考签名/工具id往返/count_tokens 既有覆盖复验；无 usage 零值兜底新增三例；账号粘滞并入第84主题                                                                     |
| 32  | 账号粘滞、额度切换、记忆容量                                | 完成（第84主题落地会话粘滞+换绑+2000容量）                                             | LocalAccountPool / modelGateway 本地线路                                                                                                                   | 会话键提取（x-session-id/previous_response_id/session_id/conversation_id/prompt_cache_key/metadata.user_id/user），运行级测试104项通过；CursorDriver spawn 级绑定为记录边界 |
| 33  | 回环随机端口、每运行令牌、请求时密钥                        | 完成（每运行轮换令牌落地；回环/随机端口按共享 listener 有意不适用并记录）              | CliProxy / LocalGatewayKey / modelGateway / serverRuntimeStartup                                                                                           | 第83主题：rotateGatewayTokenForRun 每次启动轮换并重盖章池适配器；仅令牌应答与请求时读密钥为既有行为复验通过                                                                 |
| 34  | fragment 四字段导入、重复来源选择                           | 待实施                                                                                 | Desktop deep link / Web/Mobile 导入 / server import                                                                                                        | 尚未运行                                                                                                                                                                    |
| 35  | StepFolds 与编辑/子 agent/计划边界                          | 待核验补齐                                                                             | MessagesTimeline.logic / Mobile threadActivity                                                                                                             | 尚未运行                                                                                                                                                                    |
| 36  | 富文本代码行引用、句内附件、大粘贴                          | 待核验补齐                                                                             | Composer / IDE 选区桥 / Mobile composer                                                                                                                    | 尚未运行                                                                                                                                                                    |
| 37  | composer 上方状态集中与真实来源                             | 待核验补齐                                                                             | goal / queue / context / health                                                                                                                            | 尚未运行                                                                                                                                                                    |
| 38  | 系统通知、声音、角标、托盘后台                              | 待核验补齐                                                                             | B09 / Desktop IPC / Web / Mobile awareness                                                                                                                 | 尚未运行                                                                                                                                                                    |
| 39  | 跨环境徽标、移除只隐藏、默认当前环境                        | 待核验补齐                                                                             | 环境注册表 / 选择器 / 项目与草稿状态                                                                                                                       | 尚未运行                                                                                                                                                                    |

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

| 子项 / 参考提交                              | 当前结果                               | 证据与剩余边界                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完成 Markdown 前缀 / `a9dabbf100`            | 完成：两端解析缓存与完整回退           | Web 冻结闭合顶层块；Mobile 双路径复用前缀，UTF-8偏移/引用定义/替换/空代码的原生样本等价测试通过。Android production 流式、代码、原文与历史锚点已实测；iOS原生路径源码/类型通过，无设备运行。                                |
| 完成代码行 DOM / `8078c532ce`                | 完成：Web DOM与Mobile完成行复用        | Web 高亮tokens生成固定行节点，实际追加/完成时第一行DOM相同。Mobile 已着色行在异步等待/失败中保留，新尾行完整；键不含增长end。代码显示与高亮56项定向子集通过，Android代码复制与实际正文已验，iOS仅源码/类型。                |
| 时间线行复用 / `19c1710a88`、`aefef95ffc`    | 完成：三端时间线与历史活动复用         | Web 稳定折叠/活动/正文行；Mobile selector复用历史行和回调，1200活动正文零重读，追加旧排序字段有界，其他展开行同引用。最新threadActivity定向通过；Android/Electron/Web实际流式与静态滚动证据保留。                           |
| 回合/检查点引用 / `6866fd6b5c`               | 完成：共享delta引用稳定                | threadReducer在字段不变时复用latestTurn与checkpoint数组/条目；完成状态、新消息绑定和真实元数据变化仍更新。最新151项中reducer用例通过，三端消费同一状态机。                                                                  |
| Markdown 挂载 / `887ece3071`、`355fbd96d5`   | 完成：渲染身份与显示挂载稳定           | Web renderer context更新内容，组件身份固定；实际DOM段落/代码首行追加与完成保持。Mobile块/嵌套节点按起始位置取键，StreamingMarkdown始终保留visible挂载；Native固定全文选择页与三端历史锚点已验。                             |
| 投影/活动追加 / `c2283ce146`                 | 完成：消息/活动增量与流式摘要准入      | 客户端reducer增量插入/重复替换/用量淘汰；Mobile派生新事件复用旧行；SQLite原子正文追加与server活动尾追加/二分插入。最近user时间已用元数据MAX查询，assistant正文/普通工具活动不刷新摘要，离散计划/审批/生命周期保持既有语义。 |
| 跳过 checkpoint map / `076d753ae6`           | 完成：Web/Desktop/Mobile私有回退map    | 检查点与消息身份/角色/顺序或失败状态变化才更新，正文保留map；Mobile1200消息/600检查点/20正文更新零历史读取。实际Android ready后同页显示编辑/回退，回调仅依赖动作所需字段。                                                  |
| 无用线程订阅 / `d7cf8aaa8d`                  | 完成：无消费者释放线程流而保留环境连接 | 最后一个详情/派生atom退出后释放实时流；纯缓存正文、分页及配对游标保留5分钟。定向挂载/取消/到期/重放/旧作用域通过，三端实际离开忙碌线程连接保持；连接目标矩阵见第39主题，公网模式没有实测。                                  |
| Mobile 同步核对 / `44dc8ae259`、`7bd7f99e6c` | 完成：Mobile按同一清单落实             | 共享reducer、块键、双解析缓存、正文/活动feed、代码行与回退map目标测试/类型均通过；真实Android选区/全文/帧发布/静态基线/锚点与重连通过。iOS固定全文入口及原生路径源码通过，UIKit设备边界保留。                               |

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

### 2026-10-12：终态前解除失效的审批与提问等待

公共 Adapter 边界继续追踪 `request.opened` 与 `user-input.requested`，按线程、回合、交互类型和请求身份隔离。正常完成、失败、取消、打断和会话退出前，遗漏的 canonical 审批结束通知以 `decision: cancel` 收尾，提问以空答案结束；仅关闭已经不能回应的客户端等待卡片，不调用 provider、不批准工具、不生成用户回答。真实回应解除追踪并保留原决定/答案，迟到的真实回应继续通过；同名审批与提问不混用，下一回合可重用请求身份，无回合归属的已知请求沿用当前回合，结束归属准入保护不变。

四种终态缺少交互收尾的测试在旧代码均红于只发出 `turn.completed`，新实现均绿。共享 helper 现有 22 项，公共 `runtimeEventToActivities` 与公开 payload 投影新增 4 项，分别检查最终工具 status、审批取消和空答案。`vp test run --config .candidate-test.config.ts` 指定这两份文件、`ProviderRuntimeIngestion.approval.test.ts`、Web 的 `session-logic.test.ts` 与 Mobile 的 `threadActivity.test.ts`，5 份文件共 176 项通过。客户端按原有模块配置分别验证；跨 NodeNext/Bundler 直接互引的临时夹具未保留，也未放宽产品类型配置。

其余实际 Adapter/driver 回归分组运行：共享 helper 与 Claude/Cursor/Grok/OpenCode 五份文件 229 项；Codex/BYOK/Antigravity/GenericAcpDriver 与 ProjectionPipeline 五份文件 94 项；Pi/Omp/ZCode 按其实际测试目录补充运行，三份文件 21 项通过。Windows 测试 CLI 的既有 `DEP0190` 提示保留。服务器本批目标 `tsgo --noEmit`、3 源文件 lint 和格式检查通过，没有新增类型或 lint 错误。

至此第 7 项的所有 canonical 在途 item 与交互等待均在 Adapter 终态前补齐，并经原生映射与公共活动投影定向验证。所有 Adapter 沿用上一批的同一发射边界，三端与本地/远程/隧道消费相同公开活动；不改合同、权限、CLI 或 UI 入口。原生 hooks 当前不投影为 loading 行，保持实际 hooks 结果；可独立运行的后台 task 属于持续工作，保持实际生命周期，不能以主回合结束冒充成功。设备选区、真实重连全路径和最终性能仍分别按第 4/6/8/9 项开放。本主题回退恢复仅 item 的追踪，数据结构与迁移不变。

### 2026-10-12：后续流式改动的 Web 性能交叉复测

对 `7f296c56b` 重跑第 9 项的 1280×720、1202 活动、上下各 20 页 ×4 组口径，最近 120 帧窗口的最高 p95 为 18.1 ms、最大间隔 53.9 ms、单窗口 >50 ms 的最高数量为 1。早先 `7ffa6f2b4` 为 16.8 / 66.7 ms，不能忽略 p95 上升而直接判通过。

因此在工作区外导出原始版本、恢复最初的 Web 脏文件快照，以同一浏览器和隔离后端补测：原始版本最高 p95 同为 18.1 ms、最大 53.7 ms、单窗口长帧最高 1；返回最新版本的交叉复测为 18.1 / 53.0 ms / 1。同期对照支持采样环境变化的解释，Web 本轮未观察到持续回归；首次最新版本 53.9 ms 也完整保留，不挑选较低值掩盖差异。详情、原始文件名、冷启动和重叠窗口边界见 `agent-provider-product-comparison.md`。

滚动容器 668 px，实际滚动端点 0 / 14400 px；首次最新版本虚拟列表高度从 42445 变为 41905 px，同期对照与交叉复测保持 42445 px，不据此认定完整锚点矩阵通过。隔离验证环境曾出现 React 编译器运行时预构建互操作错误与跨目录采样器加载失败，已在工作区外配置和入口中解决；未改产品配置或主目录旧版本。测试结束恢复 `main.tsx` 的原始字节并确认其 Git diff 为空，页面采样面板为 0，停止登记的基线前端会话并恢复默认视口，没有提交采样器或截图。

本记录仅覆盖 Web 开发构建的已完成长历史滚动。Desktop 独立外壳、Native 设备、真实运行回合和连接模式矩阵仍按各自条目验收；第 9 项整体保持开放。此提交仅更新两份内部证据文档，无运行时行为或迁移，回退本主题提交即可撤销记录。

### 2026-10-12：合并前过滤近期 canonical 原包重投

同一个 canonical `content.delta` 再次进入合并层时，原实现会再次拼接正文；随机后缀的 provider command identity 不能阻止它再次持久化。现于 `ProviderRuntimeEventCoalescer.offer` 的既有锁内、建立窗口与拼接之前过滤近期复合身份。身份包括 provider/实例、线程、eventId、事件类型、回合、item、request、task 及文本 stream/content/summary 索引，既不使用正文比较，也不把同一原生通知展开的多个 canonical 类型、任务或请求相互吞掉。

最近 10000 个身份按插入顺序保留；显式 flush 只清空窗口，身份随 ingestion 作用域结束释放。重投不能改变 60ms 窗口、首包/尾包或控制事件的顺序，终态后的近期重投不再产生领域事件。缺失 eventId 的非法包继续沿用下游隔离路径，不污染后续合法包。没有新增全局正文去重；不同身份的相同 Unicode/CRLF 文本完整保留。

新增最初 6 项回归在旧代码均失败于重复文字或重复控制事件，新代码通过。随后补充原生通知展开的不同 task/request、缺失与非法身份、容量淘汰边界；合并层共 18 项，真实 SQLite ingestion 在 turn/paragraph/token 三态分别验证跨 flush 重投、相同文字的新身份、终态后重投不再入库。首次整组运行 129/130 通过，既有“提问时收束正文”用例触发投影轮询的 2 秒墙钟超时；该用例单独复测通过。并行启动模拟器期间另有四个既有用例出现同类墙钟超时；五项均改用已有 ingestion drain 收据等待并保留完整正文、流式状态、审批类型及错误回合断言，没有放宽超时或修改业务分支。最终 `vp test run --config .candidate-test.config.ts apps/server/src/orchestration/ProviderRuntimeEventCoalescer.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` 两份文件 130 项全部通过（18 + 112），耗时约 202 秒。

本批服务器目标类型检查与 3 份源文件 lint 通过。最初新增夹具误用旧 `ProviderItemId` 品牌，已改为实际 canonical `RuntimeItemId` 并重新通过类型检查；没有断言强转或放宽产品配置。Windows 临时测试配置曾错误导入不存在的根 vitest 包，改为沿用既有 vite-plus 配置对象；这些验证配置均在工作区外，不提交。

所有 Adapter 的 canonical 事件经过公共 ingestion；原始日志继续保留真实投递，不删日志或改 provider 结果。Web/Desktop/Mobile 与本地/远程/relay/隧道读取同一持久化领域事件；不增加合同、设置、权限或 UI 入口，离开与重开沿用既有反向路径。回退本主题提交恢复原合并前准入，无数据库迁移。

此处是有界内存防护，不是永久原始事件账本：已淘汰身份、服务器重启以及 Adapter 重新生成的 eventId 不属于该窗口。客户端断线恢复只重放持久化领域序号，已有序号防重继续负责网络回放，不重新执行 provider 命令。第 8 项真实设备/连接中断、忙碌线程关闭与重开的完整观察仍开放，不能据此宣称跨重启 raw provider ledger 已实现。

### 2026-10-12：Android 原生启动依赖配套与本机隔离设备

本机独立 AVD 已通过 WHPX 启动，adb 状态为 device、sys.boot_completed=1，实际页大小 16384；用户原有 AVD 配置哈希保持不变。官方稳定版 37.2.12 的直接 QEMU 启动在独立运行目录补齐同包图形 DLL 搜索路径后成功，所有复制库哈希与官方包一致；未更改系统 SDK、用户 AVD 或依赖源码。

第一次正常安装的 x86_64 APK 启动即退出，真实 NativeLoader 错误为 libfbjni.so 引用的 \_\_cxa_init_primary_exception 不存在。Gradle dependencyInsight 证实 react-native-shiki-engine 的 fbjni:+ 将 RN/Hermes 所需的 0.7.0 提升到 0.8.1；APK 中 libc++\_shared.so 与 RN 0.85.3 / NDK 27 的库哈希相同，缺少新版 fbjni 所需符号。临时替换 C++ 库只作诊断，没有作为产品修复或最终验收产物。

新增 withAndroidFbjniVersion Expo 插件，在 project build.gradle 的专属生成块中将 fbjni 约束到当前 RN 的 gradle/libs.versions.toml 声明。RN 升级会更新约束，重复 prebuild 不重复追加；版本未知或已有块不完整时停止生成，保留原文件。真实 Expo prebuild 成功，正常 assembleDebug 没有诊断 C++ 覆盖脚本，2 分 6 秒完成，838 个任务中 61 个执行；最终 dependencyInsight 为 0.7.0 forced。正常 APK 的 zipalign -c -P 16 -v 4 通过，37 份 ELF 库 LOAD 均为 2\*\*14；实际安装成功，fbjni 不再引用缺失符号，Code Work 首页已显示。

隔离导出目录用只读 junction 复用依赖，Metro 初期无法解析 Expo/RN/共享包的依赖；已在工作区外将每个包的依赖真实目录纳入文件映射并保留源码别名。完整 bundle 返回 200。开发版懒加载在该跨目录夹具下导致 SQLite 与分享缓存无法加载，因此本次 Metro 使用官方现有 EXPO_NO_METRO_LAZY=1；实际数据库文件和 WAL 已创建，首页无缓存错误。产品 Metro 与数据库源码没有修改。这是开发夹具路径处理，不能替代生产构建或真实远程/隧道验收。

纯候选 vp test run --config .candidate-test.config.ts 指定 app.config.test.ts 和 plugins/withAndroidFbjniVersion.test.ts，共 10 项通过；新增 5 项经真实 Expo mod 流水线覆盖版本读取、重复生成、升级、未知版本和破损块。三份源码目标 lint 与格式检查通过，插件测试目标 tsc --noEmit 通过。将 Node 类型载入应用配置检查后，app.config.ts:187 的既有 MOBILE_VERSION_POLICY 字符串宽类型错误在本批与原始 HEAD 都能复现；不把该检查记为通过，另行跟踪修复。没有放宽产品类型设置或运行全仓检查。

公开交叉依据：2026-10-12 检索 fbjni / \_\_cxa_init_primary_exception / React Native 0.85，采用官方上游仓库 [t3code #13710](https://github.com/pingdotgg/t3code/issues/13710) 的问题记录作为本地依赖图与符号检查的佐证；实现独立按本项目配置编写，没有复制参考源码。16KB 检查口径采用 [Android 官方页大小文档](https://developer.android.com/guide/practices/page-sizes)。

本主题只影响 Android 构建依赖选择；iOS/Web/Desktop 与所有 provider、连接合同、权限、UI 入口及反向状态不变。已有 APK 必须原生重建，不能以 OTA 装入此修复。回退本主题提交并重新 prebuild/构建即可恢复原约束，无数据库迁移。本机 Native 已用新单次凭据经 adb reverse 连接相同隔离后端，真实首页显示 1202 条活动验收线程；10.0.2.2 直连曾超时，不能把转发连接等同于该路径或远程/隧道通过。流式选区与性能验收继续推进，第 4/6/8/9 项保持开放。

### 2026-10-12：Android 正文选区的等价实现与设备验证

实际设备长按 Nitro 普通段落时没有选区入口，现于用户消息和 assistant 回复旁加入“选择文本”，运行中的回复也显示此入口。`MessageTextSelection` 的原生 TextView 在虚拟列表之外，`useMessageTextSelection` 只在用户打开时保存完整消息字符串；揭示切片、后续正文和回合终态不替换该来源。选择与页内全文复制使用同一份文字，包括 Markdown、代码围栏、CRLF 和组合字素。会话 store 与几何继续使用最新全文，关闭后重开选择最新文本；切换环境或线程立即关闭旧选区，不会恢复过期正文。

- 纯候选定向测试：`vp test run --config .candidate-test.config.ts apps/mobile/src/features/threads/MessageTextSelection.test.tsx apps/mobile/src/i18n/runtime.test.ts apps/mobile/src/lib/threadActivity.test.ts`，3 文件 66 项通过，其中新选区 8 项、翻译运行时 4 项、既有 Mobile 活动与展示选择器 54 项。覆盖打开时全文、跨环境同名线程、关闭/重开、Android 入口、其他平台沿用既有入口、原生系统返回及同来源复制。
- Mobile 目标 `tsc --noEmit --project apps/mobile/.streaming-typecheck.json` 通过；定向配置显式包含已有 `Stack.tsx` 的 React Navigation 全局声明。最初未纳入该声明时，既有 `ThreadFile` 导航被推断为 never；没有通过断言或放宽产品配置解决。5 源文件/测试的 lint 和格式检查通过。
- 实际配对会话：本次专用 Android 17 / API 37.1 / x86_64 / 16KB 模拟器，1280×720、160dpi，连接本次隔离后端。点击真实回复的入口、长按“601”，看到系统选区手柄与菜单；系统复制读回 3 字符，页内全文复制逐字符匹配 71 字符及代码原文，关闭后回到原会话。凭据没有写入截图或提交。
- 原生增量夹具复用实际 `StreamingMarkdown`、选区控制器和选择页：打开时 58 字符，选中“601”；追加 50 段后全文 1008 字符，完成后 1018 字符，选区页仍为原 58 字符，手柄位置保持。完成后系统范围复制仍读回“601”；关闭后重开取 1018 字符，全文复制逐字符匹配，含 emoji 和完成尾文；系统返回关闭。此证据覆盖真实 Android View 与组件更新，不等同于真实 provider 发出该流。夹具只放在专用导出目录，入口已按原始字节恢复，临时文件已移除，4 份被测产品源码哈希仍匹配纯候选。

新增入口仅用于 Android 聊天消息，包含用户与 assistant、历史与运行中回复；完成或系统返回为反向操作。Web/Desktop 保留已验证的 DOM 选区冻结；iOS 保留已有原生正文路径，本机没有 iOS 运行工具，不能声称 UIKit 设备通过。所有 provider 和本地/远程/隧道使用同一消息全文，此处没有新增协议、权限或服务端能力门控。中/英/日翻译与[用户说明](../user/assistant-output.md)已同步；已有翻译文件的用户改动通过精确补丁保留。回退本主题提交即可移除等价入口，无持久化数据迁移。

随后截图核对发现 `select_all` 未加入 AppSymbol 的 Android 映射，入口曾有辅助标签和点击区域，但没有可见图标。现补齐既有 Tabler `IconSelectAll`，保留原有尺寸、颜色、点击区域与完整正文选择行为。新回归直接调用实际选择按钮和 AppSymbol，并比较已安装 SDK 的组件：旧源码 1 项失败 / 3 项通过，修复后图标 4 项与原选区 8 项通过；目标 Mobile tsc、两源文件 lint/fmt 通过。候选测试以 SDK 的公开 ESM 入口内联运行，仅替换 NativeSvg 叶子，避免 Node 直接加载 RN Flow；测试中的非法 SDK 名称改为合法但未映射的 `wifi`，没有放宽产品类型。生产 JS 模式的原生截图已确认用户和 assistant 消息旁均有虚线选择图标；点击回复旁图标打开 71 字符完整来源，完成后返回原线程。证据为工作区外 `native-selection-icon-visible/opened/returned.png`，Native 性能探针不存在。该修复不改变 iOS 原生符号分支、provider 或连接协议。

原生性能仍开放：曾在多次开发包重载并展开活动后发生 LOW_MEMORY 退出，Native Heap 约 0.9GB、RSS 约 1.4GB；重建 JNI 配套只修复启动依赖。生产模式 JS 包也观察到较高原生内存，不能声称内存问题已解决。两次启动堆追踪分别发生缓冲溢出和 INVALID_STACK_BOUNDS，不据此定因；错误含义核对于 2026-10-12 的 [Perfetto 官方协议](https://raw.githubusercontent.com/google/perfetto/main/protos/perfetto/trace/profiling/profile_packet.proto)，检索词 heapprofd / client_error / stack bounds。较小采样记录不替代完整内存或帧率验收。本次仅调整专用模拟器的显示覆盖值，原尺寸/密度/旋转设置已留存，用户原 AVD 未修改。第 4/5/6/8/9 项继续保留各自尚未完成的设备、连接与性能边界。

### 2026-10-12：Native 同口径长历史采样与未通过项

同一调试 APK、生产 JS 模式、专用 Android 17 / 16KB / 约 4GB 模拟器和 1280×720 / 160dpi，对照当前 `7014505e8`、同期 `7ffa6f2b4` 加最初 9 份 Mobile 用户改动，再返回当前版本交叉复测。此次 JS/TS 改动未改变原生模块二进制；已修复的 fbjni 依赖配套在两版本中一致。

真实配对路径只加载服务器保留的最近 500 活动，展开为 254 行，不能代替 1202 规模。因此两个隔离副本的实际 ThreadFeed 都通过各自 `buildThreadFeed` 载入相同 1202 合成活动，全部展开为 605 行；没有改服务器快照上限、生产持久化或主目录源码。初始 scroll=21509、总高 22133、视口高 624，上/下各 20 页 ×4，24 个窗口均实际移动 12480 且无边界空操作。滚动等待真实列表回执和每页 12 个绘制帧，以最近 120 rAF 间隔比较。

| 指标                     | 首次当前           | 同期基线           | 当前交叉复测       |
| ------------------------ | ------------------ | ------------------ | ------------------ |
| 稳态 p95 / 最大 / >50 ms | 17.6 / 19.2 ms / 0 | 18.1 / 19.3 ms / 0 | 18.2 / 18.6 ms / 0 |
| 八窗口最高 p95           | 106.1 ms           | 119.5 ms           | 138.2 ms           |
| 八窗口 p95 中位数        | 88.1 ms            | 102.8 ms           | 95.2 ms            |
| 八窗口最大间隔           | 369.3 ms           | 280.4 ms           | 264.8 ms           |
| 单窗口 >50 ms 的最高数量 | 17                 | 17                 | 23                 |

交叉复测第三组上滚的 p95 与长帧数量超过基线，Native 性能验收保持未通过，不用中位数或较低的一轮替代结果。原始记录为工作区外的 `native-feed-current-perf.json`、`native-feed-baseline-perf.json`、`native-feed-crossover-perf.json`；`summarize-native-feed-perf.cjs current baseline crossover` 同时检查八窗口样本数、行数、高度、页数与移动距离。500 活动轮次单独保存为 `native-feed-current-window500-perf.json`。两个 ThreadFeed 备份 SHA-256 已精确恢复，完整活动临时模块已移除；回执 WebSocket 已关闭，测量的 ADB reverse 端口已清理。主目录没有临时采样入口。

Native Heap / RSS 的较高占用仍需归因；Hermes 的 `Profiler.enable` 返回 Unsupported method，记录工具边界，不编造 CPU profile。正在核对按需图标导入：本地安装的 `@tabler/icons-react-native@3.44.0` 有 6147 个图标模块，AppSymbol 是唯一运行时聚合导入，38,824,759 字节生产包中包含未使用的 BrandTiktok / BrandWhatsapp 等名称；该事实说明包体有可验证的优化候选，尚不能证明它造成这次长帧。第 9 项继续修复和复测，Desktop 独立外壳、iOS、真实运行回合及连接/锚点矩阵仍开放。回退本文档增量可恢复原记录，无数据库迁移或产品配置变化。

### 2026-10-12：Native 图标按需加载与交叉复测

AppSymbol 原先从 Tabler 根入口导入 79 个图标；实际 Metro 生产包包含未使用的 BrandTiktok / BrandWhatsapp 等整套索引。现改为已安装 SDK 3.44.0 的公开单图标入口，根入口仅用于擦除后的 Icon 类型；图标几何、颜色、尺寸、Material/SF 名称映射和回退规则保持一致。生产包从 38,821,377 字节降至 27,221,472 字节，未使用的上述品牌图标已移出。完整活动临时夹具包为 27,224,909 字节，依赖类型补丁安装前后均相同。没有升级 SDK、替换图标设计或引入额外运行时依赖。

SDK 的公开 import.types 误指 dist/icons/_.d.ts，发行文件实际位于 dist/icons/icons/_.d.ts。按项目现有 pnpm patchedDependencies 增加版本限定的单行 package.json 补丁，只修正 ESM 声明路径；require 分支保持原状。未打补丁的纯候选目标 tsc 复现 82 个 TS7016，补丁后目标 tsc 通过；主目录安装补丁后实际 AppSymbol 与测试也通过定向 tsc。4 项实际图标/按钮用例、两源文件 lint 与格式检查通过；SDK 源映射一并复制到隔离测试依赖后不再有缺失 map 的噪声。锁文件仅新增补丁哈希、Mobile 引用与对应快照键，vp install --lockfile-only --frozen-lockfile --offline --ignore-scripts 通过；主目录仅按 Mobile 范围安装冻结锁文件，生命周期脚本未执行。

相同 debug APK / 生产 JS 模式 / Android 17 API 37.1 / x86_64 / 16KB / 1280×720 / 160dpi，继续使用两个版本各自 buildThreadFeed 生成相同 1202 活动输入。所有 24 新窗口均为 605 行、624px 视口、22133px 内容，20 页实际移动 12480px，没有边界空操作；每页等待 12 rAF、最近 120 间隔，上/下各 20 页 ×4 组。采样期间没有并行安装、测试或类型检查。原始记录为工作区外 native-feed-icons-perf.json、native-feed-baseline-icons-perf.json、native-feed-icons-crossover-perf.json，全部保留。

| 版本         | 最高窗口 p95（ms） | 8 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 |
| ------------ | ------------------ | ----------------------- | -------------- | --------------------- |
| 按需图标首轮 | 116.7475           | 85.3863                 | 215.0552       | 17                    |
| 原始基线重测 | 141.1475           | 108.3572                | 344.6282       | 19                    |
| 按需图标交叉 | 137.6201           | 112.8331                | 274.5196       | 19                    |

Native Heap PSS 的重测基线为 969,508KiB（946.8MiB），按需首轮与交叉为 743,892 / 739,460KiB（726.5 / 722.1MiB）；两轮优化的总 PSS 为约 1.03GiB。真实截图仍显示工具、状态、选择与复制图标和已完成代码高亮。按需加载改善包体与内存，但交叉窗口中位数 112.8331ms 仍高于本轮基线 108.3572ms，且最高 p95 高于最初基线 119.4708ms；第 9 项继续未通过，不选择首轮较低结果或提高既定门槛。JS rAF 证据不能代替 Android 合成器 FrameTimeline、iOS 实机或独立 Desktop。

安装补丁产生新的 pnpm 物理目录后，隔离 Metro 一次返回模块解析 500；仅为两个导出目录补充只读 SDK watch 路径，主目录 Metro 配置未改。交叉采样前曾观察到后端开发进程重启导致重新连接，已等待实际界面恢复在线后才开始采样；这只能证明当前静态历史的恢复，不能代替运行中正文重连验收。两个导出 ThreadFeed 已按原始 SHA-256 恢复，完整活动模块和临时 WebSocket reverse 端口已移除，原生采样 PID 已核对身份后主动停止；探针没有进入提交。

本主题影响 Mobile 的共享 AppSymbol 导入；Android 已有原生像素与交互证据，iOS 继续走 ExpoSymbolView，实际 iOS 设备未测。Web/Desktop 使用各自图标实现；provider、设置入口、连接模式及协议没有新增能力或权限门控。依据为本机安装包 exports、实际发行声明与官方 [Tabler React Native SDK 说明](https://github.com/tabler/tabler-icons/blob/main/packages/icons-react-native/README.md)，2026-10-12 检索 tabler icons react native / individual icon exports，并优先采用已安装版本元数据。补丁只对 3.44.0 生效，升级该 SDK 时须核对或移除；回退本主题提交并按冻结锁文件安装即可恢复，无数据迁移。

### 2026-10-12：Android 历史活动受控复用与完整交叉复测

诊断使用组件自己的 useRef 统计挂载，首组上滚 1081 次图标包装渲染中 1041 次为新实例，下滚 1014 次中 994 次为新实例。该两窗口只用于定位重复挂载，不作为性能验收。另一次修改 SDK forwardRef.render 的诊断出现 Native SIGSEGV（退出 reason=5/status=11），未取得有效统计；该方法已弃用，崩溃原因未定，不据此归因产品。

历史行改用普通 View；新行只在本次挂载确定 200ms FadeIn，时间经过不会切换父节点类型。仅轻量容器的交叉最高 p95 109.8581ms 高于同期基线 106.5284ms，未通过，保留全部失败原始记录。后续复用仅限 Android、挂载时已完成超过 3 秒、单条工具活动、无 Canvas 且未展开的历史单行。截止时间固定，不在滚动时把运行中行临时变为历史行；消息、工作状态、多行、展开详情和其他类型均以 entry.id 隔离子树。复用后的复制、展开和完整正文回调继续使用实际 row.id。iOS/Web 不启用此回收路径。

同一 APK、生产 JS 模式、专用 Android 17 API 37.1 / x86_64 / 16KB / 约 4GB RAM，显示 1280×720 / 160dpi；当前导出对应 aa6568e71 加本主题候选，基线为 7ffa6f2b4 加原始 9 份 Mobile 用户改动，两版本使用一致的原生二进制和 fbjni 配套。各版本自己的 buildThreadFeed 接受同一完整 1202 活动输入。每轮八窗口，20 页上/下各 4 组，每页等待实际滚动回执和 12 rAF，最近 120 帧；全部 605 行、624px 视口、22133px 内容、实际移动 12480px、零边界空操作。采样期间没有并行安装、构建或测试。

| 版本               | 最高窗口 p95（ms） | 8 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 | 空闲 p95（ms） |
| ------------------ | ------------------ | ----------------------- | -------------- | --------------------- | -------------- |
| 仅轻量历史容器首轮 | 93.7644            | 81.6799                 | 187.4963       | 14                    | 18.0442        |
| 该轮原始基线       | 106.5284           | 85.0153                 | 264.3319       | 15                    | 17.9831        |
| 仅轻量历史容器交叉 | 109.8581           | 83.4182                 | 214.3117       | 15                    | 34.6303        |
| 受控复用首轮       | 53.6594            | 51.3388                 | 88.3653        | 8                     | 34.6686        |
| 受控复用同期基线   | 93.4326            | 84.3110                 | 320.0122       | 15                    | 18.0484        |
| 受控复用交叉       | 65.0821            | 55.3055                 | 93.4425        | 8                     | 17.9247        |

受控复用两轮所有滚动窗口的 JS 回调间隔 p95、最大间隔与单窗口 >50ms 数均低于同期基线，该口径对照通过。首轮受控复用和轻量容器交叉的空闲回调间隔约为 34ms；最后一轮受控复用空闲 p95 17.9247ms / 最大 18.5451ms，与基线 18.0484ms / 18.8500ms 相近，均零 >50ms。这些值不能转换为 Android 屏幕 FPS，后续已核对实际新架构实现并补充 UI 帧时钟，见末节。首次回调节奏差异没有以末轮数据覆盖；显示查询 60.000004Hz、无 UID 帧率覆盖，不能反推先前采样状态。第 9 项保持开放，iOS、真实忙碌回合、连接和完整滚动锚点矩阵继续独立验收。

原生操作覆盖滚动后复制相邻工具 601 和 600：各得到正确 18 字符全文；展开工具 601 后，详情的实际系统选区与菜单可见，复制选中单字“实”得到正确 1 字符。对应 native-recycling-copy-tool-601.json、native-recycling-copy-tool-600.json、native-recycling-copy-tool-detail.json 均 matches=true，像素证据 native-recycling-detail-selection.png。展开后收起的内容高度修正为 22128px、末端 21504px；原始基线出现相同 5px 修正且均保持末端，未观察到本主题新增偏移，不扩大为所有滚动锚点已通过。消息全文选区仍使用列表外快照，未复用消息子树。

Native Heap PSS 同期基线 966252KiB（943.6MiB），候选首轮 679896KiB（664.0MiB），交叉 669956KiB（654.3MiB）；交叉总 PSS 997316KiB、RSS 1126804KiB、814 个 View。改善不等于长时间内存问题已解决。原始 native-feed-optimized / baseline-optimized / optimized-crossover / recycled / baseline-recycled / recycled-crossover-perf.json 均保留在工作区外，统一汇总脚本验证窗口、页数与几何。四份原生源与两个夹具已按 SHA-256 恢复或移除，采样进程按已登记身份停止；恢复回执 native-recycling-experiment-restored.json 全部为 true。

定向验证：thread-work-log.test.tsx 与 thread-feed-recycling.test.ts 共 20 项通过；覆盖父节点生命周期、原生全文详情、复制身份更新、近期/运行中/展开/Canvas/多行排除、iOS/Web 排除与固定截止时间。目标 tsc、5 份源码/测试 lint 和 7 份文件 fmt 通过。影响范围为 Mobile 历史列表内部呈现；无新增设置、协议、provider 能力、权限或数据迁移。回退本主题提交恢复原列表行为；Web/Desktop 使用各自时间线。轻量历史容器属于共享 Mobile 组件，iOS 同样使用；仅受控单行回收限定 Android，iOS 不启用回收，未运行 iOS 设备验收。

### 2026-10-12：Web 负载证据纠正与实际 Desktop 冷启动对照

实际 Desktop 读取同一隔离线程时，普通客户端活动快照只有 500 条；`orchestration/projector.ts` 的 `MAX_THREAD_ACTIVITIES` 与 `appendThreadActivity` 保留此上限，`orchestration/Layers/ProjectionSnapshotQuery.ts` 的 `THREAD_DETAIL_ACTIVITY_LIMIT` 在 SQL 查询中同样限定为 500。此前 Web 的 1202 数量来自数据库夹具，而 `final-streaming-perf.json`、`contemporaneous-baseline-perf.json`、`crossover-latest-perf.json` 及更早记录未保存实际组件输入或逻辑行数。数据库数量不能证明全部活动进入客户端。因此撤回此前 Web 第 9 项完整 1202 负载通过结论，保留所有旧采样为当时页面快照的观察；Web 需补齐实际输入数量后重跑。既有 DOM 选区、追加、终态和复制的独立证据不由此改变。Android 完整负载记录已直接核对实际 ThreadFeed 输入 1202、展示行 605，不属于该缺口。

Desktop 使用工作区外两个导出：当前 `16c9ef09e` 加最初用户改动，基线 `7ffa6f2b4` 加原始用户快照。只在两个导出的 ChatView 内对指定合成线程补齐相同 1202 活动，交给各版本实际时间线处理；601 条思考与 601 条工具活动展开为 1205 逻辑项。实际 React 列表输入已读回，测量不提高服务端快照上限，不写入主目录探针。两版通过同一 Electron 41.5.0 二进制、同一隔离后端与 CODEWORK_HOME / APPDATA，以官方 `codework-dev://app/` 桌面入口运行，自动登录和 desktopBridge 可见；无真实 provider 回合或生产数据写入。

实际窗口 1280×720、列表视口 668px；各冷启动初始高度 107461px。预热上下各 20 页后，采样起点设为 scrollTop=30000，再等待 130 个可见 rAF；正式上下各 20 页 ×4 组，每页等待真实 scroll 回执和 12 rAF，窗口保存最近 120 间隔。全部 32 个正式冷启动窗口无边界空操作；第 2–4 组各实际移动 13360px，首组保留虚拟列表行高修正造成的实际移动差异。基线重复末态高度 74629px，其余冷启动轮次 74791px，全部几何保留，不把高度变化忽略为固定轨迹。

| 实际 Desktop / 最近 120 rAF | 基线首次 | 当前冷启动交叉 | 基线重复 | 当前重复 |
| --------------------------- | -------- | -------------- | -------- | -------- |
| 空闲 p95                    | 16.8ms   | 16.8ms         | 16.8ms   | 16.8ms   |
| 八窗口最高 p95              | 116.6ms  | 100.0ms        | 99.9ms   | 100.0ms  |
| 窗口 p95 中位数             | 83.30ms  | 83.50ms        | 83.35ms  | 83.30ms  |
| 八窗口最大间隔              | 183.6ms  | 183.3ms        | 199.9ms  | 166.8ms  |
| 单窗口 >50ms 最高数量       | 19       | 13             | 14       | 16       |

首次当前通过 HMR 从原快照补齐负载，实际初始高度 52975px、末态 46333px，与冷启动轮次不同；其最高 p95 133.3ms、最大 200.1ms、长帧最高 22 仍保存，但不用于冷启动无回归判定。冷启动当前部分窗口低于基线，也有对应窗口上升；重复轮次长帧最高 16 超过基线 14，不能只采用最大间隔改善宣称通过。第 9 项继续核验 Desktop 长帧、Web 实际完整负载及 Android 空闲采样差异，不提高门槛或挑选较低轮次。

原始桌面记录为工作区外 `desktop-feed-current-full / baseline-full / crossover-full / baseline-cold-repeat / current-cold-repeat-perf.json`；`summarize-desktop-feed-perf.cjs` 验证两版二进制 SHA、1202 输入、8 窗口、每窗口 20 回执与 120 间隔、零边界及稳定段移动距离，全部通过。列表项数量在冷启动交叉与两轮重复的原始记录内均为 1205；首次基线另由实际列表检查读回。窗口可能重叠，长帧数量不相加。rAF 仅证明桌面页面响应间隔，不能替代生产构建、所有设备、运行中回合、远程/隧道或合成器帧时间。此增量仅纠正两份证据文档，无行为、权限、合同或数据库迁移；回退本主题提交可恢复文档记录。

### 2026-10-12：Web 实际完整输入与桌面调试窗口对照

Web 在上述两个独立源码导出中，经单一浏览器标签交替访问同一隔离后端，实际组件输入 1202 活动、逻辑项 1205（601 思考、601 工具、2 消息、1 回合折叠）。所有正式窗口均为 1280×720、668px 列表视口，上下各 20 页 ×4，每页实际 scroll 回执与 12 rAF，最近 120 间隔；稳定组移动 13360px、零边界。初始高度 107460px、末态 74358px，首组保留实测行高修正。此项补齐此前只有数据库数量的证据缺口，不改变普通快照的 500 条上限。

首轮 Web 的 DPR 为 1.5，最高 p95 35.2ms、最大 62.3ms、单窗口长帧最高 5；跨上下文后视口恢复默认值，前置检查拒绝该次基线初始化。重新校准后 DPR 为 1.0000000298023224，三轮统一此比例，不与首轮混合比较：

| Web 开发构建 | 最高窗口 p95（ms） | 8 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 | 空闲 p95（ms） |
| ------------ | ------------------ | ----------------------- | -------------- | --------------------- | -------------- |
| 当前校准首轮 | 20.5               | 14.40                   | 28.0           | 0                     | 7.6            |
| 同期原始基线 | 35.6               | 20.70                   | 56.4           | 3                     | 7.6            |
| 当前校准交叉 | 35.2               | 34.85                   | 61.6           | 4                     | 7.5            |

首轮较低不代表稳定改善；交叉最大间隔与长帧数高于同期基线，开发态无回归判定继续开放。浏览器下载的完整 JSON 按原字节导入工作区外，SHA、实际输入、每窗 20 回执/120 间隔、DPR 与稳定组距离均验证；原始 `web-complete-current-full / current-calibrated / baseline-calibrated / current-calibrated-crossover-perf.json` 全部保留。专用标签已关闭、临时视口已恢复。没有发送真实 provider 回合。

Desktop CPU 诊断显示 LegendList 几何读取与 React 开发态 SVG 创建开销，仍有无法归因的 program 样本，不将诊断采样当正式验收。仅隔离导出的历史工具行回收实验，首轮/基线/交叉最高 p95 为 48.3/97.2/104.0ms，最大 63.2/151.9/236.4ms，长帧最高 6/19/19；交叉未通过，实验按 SHA 还原，拒绝源码与三份原始记录均保留，未进入主目录或提交。

桌面开发启动在 `DesktopWindow.ts` 自动打开独立 DevTools。随后三轮通过实际 Electron API 确认 `wasOpen=true`、关闭回执 `isOpen=false`，使用同一 Electron 41.5.0 二进制、隔离后端与实际 desktopBridge；屏幕查询为 144Hz / 缩放 1.5、窗口 1280×720、DPR 1.5。两版均关闭 DevTools，采样协议和实际输入数量相同：

| Desktop / DevTools 已关闭 | 最高窗口 p95（ms） | 8 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 | 空闲 p95（ms） |
| ------------------------- | ------------------ | ----------------------- | -------------- | --------------------- | -------------- |
| 当前首轮                  | 41.8               | 41.55                   | 76.8           | 6                     | 7.5            |
| 同期原始基线              | 41.7               | 27.85                   | 70.0           | 3                     | 7.6            |
| 当前交叉                  | 56.1               | 27.60                   | 97.4           | 8                     | 7.6            |

当前交叉启动可见 Codex 状态探测错误横幅；实际初始高度 107374px，其余两轮 107460px，末态分别 74434/74358/74682px。这一启动状态差异与长帧波动尚未归因，不假定关闭调试窗口已解决全部差异。全部 24 窗口回执及稳定距离符合协议，但不能据首轮或调试窗口关闭后的下降宣布产品无回归。原始 `desktop-feed-closed-tools-current / baseline / crossover-perf.json` 和三次关闭回执均保留，专用 Electron 会话通过自身 close API 结束。

`summarize-complete-development-perf.cjs` 对上述 10 份完整记录（4 Web、3 拒绝实验、3 关闭 DevTools）验证实际输入、逻辑项、视口、窗口、滚动回执、样本、距离与关闭状态通过。未在正式采样期间并行构建、安装或运行测试。第 9 项继续检查生产构建、Android 空闲差异及运行中连接/锚点矩阵；临时探针仍只在隔离导出，并须在对应验证结束后按清单恢复。此主题仅补证据文档，回退提交即可恢复记录，无合同、权限或数据迁移。

### 2026-10-12：生产 Web 与实际 Desktop 的完整负载对照

生产基线采用目标开始前的完整 `d588bee5e` 加最初全部 98 份用户文件快照；当前采用 `16c9ef09e` 加同一批快照。旧 `7ffa6f2b4` 加原始快照在开发聊天页可运行，但生产编译的设置懒模块缺少被原始 settings.ts 覆盖的三态导出，不能作为完整生产基线。为此另建原始 HEAD 导出，各自使用本版本源码别名与同一套已安装依赖，未用当前实现修补原始基线。两版生产编译均退出 0。基线一次辅助路径判断失败发生在编译成功之后：实际产物位于另一个专用导出，核对绝对路径、文件数与入口 SHA 后移至其指定专用产物目录，源码和产物字节没有替换。

完整活动仍只补入指定合成线程的隔离 ChatView，两版实际列表均读回 1202 活动 / 1205 逻辑项（601 思考、601 工具、2 消息、1 回合折叠），服务端快照上限保持 500。各轮为 1280×720、668px 列表视口；先上下 20 页预热，再以 30000px 起点等待 130 rAF；正式上/下各 20 页 ×4，每页等实际 scroll 回执及 12 rAF，窗口保留最近 120 间隔。72 个正式窗口均无边界空操作，稳定组实际移动 13360px；采样期间未并行构建、测试或安装。

| Web 生产构建 / DPR 约 1.0 | 最高窗口 p95（ms） | 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 | 空闲 p95（ms） |
| ------------------------- | ------------------ | --------------------- | -------------- | --------------------- | -------------- |
| 当前首轮                  | 7.7                | 7.60                  | 14.8           | 0                     | 7.5            |
| 原始基线                  | 7.6                | 7.50                  | 14.1           | 0                     | 7.7            |
| 当前交叉                  | 7.6                | 7.45                  | 14.0           | 0                     | 7.5            |

Web 三轮实际 DPR 均为 1.0000000298023224，初始/末态均为 107460/74358px。首轮最高 p95 比基线多 0.1ms、最大间隔多 0.7ms，原值保留；交叉回到基线范围且三轮零长帧，本次静态完整历史未观察到持续回归。首次预热停在宿主后台时没有形成正式窗口；Codex 打开请求返回 queued，经用户授权切到本聊天前台后冷启动完成采样，后台不完整记录单独保存，不纳入成绩。全部原始 JSON 经正常浏览器下载保留字节和 SHA，测试标签已关闭并恢复默认视口与原浏览器可见性。

Desktop 共用实际 Electron 41.5.0 / Node 24.15.0 二进制、13779 专用后端、独立 CODEWORK_HOME / APPDATA 和自动登录 desktopBridge，通过 `codework-dev://app/` 加载两版生产前端；每轮实际关闭 DevTools，关闭回执均为 true→false。二进制 SHA-256 为 `85d6a27fb2da98443db398847c10ef45892c430104767af40208510243aece40`。

| Desktop 生产 / DPR 1.5 / 约 144Hz | 最高窗口 p95（ms） | 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 | 空闲 p95（ms） |
| --------------------------------- | ------------------ | --------------------- | -------------- | --------------------- | -------------- |
| 当前首轮                          | 7.6                | 7.50                  | 14.1           | 0                     | 7.6            |
| 原始基线                          | 7.6                | 7.50                  | 13.4           | 0                     | 7.5            |
| 当前交叉                          | 7.6                | 7.60                  | 13.5           | 0                     | 7.5            |

该组首轮/基线初始/末态均为 107460/74358px；交叉在列表启动调整期间已到 scroll=4830.6665px，初始/末态为 100008/68958px，不能假定虚拟行高估算轨迹一致。交叉数据保留，随后增加统一绘制等待的整组三轮。补测时宿主显示条件发生变化：新窗口显示查询由 2560×1440 / 144Hz / scaleFactor 1.5 变为 1920×1080 / 60Hz / scaleFactor 1，页面 DPR 相应变为 1；尺寸调整后继续等待实际绘制帧并检查渲染视口，不跨显示条件比较绝对帧间隔。

| Desktop 生产 / DPR 1 / 约 60Hz | 最高窗口 p95（ms） | 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高个数 | 空闲 p95（ms） |
| ------------------------------ | ------------------ | --------------------- | -------------- | --------------------- | -------------- |
| 当前统一等待                   | 16.8               | 16.80                 | 16.8           | 0                     | 16.8           |
| 原始基线统一等待               | 16.8               | 16.80                 | 16.9           | 0                     | 16.8           |
| 当前交叉统一等待               | 16.8               | 16.80                 | 16.9           | 0                     | 16.8           |

统一等待组在进入线程和展开后各等待 130 个实际绘制帧，再执行原采样协议。三轮实际 DPR 均为 1、初始 scroll=0、高度 107461px、末态 74629px、每个稳定窗口移动 13360px；最高 p95 同为 16.8ms、全部零长帧，未观察到静态完整历史的持续性能回归。两次关闭后立即重开时测试调试上下文退出，没有进入正式采样；启动器增加主进程与启动进程退出身份核对，失败日志保留，不作为产品帧率。旧开发态失败和拒绝的工具行回收实验仍保留，生产构建结果不将它们改写为通过。

`summarize-production-full-perf.cjs` 验证上述 9 份记录、72 窗口、原始基线版本、生产模式、实际输入/逻辑项、同组 DPR、桌面二进制 SHA、20 滚动回执 / 120 间隔、零边界、稳定距离与统一等待组几何全部通过。原始记录为工作区外 `web-production-current-full / baseline-full / current-crossover-perf.json`、`desktop-feed-production-current / baseline / crossover-perf.json`、`desktop-feed-production-settled-current / baseline / crossover-perf.json`。6 个前端服务与全部专用 Electron 会话已按本次登记身份关闭；5 份原始入口/ChatView 文件按 SHA 恢复，19 份清单内临时探针文件已移除，主目录源码哈希保持不变，生产产物与原始采样继续留存。

此增量仅补两份证据文档，无新增产品动画、设置、provider 能力、合同、权限、持久化或数据迁移。第 9 项继续保留 Android 首轮空闲差异，以及真实忙碌回合、完整连接/滚动锚点和 iOS 设备边界；本次 JS rAF 不替代原生合成器帧时间。回退本主题提交可恢复此前文档记录。

### 2026-10-13：Android 回调时钟纠正与 UI 帧补充交叉

测量发生于 2026-10-12，实际 React Native 0.85.3 的 `RN$Bridgeless=true`。本机对应 `TimerManager.cpp:358` 将 `requestAnimationFrame` 排入零延时计时器；旧 Native rAF 记录全部保留为 JS 响应间隔，不能据其约 18/35ms 推断屏幕运行于 60/30FPS。匹配版本的 [官方实现](https://github.com/react/react-native/blob/v0.85.3/packages/react-native/ReactCommon/react/runtime/TimerManager.cpp) 与 [React Native 性能说明](https://reactnative.dev/docs/performance) 是采用依据。检索日期 2026-10-12，关键词 RN Android requestAnimationFrame / TimerManager / UI frame clock；优先使用安装版本和官方源码，旧版本 issue 不作为本机原因证明。

四份额外空闲记录仍采用原 JS 回调口径。每轮滚动前后各四个窗口，每窗等待 130 回调、取最近 120 间隔；中间上/下各 20 页，实际移动 12480px。实际输入 1202、605 行、624px 视口、22133px 内容且 AppState active。

| JS 空闲回调对照                     | 滚动前最高 p95 / 最大（ms） | 滚动后最高 p95 / 最大（ms） | 前 / 后单窗口 >50ms 最高数 |
| ----------------------------------- | --------------------------- | --------------------------- | -------------------------- |
| 当前                                | 19.5548 / 20.7209           | 34.7767 / 36.4152           | 0 / 0                      |
| 基线                                | 18.0810 / 18.9104           | 18.6577 / 20.2206           | 0 / 0                      |
| 当前交叉                            | 35.4142 / 51.5067           | 35.4648 / 37.4929           | 1 / 0                      |
| 仅恢复历史 Animated.View 的拒绝实验 | 35.1091 / 36.9661           | 34.9150 / 40.9292           | 0 / 0                      |

实验保留受控回收，仅改变历史容器；没有消除回调差异，已按 SHA 恢复，未修改主目录。同期 SurfaceFlinger 查询仍为约 60Hz、无 UID 覆盖，轮次内 missed-frame 计数未变；没有证明 Android 自动空闲策略是原因。

补充 UI 口径使用已安装 Reanimated 4.3.1 的 [useFrameCallback](https://docs.swmansion.com/react-native-reanimated/docs/advanced/useFrameCallback/) 读取 `FrameInfo.timeSincePreviousFrame`。观察器仅在测量期间启停，不驱动 React 状态或动画样式。每轮滚动前后等待 130 UI 帧、八窗口上/下各 20 页、每页等待 12 个 UI 帧及实际滚动回执、最近 120 个 UI 间隔；全部实际输入 1202、605 行、624/22133px、每窗口移动 12480px、零边界空操作。三轮同一 APK、生产 JS、1280×720/160dpi，当前接受的 Mobile 源码已与提交逐一校验。

| Native UI 帧时钟 | 最高窗口 p95（ms） | 窗口 p95 中位数（ms） | 最大间隔（ms） | 单窗口 >50ms 最高数 | 前 / 后空闲 p95（ms） |
| ---------------- | ------------------ | --------------------- | -------------- | ------------------- | --------------------- |
| 当前             | 34.096696          | 16.666666             | 49.999998      | 0                   | 16.666666 / 16.666666 |
| 基线             | 49.999998          | 35.674750             | 766.666636     | 5                   | 16.666666 / 16.666666 |
| 当前交叉         | 50.011098          | 34.025381             | 116.666662     | 7                   | 16.677768 / 16.666666 |

首轮当前各对应窗口均改善；交叉不满足全部对应指标无回归：首窗最高 p95 比基线约多 0.0111ms，>50ms 数 7 高于 5；第二窗最大 100ms 高于基线约 83.33ms；第二组上滚 p95 35.383782ms 高于 34.007632ms。七个首窗长间隔包含约 66.67、83.33ms，不能全部解释为浮点精度。未调整 >50ms 门槛，未筛掉首窗，补充 UI 交叉保持未通过。

三轮同步保存独立 Perfetto [FrameTimeline](https://perfetto.dev/docs/data-sources/frametimeline) 与 process_stats 跟踪，采用本机官方 Trace Processor v58.2。实际/预期帧为 326/326、662/662、381/381，完整帧均为 buffer；最大持续时间 83.677/772.6305/503.3213ms、均值 16.983104/46.457366/50.850724ms。交叉均值高于基线，不能宣称合成器全部改善。无 data_loss 严重级别记录，但 info 级 `frame_timeline_event_parser_errors` 为 325/285/304，分类解释保留该限制。BufferStuffing 和 Non-perceivableJank 单独保留，不能把 `jank_type != None` 一概计作用户掉帧。

原始 `native-idle-{current,baseline,crossover,animated-history}-perf.json`、`native-ui-frames-{current,baseline,crossover}.json/.pftrace`、逐帧及分类 CSV 均留在工作区外；汇总校验 24 窗口、输入、源码 SHA、UI 回执、样本、距离和 trace SHA 通过。两个导出的探针与夹具已恢复/移除，`native-ui-frame-probes-restored.json` 的源码恢复、主目录不变与当前提交一致全部为 true；原生采样进程与 Metro 按登记身份停止。第 9 项的完整无回归结论仍开放。此主题仅纠正两份证据文档，回退提交即可恢复文档，没有产品动画、协议、权限或数据迁移。

### 第 8 项：独立状态流合并与实际忙碌连接（2026-10-13）

`mergeEnvironmentThread` 原来始终用 shell 会话覆盖详情会话。两条流独立到达时，较旧的 shell 可使运行中线程重开显示发送，或使已结束回合继续显示停止。现在按 `session.updatedAt` 比较时刻；较新的详情会话和 `latestTurn` 一同保留，相同时刻仍采用 shell。普通 shell 元数据更新时间不代替会话时刻；工作区、分支、权限等元数据继续采用 shell，详情消息集合保持原引用。该合并由 Web、Desktop 和 Mobile 共用，不增加协议字段、刷新循环或 provider 分支。

原实现的四种较新详情会话用例均失败，修复后运行 `vp test run packages/client-runtime/src/state/entities.test.ts apps/web/src/state/entities.test.ts` 共 18 项通过；覆盖 ready/running/interrupted/error、相同/较新 shell 时刻及等价时区。client-runtime 目标 `tsgo --noEmit --project packages/client-runtime/tsconfig.json`、触及源码 lint/fmt 与 diff 检查通过。

| 客户端与版本                  | 实际观察                                                                                                                 | 验收边界                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Web 开发构建，修复前          | 离开线程时 transport 保留；重新打开接收关闭期间 C003；断线保留正文/代码，恢复 D004/E005 各一次；终态恢复发送             | 实际 ingestion/engine/projector，受控 Codex runtime，没有外部 provider 调用                               |
| Android 生产 JS，修复前       | 离开 Home 时连接保留；重新打开 F006，断线 G007 与同原事件 ID 重投，恢复 H008 各一次；终态去除运行标记                    | SDK 新鲜层级与实际截图；旧 `uiautomator dump` 失败后复用的 XML 已排除；不是 iOS 设备证据                  |
| Electron 开发构建，修复前     | I009/J010/K011 正文保持；终态仍显示停止                                                                                  | 保留失败，HMR 模块身份诊断不能作为运行时根因结论                                                          |
| Electron 生产构建，修复前     | 断线恢复与终态发送通过；运行中重开曾显示发送                                                                             | 保留运行标记错误与 Git 超时，不扩大为整个第 8 项通过                                                      |
| Electron 候选生产构建，修复后 | 有效运行/重开/断线/恢复均显示停止生成；终态显示发送消息；同一规范 assistant ID，A001/C003/D004/E005 一次且按序，代码保留 | 159 字符与数据库全文相同，streaming=0/session=ready，历史共 6 消息；provider 尚未启动的前三份记录明确排除 |

候选 Web 首次配对后仍出现空项目列表，保存为 `busy-web-fixed-initial-empty`，重载也未解决；不能宣称初次远程环境展示已修复。Android 候选冷加载遇到 Metro manifest 加载失败，保留错误页与新启动记录，尚未作为此修复的设备通过证据。原 Electron 首次新增远程环境也曾因 HTTP shell 6 秒超时未显示项目，后来重载显示；直接 HTTP 同期 200、Git 直接执行约 58–68ms，与服务端 GitVcsDriver 5 秒超时并存，根因尚未解决。

原始忙碌动作、代理连接收据、DOM/SDK 层级、截图、只读数据库快照及 `busy-runtime-fixed-verified.json` 保留在工作区外。隔离 fixture 只控制 Codex `makeRuntime` 的事件，之后走真实 ingestion/engine/projector，不修改主产品入口、不调用外部 CLI。其余 adapter 的第 7 项终态定向测试仍适用，但本轮不证明各真实 provider、隧道、多环境切换或完整滚动锚点矩阵；第 8 项继续开放，第 9 项原生 UI 交叉仍未通过。回退此提交即可恢复合并与文档，无数据迁移。

### 第 8 项：Windows SDK 后台控制台路径（2026-10-13）

上述首次空列表问题继续定位到 Windows 主机的后台进程启动。直连 13809、代理 13811、候选 Web 5763 的同一 shell 接口均曾在 20 秒超时；直接 Node spawn 与独立 ProcessRunner 则约 55–65ms 成功。仅重启原 SDK 后端，服务内诊断仍在 12 秒超时。SDK 4.0.0-beta.103 没有给 `spawn` 和 Windows `taskkill` 传入 `windowsHide`；[Node 官方说明](https://nodejs.org/api/child_process.html)该选项默认 false。

隔离预加载试验仅设置隐藏选项，实际服务 ProcessRunner 约 90ms 成功，三个 shell 请求 125–166ms 返回 200，真实 Web 恢复项目与线程。随后收敛为 `@effect/platform-node-shared@4.0.0-beta.103` 的固定版本补丁：只在 SDK 的启动与两个既有 Windows 清理调用补充隐藏选项，src/dist 同步；不升级依赖、不修改 argv、stdio、终态或权限。它保留既有 MIT 依赖许可，不移植参考项目源码。

| 验证层次               | 结果与边界                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 原包与候选定向对照 | 3 项原包失败，补丁通过；真实子进程核对引号/Unicode argv、stdin/stdout/stderr 与退出码，清理调用使用替身，未向已退出 PID 执行真实 taskkill                                                               |
| 默认仓库定向入口       | `vp test run apps/server/src/windowsProcessSpawner.test.ts apps/server/src/processRunner.test.ts apps/server/src/project/RepositoryIdentityResolver.test.ts`，3 文件 23 项通过；目标类型、lint/fmt 通过 |
| 冻结安装               | 隔离目录与主工作区均按 `--frozen-lockfile --offline --ignore-scripts --filter 'codework...'` 成功；安装后 SDK 运行时 SHA 与候选一致；锁文件仅新增补丁及四处对应引用，无版本升级                         |
| 实际 SDK 后端产物      | 不使用临时 NODE_OPTIONS 预加载；实际 ProcessRunner 约 86ms、退出码 0；直连/代理/候选 Web shell 均 200，409–427ms，1 项目/1 线程                                                                         |
| 首次配对的真实 Web     | 新 localhost origin 的独立浏览器存储，首次配对后无需重载即显示项目与既有线程；原先空列表的 origin 与失败记录保留                                                                                        |

测试 runner 原生加载 SDK 时会绕过 builtin 替身，最初默认入口的三项观察断言因此失败，并未调用对应替身。按 [Vitest 官方依赖内联说明](https://vitest.dev/config/server.html)仅内联两个 Node SDK 包后，默认入口的实际已安装补丁通过；没有跳过或放宽断言。SDK 的非零退出后 PID 清理身份问题仍归第 16 项，不把隐藏选项补丁当作进程 registry 的实现。

隔离 SDK 副本的初次构建缺少 hoisted `ws` peer，启动被拒绝；补齐仅在隔离 pack 配置中的既有 peer 映射后，产物的版本入口与后端均启动成功。临时 pack 配置已按 SHA 恢复，主产品没有预加载探针。`busy-shell-http-{fixed,hidden,sdk-corrected}-diagnostic.json`、服务进程诊断、23 项结果、冻结安装及 `busy-sdk-fresh-web-initial` DOM/截图均在工作区外。对照支持控制台创建路径导致等待的解释，没有把当时主机内存压力认定为已证实根因。

适用面为 Windows 主机的 SDK 进程，不改变 Web/Desktop/Mobile 协议或连接模式；Node 在其他平台忽略隐藏控制台选项。真实 provider、隧道及完整锚点矩阵继续开放，Android 候选 manifest 加载和第 9 项 UI 交叉仍未完成。官方资料于 2026-10-13 检索 `Node child_process windowsHide`、`Vitest external dependencies mocking`，采用 Node/Vitest 原始说明及本机已安装 SDK 源码。回退本主题并按锁文件重新安装可恢复原 SDK；升级该 SDK 时需核对并重建补丁，无数据迁移。

### 第 8 项：当前候选的三端正文与终态复验（2026-10-13）

Android manifest 后续返回 200，预热后显式重新打开开发客户端进入真实应用，候选 `threadDetail` 已加载；之前的 EOF、SocketTimeout、错误页与重载到开发器 Home 的记录保留。没有证明 Expo runtime-version 子进程是失败原因，没有为此增加 SDK 补丁。Web/Android 从真实入口重开同一忙碌线程，关闭期间六个既有代理 TCP 连接均保持；断线时正文/代码保持、连接提示可见，原事件 ID 重投后恢复 C003/D004/E005 各一次且按序。实际 Electron 同期观察到同一规范消息，运行中停止生成、终态发送消息；Android 原生截图的红色停止方块转为发送箭头，工作计时与运行标记消失，SDK 层级未暴露图标按钮名称，不用空名称推断状态。

本轮用主目录冻结安装的 SDK 按恢复后的普通隔离构建配置打包，版本入口与服务启动通过，不再依靠 SDK 或 peer 临时别名，也没有 NODE_OPTIONS 预加载。夹具回合/原事件 ID 增加本次进程 UUID，避免测试后端重启时重用旧编号；它不进入产品源码。当前回合 159 字符与只读数据库完全一致、streaming=0/session=ready，历史六条消息逐字段不变，总计八条。`verify-current-busy-clients.cjs` 核对六份 Web 记录、五份新鲜原生层级、两份真实 Electron 记录、原历史与连接收据通过，汇总为 `busy-current-clients-accepted.json`。

虚拟列表的物理 DOM 顺序与可见顺序不同。最初按最后一个 DOM assistant 推断即时重开缺消息，已通过规范 messageId 与两张实际截图纠正：即时记录已经包含当前全文，位置与稳定记录一致。原始记录和初始判断仍保留，不把错误诊断写成产品故障；未录制连续帧，也未完成滚动锚点、隧道或外部真实 provider 矩阵，因此第 8 项继续开放，第 9 项 UI 交叉仍未通过。本主题仅补充两份证据文档，回退对应提交即可恢复，无产品数据迁移。

### 第 8 项：移动端重开视口与连续帧补充（2026-10-13）

随后录制了实际关闭与重开的连续过程。Desktop v2 的 151 张 SDK 帧中，Home 返回聊天后正文与代码可见；Android v2 原始视频为 1280×720、45.889922 秒、191 个编码帧，重开后的多个帧正文为空，最后恢复。此前静态截图没有捕捉到这个区间，不能沿用静态记录声称无闪烁通过。录屏与提取原帧均保留，不重采样、不作为第 9 项 UI 帧率。

隔离诊断显示空白时仍有 14 条缓存输入、15 条展示行，freeze=false；首轮视口约 900×519，估计总高度 5673px，稳定后为 900×624、2993px。`ThreadFeed` 原来每次挂载把分栏宽度与高度设为零，需要先修正排版与列表末尾。现在只保存上一轮非零实测视口，窗口宽高和布局相同才复用，实际 onLayout 继续修正；只存一条数字记录，不保留消息、选区、列表实例或订阅。Web/Desktop、provider 契约及远程/隧道协议不变，iOS 使用相同尺寸提示但未在本机运行。

诊断原版录像检测到 129 个正文空白编码帧，区间 1.042489—4.687100 秒；视口实验为 9 帧、0.554067—0.721833 秒。去掉探针、重新生产打包并冷启动后，真实候选为 14 帧、0.681111—0.935289 秒，之后回复和代码保持可见。像素检查只在固定正文区域辨识空白，并用原帧人工核对；它不测量显示帧率。初次挂载仍有约 0.25 秒空白，第 8 项无闪烁与完整连接矩阵继续开放，第 9 项 Native UI 回归仍未通过。

`vp test run` 定向运行 `thread-feed-recycling`、`thread-feed-live-follow`、`threadContentPresentation`、`threadActivity`，4 文件 82 项通过；`ThreadFeed.tsx` 的 lint、fmt 与 diff 检查通过。单文件目标 tsc 缺少应用导航声明会报告 navigate 的 never；加入实际 Stack 后，只剩用户原有 `SettingsByokRouteScreen` 两处导航参数错误。纯 HEAD 加本次源码候选使用实际导航声明与依赖路径进行 `tsc --noEmit`，无诊断通过，没有改用户文件或放宽类型。生产 JS 包 27225246 字节，源码 SHA 与 Main 相同，所有采样探针已从候选移除。

原始 `native-busy-reopen-{v2,diag,viewport,candidate}.mp4`、对应编码时间与原帧、像素记录、SDK 层级和候选类型日志在工作区外。受控第六回合已完成，115 字符、19 个夹具事件，实际 Native 红色停止方块恢复发送箭头；本轮 C003 在可见页到达，没有将其记作关闭期间事件。回退本主题即可恢复原视口初始化，无数据迁移。

### 第 9 项：原始完整基线的 Android UI 对照通过（2026-10-13）

旧补充交叉失败保留。重新建立目标开始前 `d588bee5e` 加原始 98 项工作区快照的完整 Native 基线；独立 Git 索引和源码别名在工作区外，不改变主索引。基线列表源码与旧 `7ffa6f2b4` 的列表字节恰好相同，整套源码与设置仍以目标开始前版本为准。当前为 `54a45f967`。两版使用同一 APK、RN 0.85.3 / Reanimated 4.3.1、1280×720 / 160dpi，生产 JS；原始基线包 38789428 字节、9536 模块，当前两轮 27232662 字节、3477 模块，当前/交叉包 SHA 相同。

采样前只停止本任务已不用的旧开发/生产前端：核对登记父 PID、创建时间、命令、工作区和直属端口后停止具体进程树，用户终端及其他应用保持。可用内存约 1.8GB 增至 3.2GB，没有把内存变化认定为此前失败的唯一原因。真实客户端打开性能线程，展开回合与之前 600 次工具调用后，三轮均校准为 1202 活动、605 行、624px 视口、22133px 内容、初始滚动 21509px。UI 帧回调只在测量期间开启，无样式或 React 状态采样写入；采样时没有并行构建、类型检查或浏览器操作。

| UI 时钟正式对照 | 最高窗口 p95（ms） | 窗口 p95 中位数（ms） | 最大间隔（ms） | 8 窗口 >50ms 总数 | 前 / 后空闲 p95（ms） |
| --------------- | ------------------ | --------------------- | -------------- | ----------------- | --------------------- |
| 当前            | 33.333332          | 16.666666             | 39.013400      | 0                 | 16.666666 / 16.666666 |
| 原始基线        | 49.999998          | 35.701021             | 199.999992     | 28                | 16.666666 / 16.666666 |
| 当前交叉        | 33.333332          | 16.666666             | 41.048004      | 0                 | 16.666666 / 16.666666 |

全部 24 个窗口各有 20 页操作、120 个 UI 间隔样本、实际稳定移动 12480px、零边界。两当前轮的 16 个对应窗口逐一比较 p95、最大间隔与 >50ms 数量，全部不高于原始基线；前后空闲也不高于基线。没有采用容差放宽比较，验证汇总为 `native-ui-clean-accepted.json`。

FrameTimeline 三轮实际/预期帧数为 331/331、606/606、331/331，无不完整帧；平均持续时间 18.571909 / 40.154856 / 18.605246ms，最大 81.9164 / 511.5925 / 97.0278ms。当前与交叉两项均不高于基线。info 级解析计数 325 / 285 / 323 保留，没有 data_loss；不把虚拟设备上的分类扩大为完整掉帧计数，也不把编码录像或旧 RN rAF 回调当作 UI 帧率。

`native-ui-clean-{current,baseline,crossover}.json`、pftrace、逐帧 CSV、包 SHA、24 窗口验证与 16 对应窗口比较全部在工作区外；旧失败记录不覆盖。两个导出的列表源码已按 SHA 恢复，临时模块移除，帧回调、测量连接及 reverse 端口关闭。主目录没有产品改动。Web/Desktop 的生产静态结果与原始边界继续采用既有 72 窗口证据；本主题关闭第 9 项所述同口径静态性能缺口，真实流式发布节奏、忙碌重开、滚动锚点与连接模式矩阵继续归第 4/5/6/8 项，不据本结果宣布完整目标完成。回退本证据提交即可恢复文档，无数据迁移。

### 2026-10-13：移动端状态与文字时钟使用真实 UI 帧

React Native 0.85.3 bridgeless 的 rAF 是零延时计时器；此前仅纠正性能测量口径，产品中的 `FrameClock` 与 `hostTextRevealClock` 仍使用该路径。本主题新增 `native-frame-queue`，由 `NativeFrameScheduler` 的 Reanimated UI 帧回调调度，接入 Mobile connection layer，并向 `StreamingMarkdown` 提供同一文字时钟。完整事件累积、缓存游标和全文不经过调度队列；共享 hook 的可选时钟参数保留 Web/Desktop 默认实现。

队列只在有等待内容时激活，快照合并与文字揭示共用一次 UI 通知；在途门控避免 JS 忙碌时积累通知，回调中新请求等下一帧。取消、旧驱动、旧激活代次和相同时间戳不会消费新的请求。后台或驱动未挂载时保留 100ms 单次计时器兜底，空闲与前台恢复时取消；Android 实测后台会暂停 JS 计时器，不能将此兜底描述为操作系统保证的 100ms 截止时间。实测后台等待在返回前台后的真实 UI 帧完成。

定向命令 `vp test run apps/mobile/src/connection/native-frame-queue.test.ts apps/mobile/src/connection/native-frame-clock.test.ts packages/client-runtime/src/state/latestFrame.test.ts packages/client-runtime/src/textReveal.test.ts packages/client-runtime/src/state/threads-atoms.test.ts` 共 56 项通过，覆盖同帧多更新、重入、取消、前后台切换、旧驱动与实际 Effect layer。10 个代码文件 lint/format 和纯候选 Mobile/共享类型检查通过；原工作区 BYOK 导航已有错误没有纳入本主题或改写为通过。

本机隔离 Android、production JS、1280×720、RN 0.85.3 的 SDK 记录：首个快照立即发布，随后 24 组各 8 次完整快照更新分别合并成 24 次发布，值为每组最后值，全部对应不同的真实 UI 时间戳，相邻间隔约 16.666666ms。取消的文字时钟回调为 0；完成采样与后续空闲观察的事件数组完全一致，末态 driver 不活跃。后台请求返回前台后经真实 UI 帧完成；实际界面返回已配对线程列表。原始 `native-frame-clock-probe-*.json`、验证脚本及 `native-frame-clock-device-accepted.json` 保存在工作区外。

实际 Hermes 缺少 `Intl.Segmenter`，因此旧 `createTextReveal` 的能力降级会直接显示新增全文，本次真实文字样本只有一次变化。它不能作为移动端渐进揭示通过证据；第 5 项继续开放，下一主题补齐字素兼容与真实忙碌回合。UI 时钟探针只装在隔离导出中，按 SHA 还原并移除；没有进入主目录或提交。

适用所有 provider 的客户端完整快照，无 adapter/RPC/权限/协议变化。本地、远程和隧道沿用同一客户端连接层；实际覆盖本机隔离 Android 的连接与前后台恢复，iOS/真实隧道没有设备证据。既有 Web/Desktop 时钟保持默认；不新增产品动画或持久化。回退本主题提交即可恢复旧时钟，无数据迁移。

调试稳定性补记：探针运行期间出现一次 Hermes 原生 SIGSEGV（PID 31674，2026-10-12 22:50:50 UTC，fault address 0，`mqt_v_js` / `performMicrotaskCheckpoint`）。原始 crash buffer 已保存，没有将失败抹去。检索日期 2026-10-13，关键词 Hermes SIGSEGV RuntimeScheduler_Modern inspector 0.85；采用 [Hermes 官方仓库 #2118](https://github.com/facebook/hermes/issues/2118)，其中同版 RN 0.85.3 的 CDP attach/evaluate/disconnect 可在断开后延迟崩溃的报告与本次调试方式吻合，因此怀疑为调试器缺陷，尚无符号化根因证明。移除探针、冷启动相同产品 bundle（27234974 字节，SHA `6f10659b59a8e8a6bf0aad0df025b974640cf7017549434ec882c8755602ace0`）后停止 CDP 接入，使用 Android SDK 实际界面检查线程进入/返回与前后台恢复；后续 Native 验收改用 SDK 回执及应用私有文件，避免反复接入此调试器。未改 SDK/依赖或对该原生崩溃宣称已修复。

### 2026-10-13：Hermes 缺少 Intl.Segmenter 时仍按字素揭示

上一主题在真实 Android 发现 `Intl.Segmenter` 不存在，旧 `createTextReveal` 因此直接显示新增全文。新增回归测试先在旧版失败：期望保留首段并安排一帧，实际已显示全部 951 字符。修复保留支持客户端的原生分段器，缺少时使用固定版本 `unicode-segmenter 0.17.3` 的局部 `graphemeSegments`；不写全局 Intl、不维护自写 Unicode 表。稳定前缀仍保留，仅重分末个字素及新增尾文。

检索日期 2026-10-13，关键词 unicode-segmenter graphemeSegments Hermes React Native。采用 [库的官方文档](https://github.com/cometkim/unicode-segmenter) 与 npm 官方 registry 的 0.17.3 元数据：提供 UAX #29 字素分段、明确支持 Hermes、无传递依赖、MIT。只引入字素入口，避免完整词句分段 polyfill；未采用官方性能倍数作为本机验收数据。client-runtime manifest 加一项精确依赖，锁文件仅增加本库的 importer/packages/snapshot 共 8 行；安装后原 Windows Node SDK 修补与已验证冻结安装的 SHA 一致。

`vp test run packages/client-runtime/src/textReveal.test.ts apps/mobile/src/connection/native-frame-queue.test.ts apps/mobile/src/connection/native-frame-clock.test.ts` 47 项通过；缺少 Intl、家庭 emoji、国旗、重音、CRLF、肤色、印地语连字、分包代理对/ZWJ/国旗、选择前追上全文及终态停止均覆盖。两源文件 lint/format、共享及 Mobile 纯候选类型检查通过。既有完整正文、节奏开关、首段与终态语义保持不变。

同一隔离 Android、production JS、1280×720、RN 0.85.3，在无 CDP 连接下自动执行实际 Effect publisher、Native UI clock 和真实 `createTextReveal`，通过 Expo 文件 API 写应用私有 JSON，再由 Android SDK `run-as` 读取。回执确认原生 Segmenter 为 undefined；首段全文立即显示，24 组完整状态合并对应 24 个不同 UI 帧，1249 字符完整正文产生 43 次字素完整的前缀揭示，各对应不同 UI 帧；保存全文、终态附加段立即吸附、取消回调 0 与末态 driver 关闭均通过。`native-segmenter-private-receipt-initial.json`、`native-segmenter-device-accepted.json` 和原始 bundle 记录保存在工作区外。

首轮校验曾将冷启动后 200ms 的全应用事件数组当作静止窗口，292→300 的两次环境状态发布令断言失败。原始数据、首次校验脚本及失败记录保留；该窗口不能证明全应用空闲，后续只对本主题的文字揭示、完成和取消作结论。第34主题稳定空闲采样保持原记录，不将冷启动测量改写成空闲通过。

字素库仅作为安装依赖使用，没有复制参考项目源码。所有 provider 与本地/远程/隧道使用相同完整文本来源；Web/Desktop 保留原生 Intl 分段行为，缺少该 API 的客户端也获得兼容实现。没有新增协议、设置、权限或数据迁移，iOS 与真实外部 provider 仍无设备/调用证据。隔离自动探针按 SHA 移除；纯产品 bundle 为 27262015 字节，SHA `7d639a0e063dc2cc48913d6bf48b9bae3a506f3ed8de36f4e0b3f4139ba97536`。回退本主题并按原锁安装即可恢复旧降级行为。
纯产品端到端补记：Android 客户端实际发送 `native-segmenter-acceptance-08`，受控 Codex adapter 生成第8回合 `fixture-turn-3fb5a9ae-20cb-48d4-bdc6-bfcffe653277-29`。真实正文包含 4800 字符（代码、家庭 emoji、国旗、组合字符、肤色、印地语连字）。选择页打开后追加 33 字符尾文并完成，选择页原文始终保持 4800 字符；长按得到原生高亮，完成后的高亮区域原始像素 SHA 与选择后完全一致，系统 Copy/Share/Select all 菜单仍可见。关闭、滚动到尾部并重新打开选择页，4833 字符与实际 provider、SQLite 的唯一 assistant 正文逐字一致，`is_streaming=0`、session ready、active turn null。源流回执等待期间一次过早读取得到 closed，动作守卫拒绝注入；确认真实 running 回执后才注入，没有重复发首段。瞬时窗口层级为空的失败记录保留，后续只使用新鲜 SDK 层级。`native-segmenter-real-flow-accepted.json` 与截图/像素核验保存在工作区外；无 CDP、真实外部 provider、iOS 或隧道调用。

第5项的服务端 leading/trailing 合并、三端按帧完整快照、首段/终态/设置、按积压揭示、完整复制/选区/几何来源均已有源码、定向与受控实际客户端证据，可独立验收完成。第4项增量渲染完整清单及第8项 Native 重开初始空白和滚动锚点矩阵仍开放，不以第5项通过替代。

### 第4项补齐：Mobile 用户回退目标缓存与检查点入口即时刷新

源码核对发现 `ThreadRouteScreen` 的旧 useMemo 依赖完整详情，每个正文状态都会重建历史 checkpoint 索引。复用 Web 的线程私有缓存模式，新增 `createRevertTurnCountByUserMessageIdSelector`，保留 Mobile 原有 ready checkpoint、assistant 绑定与失败直接重发语义；仅消息身份/角色/顺序、检查点数组或失败状态变化时派生。每个环境/线程一个选择器，空数据释放旧缓存，没有全局索引。

19 项定向测试（`threadMessageActions.test.ts` 与 `thread-feed-live-follow.test.ts`）通过。1200 消息、600 检查点的初次派生读取 600 次状态，20 次后续正文更新读取旧检查点 0 次并保留 map；ready/计数/绑定、身份/顺序/角色/增删、失败/恢复、空数据与实例隔离覆盖。4 源文件 lint/format 与包含真实 Stack 的纯候选 Mobile 类型检查通过，原工作区无关 BYOK 导航类型问题保持原边界。

实际 Android 对照另发现既有可见行刷新遗漏：第9受控回合 `fixture-turn-3fb5a9ae-20cb-48d4-bdc6-bfcffe653277-37` 的 SQLite checkpoint 已 ready（count=8），当前可见用户行没有编辑/回退按钮；关闭重开后两按钮出现。LegendList 已有注释明确闭包改变不会刷新行，但 extraData 只有样式/展开/复制。现加入回退目标、处理中与两项回调，真实 checkpoint 变化会更新入口。相关回调只依赖动作所需的线程身份、模式和忙碌布尔状态，正文和无关外壳字段不触发整张列表刷新。

补刷新依赖的实际产品包为 27263686 字节、SHA `327232e79644c016bcd40e997e9eef14f0bc97ed1620d230a95745f289e87738`。第10回合由 Native 实际发送 `native-fix-10`，受控 Codex adapter 的 turn44 完成后，SQLite checkpoint ready/count=9；保持同一页面，编辑与回退按钮出现。原始红对照、数据库回执、新鲜 Android SDK 层级与截图在工作区外。C003 是夹具固定文案，该两次测试期间线程始终可见，不作为关闭流证明；没有执行文件回退或重发。最终回调稳定化版本继续复核。

一次输入使用尚在过渡中的输入框坐标，开发客户端进入悬浮窗权限页；未更改该权限，未产生新回合，夹具守卫拒绝注入。随后返回实际应用，刷新坐标并确认展开的输入控件再输入。层级为空与错误包的失败记录保留，不算产品通过。

适用 Mobile 的全部标准 provider 消息与现有回退入口；Web/Desktop 已有对应 map 缓存，本主题无变动。沿用本地/远程/隧道 RPC、交互审批与 runtimeMode，无协议或权限修改；实际覆盖本机隔离 Android，iOS 与外部 provider 无设备/调用证据。正常、失败、恢复与切换线程可反向更新；回退本主题恢复旧派生与行刷新，无数据迁移。第4项完整清单中的服务端摘要热路径仍继续核验，第8项首绘/锚点仍开放。

最终包补记：回调稳定化后的 Native product 为 27264665 字节、SHA `a8c41e6ba08b773cc7675d77ddac56fe0eb41f1897dc9613601824e2af48469b`，主目录与隔离导出的3个生产源文件按 SHA 一致，没有临时探针。Native 实际发送 `stable11`，受控 turn51 的新检查点 ready/count=10 后，保持同一页面，编辑与回退按钮出现；115 字正文与持久化/fixture 一致，session ready、assistant streaming=0。该结果再次覆盖最终版本的入口刷新，未执行文件回退。纯候选4源逐字匹配、19项定向与最终 Mobile 类型/lint通过。随后用户明确允许约 0.25 秒首次绘制等待，要求正文出现后不闪烁，继续完成滚动锚点与连接矩阵；完整39项范围保持不变。

### 第37主题：线程摘要查询用户时间不读取历史正文

源码确认 `refreshThreadShellSummary` 为计算最近用户消息时间而调用 `listByThreadId`，同时加载全部历史正文和附件。现复用内部持久化仓储，使用按 thread/role 过滤的 SQLite `MAX(created_at)`，结果经 nullable `IsoDateTime` schema 校验，摘要直接消费该元数据。仍按创建时间的字符串最大值判断，不改为更新时间或事件序号；没有索引、迁移、缓存、RPC 或协议变化。

真实 SQLite 的三项新增仓储用例覆盖空线程、仅 assistant、线程隔离、迟到用户消息、创建时间与更新时间/序号不同，以及角色覆盖与删除。实际 pipeline 用例覆盖长回复增量/空完成、两个用户消息、会话 ready、计划更新及已投影重放：历史正文 API 调用为 0，四次摘要时间查询，实际 `latest_user_message_at` 保持最新创建时间。仅将隔离候选的 pipeline 恢复旧版，同一用例因历史读取 2 次而失败；恢复新版后两文件 39 项通过。原始红/绿结果在工作区外保留，未替换主目录为旧实现。

五个源文件目标 lint/format 和以 HEAD 第36主题加本主题源码导出的纯候选 server 类型检查通过；无关工作区内容不进入候选。适用所有 provider 的标准持久化消息与 Web/Desktop/Mobile、本地/远程/隧道摘要，不新增客户端入口、权限或设置。删除与角色变更后的元数据立即反映当前表内容。回退本主题即可恢复旧摘要读取，无数据迁移。

本主题只关闭用户时间这条摘要路径的正文读取；计划、活动和审批摘要的其余查询继续核验。第4项完整清单以及第8项滚动锚点、连接矩阵保持进行中。首绘采用用户确认的约 0.25 秒等待、正文出现后稳定标准，不能用静态帧率或选区结果替代锚点验收。

### 第38主题：三端历史锚点、断线恢复与回尾跟随

复用已有隔离 server、TCP proxy、受控 Codex adapter 和实际客户端，不新增产品代码或临时渲染探针。Web 使用当前 production 页面，Android 使用第36主题 production JS/真实 SDK UiAutomation，Electron 使用实际 41.5 外壳、1280×720 与相同 production 页面。用户允许约 0.25 秒首次绘制等待；既有连续录像中的正文出现后稳定现象按这一标准保留，滚动与连接另逐项验证。

第12受控回合：先追加40个段落和未闭合代码，手动滚到历史位置，再闭合代码与追加15个尾段。Web 内容高度增加601px，可见 `ANCHOR_007` 仍为 y=438。Android 手势后的首次层级为 null，守卫拒绝保存，不把这次即时读取当通过；稳定快照取得后，再追加代码和8个段落，`ANCHOR_024` 的 bounds 仍为 `404 289 914 315`。两端在 proxy 切断、离线追加、原事件重投、自动恢复与完成后均保留历史锚点；Web 完成时 scrollTop 因上方布局变化减少42px，可见段落位置不变，不能把 scrollTop 变化误判成视图跳动。数据库只有一条当前 assistant，2417字与实际夹具全文逐字一致。

两端通过各自“滚动到底部”入口看到离线/恢复段落各一次。第13回合验证运行中反向路径：30段正文自动跟随，用户滚动后暂停，显式回尾恢复，再追加12段，最新 `FOLLOW_MORE_012` 可见且回尾按钮消失；1353字全文完成、streaming=0、session ready。验证汇总 `anchor-web-native-accepted.json`，原始层级、截图、proxy 连接身份与只读数据库在工作区外保存。一次终态即时 Native 快照仍有重连提示，后续新鲜稳定快照清除提示并保留相同锚点；原始过渡快照不删除。

第14回合由实际 Electron 输入发送。唯一桌面段落 `DESKTOP_ANCHOR_007` 在追加、断线、原事件重投和恢复六个阶段保持 y=373.359375。显式回尾后12个新尾段继续跟随，末段可见、回尾按钮消失；再次滚到历史处，完成前后8个可见段落位置相同。终态当前 assistant 只出现一个规范 ID，45个标记各一次且按序；3471字 provider/SQLite 全文一致，原26条持久化消息逐字段不变。`anchor-desktop-accepted.json` 与实际外壳截图保留；未把揭示期间不可访问的全文几何层算为重复的规范消息。

`vp test run apps/mobile/src/features/threads/thread-feed-live-follow.test.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts` 两文件75项通过。连接准备/主管/注册与线程同步/挂载/分页六文件96项通过，覆盖直接、bearer、relay 与 SSH 的准备路径和共享重放生命周期；连接方式与实际网络覆盖仍须分开记录。本主题实际使用本机隔离 proxy 远程环境配置，无真实外部 provider、SSH 主机或公开 relay/tunnel 调用，iOS 无设备运行。没有增加设置、权限、合同、持续动画或持久化，全部 provider 继续使用标准消息事件；回退仅恢复本证据文档，无产品数据迁移。

### 第39主题：显式连接目标的线程重放矩阵

既有 resolver/registry/主管分别验证连接准备、授权与重连，正文续订测试此前只使用 Primary 目标。扩展原线程测试夹具的可选 `PreparedConnection`，对以下五种形状运行相同真实 Effect 线程状态机，每种同时测试旧环境无 completionMarker 与新环境有 completionMarker。复用原始事件用例，不新增产品条件分支、设置或权限。

| 连接入口        | 准备/授权证据                                    | 正文重放证据                                     | 实际网络边界                                                    |
| --------------- | ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------- |
| Primary 主环境  | resolver 主环境/桌面平台 bearer 用例             | 两态：缓存、断线引用、游标续订、重投、完成       | 既有本地客户端与静态运行证据；本主题状态机模拟，不新增网络服务  |
| Bearer 远程环境 | 注册 profile、现有 bearer 授权                   | 两态同上，显式 Bearer 目标/授权                  | 三端实际隔离 proxy 配对和断线恢复；主机仍为本机，不宣称公网测试 |
| Bearer 隧道入口 | 隧道沿用远程 bearer 准备与标准 socket URL        | 两态同上，显式 Cloudflare URL 形状               | URL仅测试数据，没有访问公开隧道                                 |
| Relay DPoP      | 当前云会话/设备身份 broker、凭据更换与超时       | 两态同上，显式 Relay 目标/DPoP 元数据            | broker/主管替身测试，没有公开 relay 账号或网络调用              |
| SSH             | 平台 gateway 启动后再授权，显式删除与 owner 保留 | 两态同上，显式 SSH 目标/已准备的 loopback socket | gateway 替身测试，没有连接外部 SSH 主机                         |

十个重放用例均验证：忙碌缓存立即可用，序号7订阅；旧事件、过期包与回放忽略，断线时正文对象保持；替换连接从12续订，非连续全局序号合法；不同事件中的相同文字保留；完整终态只有一条消息，错误清除、HTTP快照读取为0。所有目标在连接层收敛为 `PreparedConnection` 和同一 `RpcSession`，客户端渲染不增加按连接方式区分的实现。

六文件定向命令（resolver/supervisor/registry、threads-sync/threads-atoms/threads-pagination）104项通过；单测试文件 lint/format 与 HEAD 第38主题加本测试导出的纯候选 client-runtime 类型检查通过。结合第31/38主题三端实际关闭忙碌线程连接保持、重开、断线原事件重投、唯一全文、锚点与用户确认的首绘标准，第8项功能与共享协议验收完成。外部 provider、公网 relay/tunnel、SSH 和 iOS 设备覆盖仍按本表明确为未实测，不能把模拟元数据写成真实网络成功；完整39项目标仍继续。

此主题只有测试与验收文档，无协议、产品设置、数据迁移或权限变化。全部 adapter 继续提供标准领域事件，聊天退出/重开与手动回尾的反向行为已覆盖；回退本主题仅恢复测试和记录。

### 第40主题：两种手机平台提供固定全文选择页

最终清单核对发现固定全文选择入口只有 Android；iOS 原有 UITextView 会保存/恢复选区，但 Windows 主机无法实际运行 UIKit 的追加/几何矩阵。目标第6项允许等价方案，因此复用现有平台通用 hook/modal，让 Android/iOS 的非空消息都提供“选择文本”。保留 iOS 正文的直接原生选区；Web 使用现有 DOM 冻结，不增加此手机入口。

参数化原入口用例后，旧实现的 iOS 用例因缺少选择按钮失败；修复后按钮传递同一完整原文，不裁剪空白、代码或字素。快照选择页不随列表正文/回合终态更新，关闭重开取最新全文，环境/线程切换立即关闭，全文复制与系统选择共享同一快照。20项选择页/跟随测试、两源目标 lint/format、含真实 Stack 的纯候选 Mobile 类型检查通过；原始 iOS 红记录在工作区外。

代表原生运行证据采用第35主题实际 Android：4800字符固定选择正文在追加33字符和完成后不变，系统高亮像素SHA一致；重开4833字符与provider/SQLite逐字相同。Android 条件分支的布局和动作没有改变，此主题不将旧bundle写为新bundle。iOS 的按钮、快照生命周期及 React Native 属性通过源码、参数化测试和目标类型核验，未编译或运行 iOS UIKit；该设备边界保留。Web 实际 DOM 选区冻结与前缀/代码节点复用、三端锚点与回尾证据按既有记录采用。

第6项功能采用 Web/Desktop 同渲染器的 DOM 保留与两手机平台的固定全文等价选择页完成；可见滚动锚点已由第38主题三端实际运行补齐。没有新增协议、权限、库、模式设置或数据迁移，适用所有provider与本地/远程/隧道的标准消息来源；页面退出/重开与环境切换反向路径均覆盖。用户说明已更新。回退本主题恢复仅Android入口；不据此宣称iOS设备验收或整个39项目标完成。

### 第41主题：第4项九条增量清单最终核验

逐项重读当前实现并把早期表中的“设备待测”对齐后续证据。九条分别为前缀解析、完成代码行、时间线行、回合/检查点引用、Markdown挂载、投影/活动追加、回退map、无用线程订阅和Mobile同项落实，均已有实现和行为用例；表格保留对应上游提交号，不据部分清单关闭整体。

最新九文件151项（Web前缀/ChatMarkdown/StreamingChatMarkdown/revertTargets，Mobile原生前缀/原生Markdown工具/代码显示/消息动作，共享threadReducer）以及HighlightedCodeLines/threadActivity两文件56项通过。此前各主题纯候选目标类型/lint、数据库无正文回读的红绿、Native字素/帧发布/选择/检查点即时入口、三端静态性能与历史锚点证据继续采用；本次只核验记录，无新的产品变化或帧率采样。

摘要边界重新确认：`shouldRefreshThreadShellSummary` 对assistant消息和普通工具活动返回false，文本delta不重复读取计划/活动/审批历史；用户时间查询已由第37主题移到SQLite元数据。计划、审批、问题、会话和检查点的离散状态变化仍按既有语义派生摘要，不声称完全删除所有历史查询，也不为非流式事件引入另一个缓存系统。它满足本清单的流式增量约束，后续若实际离散摘要出现性能问题再依据证据处理。

第4项按完整九条源码/定向与代表三端实际运行完成。Mobile代表设备为本机隔离Android；iOS原生路径及第40主题等价选择页仅源码/React属性/目标类型，UIKit未实测。第3—9项已各自记录完成功能或静态性能口径，实际外部provider、公网relay/tunnel、SSH与iOS设备边界没有改写为通过。全部39项和comparison其余候选保持原范围，接下来进入第10项Agent接入契约。回退本主题仅恢复验收记录。

### 第42主题：Windows 正文 argv 三层守卫

逐入口清点确认只有 Antigravity 对话、Antigravity 文本生成和 ZCode 将正文放入启动参数。新增共同守卫，复用实际命令解析；原始 UTF-8 早拒后，按解析后的 cmd/bat 或直接进程互斥计算完整命令行。统一 `AGENT_PROMPT_TOO_LARGE` 保留阶段、计数及处理建议，不回显正文、路径或密钥，不截断或重试。cmd 多行限制单独转换为 `AGENT_PROMPT_UNSUPPORTED`。完整 provider 清单、限制推导、官方资料及跨端决定见 [Windows 正文参数边界](./windows-prompt-argv.md)，[用户说明](../user/windows-prompts.md)已同步。

验收命令在 HEAD 第41主题加本主题十个源文件的隔离候选执行：

- `vp test run --config .argv-test.config.ts apps/server/src/provider/promptArgv.test.ts apps/server/src/provider/Layers/AntigravityAdapter.test.ts apps/server/src/provider/zcode/ZCodeAdapter.test.ts apps/server/src/textGeneration/AntigravityTextGeneration.test.ts`：4文件26项通过。覆盖短输入、原始超限、合法长中文、UTF-16 emoji、多引号/反斜线、额外参数、两种 Windows 路径互斥、解析后路径、非 Windows、多行和三处错误传递；ZCode 正常模拟子进程与失败回合仍能结束。
- `vp test run --config .argv-test.config.ts apps/server/src/provider/pifamily/PiAdapter.test.ts apps/server/src/provider/pifamily/OmpAdapter.test.ts`：2文件15项通过，确认共用启动函数中未声明正文 argv 的 JSONL/RPC 路径保持工作。
- `tsgo --noEmit -p apps/server/.streaming-typecheck.json`：纯候选目标类型通过。十源 `vp fmt --check` 通过，目标 `vp lint` 退出0；仅保留 AntigravityTextGeneration 原有动态输出 schema 编译告警，不将其写成零诊断。未运行全仓检查。

有效旧版对照在隔离候选临时恢复单一生产文件，结束后按 SHA 还原：Antigravity 对话和文本生成分别因调用守卫前的 spawner 而失败；ZCode 超限用例的旧版错误不含统一代码，新版返回统一错误并无进程参数文件。最初配置测试缺 prefix、随后隔离别名顺序导致零测试加载失败，均保留为夹具/配置失败，不算行为红证据；类型检查发现服务组合问题，修正 Layer 依赖后通过。临时目录写入工具未执行的两次调用经进程/文件检查后结束，再通过明确的临时目录写入权限完成，未重复启动测试或替换主工作区为旧源。

独立只读入口审查没有发现遗漏或确定缺陷。本机 Node v24.18.1 使用项目相同的完整命令与参数转义，通过真实 `shell:true` 启动无副作用 Node 子进程：完整 cmd 字符串8189/8190/8191成功且参数长度正确，8192返回命令行过长。未转义 echo 的初步8191失败结论被完整转义实验推翻，未据此修改限额。此实验没有新增实际批处理文件，不证明任意批处理内部二次展开。直接 exe 接近32767的实测探针未进入脚本，按原工具句柄停止并确认两个自有PID退出；不算通过，也不据此归因守卫。直接进程的序列化上限以官方约束、运行时源码与确定性测试为证据。

本主题适用 Web/Desktop/Mobile 连接的 Windows 服务器以及本地/远程/隧道入口；界面沿用既有失败消息与重发操作，无新控制项、wire 协议、权限或数据迁移。没有请求真实外部 provider，未把当前保留的旧验收服务写成已加载新守卫。回退本主题恢复旧 spawn 行为。第10项完成，全部39项与 comparison 额外范围继续；第11项目录统一、缓存、共享截止时间和草稿无会话进入下一主题。

### 第43主题：Cursor/Grok 查询目录不创建原生会话

源码证实两处目录发现原先调用 `AcpSessionRuntime.start()`，会执行 `session/new`。新增通用 `prepareClient()`，只初始化及按配置认证；成功结果与正在进行的请求共享，真正 `start()` 再沿原流程创建/加载会话。准备失败和中断结束全部等待者，后续可以重试；会话创建失败不重复已成功的握手。独立状态机审查发现共享状态发布与清理安装之间的中断窗口，使用 `uninterruptibleMask` 保护短暂状态更新，并对实际 RPC/等待者使用 `restore` 保留取消能力；既有 start 同构窗口一并修复。

Cursor 使用准备后的 `cursor/list_available_models`，受控请求日志严格为初始化、认证、模型扩展。Grok 官方提供初始化后调用 `x.ai/models/list` 的完整动态目录；按官方读取流程不发送 authenticate，避免该路径可能保存认证信息的副作用。测试带假 API key，仍严格只有 initialize/list。解码优先处理包装 error，再验证模型状态，保留动态模型、reasoning 选项/说明/当前值/默认值及 customModels；未知方法和畸形数据保持错误与升级建议，不回退为创建临时会话。该扩展不表示已发现全部会话 configOptions 或模式，版本与官方固定源码链接见 [providers](./providers.md)。

旧行为对照只替换隔离候选中的一个 Provider 生产文件：Cursor 用例因额外的 `session/new` 请求失败，Grok 用例因目录变成 error 而非 ready 失败；两份原始记录保存为 `cursor-catalog-cursor-red-proof.txt` 与 `cursor-catalog-grok-red-proof.txt`，结束后源文件按 SHA 恢复。主工作区没有恢复为旧实现。

最终六源与 HEAD 第42主题组成纯候选，`tsgo --noEmit -p apps/server/.streaming-typecheck.json` 通过；六源 `vp fmt --check`、`vp lint` 及本主题 `git diff --check` 通过，无目标 lint 告警。`vp test run --config .candidate-test.config.ts` 指定 `acp/AcpJsonRpcConnection.test.ts`、`Layers/CursorProvider.test.ts`、`Layers/GrokProvider.test.ts`、`Layers/CursorAdapter.test.ts`、`Layers/GrokAdapter.test.ts`、`Drivers/GenericAcpDriver.test.ts`，共6文件220项全部通过，331.92秒。该矩阵同时验证目录和既有真实会话模拟路径的审批、失败、恢复、配置及事件行为；没有运行全仓检查。

测试夹具修正为 Windows cmd 加 Node 启动方式，探测退出改为作用域结束后检查捕获的真实进程句柄，替代原文件轮询。初轮四项旧 sh 夹具失败、受限运行下崩溃审批用例超时均保留；同一崩溃用例在隔离授权运行通过，尚不能将先前超时明确归因。一次 `MaxOpsBeforeYield=1` 的无效测试配置使调度无法推进，测试进程堆耗尽退出；改为16后准备与启动中断用例通过，不能将该实验写成产品内存问题。该两用例覆盖 RPC 开始后的中断与恢复，发布窗口由源码临界区与独立复查支持，不扩大为旧窗口已得到确定性红对照。

本主题在服务器目录探测执行，Web/Desktop/Mobile 的模型选择、设置刷新以及本地/远程/隧道共用既有快照入口，没有新增 UI 控制、wire 字段、权限或持续动画。真正 Cursor/Grok 对话继续采用原认证、审批、runtimeMode 与会话恢复；其余 ACP provider 只复用生命周期修复，原模型/模式数据路径保留。无真实外部 Cursor/Grok 或原生客户端操作，本地 Node 假 ACP 子进程属于协议集成证据；不宣称真实供应商已验证。回退本主题恢复旧目录与生命周期行为，无数据迁移。第11项仍在进行，统一 fetchCatalog、等价配置共享缓存、单一 deadline/AbortSignal 与 BYOK 两路发现收敛仍必须完成；完整39项及 comparison 额外范围不缩减。

### 第44主题：BYOK 目录总预算与跳转释放

已保存配置和草稿发现共用的 `discoverTarget` 现在为整个候选循环提供15秒预算；每个 HTTP 请求只收到剩余时间，超时立即结束，不继续下一地址。预算包含跳转和响应正文。HTTP 帮助函数的独立调用保留默认15秒，因此余额查询无需改接口。成功/陈旧目录语义、配置与凭据指纹保持原行为，未移动或扩大缓存。

本轮还证实真实 Fetch 默认自动跟随跳转，会越过已有的跳转次数限制及跨源凭据剥离。目录 HTTP 请求固定采用手工跳转，并复用现有 URL 校验、三次跳转限制、认证头剥离及4 MiB正文上限。每个请求链使用局部 Scope，完成、失败或超时均释放包括未读取3xx正文在内的请求。构造阶段注入的 fake/custom Fetch 保留；当前生产 BYOK 装配未配置其他 `FetchHttpClient.RequestInit` 默认字段，该帮助函数显式设置 `redirect: manual`，后续若增加其他默认 options，需要一并验证保留规则。

隔离 HEAD 第43主题候选只叠加本主题四个源文件：`vp test run --config .candidate-test.config.ts` 指定 `ByokModelDiscoveryService.deadline.test.ts`、`ByokModelDiscoveryService.test.ts`、`byokHttp.test.ts`、`ByokBalanceService.test.ts`，4文件63项通过。新增虚拟时钟测试验证前一候选耗时8秒、下一请求或正文挂起时总计15秒终止；14秒成功保留模型；草稿超时取消；没有第三候选请求；捕获的请求 signal 已取消，正文 reader 已释放。未结束的302正文用例确认返回后两跳 signal 均取消。两台本机随机端口 HTTP 夹具配合真实 Node Fetch，确认跨源不转发 Authorization、x-api-key、x-goog-api-key，并保留普通请求头；两个服务在 finally 关闭，没有外部请求。

有效红对照只在候选暂时恢复单个生产文件，随后按字节恢复：旧发现代码在15秒点仍未完成，两个断言失败；旧 HTTP 代码在目标服务器收到 `x-api-key`，实网用例失败。一次未转义的 shell 正则筛选没有运行目标测试，已单独保留为无效夹具失败，改用无元字符名称后才取得有效红证据。主工作区没有替换为旧源。

最终纯候选目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json`、四源 `vp fmt --check` 通过；目标 `vp lint` 退出0，仅保留 ModelDiscoveryService 原有未使用 catch 参数与空 fallback spread 两条告警。测试夹具的 Node 导入、Error.code 类型及 Effect JSON 诊断已修复；未运行全仓检查。独立源码复查指出的未读跳转响应验收缺口已补定向断言。

本主题改变服务端目录与共用 HTTP 行为，Web/Desktop/Mobile 和本地/远程/隧道均沿原 RPC；没有新 UI、wire 字段、权限、动画或持久结构。[用户说明](../user/model-catalog-refresh.md)已补充。其他 CLI provider 本主题不变；实际外部供应商、真实客户端和公网连接没有新增验收。回退四源即可恢复旧预算与 HTTP 行为，无数据迁移。Effect 当前仍为各请求创建独立 signal，不能将共用 Scope 写成同一 AbortSignal。统一 fetchCatalog、等价配置共享缓存、全 provider deadline 与底层共享 signal 仍需完成，第11项继续进行，全部39项及 comparison 附加范围保持。

### 第45主题：同一实例的并发刷新共享一次检查

`makeManagedServerProvider` 在同实例、等价快照设置的范围内合并正在进行的初次、手动和周期检查。不同设置分别排队，继续使用原 semaphore 保证最多一个实际检查。开始与结束时核对当前设置，旧结果不发布；异步 enrichment 同时核对设置及 generation，新设置尚未发布时也拒绝旧补充回调。实际 provider 配置仍由 registry 重建实例，未把已捕获配置的 `checkProvider` 改造成可重配置对象。

检查归 provider Scope 所有，调用者取消只结束自身等待，包括全部等待者取消后仍允许其他请求加入。成功、失败或关闭都删除登记并完成共享 `Deferred<Exit>`，各等待者独立重放结果。开发测试发现直接用 Deferred.done 传播 interruption 可能让后续等待者悬挂，已改为先成功保存 Exit 再逐个重放。独立审查进一步发现父调用者本来不可中断时，复用其 restore 会让独立检查同样不可中断；改为不可中断启动以安装 onExit，实际 semaphore 等待和检查明确使用 Effect.interruptible。新增 uninterruptible 和 acquireRelease acquire 两种 owner 用例，均保证初次轮完成后才发起待关闭的新检查，验证 Scope 关闭后两名等待者结束。

主线程在第44主题代码加最终两源的纯候选运行 `vp test run --config .candidate-test.config.ts`，指定 `makeManagedServerProvider.test.ts`、`Layers/ProviderRegistry.test.ts`、`Layers/ProviderInstanceRegistryLive.test.ts`、`Layers/ProviderInstanceRegistryHydration.test.ts`，4文件84项通过，20.94秒；包含新增共享、取消、失败重试、设置/enrichment隔离及关闭回归，目标文件自身17项。纯候选 `tsgo --noEmit -p apps/server/.streaming-typecheck.json`、两源 `vp fmt --check`、`vp lint` 和本主题 diff check 全部通过，无目标lint告警；未运行全仓检查。

旧实现的独立对照只替换候选生产文件：初次检查加三个重叠手动请求执行4次而非1次；设置变化后仍发布旧结果，两用例均失败，结束后按字节恢复。独立只读复查确认上述中断性问题已修，未发现剩余确定缺陷；测试通过与源码审查分别记录，不将只读判断充作运行证据。

全部十二个内置 driver 均使用这一状态快照管理器，因此 Codex、Claude、Cursor、Grok、Kimi、Antigravity、OpenCode、Pi、OhMyPi、ZCode、通用ACP及BYOK适用。Web/Desktop/Mobile 的设置、模型选择及本地/远程/隧道沿原刷新RPC共享此行为；未增加聊天、快捷键或命令面板入口，没有 wire、权限和持久化变化，也不触及实际会话审批。修改配置后的取消/重建由原registry承担，失败后可再刷新。用户说明与 [providers](./providers.md) 已同步。回退两源恢复旧串行多轮行为，无数据迁移。

本轮没有新增真实供应商或三端UI验收，当前保留的运行服务没有加载这两个新主题。无等待者的检查仍执行至完成或 Scope 关闭，本主题未添加统一 deadline，也未实现跨实例共享缓存。第11项仍在进行，全部39项及 comparison 额外范围不缩减。

## 46. BYOK 统一目录入口、跨实例共享缓存与强制刷新意图

将 BYOK 状态检查、已保存配置发现与草稿发现收敛到 `ByokCatalog.fetchCatalog`，删除状态层独立 `/models` 探测与旧的模块级实例缓存。生产服务装配向 registry driver 与 WebSocket discovery 提供同一目录服务；目录结果不含实例身份，取出后补当前 instanceId、adapterId 和模型路由。协议、实际地址、供应商模板、候选顺序、目录策略、凭据与自定义请求头全部参与SHA256索引；实际加载仍使用本次调用的原始参数。相同有效配置跨实例共享一分钟成功结果，容量128；草稿同样共享，但不保存配置、凭据或建立 provider session。

`ProviderCatalogCache` 将成功值与在途加载分开，强制请求绕过TTL但合并同键正在执行的加载。容量只限制成功值；完成后清除加载闭包，失败不覆盖旧成功值或延长TTL。单个等待者取消/超时不终止其他等待者，最后一个离开后中断加载；零剩余预算不启动新请求。BYOK 单个目录加载保留第44主题的15秒预算，实例状态检查跨全部模型通道另用同一个15秒截止时间，逐项传剩余等待预算，超时仍返回同配置旧值。

刷新管理器区分状态检查与目录强制意图。BYOK 设置 `usesCatalogCache`，初次、设置变化、周期检查允许命中TTL；手动刷新只加入强制检查，不能加入已读过旧缓存的普通检查。普通检查可以加入强制检查。其他十一个 driver 暂未接入统一目录缓存，保持第45主题的同设置合并行为。所有检查仍由 provider Scope 管理，设置/补充快照隔离与关闭唤醒不变。

验收发现并修复两个边界：空列表、无可用模型或畸形JSON原先可能从同步解码器抛出defect，现转成 `invalid_payload` 业务失败，允许重试；多通道状态检查使用外层超时时，会在第一请求耗时8秒后中断第二请求，使第二通道的旧目录消失，现通过每等待者剩余预算保留它。独立审计在工作区外添加的反例先失败，修复后与6组相关测试共74项通过。原registry的4个真实driver测试fixture补齐新增目录服务依赖后，53项全部通过。

主线程在排除原始未提交修改的纯净候选执行 `vp test run --config .candidate-test.config.ts`，指定 `ProviderCatalogCache.test.ts`、`byok/ByokCatalog.test.ts`、`byok/ByokModelDiscoveryService.test.ts`、`byok/ByokModelDiscoveryService.deadline.test.ts`、`makeManagedServerProvider.test.ts`、`Layers/ByokProvider.test.ts`、`Layers/ByokProvider.catalog.test.ts`、`Layers/ProviderRegistry.test.ts`、`Layers/ProviderInstanceRegistryLive.test.ts`、`Layers/ProviderInstanceRegistryHydration.test.ts`，10文件147项通过，27.74秒。随后针对新覆盖的 OpenAI/Anthropic/Gemini 状态认证路径，再跑 `ByokProvider.catalog.test.ts`，7项通过，2.31秒；本主题共150个不同用例通过。包含Cache18项、managed20项及之前15秒请求/正文取消回归。

旧实现对照只临时替换隔离候选源文件：旧Discovery使保存入口与状态入口请求2次而非1次；旧managed初次检查错误继承外层强制意图。两例明确断言失败，结束后按字节恢复。目标15源 `vp fmt --check`、`vp lint` 通过，无目标lint告警；`tsgo --noEmit -p apps/server/.streaming-typecheck.json` 覆盖生产 `server.ts` 装配并通过，只有未改文件的4项既有建议。未运行全仓检查。

本主题适用于 Web/Desktop/Mobile 现有设置和模型选择入口，以及本地/远程/隧道连接；没有新增 wire 字段、权限、持续动画、快捷键或持久结构。BYOK 三种协议状态发现均通过统一入口，其余CLI目录收敛继续后续主题。用户说明和架构文档已同步。无真实外部供应商、客户端操作或新生产服务启动验收；保留的旧运行服务未加载此主题。回退本主题恢复旧目录发现路径，无数据迁移。第11项的其余CLI统一入口/共享缓存、全provider单一deadline与同一AbortSignal仍开放，完整39项及comparison额外范围不变。

## 47. Cursor/Grok 共享模型目录及实际执行环境一致性

增加 `CliProviderCatalog.fetchCatalog`，复用第46主题的成功值/在途分离缓存，TTL一分钟、成功值容量128。固定目录类型只容纳模型、技能和斜杠命令，当前 Cursor/Grok 仅缓存原生模型与能力选项；认证、版本、检查时间、Grok 技能和自定义模型分别实时检查或合并。每个 registry 创建一个对象并传入 driver，配置变化重建实例仍复用目录；不同 registry 相互独立。公开 Cursor 目录入口和 Grok 状态目录路径全部经过该入口，缺省注入时创建私有对象，没有模块级可变缓存。两者启用 managed provider 的目录强制刷新语义。

缓存身份覆盖目录命令、端点、cwd及最终环境，Grok 另含当前版本与路由协调后的配置文件内容。实例名称、颜色和自定义模型不进入原生目录身份，加载只执行当前调用提供的参数和服务。显式部分环境继续覆盖宿主环境，随后冻结为单次探针快照；ACP `extendEnv:false` 防止加载时重新混入宿主新增变量。Windows resolver 接受可选 cwd，相对命令和相对 PATH 与实际启动目录一致；省略 cwd 的既有入口及非 Windows 行为保持原样。Grok 路由协调前移至状态检查，配置读写失败不能读旧缓存，默认个人目录只读。目录查询依然不建立原生 session。

主线程在 HEAD 第46主题加15个源文件的纯候选中执行定向 `vp test run --config .candidate-test.config.ts`：`CliProviderCatalog`、`ProviderCatalogCache`、`makeManagedServerProvider`、registry catalog/Live/Hydration、`ProviderRegistry`、`CursorProvider`、`GrokProvider`及其catalog、ACP environment/JsonRpcConnection、`GenericAcpDriver`、shared shell与promptArgv，共15文件302项通过，239.48秒。最终 lint 修正与红对照恢复后再跑 CLI cache/Cursor/Grok catalog/ACP environment/shell 五文件80项，通过64.41秒；这些属于前302项，不重复计数。服务端与shared两份目标 `tsgo --noEmit`、15源 `vp fmt --check` / `vp lint` 全通过，类型与lint无剩余诊断；未运行全仓检查。Node 对既有 `.cmd` shell 启动发出 DEP0190 提示，保留日志，不将测试描述为无运行提示。

四个旧实现对照只替换候选单一生产文件，均明确断言失败：Cursor探针执行六次而非五次；Grok等价配置模型进程执行两次而非一次；旧ACP重新继承快照之后新增的宿主变量；旧Windows解析选中ambient相对命令而非指定cwd路径。每次结束均按SHA恢复候选，最终80项复验绿。集成期间类型检查还发现 Cursor `usesCatalogCache` 曾放错在 Driver 对象，以及测试解码回调的索引/ParseOptions冲突，均已修复后验收。

独立只读审核补充真实Windows `.cmd → Node` ACP的跨Scope组合测试：目录RPC已进入后加入第二实例等待者，关闭首实例Scope，首Fiber退出但进程继续，第二实例拿到完整目录。回环TCP事件门同步，无sleep/polling；日志仅一个PID、一套initialize/authenticate/list请求，无session创建，随后缓存命中同一引用。该外部候选临时测试1/1通过，5.07秒；连同主矩阵为303个不同用例，临时审核文件不提交。独立审核修正后没有未解决的确定缺陷；Grok同类Scope组合结论采用共享实现与静态审核，未冒充直接实测。

此行为由服务器提供，Web/Desktop/Mobile 既有设置刷新、模型选择及本地/远程/隧道请求共享；聊天/命令面板/快捷键没有新增入口，wire、权限、持久结构、会话审批与帧率实现未变。失败再刷新、配置变化、实例关闭/重建、改名和自定义模型隔离均有定向覆盖。BYOK沿用第46主题，Codex、Claude、OpenCode、GenericACP、Kimi、Antigravity、Pi、OhMyPi、ZCode保留原目录行为，后续继续收敛。

本轮没有真实外部Cursor/Grok账号、三端UI或新服务启动验收，保留服务未加载新主题。回退本主题恢复原探测与环境解析行为，无数据迁移。第11项仍开放其余九个CLI统一入口、完整模型/模式目录、所有provider单一总deadline及共享AbortSignal；两CLI现有分阶段超时不能视为统一总预算。完整39项及comparison额外范围保持不变。

## 48. 六类 CLI 的配置模型目录共享与动态状态隔离

Kimi、Antigravity、通用 ACP 的配置模型，以及 Pi/OhMyPi/ZCode 的路由模型，初始快照和健康检查统一经过 `CliProviderCatalog.fetchCatalog`。五个 driver 源文件复用 registry 传入的目录对象，未注入时创建私有对象；Pi 系及 ZCode 的异常草稿也传入同一对象。六个 driver 均启用 `usesCatalogCache`：普通检查复用一分钟成功值，手动刷新重新生成，实例 adapter 和会话各自独立。

这些目录由本地配置映射而成，不启动模型探针或创建 session，因此缓存身份不包含实例名称、进程命令、cwd、环境或账号。Pi 系只快照实际显示所需的 adapterId、displayName、trim(modelId)，保留路由顺序，忽略当前映射不用的协议、上下文窗口和来源账号。Kimi/Antigravity/GenericACP 复用 `providerCustomModelSlugs`，先规范化自定义模型，再让键和加载器共用同一数组快照。默认模型与能力声明没有改变；GenericACP 的 `default` 仍代表 CLI 自选，能力为 null。

独立审核发现并修复等价配置分裂：原先原始 `customModels` 参与键，而展示层另行 trim、去空、去重，导致相同目录不能共享。现在目录键和 `providerModelsFromSettings` 共用同一规则，保留首见顺序并排除内置重复项。旧归一化边界的两个反例明确断言失败，修正后通过。另分别换回 HEAD 第47主题的 GenericACP driver 和 Pi 系快照层，得到一个及三个引用共享断言失败；三组对照均只替换外部候选，finally 按字节恢复，原始失败日志保留。

版本、安装、启用、认证和检查时间继续在目录之外更新。Kimi/Antigravity 禁用实例仍检查安装，Pi 系保持禁用时不启动版本探针的既有行为。ZCode 测试在目录引用保持一致时，读取临时受管目录里的加密测试凭据，验证未登录→账号A→账号B→退出，认证随每次检查更新。Kimi 的 `routeThroughByok` 最终发布仍经过当前网关设置的实时路由覆盖，此处不声明所有最终 models 引用共享；会话内动态模式也不缓存为全局目录。

主线程以 HEAD 第47主题加15源形成纯候选，运行 `vp test run --config .candidate-test.config.ts` 指定14文件：`Drivers/GenericAcpDriver.test.ts`、`Drivers/GenericAcpDriver.settings.test.ts`、`Drivers/PifamilyDrivers.catalog.test.ts`、`Drivers/ZCodeDriver.test.ts`、`Layers/ConfiguredCliProvider.catalog.test.ts`、`Layers/PifamilyProvider.catalog.test.ts`、`Layers/KimiProvider.test.ts`、`Layers/AntigravityProvider.test.ts`、`providerSnapshot.test.ts`、`CliProviderCatalog.test.ts`、`ProviderCatalogCache.test.ts`、`makeManagedServerProvider.test.ts`、`pifamily/PifamilyByokRouting.e2e.test.ts`、`Layers/ProviderInstanceRegistryLive.catalog.test.ts`，共94项通过，62.68秒。路径均位于 `apps/server/src/provider/`。服务端目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json`、15源格式和lint检查通过；lint保留6处HEAD已有告警，没有新增告警。Node既有Windows shell DEP0190提示保留，没有运行全仓检查。

旧实现恢复及新增测试的Schema编译位置修正后，最终再跑 GenericACP、Pi系driver、两组配置目录四个测试文件，36项通过，39.23秒；这些属于上面的94项，不重复计数。最终15源格式、lint与目标类型检查再次通过。

独立审核在外部候选添加一次真实 GenericACP driver 组合测试，1/1通过，3.86秒：有空格/重复/内置default的配置与规范配置共享一次加载，身份和adapter独立、全部session列表为空，手动刷新使加载次数加一，第三等价实例复用刷新结果；实际子进程仅执行 Node `--version`。十个生产源的工作区/候选SHA一致，临时审核文件和日志保留在工作区外，不提交。与主矩阵合计95个不同用例。审核后的确定缺陷均已修复。

Web/Desktop/Mobile 的现有模型选择和设置刷新，以及本地/远程/隧道，都继续使用服务端快照；没有新增 UI、wire 字段、权限、快捷键、持续动画或持久结构。其他provider：BYOK/Cursor/Grok沿用此前共享目录；Codex/Claude/OpenCode原生目录尚待接入。修改配置后得到新目录、手动刷新、TTL、实例重建与私有缓存隔离有定向覆盖；没有真实供应商账号、三端操作或新服务运行验收，保留服务未加载本主题。回退这15个源文件可恢复此前目录行为，不涉及数据迁移。第11项仍在进行，统一总deadline、同一AbortSignal以及模型/模式的剩余边界继续开放，全部39项和comparison额外范围不缩减。

## 49. Codex/Claude 原生目录共享与当前认证分离

Codex 的模型分页和技能统一经过 `fetchCodexCatalog`，接入 registry 共享的 `CliProviderCatalog`；每次状态检查独立读取版本与 `account/read`，自定义模型在缓存外分别合并。目录加载自己拥有 app-server 进程 Scope，首个调用者结束不能关闭其他等待者的目录进程。缓存身份包含 binary、解析后的 argv、cwd、最终环境、版本和协议可见账户；等价引号写法不再分裂缓存。API Key、Bedrock、无账户及空邮箱无法提供稳定身份，强制绕过完成值而保留在途合并，防止同 home 换凭据继续显示前次目录。带邮箱的 ChatGPT 账户按协议可见字段分区，尚不能证明同邮箱同套餐下所有组织切换的完整身份隔离。

Claude 的模型、命令和本地技能统一经过 `fetchClaudeCatalog`，草稿与原生目录采用不同操作身份。移除 driver 旧五分钟账户混合缓存；SDK initialize 每次读取当前账户与命令，仅目录值进入一分钟成功缓存。命令值、版本、实际 executable、cwd、完整环境和规范化自定义模型参与目录身份。初始化失败的降级目录不覆盖或延长成功值。公开探针合并宿主和实例环境后固定快照，Windows 相对命令、相对 PATH、npm 包入口和损坏安装检查使用同一 cwd。每次 Effect 执行创建独立 AbortController，成功、失败、取消、超时都 abort 并调用 `query.close()`；SDK 返回 void 只能证明发起关闭，第15项的等待完全退出契约仍开放。

两个 driver 都启用目录强制刷新语义，并复用注册表目录对象；未注入时使用私有对象。草稿不启动原生探针，Codex 探针仅使用 initialize/account/model/skills 方法，Claude 仅初始化、关闭会话持久化且不发送用户消息。冷 Codex 状态检查需要健康与目录两个进程，N个等价并发调用为N个健康进程加一个目录进程；缓存命中仍执行一次健康进程。这里减少目录分页和技能查询，没有以测试推断真实 CLI 启动或端到端性能更快。

主线程从 HEAD 第48主题导出纯候选，只加入本主题10个源文件，运行 `vp test run --config .candidate-test.config.ts` 指定 `Layers/CodexProvider.catalog.test.ts`、`Layers/CodexProvider.test.ts`、`Layers/ClaudeProvider.catalog.test.ts`、`Layers/ClaudeCapabilitiesProbe.lifecycle.test.ts`、`Layers/ClaudeCapabilitiesProbe.test.ts`、`Drivers/ClaudeExecutable.test.ts`、`Drivers/ClaudeHome.test.ts`、`Drivers/CodexHomeLayout.test.ts`、`Layers/ProviderRegistry.test.ts`、`CliProviderCatalog.test.ts`、`ProviderCatalogCache.test.ts`、`makeManagedServerProvider.test.ts`、`Layers/ProviderInstanceRegistryLive.catalog.test.ts`。路径均位于 `apps/server/src/provider/`，13文件156项通过，22.63秒。服务端目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json`、10源 `vp fmt --check` 和 `vp lint` 全通过，无类型或lint诊断。集成时发现并修复 exact optional 字段及测试导入路径问题，没有跳过失败或运行全仓检查。

独立审核发现并修复四项具体问题：Claude 局部环境继承、Windows cwd 解析、Codex 不可区分账户复用已完成目录、原始 argv 字符串导致等价参数不共享。新增6种账户身份和1种引号等价测试，修复前7项均断言失败，修复后14项目录测试全绿。随后仅在隔离候选恢复三个 HEAD 第48主题生产文件，分别使 Codex 目录引用共享失败、Claude 同一探针第二次执行返回 undefined、相对 PATH/cwd 两个断言失败。每次 finally 按SHA恢复。恢复后四个直接相关文件38项再验通过，5.55秒，属于156项的子集。

独立审核另在候选外部添加3项真实 Windows 子进程组合测试，2文件3项通过，18.23秒：完整 Codex 状态检查中关闭首 caller Scope，另一个仍得到完整分页与技能，只有一个目录PID；固定 API Key 身份响应而更换假CLI模型，下一次检查拿到新目录；Claude 真实SDK从相异宿主cwd使用相对 `.cmd` 和相邻npm `cli.js`，版本与初始化命中相同文件和目标cwd，输入只有 initialize、没有prompt。使用事件与收据同步，没有sleep或轮询。第一次三项断言通过但夹具未处理终止时的 ECONNRESET 导致exit1，仅修复临时夹具预期退出处理后重跑exit0；Node既有 DEP0190 提示保留。临时测试不提交，工作区与候选10源SHA一致。主矩阵加独立组合共159个不同用例，没有真实提供商账号或外部API调用证据。

匿名身份边界的外部核对日期为2026-10-13，关键词 `openai/codex refresh_available_models AuthMode`、`list_models ApiKey models_manager`。采用官方 [models_identity](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/models_identity.rs) 和 [models-manager](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/manager.rs) 源码，因其直接说明账户/认证摘要和未知身份的缓存契约；不以issue评论替代协议证据，也不把当前main当成本机安装版证明。

Web/Desktop/Mobile 的既有设置刷新、模型选择及本地/远程/隧道请求都使用服务端快照。没有新增UI、wire字段、权限、快捷键、持久结构或持续动画；没有本轮三端UI、真实账号切换或新服务启动验收，保留的运行服务未加载新主题。回退这10个源文件可恢复此前目录和探针行为，无数据迁移。其他provider保持第46—48主题实现；OpenCode仅完成版本/API边界研究，尚未接入。第11项继续开放OpenCode入口、模型/模式剩余边界、全provider单一总deadline和同一AbortSignal，Codex/Claude的分阶段超时不算统一预算。全部39项及comparison额外范围保持不变。

## 50. OpenCode 完整目录刷新、统一预算与共享信号

OpenCode 的版本检查、模型、variants、agent 模式和技能统一经过 `OpenCodeCatalog.fetchCatalog`。同一 registry 的实例及重建共享目录对象，不同 registry 和未注入的直接 driver 保持独立。初始检查与 managed 检查捕获相同对象，启用目录刷新语义。本地身份包含 binary、cwd、最终环境（包括 BYOK 注入配置）；远端仅使用去除两端空格的 serverUrl、password、directory。完整输入快照同时用于键与实际执行，自定义模型和实例身份在目录之外合并。禁用和 pending 不启动发现，最低版本错误及普通技能查询失败降级保留；本地版本命令非零退出现在明确失败。

最低支持版本的目录 API 将模型与 connected 合并返回，缓存完成值会保留旧连接状态。因此复用公共缓存的 `capacity: 0`、`shouldCache: false` 模式，只合并正在进行的完整检查；顺序刷新重新获取版本和目录，断开与恢复都会更新认证和可见模型。收益是减少等价并发探测，不能声称顺序检查在一分钟内不再发现目录。外部客户端直接按本次配置构造，不借用 adapter client、不调用 server 启动/连接生命周期，也不创建 session 或发送 prompt。

每次共享加载拥有一个 Scope、AbortController 和十五秒工作预算。本地版本、三路 CLI 发现和一秒重试等待，以及远端三路 SDK 请求，均在此预算内；SDK 接收同一 signal，晚加入者不能重置预算。首等待者取消保留其他等待者，最后等待者取消或超时则释放加载。短命令设置两秒强制退出宽限并等待 finalizer，所以十五秒是工作预算，不是包含操作系统清理的绝对返回上限。runtime 公开调用仍支持仅传部分环境并继承宿主；目录内部固定最终 cwd/env 后关闭二次继承，Windows 解析与 spawn 使用同一参数。取消保持中断，不会作为模型失败重试或降级为空技能；同步解析 defect 转成健康错误后允许恢复。

新测试还复现了公共 `ProviderCatalogCache` 的清理缺陷：首等待者取消、其余等待者完成后，下一次强制刷新仍可能读到已结束加载。虚拟时钟用例在容量0和2时均返回旧值1而非新值2；结合 installed Effect 的 Cache 实现，旧零TTL清理依赖首 fiber 的时钟上下文。现在每轮加载按独立对象登记、完成标记和等待退出清理，不依赖该时钟；同步加载在条目登记后释放，旧轮清理不能删除同键新一轮。既有成功TTL、失败保留旧值、容量、强制刷新和取消规则保持。

主线程从 HEAD 第49主题导出纯候选，只加入本主题11源。`vp test run --config .candidate-test.config.ts` 指定18文件，共208项通过，85.15秒：provider 下的 `OpenCodeCatalog.test.ts`、`opencodeRuntime.catalog.test.ts`、`opencodeRuntime.inventory.test.ts`、`Layers/OpenCodeProvider.test.ts`、`Layers/OpenCodeAdapter.test.ts`、`Layers/ProviderInstanceRegistryLive.catalog.test.ts`、`Layers/ProviderInstanceRegistryLive.test.ts`、`Layers/ProviderInstanceRegistryHydration.test.ts`、`ProviderCatalogCache.test.ts`、`CliProviderCatalog.test.ts`、`byok/ByokCatalog.test.ts`、`byok/ByokModelDiscoveryService.deadline.test.ts`、`makeManagedServerProvider.test.ts`、`Layers/CodexProvider.catalog.test.ts`、`Layers/ClaudeProvider.catalog.test.ts`、`Layers/GrokProvider.catalog.test.ts`、`Layers/CursorProvider.test.ts`，以及 `textGeneration/OpenCodeTextGeneration.test.ts`。全部路径位于 `apps/server/src/`。目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json`、11源 `vp fmt --check` 与 `vp lint` 通过，无目标类型/lint诊断；保留既有 Windows shell 的 Node DEP0190提示，没有全仓检查。

有效旧版对照只替换隔离候选中的三个 HEAD 第49主题生产文件：公共缓存两项新加载断言失败，runtime 两项 cwd/环境断言失败，Provider 完整状态检查出现两次目录加载而非一次。每组 finally 按SHA恢复，原始日志为 `catalog-opencode-{cache,runtime,provider}-old-red.log`。恢复后再跑缓存、目录、runtime新测试、Provider及registry目录五文件55项，全部通过，5.20秒；属于208项的子集。第一次组合新目录测试的两项缓存失败及修复前单独红灯记录均保留，未把失败隐藏为测试波动。

独立只读审核在候选添加5项临时组合测试，5/5通过，2.59秒。真实本机HTTP配合实际SDK/runtime验证完整健康检查中首 caller Scope 关闭、其他等待者继续；三轮9个请求确认 connected 有值→空→恢复，认证与原生模型同步变化；推进测试时钟至15秒及最后等待者取消均关闭三路悬挂HTTP；畸形技能JSON返回健康error而非抛出defect。Windows相对`.cmd`启动真实Node假CLI，等价并发完整检查共4命令，之后顺序检查累计8命令，cwd/env、版本、模型、技能和各自自定义模型符合输入。命令白名单排除 server/session/prompt。首轮4/5来自临时HTTP夹具重复结束响应，修正夹具保护后5/5退出0；生产代码未因此改动。审核日志 `catalog-opencode-review.log` 保存两轮输出及11源执行前后SHA一致，审核未发现未修复的阻塞缺陷。与主矩阵合计213个不同用例。

接口研究访问日期2026-10-13，关键词 `OpenCode provider.list/auth/connected`、`auth list`、最低版本SDK。采用官方固定版本 [v1.14.19生成SDK](https://raw.githubusercontent.com/anomalyco/opencode/v1.14.19/packages/sdk/js/src/v2/gen/sdk.gen.ts) 和 [models命令](https://raw.githubusercontent.com/anomalyco/opencode/v1.14.19/packages/opencode/src/cli/cmd/models.ts) 确认最低版本没有新 `/api/provider` 独立接口；当前本库SDK为1.15.13，不能仅因其存在新方法就提高运行时前提。旧组合语义另由官方 [v1.2.21 provider路由](https://raw.githubusercontent.com/anomalyco/opencode/v1.2.21/packages/opencode/src/server/routes/provider.ts) 与 [auth命令](https://raw.githubusercontent.com/anomalyco/opencode/v1.2.21/packages/opencode/src/cli/cmd/auth.ts) 辅助核对，明确它们不代表当前最低版本源码。未以凭据清单伪造独立可用性查询，未复制参考项目实现。

本主题影响三端共用的服务端设置刷新与模型选择，本地/远程/隧道沿用既有快照接口；没有新增UI、wire字段、权限、快捷键、持久结构或持续动画。其他provider沿用此前目录入口并接受公共缓存清理修复；各自总预算与同一signal仍需继续实施。没有真实供应商账号、外部服务、三端新运行或Linux/macOS进程验收，现存服务未加载本主题。回退本主题11源可恢复此前目录行为，无数据迁移。第11项保留其他provider总deadline/同一AbortSignal及模型/模式剩余边界；全部39项与comparison额外范围继续，不能把本主题完成视作总目标完成。

## 51. BYOK 目录候选与跳转共享实际 Fetch 信号

BYOK 的共享 `discoverTarget` 现在拥有整轮 HTTP Scope 和 AbortController；各候选、跳转及正文处理复用该 Scope，保留既有十五秒总预算。成功、全部失败、超时或最后等待者取消都会 abort 并释放请求。首调用者取消、某个短等待预算到期及单个候选正常失败，均不能取消其他等待者仍需要的加载。缓存命中无需建立传输，新一轮强制刷新使用新信号；身份、成功TTL、失败旧值和实例路由规则不变。

实际安装 Effect `4.0.0-beta.103` 的 `FetchHttpClient` 最后覆盖 `RequestInit.signal`，`HttpClient.withScope` 又为每个请求创建独立controller，因此仅传 RequestInit 或统一 Effect Scope 都不能证明实际 Fetch 收到同一对象。新增 `ByokHttpClient.fetchHttpClientLayer`，构造时保存实际 Fetch，在 `transformResponse` 内读取私有 Context.Reference，并向原响应 Effect 提供固定的 Fetch 包装。只替换实际调用的 signal，其余最终传输参数保留；未向 RequestInit 或请求头添加内部标记，也未使用 Effect 私有API、全局 Fetch替换、伪请求或额外取消监听器。

服务器只为 `ByokCatalog.layer` 绑定此工厂；构造时注入的 custom Fetch 被保留，执行期 ambient Fetch 不能绕过包装。直接注入未包装的通用 HttpClient 仍可正常使用，严格同对象 signal 的契约属于生产专用工厂路径。余额与独立 `fetchByokCatalog` 保留自有Scope及默认预算；不同目录目标分别拥有共享加载，不能将某一实例的等待controller连接到全部目标而破坏其他客户端。跨目标统一等待与取消所有权以及其他provider剩余契约仍属第11项后续。

独立审核在实施中指出两处具体风险并促成修正：合并默认 RequestInit.headers 会在跨源跳转后补回已剥离凭据；仅在 HTTP layer 构造时包装 Fetch 又可能被执行期上下文覆盖。最终 helper 保持旧 manual-only options，工厂在响应执行内部固定实际传输；测试覆盖 ambient 默认 authorization/cookie/x-api-key 不回填、仅 layer 构造注入的 Fetch 保留及执行期替代 Fetch 不执行。三次跳转与4 MiB正文上限沿用原有验证。

纯候选为 HEAD 第50主题加5源，运行 `vp test run --config .candidate-test.config.ts` 指定 provider 下的 `byok/ByokCatalog.signal.test.ts`、`byok/ByokCatalog.test.ts`、`byok/ByokModelDiscoveryService.deadline.test.ts`、`byok/ByokModelDiscoveryService.test.ts`、`byok/byokHttp.test.ts`、`byok/ByokBalanceService.test.ts`、`ProviderCatalogCache.test.ts`、`Layers/ByokProvider.catalog.test.ts`，全部位于 `apps/server/src/`，8文件109项通过，8.90秒。新增9项使用真实 FetchHttpClient 配合注入 Fetch，严格比较各候选/跳转signal对象，覆盖前候选耗时后的请求与正文超时、等待者隔离、全失败恢复、独立调用及注入兼容。

服务入口的目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json` 初次发现 Bun 全局 Fetch 声明要求静态 `preconnect`；仅修正生产包装与测试替身的调用函数类型边界，没有伪造静态方法或改变运行逻辑。最终检查退出0，保留 CliProxy、ByokAdapter、localAccountUsage 中4条已有 `Effect.succeed(undefined)` 建议，三文件与HEAD源码一致；不将其写成零诊断。5源 `vp fmt --check`、`vp lint` 通过，lint无诊断。没有运行全仓检查。

有效旧版对照仅在候选恢复 HEAD 第50主题的 `ByokCatalog.ts`，新多候选/跳转用例在signal对象身份断言明确失败（false而非true），日志为 `catalog-byok-signal-old-red.log`；finally 按SHA恢复。恢复后新信号测试与既有HTTP测试2文件17项通过，1.18秒，属于109项子集。主工作区没有恢复为旧版，也没有跳过失败用例。

独立审核另执行3项真实本机 HTTP/Fetch 组合，初次及最终类型修正后均3/3通过；最终769毫秒、退出0。第一个候选404、第二个跨源302、最终正文挂起，共三次实际Fetch使用同一signal；首Scope取消与另一等待者1秒超时后，剩余等待者仍取得结果。缓存命中不请求，强刷新建信号；第一候选6秒加后续正文9秒在整轮15秒结束并观察到真实连接关闭，最后等待者取消也关闭未完成正文。跨源目标没有认证头，普通自定义头保留。测试时钟只控制预算，连接关闭来自真实HTTP事件。最终5源执行前后与工作区SHA一致，独立测试不提交；日志 `catalog-byok-signal-review.log` 保留两轮输出及审核发现。主矩阵加独立组合共112个不同用例，范围内没有尚未修复的阻塞缺陷。

三端既有设置、模型发现与选择入口，以及本地/远程/隧道连接，继续使用同一服务端目录。没有新增UI、协议字段、权限、持续动画或持久结构；草稿发现仍不创建会话。其他provider及余额调用保持原入口，本轮未操作真实账号、外部供应商、产品运行服务或三端UI。回退本主题5源可恢复此前传输行为，无数据迁移。第11项仍在进行，全部39项和comparison额外范围没有缩减。

## 52. Codex／Claude 完整原生刷新预算与资源所有权

新增注册表持有的 `NativeProviderCatalog`，等价配置的完整原生刷新只合并在途执行。每个真正加载拥有一个实际 AbortController、资源 Scope 和总预算；认证不进入完成缓存。Codex／Claude driver 接入同一注册表对象，实例重建沿用，不同注册表与直接创建的私有对象相互独立。键与实际执行使用冻结的 binary/argv/cwd/env/home 参数，自定义模型和 checkedAt 在返回后逐调用映射。强刷新只加入强刷新，普通请求可加入已有强或普通请求；若选择强通道时原加载恰好结束，新建加载仍在内部携带强意图，不能把普通加载放进强通道。

Codex 十秒预算覆盖 initialize、account/read、分页模型、技能及必要损坏诊断。健康 client 直接读取目录，冷路径由此前两进程变为一个；顺序检查仍读取账户，稳定OAuth身份的一分钟纯目录及匿名身份不复用规则保留。损坏诊断只用本轮剩余时间，截止后不另起进程，解析及 spawn 采用同一 cwd/env。Codex RPC 没有独立signal参数，通过整段 Effect 中断与进程 Scope 连接到 owner 信号，停止后续请求。独立 `fetchCodexCatalog` API 保留自有探针行为；完整刷新内部以 `shareInFlight:false` 直接在 owner 中加载纯目录。

Claude 的版本、SDK initialize 和技能扫描共用三十秒预算，保留此前慢 Bedrock 初始化事实而不把二十五秒保障缩到十五秒。SDK 接收 owner 的实际 controller，Query 在初始化返回后继续存在，技能阶段结束后才关闭；公开独立 probe 保留自身二十五秒约定。超时保留本次 owner 已确认的安装、版本及版本模型门控，认证unknown；晚加入者不能用自己的空进度覆盖原owner状态。当前账户、命令逐次初始化读取，初始化拒绝与恢复有覆盖；成功初始化但账户字段空保留旧状态语义，不把它称作已验证退出登录。关闭持久化、hooks、MCP及不发送prompt边界保持。

公共目录缓存增加当前 Scope 加载选项，仍复用同一完成值、TTL、容量及失败旧值。并行纯目录按活动代次保护写回，较新强刷完成或失败后，旧加载不能恢复写权限；强代次也保护“普通 owner 账户阶段更慢、较晚才到目录”的反序情况。普通等待者仍收到自己的加载结果，缓存保留强结果。全部活动加载结束时删除代次记录，避免无界登记。底层Cache同步启动lookup再登记取消处理，实际SDK同步阶段回执重入取消曾导致最后等待者离开后仍不abort/close；现在lookup先让出调度，ensuring覆盖该让出点，登记完成后才运行加载。加载开始前及登记后启动前的取消清理均保留。

纯候选为 HEAD 第51主题加16源，`vp test run --config .candidate-test.config.ts` 指定21文件，251项通过，111.81秒：provider 下 `ProviderCatalogCache.test.ts`、`CliProviderCatalog.test.ts`、`NativeProviderCatalog.test.ts`、`Layers/ProviderInstanceRegistryLive.catalog.test.ts`、`Layers/CodexProvider.refresh.test.ts`、`Layers/CodexProvider.catalog.test.ts`、`Layers/CodexProvider.test.ts`、`Layers/ClaudeProvider.refresh.test.ts`、`Layers/ClaudeProvider.catalog.test.ts`、`Layers/ClaudeCapabilitiesProbe.lifecycle.test.ts`、`Layers/ClaudeCapabilitiesProbe.test.ts`、`Layers/ProviderRegistry.test.ts`、`OpenCodeCatalog.test.ts`、`byok/ByokCatalog.test.ts`、`byok/ByokCatalog.signal.test.ts`、`Layers/ByokProvider.catalog.test.ts`、`makeManagedServerProvider.test.ts`、`Layers/ProviderInstanceRegistryLive.test.ts`、`Layers/ProviderInstanceRegistryHydration.test.ts`、`Layers/GrokProvider.catalog.test.ts`、`Layers/CursorProvider.test.ts`，均位于 `apps/server/src/`。没有运行全仓检查。首次目标类型检查发现Claude capabilities与skills依赖误用同一泛型，分为两个依赖并集后，`tsgo --noEmit -p apps/server/.streaming-typecheck.json` 退出0、无诊断；最终16源格式与lint通过、无lint诊断。保留既有Node Windows shell DEP0190提示。

四组有效对照只替换隔离候选、finally按SHA恢复：本主题中间Cache版本使最小Promise同步回执取消用例持续等待实际abort收据，五秒测试上限失败；同一中间版本使强目录先开始、普通晚到后的缓存断言失败；恢复HEAD第51主题Codex生产文件使损坏诊断cwd断言失败；恢复旧Claude生产文件使跨版本／初始化／技能阶段的信号存活断言失败。原始记录为 `catalog-native-refresh-{cache-cancel,cache-strong,codex,claude}-old-red.log`，四组 `valid:true/restored:true`。最小取消用例使用默认forkChild，让调用者先等待回执，避免提前启动掩盖重入窗口。结束后8个直接相关文件76项全部通过，12.35秒，属于251项子集。另保存工作区修复前真实Claude取消原始日志与120秒失败摘要，修复后相同收据要求约21毫秒通过。一次测试名称正则经Windows `.cmd` 错误解释为管道导致EPIPE，属于命令失败，不计行为红证据；改用文件级验证及无shell Node对照后通过。

独立只读审核执行2份临时文件、4项实际Windows CLI／SDK组合，4/4通过、exit0，26.58秒。Codex账户阶段7秒、分页剩余3秒，晚加入及首Scope取消保留共同进程，超时不另起诊断；两个顺序分别覆盖普通目录先开始和普通账户更慢，强刷先完成后旧普通均不能覆盖完成缓存。Claude真实版本进程5秒、实际SDK初始化20秒、临时目录技能扫描剩余5秒，共同控制器保持到总预算结束；保留已确认安装／版本，随后新控制器恢复。预算用TestClock推进，协议和Windows进程实际执行，账户及provider响应为本机假CLI，技能暂停是受控文件系统拦截，恢复读取真实临时技能文件。执行前后16源与工作区SHA一致，主矩阵加独立组合共255个不同用例，范围内无未处理阻断缺陷。

独立夹具首跑删除临时cwd发生EBUSY，不能作为业务通过证据；后续两调用创建不同owner的原因是实际SDK在query中修改测试进程环境，夹具逐次复制process.env使输入不同。最终固定HostProcessEnvironment及显式env，断言native key相同后通过，没有修改生产键掩盖配置差异。全部失败原始输出保留，汇总为 `catalog-native-refresh-review.log`。四轮Claude假CLI／SDK日志捕获的12个自有PID逐个确认已不存在；Codex证明实际client Scope释放与TCP关闭，未额外保留系统PID快照。`Query.close():void`、signal或TCP关闭不等于一般OS退出保证，第15项仍独立；同步文件系统调用也不能由Effect预算抢占。

三端既有设置刷新、模型选择及本地/远程/隧道请求继续使用服务端快照；没有新增UI、wire字段、权限、快捷键、持久结构或持续动画。其他provider接受公共缓存清理和写回保护，其余CLI整次预算／信号、跨目录目标取消及模型／模式边界继续实施。没有本轮真实供应商账号、产品服务启动或三端新运行验收；保留运行服务未加载本主题。回退本主题16源可恢复前一主题行为，无数据迁移。第11项仍在进行，完整39项及comparison额外范围继续。

## 53. Cursor 完整原生刷新、身份与取消边界

CursorDriver 接入 registry 持有的 `NativeProviderCatalog`，等价配置完整检查只共享在途执行。about（含旧CLI文本格式回退）、渠道文件读取、客户端初始化、认证及 `cursor/list_available_models` 使用同一个实际 controller、Scope 和十五秒工作预算，晚加入者不能重置截止时间。首等待者取消保留其他等待者，最后一个取消才终结共同加载；强请求不加入普通旧加载，普通请求可加入强加载。初始pending快照与禁用路径不启动检查，明确未登录不查询模型；仍使用客户端准备，不调用 `startSession`、`session/new` 或发送prompt。

纯目录在完整 owner 内以 `shareInFlight:false` 读写一分钟成功缓存，不建立第二个预算或Scope。完成键补已观测版本、渠道及完整协议可见认证字段，包含实际binary/端点/cwd/env与渠道配置路径；unknown、无稳定邮箱或无法识别版本时直接重新发现，不读写完整检查的完成目录。版本、账号、套餐、渠道变化均有覆盖。入口复制实际配置，环境冻结后同时用于键与执行；共享结果返回后，各调用者按自己的冻结自定义模型合并，并重新生成完成时的checkedAt。Cursor账号池仍只参与真实会话环境准备，没有新增凭据刷新或借用adapter。

公开 `discoverCursorModelsViaAcp` 保留三参数兼容，入口仅冻结binary/端点，缺少实时身份时使用独立 `unverified` 操作键与 `forceRefresh:true`。它保留等价在途共享，顺序调用每次重新发现；此路径仍保存成功值，但以后不复用，不能写成完全不保存。完整检查与独立入口共用同一个底层ACP加载器，后者拥有自己的十五秒Scope/controller。旧测试按新行为保留并调整三组计数：顺序同配置1→2组、环境/强刷新矩阵5→6组、版本账号变化1→2组；等价并发仍断言只探测一次。

新增公共 `withCatalogAbortSignal` 使用公开Effect API：预取消直接中断；注册abort监听后复查信号，结束移除监听；race工作分支先让出调度，确保两个fiber已登记后才允许同步阶段回执触发取消。真实资源由工作Scope终结，typed error和interruption不被吞掉。新五项测试覆盖预取消、同步回执重入、实际Scope终结、外部caller取消、当前服务与监听清理及原错误；没有全局fetch、私有fiber API或在回调另起后台工作。about直接设置两秒强杀宽限，Cursor目录探针使用局部spawner薄包装把该选项传到ACP及其tracked-PID taskkill；公共ACP runtime与会话默认策略不变。同步文件系统调用和操作系统清理仍不能由十五秒预算保证硬墙钟退出。

主线程以HEAD第52主题导出纯候选，加本主题6源，运行 `vp test run --config .candidate-test.config.ts` 指定12文件：provider 下 `CliProviderCatalog.test.ts`、`NativeProviderCatalog.test.ts`、`ProviderCatalogCache.test.ts`、`Layers/CursorProvider.test.ts`、`Layers/CursorProvider.refresh.test.ts`、`Layers/CursorAdapter.test.ts`、`acp/CursorAcpExtension.test.ts`、`acp/CursorAcpSupport.test.ts`、`acp/CursorAcpCliProbe.test.ts`、`Layers/ProviderInstanceRegistryLive.catalog.test.ts`、`makeManagedServerProvider.test.ts`，以及 `textGeneration/CursorTextGeneration.test.ts`，均位于 `apps/server/src/`。11文件159项通过，184.11秒；真实安装门控 `CursorAcpCliProbe` 1文件3项跳过，宿主未启用该开关，没有真实供应商验收。主矩阵完成后最后一处类型判别改为结构标签，运行分支保持一致；最终源码及旧版对照恢复后4个直接相关文件55项通过，48.93秒，是159项子集，不重复计数。

两次目标类型检查红灯原始日志保留：首次有维护逻辑所需import误删、可选字段显式undefined及不同错误Effect联合推断；随后两分支分别Result仍使泛型 `Result.isFailure` 无法对union收窄。恢复import、条件字段、分支Result和直接 `_tag` 判别后，最终 `tsgo --noEmit -p apps/server/.streaming-typecheck.json` 退出0、无诊断，未使用any或强转掩盖。最终6源 `vp fmt --check`、`vp lint` 退出0、lint无诊断。保留既有Windows shell的Node DEP0190提示，没有全仓检查。

三组有效旧版对照均只改隔离候选并finally按SHA恢复：取消helper去掉race前让出，最小同步回执取消在五秒内收不到实际资源关闭收据；恢复HEAD第52主题Cursor生产文件，身份变化仍只查询一次而非五次，checkedAt返回启动时刻而非五秒后的完成时刻。原始日志为 `catalog-cursor-native-helper-old-red.log`、`catalog-cursor-native-identity-old-red.log`、`catalog-cursor-native-caller-freeze-old-red.log`；三组valid/restored均为true。后一个红证据首先失败在时间戳，不能将未运行到的配置断言也算已复现；配置冻结由最终绿色收据和执行参数断言证明。主工作区没有回退旧生产源码。

独立审核最终4项真实Windows `.cmd → Node` CLI/ACP组合4/4通过、exit0，29.52秒。about消耗6秒后ACP只获剩余预算，第二caller第10秒加入、首Scope关闭仍保持同一个owner至第15秒超时，保留已确认版本/账号/安装及各自custom，随后新controller恢复。稳定身份二次检查只运行about，版本/账号变化重新探测；unknown连续两轮返回各自新模型；独立入口仍完成真实scoped目录删除。4个临时目录均删除，24个实际handle终结后running/osAlive均false，8次taskkill退出0，40个捕获自有PID逐个后续核对均不存在，未额外kill。8组24个ACP请求全部为initialize/authenticate/list_available_models，没有session或prompt。预算由TestClock与真实阶段收据驱动，账户/模型为虚构，不能称真实Cursor云端或绝对墙钟退出验收。审核前后6源与工作区SHA一致，日志 `catalog-cursor-native-review.log`，SHA `B2B0285B37198A46EAC6C9A65004C7D8CE4565B747E5E1E037C7717DF5E976C7`。主矩阵加独立最终组合共163个不同用例；此前诊断及复验不重复计数。

实施初次工作区默认配置的旧测试有4个Windows临时目录EBUSY，单项又复现两次；去掉局部两秒选项仍失败，已恢复。原输出重建为明确标记的摘要 `catalog-cursor-native-first-failures-summary.md`，不把它当原始重定向日志。HEAD52单项、三组带只读PID观察的真实trace、最终无trace159项、恢复55项和原工作区apps/server默认配置同一单项随后均通过；后者1通过27跳过、13.43秒，raw `catalog-cursor-native-default-config-green.log`。观察可能改变时序，两个配置本来都内联同样平台包，因此没有实证唯一根因，不宣称已定位修复；没有保留目录、sleep/轮询或按名称kill来掩盖失败。真实trace的19个捕获PID亦确认退出，属于诊断而非最终四项新增数字。当前验收未复现该失败，本增量范围内没有遗留阻断发现，第15项通用进程完全停止契约仍独立。

三端既有设置刷新、模型选择以及本地/远程/隧道请求继续取服务端快照；没有新UI、wire字段、权限、快捷键、持久结构或持续动画。没有本轮三端产品运行或真实账户验收，保留服务未加载新主题。其他provider沿用此前实现；Grok及六家配置CLI总预算/信号、跨目录目标取消与模型/模式剩余边界继续实施。回退本主题6源可恢复前一主题目录行为，无数据迁移。第11项保持进行中，全部39项及comparison额外范围保持不变。

## 54. Grok 完整原生刷新与 Driver 路由准备

`GrokDriver` 使用注册表共享的 `NativeProviderCatalog`。新统一入口 `fetchGrokCatalog` 将刷新期配置准备、版本、技能、初始化与 `x.ai/models/list` 放在同一个十五秒工作预算、Scope 和 AbortController 中，晚加入者不续时；强/普通意图和首/末等待者取消沿用公共目录所有权。没有稳定认证身份，因此不保存完成模型目录，顺序刷新始终读取当前 CLI；没有认证写入、session 或 prompt。技能非零退出仍按最佳努力返回空列表，取消继续传播。owner 内不再追加技能四秒超时，独立技能调用仍保留该预算。

入口在首次异步等待前复制配置、自定义模型、准备身份和显式环境，宿主环境捕获后同时用于键与执行。版本/ACP 使用宿主 cwd，技能使用服务器 cwd；解析器和 spawn 使用各自相同实际 cwd/env，关闭环境二次继承。键包含两种 cwd、实际环境、ACP 环境、命令、准备路径/来源/网关和路由代次；显式传入配置内容也参与身份。自定义模型在共享结果外按当前调用者的冻结输入补齐，checkedAt 使用完成时间。短命令与局部 ACP 探针采用两秒强制退出宽限，不修改公共会话策略。

原 `fetchCatalog` 维持无错误签名，新增 `fetchCatalogWithError` 在同一零TTL在途加载中保存预期错误的原 cause，失败后可重新加载；缺陷与中断不包装。Driver 将错误补为当前等待者自己的 `ServerSettingsError` 路径/操作/实例字段；公开 managed refresh 继续以 defect 承载领域错误。路由准备只读取一次设置，托管文件和纯模型覆盖复用该快照，不在目录完成后异步重读，也不带共享首实例身份。registry 将已有 `__byokSourceFingerprint` 在配置解码外传入可选 `catalogRevision`，不同代次不合并；不新增 wire 或持久字段。默认个人 home 只读，隔离目录才维护托管模型块。

主线程从第53主题 HEAD 导出纯候选，只叠加本主题15源，所有153个工作区包别名指向候选。最终 `vp test run --config .candidate-test.config.ts` 指定14文件：provider 下 `NativeProviderCatalog.test.ts`、`Layers/ProviderInstanceRegistryLive.catalog.test.ts`、`Layers/ProviderInstanceRegistryHydration.test.ts`、`Layers/GrokProvider.refresh.test.ts`、`Layers/GrokProvider.catalog.test.ts`、`Layers/GrokProvider.test.ts`、`Drivers/GrokDriver.catalog.test.ts`、`Drivers/GrokSkills.test.ts`、`acp/GrokAcpSupport.test.ts`、`makeManagedServerProvider.test.ts`、`Layers/CodexProvider.refresh.test.ts`、`Layers/ClaudeProvider.refresh.test.ts`、`Layers/CursorProvider.refresh.test.ts`、`byok/modelGateway.test.ts`。14文件172项通过，63.65秒，原日志 `catalog-grok-native-tests-final.log`。新增8项完整刷新和4项实际 Driver 验证了预算、取消、未知身份新目录、代次隔离、冻结输入、技能失败、完成时间、共享路由及失败实例身份、个人目录只读和超时恢复。

最后的测试类型修正只补品牌 ID、必填字段及 Schema 判别；最终 Driver 4项再次通过，3.30秒，是172项子集。15源 `vp fmt --check`、`vp lint` 均退出0，lint无诊断。目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json` 退出0；保留 HEAD 的 ByokAdapter 两条 `Effect.void` 建议，未称零诊断，候选该文件未吸收原工作区修改。新增测试最初的品牌/必填/instanceof 类型错误均已修正，没有 any 或强转规避。Windows shell 的既有 DEP0190 提示保留，没有全仓检查。

最初13文件矩阵的6个失败来自新 ACP 假句柄错误地立即返回 exitCode=0，导致目录请求未完成即结束；改为 Deferred 退出收据后7项通过，2.53秒，随后新增边界后3文件17项通过，5.67秒。实际 Driver 首次测试还误把路由 slug 当上游 modelId、把公开 refresh 当 typed error，以及遗漏补充发布设置读取；根据现有契约修正后通过，没有更改生产逻辑迁就夹具。这些诊断日志保留，不计作旧版行为失败。

有效旧版对照只替换隔离候选的 `GrokSkills.ts` 为第53主题版本：准备5秒、版本3秒、技能4秒后，旧独立技能计时器使结果变为空列表，断言 `[]` 不等于 `[review]` 失败。`catalog-grok-native-skills-old-red.log` 退出1，有直接 AssertionError；finally 按 SHA 恢复，`catalog-grok-native-skills-red-proof.json` valid/restored 均 true。恢复后相关用例绿色，主工作区未恢复旧代码。

两项额外真实 Windows `.cmd → Node` CLI/ACP 组合通过，12.03秒，日志 `catalog-grok-native-windows-initial.log`。版本用6秒、技能用5秒后模型只获剩余4秒；晚加入与首 Scope 取消不重置预算，超时保留版本/技能/custom/完成时间，随后新加载恢复。最后等待者取消结束实际子进程，未知身份后续两轮分别读取新模型。十五次假 CLI 启动、十个 ACP 请求均只含 initialize 和 x.ai/models/list；两个真实 scoped 临时目录已删除，35个捕获的外壳、Node 及清理 PID 后续逐个确认不存在。20个真实 handle 终结后 running/osAlive 均 false，其中五个是 taskkill 清理进程。预算使用 TestClock 和实际 TCP 阶段收据，不使用 sleep/轮询、按名称 kill 或保留目录掩盖资源泄漏。账号/模型均虚构，不能称 Grok 云端认证、真实供应商或硬墙钟退出验收。主矩阵加两项 Windows 组合共174个不同用例，诊断与复验不重复计数。

创建实例的初始路由协调、managed 前后设置读取和 OS 清理不属于十五秒工作预算。目录缓存的代次保护不等于文件事务隔离：多个实例显式指定同一可写 GROK_HOME 时，并发文件写入顺序仍需独立验收；默认实例 home 独立，个人默认 home 只读。该边界保留在第11项后续，未声称已关闭。

本主题影响三端共用的服务端设置刷新、模型选择与本地/远程/隧道请求，未新增入口、权限或持续动画。其余 provider 保持既有实现，并通过受公共接口影响的定向回归。本轮没有真实供应商、三端产品操作或新服务启动，保留服务未加载新主题。回退15源与4文档可恢复前一主题行为，无数据迁移。只独立提交本主题，原84个无关文件及混合 BYOK/ChatView 改动继续保留。第11项仍开放六家配置CLI整轮预算/信号、跨目录目标取消、共享可写home和模型/模式边界；完整39项与comparison额外范围不缩减。

## 55. Kimi 完整刷新与版本探针工作预算

`KimiDriver` 接入 registry 的 `NativeProviderCatalog`，统一 `fetchKimiProviderCatalog` 入口在十五秒 owner 内执行路由准备、配置模型目录与版本探针。纯配置模型继续复用既有 `fetchKimiCatalog` 成功缓存；安装/版本/认证状态只共享正在执行的检查，完成后重新读取版本。版本解析和 spawn 使用冻结的同一实际 cwd/env，关闭环境二次继承，设置两秒强制退出宽限。禁用实例仍探测实际安装状态，保持原来的安装按钮语义；不创建 ACP 会话或发送 prompt。

完整键覆盖实际命令、启用状态、规范化模型配置、工作目录、完整环境及路由来源/代次。配置和环境在异步等待前复制，checkedAt 使用每个调用者的完成时间。准备与版本共享同一 controller/总预算；晚加入者不续时，首取消保留其他等待者、末取消终结共同加载，强刷新不加入普通旧执行。路由准备只读一次设置，纯覆盖函数保留既有失败关闭语义（读取设置失败时路由模型为空），模型覆盖没有预算外异步尾读；各实例身份在共享结果外补齐。初始路由映射保持原行为，实例重建复用第54主题的内存 catalogRevision。

第54主题 HEAD 导出的纯候选叠加4源，`vp test run --config .candidate-test.config.ts` 指定 `Layers/KimiProvider.refresh.test.ts`、`Layers/KimiProvider.test.ts`、`Layers/ConfiguredCliProvider.catalog.test.ts`、`Drivers/KimiDriver.catalog.test.ts`（均位于 apps/server/src/provider），4文件20项通过，最终清理后6.08秒。六项新整轮测试覆盖准备6秒+版本剩余9秒、晚加入、首/末取消、配置环境冻结、实时禁用安装、强刷新/路由代次、版本失败与取消；实际 Driver 用例证明跨实例共享路由准备、各自身份和新代模型。旧纯目录缓存以及 Antigravity 对照未改，全部通过。4源最终目标类型无诊断，格式/lint退出0；首次类型检查的同步 Schema 解码位置问题已修正为模块级 Effect 解码器，lint 的内联编译提示和 Driver 无用旧变量也已清理，没有全仓检查。

真实 Windows `.cmd → Node` 版本命令1项通过，2.84秒，`catalog-kimi-native-windows-initial.log`。版本阻塞时第6秒加入第二caller、关闭首Scope，仍由同一个owner在第15秒结束，TCP关闭收据确认实际子进程终结，后续版本恢复。两次假 CLI 启动、两个真实 handle 终结后 running/osAlive 均 false；4个捕获的外壳/Node PID 后续核对不存在，scoped 临时目录已删除，没有额外 kill、sleep/轮询或保留目录规避失败。测试只使用本机端口与虚构 CLI，不能称真实供应商认证或绝对墙钟上限。

另1项公开状态入口的有效旧版对照只替换隔离候选 KimiProvider 为第54主题版本：版本探针一直挂起，旧路径到16秒观察时限仍未完成，结果为 `observer reached`，与十五秒工作预算消息的断言直接失败。恢复新版后通过，finally 按SHA校验恢复；`catalog-kimi-native-deadline-proof.json` 两轮 valid/restored 均 true。该观察时限仅用于红灯证明，不是生产计时或 sleep 验收。主矩阵加实际 Windows/公开入口各1项共22个不同用例，复验不重复计数。

三端既有模型选择/设置入口、本地/远程/隧道继续使用同一服务端快照，没有 wire、持久结构、权限或动画改动。本轮未运行三端产品、真实账户或新服务，现存服务未加载此增量。初始路由映射、managed 前后设置与 OS 清理不属于十五秒工作预算。回退4源与4文档可恢复第54主题行为，无数据迁移。原84个无关文件及 BYOK/ChatView 混合改动保持。第11项仍开放 Antigravity、通用ACP、Pi、OhMyPi、ZCode 整轮预算/信号，跨目标取消、显式共享可写 home、模型/模式边界及对应完整连接/客户端验收；原39项与comparison额外范围保持不变。

## 56. Antigravity 完整刷新与版本进程预算

`AntigravityDriver` 接入注册表共享的 `NativeProviderCatalog`，统一 `fetchAntigravityProviderCatalog` 入口把纯配置目录和版本探针纳入同一个十五秒 Scope/controller。纯配置完成缓存仍由已有 `fetchAntigravityCatalog` 提供；版本、安装与未知认证不读整轮完成缓存。禁用实例继续探测实际安装。入口复制配置与显式环境，完整身份包含实际命令、启用状态、规范化模型配置、宿主 cwd 和最终环境；解析和 spawn 使用同一冻结 cwd/env，关闭二次继承并设置两秒强制退出宽限。checkedAt 为每个调用者的完成时间。目录不执行 ACP 会话、认证写入或 prompt。

晚加入不重置截止时间，首等待者取消保留其他等待者，末取消才终结共同加载。强刷新不加入普通旧执行，不同配置独立执行；只影响实例身份的字段不进入键，规范化后等价的自定义模型配置仍只启动一次版本探针。Driver 在共享结果外补各自身份，adapter 保持独立；创建时复制配置，避免后续编辑改变捕获的探针参数。移除该 Driver 中未使用的旧服务读取，没有改动既有 adapter/textGeneration 的类型转换或会话路径。

从第55主题 HEAD 导出纯候选，仅叠加4源。`vp test run --config .candidate-test.config.ts` 指定 `Layers/AntigravityProvider.refresh.test.ts`、`Layers/AntigravityProvider.test.ts`、`Layers/ConfiguredCliProvider.catalog.test.ts`、`Drivers/AntigravityDriver.catalog.test.ts`（均在 apps/server/src/provider），4文件21项通过，5.79秒，日志 `catalog-antigravity-native-tests-final.log`。七项新整轮用例覆盖目录6秒+版本剩余9秒、晚加入、首/末取消、输入冻结、禁用安装、实时版本、强刷新、规范配置合并、不同配置、失败与取消；实际 Driver 用例证明等价配置跨实例共享且身份/adapter 独立。旧 Kimi/Antigravity 配置缓存及安装语义保持通过。

目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json` 退出0、无诊断，4源 `vp fmt --check` 和 `vp lint` 退出0、lint无诊断。初次类型检查发现测试缺少 Driver 声明的 ProviderEventLoggers，补无操作测试服务后通过，未用强转掩盖。最终 Driver 1项复验通过，2.67秒，是21项子集；没有全仓检查。

额外真实 Windows `.cmd → Node` 版本命令1项通过，2.83秒，日志 `catalog-antigravity-native-windows-initial.log`。版本阻塞时第6秒加入第二caller并关闭首Scope，仍在原第15秒结束；TCP关闭收据证明实际子进程终结，随后新检查恢复。两次假 CLI 启动，两个 handle 终结后 running/osAlive 均 false；四个捕获的外壳/Node PID 后续核对不存在，真实 scoped 临时目录已删除。CLI 与解析器使用相同实际 cwd，命令只有 --version，没有 session 或 prompt。只用本机端口和虚构 CLI，不是供应商云端认证或硬墙钟上限验收。既有 Windows shell DEP0190 提示保留，没有 sleep/轮询、按名称 kill 或保留目录规避失败。

公开旧入口预算对照另1项：仅替换隔离候选 AntigravityProvider 为第55主题版本，挂起版本命令到16秒观察时限仍未完成，得到 `observer reached`，与十五秒预算消息的断言直接失败。finally 按SHA恢复后同一用例通过；`catalog-antigravity-native-deadline-proof.json` 两轮 valid/restored 均 true，红灯日志有直接 AssertionError。主矩阵加 Windows/公开预算各1项，共23个不同用例，复验不重复计数。

三端既有设置/模型选择及本地/远程/隧道继续使用服务端快照，没有新 UI、wire、权限、持久结构或动画。其余provider保持此前实现；本轮未启动产品服务、操作真实供应商或运行三端产品，现存服务未加载该增量。初始快照、managed 前后设置与 OS 清理不属于十五秒预算。回退4源和4文档可恢复第55主题行为，无数据迁移。原84个无关文件及混合 BYOK/ChatView 改动保留。第11项继续开放通用ACP、Pi、OhMyPi、ZCode 整轮预算/信号、跨目标取消、共享可写home与模型/模式及完整连接/客户端验收；完整39项和comparison额外范围保持不变。

## 57. 通用 ACP 完整目录与八秒预算

`GenericAcpDriver` 接入 registry 的 `NativeProviderCatalog`，私有完整 `fetchCatalog` 将配置模型目录和实际命令探针统一到既有八秒工作预算。纯配置目录保留原来的成功缓存，初始快照仍不建会话；模型包含明确的 CLI 默认入口与配置模型。命令/参数/模型在实例创建前复制，环境也不再保留 process.env 的可变引用。每轮检查捕获实际宿主 cwd 和最终环境，同时用于键、解析与 spawn，关闭二次继承并设置两秒强制退出宽限。

完整身份包含实际拆分命令、原生参数加 --version、启用状态、规范化模型与真实 cwd/env，显示名与实例ID不参与共享。返回时才补各自身份和 checkedAt。晚加入不续时，首实例 Scope 关闭保留另一实例等待，末 Scope 关闭中断实际 owner；managed 公开调用者取消仍只结束自身等待，必须区分实例 Scope 和外部等待 Scope。手动强刷新不加入另一实例的自动普通加载，普通检查仍可加入强加载。不同环境不共享探针，顺序检查重新读取输出。

保留非零退出分类：包仓库错误仍显示可操作错误，不支持 --version 的命令仍允许进入实际会话握手，成功输出继续有界展示。整轮超时时，仅实际取得子进程句柄才表示 installed，目录阶段超时不假称启动成功；认证仍 unknown。没有会话、认证写入、session/new 或 prompt，真实适配器、MCP和模型选择能力未改。

从第56主题 HEAD 导出纯候选，仅叠加 Driver 与新目录测试两源。`vp test run --config .candidate-test.config.ts` 指定 `Drivers/GenericAcpDriver.test.ts`、`Drivers/GenericAcpDriver.settings.test.ts`、`Drivers/GenericAcpDriver.catalog.test.ts`（均在 apps/server/src/provider），3文件18项通过，43.46秒，日志 `catalog-generic-native-tests-final.log`。新7项覆盖目录3秒+探针剩余5秒、跨实例晚加入、首/末实例Scope关闭、配置和带空格参数冻结、实际 cwd/env、失败/不支持版本兼容、实时输出、环境隔离与强普通意图。既有真实命令、Windows批处理参数、认证、MCP、新建/恢复和Kiro专有执行回归通过；其中会话用例是原本的会话验收，不能与目录不建会话的断言混为一谈。

两源目标类型检查退出0、无诊断，`vp fmt --check`、`vp lint` 退出0、lint无诊断。旧版恢复后7项再次通过，3.28秒，是18项子集；没有全仓检查。既有 Windows shell DEP0190 提示保留。

额外真实 Windows GenericAcpDriver `.cmd → Node` 组合1项通过，4.29秒，日志 `catalog-generic-native-windows-initial.log`。预热后阻塞版本，第3秒第二实例加入、关闭首实例Scope仍由同一个owner在第8秒结束，TCP关闭收据确认实际进程终结；第二实例随后恢复就绪。含预热共4次假 CLI 启动、8个捕获外壳/Node PID 均已退出，scoped临时目录已删除，协议日志只有版本命令，没有ACP会话请求。真实 cwd 与目录键一致，无按名称 kill、sleep/轮询或保留目录规避清理。只用本机端口和虚构 CLI，不是云端认证或硬墙钟退出上限验收。

旧版有效对照另1项：仅替换隔离候选 GenericAcpDriver 为第56主题版本，目录先耗3秒后，旧版本阶段重新取得8秒，到第9秒观察时限仍未完成，结果 `observer reached` 与整轮8000ms消息断言直接失败。恢复新版后同一用例通过，finally按SHA恢复；`catalog-generic-native-deadline-proof.json` 两轮 valid/restored 均 true。观察时限仅用于红灯证据，不是生产轮询。主矩阵加实际Windows/公开预算各1项共20个不同用例，复验不重复计数。

三端现有设置/模型选择和本地/远程/隧道继续取服务端快照；没有新增UI、协议、权限、持久结构或动画。本轮没有产品运行、真实供应商或新服务启动，现存服务未加载此主题。实例初始目录、managed前后设置与OS清理不属于八秒工作预算。回退两源与四文档可恢复第56主题行为，无迁移。原84个无关文件及混合 BYOK/ChatView 改动保留。第11项继续开放 Pi、OhMyPi、ZCode 整轮预算/信号，跨目标取消、共享可写home、模型/模式及全连接/客户端验收；完整39项及comparison额外范围不缩减。

## 58. Pi、OhMyPi、ZCode 完整刷新与官方凭据边界

三类 Driver 接入 registry 的 `NativeProviderCatalog`，统一完整入口 `fetchPifamilyRefreshCatalog` 把刷新期路由读取、纯目录、版本及 ZCode 官方凭据装饰纳入一个十五秒 Scope/controller。旧纯目录 `fetchPifamilyProviderCatalog` 继续提供配置成功缓存，旧健康入口参数保持兼容并委托完整入口。禁用实例和 ZCode 内嵌运行时继续跳过版本探针，初始快照不创建会话。整轮完成值不保留，后续检查重新读取版本和官方账户。

键包括实际命令、前置参数、启用/内嵌状态、展示命令标识、规范路由展示字段、真实 cwd/env及准备来源/路径/代次；准备和凭据回调存在性也参与身份。已有 catalogRevision 仅为内存元数据，区分路由代次。受管 home 是实际环境的一部分，不为跨实例复用而省略它；不同实例实际 home 不同自然不共享整轮执行，同一 registry 重建继续使用目录对象。路由、参数及显式环境在异步等待前复制，返回时补完成时间，各实例在完整结果之外补身份。

版本解析与 spawn 使用同一个冻结 cwd/env，关闭二次继承并设置两秒退出宽限。旧部分环境输入继续捕获宿主以保留 PATH/SYSTEMROOT。Driver 明确 `completeEnvironment:true`，使用已清洗的完整受管环境；不能再合入被剥离的宿主供应商变量，防止探针绕回其他账户。禁用/内嵌跳过和 ZCode 前置 bundle 参数保持原行为。

路由读取的预期失败关闭模型路由，但仍如实检查 CLI；取消与缺陷不再被 Driver 外部 `catchCause` 转为初始无路由快照。初始路由读取也只降级预期错误，不吞中断。ZCode 官方凭据读取位于同一个 owner 内；凭据阶段超时时保留已确认 installed/version/models，认证回到 unknown 并显示超时，不能以版本成功代替官方登录验证。创建时托管文件写入、文本通道构造、初始路由/凭据及 managed 前后设置读取是既有生命周期边界，不算进刷新工作预算。

从第57主题 HEAD 导出纯候选，叠加5源。`vp test run --config .candidate-test.config.ts` 指定 `Layers/PifamilyProvider.refresh.test.ts`、`Layers/PifamilyProvider.catalog.test.ts`、`Drivers/PifamilyDrivers.catalog.test.ts`、`Drivers/ZCodeDriver.test.ts`、`pifamily/PiAdapter.test.ts`、`pifamily/OmpAdapter.test.ts`、`zcode/ZCodeAdapter.test.ts`（均在 apps/server/src/provider），7文件61项通过，39.25秒，日志 `catalog-pifamily-native-tests-final.log`。16项新共享刷新覆盖三种 provider 的准备/版本/凭据共15秒、晚加入、首/末取消、输入冻结、实时账户、完整/部分环境边界、强意图/代次和禁用/内嵌跳过。实际 Driver 文件11项通过，含新增的三类路由读取失败仍检查安装、三类路由读取预算以及 ZCode 实际凭据读取预算，共7个新增 Driver 用例；旧三类目录缓存与三个 adapter 回归保持通过。

五源目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json` 退出0、无诊断，`vp fmt --check` 与 `vp lint` 退出0、lint无诊断。实际 Driver 11项最终复验通过，3.95秒，是61项子集。初次三文件矩阵的3个冻结测试失败来自夹具先发准备收据、再读取可变路由；准备快照先取得、再发收据后16项通过，生产逻辑未为此改动。测试类型的只读路由赋值改为可变夹具 `satisfies`，联合 Driver 调用改为具体类型工厂，没有 any 或不安全强转。没有全仓检查。

额外真实 Windows `.cmd → Node` 组合三类各1项，共3项通过，4.45秒，日志 `catalog-pifamily-native-windows-initial.log`。版本阻塞、第6秒晚加入与首等待Scope关闭仍沿用第15秒截止时间，TCP关闭收据确认进程结束，随后目录恢复。共6次假 CLI启动、12个捕获外壳/Node PID 后续核对不存在，三个 scoped 临时目录已删除；ZCode 的 bundle.cjs 前置参数原样传递，只有版本命令，无会话请求。完整共享取消还需区分 Driver/managed 等待者生命周期，Windows 组合是原生入口的等待Scope验收，实际 Driver 边界由上面的测试覆盖。使用本机端口和虚构 CLI，不是云端认证或硬墙钟退出上限验收；既有 Windows shell DEP0190 提示保留，无 sleep/轮询、按名称 kill 或保留目录掩盖清理失败。

旧版公开入口预算对照三类各1项，共3项直接失败：仅在隔离候选恢复第57主题 PifamilyProvider，挂起探针到16秒观察时限仍未完成，`observer reached` 与15000ms消息断言失败。finally 按SHA恢复后同三个用例通过，`catalog-pifamily-native-deadline-proof.json` valid/restored 两轮均 true。主矩阵加 Windows3项和公开预算3项共67个不同用例，诊断及复验不重复计数。

三端既有设置/模型选择、本地/远程/隧道继续使用服务端快照，没有新UI、wire、权限、持久结构或动画。其余provider保持此前增量。本轮没有真实供应商、产品三端或新服务启动，现存服务未加载本主题。回退5源及4文档可恢复第57主题行为，无迁移。原84个无关文件及混合 BYOK/ChatView 改动保留。十二类共享刷新现在均有完整预算和取消资源边界；第11项仍开放跨目录目标取消、Grok显式共享可写home、模型/模式及全部入口/客户端/连接验收，不能据此把第11项或全部39项标为完成。

## 第59主题：BYOK跨目标等待、取消与输入快照

2026-10-13，第58主题提交后继续第11项。用户明确选择“每个实际目录加载共享信号，实例共用15秒等待预算，保留部分重叠目标的在途复用”。该决定澄清取消边界，不缩小原39项及comparison全部清单。现有单目录Scope/controller与引用计数保留，不引入整批独占目录加载。实例预算耗尽只取消自身等待；另一个客户端仍等待同一目录时保留请求，最后等待者离开才取消，跨实例部分重叠目录继续复用。

修复两处输入别名：`ByokCatalog.fetchCatalog` 在第一处异步等待前复制目标、候选地址数组与选项，防止缓存键登记后加载使用编辑过的凭据；`checkByokProviderStatus` 同样冻结适配器列表和候选数组，让后续目标、模型路由和展示使用一轮配置。`checkedAt` 从检查开始改为完成时间。只涉及两个生产文件及一个定向测试文件，不改变schema、会话、权限、余额或持久化结构。原混合ByokProvider的斜杠命令改动从候选与提交中精确排除。

从第58主题HEAD导出纯候选，叠加3源。`vp test run --config .candidate-test.config.ts` 指定 `Layers/ByokProvider.refresh.test.ts`、`Layers/ByokProvider.catalog.test.ts`、`Layers/ByokProvider.test.ts`、`byok/ByokCatalog.signal.test.ts`、`byok/ByokCatalog.test.ts`、`byok/ByokModelDiscoveryService.test.ts`、`byok/byokHttp.test.ts`、`ProviderCatalogCache.test.ts`（均在apps/server/src/provider）：8文件93项通过，6.84秒；日志 `catalog-byok-cross-target-tests-final.log`。其中9项新用例覆盖跨目标15秒、请求与正文取消、短等待者/其他客户端、部分重叠实例、末等待者退出和恢复、配置与键执行冻结、完成时间。既有同键旧值、预算耗尽不启动冷请求、强刷新、草稿入口与凭据隔离测试保持通过。

两个新用例使用本机随机端口的真实Node HTTP服务器、专用HttpClient工厂和实际Fetch。A目录耗时8秒后B正文挂起，剩余7秒到期时：无其他等待者的B收到服务端close收据；有另一个等待者时信号及连接继续有效，实例先返回、另一客户端随后得到完整模型，再释放信号。C冷目录没有收到请求。所有服务器由测试Scope关闭并等待close回执，没有新CLI、后台服务、真实账户、sleep或轮询。测试夹具用Node HTTP观察传输close、注入原生Fetch，因此仅该测试文件按仓库既有格式说明两个Effect诊断例外；生产查询仍走专用HttpClient。

三源目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json` 退出0无诊断，`vp fmt --check` 与 `vp lint` 退出0无诊断。首次类型检查修正了夹具缺少Schema默认字段和只读数组；`.cmd`直接spawnSync的EINVAL改用已安装tsgo Node入口。真实HTTP初次使用已弃用的it.scoped触发Vitest夹具解析错误，改为现有it.effect+Effect.scoped后通过，生产代码未为这些夹具问题修改；没有全仓检查。

有效旧版对照只在隔离候选恢复第58主题两个生产文件：9项中4项直接断言失败、5项通过，失败分别为request/body的完成时间仍是开始时刻、跨目标加载使用编辑后的地址/密钥/请求头、旧键执行编辑后的地址和密钥。Vitest将两个同断言用例合并输出为一个失败块，因此证据以4个失败用例和3个直接AssertionError块共同校验；不把测试导入或包装器失败当红证据。finally按SHA恢复后9项通过，`catalog-byok-cross-target-red-proof.json` valid/restored均true。此复验属于93项子集，不重复计数。

Web/Desktop/Mobile的设置发现与状态快照继续消费同一服务端入口，本地/远程/隧道规则相同；本主题没有UI、wire或动画变更，也未启动新产品客户端或真实供应商调用，保留实际三端/全部入口/连接验收。其他provider保持前主题行为。回退2生产源、1测试及4文档可恢复第58主题，无迁移。原84个无关文件、ChatView及混合BYOK改动继续保护。第11项仍开放Grok显式共享可写home写入顺序、模型/模式与完整入口/三端/连接矩阵，整个39项及comparison其余要求继续执行，未宣告完成。

## 第60主题：Grok共享可写home的目录占用

2026-10-13，第59主题提交后继续第11项。实际Driver原子写入只保护rename，不能保证其后版本/技能/ACP读取仍消费本轮文件；另一个实例的初始化也能在刷新中覆盖或删除managed区域。新增`GrokHomeAccess`，按物理home串行占用，从准备前保持至NativeProviderCatalog owner清理完毕；初始化协调以短Scope使用同一占用。排队计入既有十五秒工作预算，等待可取消，不同home并行；只保留有持有者/等待者的Map记录，最后退出即删除，不建立长寿命实例/账号注册表。

路径采用realPath或最近存在的父目录规范化，CLI的GROK_HOME使用规范路径；Windows大小写和真实junction别名共用占用。代理指向个人目录的物理别名时拒绝写入；非代理个人目录仍只读。初始及刷新捕获同一FileSystem/Path/HostProcessPlatform，防止服务环境变化制造两个锁身份。队列权限在可中断等待成功后、受保护区域内登记Scope finalizer，取消排队不释放持有者，所有者CLI清理回执结束后才交接。

从第59主题HEAD导出纯候选，叠加4源（2生产、2测试）。最终定向矩阵分两组串行运行，均为`vp test run --config .candidate-test.config.ts --testTimeout 8000 --reporter verbose`，路径均在apps/server/src/provider。核心6文件：`GrokHomeAccess.test.ts`、`grokHome.test.ts`、`Drivers/GrokDriver.home.test.ts`、`Drivers/GrokDriver.catalog.test.ts`、`NativeProviderCatalog.test.ts`、`Layers/GrokProvider.refresh.test.ts`，30项通过，8.96秒。既有4文件：`Layers/GrokProvider.catalog.test.ts`、`Layers/GrokProvider.test.ts`、`Drivers/GrokSkills.test.ts`、`byok/modelGateway.test.ts`，77项通过，48.70秒。日志`catalog-grok-home-core-final.log`与`catalog-grok-home-existing-final.log`，两组result的code=0/sourceStable=true。9项新增用例涵盖不同来源配置与各实例模型、代理/非代理初始化干扰、个人目录别名、清理顺序、排队取消、不同home并行、大小写/真实junction、未创建子目录稳定身份及排队预算恢复。

四源目标`tsgo --noEmit -p apps/server/.streaming-typecheck.json`、`vp fmt --check`与`vp lint`退出0无诊断，`catalog-grok-home-checks-source-stability.json` stable=true。初次夹具发现服务未捕获导致初始化与刷新锁身份不一致，修复生产边界后通过；随后夹具先等待自动启动和显式刷新回执再清零本轮计数，避免把启动探针当成多余刷新。节点命名和process.platform两处lint已改为NodeFSP及HostProcessPlatform。没有全仓检查。

验证过程保留两类无效记录：旧版对照误与同一候选回归并行，回归读到旧Driver，该批结果不作为验收（`catalog-grok-home-tests-parallel-invalid.log`）；恢复后完整10文件触发包装器60秒进程超时，未产生通过总结（`catalog-grok-home-tests-wrapper-timeout.log`），其中捕获PID4244/18816随后确认不存在。改为上述捕获子PID、实时输出、无60秒截断的分组串行执行；PID16736/110744正常close退出，两个完整结果通过。最终验收不使用这两批无效运行。

有效旧版对照仅在隔离候选恢复第59主题GrokDriver：4项中3项直接AssertionError失败（个人目录别名错误放行、另一代理初始化覆盖本轮路由、非代理初始化删除本轮路由），1项跨刷新调度用例通过，不把它也说成旧版失败。finally按SHA恢复后4项通过，`catalog-grok-home-red-proof.json` valid/restored均true。该4项是107项子集，不重复计数；旧版对照与最终检查串行，不再共享同时被写入的候选。

额外实际Windows`.cmd→Node`、真实文件与TCP阶段收据1项通过，最终7.89秒，日志`catalog-grok-home-windows-final.log`。真实Driver两来源在同一个home刷新，两次受测CLI配置读取分别包含model-a/model-b，对应各自实例；启动检查先经回执排空。全程6个外壳handle和6个Node PID被捕获，全部handle停止，12个PID的OS存在检查均失败为ESRCH；scoped临时目录确认不存在，资源记录`catalog-grok-home-windows-resources.json` alivePids=[]。只运行版本失败探针以结束检查，不发送会话/prompt或请求真实供应商；只使用自有TCP端口、文件和虚构路由，不按名称kill、sleep或轮询。保留既有Windows shell DEP0190提示。107定向加此1项共108个不同用例，诊断/复验不重复计数。

本主题保护同一服务进程中的配置协调和完整目录消费，不是跨进程文件锁，不约束外部CLI/编辑器和原生会话修改；会话启动/续接、文本生成在共享home中的消费边界仍开放。Web/Desktop/Mobile沿用服务端目录快照，本地/远程/隧道规则一致，无新UI、wire、权限、动画或持久化迁移；未新测产品三端或真实账号，现存服务未加载本主题。回退2生产、2测试及4文档可恢复第59主题。原84个无关文件、BYOK与ChatView混合hunk继续保护。第11项的共享home会话边界、模型/模式与完整入口/三端/连接，以及原39项与comparison全部其他要求继续执行，未宣告整体完成。

## 第61主题：Grok共享home配置所有权与会话消费

2026-10-13，第60主题后继续第11项。检索词为“Grok config.toml GROK_HOME”“Grok CLI配置重载”，采用官方[配置说明](https://docs.x.ai/build/settings)及公开仓库固定提交`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`的[ConfigReloader](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/config/reloader.rs)。其模型表变更会产生ModelsChanged，不可将initialize返回当作永久配置冻结证据；官方源码比第三方摘要直接，固定提交比浮动main可复核。参考文件只存在外部临时目录，不复制源码、不引入未证明的配置覆盖参数。用户明确选择“拒绝冲突并提示使用独立home；等价配置仍可共享”，完整39项和comparison范围不变。

`GrokHomeAccess.claimGrokHomeConfiguration`在实例Scope内登记规范化物理home的文件配置身份；代理模式比较来源和本地网关，非代理模式忽略未使用字段。`GrokDriver`在配置写入、令牌创建和CLI启动前取得所有权，不兼容配置返回带独立GROK_HOME处理建议的Driver错误；等价配置按引用计数共享，最后实例关闭或失败子Scope清理后释放。显示名、颜色、启用状态与自定义模型不影响该文件身份。配置所有权不持有长期排他信号量，第60主题的短目录占用仍负责每次写入到消费清理的一致性。

第60主题曾允许不同路由串行改写共享home的三个Driver用例，按用户本轮选择更新为拒绝初始化的断言；保留等价共享、目录串行、Scope清理、预算与物理别名测试，不能继续把历史“不同来源可串行初始化”当作当前行为。真实注册表将冲突实例放入unavailable并公开原因；移除原实例后reconcile重新创建此前失败实例，验证反向恢复。会话结束或客户端窗口关闭不等于实例Scope关闭。

纯候选来自第60主题HEAD，只叠加4源（2生产、2测试）。最终`vp test run --config .candidate-test.config.ts`串行两组：核心8文件位于apps/server/src/provider，`GrokHomeAccess.test.ts`、`grokHome.test.ts`、`Drivers/GrokDriver.home.test.ts`、`Drivers/GrokDriver.catalog.test.ts`、`NativeProviderCatalog.test.ts`、`Layers/GrokProvider.refresh.test.ts`、`Layers/ProviderInstanceRegistryLive.test.ts`、`Layers/ProviderInstanceRegistryHydration.test.ts`，52项通过，16.51秒；运行组为provider下`Layers/GrokAdapter.test.ts`、`acp/GrokAcpSupport.test.ts`及`apps/server/src/textGeneration/GrokTextGeneration.test.ts`，71项通过，102.71秒。共11文件123项，日志`catalog-grok-home-configuration-core-final.log`与`catalog-grok-home-configuration-runtime-final.log`，两个捕获测试子进程正常close，源码前后stable=true；单项超时分别8/10秒，没有包装器总时长截断或全仓检查。

四源目标类型/fmt通过后，测试Schema.is谓词提升到模块级以消除一处lint提示，只复验该helper文件10项（2.45秒，123项子集）和四源目标`tsgo --noEmit -p apps/server/.streaming-typecheck.json`、`vp fmt --check`、`vp lint`，均退出0无诊断，最终sourceStable=true。初次类型检查的exactOptionalPropertyTypes显式undefined和Effect JSON诊断，分别按既有输入边界补齐undefined类型及使用结构字段比较修复；不靠诊断关闭掩盖生产类型问题。

有效旧版对照严格串行：只在隔离候选恢复第60主题GrokDriver，选择实际注册表用例，旧版错误放行a/b两实例，`['a','b']`不等于`['a']`直接AssertionError失败，退出1；finally按SHA恢复后同用例通过，`catalog-grok-home-configuration-red-proof.json` valid/restored/directAssertion均true。没有用缺少新API、导入错误或观察超时作为红证据；该复验属于123项子集。

额外真实Windows`.cmd→Node`、真实文件、ACP编解码与TCP收据的多入口组合1项通过，12.50秒，日志`catalog-grok-home-configuration-windows-final.log`。等价来源的两个Driver并行建立会话，两个ACP handle仍在运行时目录刷新完成；随后新进程经session/load续接，标题生成经session/new及session/prompt返回结构结果。13次ACP请求的配置消费均保留model-a，不出现model-b；来源冲突尝试未新增CLI，关闭首实例后另一等价实例仍阻止接管，最后实例关闭后model-b来源成功接管。此为假ACP与虚构路由，不是实际Grok云端认证或生成。

资源记录`catalog-grok-home-configuration-windows-resources.json`包含9个Node PID及13个handle PID（含外壳与taskkill清理进程），所有handle终结，22个捕获PID逐个OS核对为ESRCH，scoped目录确认不存在。Scope关闭造成的4个TCP ECONNRESET在夹具中显式计为取消回执，其他错误继续失败；最终没有未处理错误。首轮嵌套模板夹具语法错误改为独立UTF8脚本生成，之后虽业务断言通过但4个未处理ECONNRESET使Vitest退出1，未计为通过；修复夹具取消观察后以完整退出0为验收。保留既有Windows shell DEP0190提示，没有sleep/轮询、按名称kill或保留目录掩盖泄漏。123主矩阵加Windows1共124个不同用例，复验不重复计数。

用户可见变化写回model-catalog-refresh说明，架构与comparison状态同步。Web/Desktop/Mobile消费同一服务端unavailable原因及目录快照，本地/远程/隧道规则一致，无新UI、wire、权限或持久结构；本轮未新启动产品三端或真实账号，现存服务未加载本主题。其他provider行为保留，全部入口/三端/连接及模型/模式验收继续。配置所有权仅约束同一服务进程的Code Work实例，不是跨进程文件锁，不隔离共享原生账号/会话文件或外部编辑器修改；等价共享的真实供应商行为仍需按适用范围验证。回退2生产、2测试及4文档可恢复第60主题，无数据迁移。原84个无关文件、BYOK与ChatView hunk保持保护；第11项及整体39项仍在进行中。

## 62. BYOK 本地技能与模型共用完整刷新预算

入口核对发现，BYOK Driver 在模型检查完成后另做无预算的技能扫描，初始快照也等待同一扫描。因此第59主题的实际 HTTP 目录预算仍有效，但不能据此证明 BYOK 的整个实例刷新和初始化有界。本主题新增 `ByokProviderCatalog.ts`，由 `fetchByokProviderCatalog` 并行读取模型与用户/服务器 cwd 技能，复用 registry 的 NativeProviderCatalog 在途所有者和十五秒预算。初始化只发布已有配置快照，后台异步补技能；不创建 provider session，不启动 CLI 或调用推理接口。

完整检查身份只包含影响模型快照的启用、adapter标识/展示/模型/实际目录身份以及技能 cwd，实例名称、颜色、余额凭据和执行参数不参与共享。配置和候选数组在异步等待前复制；等价检查晚加入不延长原预算。顺序刷新重新扫描技能，不把技能文件长期缓存。HTTP 请求仍由各 ByokCatalog 实际加载拥有共享信号；整轮取消只释放自己的等待，不能把外层 controller 覆盖到 HTTP 传输而破坏部分重叠目标复用。

汇总增加可选内部 `onModels` 完成回执，逐目录保留已完成结果，既有调用签名保持兼容；回执只更新完整检查内部草稿，不新增客户端半轮发布。新增边界测试先直接失败：前目录完成、后目录挂起，整轮预算抢先取消后汇总丢失 `first/finished`；实际 `['first','second']` 不等于包含该模型的期望。修复完成回执后通过。超时保留配置模型、已发现模型及已完成技能，说明超时；返回时写本调用者完成时间，取消/失败/恢复和实例关闭分别验证。

最终纯候选由第61主题 HEAD 构建，只叠加6源（3生产、3测试），移除原 BYOK 混合 hunk 后验收。`vp test run --config .candidate-test.config.ts` 分两组：核心8文件为 `provider/ByokProviderCatalog.test.ts`、`provider/Drivers/ByokDriver.catalog.test.ts`、`provider/Layers/ByokProvider.catalog.test.ts`、`provider/Layers/ByokProvider.refresh.test.ts`、`provider/NativeProviderCatalog.test.ts`、`provider/byok/ByokCatalog.test.ts`、`provider/byok/ByokModelDiscoveryService.deadline.test.ts`、`provider/makeManagedServerProvider.test.ts`，70项通过，10.27秒；运行3文件为 `provider/Layers/ByokAdapter.test.ts`、`provider/Layers/ByokProvider.test.ts`、`provider/Layers/ProviderInstanceRegistryLive.test.ts`，28项通过，11.38秒。上述路径位于 apps/server/src。合计11文件98个不同用例，其中本主题新增13项；复验和旧版对照不重复计数。日志 `catalog-byok-skills-core.log` 与 `catalog-byok-skills-runtime.log`，捕获子进程均正常 close，源码前后 stable=true。

新增两项真实本机 HTTP 用例将第59主题的 TCP/Fetch 夹具扩展到完整模型技能入口：第一目标在第8秒完成，第二目标正文挂起；第15秒返回已完成模型，不启动冷目标。没有其他等待者时观察正文连接 close 与 signal abort；仍有等待者时保持连接/信号，其他调用者获得结果后才关闭。读取使用虚构凭据、loopback临时端口，所有资源由 Scope 释放；文件系统测试显式 mock 技能读取，不写真实技能或账号目录。Driver 用例断言初始化返回、空会话列表、独立身份、下一轮技能变化和实例 Scope 关闭等待挂起读取终结。

六源目标 `tsgo --noEmit -p apps/server/.streaming-typecheck.json`、`vp fmt --check`、`vp lint` 均退出0；类型检查仅保留既有 ByokAdapter 中两处 Effect.void 风格 suggestion，没有 owned 源错误或 lint 警告。首轮测试夹具错误引用不存在的 Path.posix，导致8项失败与目标类型错误；改为既有 Path.layer 后通过，没有把该失败计为验收。之后多目标部分结果的直接失败促成回执修复；最终源码和目标检查一致。

有效旧版对照在所有检查停止后串行执行，仅恢复候选内第61主题 ByokDriver，选择“技能目录挂起仍发布初始配置”实际 Driver 用例。旧 Driver 的 created=false 与期望 true 直接 AssertionError 失败，退出1；不是导入错误或超时。finally按 SHA 恢复后相同用例通过，`catalog-byok-skills-red-proof.json` 的 oldExit=1、newExit=0、restored/directAssertion/valid 均符合预期。旧版重复扫描和未受限初始化没有通过新增入口测试。

用户说明、providers架构和 comparison 状态同步；Web/Desktop/Mobile既有设置刷新、模型选择和技能菜单使用同一服务端快照，本地/远程/隧道走相同规则。没有新增UI、wire、权限、持久结构、动画或快捷键；聊天回合按线程 cwd 加载技能正文的运行入口保留，不能用目录菜单证明执行已验收。其余十一类driver保持既有实现。未新启动三端产品或真实供应商，现存保留服务未加载本主题；模型/模式及完整入口/三端/连接矩阵仍开放。回退3生产、3测试和4文档恢复第61主题，无数据迁移。精确暂存仅本主题，原84个无关文件和 BYOK/ChatView 混合 hunk保持保护。第11项和完整39项及comparison额外范围继续进行。

## 63. 当前实例与原生模式控制一致性

Web 旧入口按 driver 查默认实例，可能借用另一配置的两态声明；Mobile 没有按同一规则撤回斜杠菜单。共享 `canUseProviderInteractionModes` 改为精确 instanceId 和所选模型的能力，原生 ACP `acpMode`、OpenCode `agent` 选择器出现时撤回旧两态控件。Web Add 菜单、斜杠、Shift+Tab 与 Mobile 斜杠共用判断；不支持时删除 Plan 行，避免错误提示用户开启设置。发送、编辑重发、计划续接和原生 outbox 统一清除明确不支持实例的旧 plan；没有离线能力证据时保留用户草稿。没有新增服务端字段或持久化结构。

十二类 Adapter 决定：Codex 与 Claude 保留已绑定的两态运行参数；Cursor、Grok、Kimi、通用 ACP 保留真实会话提供的模式/配置回执和既有别名绑定，不为草稿建 session；OpenCode 保留目录发现的原生 agent 控件；BYOK 无两态能力；Antigravity、Pi、OhMyPi 的实际发送没有绑定 interactionMode，明确声明 false；ZCode 保留实际 `--mode plan` 绑定。模式回执继续在线程内合并。Codex `collaborationMode/list` 尚未接入统一目录，Claude远程发现另归第29项，不能将剩余目录范围标为完成。

纯候选从 `6ff621631` 构建，只覆盖本主题14源，剥离 ChatView 原4组和 ChatComposer 原2组混合改动。九个文件84项通过：共享 providerModels、Web providerModels/modelSelection、Mobile modelOptions/providerOptions、Web composerProviderState/ComposerAddMenu 共66项；PifamilyProvider.catalog/AntigravityProvider.refresh 共18项。client-runtime、Web、Mobile、Server 四个目标 tsgo，14源 fmt/lint 均通过，检查前后哈希稳定。新增10个客户端断言并扩展初始、健康、超时、恢复的声明断言。旧 Web helper 同一原生模式用例直接得到 true、期望 false，旧版退出1；恢复候选后退出0，源码哈希恢复。首次 alias 与类型诊断、原生失败 bundle 均不计通过。

实际 Web 在独立 userdata 中选择支持两态的实例并启用 Plan，再切换 BYOK。最终 Add 菜单没有 Plan 行；发送“验证当前实例模式控制。”经真实本机 HTTP/SSE 返回“本机模式验收完成。”，只读 SQLite 确认 byok-fixture/fixture-model 与 interaction_mode=default。最终 DOM、菜单截图和请求记录留在工作区外。测试 API 仅用合成凭据及受控文本，未调用外部模型供应商或操作真实账号。

实际 Android 复用兼容开发客户端，14源与测试候选字节一致。最初生产 bundle 关闭开发配对入口，随后仅重启捕获的本主题 Metro，最终 dev=true/minify=true bundle 返回200（31,395,316字节，SHA-256 `766e82284dbe23d62904c212cad495dc01c453b01ebd0aad7944b9431e92f235`）。客户端就绪后用新凭据连接 `10.0.2.2:13774`，实际显示 server 项目与指定线程；斜杠菜单保留 /model、不显示 /plan 或 /default。发送 native-mode-test 后出现新用户行和第二条完整回复，队列完成；同一 SQLite 仍为 default。SDK即时层级与截图保存于工作区外，配对凭据不进入证据或提交。

Web/Desktop 共用 React 控件，Mobile 使用同一共享判定和原生入口；本轮实际运行 Web 和 Android，没有新开 Electron、iOS设备或公网 relay/tunnel。设置页保留原生模型选项，ThreadSettingsSheet 没有独立两态入口；运行权限独立不变。实例切换、能力撤回、原生选项、离线未知与重新选择支持实例的反向路径由定向断言覆盖。未增加持续动画或全局订阅，未新测帧率；既有性能证据保持原边界。完整能力声明第14项、Codex模式发现及全部入口/客户端/连接验收继续开放。

官方协议采用理由与检索日期见 providers 的“当前实例的模式入口”。回退本主题14源及4文档恢复此前行为，无数据迁移。精确暂存继续保护原 BYOK、ChatView 与 ChatComposer 混合 hunk，83个剩余无关基线文件保持原哈希。第11/14项保持进行中，完整39项及comparison额外范围不缩减。

## 64. Codex 原生模式与统一目录、发送及计划续接

此前 Codex 完整入口仅发现模型和技能，模式控件仍静态声明两态。本主题用现有 raw RPC 能力在 `fetchCodexCatalog` 中并行增加 `collaborationMode/list`，与分页模型、技能共用初始化后的无会话 client、缓存身份和整次十秒刷新所有者。没有额外认证、线程、会话或推理请求，没有新 controller、单请求 deadline 或外部探测入口。查询键同时标识三种发现，实际加载仍采用调用者快照和现有上下文。

模式按官方响应自主解码为 `codexCollaborationMode` 模型选项：保留名称、default/plan 标识和预设模型/推理说明，过滤未知/空/重复项，只有一个广告就只展示一个，不补造另一模式。default 广告存在时优先；否则采用首个可执行广告。用户选择的模型和推理不被预设元数据覆盖。方法不支持时提示更新 CLI，其他 RPC 或数据错误提示刷新；成功模型和技能保留、模式控件撤回。内部目录增加可选 catalogMessage，带告警的结果不进入完成缓存，同版本下一次刷新可恢复；其余 CLI 无该字段时沿用完成缓存规则。挂起的模式请求仍受原生总预算与 Scope 取消控制。

Codex 两态控件撤回，三端复用现有通用选项消费。普通发送、编辑重发和 Mobile outbox 从广告与有效选择同步规范 interactionMode；Adapter 只读取绑定实例的 native 选项并传给既有 turn/start 协作模式，旧两态字段继续兼容，运行权限和审批不变。Web 原线程续接和新线程实施明确设置广告的 default，原线程同步更新草稿；缺少请求模式时明确拒绝，模式撤回时清除旧选项。没有新增 wire 字段、权限、动画、全局订阅或持久化迁移。

纯候选以 `f11f2253c` 为基线，只覆盖17源（9生产、8测试），继续剥离 ChatView 原4组混合改动。十一文件159项通过：CodexCollaborationModes、CodexProvider、CodexProvider.catalog/refresh、CodexAdapter、CodexSessionRuntime、codexModelOptions、CliProviderCatalog、client-runtime/providerModels、Web composerProviderState、Mobile providerOptions。新增13项断言覆盖广告元数据、单项/空/未知/畸形/错误响应、缓存复用/恢复、模式挂起整轮截止、绑定实例与有效选项、规范模式和实施反向路径。contracts、client-runtime、Server、Web、Mobile 五个目标 tsgo 通过，17源 fmt/lint 通过，全部检查前后哈希稳定。两处 no-unsafe-optional-chaining 警告在旧 CodexAdapter.test 中同样出现，独立 HEAD lint 退出0、同为两条并按哈希恢复；本主题没有新增这两处语句。

首轮136项通过、1项失败，定位为临时脚本误将可选模式方法加入“模型/技能失败必须整轮失败”的断言；目录告警的内部类型缺失和纯候选 Web Node 类型配置一并修正。随后的148项及最终159项均通过，失败结果不改写为通过。旧 CodexProvider 恢复到同一候选、运行“模式与分页模型和技能共用入口”用例，因模式 descriptor 为 undefined 直接 AssertionError、退出1；恢复17源候选后同例退出0，文件SHA一致。

实际 Windows 协议验收使用工作区外合成账户和受控 `.cmd`/Node fixture，由真实平台 spawner 启动。请求严格为 initialize、initialized、account/read、skills/list、model/list、collaborationMode/list，响应为 ready，返回两项真实 fixture 广告，旧两态声明 false；没有会话调用。worker 捕获 PID80860，Scope 关闭后 PID 已停止，追加的一项真实进程测试通过。临时验证入口最初放在候选根而无法解析平台依赖，迁至 server 依赖边界后通过；未修改依赖或产品源码。该证据是本机进程/RPC联调，不是官方 Codex 账户或外部推理验证。

原始证据为工作区外 `catalog-codex-modes-{core,typecheck-*,format,lint,old-red,restored-green}.log`、red-proof、Windows fixture/result.json 与请求记录。官方原始来源、检索词、2026-10-14访问日期及采用理由写入 providers。未复制参考代码。第63主题实际 Web/Android证据不用于证明本主题新控件已实测；保留服务未加载本候选，本轮没有新产品客户端、Electron、iOS、外部供应商或公网 relay/tunnel运行。共享渲染器、通用选项及发送有定向覆盖，设置/聊天/命令/快捷键、全部实例/客户端/连接的最终矩阵仍开放。其他十一类 driver 沿用此前实现；第14项的完整能力分拆继续实施。回退17源及4文档恢复第63主题，无迁移。原83个无关基线文件、BYOK/ChatView/ChatComposer混合hunk继续保护，只提交本主题。第11项及完整39项与comparison额外范围保持进行中。

## 65. Codex 实际 Web 模式与计划实施入口

核对当前 `c58dd9c5e` 与保留服务实际进程后，复用独立 home、端口13774/5734和已配对浏览器。第64主题17源按SHA同步至隔离候选，使用正式供应商设置保存受控 `.cmd` 程序、独立 Codex home 后启用；未改 live userdata，未用SQL写入业务状态，未读取真实账号。连续编辑时 home 未保留的现象已记录，单独保存并核对后才启用；设置保存问题留待下一主题定位，不计为已修复。

实际设置页发现受控模型，草稿模型菜单展示原生 default/plan 名称及预设说明；选择 Plan 后摘要为“Medium · 原生计划”，预设 high 没有覆盖已选 medium。草稿发送前12条请求仅为 initialize/initialized/account/read/skills/list/model/list/collaborationMode/list，thread/turn调用为0。选择受监督权限后，实际 turn/start为plan、approvalPolicy=untrusted、sandboxPolicy=readOnly；SQLite 同步 interaction_mode=plan 与原生选项plan。

最初 fixture 的 item 生命周期通知缺少必填 startedAtMs/completedAtMs，助手文字已显示但没有计划卡片；该失败不计为计划完成证据。修正 fixture 并通过实例停用释放实际 PID71016，再启用后恢复会话，合规计划通知形成真实持久化计划和可操作卡片。另补 fixture 的 exec 标题读取，避免将 CLI 文本输入误当JSON。均为工作区外测试实现修正，没有调整产品协议来适配错误fixture。

原线程点击“实现”，同一真实进程收到default；SQLite同时保存default选项、default规范模式和approval-required。随后重新选择Plan，下一回合RPC与持久化均为plan、生成第二张计划卡片，但计划就绪入口未显示。真实问题是ChatView只读取旧两态draft=default，未读取当前模型选项。修复只增加当前草稿 modelSelectionByProvider 的细粒度订阅，复用 resolveProviderInteractionMode 派生界面模式；不订阅提示词、不新增effect或回写链。既有流式列表、缓存和协议不改。

前后验证使用同一线程、同一计划与同一持久化数据：旧界面模式摘要为原生Plan、卡片存在、expectedPlanReady=true而actual=false；加载已测试单源候选后就绪入口立即出现。点击“在新的线程中实现”，新线程 `5cfc4134-634b-44de-8a29-dc449a29e5ef` 的实际RPC、规范模式和原生选项全部default，仍是untrusted/readOnly与approval-required，页面显示完整默认模式回复。原线程 `d953cce2-9925-4734-abdf-116666bf6700` 保留自身plan状态，两份有效计划保留；完成的旧回复和计划历史可查看。总请求中的首个不合规fixture回合与后续有效回合分别记录，不把最初计划缺失改写为通过。

纯候选从第64主题提交构建，仅1生产源并剥离原ChatView四组hunk。client-runtime/providerModels、Web composerProviderState、composerDraftStore三个文件107项回归通过，Web目标tsgo、单源fmt/lint通过，检查前后SHA稳定。没有为纯状态派生新增镜像测试；实际红绿界面、模型菜单/实施操作、RPC与只读SQLite构成行为证据。原始材料为工作区外 catalog-codex-mode-ui-{core,typecheck-web,format,lint}.log、loaded-source/runtime-proof.json，以及可视化目录中的 codex-native-{mode-menu,plan-ready,implemented,ui-old-no-ready,ui-fixed-ready,new-thread-implemented}.png 和前后DOM证明。

本主题适用于Web及Desktop共用ChatView、现有聊天/模型菜单/计划操作入口；Mobile保留第64主题发送绑定和自身界面，本轮没有新原生客户端运行。旧两态快捷键和斜杠菜单按第63/64主题能力决定，不新增第二套模式探测。模式刷新及本地/远程/隧道仍取同一服务端快照，本轮实际网络为本机配对连接，不宣称公网relay/tunnel、外部Codex或真实订阅账号通过。没有新帧率测量或Electron窗口证据。单源修复与4文档可独立回退，无迁移；精确暂存继续保护83个无关基线文件及BYOK/ChatView/ChatComposer混合改动。保留隔离服务和测试状态供后续完整矩阵使用。第11项、完整能力第14项及全部39项/comparison范围保持进行中。

## 66. 供应商设置连续保存保留编辑意图

第65主题记录的设置丢失已定位：DraftInput 和实例卡片从旧渲染快照构造完整实例，ProviderSettingsPanel 将它与旧 settings 合成完整 providerInstances 映射；服务端明确替换该映射。因此仅由服务端串行写入不能避免后一次名称保存覆盖先前 home 或程序路径。沿用现有 updateSettings 成功回执，不改变 wire 或服务端替换规则。

新增 providerInstanceEdits 小模块，队列只保存 providers/providerInstances 快照。卡片更新串行发送，相对原卡片只重放用户实际改变的字段，采用最新成功回执构造下一映射；对象递归，数组/标量/null和删除键仍替换，未改字段保留最新值。已收到的其他客户端推送在等待中按变化合入，避免较早推送撤销较晚回执；失败不推进、不重试，后续独立编辑仍运行。队列与回调捕获所选环境，不把旧环境的等待编辑送到新环境。添加/删除/重置入口保持原行为，跨客户端未收到推送的同时保存不由本主题宣称完全解决。

纯候选从第65主题 0648bd1ad 构建，仅2生产源、2测试源。执行 `vp test run --config .candidate-test.config.ts` 的 ProviderSettingsPanel.environment、ProviderSettingsPanel.logic、ProviderSettingsForm、providerInstanceEdits、SettingsPanels.logic 五文件，68项通过；Web目标tsgo、4源fmt/lint通过，检查前后SHA稳定。新增5项行为断言覆盖连续三项意图、选定环境、等待中推送、失败不重试及替换/删除语义。首次脚本误用 Form 的 .tsx 扩展只运行53项；修正为实际 .ts 后完成68项。沙箱写工作区外既有隔离目录被拒，使用已授权隔离范围的受审提升完成；失败不计通过。

在所有检查停止后，仅将候选 Panel 恢复为第65主题版本，运行同一“连续home、程序与名称保存”入口测试。旧版收到3次即时写入、期望按队列仅1次，直接 AssertionError、退出1；finally恢复SHA一致，再运行同例退出0。没有以导入错误、等待超时或人为throw充当失败证据。

实际保留 Web 页面在旧源码下连续修改 home、程序路径和名称，最终名称与 home 保留但程序路径回到旧 codex-fixture.cmd，独立 userdata/settings.json 与页面一致。加载经测试且SHA一致的 helper和Panel后，用同样连续失焦步骤改为测试 home、codex-fixture-alt.cmd及“Codex 连续保存修复”，页面与只读设置文件三项均保留；点击状态刷新从新路径获得受控模型/模式目录，重开页面三项仍在。只使用工作区外合成账号、受控 .cmd/Node与既有配对测试环境，无真实凭据或外部推理。截图显示的订阅标签是fixture响应，不能视为真实订阅验收。

原始证据为工作区外 catalog-provider-edit-intent-{core,typecheck-web,format,lint,old,green}.log、old-proof、ui-{old,fixed,source}.json及可视化目录 provider-edit-{old,fixed}.png。Web/Desktop共用设置卡片适用十二类driver，聊天模式菜单/快捷键/斜杠不增加入口；Mobile独立设置未改变，本轮没有Electron、Android、iOS或公网relay/tunnel实际运行。既有本地/远程/隧道设置RPC规则不变，没有动画、全局订阅、新会话、额外刷新或数据迁移；未重新测帧率。回退2生产、2测试及4文档恢复第65主题。精确提交继续保护83个无关基线文件及BYOK/ChatView/ChatComposer混合hunk。第11项、完整能力第14项和全部39项/comparison继续进行，剩余客户端/入口/连接矩阵保留。

## 67. Android 原生目录选项与实际发送绑定

第66主题独立提交 a6a406173 后，继续第11项实际客户端验收。第63主题 Metro 已按记录停止且测试连接已移除；复用隔离 emulator-5562 及兼容 com.codework.mobile.dev，不重建原生应用。将共享 providerModels、contracts/model、Mobile use-thread-composer-state 三个第64主题相关源按当前提交原始字节同步至既有原生纯候选，三个SHA均相同。app.config与package.json仍与既有原生客户端构建范围一致，没有原生依赖/配置变更。Metro捕获PID1776，端口8088；Android dev=true/minify=true包返回200，31,397,414字节，SHA-256 `7228e40b784811714355b6cd1a596053904e5aeaf146bf501604cef716ca9784`。没有将旧包或仅启动进程当成加载成功。

用新的一次性凭据经既有开发路由连接10.0.2.2:13774，实际列表出现指定server项目及第65主题受控Codex线程。原生线程模型设置读取“Codex 连续保存修复”的模型广告，提供Reasoning Medium和原生默认/原生计划选项，运行时为受监督。先从Plan选择default，实际发送codex-native-default-67，再选择Plan发送codex-native-plan-67。真实Windows worker PID29268分别收到 turn/start mode=default/plan，两次都是模型fixture-codex-model、approvalPolicy=untrusted、sandboxPolicy=readOnly。原生界面完整显示两次回复，Medium仍保留，没有被预设high覆盖。

只读SQLite在第一次完成后保存default选项/default规范模式/approval-required，第二次完成后保存plan选项/plan规范模式/approval-required；四条新增用户/助手消息均is_streaming=0，与实际两次RPC一致，原线程新计划持久化后共有三份有效计划。截图与数据库只能证明原生选项和发送绑定；本主题没有验收Mobile计划卡片及实施入口，不能借用Web实施证据替代。没有新增产品源码或再次运行未改变源码的同一单测；第64主题159项、五目标类型及本主题实际运行证据各保持自身范围。

即时SDK读取在部分路由切换帧返回空前台包，未保存或复用旧层级；语义点击没有触发导航时，按即时截图/层级定位行坐标。开发Tools浮标遮挡右上“完成”，误打开开发菜单后关闭，改用左侧返回；不计为产品操作成功。随后改用静态界面等待空闲的uiautomator dump，每份XML由本次回执确认，计划选项与最终消息截图通过。未用隐藏RPC或SQL改写业务状态来替代UI。

完成后通过客户端正常移除仅10.0.2.2:13774连接，保留原有13773/13811连接；移除本次adb reverse8088并停止捕获Metro1776，模拟器与Web/backend继续保留供全目标验收。实际回执确认原有两个连接仍在，服务端线程与计划数据保留。原始材料为工作区外catalog-codex-native-mobile-{source,mobile-bundle-result,default-state,runtime-proof,cleanup-proof}.json、即时层级/静态XML与PNG；可视化目录android-codex-native-{plan-settings,default-completed,plan-completed}.png可查看。

本主题只更新验收记录，Android为真实本机客户端、Windows为真实受控进程，供应商/账户/推理仍是合成fixture，不是外部Codex账号或网络服务验收。没有新Electron、iOS、公网relay/tunnel、帧率或其他十一类provider实测；其既有决定不变。目录广告仍来自第64主题统一无会话入口，Mobile使用第64主题规范发送及自己的模型设置入口，不引入新探测。第11项完整入口/客户端/连接矩阵、第14项完整能力及全部39项/comparison额外范围继续开放。三份文档可独立回退，没有产品行为或数据迁移；原83个无关基线与原有混合hunk继续保护。

## 68. 当前十二类目录合同与联合回归

上一轮第66/67主题两次提交及Android实际发送属于有效进展。本轮核对HEAD为5fe0fe34f，原92项未提交状态仍在；捕获的Web dev runner156576及fixture124388实际存活，继续保留独立13774/5734测试环境。当前Desktop源码自既有桌面验收基线1b76a57c1至HEAD没有变更；既有Electron148676实际存活，其登记的启动配置指向旧生产渲染，仅凭进程存活不能宣称当前原生模式通过。CUA当前禁用Windows原生控制且没有Electron控制表面，本轮未执行替代UI自动化或修改其窗口；Electron实际模式验收继续开放。

为了核对当前累计目录改动与客户端消费，构建catalog-client-matrix-candidate纯副本：暂存区为空时用checkout-index导出当前提交，不复制主工作区未提交内容，不使用live userdata。临时内联脚本首次解析错误，没有运行检查；改为工作区外保存脚本后成功。153个工作区依赖别名按最长键优先，测试入口固定到副本源码；只运行provider目录/刷新相关35个测试及共享/Mobile模型选项、Web设置入口/helper共5个文件，未运行全仓测试或检查。

命令为 `vp test run --config .candidate-test.config.ts <catalog-client-matrix-tests.json中的40文件> --testTimeout 10000`，40文件361项全部通过，耗时38.71秒，退出0；363个相关provider/contract/客户端源检查前后SHA一致。原始命令列表、输出和code/pid/stable回执分别为工作区外catalog-client-matrix-{tests,check-files}.json、core.log及core-result.json，捕获测试PID139460已退出。Node提示测试中的shell参数弃用告警，未把告警隐去或将其当成新的产品缺陷；本主题没有产品源码变更，之前各主题的目标类型/lint结果仍按原范围保留，不宣称本轮重跑。

源码和定向用例核对十二类driver实际预算：Codex10秒、Claude30秒、Cursor/Grok/Kimi/Antigravity/OpenCode/Pi/OhMyPi/ZCode15秒、通用ACP8秒，BYOK实例与每个实际HTTP目录15秒且部分重叠目标仍共享。版本/准备/目录/技能各阶段消耗剩余预算，等价实例晚加入不续时；实际共享owner拥有取消信号。强/普通刷新、账号正反变化、输入冻结、缓存只作索引、等待者取消与无草稿会话的联合回归通过。具体十二行合同及对应测试入口写入providers，不能将静态声明误当原生目录广告：Codex和OpenCode由目录发现，ACP仅提供实际会话广告，Claude/ZCode保留真实运行绑定，BYOK/Antigravity/Pi/OhMyPi明确撤回未绑定的两态控制。

本轮仅完善三份架构/验收文档，无新UI、协议、权限、缓存或会话实现；没有新三端产品、Windows CLI、外部供应商、iOS或公网relay/tunnel实际运行，也没有重新测帧率。Web/Desktop共用客户端控制，Mobile消费同一服务端快照；设置/聊天/命令/快捷键、本地/远程/隧道与反向状态的完整最终矩阵仍需逐项证明。第11项及第14项、完整39项/comparison额外范围继续进行。三文档可独立回退，无迁移；精确提交继续保护83个无关基线文件与原BYOK/ChatView/ChatComposer混合hunk。

## 69. 手机持久化队列采用实际发送时的模式目录

第68主题是有效进展。本轮基线bcac422c4，继续第11项的模式撤回边界；Electron替代自动化授权尚待答复，没有操作其窗口。源码确认Mobile只在入队时清理目录选项，outbox已有线程和新任务派发直接使用旧持久化设置。等待/离线期间目录变化会保留旧Plan，不能用菜单清理证明真正发送已一致。

三生产源修改：thread-outbox-model在第三个可选目录输入中复用共享会话目录和模型选项归一化，同步规范模式；不改原消息、权限或旧两参数/V1继承行为，未知/离线仍保留意图。Codex旧模型未广告模式也清除原生模式，不借用其他实例。两个drain入口在确认持久化后读取所属环境当前配置，并在读取后复核编辑状态；新增共享客户端readConfig包装复用既有server.getConfig和按环境singleFlight。服务端只读取已发布provider投影，没有新增目录入口、wire字段、权限或草稿session。

首版仅读取configValueAtom，五文件52项及Mobile类型/fmt/lint通过，但实际离线探针仍发送Plan，没有据此验收。配置流在恢复前后允许缓存值，不能保证已收到本轮快照；最终改为显式当前RPC。最终六文件71项通过：thread-outbox、drain派发入口、modelOptions、providerOptions、共享providerModels、共享state/server。新增9项断言覆盖撤回/恢复、推理与权限、实例/旧模型、ACP原始URI、离线/V1、持久化确认后的所属环境、新任务/已有线程、配置失败不删消息与读取期间进入编辑。Mobile和client-runtime目标tsgo、五源fmt/lint通过，检查前后SHA稳定。工作区外脚本首次多余括号导致解析失败，修正并先做node --check后运行；不计解析失败为测试通过。

在检查停止后恢复候选两处Mobile生产源到旧HEAD，同一3个用例直接AssertionError，旧规范模式为plan、派发参数仍plan；退出1。finally恢复源码SHA一致，最终版相同3例退出0，final-red-proof中的oldExit=1/newExit=0/restored/directAssertion均符合预期。不是导入错误或超时对照。

实际复用隔离emulator-5562与兼容开发客户端。三处最终生产源按测试候选SHA加载，未原生重建；仅重启捕获的本主题Metro。首次取包时端口尚未就绪，确认同一PID46604仍存活后继续读取，没有因观察失败再次重启。最终Android dev=true/minify=true包返回200，31,401,595字节，SHA-256 `f26a731312af0312d6f03e3e2898bcea60900e10feca931748b0cf1524c70271`，并通过开发菜单正式Reload确认重载，不能仅据同URL启动或HTTP取包宣称应用已加载。

两轮忙碌探针在目录撤回前已进入RPC，未形成所需等待证据，不计为目录恢复派发通过；受控等待已释放，原始busy-attempt-proof保留。随后使用本任务模拟器的临时离线开关，原始状态disabled已记录。最终消息outbox-offline-fixed-69实际存入私有thread-outbox文件，schemaVersion3、messageId `4fdd00b3-b149-4963-a8ce-6a0217e468a2`、Plan选项/规范模式、Medium及approval-required完整保留，RPC中尚未出现该文本。只读取这条指定、无附件的合成消息，不读认证文件或修改客户端存储。Web正式刷新fixture为default-only，菜单实际只显示原生默认；恢复联网后真实Windows worker PID138112仅收到一次该消息，mode=default、untrusted/readOnly。只读SQLite同时保存default原生选项/default规范模式、Medium与approval-required，用户ID仍与文件一致，新增用户/助手两行完整，session ready、active_turn_id为空；原生界面显示完整默认回复，物理outbox目录为空。

原生页面仍显示历史探针留下的1条队列计数，未把物理文件移除改写为整队列UI清空；第19项须继续对账。中间离线消息outbox-offline-refresh-69曾收到plan，与最终有效消息分开记录，不将失败抹去。即时SDK在路由/网络切换帧偶有空前台包，改用静态空闲层级核对，未复用旧XML或据空帧重启。没有通过SQL或隐藏RPC写入业务状态代替UI。

原始证据在工作区外catalog-outbox-modes-{core,typecheck-mobile,typecheck-client-runtime,format,lint,final-old,final-green}.log、final-red-proof、final-native-source、final-queue-proof、final-runtime-proof及层级/PNG。可视化目录android-outbox-catalog-fixed.png、android-outbox-catalog-proof.json与outbox-catalog-default-only.png可查看。完成后恢复fixture原文件SHA、移除仅本主题两控制文件，通过实例停用释放PID138112再启用/刷新原目录；恢复飞行模式disabled，仅移除客户端13774测试连接，保留13773/13811，撤销reverse8088并停止捕获Metro46604。保留模拟器、Web/backend和服务端线程数据。

本主题实际为Web目录撤回操作、Android已有线程离线恢复及Windows受控协议进程；不是外部供应商/真实账号验收。新任务派发有入口集成断言，ACP URI为定向证据，没有新任务设备、Electron、iOS、公网relay/tunnel或帧率实测。十二类provider沿用既有决定；新客户端RPC不执行供应商探测，Web/Desktop不改变发送入口。没有动画、全局订阅、持久格式迁移或审批放宽，队列参数规范化后仍走既有消息/命令身份。第11项完整矩阵、第14/19项及全部39项/comparison继续进行。五源与四文档可独立回退，原83个无关基线及BYOK/ChatView/ChatComposer混合hunk继续保护。

## 70. Android新任务离线恢复采用当前目录的实际验收

第69主题是有效进展，本轮基线fb21d508e。第11项仍进行，完整39项与comparison额外范围保持不变；Electron替代自动化授权尚未收到，没有操作其窗口。继续使用test-codework-mobile流程、隔离emulator-5562、兼容com.codework.mobile.dev开发客户端，以及此前保留的13774后端/5734 Web环境。开工核对devRunner156576、fixture124388仍存活，端口实际监听分别为server119888和Web54228。未运行真实账号、外部供应商或live userdata，未写SQL业务状态。

三处第69主题生产源在原生副本的SHA与已测试候选一致，无新产品源码修改或原生重建。启动并捕获本主题Metro120540、8088端口，APP_VARIANT=development、dev-client、codework-dev、CI=1、EXPO_OFFLINE=1。Android包HTTP200、31,401,571字节、SHA-256 `f5377b0ca9aac450d28f6c0223162d31676caeecf99b053a40ff4dba82a44320`；通过真实Tools菜单Reload重载。最初两次层级只有Tools加载帧，确认同一Metro仍存活且完成编译后页面加载，没有因观察延迟重启。Metro日志保留依赖导出、颜色环境变量及资源解析告警，不当成验收通过依据。

实际新建任务选择隔离server项目，输入newtask-offline-catalog-70。选择器最初只显示草稿旧模型gpt-5.6-sol；打开旧版模型筛选后确认合成Codex模式验收模型被标为旧版，显式选择它，设置Medium、原生计划及受监督。模型待选状态须点击保存；左侧返回不提交待选模型。右侧Tools浮层覆盖按钮部分区域，点击当前保存按钮可见边缘成功回到草稿；导航帧的XML一度早于截图，最终以草稿截图和随后文件共同确认，不凭旧层级推断。没有更改目录语义来绕过筛选，也没有把合成模型的旧版标签当成外部模型结论。

本任务模拟器原飞行模式disabled，临时enable后确认原生“您离线”和“将任务加入队列”。队列保存指定文件edc6b503-1164-46df-a971-e966c0418df2.json；只读这条无附件合成消息。文件为schemaVersion3、环境56819db7-b079-4e29-b460-8f036e42d292、预分配线程12c26f38-cbb3-4581-8d96-49079af4b983、消息edc6b503-1164-46df-a971-e966c0418df2、命令a910c823-12b3-4a12-a423-35db784afb23；原生mode=plan、Medium、approval-required，creation为指定项目9bd1fd3c-05b0-4b52-93a7-aac7f0bf2c69、local和原cwd；当时尚无该文本turn/start。文件规范interactionMode为default，原生选项为plan，不能宣称入队表示已一致；该表示仍随第14/19项核对。

通过本主题可恢复合成fixture控制撤回Plan，Web设置正式刷新，打开新线程的完整模型选项菜单确认只广告原生默认。恢复飞行模式disabled后自动创建线程并派发；真实Windows Node worker78776只收到一次该文本，model=fixture-codex-model、mode=default、untrusted/readOnly。只读SQLite投影证实项目与预分配线程一致，规范与原生选项均default、Medium与approval-required保留，原user messageId不变，仅用户/助手两行且is_streaming=0，助手完整“原生默认模式已确认。”，session ready、active_turn_id与last_error为空，物理outbox为空。runtime-proof.valid=true覆盖这些断言。

原生列表实际出现新线程，打开初期曾显示加载消息、连接失败重试和两个环境重连；没有据落库完成就声称正文可见。观察同一进程/连接继续恢复，最终新线程全文和默认回复可见，旧13773/13811与本轮13774均实际已连接。点击已变化的重连提示时SDK语义动作失败，刷新层级后继续，没有复用旧XML或重启。这证明最终恢复与新任务目录派发，不证明重连延迟无回归；完整连接矩阵及第8/19项的状态对账仍开放。

原始工作区外catalog-newtask-native-{queue-proof,runtime-proof,metro,bundle-result,cleanup-proof}.json、Metro日志和各导航层级/PNG保留。可视化目录android-newtask-catalog-completed.png、android-newtask-catalog-proof.json、newtask-default-only.png及newtask-provider-restored.png可查看。恢复fixture原字节SHA、移除本主题newtask-modes.json，通过实例停用释放worker78776后重新启用/刷新，Web确认已认证；仅忘记手机13774测试连接，保留13773/13811已连接；移除reverse8088，停止捕获Metro120540，飞行模式disabled。保留模拟器、Web/backend、服务端新线程和验收数据。

本轮新增Android新任务实际离线入队/目录撤回/自动创建/一次发送/完整回复/文件移除证据，无新源码、协议、权限、会话生命周期或用户行为变更。因此未重复第69主题71项测试/目标类型/lint或第68主题361项，也未重做旧版对照；对应源码证据按原范围保留。Web为目录撤回入口，Windows为受控CLI子进程；Electron、iOS、ACP实际动态目录、外部供应商、公网relay/tunnel和帧率未新增验收。第11项剩余完整矩阵、第14/19项及全39项/comparison继续进行。三份架构/进度文档可独立回退，无迁移，原有92项未提交状态与受保护混合hunk继续保留。

## 71. 手机新任务原生模式与规范模式同时对齐

第70主题是有效进展，本轮基线0c5db4e86。继续第11项，并处理上一轮明确保留的第14/19项表示矛盾：真实离线新任务文件的原生选项为plan，规范interactionMode却是default。源码确认新任务显示、在线handleStart和buildPendingTaskMessage三个入口各自受旧版Plan偏好覆盖；模型菜单独立保存原生选项，运行适配器又优先采用它，导致实际Plan与规范记录不一致。没有据菜单或RPC成功掩盖规范状态。原39项/comparison范围保持完整，Electron替代UI自动化授权仍待答复。

四源修改：modelOptions新增resolveModelInteractionSettings，复用既有菜单归一化与共享resolveProviderInteractionMode；明确原生模式优先于旧两态偏好，已撤回选项与规范模式同步校正，在线旧Codex模型缺少模式广告时移除历史原生字段，未知/离线无配置保留输入，不借用其他实例。new-task-flow-provider按当前模型能力计算显示模式；离线入队与待发任务编辑采用同一快照解析；NewTaskDraftScreen在线创建读取刚保存的草稿并同时对齐模型与规范模式。保留项目/工作区/消息身份、推理和runtimeMode，不新增协议、目录探测、全局订阅、effect修正或动画。参考仓库React性能技能采用派生状态，目录只在快照构建时归一化。

纯HEAD候选仅带入本主题四源，无主工作区未提交修改。新增八项覆盖旧开关关闭时原生Plan、旧开关开启时原生默认、撤回/旧模型、推理与草稿不变、实例隔离、离线及BYOK/Claude真实两态声明。七文件83项全部通过：Mobile modelOptions/providerOptions/legacy-plan-mode、thread-outbox/drain，以及共享providerModels/state/server；Mobile目标tsgo、四源fmt/lint通过，检查前后SHA稳定，捕获PID106708/62840/61240/101956均退出0。首次测试文件类型断言换行导致格式解析失败，修正后正式检查通过，不把解析失败计为通过。没有全仓检查、Web类型或服务器类型重跑。运行命令与code/pid/stable回执在工作区外catalog-newtask-mode-state-checks.cjs及对应日志/result.json。

旧版对照采用第70主题已保留的实际Android入队文件，并核对当前基线两处生产源仍为旧偏好分支：old-proof保存0c5db4e86完整SHA、flow与screen源SHA以及nativeMode=plan/interactionMode=default的直接矛盾。没有在本轮重新运行旧包，也没有将新增函数在旧源码中的导入失败当作旧行为证明。新版实际文件则原生与规范均plan。旧原生文件、原有失败和本轮入口证据各自保留。

继续按test-codework-mobile复用隔离emulator-5562、兼容开发客户端与保留的13774后端/5734 Web。三生产源从本主题测试候选同步到原生副本且SHA一致，无原生重建。捕获Metro70456、8088，development/dev-client/codework-dev、CI=1/EXPO_OFFLINE=1；Android包HTTP200、31,404,243字节，SHA-256 `5b64ffa6c1c7f6761a63559e134fd297f9543e455194baa664bbb66c0854d604`，通过真实Tools→Reload重载。加载帧只有Tools时确认同一Metro仍存活并完成编译，没有据延迟重启。合成未知Codex模型通过现有旧版筛选显式选择；没有改变目录以绕过筛选。输入/键盘切换期间一次模型按钮未打开，刷新布局后按当前按钮进入；实际在线文本由IME首字母改为Newtask-online-plan-71，按实际文本对账，未修改历史数据。

Android在线新任务实际选原生Plan、Medium和受监督，通过开始任务创建线程6dbf4990-a32f-4f60-ba3c-1406b95fd432；真实Windows worker95636只收到一次turn/start，mode=plan、untrusted/readOnly。只读SQL中规范interaction_mode和原生选项均plan，Medium与approval-required保留，指定项目9bd1fd3c-05b0-4b52-93a7-aac7f0bf2c69不变，用户/助手仅两条完整消息，会话ready/无active_turn_id/无last_error。手机最终显示完整“原生计划模式已确认。”。提交后第一帧出现“线程不可用”，随后加载成功；该首绘现象继续归第8项，不将模式修复推成首绘无闪烁证明。

第二条新任务newtask-offline-plan-71沿用已选模型设置，临时飞行模式由disabled改enable，实际确认“您离线”和队列按钮后入队。只读指定无附件文件20de5041-6b04-4eb1-be5f-fcc2a9404c63.json：schemaVersion3，原生mode=plan、规范interactionMode=plan、Medium/approval-required、创建项目与local工作区信息完整，当时尚未派发。恢复disabled后自动创建预分配线程ac8d0c42-80de-4c02-8d00-c5bba1a64e10，worker7660仅收到一次Plan回合；SQL保存相同user messageId20de5041-6b04-4eb1-be5f-fcc2a9404c63，原生/规范均plan、权限与推理保留，回复完整、会话ready且无错误；手机打开新线程后全文可见，物理outbox为空。online/offline-proof.valid均true。

本主题未改fixture，原文件SHA与第70主题备份一致。通过Web实例停用释放worker95636/7660后重新启用/刷新，Web确认恢复已认证；仅忘记手机13774临时连接，保留13773/13811已连接；移除reverse8088、停止捕获Metro70456，飞行模式disabled。模拟器、Web/backend及服务端验收线程保留，不写SQL业务状态或读取认证文件。原始工作区外catalog-newtask-mode-state-{old,queue,online,offline}-proof.json、native-source、bundle-result、cleanup-proof及导航层级/日志；可视化目录android-newtask-{online,offline}-plan.png与对应proof.json可查看。

本次实际为Android在线新任务、离线新任务和Windows受控协议进程，不是外部供应商账号。待发编辑复用同一已测试设置解析函数，本轮未做编辑设备操作；非Codex的实际声明沿用共享解析，BYOK关闭/Claude保留两态有定向断言，其余driver目录合同不变。Web/Desktop入口不修改，Electron、iOS、ACP实际动态目录、公网relay/tunnel、未知配置编辑与帧率未新增验收。另确认新任务旧版两态按钮的显示目前只看planModeEnabled偏好，未按实例广告门控；原生模式优先时该按钮不能改变原生选项，后续单独修复并验证开启偏好的入口，不能将本轮关闭偏好下的设备证据用于证明其可用。第11项剩余矩阵、完整第14/19项与原39项/comparison继续进行。四源与四文档可独立回退，无数据迁移；仍保护原83个无关基线文件、BYOK/ChatView/ChatComposer混合hunk，精确提交不得包含截图或工作区外脚本。

## 72. 手机新任务旧版两态入口按实例能力门控

第71主题是有效进展，本轮基线1a7aefdae。继续第11/14项并处理上轮明确记录的入口缺陷：NewTaskDraftScreen旧版按钮仅看设备planModeEnabled，原生模式优先时可出现不能切换的Build/Plan按钮。已有ThreadComposer和Web均采用共享canUseProviderInteractionModes；CodexProvider声明showInteractionModeToggle=false，GenericAcpDriver声明true，BYOK与原生模式按既有能力决定。先核对当前源码、92项未提交状态与原生环境；没有新供应商能力推断或全局放权。

仅修改NewTaskDraftScreen一处入口，新增共享判断：设备偏好开启、所选模型存在且当前实例/能力允许两态才展示按钮。原生模式菜单、发送快照、运行权限、项目与消息身份、目录入口和缓存不变，无新协议/订阅/动画。原有共享判断负责实例隔离、未知实例、ACP原始模式、OpenCode agent与明确关闭声明；其他实例保持既有兼容行为。本轮按仓库React性能原则使用派生布尔值，不增加effect或独立偏好状态。

纯HEAD候选仅带入这一生产源，相关三文件33项通过：Mobile modelOptions、legacy-plan-mode及共享providerModels；Mobile目标tsgo、单源fmt/lint通过，前后SHA稳定。捕获PID82368/32192/80152/90788均退出0。没有新增镜像断言测试，也没有重复上一主题七文件83项、服务器类型或全仓检查；本轮实际前端路径补充如下。命令和code/pid/stable回执位于工作区外catalog-newtask-toggle-checks.cjs及相应日志/result.json。

按test-codework-mobile继续复用隔离emulator-5562及兼容com.codework.mobile.dev，无原生重建。旧客户端使用上轮已经真实Reload的同一源码，Native Screen SHA为b59dd3a36157ed90c3b9daae3c7d089e0e4a445b2c6db7679ce5d7b4aef1a8c2；捕获旧Metro27852，Android包HTTP200、31,404,243字节、SHA-256 5b64ffa6c1c7f6761a63559e134fd297f9543e455194baa664bbb66c0854d604，与上轮实际加载包一致。通过实际设置页确认本地旧版Plan偏好checked=false，开启后checked=true。一次滚动触发Android最近任务，返回已观察的Code Work卡片后改从内容中部滚动，没有启动其他应用或重启模拟器。没有通过私有存储/隐藏RPC写偏好。

实际旧版新任务选择Codex模式验收模型，菜单原生默认可见；草稿仍显示“交互模式：Build”。点击后继续Build，再打开模型菜单确认原生默认未改变，old-proof记录直接无效入口，未发送测试任务。随后仅停止捕获旧Metro27852，将已测试单源按SHA同步原生副本；修复源SHA cf4c7b7787d8380ae30fc59551fa27ccb15eeb4944ea9445d28fbdd70684b31e。捕获修复Metro52628，Android包HTTP200、31,404,760字节、SHA-256 e2f0482de91f2d08d0477a0b5a8928a1f171c9ef1c40379205f6169ae9201ccd，通过真实Tools→Reload加载。两次编译完成，同一进程在加载期间仍存活，没有据观察延迟重启。

同一客户端及保持开启的设备偏好下，新版Codex草稿不再显示旧两态按钮，模型菜单的原生默认与推理选项保留。切到“可用两态测试”的fixture-acp-model后入口显示Plan，实际点击Plan→Build→Plan；切到“隔离模式验收”的BYOK模型后入口再次隐藏。只读隔离配置核对两实例分别为driver=acpAgent/id=byok和driver=byok/id=byok-fixture，不按显示名称判断类型。ui-proof.valid=true覆盖旧版可见且无效、新版Codex隐藏/原生菜单保留、正向与反向切换、BYOK隐藏及源码SHA。Codex fixture thread/start前后均5、turn/start均16，证明本轮这些草稿动作未新增Codex会话/回合，不扩展为所有provider运行证明。

通过实际设置页再次确认旧版偏好仍checked=true，然后恢复原checked=false；保留旧版线程列表等其他偏好。仅忘记手机13774临时连接，原13773/13811均实际已连接；移除reverse8088，停止捕获修复Metro52628，旧Metro27852也已退出。未改fixture，其SHA与第70主题备份一致；本轮没有新增供应商回合、SQL业务写入或真实账号操作。测试模型选择保留在隔离空草稿，未声称恢复所有草稿字段；模拟器、保留Web/backend与先前验收线程数据不删除。cleanup-proof记录偏好原值/恢复值/恢复核验以及进程和连接边界。

工作区外catalog-newtask-toggle-{old,ui,preference,cleanup}-proof.json、before-counts、native-source、bundle-result及导航XML/PNG保留。可视化目录android-newtask-toggle-{before,after,allowed,byok}.png及android-newtask-toggle-proof.json可查看，截图/脚本不提交。更新providers、comparison及用户模型目录说明；单源加四文档可独立回退，无迁移。

本轮新增Android新任务入口、设备本地设置及实例切换的直接证据，不是通用ACP供应商回合或外部账号验收。Web/Desktop沿用既有共享门控未修改；其余provider按当前实例声明决定，未增加支持能力；设置入口只是偏好开关，实际控制仍在模型/草稿入口。Electron替代自动化授权仍待答复；iOS、ACP实际动态模式、全部入口、远程/relay/tunnel、未知配置编辑、首绘/队列对账及帧率未新增验收。第11项剩余矩阵、完整14/19项及全39项/comparison继续进行。精确提交仍保护原83个无关基线文件、原BYOK/ChatView/ChatComposer混合hunk及92项未提交状态。

## 73. ACP 原生 URI 模式实际发送与主会话目录撤回

基线270e08805，继续第11项。本轮没有生产源码、协议、权限或用户行为修改；复用GenericAcpDriver、CursorAdapter及已有ACP配置回执合并，验证Web首回合、Android原生模式选择、Windows实际协议请求与两端撤回。实例ID仍为byok，实际driver为acpAgent；与byok-fixture的BYOK网关分别对账。原39项与comparison完整范围保持不变。

在工作区外原受控命令加临时记录层，原字节另存，--version仍返回1.0.0。子进程执行仓库既有acp-mock-agent.ts；启用其URI模式和动态config更新开关，第二组另启用已有STARTUP_CONFIG=dynamic回执场景。记录层只保存方法/请求ID、指定模式字段、两组合成测试文本和配置选项ID，不记录认证、MCP或初始化参数；没有复制上游实现或修改数据库。草稿阶段记录文件尚不存在，首个session/new仅在实际发送后出现。mock源SHA与当前提交相同，为57403f8445e0609719ccf341af6c268e302b9ae401cfbd579ab124e6960ec612。

第一组acp-bootstrap-73由Windows worker156556完成，Web显示动态“计划/实施/审查”。Android正式Reload后连接恢复曾短暂“暂无线程”，打开线程也出现“正在加载消息”，之后完整“配置已更新”可见。Mobile历史选择仍显示原始default；在设置中显式选当前动态默认模型后才显示原生模式菜单。选择审查并发送acp-uri-73，进程151696执行session/load后返回初始model配置，dynamic-default被本地配置校验拒绝，未调用第二个prompt；规范用户行已落库、会话error、active_turn_id为空。失败线程2367d4eb-3530-4a97-92a6-a9c042ab76eb及原始证据保留。

日志在第一组两回合之间记录06:52:17的Restarting 'src/bin.ts'、代理ECONNRESET和06:52:27重新监听。空闲回收阈值为1800000ms，不能将本次重新加载归因为空闲回收；先前中间说明的该归因已撤回，具体watch触发源未确认。恢复后mock未保留动态目录是直接失败边界，不把启动配置场景的成功用于覆盖此失败。后端重启后的模型/模式对齐、未知模型显示/编辑、撤回后再次发送仍随完整矩阵继续。

第二组独立线程7a185f1f-1497-4a21-9fe4-f627f03347db：Web发送acp-bootstrap-73-live，Android加载同线程，在设置显式选择当前“默认模型”及“审查”，保存后发送acp-uri-73-live。真实Windows worker98968在同一mock-session-1收到两个prompt；其中URI只调用一次session/set_config_option，configId=operation、value=https://agentclientprotocol.com/protocol/session-modes#review，成功response且无legacy session/set_mode。该URI不被缩写成两态plan/code；规范interaction_mode保持default，实际原生选择按完整URI持久化，runtime_mode仍为approval-required。

首回合主会话公布engine/operation/fast配置，foreign和isReplay回执不覆盖其模式。第二个prompt主会话发完整空configOptions，实际活动投影末尾session.mode.updated的mode为null、session.config-options.updated为空；Web移除模式按钮，Android设置只剩fixture-acp-model和受监督运行选项，没有Agent模式或审查入口。持久化历史选择仍保留原URI及dynamic-default，Mobile输入框显示原始dynamic-default；本轮只证明撤回广告与控件，不声称历史选项清除或下一次派发已验收。只读SQLite证实四条唯一完整消息，两条助手回复均“配置已更新”，is_streaming=0，会话ready、无active_turn_id/last_error，项目身份保持不变。catalog-acp-live-proof.valid=true执行16项明确断言。

复用emulator-5562及兼容开发客户端、隔离13774后端/5734 Web，不连接真实账号或live userdata。捕获Metro127968，8088；原生NewTaskDraftScreen加载SHA仍为第72主题cf4c7b7787d8380ae30fc59551fa27ccb15eeb4944ea9445d28fbdd70684b31e。本轮Android包HTTP200、31,404,760字节、SHA e2f0482de91f2d08d0477a0b5a8928a1f171c9ef1c40379205f6169ae9201ccd，通过真实Tools→Reload加载。语义读取在未就绪时点击失败，改读新层级后继续，没有回用旧XML。原生设备Plan偏好未改变，沿用第72主题已恢复的false。

当前HEAD纯候选三文件146项通过：AcpJsonRpcConnection、AcpRuntimeModel、共享providerModels，覆盖配置/legacy URI、动态目录、根/foreign/replay归属、withdrawal和客户端模式归一化。测试PID77436退出0，九份对应源/测试文件与当前生产源SHA一致，执行前后哈希稳定；命令为vp test run --config .candidate-test.config.ts <上述三文件> --testTimeout 10000，回执与日志在工作区外catalog-acp-live-checks.cjs及test-result.json/test.log。不重复生产类型/lint或旧版产品对照；本轮无生产源修改，文档fmt与diff检查另行通过，不跑全仓检查。

通过Web实例停用释放受控会话，原wrapper按备份字节恢复，SHA 08d14bb66f352c7c0dbc14fdc73103285c3cb3432b52032db77a8583fb7a4faf；再启用并正式刷新原实例。临时记录层额外child98968在wrapper退出后仍存在，核对捕获的父PID65788和实际mock命令身份后，仅停止该PID；全部六个捕获wrapper/child均已退出。仅忘记Android13774测试连接、移除reverse8088、停止捕获Metro127968；原13773/13811实际已连接，8087/13773/13811转发及保留的Web/backend/fixture不变。cleanup-proof.valid=true，合成线程和失败数据不删除。

证据保留在工作区外catalog-acp-live-{rpc,proof,state-accepted,state-after,source-proof,test-result,cleanup-proof}及导航XML/PNG；可视化目录android-acp-live-selected.png、android-acp-live-withdrawn.png、web-acp-live-after.png和acp-live-proof.json可查看，截图/临时脚本不提交。三份架构/进度文档独立提交，可独立回退且无迁移。本轮是本机Web/Android到受控Windows ACP进程的集成验证；Electron替代自动化授权仍待答复，iOS、外部供应商账号、公网relay/tunnel、全部入口、重启恢复/再次发送和帧率没有新增通过结论。第11项剩余矩阵、第14/19项与全39项/comparison继续进行，原83个无关文件、混合hunk及92项未提交状态继续保护。

## 74. 手机已有线程的当前模型显示、设置与待发解析

基线6aacdaa1dd82fbf6eb72afee036a775eb2d543d1，继续第11/14/19项，承接第73主题直接观察的缺陷：历史选择仍是default时原生设置只有先重选动态模型才提供模式；队列先合并会话目录再构造菜单，会将已撤回历史模型作为未知模型补回。本主题不改缓存入口、供应商协议、权限、项目或消息身份，原39项与comparison完整范围不变。

Mobile新增resolveThreadModelOption，显示、设置、入队与最终派发复用同一当前目录：原选择仍可用时保留；明确撤回时仅选同实例默认项或首项，保留兼容模式/推理并按当前描述校正失效值；无同实例模型则返回null。两个派发入口遇到已知实例无模型时保留队列，在线输入框及键盘发送保留草稿。缺少配置的离线意图仍保留。共享运行库hasSessionModelCatalog复用现有Schema解码，最新有效模型快照决定撤回，空数组生效、null清除覆盖；仅模式/配置更新、非法负载及其他实例事件不能误删未知历史模型。没有新wire字段、持久化迁移、动画或provider会话创建。

纯HEAD候选只带本主题十份源码/测试。六文件75项通过：Mobile modelOptions、thread-outbox、use-thread-outbox-drain、thread-settings-options、thread-settings-sheet-state和共享providerModels；Mobile及client-runtime目标tsgo、十文件fmt/lint均通过，检查前后SHA稳定。捕获PID113100/32796/155524/126528/10892均退出0。旧版生产源来自完整HEAD基线，两个新增outbox行为断言直接失败、退出1，没有把新函数导入失败当作旧版对照。首次类型检查两个旧测试未处理新增null分支而失败，修正测试访问后通过；新增mode-only/null/非法/跨实例快照断言后正式总数75。命令与code/pid/stable回执在工作区外catalog-thread-model-checks.cjs及对应日志/result.json，不跑全仓检查。

按test-codework-mobile继续使用emulator-5562、兼容com.codework.mobile.dev、隔离13774后端/5734 Web。初版新增解析每render返回新selection，实际打开原生设置触发Maximum update depth exceeded；保留XML/PNG和错误日志后，将解析纳入useMemo，保持设置路由引用稳定，不回写持久化线程。该问题不能仅由单元测试排除，修复后正式Reload与实际模式选择/发送成功，最终设置两次新层级均稳定。

实际发送使用修正useMemo后的五生产源，加载Android包HTTP200、31,406,208字节，SHA c45b0858c9b9adadcec569d834f43935fb51013f183ab0431d927a12d91b3f90。独立acp-bootstrap-74线程d80cf730-8788-421c-a829-0334229a2d5b由Web先选受监督并发送，原始SQL选择仍default；Android无需重选模型即可显示当前默认模型及Agent模式菜单，只选择审查。设置打开时切换其他侧栏线程、关闭后曾返回旧线程并显示空白，保留证据并继续第19项导航核对；本次明确关闭设置、重开标题acp-bootstrap-74核验后，才发送acp-recovery-74，没有将旧线程显示当作正确导航。没有手动重选模型或改写SQL。

真实Windows worker120804与wrapper30540在同一mock-session-1收到两个prompt、只有一次session/new；第二回合仅调用一次session/set_config_option，configId=operation、value为完整https://agentclientprotocol.com/protocol/session-modes#review，response成功，无legacy session/set_mode。只读SQL第二次选择dynamic-default+URI，规范interaction_mode=default、runtime_mode=approval-required，创建项目9bd1fd3c-05b0-4b52-93a7-aac7f0bf2c69不变。四条唯一完整消息，首回合两条原ID/文本保留，两次助手全文均“配置已更新”，is_streaming=0，会话ready、无active_turn_id/last_error。第二回合撤回主配置后，末尾mode=null/空配置活动落库；Android与Web显示fixture-acp-model，手机设置勾选此项，Agent模式入口消失。第73主题失败线程仍保持三条原消息，没有新恢复消息，本主题未证明后端重启后的旧广告与新CLI目录已对齐。

实际发送之后另收紧在线无模型键盘保护，并修正mode-only事件撤回判断；正向有效模型路径不变，但不将早先发送声称为最终源码哈希下重发。最终六生产源与75项候选SHA一致，实际编译包HTTP200、31,406,736字节，SHA b586ba3615196ce4598667099f492283fe1a715fa2a2e50a9e35fc9f942f4fe4；编译代码直接确认hasSessionModelCatalog与useMemo后，通过真实Tools→Reload载入。之后重新打开同线程、两条全文、fixture-acp-model按钮、checked模型及撤回控件均确认，设置稳定两次。源码修改后Metro仍给旧编译代码，先直接读取旧selectionRemoved分支/旧SHA证实缓存，再只停止捕获PID并使用clear启动；没有仅据加载延迟重启。全部Metro捕获PID135796/124360/95268/149224，最后进程149224重载时短暂只显示Tools，编译完成后同一进程恢复；一次Reload语义点击没有生效，重新读层级后按实际父控件坐标完成。

临时wrapper只启用既有URI/动态配置fixture开关，不启用启动动态配置场景；记录只含方法/请求ID、指定配置字段与两条合成文本，不记录认证或MCP初始化。原mock源码SHA57403f8445e0609719ccf341af6c268e302b9ae401cfbd579ab124e6960ec612。通过Web实例停用释放wrapper后，额外子进程120804仍存在；核对其捕获父PID30540和实际mock命令后只停止该PID，原wrapper按备份字节恢复SHA08d14bb66f352c7c0dbc14fdc73103285c3cb3432b52032db77a8583fb7a4faf，再启用/刷新实例。仅忘记手机13774临时连接、移除reverse8088、停止捕获Metro149224；原13773/13811实际已连接，8087/13773/13811转发、模拟器及保留Web/backend/fixture保持。所有六个wrapper/child/Metro已退出，cleanup-proof.valid=true；本轮没有改变设备Plan偏好，验收线程与失败数据不删除。

catalog-thread-model-proof.valid=true汇总26项协议/投影/界面/类型/旧版断言；工作区外rpc、state-before/after、old-proof、positive/final Native源与bundle、缓存探针、proof/cleanup和XML/PNG均保留。可视化目录android-thread-model-{selected,completed,settings}.png、thread-model-proof.json可查看。十份源码/测试与四份用户/架构/进度文档独立提交，截图和临时脚本不提交；可按该提交独立回退，无迁移。

本轮新增本机Web首回合、Android已有线程设置/实际发送和Windows受控ACP进程证据；测试涉及共享目录及Codex/ACP模式规则，没有外部供应商账号请求。Web/Desktop生产入口不改，其他provider仍按真实当前目录与既有声明决定。完整空目录的队列保留及未知目录边界有定向测试，本轮没有设备第三次发送、完全空目录/未知配置编辑、全部入口、iOS、公网relay/tunnel或帧率新增结论。Electron替代自动化本轮获得用户明确授权，尚未执行，下一主题使用独立Playwright Electron/CDP窗口及隔离数据完成模式菜单与发送矩阵。后端重启目录、跨线程设置导航、首绘/队列对账继续开放，第11项及完整14/19项、原39项/comparison继续推进。精确暂存/提交前后核对原83个无关基线文件、BYOK/ChatView/ChatComposer混合hunk及92项原未提交状态。

## 75. 独立 Electron 原生模式菜单与受控发送

基线e8362c184a76401b7fe9c206b0d947a197bf1e33，上轮已完成第74主题并独立提交，属于有效进展。本轮执行用户明确授权的Playwright Electron/CDP隔离验收，继续第11/14/19项。本轮不改生产源码、协议、权限或产品使用方式，仅补充真实桌面入口、Windows受控请求和投影证据；全39项与comparison范围不变。

纯提交副本位于忽略目录.t3/catalog-electron-modes-20261014，产品home/APPDATA/LOCALAPPDATA与新user-data-dir独立；本地所有provider禁用，UI也确认主设备Codex等已禁用，不接真实账号或live userdata。依赖采用既有junction，构建别名将工作区包指向副本，1966份输入仅两份vite配置加隔离别名，其余源字节不变。初次vp pack误用本机不支持的--config，把配置当入口而失败；保存日志后按默认vite配置加载构建，server/main/preload分别为11,134,410/1,555,323/56,136字节，SHA为429868aaeec8f2758fdfb8f5e3db0374f388abe3a095850e3d1334c8a4a0d8bc、36b41759958fe27adcff580f214e13ef9cb39a6b640709940cc8178072f1a020、0299da4f72abcfdf8a7cafedeb63f5d8058f1df168b1baba2339ec533b20eda5。目标构建退出0，保留非致命动态导入、dts/sourcemap和插件耗时提示；没有安装包、更新发布或全仓构建/检查。

先前三次启动在窗口前退出，Windows记录同二进制41.5.0的0x80000003异常，保留原日志，不将原生退出归因为未证实的应用代码缺陷。核对同版本原隔离Electron148676仍活着，比较成功启动环境后，沿用系统用户目录信息并显式指定独立user-data-dir，同时维持产品数据隔离和认证环境剔除；两项一起改变，未单独证明其中某一项是根因。首次成功78044因控制器stdin EOF正常关闭；确认终态后，使用持续PTY保留第二次成功窗口87380，启动器64064。实际标题Code Work (Dev)、origin codework-dev://app、desktopBridge对象；初始请求1280×720，后续实际viewport1286×723/DPR1.5，本轮不用于第9项1280×720帧率口径。

窗口使用本轮主后端13775，通过真实设置→连接设备→添加环境连接保留的本机13774合成环境。配对链接只在进程/临时文件中使用，不输出或截图；配对成功后的通用dialog等待误匹配成功提示和关闭中的对话框，读取实际已连接状态后继续，没有重新消费令牌。菜单和页面切换的首次捕获可能仍为前一帧，以后续新控件/投影判定；有两次供应商设置截图30秒超时及一次按钮accessible name等待20秒超时，保留错误，没有据截图超时重启应用。一个辅助鼠标目标坐标在视口外，未算作有效选择；改为先滚入视口并验证中心坐标，再点击，最终aria-pressed确认13774已选中。一次非提权探活将EPERM误标为false，该判定撤回；随后已登记PID的WMI及真实CDP页面确认仍存活，不能以权限失败判进程停止。

实际Codex命令仍是原隔离codex-fixture-alt.cmd/worker.cjs，返回合成fixture@example.test账号，使用独立fixture home，不调用真实CLI/外部账号。草稿打开原生选项、显示全部、选原生计划并设置受监督后，保存协议基线thread/start=5、turn/start=16；发送前仍为5/16，模型菜单没有新增会话。实际发送electron-codex-plan-75创建线程0abcbdef-d527-4a8b-9256-0753fcc1b9e3，Windows worker155496收到Plan请求，approvalPolicy=untrusted/sandboxPolicy=readOnly。SQL规范interaction_mode和原生codexCollaborationMode均plan，reasoningEffort=medium、runtime_mode=approval-required，完整“原生计划模式已确认。”及计划卡片可见。点击真实“实现”按钮后，同一worker收到default请求；持久化原生/规范均default，Medium和权限保留，完整“原生默认模式已确认。”可见。第二条实际用户文本为PLEASE IMPLEMENT THIS PLAN加完整受控计划，按原始文本对账，不改历史。四条唯一完整消息、首回合原ID/文本保留、ready且无active_turn_id/last_error；UI四个messageId与SQL一致。Medium的直接证明为UI与SQL，worker日志未记录实际reasoning字段，不据此额外断言该字段的协议值。

独立空草稿切到byok-fixture模型后未显示模式控制，再切实际driver=acpAgent/id=byok的CLI默认模型。此观察仅覆盖当前设备偏好，未新增旧版两态偏好开启下的全部能力门控结论。临时ACP记录层复用既有URI与动态config场景，不启用STARTUP_CONFIG；记录只含方法/请求ID、指定配置字段和electron-acp-bootstrap-75/electron-acp-review-75合成文本，不记录认证/MCP初始化。mock源SHA57403f8445e0609719ccf341af6c268e302b9ae401cfbd579ab124e6960ec612匹配HEAD；草稿阶段记录文件不存在。

发送electron-acp-bootstrap-75创建线程3bdcbe3f-9a4d-4dd8-aa82-3ddb34f38898，wrapper40680/worker99684，首个session/new发生在发送后。SQL原模型仍default，完成回合后Electron已显示运行目录“默认模型”和原生“计划”；无需重选模型。实际菜单有计划/实施/审查，选择审查并发送electron-acp-review-75，同一mock-session-1和worker收到第二个prompt，完整URI只调用一次session/set_config_option，configId=operation、value=https://agentclientprotocol.com/protocol/session-modes#review，成功response且无legacy session/set_mode。SQL采用dynamic-default+原URI，规范interaction_mode=default、runtime_mode=approval-required；两组均属项目9bd1fd3c-05b0-4b52-93a7-aac7f0bf2c69。四条唯一完整消息、两条助手均“配置已更新”，首回合身份/文本保持，终态ready无错误；UI消息ID与SQL一致。

第二ACP回合主配置完整撤回，末尾mode=null/configOptions=[]活动落库；最终Electron模型按钮为fixture-acp-model，原生计划/审查入口消失，两条全文可见，截图已用图像工具实际查看。原URI留在持久化历史，不将控件撤回等同于清除历史选项或第三次派发已通过。第73主题重启目录失败仍保留，本轮新线程成功不覆盖它。

实际Web ChatView/ChatComposer/ProviderModelPicker、providerModels/modelSelection与远程AcpSessionRuntime/AcpRuntimeModel/GenericAcpDriver/CursorAdapter/CodexProvider/CodexAdapter十一份源匹配当前提交。服务中的共享providerModels比HEAD只少第74主题新增但Web未使用的hasSessionModelCatalog函数，移除该新增块后其余字节一致；保存两端完整SHA与此边界，不把磁盘副本笼统当成全图已加载。桌面壳采用本轮纯提交构建及独立preload，保留实际运行登记与产物SHA。

定向命令为vp test run --config .candidate-test.config.ts <AcpJsonRpcConnection/AcpRuntimeModel/shared providerModels/Web providerModels/Web modelSelection五文件> --testTimeout 10000。首轮四文件151项通过，第五因隔离配置遗漏~/别名而无法导入，整体code=1；补齐测试别名后仅重跑失败的modelSelection文件，22项通过。合计五文件173项，原失败日志不覆盖；两次源哈希稳定，PID56132/116208退出记录分别为1/0，catalog-electron-modes-proof将失败原因及已解决状态分别列出。无生产源码修改，不重复类型/lint或此前旧版行为对照；构建、文档fmt与diff检查另行通过。proof.valid=true执行33项具体断言，不替代未覆盖的完整矩阵。

清理先通过实际供应商开关停用byok，配置确已false，但ready会话进程仍存在，没有把停用视为已释放。使用现有thread.session.stop命令及普通一次性配对，只有本轮两线程；首次传输失败且无回执，随后日志记录09:17:39后端watch重启和09:17:49恢复，触发源未确认，不归因空闲回收。后端恢复后改用本轮已构建CLI执行相同公开授权流程，取得sequence294/296回执，两线程投影stopped/无active_turn_id/last_error，四条原消息逐字及ID不变。临时记录层额外child99684仍遗留，停止前核对捕获父PID40680及实际mock命令，只停止该PID；wrapper40680、worker99684和Codex worker155496均退出。原wrapper按备份字节恢复SHA08d14bb66f352c7c0dbc14fdc73103285c3cb3432b52032db77a8583fb7a4faf，再通过界面恢复byok.enabled=true。停用、停止命令、后端重启与额外子进程各自记录，不能互相替代。

独立窗口87380、原隔离窗口148676、保留Web/backend的devRunner156576与fixture124388都经WMI确认仍活着；本轮产品home/APPDATA及连接保留用于后续矩阵，没有删除数据库/线程或按名称清扫进程。临时API令牌仅在清理进程内交换，未保存或输出。设置页实际出现两张相同的可用两态测试/byok卡片，开关同时反映同一配置；该重复显示作为下一主题的源码核对项，不在本轮修复或掩盖。

工作区外catalog-electron-modes-{registry,build-input,build-output,source-boundary,web-source,web-shared-source,test-result,web-retry-result,codex-_-state,acp-_-state,acp-rpc,proof,stop-receipts,stopped-state,cleanup-proof,process-proof}及启动/定位/截图失败记录保留。可视化目录desktop-native-{codex-plan,codex-default,acp-modes,acp-withdrawn}.png、desktop-native-modes-proof.json可查看，截图和临时脚本不提交。三份架构/比较/进度文档独立提交，可独立回退，无迁移。

本轮证明独立Windows Electron客户端连接本机第二环境、两个受控provider实际模式/发送及停用配置入口；不是外部供应商账号或跨机器网络验收。Web/Android沿用已记录证据，iOS、公网relay/tunnel、全部快捷键/命令面板/设置入口、未知配置编辑、后端重启旧目录对齐、第三次撤回后发送、重复设置卡片及本轮帧率仍未完成新增验证。第11项完整矩阵、第14/19项和原39项/comparison继续进行。精确提交前后继续保护原83个无关基线文件、BYOK/ChatView/ChatComposer混合hunk及92项原未提交状态。

## 76. 设置列表按实际 driver 识别占用旧标识的实例

基线7dff56e7707222a14c065925a677c9890dcafd78，第75主题已独立提交并完成真实Electron模式/发送，本轮属于后续身份边界修复。先读当前源码和同窗口DOM：driver=acpAgent/id=byok的实例有两行及两个同名开关。Web ProviderSettingsPanel默认槽采用了其他driver的显式实例，又在实际driver组重复加入；默认槽的row.driver和isDefault还可能使编辑写入错误的legacy镜像。Mobile默认槽同样不检查显式driver，codex标识可被错误展示为Codex字段。没有改最初读取的IntegrationsSettings或其原用户修改。

仅两生产源最小修改：Web默认槽在显式driver不匹配时不生成有效行，但继续显示该driver的其他自定义实例；未列出driver的默认身份同时核对其自身默认标识。Mobile被其他driver占用的旧槽不入列，下方命名实例采用实际driver、字段和known状态。标识与配置对象保留，不迁移/删除legacy数据，不在effect里回写，不新建状态或缓存层。旧槽没有显式实例时仍沿用原兼容合成；同driver默认槽原行为不变。

新增五个行为回归先跑真实旧生产源：Web重复byok/acp实例、未知driver占用grok；Mobile codex→acp、codex→byok、cursor→未知driver。旧源来自完整7dff56e77并保存两源SHA，五项均直接失败，退出1；没有缺少新函数或依赖导致的伪红。新版测试验证唯一行、真实字段、known状态、非默认实例可删除、其他同driver自定义实例仍存在、配置对象保留，以及编辑不修改providers旧镜像。所有相关五文件71项通过：Web ProviderSettingsPanel.environment、Panel.logic、providerInstanceEdits、SettingsPanels.logic和Mobile SettingsProvidersRouteScreen.logic。PID15060退出0，前后四源/测试哈希稳定。

Mobile目标tsgo通过，PID137316；Web局部目标首次报既有useCopyToClipboard的NodeJS命名空间缺失，用旧生产源在相同目标配置复现同一错误。只给工作区外隔离Web类型配置补vite/client与node声明，再跑通过；未改该无关hook或项目tsconfig。四文件fmt/lint通过，PID135648/83664均0，哈希稳定；首次Web失败及旧源对照、修正回执分别保留。没有全仓检查、后端修改或新增依赖。

继续使用第75主题独立窗口87380，连接13774合成环境。旧DOM同实例开关count=2，修复的单个Web源从测试候选按SHA复制到既有Vite副本，HMR后同窗口count=1且13774仍选中，没有重启Electron/backend。真实ACP编辑页正常打开，启动、登录/MCP及删除实例入口保留，截图已实际查看。点击唯一开关true→false→true，只读隔离settings确认每次目标driver仍acpAgent，旧providers、其他providerInstances及目标命令config三组哈希不变，enabled恢复原true。没有发送新provider回合、删除实例、改原命令或读取真实认证。catalog-instance-slots-proof.valid=true执行12项明确检查。

保留原Android/iOS源码路径，Mobile fields/unknown/materialize行为和目标类型有直接回归证据，本轮没有新增该标识复用的Android/iOS设备动作。桌面壳复用已构建的第75主题，Web与Desktop采用同一修复源；服务端、所有adapter、目录入口/缓存和连接协议不变。其他driver依据显式driver与既有声明，不新增支持能力。当前证据是本机第二环境与受控配置，不是外部账号、公网relay/tunnel或本轮帧率。

工作区外catalog-instance-slots-{old-source,old-test-result,old-test,core-result,typecheck-_,baseline-web-typecheck_,web-source,desktop-before,desktop-after,settings-before,settings-disabled,settings-restored,proof}保留；可视化目录desktop-provider-slot-{before,after}.png及provider-slot-proof.json可查看，截图/脚本不提交。两生产源、两测试与四份用户/架构/比较/进度文档独立提交，可独立回退，无迁移。fixture wrapper继续保持原恢复字节，enabled恢复；独立Electron、原窗口和原服务保留。第11项完整模型/模式/设置/待发入口矩阵、重启目录、原第14/19项及全39项/comparison继续进行，不能以本轮行构造修复替代它们。提交前后仍检查原83个无关基线文件、BYOK/ChatView/ChatComposer混合hunk及92项原未提交状态。

## 77. 恢复会话的 ACP 模型与模式选择按当前目录对齐

基线3491b56879bc44c4d115fa0fafd0bd391907d6b8，第76主题已独立提交，本轮为第11项首个可独立验收增量：后端重启或原生会话恢复后，持久化的动态模型/模式选择与新CLI实际广告目录对齐。不改协议合同、不手工改SQL/历史消息/目录、不重造统一目录与缓存。

保留失败线程2367d4eb-3530-4a97-92a6-a9c042ab76eb：watch重启后session/load广告default、composer-2、gpt-5.4、claude-opus-4-6，持久化dynamic-default在session/set_config_option本地校验被拒，Invalid value "dynamic-default"，第二个prompt未调用，规范用户消息已落库、会话error。重启有watch日志证据，空闲阈值1800000ms，不归因空闲回收，触发源未确认。原实现把持久化值直接送入set_config_option/set_model，本主题在adapter边界补齐对账。

CursorAcpSupport.applyCursorAcpModelSelection返回{appliedModel,withdrawnModel}：先读当前configOptions并抽取模型configId；config选项目录按请求全值→基础模型ID→当前有效值→首个有效项回退；空数组视为明确撤回、不派发；目录null（CLI未广告）保留原请求值透传。旧式getAvailableModels目录同理：请求在目录内用之，否则广告默认，否则首项，空目录不派发。模型下发后重新读getConfigOptions再应用reasoning/context/fast，因为per-model选项随模型切换出现；首次漏掉re-read被完整测试回归捕获并修复。AcpAdapterSupport.applyAcpModeSelection返回{applied,withdrawnModeId}：按getModeState强校验，撤回模式不派发交调用方回退；非字符串模式值仍是ACP请求错误。applyAcpConfigSelections语义不变，撤回配置值仍拒绝并提示刷新会话配置。

Grok模型路径明确不按目录强校验：session/set_model旧式接口本接受目录外自定义模型，runtime成功后以isCustom追加，CLI仍是权威；新增透传回归测试。GrokAdapter两个调用点仅消费模式结果，撤回模式发runtime.warning后继续。CursorAdapter抽applyRequestedSessionConfiguration统一startSession/sendTurn：模型对齐、显式模式优先于default/plan推断、撤回模式告警后走正常runtime/interaction解析、配置项按最新目录校验。会话显示模型与turn.started记录实际下发值而非撤回原值；runtime.warning携带eventId/createdAt与provider/thread/turn元数据，经既有ProviderRuntimeIngestion落工作日志，不新增合同类型。

新增与更新测试：CursorAcpSupport模型选择describe转@effect/vitest的it.effect并补撤回回退/空目录/旧式目录/null透传共10项；GrokAcpSupport透传用例累计16项；CursorAdapter新增恢复回归（持久化dynamic-default+标准目录，撤回不派发且回退currentValue不产生请求、警告与提示均落事件、URI模式与通知收集器需先Effect.yieldNow挂订阅再跑会话）累计44项；既有失效模式值用例由"整轮失败"改断言"不派发且继续"；GrokAdapter 50项。四文件合计120项全部通过，PID退出0；完整CursorAdapter回归曾暴露per-model配置在setModel前取目录的顺序缺陷，修复后复跑全绿。

定向fmt/lint对十份改动文件零错误；CursorAdapter.test.ts约1398行一处既有未用参数告警保留未动，不混入本提交。scoped tsgo对本八份源/测试文件零诊断；全仓server tsgo仍有脏工作区既有无关错误（AgentHooks的JSON/ExitCode/Path诊断、ToolBroker未标记Error、CliProxy建议项、server.test.ts缺ByokCatalog上下文等），不属于本主题。CursorTextGeneration.textGeneration以丢弃位置调用applyCursorAcpModelSelection，新返回对象兼容无需改动。

providers.md的ACP目录章节记录三态目录语义（null透传/非空回退/空不下发）、Grok模型透传依据与per-model重读决策。尚未完成：完全空目录/未知配置的真实客户端草稿与待发行为、目录在编辑器打开期间撤回的三端表现、设置/新任务/命令面板/快捷键入口覆盖及Mobile实机证据；这些为第11项后续增量，不以本轮单测/适配层证据替代。提交前后核验：原83个无关基线文件SHA一致，15个相对基线变更文件均为既往已提交主题产物且与本提交无交集，BYOK/ChatView/ChatComposer混合hunk及92项原未提交状态保留。

受控环境后端重启恢复实测已完成（独立dev-runner隔离home、driver=acpAgent经GenericAcpDriver→makeCursorAdapter走同一代码）。临时把保留fixture wrapper换成读取catalog-acp-restore77-control.json环境注入的等价版（原字节SHA08d14bb66f352c7c0dbc14fdc73103285c3cb3432b52032db77a8583fb7a4faf已备份并于实测后恢复，SHA复核一致）；mock spawn沿用candidate副本。真实CLI驱动走bin.ts的agent run/send/wait WS RPC，每次新一次性配对令牌（回环无bearer、401拒绝直接/ws）。首回合agent run --model dynamic-default在提交前启动的watch子进程PID126656上复现与生产线程完全相同的失败：Invalid value "dynamic-default" for session config option "model"、session/prompt未达CLI（phase1请求日志仅initialize/authenticate/session/new）、规范用户消息落库、projection session error+provider.turn.start.failed——该结果作为同线程前置失败保留，不以成功覆盖。

之后node --watch未对mtime/内容变更重启（Windows侧既有行为），仅终止已确认归属子PID126656后supervisor不再自动重生；改由手动spawn node src/bin.ts（CODEWORK_HOME=隔离、CODEWORK_PORT=13774、PID88448）接替，端口与环境ID不变，devRunner/原supervisor仍存活但此后端不再受watch管理，已记录为环境拓扑差异。第二次agent send在新代码上session/new取得标准目录：请求日志中set_config_option仅mode=code、零dynamic-default、session/prompt送达合成文本，projection落runtime.warning“模型选择「dynamic-default」已不在当前CLI模型目录中，本次改用「default」”，回合completed、session ready、last_error空。第三次send同会话第二个prompt同样completed且未重复告警（会话模型已对齐实际下发值default，线程级用户选择仍显示dynamic-default属草稿层原值）。证据catalog-acp-restore77-{proof.json,req-phase1.log,req-phase2.log,control-final.json,wrapper-original.cjs}存于证据根目录。边界：前一轮恢复经由session/new（首轮未落provider_session_id），本轮补充session/load原生续接变体实测并已通过；两轮均为本机合成后端重启，不是外部provider账号或跨机relay验证。

补充session/load变体实测（同环境、同一控制文件wrapper机制）：首轮以标准目录+composer-2建会话，provider_session_runtime持久化resume_cursor{sessionId:mock-session-1}；控制文件切CODEWORK_ACP_STARTUP_CONFIG=explicit后杀掉自建后端PID88448并同配置重生（真实后端进程重启，ACP子进程随之消亡）。第二次send经ensureSessionForThread检测死会话后携resumeCursor走session/load：load结果先广告标准目录（model含composer-2），startupMetadata随后以config_option_update翻转为动态目录。请求日志顺序证实set_config_option(model=composer-2)在其仍属合法目录时派发一次（非撤回后误派发），sendTurn二次应用时目录已变为engine动态集，composer-2撤回→runtime.warning“模型选择「composer-2」已不在当前CLI模型目录中，本次改用「dynamic-default」”→set_config_option(engine=dynamic-default)+operation=code→prompt送达完成。第三次send零配置写入仅prompt、未重复告警，session ready、last_error空、三组用户/助手消息完整。证据catalog-acp-restore77-load-{a.log,b.log,proof.json,control-final-load.json}保留；wrapper与控制文件已恢复/删除，后端PID88448重生进程保留供后续矩阵使用。

## 78. Web 草稿有效模型状态按当前会话目录对齐的回归覆盖

基线含第77主题提交1b58b6f80。本轮为第11项“完全空目录/未知配置的客户端行为、编辑器打开期间目录撤回”增量的 Web 侧证据：只新增回归测试与文档，未改生产源码。结论为既有行为已正确，此前缺口是覆盖而非实现。

`deriveEffectiveComposerModelState`（composerDraftStore）此前无任何定向用例。新增 describe 覆盖六条：持久化草稿模型被会话目录撤回后解析为同实例默认项；目录无默认项时取首项；完全空目录不借用其他实例模型，落空到驱动静态默认（cursor→auto）；草稿中已消失实例的选择不串入选中实例且其选项不进入选中实例派发键；实例 `customModels` 配置的自定义模型在目录撤回后保留（与服务端 Grok `session/set_model` 自定义透传语义一致）；撤回模型与撤回 `acpMode` 模式值经 `deriveEffectiveComposerModelState`→`getComposerProviderState` 组合后同时校正，派发选项只含当前目录有效值。

开发中曾出现的两条红测是测试夹具缺陷而非产品缺陷：会话快照负载缺 `capabilities` 必填字段（`ServerProviderModel` 要求 NullOr），`decodeModels` 解码失败导致快照被忽略，旧目录继续生效——同时印证了畸形负载不替换最近合法快照的既有语义。补齐字段后全绿。

派发链路复核：`ChatView` 以 `applySessionModelCatalogs(serverConfig.providers, activeThread.activities)` 响应式合并目录，`useEffectiveComposerModelState`→`getComposerProviderState`→`selectedModelSelection` 全部消费合并后目录；模型选择器打开期间目录活动到达时选项随 `providerStatuses` 即时收敛（useMemo 依赖活动列表）；待发/排队条目仅携带 messageId/text/createdAt，不携带冻结 modelSelection，分发时由 adapter 边界按当时目录对齐（第77主题）。`thread.turn-start-requested` 负载的 modelSelection 是发送时点的已校正值。

`apps/web/src/composerDraftStore.test.ts` 共 87 项通过（新增 6 项），`.t3` 两份隔离副本 81 项亦过；vp check --fix 后该文件 fmt/lint 零告警；Web 目标 tsgo --noEmit 仅有脏工作区既有无关诊断（WorkspaceLayout/useResizableWidth 的 setWidth、AgentToolsSettings 的 cryptoRandomUUID），本文件零错误。

边界：本轮为 Web 纯函数层证据。设置/新任务/命令面板/快捷键入口、真实客户端 UI 下“编辑器打开期间目录撤回”的端到端表现、Mobile 实机操作证据仍属第11项开放矩阵；整体39项与comparison继续。

## 79. 检查点回退拆分为 conversation / files / both

基线含第78主题提交2413d8fc1。本轮落实comparison第6项“更细的能力声明”中的 rewind 三态拆分（第14项的一部分）：合同新增 `ThreadCheckpointRevertScope`（conversation/files/both），`thread.checkpoint.revert` 命令、`thread.revert.complete` 内部命令、`thread.checkpoint-revert-requested` 与 `thread.reverted` 事件全部携带可选 scope；持久化旧事件无该字段一律按 both 解释，协议向后兼容。

语义：both 保持既有完整行为（恢复文件+回退 provider 对话+裁剪投影）。files 只还原工作区：经 `WorkspaceOperationLock` 作用在线程配置工作区（无 provider 会话时回退到 thread/project 配置 cwd），仍做 git 工作区校验、同工作区忙碌扫描、恢复检查点与 index 备份；不调 `rollbackConversation`、不查 `threadRollback` 能力、保留目标之后的检查点 ref（对话仍引用这些回合）；`thread.reverted` scope=files 在内存 projector、SQL ProjectionPipeline 全部五个处理器与客户端 threadReducer 中均为不裁减语义，仅刷新 updatedAt；reactor 追加 `checkpoint.reverted` 活动（经 activityFailureMessages 映射到三端本地化文案）供用户可见。conversation 只回退对话：跳过全部 git 步骤（无工作区扫描、无 index 备份、无恢复检查点），仍要求绑定 provider 会话且具备 threadRollback，无会话或不支持时失败关闭、不落任何文件副作用；失败分支不做文件补偿，仅报告对话回退未完成或“服务商已回退但本地历史提交失败”。

decider 既有守卫（本线程 session starting/running/activeTurn/排队时拒绝）对三个 scope 一致生效，conversation scope 下在途回合不可能被回退。Web 端消息行回退按钮改为菜单（both/conversation/files 三项），`localApi.dialogs.confirm` 按 scope 显示对应标题与后果说明；Mobile 端 `UserMessageActions` 改用 `ControlPillMenu`（iOS 原生 UIMenu / Android `AndroidAnchoredMenu`），Alert 确认框同样分 scope 文案，`isRevertingCheckpoint` 期间菜单项禁用。Desktop 复用 Web 路径。

测试：CheckpointReactor.test.ts 新增 4 项 scope 用例（files 仅还原工作区保留对话与检查点索引、conversation 仅回退对话不动文件与 git ref、files 无 provider 会话仍可还原、conversation 无会话拒绝且不触碰文件），全部用 `effectIt.effect` 风格，文件累计 37 项；threadReducer.test.ts 新增 files 不裁减用例；MessagesTimeline 既有测试在签名变更后复跑通过。定向套件：server 侧 12 文件 349 项、web/client 6 文件 256 项、mobile threads 目录 66 文件 489 项全部通过。18 份改动文件 fmt/lint 零错误；scoped tsgo 对合同/server 改动零诊断，web/mobile 仅剩脏工作区既有无关错误（Stack.tsx 引用未跟踪的 SettingsAgentToolsRouteScreen 等）。

文档：providers.md 回退段落记录三态语义与文件/对话失败补偿边界；source-control.md 用户文档更新为三种范围说明（对话回退仍仅 Codex，文件还原不需要 provider 会话）。边界：conversation scope 的真实 provider 回退仅 Codex 适配器声明 threadRollback，其余适配器在能力检查处失败关闭（未新增声明）；无浏览器/实机验收；legacy 命令与事件不带 scope 时行为与旧版完全一致已由 both 路径回归覆盖。第14项其余能力（streaming/reasoning/MCP/persistence/sessionModelSwitch 三态）与设置页真实能力门控仍为开放条目。

## 80. sessionModelSwitch 三态与 restart-continue 续接确认

基线含第79主题提交646550fda。本轮落实comparison第6项能力声明与第98行 `ConfirmsModelSwitch.switchRestarts` 的移植：合同与适配器边界把 `ProviderSessionModelSwitchMode` 扩为三态 `in-session | restart-continue | unsupported`——in-session 在活会话上直接下发模型；restart-continue 重启 provider 会话但经 resumeCursor 续接对话；unsupported 重启进入全新对话（原“需要新会话”语义）。

适配器声明：Antigravity 由 unsupported 改为 restart-continue，因其每回合 spawn 新 `agy -p` 进程、会话经 `--conversation <id>` 续接；`startSession` 现在从 `resumeCursor`（`{schemaVersion:1, conversationId}` 自有形状，异构/畸形游标安全回退为新会话）恢复 conversationId，随后 sendTurn 以 `--conversation` 续接。其余适配器（Byok/Claude/Codex/Cursor/Grok/OMP/OpenCode/Pi/ZCode）保持 in-session；Grok 的 `requiresNewThreadForModelChange` 展示位语义不变，服务端在切模型时仍硬拒绝。

编排：`ProviderCommandReactor` 对 restart-continue 的模型切换触发会话重启，但保留 `activeSession.resumeCursor` 且不置 `freshConversation`；unsupported 重启仍丢弃游标并 `freshConversation: true`；`input.modelSelection` 缺省时 in-session 之外的声明都沿用 `activeSession.model`，避免重启续接路径误改模型。快照链路：`ProviderSnapshotSource.sessionModelSwitch` 由 `buildSnapshotSource` 从 `adapter.capabilities` 盖章，`correlateSnapshotWithSource` 把它合进每份 `ServerProvider` 快照（可选字段，旧快照缺省安全），客户端因此看到真实适配器声明而非手工展示位。

客户端门控共享化：`client-runtime/providerModels.ts` 新增 `startedSessionModelChangeGate`，返回 `blocked | confirm-restart | null`——会话未开始、跨实例或同模型返回 null；`requiresNewThreadForModelChange`（current/next 任一）返回 blocked；`nextProvider.sessionModelSwitch === "restart-continue"` 返回 confirm-restart。Web `getStartedThreadModelChangeBlockReason` 改为委托该函数；`onProviderModelSelect` 在 confirm-restart 时经 `localApi.dialogs.confirm` 询问后再写入草稿选择。Mobile `ThreadComposer` 的设置会话 `onSelectModel` 走同一门控：blocked 弹 Alert 说明、confirm-restart 弹带“切换模型”按钮的确认 Alert——Mobile 此前连 `requiresNewThreadForModelChange` 硬阻断都没有，本主题一并补上。三端 en/zh/ja 文案齐备。

测试：ProviderCommandReactor.test.ts 新增 restart-continue 用例（第二次 startSession 携带上一会话 `resumeCursor: {opaque:"resume-1"}` 且非 freshConversation），全文件 68 项通过；AntigravityAdapter.test.ts 新增续接用例（startSession 恢复 conversationId、spawn argv 断言 `--conversation conv-restored`、能力声明为 restart-continue），5 项通过；providerModels.test.ts 新增 4 项门控用例（未开始/confirm-restart/requiresNewThread 优先/同模型跨实例不触发），17 项通过；ChatView.logic.test.ts 66 项、ProviderRegistry.test.ts 53 项回归通过（修复了测试桩无 capabilities 时的防御性读取）。17 份改动文件 fmt/lint 零告警；server/client-runtime/contracts/web/mobile 作用域类型检查对本主题文件零诊断。

边界：restart-continue 的确认是选择时点的客户端确认，若确认后另一客户端先改了模型，服务端仍以当时的 resumeCursor 续接（对话不断，模型值以最新选择为准）；无浏览器/实机验收，Web/Mobile 确认路径由共享纯函数 + 各自接线覆盖；streaming/reasoning/MCP/persistence 声明仍开放，见comparison第6项。

## 81. 真实能力声明：streaming / reasoningStream / mcp / persistence

基线含第80主题提交933b9c6d3。本轮把comparison第6项剩余的能力标志落地为诚实声明：`ProviderAdapterCapabilities` 新增 `streaming`（回合内增量 content.delta）、`reasoningStream`（reasoning_text / reasoning_summary_text 增量）、`mcp`（会话注入 Code Work 托管 MCP 桥，即消费 McpProviderSession）、`persistence`（会话经 resumeCursor 跨重启恢复）四个可选布尔。

真值表经逐适配器核对而非统一置真：streaming/persistence 全部适配器成立（每家都发 content.delta、都解码应用 resumeCursor）；reasoningStream 仅 Antigravity 不声明——ACP 运行时透传 agent_thought_chunk（Cursor/Grok/acpAgent），ZCode/OMP/Pi/OpenCode 各有原生推理增量，Claude 透传 thinking 块，Codex 发推理项，Byok 发 reasoning_summary_text；mcp 仅 Claude/Codex/Cursor/Grok/OpenCode/Pi 声明——这六家在会话建立时读取 McpProviderSession 并把 code-work MCP 端点注进 CLI 会话，Antigravity/OMP/ZCode 不消费，Byok 的 MCP 工具走 composition 工具注册表（独立路径，不消费会话凭据）。

服务端消费点：`ProviderService.prepareMcpSession` 改为仅对 `capabilities.mcp === true` 的适配器签发 MCP 凭据——此前对每个会话无条件签发，未消费适配器的令牌空挂。客户端透出：`ProviderSnapshotSource.adapterCapabilities` 盖章进 `ServerProvider` 快照（新增 supportsStreaming/supportsReasoningStream/supportsMcp/supportsSessionResume 可选布尔），未声明的标志落为明确 false；会话恢复路径与首次建立路径行为一致。

测试：ProviderService.test.ts fake 适配器支持能力覆盖并新增“未声明 mcp 不签发凭据”负向用例（48 项通过）；ProviderRegistry.test.ts 新增快照盖章用例（sessionModelSwitch=restart-continue、supportsMcp=false、其余为真；54 项通过）。17 份改动文件 fmt/lint 干净（ClaudeAdapter 一处 3764 行既有 spread 警告系 HEAD 已存在、未触碰）；server/contracts 作用域 tsgo 对本主题文件零诊断（ByokAdapter 1235–1529 行的错误属无关脏工作区 BYOK 改动）。

边界：能力标志当前为透出+服务端消费，三端设置页暂无按这些标志门控的现存控件（模型切换已由 sessionModelSwitch/requiresNewThreadForModelChange 覆盖）；streaming/reasoning/persistence 目前是诚实描述与后续门控的底座，UI 消费待出现对应控件时接入。无浏览器/实机验收。

## 82. 编辑器打开期间目录撤回的选择器组件级收敛证据（第11项）

基线含第81主题提交0f5f325c6。本轮为第11项“目录在编辑器打开期间撤回”的 Web 组件渲染层证据：只新增回归测试与文档，未改生产源码。结论为既有行为已正确，此前缺口是覆盖而非实现。

静态链路复核：`ChatView` 以 `applySessionModelCatalogs(serverConfig.providers, activeThread.activities)` 派生 `providerStatuses`（依赖数组含活动列表，新目录活动到达即重算）→ `ChatComposer providerStatuses` prop → `providerInstanceEntries`/`modelOptionsByInstance` useMemo → `ProviderModelPicker`/`ModelPickerContent`。弹层内部 `flatModels`/`filteredModels`/`filteredItemKeys` 全部经 useMemo 从 props 派生，无陈旧缓存；`flatModels` 显式跳过 `entryByInstanceId` 中已消失实例的残留选项；`selectedInstanceId`/`expandedLegacyInstances` 是选择器本地 useState，目标实例消失时过滤结果自然收敛为空列表而非崩溃。触发器收敛面：`selectedInstanceOptions.find(slug===model) ?? options[0]`——被撤回的展示模型回退到实例首项；整目录撤空（显式撤回语义、无可校正依据）时回退为选择原值透传。

新增 `ProviderModelPicker.catalog.test.tsx` 五项用例，经仓库既有 `renderToStaticMarkup` 组件测试模式验证真实渲染输出（前后两次渲染重放目录变化）：目录内含所选模型时触发器显示该模型；所选模型被撤回后触发器收敛到实例首项且不再显示撤回名；整目录撤空时触发器原样显示待定选择 slug；实例从 `instanceEntries` 撤回后其边栏 rail 消失；正在查看的实例消失时选择器收敛为空列表而不抛错。

入口覆盖复核：设置面板走 `resolveAppModelSelectionState`；Mobile 组合器 `buildModelOptions(config, selection, activities)` 依赖活动列表、outbox 分发时由 `thread-outbox-model.ts` 合并目录；命令面板/快捷键无独立切模型路径（仅选择器内跳转键）。测试基建边界：LegendList 虚拟列表在 SSR 下不产出行、`ComboboxEmpty` 的 provider-settings `Link` 需要异步 Router 上下文，两者不可静态断言，行级收敛由第78主题的纯函数链路测试与本组件的 props→useMemo 派生结构共同支撑。

验证：新文件 5 项用例全绿（49ms）；`vp check --fix` 零告警；作用域 tsgo 对本文件零诊断（全仓 WorkspaceLayout/AgentToolsSettings 等处错误属脏工作区既有无关改动）。

边界：本轮为 Web SSR 组件级证据，真实浏览器/Electron 交互与 Mobile 实机证据仍属第11项开放矩阵（需用户授权的浏览器验证或物理设备/EAS）。第11项其余矩阵与整体39项继续。

## 83. BYOK 内部网关令牌每次运行轮换（第33项）

基线含第82主题提交63ed624c3。本轮落实 §2.3-8 本机代理安全姿态中尚未满足的一条：内部 BYOK 网关令牌此前经 `getOrCreateRandom` 持久化、跨运行复用，一旦从子进程环境泄漏即长期有效。

实现：`modelGateway.rotateGatewayToken` 每次调用重写 `byok-gateway-token` 密钥并返回新值；`CliProxy.rotateGatewayTokenForRun` 先读当前 settings、再轮换令牌、最后用 `refreshLocalPoolInstanceAdapters(settings, {origin, token})` 把持久化在 BYOK 实例 `config.adapters` 里的池适配器重盖章到本次运行的 origin/token；`CliProxy.layer` 构建期调用——路由图物化先于 `commandGate.signalCommandReady`（`awaitAuxiliaryParked` 等待 `routesReady`），命令门保证没有任何会话 spawn 或网关请求能在轮换完成前执行，`ensureGatewayToken` 之后的每次调用（spawn 注入 env、connectByok、请求鉴权）拿到的都是本次运行的新值。

配套修正：`refreshLocalPoolInstanceAdapters` 的 connection 参数改为显式传入时即为权威坐标——此前 anchor 适配器上的旧 apiKey/baseURL 优先，令牌轮换与端口漂移（dev 端口自动偏移）都无法借此收敛；不传 connection 的内部调用语义不变。

审计确认的既有满足项与有意不适用项：只应答带令牌请求（`readProvidedToken` + `timingSafeTokenMatch`，缺省/错误均 401）与请求时读取上游密钥（每请求读 settings、`ensureLocalAccountCredential` 每次尝试读凭据、外部 key ring 每请求重读）为既有行为复验通过，本轮未改。回环监听与随机端口按有意设计不适用：网关是主 HTTP listener 上的 `/byok-gw/*` 路由，远程/隧道客户端依赖同一监听，令牌是访问边界；已在对比文档记录该取舍。

测试：CliProxy.test.ts 新增用例——上一轮令牌与 origin 烘焙的池适配器在 `rotateGatewayTokenForRun` 后全部携带新令牌与新 origin，自有适配器不受影响，`ensureGatewayToken` 返回新值；CliProxy 27 项、LocalAccountPool 21 项通过。三份改动文件 fmt/lint 零告警（CliProxy.test.ts 731 行既有 schema-compile 警告未触碰）；server 作用域 tsgo 对本主题文件零诊断。

边界：共享 home 的多 dev server 仍是“后启动者覆盖”语义（持久化适配器原本就绑定单一 origin/token，轮换不改变这一点）；轮换失败仅记警告、不阻塞启动，此时旧令牌继续可用为有意弱降级；外部 Agent key ring（LocalGatewayKey）是用户管理的持久凭据，不随运行轮换；真实网关请求的红/绿验收（旧令牌 401、新令牌 200）属受控运行证据，本轮为服务级单测覆盖。第11项与完整39项继续。

## 84. 本地账号池会话粘滞与额度换绑（第32项）

基线含第83主题提交2f01f1776。对照上游 `CodexBalancer`：同一会话尽量停在同一账号（提示缓存与加密推理绑定账号）、额度/故障才换绑、会话记忆上限 2000。Code Work 此前 `pickLocalAccount` 纯按策略（round-robin/fill-first/weighted）逐请求选号，没有会话亲和——多账号池下同一 Codex 线程的相邻 Responses 请求会交替落到不同账号，`previous_response_id` 续接与提示缓存连续性都被打散。

实现分三层。提取（modelGateway）：`extractGatewaySessionKey` 从请求取粘滞键，优先级对齐上游——`x-session-id` 头、Responses `previous_response_id`、`session_id`、`conversation_id`、`prompt_cache_key`、`metadata.user_id`、`user`；GET/无 body/非 JSON 请求无键，行为不变。挑选（LocalAccountPool）：`pickLocalAccount` 新增可选 `sessionKey`——绑定账号仍在候选内（启用、模型匹配、未冷却、未被 triedLocalIds 排除）时直接命中且不推进轮询游标；否则走原策略挑选并把结果换绑。换绑天然接上既有重试：账号失败冷却后下一轮绑定检查落空，重新挑选即重绑到新账号。容量：LRU Map 上限 `LOCAL_POOL_SESSION_AFFINITY_CAPACITY = 2000`，超出逐出最旧绑定；绑定为进程内状态，重启后首轮重新分配——与上游 in-memory TTL 语义一致。

验证：LocalAccountPool.test.ts 新增三例（同会话六连选同账号且新会话仍轮询、冷却/候选外换绑、2000 容量逐出）；modelGateway.test.ts 新增 `extractGatewaySessionKey` 三例（header 优先、字段优先级、无键场景）；modelGateway.local.runtime.test.ts 新增两例真实 HTTP 冒烟（同 session_id 两请求落同一上游凭据、绑定账号 401 后换绑并停留）——首跑曾暴露测试账号复用导致上一用例冷却污染，已按文件惯例改用独立 codex-sticky-\* 夹具。三文件 + LocalAccountPool 共 311 项通过；改动文件 fmt/lint 零告警，server 作用域 tsgo 对本主题文件零诊断。

边界：粘滞只在本地官方账号线路生效，中转 BYOK 通道无账号概念；CursorDriver 的 spawn 时取号（`resolveSessionEnvironment` 不带会话身份）维持逐次轮询，若后续把会话/线程身份穿进 spawn 环境解析可再绑定；无会话键的请求行为完全不变。第11项与完整39项继续。

## 85. BYOK 翻译兼容五项清单核对（第31项）

基线含第84主题提交0dad58079。对照 §4.2-9 的 BaoCode 翻译清单逐项核对 `modelGateway` 双桥（AnthropicBridge：Messages→chat/completions；ResponsesBridge：Responses→chat/completions）的测试覆盖。

核对结论：流式分块边界已有双向用例——Anthropic 侧 `push` 中途截断 JSON 行（pending 行缓冲），Responses 侧 SSE 数据行跨块且正文只出一次；思考块与签名处理已有覆盖——请求侧 thinking/signature 与 redacted*thinking 均无 Chat 对应物按设计丢弃（本轮在丢弃用例中显式补入 redacted_thinking 块），响应侧 reasoning_content 不落盘；工具调用 id 双向往返已有——toolu*→tool_calls→tool_call_id 保序、流式 call_1 保留上游 id、Responses call_id 回环与不合规函数名映射；count_tokens 走 `estimateAnthropicPromptTokens` 本地估算不发上游，system/text/tool_use/tool_result 均计入，已有用例。

唯一缺口是「上游无 usage 时的兜底」：两个桥的 `usageOf`/`chatUsageOf` 对缺省字段回退零值，但此前无断言。本轮补三例——Anthropic 非流式缺 usage → `{input_tokens:0, output_tokens:0}`；Anthropic 流式全程无 usage chunk → message_start/message_delta 均为零值且 stop_reason 正常收口；Responses 非流式与流式缺 usage → completed 响应 `{input:0, output:0, total:0}`。行为本身已正确，本轮属回归证据补齐。两测试文件 63 项通过，fmt/lint 零新增告警。

边界：五项清单的「账号粘滞与额度用尽切换」已由第84主题（同 commit 线）在网关请求层落地；桥接覆盖范围以 BRIDGEABLE_ANTHROPIC_PATHS 与 Responses 转换白名单为界，白名单外端点保持原生直通，不属于翻译面。第11项与完整39项继续。

## 86. MCP 注入失败关闭与 options 深合并核对（第18项）

基线含第85主题提交14ae7c171。第18项三个子项：草稿无 session 已由第43主题落地；本轮完成其余两项。

MCP 失败关闭（对照项 §2.2-10）：审计发现真实失败开口——`issueActiveMcpCredential` 在 `McpSessionRegistry.layer` 未物化时返回 undefined，`prepareMcpSession` 静默继续，声明 `mcp` 的适配器随即在无注入桥的状态下 spawn。本轮改为失败关闭：签发返回 undefined 时以 `ProviderAdapterProcessError` 拒绝 startSession/恢复路径，会话不会在没有服务端凭据绑定的状态下运行。预批准语义核对：Claude 经 `canUseTool`（full-access 直接放行、其余模式走用户审批）；Codex/Cursor/Grok/OpenCode/Pi 以配置注入本身构成对精确 server `code-work` 的批准；服务端 bearer+thread+capability 作用域兜底。测试侧：`makeProviderServiceLive` 包装默认桩模拟 registry 存活签发（生产 server.ts:893 常驻物化），显式 option 覆盖；新增负例断言签发不可用时 startSession 以 ProviderAdapterProcessError 失败。ProviderService 49 项全绿。

options/profile 深度合并（对照项 §2.2-8）：核对为等价实现——`applyServerSettingsPatch` 经 `deepMerge` 递归合并（对象递归、数组/标量/null 替换、undefined 跳过）；`providerInstances` 整表替换是显式设计决定（合同注释：地图小，半合并状态比整表提交更危险，UI 每次提交完整 map）；实例 `config` 是 `Schema.Unknown` 不透明 blob 原样持久化，驱动每次启动用自带 schema 解码套用最新缺省——「只持久化 agent 自己的部分、缺省改动下次启动生效」语义成立；上游的 provider profile 继承在 Code Work 无对应概念，`backgroundActivityProfile` 已有 baseProfile+overrides 继承机制。无需代码改动。

边界：失败关闭只覆盖「声明 mcp 但签发不可用」的内部前置违约；上游「无法预批准精确注入 server/工具时拒绝无人值守执行」在 Code Work 由注入即批准+服务端凭据门控表达，无额外预批准协议可落。第11项与完整39项继续。

## 87. steer 全契约与排队/steer 行为（第12项）

基线含第86主题提交6c5ad283f。对照 §2.2-2 的 steerActiveTurn 契约：适配器声明、不支持回退打断后替换、出错不重试、打断丢弃未读 steer、上游“排队或 steer”UI。

契约与能力：`ThreadTurnStartCommand`/`ClientThreadTurnStartCommand`/`ThreadTurnStartRequestedPayload` 增加可选 `steer`，decider 透传 `steer===true`；`ProviderAdapterCapabilities.steer` 声明“回合运行中 sendTurn 送入存活回合”，六个真实支持的适配器（Codex/Claude/Cursor/Grok/OpenCode/BYOK，BYOK 经 steerWindow 把文本并入循环下一轮）声明为 true，Antigravity/Omp/Pi/ZCode 诚实不声明；`ProviderRegistry` 把声明盖进 `ServerProvider.supportsSteer` 快照供三端消费。

Reactor 语义：`pendingSteerMessageIds` 追踪所有未被 provider 读取的 turn start；`heldTurnStarts` 按线程 FIFO 停放非 steer 适配器上回合中到达的普通请求，回合结束/会话就绪时排空——死条目（已取消）跳过不卡队，打断时间戳 `lastTurnInterruptedAt` 丢弃打断前到达的迟到输入；steer 适配器的回合中发送直接投递，provider 返回同一 activeTurnId 时重发 session-set 由投影把 pending 行折叠进该 turn 清除；显式 `steer:true` 在非 steer 适配器上先 provider interrupt、`discardUnreadSteer(threadId, except=替换消息)` 丢弃其余未读输入、再以新回合送达替换消息；sendTurn 失败走既有 `recoverTurnStartFailure` 单次定案，结果不明确故绝不自动重试；`processSessionSet` 在会话停/错时丢弃停放输入；队列排空走 skip-dedupe 路径避免去重吞掉重放；投影 `appendPendingTurnStart` 先删同 messageId 旧行再插入，steer 重发/outbox 重试不再产生双排队行。

三端 UI：Web 的 steer 动作由“BYOK 线程专属”改为按 `supportsSteer` 能力门控（BYOK 入口保持、另五家放开），仅对无附件纯文本排队行开放（localStorage 重建路径保不了附件），成功撤下本地队列、失败保留并 toast；Mobile 在排队横幅的服务端排队行上新增引导/取消，`onSteerQueuedMessage` 从 `selectedThreadDetail.messages` 重建原文与附件、复用原 messageId 发 `steer:true`，同样按能力门控；新增 queuedSteer.\* 三语字符串。Desktop 复用 Web 实现无独立改动。

验证：ProviderCommandReactor.test.ts 新增五例——非 steer 适配器停放+回合结束排空、steer 适配器投递+pending 行采纳、显式 steer 打断后替换、send 失败不重试且回合定案、打断丢弃停放输入并过滤迟到到达；既有三例按旧语义（回合中发送直送）的用例经 createHarness `steer:false` 显式声明继续通过；全文件 73/73 通过。scoped lint 对改动文件零告警；server/web/contracts/client-runtime 作用域 tsgo 对本主题文件零诊断（仓内其余既有无关报错与 mobile 导航类型问题保持原状）。

边界：排队停放与打断丢弃是进程内记账，重启后 pending 投影行仍在但无 held 状态，重放行经同 messageId 投影替换收敛；Mobile 的“排队中”语义统一走 outbox（本地待发）与服务端 parked 行（服务端已收待读）两层，UI 已对后者渲染独立操作；真实 provider 会话的端到端 steer（各 CLI 的回合中输入注入语义）由各适配器既有驱动保证，本轮证据止于适配器接口层。第11项与完整39项继续。

## 88. managed-process registry：provider 衍生进程登记与启动对账（第16项）

基线含第87主题提交233deb95d。对照 §2.2-7 与矩阵第16项，按 Paseo 同构契约落地 Code Work 账本。

账本：`src/process/ManagedProcessRegistry.ts`——每进程一条 JSON 记录（`<stateDir>/managed-processes/<id>.json`，经 `writeFileStringAtomically` 原子写），字段含 owner(provider/kind)、pid、command、args、metadata、平台进程身份(commandLine+startedAt)与 createdAt；`ManagedProcessRecordJson` Schema 编解码往返，单条损坏/半写记录告警跳过不阻断整体对账。

身份与平台检查：`makeManagedProcessTable`——POSIX `ps -ww -p <pid> -o lstart= -o command=`（lstart 定宽24字符切片），Windows `powershell Get-CimInstance Win32_Process` 取 CommandLine/CreationDate；PID 非正整数直接 not-found，检查失败走 error 分支不盲目处置。`processIdentityMatches` 顺序：双端 startedAt 俱在→先比时间戳、一致再以命令行确认；双端 commandLine 俱在→规范化全等；否则退化为 command+args 连续签名包含——散词命中不算匹配（测试例 `grep opencode notes/serve--port=6767.txt` 不误杀）。

对账语义（`reapStale`，接 `reconcileProviderSessions` 起点、孤会话标记之前，账本失败不阻断会话对账）：死 PID 删记录；活 PID 身份匹配→终止→删记录（POSIX 先进程组后单 PID、SIGTERM→5s 轮询→SIGKILL→1s；Windows `taskkill.exe /pid /t /f`）；身份不匹配只删记录不杀进程；检查/终止失败保留记录并计入 errors 留待下次启动。

登记点（owner 语义化、登记失败不阻断 spawn、scope 关闭/进程退出即撤记）：Codex app-server（session-transport）；共享 ACP 传输经 `AcpSessionRuntimeOptions.owner`——Grok/Cursor 适配器传入各自 PROVIDER，GenericAcpDriver 经 `options.provider` 覆盖正确归属，Provider 目录探针不传 owner 不登记；Pi 系 JSONL 传输经 `spawnPifamilyProcess` owner——Omp/Pi/ZCode 传入；OpenCode helper server（`opencode serve`，helper-server，metadata 记端口）；Antigravity 回合传输（turn-transport，`ensuring` 撤记）。Claude 走 SDK 内部 spawn 无直接句柄，诚实排除。`server.ts` 在 RuntimeCoreDependencies 链 provideMerge 一次账本（共享外层 ProcessRunner），`reconcileProviderSessions` 以 `serviceOption` 可选消费——未装配环境行为不变。

验证：`ManagedProcessRegistry.test.ts` 10 例全绿——写读往返持久化、死 PID 删记录、startedAt 匹配终止、startedAt 不匹配/命令行不匹配只删不杀、无时间戳时连续签名匹配、散词命中不误杀、检查失败保留+errors、终止失败保留+errors、损坏记录跳过、registry 未装配时 `recordSpawnedChild` 返回 none。scoped tsgo 对 15 个改动文件零诊断（仓内既有无关报错保持原状）；`vp lint`/`vp fmt` 全部改动文件零告警。

边界：spawn 与登记非原子——登记失败仅告警（下次启动按残留对账），记录持久化后进程立刻自然退出由对账清理，与上游同向；无 startedAt 时身份核验上限取决于签名匹配，已按"宁可留记录不误杀"取向设计；三端无 UI 面，远程/隧道共享同一服务端账本；表驱动模拟覆盖对账矩阵，真实 provider 多进程重启场景未跑。第11项与完整39项继续。
