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

| 编号 | 需核对事项 | 准确现状 | 源码证据与边界 |
| --- | --- | --- | --- |
| B01 | steer 契约 | 缺失 | `provider/Services/ProviderAdapter.ts` 只有 `sendTurn/interruptTurn`，没有可选 steer 操作；`ProviderCommandReactor.ts` 处理 turn-start 请求与排队。尚无统一准入、回显对账和未读 steer 清理契约。 |
| B02 | rewind 保留文件 | 部分实现 | `contracts/src/orchestration.ts` 的 `ThreadCheckpointRevertCommand` 仅有 `turnCount`；`CheckpointReactor.ts:923` 总是先恢复文件检查点，再回退 provider 对话。Codex 支持对话回退，但缺保留文件变体。 |
| B03 | 发送前压缩 | 部分实现 | `ChatComposer.tsx:2491` 手动注入 `/compact`；`ClaudeAdapter.ts` 接收 compact boundary 和自动压缩上下文用量，BYOK 有摘要命令。没有等价的发送前压缩 token 芯片和旧线程发送提示。 |
| B04 | provider 原生斜杠命令 | 部分实现 | `ClaudeProvider.ts:789` 从 SDK initialization commands 读取；Cursor/Grok 在会话加载时读 ACP available commands；BYOK 有独立命令表；`CodexProvider.ts:686` 仅固定 review/feedback。需要统一发现并补齐客户端与 provider 支持决定。 |
| B05 | `/goal` 与权威状态 | 部分实现 | 有 `ThreadGoalStore`、类型化 RPC、Web `ThreadGoalStatusBar` 和 Mobile `ThreadGoalRouteScreen`；`ProviderRuntimeIngestion.ts:1423` 用 `scanGoalMarkers(text)` 决定终止，完成后清除 goal。不是 Codex/Claude 原生 hooks/会话文件状态。 |
| B06 | 思考轨迹 | 部分实现 | Web `MessagesTimeline.logic.ts:1287` 渲染 reasoning-summary；Mobile `threadActivity.ts:362` 明确跳过 `reasoning.summary.delta`。共用事件已存在，但最新思考与三端展示不完整。 |
| B07 | 订阅额度页 | 部分实现 | `usage/AccountQuota.ts` 从 Codex/Claude rate-limit 事件归一化并持久化；Web `UsageSubscriptionPanel`、Mobile `UsageRouteScreen` 使用账号额度；跨环境有 `shared/accountQuotaMerge`。当前按 provider 合并、主要展示已用，尚缺独立 Limits、跨账号身份和完整剩余视图。不是缺少所有订阅额度能力。 |
| B08 | 项目级设置覆盖 | 部分实现 | `ProjectSettingsPanel` 和 Mobile `ProjectSettingsRouteScreen` 有项目默认模型、工作区模式与脚本；`orchestration.ts` project 字段不包含通用 server settings override。缺 scopable server settings、环境/项目双选择器与新线程默认权限覆盖。 |
| B09 | 通知 / 声音 / 角标 / 托盘 | 部分实现 | Mobile `features/agent-awareness` 有通知注册、权限和导航；Web 侧栏有完成/唤醒标记；Desktop `ElectronTray` 与 `DesktopWindow.ts:600` 支持关闭窗口隐藏到托盘。缺三端统一的完成/需要输入系统通知、声音与系统角标链。 |
| B10 | 附件类型与预览 | 部分实现 | 合同已有 image/audio/file 与 provider 输出二进制附件；`ChatFileAttachment` 上限沿用 10 MiB，发送上传形状主要是图片。`AttachmentUpload` 有签名上传与过期清理。缺用户任意文件 50 MB、完整 PDF/ZIP 发送与 HTML/PDF 内联预览、大粘贴文本附件。 |
| B11 | MCP 应用渲染 | 缺失 | `McpHttpServer` 提供 provider-scoped bearer 工具，现有 canvas/preview 不是通用 MCP Apps 的 `ui/resource` 宿主；当前客户端没有 MCP Apps 生命周期和 HTML 应用 RPC 桥。 |
| B12 | MCP OAuth / URL / caller 权限 | 部分实现 | 已有 provider-scoped MCP 凭据与 `McpInvocationContext`；现有外部 MCP 配置/认证能力不能代替环境 MCP 的外部 agent OAuth、可复制 URL 与逐工具 caller 权限声明。需补完整入站链。 |
| B13 | RPC 权限粒度 | 部分实现 | `auth.ts` 的 read/operate、terminal:operate、review:write、access 与 relay scopes 已完整映射 RPC；`RpcAuthorization.ts` 把文件写、VCS、设置、浏览器控制等放在 orchestration:operate，终端观察也用 terminal:operate。缺目标要求的独立语义 scopes。 |
| B14 | 远程模型清单 | 部分实现 | `ModelManifest.ts:33` 远程拉取清单，远程/磁盘/内置三级、TTL、并发刷新；用于现有模型 current/legacy 分类，不等于从远程发现全部新 Claude 模型。CLI 升级通知已有，模型收藏/可见性同步仍需核对补齐。 |
| B15 | 协议未知联合成员 | 部分实现 | ACP `protocol.ts:316` 有 Harn/CodeBuddy 特定扩展；其余 SessionNotification 严格解码，未知 union 变为 parse error。WebSocket 的 `OrchestrationThreadStreamItem` 同样是闭合 union。`server.ts` 已对 config issues、editor、remote targets 使用 `ForwardCompatibleArray` 丢弃未知成员，不能据此认为 thread/ACP 联合成员均可容忍。 |
| B16 | 更新后活动线程恢复 | 部分实现 | `serverRuntimeStartup.ts:530` 检查原生会话是否仍活着，孤儿会话标 error、活动 goal 暂停；Composition 有 startup recovery，但不会自动续接普通活跃 provider 线程。 |
| B17 | 存储清理 | 部分实现 | `attachmentStore.ts:216` 清理过期 pending/.part 上传；投影在删除/回退时清附件，checkpoint 有清理。缺按机器/项目的自动存储保留策略与用户设置。 |
| B18 | 空闲会话回收与预热 | 部分实现 | provider instance 子 scope 关闭会等待其 finalizers；会话有 stopSession/stopAll，结案有条件停止。没有“空闲且不可见 release / 展示前 prepare”的统一 lifecycle 契约。不能把网络 idle timeout 当作 provider 会话回收。 |
| B19 | 用户消息身份与回显 | 部分实现 | `decider.ts:1023` 用 `command.message.messageId` 写唯一用户行，规范身份已具备；provider user item 不被当成助手正文。缺统一显式 `clientMessageId` 对账与 steer 回显合同，不应增加全局文本去重。 |
| B20 | 事件幂等重连 | 部分实现 | 共享 `state/threads.ts:341` 拒绝 `sequence <= lastSequence`，`afterSequence` 续订，snapshot 重置 history epoch；server command id 保证持久幂等。已有核心序号防重，缺目标要求的完整断线/关闭忙碌流/打开运行线程定向矩阵与实际测量。 |
| B21 | argv 与 Windows 路径 | 部分实现 | `AntigravityAdapter.ts:203` 用 `-p prompt`；`ZCodeAdapter.ts:578` 用 `--prompt=text`，其余主传输为 SDK/stdio/HTTP。已有 resolveSpawnCommand 分 `.cmd` 与 exe，但未做 prompt 三层长度守卫。 |
| B22 | IDE 键位 / 线程管理 / 可观测补充 | 部分实现 | 工作台有 VS Code keybinding service 与应用快捷键编辑器，未见 IntelliJ/Sublime/Atom 方案选择；线程有结案/贪睡/归档和手动排序设置，但全入口撤销与跨机器标记待补；`observability/Layers/Observability.ts` 已按配置导出 OTLP trace/metrics，需继续核对主进程日志、总开关与诊断导出。 |

“缺失”只针对该行描述的行为，不是否定其相邻能力；以上是静态源码核对，不是功能完成验收。

## 阶段 1—5：完整交付与验收台账

| 项 | 主题 | 当前状态 | 实现 / 验收入口 | 验证结果 |
| --- | --- | --- | --- | --- |
| 1 | 通读指定文档与约束 | 完成 | 上述七篇文档、根 AGENTS | 2026-10-12 完整阅读 |
| 2 | 全部需核对条目源码基线 | 完成 | B01—B22 | 已读取源码并明确边界；不把静态核对当成实现完成 |
| 3 | 三态输出、默认 paragraph、旧键策略、三端设置 | 完成（本主题定向验收） | settings / AssistantTextBuffer / ProviderRuntimeIngestion / Web/Desktop 设置 / Mobile 设置 | 工作区 10 文件 / 273 项通过；纯暂存候选 35 项与五个目标类型检查通过；当前脏工作区的完整模块诊断仍记录为未通过，见下文 |
| 4 | 全部客户端增量渲染清单与上游对应提交 | 待核验补齐 | ChatMarkdown / MessagesTimeline / client-runtime reducer / Mobile Markdown | 尚未运行 |
| 5 | 60 ms leading+trailing、每帧提交、完整 store 与揭示切片 | 待实施 | ingestion / client-runtime / 三端渲染 | 尚未运行 |
| 6 | 流式选区与滚动锚点 | 待核验补齐 | Web DOM / Mobile 原生 Markdown | 尚未运行 |
| 7 | 每个 adapter 终态无 loading | 待核验补齐 | 十二类 driver / 各 Adapter 定向测试 | 尚未运行 |
| 8 | 重连不重不丢不乱、关闭忙碌流、打开运行线程 | 待核验补齐 | state/threads / RPC transport / server 订阅 | B20 为部分底座，验收尚未运行 |
| 9 | 同口径帧间隔性能无回归 | 待验收 | 1280×720、约 1200 活动、上下各 20 页 ×4 组 | 未测；历史 2026-09-25 数据不能替代本次 |
| 10 | Windows argv 三层守卫 | 待实施 | Antigravity / ZCode / resolveSpawnCommand | 尚未运行 |
| 11 | 统一 catalog、缓存键、deadline、AbortSignal、无草稿 session | 待实施 | ProviderDriver / provider snapshot 探测 | 尚未运行 |
| 12 | steer 全契约与排队/steer UI | 待实施 | ProviderAdapter / ProviderService / reactor / 三端 composer | 尚未运行 |
| 13 | 规范消息身份与回显对账 | 待核验补齐 | decider / normalizer / provider echo | B19 为部分底座，验收尚未运行 |
| 14 | 细化 rewind/streaming/reasoning/MCP/persistence/切模型能力 | 待实施 | ProviderAdapterCapabilities / server config / 三端控制 | 尚未运行 |
| 15 | prepare/release/dispose 完全停止 | 待实施 | 生命周期与可见性报告 | 尚未运行 |
| 16 | managed-process registry 身份核验与启动对账 | 待实施 | provider process / persistence / diagnostics | 尚未运行 |
| 17 | ACP 配置驱动收敛与 help flags | 待核验补齐 | GenericAcpDriver / AcpRegistryCatalog / ACP transport | 尚未运行 |
| 18 | 草稿无 session、MCP 失败关闭、options/profile 深度合并 | 待核验补齐 | 探测 / MCP 注入 / settings 配置 | 尚未运行 |
| 19 | 排队、快捷键、召回、异步问题、文件回答、secret | 待核验补齐 | Web/Mobile composer / 用户问题 RPC | 尚未运行 |
| 20 | 原生/跨 harness 压缩、发送前 token 芯片、旧线程提示 | 待实施 | B03 / 上下文控制 | 尚未运行 |
| 21 | Codex/Claude 原生 goal 与权威状态 | 待实施 | B05 / provider hooks 或会话状态 | 尚未运行 |
| 22 | 项目设置覆盖、双选择器、默认权限、子模块限制 | 待实施 | B08 / CodeworkProjectFileLoader / ProjectSetupScriptRunner | 尚未运行 |
| 23 | 全入口撤销、排序、通知角标、远端项目标记 | 待核验补齐 | Sidebar / Mobile shelves / 通知服务 | 尚未运行 |
| 24 | 50 MB 任意附件、HTML/PDF 预览、大粘贴折叠 | 待实施 | B10 / assets / 三端附件 | 尚未运行 |
| 25 | MCP Apps、caller scopes、外部 OAuth、URL | 待实施 | B11 / B12 | 尚未运行 |
| 26 | 独立语义权限 | 待实施 | B13 / auth / RPC/MCP | 尚未运行 |
| 27 | Limits、跨账号环境、剩余额度与 provider 接入 | 待核验补齐 | B07 / AccountQuota / quota merge / 三端用量 | 尚未运行 |
| 28 | worktree 位置、可取消异步初始化、分支前缀、结案动作 | 待核验补齐 | VCS / setup script / composer bootstrap | 尚未运行 |
| 29 | 远程目录、新模型提示、收藏可见性同步 | 待核验补齐 | B14 / ModelManifest / provider update / settings | 尚未运行 |
| 30 | 更新续接、按机器项目清理、未知 union、远程兼容范围 | 待实施 | B15 / B16 / B17 | 尚未运行 |
| 31 | BYOK 翻译兼容五项清单 | 待核验补齐 | modelGateway / AnthropicBridge / ResponsesBridge | 尚未运行 |
| 32 | 账号粘滞、额度切换、记忆容量 | 待核验补齐 | LocalAccountPool / modelGateway 本地线路 | 尚未运行 |
| 33 | 回环随机端口、每运行令牌、请求时密钥 | 待核验补齐 | CliProxy / LocalGatewayKey / modelGateway | 现网关复用 HTTP listener、令牌持久化；尚未满足全部要求 |
| 34 | fragment 四字段导入、重复来源选择 | 待实施 | Desktop deep link / Web/Mobile 导入 / server import | 尚未运行 |
| 35 | StepFolds 与编辑/子 agent/计划边界 | 待核验补齐 | MessagesTimeline.logic / Mobile threadActivity | 尚未运行 |
| 36 | 富文本代码行引用、句内附件、大粘贴 | 待核验补齐 | Composer / IDE 选区桥 / Mobile composer | 尚未运行 |
| 37 | composer 上方状态集中与真实来源 | 待核验补齐 | goal / queue / context / health | 尚未运行 |
| 38 | 系统通知、声音、角标、托盘后台 | 待核验补齐 | B09 / Desktop IPC / Web / Mobile awareness | 尚未运行 |
| 39 | 跨环境徽标、移除只隐藏、默认当前环境 | 待核验补齐 | 环境注册表 / 选择器 / 项目与草稿状态 | 尚未运行 |

## comparison 中未被编号遗漏的候选

这些候选仍属于完整目标，不因优先级低而自动排除。

| 对照条目 | 状态 / 决定 | 依据与下一验收入口 |
| --- | --- | --- |
| §2.1 纯文本 CLI artifact 兜底 | 不做 | 当前支持的 provider 均有结构化 SDK/stdio/HTTP/stream-json；原文仅在确实支持纯文本 CLI 时要求。不能为了兜底扫描任意 agent 输出并落盘。 |
| §2.1 全局免交互放权 | 不做 | 原文明确“不要照搬”，与交互审批和用户横切要求冲突。 |
| §2.2 provider 插件化 SDK | 待核验补齐 | 当前注册 driver 与本地 UI 插件不等价；须在既有注册表与安全模型内实现或给出经行为核对成立的决定。 |
| §2.3 transcript 投影与版本缓存 | 待核验补齐 | 已有事件溯源；随第 4/8 项核对去重、稳定引用和缓存。 |
| IDE-2 checkpoint 移出 `.git` | 不做 | 原文要求先不迁移；保留隐藏 refs，随第 14/28 项核对只读仓库、worktree 和远程边界。 |
| IDE-5 SCM 提交图与 agent 起草 | 待核验补齐 | Git 与工作台能力可复用；需核对提交图、起草入口和三端边界。 |
| IDE-6 主题与键位方案 | 待核验补齐 | 已有 themeSync 和快捷键编辑；需核对预设方案与用户入口。 |
| IDE-7 DAP/LSP/终端 | 待核验补齐 | 不重复造工作台底座；核对实际入口、远程和 Mobile 的决定。 |
| IDE-10 更新/安装器/SSH 服务端 | 待核验补齐 | 现有桌面发布与 SSH 能力需读链路，不以构建代替安装/更新验收。 |
| §4.2 减少 ACP 持久化与流式全量读取 | 待核验补齐 | 随第 4/5 项核对 ingestion、projector 和 ACP 快照写入。 |
| §4.2 unprompted/不可见忙碌语义 | 待核验补齐 | 随第 7 项核对 native 后台报告与终态。 |
| §5.2 多模型各 worktree 开线程 | 待核验补齐 | 须复用 bootstrap 和模型选择，三端明确入口。 |
| §5.2 托管平台与 PR 评审指南 | 待核验补齐 | 核对现有 GitHub API/多账号/Forgejo/Gitea 等支持，不以关键字决定缺失。 |
| §5.2 设备与远程 Mac 更新 | 待核验补齐 | 低优先级不是排除理由；必须给出源码与适用边界。 |
| §5.2 OTLP/主进程遥测/诊断导出 | 待核验补齐 | B22 已确认服务端 trace/metrics 底座，日志与客户端诊断仍须补齐。 |
| §5.2 CLI install/update/restart/WSL | 待核验补齐 | CLI 与 service launcher 链路需逐项验证。 |

## 验证与完成门禁

### 第 3 项：三态回复输出

- 未配置的环境由共享 `resolveResponseStreamingMode` 解析为 paragraph；可选新字段不破坏旧环境配置解码。显式旧键 true/false 继续对应 token/turn，新旧客户端交替写入时明确的最后一次选择生效。新模式写入同步旧布尔值，恢复默认明确写 paragraph。
- 缓冲只扫描新到的行。段落、反引号/波浪号围栏、引用和缩进代码块按闭合边界输出，ATX/setext 小标题与正文一起出现；紧凑列表确认下一项正文时发出上一项，嵌套项归属父项。长代码块不会被原 24K 溢出规则提前切开；完整回复模式也保留整个消息。终态、工具、审批边界仍刷新尾段，中途切 token 先发已有缓存，完成事件的全文回显不会重复已发前缀。
- Web/Desktop 共用通用设置选择器与恢复默认入口，Mobile 在对应服务器设置中选择三态；token 文案标为遗留模式。服务端 `getConfig` 返回可选 `features.responseStreamingModes`，两端只对声明支持的环境发新字段，缺失声明的旧服务端控制禁用。设置搜索保留原锚点并加入段落/完整回复/遗留关键词。
- 所有现有 provider 的标准 assistant 增量均经过同一 ingestion 层，三态不依赖特定 adapter，保留 provider 原生消息/工具边界与交互审批。协议与服务器设置按环境生效，本地/远程/隧道的客户端消费相同文本事件；没有新增聊天、命令面板或快捷键专属控制。反向状态是切换任意其它模式或恢复 paragraph。用户说明：[回复输出方式](../user/assistant-output.md)。

本次定向验证（2026-10-12）：

| 命令 / 范围 | 结果与边界 |
| --- | --- |
| `vp test run apps/server/src/provider/ModelManifest.test.ts apps/server/src/usage/AccountQuota.test.ts packages/client-runtime/src/state/threadReducer.test.ts` | 3 文件 / 54 项通过；仅基线模型清单、额度与 reducer，不代表新增功能已验收 |
| `vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts apps/web/src/components/settings/ResponseStreamingModeControl.test.tsx apps/web/src/components/settings/settingsSearch.test.ts` | 5 文件 / 231 项通过；当时尚未载入新增的 7 项事件链测试 |
| `vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t '模式通过\|paragraph 模式\|回合中从\|long\|oversized\|长回复'` | 8 项通过 / 98 跳过；三态分段、全文回显、失败/取消、中途切换与长回复，使用 worker drain，没有新增等待轮询 |
| `vp test run apps/server/src/orchestration/AssistantTextBuffer.test.ts packages/contracts/src/settings.streaming.test.ts packages/shared/src/serverSettings.streaming.test.ts apps/web/src/components/settings/ResponseStreamingModeControl.test.tsx` | 4 文件 / 27 项通过；围栏、标题、列表、缩进代码、任意切片、兼容 patch 与 Web 控制禁用状态；随后新增的 features 解码测试另行通过 |
| `vp test run apps/mobile/src/features/settings/SettingsServerRouteScreen.streaming.test.ts apps/mobile/src/features/settings/SettingsServerRouteScreen.logic.test.ts packages/contracts/src/settings.streaming.test.ts` | 3 文件 / 19 项通过；Mobile 三态 patch 与旧环境能力门控、现有后台活动逻辑、新字段和 features 解码 |
| 上述所有本主题相关测试合并运行（10 个文件） | 最后一次完整定向运行 273 项全部通过，包含新增事件链与全部缓冲边界用例；未运行全仓测试 |
| `vp lint` 精确列出的本主题 17 个 TS/TSX 文件 | 退出码 0，无诊断；不检查全仓 |
| 扩展到全部 22 个涉及的 TS/TSX 文件 | 退出码 0；现有 `settings.test.ts` 中四条 inline-schema 编译警告；纯暂存候选中两条原 HEAD 已有警告，不属于新模式实现 |
| `tsgo --noEmit`，分别在 `packages/contracts`、`packages/shared` 执行 | 均退出码 0；shared 有一条已有的类型查询建议，不是错误 |
| `tsgo --noEmit`，分别在 `apps/server`、`apps/web` 执行 | 未通过：server 的 AgentHooks/AgentMemory/WebSearch、ToolBroker、ByokAdapter 中有诊断，Web 的 WorkspaceLayout/useResizableWidth/AgentToolsSettings 中有诊断；本主题增量文件没有剩余诊断。不能写成模块类型检查已通过 |
| `tsc --noEmit`，在 `apps/mobile` 执行 | 未通过：已有 `SettingsByokRouteScreen` 的 847/866 行导航参数不匹配；本主题文件没有诊断 |
| 纯暂存候选的五个目标类型检查 | contracts/shared/server/web 用 `tsgo --noEmit`，Mobile 用 `tsc --noEmit`，全部退出码 0；只包含本主题文件及其传递依赖，排除无关测试 |
| 纯暂存候选的五个新增测试文件 | 35 项通过；Vite 工作区包别名固定到候选源码，没有借用主目录的未提交包源码 |
| 纯暂存候选的 ingestion 事件链定向测试 | 8 项通过 / 98 跳过；再次确认该主题可脱离此前未提交的源码运行 |
| 纯暂存候选的 `vp fmt`（22 个 TS/TSX 文件） | 通过；仅把本主题五个文件中的新增关键词/文案格式补丁回写主目录和暂存区，没有格式化原有无关改动 |

候选用 `git checkout-index` 导出到工作区外，仅包含 HEAD 加精确暂存的本主题改动；第三方依赖只复用已安装目录。独立临时配置使用源码别名与目标文件清单，并关闭 composite/incremental 的导出目录记账（避免路径别名导致 TS6307）；其余应用编译选项与 Effect 诊断保留。这些临时配置和脚本不提交。

真实 Web/Desktop/Mobile 操作、真实 provider 联调与第 9 项帧间隔回归尚未运行。当前脏工作区的完整模块检查问题仍开放，不能将“纯候选定向类型检查通过”写成“当前工作区完整模块通过”。完整目标仍未完成。

- 后端行为变更必须带定向测试；前端带定向测试或真实集成验证。使用仓库本地 `node_modules/.bin/vp.cmd`，只跑触及文件和目标 lint/typecheck，不跑全仓检查。
- 每个实现主题必须附 Web/Desktop/Mobile、全部 provider 的支持决定，本地/远程/隧道、聊天/设置/命令面板/快捷键适用入口、反向状态和用户文档位置。
- 性能必须有本次修改前/后的同环境测量；当前尚无本次帧间隔数据。选区、滚动锚点和 Mobile/独立 Desktop 的真实运行证据仍未验收。
- 一个主题一个 conventional commit，精确暂存；不把初始脏文件整份加入提交。当前未创建 PR、未推送、未部署。
- 只有第 1/2 项全部核对、阶段 1—5 每项完成或有成立的不做理由、所有定向测试与目标 lint/typecheck 通过、性能无回归、文档与实际行为一致，才可宣布完整目标完成。当前目标未完成。
