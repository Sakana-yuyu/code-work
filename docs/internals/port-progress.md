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

| 项  | 主题                                                        | 当前状态                                                     | 实现 / 验收入口                                                                                            | 验证结果                                                                                                              |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 通读指定文档与约束                                          | 完成                                                         | 上述七篇文档、根 AGENTS                                                                                    | 2026-10-12 完整阅读                                                                                                   |
| 2   | 全部需核对条目源码基线                                      | 完成                                                         | B01—B22                                                                                                    | 已读取源码并明确边界；不把静态核对当成实现完成                                                                        |
| 3   | 三态输出、默认 paragraph、旧键策略、三端设置                | 完成（本主题定向验收）                                       | settings / AssistantTextBuffer / ProviderRuntimeIngestion / Web/Desktop 设置 / Mobile 设置                 | 工作区 10 文件 / 273 项通过；纯暂存候选 35 项与五个目标类型检查通过；当前脏工作区的完整模块诊断仍记录为未通过，见下文 |
| 4   | 全部客户端增量渲染清单与上游对应提交                        | 完成（九项源码清单、目标验证与代表三端运行）                 | 前缀/代码行/时间线/turn/checkpoint/挂载/投影活动/map/订阅/Mobile                                           | 最新151+56项相关测试；9子项逐一对齐，三端实测与iOS设备边界见第41主题                                                  |
| 5   | 60 ms leading+trailing、每帧提交、完整 store 与揭示切片     | 完成；增量清单、重开与滚动锚点继续随第4/8项验收              | ProviderRuntimeEventCoalescer / ProviderRuntimeIngestion / latestFrame / textReveal / NativeFrameScheduler | 定向与三端受控管线通过；Android 24 帧发布、43 帧字素揭示、全文/选区/终态通过，详见第34/35主题                         |
| 6   | 流式选区与滚动锚点                                          | 完成（DOM保留与手机固定全文等价选择页）                      | Web/Desktop StreamingChatMarkdown；Android/iOS 选择页                                                      | Web/Android实际选区与三端锚点通过，iOS同入口20项/类型通过；UIKit设备未实测，见第35/38/40主题                          |
| 7   | 每个 adapter 终态无 loading                                 | 完成：公共条目与交互终态、定向验证                           | 共享 runtimeTurnItems / 全部 canonical 发射入口 / 原生 Codex 与公共投影                                    | item、审批与提问均先收尾；两端状态、原生 adapter 及投影定向验证通过；详见下文                                         |
| 8   | 重连不重不丢不乱、关闭忙碌流、打开运行线程                  | 完成（共享协议矩阵与三端受控运行验收）                       | ws/state/threads/缓存游标/复合身份/Mobile ThreadFeed                                                       | 五种已准备连接×完成标记两态通过；三端关闭/重开/断线重投、锚点与回尾通过，首绘采用用户确认标准，见第38/39主题          |
| 9   | 同口径帧间隔性能无回归                                      | 三端同口径静态滚动验收通过；流式与连接矩阵归相应条目继续核验 | 1280×720、实际组件输入 1202 活动、上下各 20 页 ×4 组                                                       | Web/Desktop 原 72 窗口保留；Android 原始基线新 24 窗口与 FrameTimeline 通过，两当前轮 16 对应窗口均无回归             |
| 10  | Windows argv 三层守卫                                       | 完成（入口清点与定向验收）                                   | promptArgv / Antigravity 对话及文本生成 / ZCode 最终 spawn                                                 | 4文件26项、旧版失败对照、纯候选目标类型通过；Windows shell边界实测与证据边界见第42主题                                  |
| 11  | 统一 catalog、缓存键、deadline、AbortSignal、无草稿 session | 待实施                                                       | ProviderDriver / provider snapshot 探测                                                                    | 尚未运行                                                                                                              |
| 12  | steer 全契约与排队/steer UI                                 | 待实施                                                       | ProviderAdapter / ProviderService / reactor / 三端 composer                                                | 尚未运行                                                                                                              |
| 13  | 规范消息身份与回显对账                                      | 待核验补齐                                                   | decider / normalizer / provider echo                                                                       | B19 为部分底座，验收尚未运行                                                                                          |
| 14  | 细化 rewind/streaming/reasoning/MCP/persistence/切模型能力  | 待实施                                                       | ProviderAdapterCapabilities / server config / 三端控制                                                     | 尚未运行                                                                                                              |
| 15  | prepare/release/dispose 完全停止                            | 待实施                                                       | 生命周期与可见性报告                                                                                       | 尚未运行                                                                                                              |
| 16  | managed-process registry 身份核验与启动对账                 | 待实施                                                       | provider process / persistence / diagnostics                                                               | 尚未运行                                                                                                              |
| 17  | ACP 配置驱动收敛与 help flags                               | 待核验补齐                                                   | GenericAcpDriver / AcpRegistryCatalog / ACP transport                                                      | 尚未运行                                                                                                              |
| 18  | 草稿无 session、MCP 失败关闭、options/profile 深度合并      | 待核验补齐                                                   | 探测 / MCP 注入 / settings 配置                                                                            | 尚未运行                                                                                                              |
| 19  | 排队、快捷键、召回、异步问题、文件回答、secret              | 待核验补齐                                                   | Web/Mobile composer / 用户问题 RPC                                                                         | 尚未运行                                                                                                              |
| 20  | 原生/跨 harness 压缩、发送前 token 芯片、旧线程提示         | 待实施                                                       | B03 / 上下文控制                                                                                           | 尚未运行                                                                                                              |
| 21  | Codex/Claude 原生 goal 与权威状态                           | 待实施                                                       | B05 / provider hooks 或会话状态                                                                            | 尚未运行                                                                                                              |
| 22  | 项目设置覆盖、双选择器、默认权限、子模块限制                | 待实施                                                       | B08 / CodeworkProjectFileLoader / ProjectSetupScriptRunner                                                 | 尚未运行                                                                                                              |
| 23  | 全入口撤销、排序、通知角标、远端项目标记                    | 待核验补齐                                                   | Sidebar / Mobile shelves / 通知服务                                                                        | 尚未运行                                                                                                              |
| 24  | 50 MB 任意附件、HTML/PDF 预览、大粘贴折叠                   | 待实施                                                       | B10 / assets / 三端附件                                                                                    | 尚未运行                                                                                                              |
| 25  | MCP Apps、caller scopes、外部 OAuth、URL                    | 待实施                                                       | B11 / B12                                                                                                  | 尚未运行                                                                                                              |
| 26  | 独立语义权限                                                | 待实施                                                       | B13 / auth / RPC/MCP                                                                                       | 尚未运行                                                                                                              |
| 27  | Limits、跨账号环境、剩余额度与 provider 接入                | 待核验补齐                                                   | B07 / AccountQuota / quota merge / 三端用量                                                                | 尚未运行                                                                                                              |
| 28  | worktree 位置、可取消异步初始化、分支前缀、结案动作         | 待核验补齐                                                   | VCS / setup script / composer bootstrap                                                                    | 尚未运行                                                                                                              |
| 29  | 远程目录、新模型提示、收藏可见性同步                        | 待核验补齐                                                   | B14 / ModelManifest / provider update / settings                                                           | 尚未运行                                                                                                              |
| 30  | 更新续接、按机器项目清理、未知 union、远程兼容范围          | 待实施                                                       | B15 / B16 / B17                                                                                            | 尚未运行                                                                                                              |
| 31  | BYOK 翻译兼容五项清单                                       | 待核验补齐                                                   | modelGateway / AnthropicBridge / ResponsesBridge                                                           | 尚未运行                                                                                                              |
| 32  | 账号粘滞、额度切换、记忆容量                                | 待核验补齐                                                   | LocalAccountPool / modelGateway 本地线路                                                                   | 尚未运行                                                                                                              |
| 33  | 回环随机端口、每运行令牌、请求时密钥                        | 待核验补齐                                                   | CliProxy / LocalGatewayKey / modelGateway                                                                  | 现网关复用 HTTP listener、令牌持久化；尚未满足全部要求                                                                |
| 34  | fragment 四字段导入、重复来源选择                           | 待实施                                                       | Desktop deep link / Web/Mobile 导入 / server import                                                        | 尚未运行                                                                                                              |
| 35  | StepFolds 与编辑/子 agent/计划边界                          | 待核验补齐                                                   | MessagesTimeline.logic / Mobile threadActivity                                                             | 尚未运行                                                                                                              |
| 36  | 富文本代码行引用、句内附件、大粘贴                          | 待核验补齐                                                   | Composer / IDE 选区桥 / Mobile composer                                                                    | 尚未运行                                                                                                              |
| 37  | composer 上方状态集中与真实来源                             | 待核验补齐                                                   | goal / queue / context / health                                                                            | 尚未运行                                                                                                              |
| 38  | 系统通知、声音、角标、托盘后台                              | 待核验补齐                                                   | B09 / Desktop IPC / Web / Mobile awareness                                                                 | 尚未运行                                                                                                              |
| 39  | 跨环境徽标、移除只隐藏、默认当前环境                        | 待核验补齐                                                   | 环境注册表 / 选择器 / 项目与草稿状态                                                                       | 尚未运行                                                                                                              |

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
