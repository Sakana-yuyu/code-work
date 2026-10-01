# 通用 ACP Agent（acpAgent）

`acpAgent` 是用户自配置的通用 Agent Client Protocol 入口：任意说 ACP（JSON-RPC over stdio）的 CLI 都能接入，设置里填完整启动命令即可。驱动实现在 `apps/server/src/provider/Drivers/GenericAcpDriver.ts`，注册于 `apps/server/src/provider/builtInDrivers.ts`。

与 Cursor / Kimi 的关系：GenericAcpDriver 不新写会话编排，直接复用 `apps/server/src/provider/Layers/CursorAdapter.ts` 的 ACP 适配层（Kimi 走同一路径，见 `Drivers/KimiDriver.ts`）。因此文件系统与终端请求经 ToolBroker 桥执行并受工作区约束，权限请求走既有审批链（`request.opened` → `thread.approval.respond`），与会话生命周期、终止树杀等行为和 Cursor/Kimi 完全一致。设置 schema 在 `packages/contracts/src/settings.ts`（`AcpAgentSettings`）。

## 命令配置

- `command`：完整启动命令，按引号语义拆分（复用 `PiAdapter.ts` 的 `splitPifamilyLaunchArgs`），首段是可执行文件，其余是参数。例如 `npx -y cline@3.0.46 --acp`。命令为空时驱动拒绝创建实例。
- `authMethodId`：会话建立时 ACP `authenticate` 请求使用的 method id，未设置时默认 `login`（Kimi 同值）。显式空字符串会跳过该 RPC，直接由上游建会话检查已有登录或环境凭据；新建与恢复一致。Web/Mobile 保留显式空值，并显示未设置时的默认值。
- `supportsModelSelection`（隐藏，默认 true）：agent 是否接受会话级模型选择。
- `supportsMcpServers`（默认 true）：是否向会话注入 Code Work HTTP MCP 服务器。Web 与 Mobile 均可编辑，明确的 false 必须保存，不能当作空值删除。修改在实例重建后的新建或恢复会话生效。
- 探照灯：以 `<命令> --version` 探测（8 秒超时），ENOENT 如实报"未找到"；初始模型目录来自 `customModels`，会话广告可动态补充，登录与模型可用性由真实 ACP 会话确认，探测输出只做展示。
- 文本生成复用 `makeCursorTextGeneration`，同样以配置的命令拉起一次 ACP 会话。

健康探测与实际会话共用 `shared/shell.resolveSpawnCommand`，按实例的有效环境解析
Windows PATH 中的命令。原生可执行程序直接启动；解析到 `.cmd` / `.bat` 时使用
已有 Windows shell 转义，命令路径和参数分别处理。带空格的路径和参数必须在配置
中加引号；`&` 等参数字符不是额外的 shell 指令。未找到命令不会静默切换到 shell。
子进程回归覆盖原生 Node、带空格的批处理入口及 PATH 中的本地 npx 模拟入口，
同时检查版本探测、ACP 握手、参数完整性及非零退出码；这不等于 npm 下载或官方 CLI 验证。

## MCP 会话兼容

GenericAcpDriver 将实例的 `supportsMcpServers` 传到共用 CursorAdapter 的唯一 MCP 注入位置。
关闭时不传服务器及认证头，AcpSessionRuntime 对 `session/new` 和 `session/load` 均发送 `mcpServers: []`；
原来的 Cursor/Kimi 默认行为不变。文本生成路径本来就不注入 MCP，标准 ACP fs/terminal、权限审批和 Agent 自带工具不受此开关影响。
关闭后不能调用 Code Work MCP 提供的工具；这不是 Agent 全部工具的总开关，也不会撤销 Agent 自行配置的 MCP。

Factory Droid 目录精确 ID `factory-droid` 预填 false，其它目录条目恢复 true；实例保存后可自行调整。
这是固定 Paseo Droid 0.179.0 的兼容默认，不是所有 Droid 版本永久不支持 MCP 的断言。
当前目录快照为 0.229.0，Factory 最新文档已介绍 Zed MCP context servers；已验证版本可以重新开启。
不按手工命令字符串猜测能力，不迁移旧实例。目录的“已配置”仍按命令和必要环境匹配，允许实例覆盖这个兼容默认。

2026-09-30 检索 `Droid ACP MCP supportsMcpServers`，采用
[固定 Paseo 目录](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/app/src/data/acp-provider-catalog.ts)
及同提交的 ACP 适配器确认旧版兼容行为，采用 [Factory 官方 IDE 文档](https://docs.factory.ai/ide-integrations)
确认当前文档边界；不采用社区推测替代 CLI 实测。Node ACP 子进程回归覆盖 false、缺省和 true 的 new/load 报文，
证明 Code Work 注入控制，不证明真实 Droid 登录或工具能力。无需数据库迁移；回滚仅撤回开关、目录默认和注入条件，恢复原有注入行为。

## BYOK 网关注入：注入，不是强制

开启 `routeThroughByok` 后，驱动向子进程注入标准 OpenAI / Anthropic 环境变量，指向本地 BYOK 网关（`GenericAcpDriver.ts`）：

- `OPENAI_BASE_URL` = `/byok-gw/openai[/source/<instanceId>]/v1`，`OPENAI_API_KEY` = 网关 token；
- `ANTHROPIC_BASE_URL` = `/byok-gw/anthropic[/source/<instanceId>]`，`ANTHROPIC_AUTH_TOKEN` = 网关 token，并清空 `ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_OAUTH_TOKEN` 避免混用凭据。

语义要如实表述：这是 **BYOK 优先注入**，不是物理强制。只有读取这些变量的 agent 才会走网关；agent 完全可以无视环境变量用自己的登录态（典型如自带 OAuth 的 CLI）。这与 Pi / OhMyPi 的构造性强制（受管 models.json + 环境清洗，CLI 物理上接触不到其它凭据）是两回事，见 [pi-family-providers.md](./pi-family-providers.md)。网关侧本身仍 fail-closed：注入指向的来源里没有匹配通道时返回 404 / 协议错误，不会借用其它实例的凭据。

BYOK 源变化时，`ProviderInstanceRegistryHydration.ts` 只在 `routeThroughByok: true` 的 acpAgent 实例上计算 `__byokSourceFingerprint` 并触发忙碌边界内的实例重建。

## ACP 目录

在线目录读取失败时，使用随程序发布的官方数据快照，并返回 `error: "unavailable"`、
`source: "bundled"`、`snapshotDate`。Web 添加实例页面同时显示快照日期、版本可能过期
的提示和可搜索条目；合法在线空列表不会被旧快照覆盖。旧服务端没有 source 字段时
仍沿用原有错误显示。快照和在线数据共用同一 npx/uvx 安全校验与服务端平台判定，不因
离线而放宽可执行命令条件。详细来源、更新方法及 44 个入口对照见
[Paseo 目录对照](./paseo-provider-catalog.md)。

`server.getAcpRegistryCatalog` 读取 ACP 官方目录，并以精确 ID 补充经核对的五个手工安装入口。手工条目携带 setup（官方安装/ACP 来源链接、核对日期），版本为 null，使用本机已安装版本；不支持的平台不生成预填命令。在线同 ID 原样优先，合法空在线结果只保留这五项，不补旧快照。服务端按自身平台标记二进制条目的可用性，只把参数安全且固定版本的 npx/uvx 分发转换为可选择的启动命令；当前平台若仅有带 sha256 的官方二进制，则暴露 `binaryDistribution`，客户端通过 `server.installAcpRegistryBinary`（只传 entryId）在所选环境下载、校验并回填命令。目录失败时向导仍保留手工命令入口。选择条目填写现有 `acpAgent.command` 及已核对的实例 `environment`，实例保存、探测与会话启动继续走原有驱动。npx/uvx 可能在探测时下载软件包，界面会先明确提示。目录条目可带官方 CDN `iconUrl`；Web 优先使用内置 `acp-agent-icons` 副本。目录查询需要环境读取权限，并限制响应大小与等待时间。

## 思考与正文流

通用 ACP、Cursor/Kimi 与 Grok 共用的会话解析层接收 `agent_thought_chunk` 文本，沿用
`content.delta` 的 `reasoning_text` 类型传递，不并入 `assistant_text`。思考到达时结束
前一正文段，后续正文分配新的消息 ID。Grok 的活动监测也把这些事件视为真实进度。

这与可展示的 `reasoning_summary_text` 不同：上游没有明确提供摘要时，不把原始思考
伪装成摘要。当前 ingestion 继续遵守原始 reasoning 不进入对话时间线的边界。
协议 fixture 已覆盖正文、思考、正文交错的子进程事件链路；不代表所有 ACP CLI 已完成真实登录验证。

## 会话命令

`available_commands_update` 转为共用会话命令快照。建会话期间先到达的通知按 sessionId
暂存，只采用返回的当前会话；运行期通知沿用重放和子会话过滤。名称去除前导斜杠、
过滤空白名称并按名称去重，保留说明与输入参数提示。空数组明确撤回全部命令。

Adapter 的 `session.started` 携带初始 `slashCommands`，后续通过 `session.configured`
携带替换列表，沿既有活动链投影为 `session.commands.updated`。Web、桌面和 Mobile
在当前线程按 providerInstanceId 选择最新合法快照；旧服务端没有这些字段时仍使用
provider 全局目录。命令更新不作为执行工作日志显示，不写入另一个项目的全局目录。

标准命令菜单选择沿用既有输入框行为，将 `/命令 参数` 作为普通 ACP prompt 发送；不会执行
本地 shell，也不会自动替用户提交。上游命令需要会话握手后才可发现，新草稿未启动
会话时不会凭空显示命令。上游仍负责命令语义与认证；应用保留自身内置命令入口。

## 动态配置与选择


`AcpSessionRuntime` 接收当前会话的 `config_option_update`（注意 option 为单数），
按完整快照替换配置，空数组也会清空，不与旧选项合并。重放和其它会话的通知沿用
运行时隔离规则。模型切换从最新配置的 `model` 类别解析键名，模式切换从 `mode`
类别解析键名；未提供类别配置的旧 Agent 的模式通过标准 `session/set_mode` 设置，
模型仍保留既有 `model` 配置兼容入口。

配置模式优先于旧 `modes`，支持分组候选；移除配置模式时清理派生模式状态。
`current_mode_update` 同时刷新配置中的当前值，避免随后的设置被错误当作无需写入。
主动设置返回的完整配置也更新同一快照。已有值不重复写入，不合法的候选值或布尔
类型由既有本地校验拒绝。下一回合的模型/模式选择沿用原 Adapter 请求链。

子进程测试覆盖通知后的选择、拒绝、清空、旧模式通知和回合切换。
握手中的 `configOptions` 模型类别优先于旧 `models.availableModels`；分组候选被展平、
清洗和去重。会话开始通过 `session.started.models` 发布目录，后续配置通知和主动设置
的响应通过 `session.configured.models` 发布更新；模型列表及当前值未变化时不重复发布。

投影保存为 `session.models.updated` 线程活动，ID 使用原事件 ID 加 `:models`，避免
同一事件同时携带命令时冲突。`null` 表示新会话未提供模型信息、清除历史覆盖；`[]`
明确撤回广告。旧服务端不含此字段时保持兼容。活动不显示为聊天工作日志。
`packages/client-runtime` 按实例解析当前线程最新合法快照，保留同名模型已知的能力描述
及显式自定义模型，不修改全局探测结果。Web/Desktop 在 ChatView 统一派生供菜单、
选择校验和发送使用，Mobile 在 buildModelOptions 复用，避免补回已撤回的历史选项。
未连接的新草稿仍用实例配置和探测目录。目录不代表模型已认证、可计费或真实可用。

### 任意模式选择

`session.started.mode` 和 `session.configured.mode` 复用 select 类型的 ProviderOptionDescriptor，
选项 ID 固定为 `acpMode`；候选值保留上游原始 ID（包括 Copilot 风格 URI），名称和描述仅用于显示。
投影为 `session.mode.updated`，事件 ID 后缀为 `:mode`；按实例读取最新合法快照，null 清除历史覆盖。
共享客户端将它合并到当前线程的各模型能力中，包括静态和自定义模型，保留其它选项。
Web/Desktop 模型参数菜单及 Mobile 会话设置沿既有选项控件编辑，选定值通过 ModelSelection.options 提交。
未发送的新选择表示下一回合意图，上游当前值提供默认选择；候选撤回后 UI 按当前目录重新解析。
服务端仍校验实际提交值，过期或非字符串模式返回错误，不会静默降级后发送 prompt。

Cursor/Kimi/通用 ACP 与 Grok 的启动和发消息入口均应用显式模式；显式选项优先于兼容的 default/plan 推断。
Web 检测到完整模式选项时隐藏旧两态开关及相关菜单/快捷键入口，Mobile 隐藏内置 /plan、/default 菜单项。
Mobile 入发送队列前也复用菜单目录归一化，明确撤回的模式不会残留在待发选项中。Agent 自己更新模式或配置时发布新的会话快照，
同一模式不重复写入。配置类别存在时调用最新配置键；仅有旧 modes 时使用 `session/set_mode` 并校验响应。
没有该能力的 Agent 不产生模式控件，其它非模式配置项仍未全部提供通用 UI。

Cursor 在发布回合完成前等待现有事件队列屏障，避免模式和工具结束事件落在完成后；会话停止或消费者退出时
停止等待，不能因停机后已无人消费队列而挂住回合。新字段可选，旧事件仍可读取，无数据库迁移。
回滚撤回本轮 mode 合同、投影、共享合并和模式设置分支及对应测试即可；不得回滚已有模型目录和账号池修改。

协议核对日期 2026-09-30，检索关键词 `ACP session modes set_mode configOptions`，采用
[ACP 官方模式协议](https://agentclientprotocol.com/protocol/v1/session-modes)及仓库 effect-acp 对应生成 schema，
因为前者明确要求模式来自广告列表，后者是本项目实际解码边界；专用 modes API 已被标注逐步让位于配置选项。
固定 Paseo 提交中的 Copilot URI 模式说明原始 ID 不能压缩成两态。协议 fixture 验证不能替代真实 Copilot 认证或权限语义。

### 启动与恢复期间的配置通知

`Starting` 阶段按 sessionId 缓存最后一次非重放 `config_option_update`，与会话命令共用
启动元数据容器，互不覆盖。取得新建/恢复响应后，仅取最终 sessionId 的缓存：响应中
`configOptions` 是数组时优先采用（包括空数组）；字段缺省或为 null 时以已收到的配置
补全 `sessionSetupResult`。各 Adapter 和运行时的模型、模式及配置键由同一份结果派生，
不会出现模型目录已更新但启动选择仍使用旧键的分歧。初始化失败后重试先清空缓存和派生值。

恢复期间只有目标 sessionId 的通知计入重放活跃时间；显式重放只参与等待，不更新配置。
已有“重放空闲后继续”的兼容路径也可以采用缓存配置，其来源标记仍保留，不把上游 RPC
未返回说成已收到成功响应。启动元数据不另发重复的模型变更事件，由会话启动快照统一发布。

协议核对：2026-09-30，以 `session new configOptions config_option_update` 检索并采用
[ACP 官方 v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)
和[会话建立说明](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)，
因为它们定义响应中的初始配置与更新中的完整配置。响应优先、缺省时保留通知是 Code Work
针对早到通知的兼容策略，不是声称协议规定所有 Agent 的发送时序。当前仍使用 v1 握手，
未据此宣称支持 v2 恢复协议或所有厂商的历史重放标记。

## 上下文用量

共用 ACP 解析层接收 `usage_update`，经 Cursor/Kimi/通用 ACP 及 Grok 转为
`thread.token-usage.updated`。`used` 表示当前上下文占用，映射为 `usedTokens`；
`size` 大于零时映射为 `maxTokens`，零值表示窗口未知，不构造虚假上限。
当前 effect-acp 将此上游事件标记为不稳定能力，没有发送该通知的 Agent 不会产生用量快照。

投影沿用 `context-window.updated`，零用量也会更新，避免上下文清空后保留旧显示。
Web 与桌面共用的上下文仪表读取这一快照；Mobile 目前仍未提供对应仪表。
其它会话和标记为重放的用量沿用会话运行时过滤，不覆盖当前会话状态。
Grok 不将单独的用量通知计为执行进度，避免只有计量心跳时无限延长无进展回合。

`used` 不是累计计费 token，不能伪装成 `totalProcessedTokens`；可选 `cost`
保留在原始事件中，不转换为 token 或账号余额。本链路不新增费用计算或扣款。

## 资源消息

共用 ACP 解析将 `resource_link` 和带 `text` 的 `resource` 转为现有 ContentDelta，
保留正文/思考流归属和原始事件。HTTP(S)、file URI 复用客户端现有链接入口；其它 URI
显示“不支持直接打开”及可复制的原始值，不主动请求资源或虚构下载能力。标题中的
Markdown 标点转义，目标保留查询参数和片段；嵌入正文及说明使用足够长的代码围栏，
不执行其中的 HTML、图片或链接语法。空正文及长正文保持原值，沿原消息传输与持久化限制。

每个正文资源复用 assistant item 分段，在资源前后关闭活动文本段，避免被相邻未闭合的
Markdown 围栏吞入。重放、子会话和思考隐藏仍由已有会话/投影策略处理。没有新消息表、
双份客户端状态或额外网络读取；Web/桌面与 Mobile 复用原 Markdown 和复制控件。

ACP `audio` ContentBlock 与带 `blob` 的嵌入资源经同一 ContentDelta 路径进入资产存储：
音频持久化为 `ChatAttachment.type=audio`，二进制持久化为 `type=file`。服务端只接受内联
base64，不按 uri 回源；日志省略正文。blob 附件名优先用资源显式名称，否则从 `uri` 取 basename
（解析器不得把整段 URI 当作 `name`，否则会绕过 basename）。Web 对音频使用原生播放器、对文件提供下载链接；
Mobile 通过签名资产地址打开。拒绝可执行与可脚本化 MIME。大小上限与图片同为 10 MiB。
思考流中的音频/blob 仍沿原思考隐藏策略，不转为公开回复。

核对日期 2026-09-30，检索关键词 `ACP ContentBlock resource_link embedded resource audio blob`，采用
[ACP 官方 v1 内容协议](https://agentclientprotocol.com/protocol/v1/content)及仓库实际生成 schema，
因为它们明确区分资源链接、文本资源、音频和二进制资源。固定 Paseo 的 contentBlockToText 只取
资源标题或文本，本实现保留 URI 并使用现有安全链接入口；模拟进程不代表官方 CLI 实测。
Ingestion 回归覆盖音频/blob 的重复事件、危险 MIME 拒绝、思考流不落盘，以及附件正文不进入投影 JSON。

## 助手图片输出

ACP `agent_message_chunk` 的 `image` 经共用解析器、Cursor/Generic/Kimi 与 Grok Adapter
进入 `content.delta.image`；复用资源分段边界，图片不会被前文未闭合 Markdown 吞入。
`agent_thought_chunk` 的图片仍沿原思考隐藏策略，不转为公开回复。重放和其它会话通知由原门禁过滤。

Ingestion 在发布消息前将 base64 保存为现有 `ChatAttachment`。内部
`thread.message.assistant.delta` 可携带附件快照；事件表、投影和客户端只保存 ID、类型、名称、
MIME、字节数，完成消息不清空既有附件。现有原子 `.part` 写入/重命名存储被复用，
附件 ID 来自线程、实例、回合、事件 ID 的稳定摘要，相同事件重试不产生额外文件。
线程前缀保持现有清理规则；无需数据库迁移。写盘成功后若消息事务失败，文件保留供同事件重试，
不会删除可能已被成功提交引用的资产；不能据此声称跨文件系统与数据库的分布式事务已实现。

入口接受 PNG/JPEG/GIF/WebP，校验规范 base64、非空、最多 10 MiB 以及 MIME 对应的格式签名，
不主动下载可选 `uri`，不接受可执行 SVG。签名检查不是完整图像解码，损坏图片在客户端显示不可用。
验证或写盘失败发布 `provider.image.failed` 错误活动，保留具体原因；不使用会被客户端翻译为泛化
“运行时错误”的摘要。ACP 原始记录和 canonical 日志调用均省略图片正文，公开投影也不带 base64。

Web/桌面复用用户附件的图片网格与大图预览，纯图片历史不作为空消息删除。Mobile 复用原有助手附件
及签名资产地址，两个客户端的图片解码失败都有可见反馈。地址仍通过当前环境授权和签名 URL 获取；
附件前缀用于归属及清理，现有资产接口没有新增逐线程 ACL，不能将前缀描述为独立访问授权。

验证包含协议子进程、流式/缓冲投影、原子写盘失败、编码/大小/类型边界、重复事件、线程隔离、
共享 reducer 和本地浏览器。真实官方 CLI、Electron 原生壳、原生手机及远程/relay/tunnel 尚需独立验收。
回滚撤回图片可选载荷、内部命令和消费分支及双端渲染即可；旧消息数据中的附件保持有效，无迁移操作。
协议来源沿用上节官方 v1 内容协议（2026-09-30），关键词 `ACP image data mimeType`，采用其必填 base64/MIME 定义；
支持格式和大小限制属于本产品边界，不冒称 ACP 只支持四种格式。

共用工具解析保留结构化批量结果的优先级，其后优先使用 rawOutput.content 的 MCP 文本结果，再使用已经限长的 ACP 展示正文；没有文本结果时才使用路径或命令摘要。Hermes 等 Agent 在终态重复携带 kind，不能因此丢掉 read/execute/edit/search 的实际输出。标题和命令仍是独立字段，缺省标题继续由原生命周期合并保留；不从截断的厂商标题猜测完整命令。

Gajae 的 ACP 展示正文同时包含命令预览和重复摘要，不能一起当作 stdout。已知 MCP 原始文本块及派生详情沿用 8,000 字符尾部限制，非文本块和其它结果字段保持原样；这不是全局正文去重。官方 CLI 与产品 Runtime 的命令、拒绝、取消副作用已有本机响应端点证据。客户端中断且上游未发工具终态时，Runtime 会为已展示的 pending/inProgress 工具补发 failed（仅审批身份、从未发出工具行的条目不新造 Tool）；连续回合与真实审批中取消的官方 CLI 再验仍见专项文档。

权限请求中的 toolCallId 不必然对应一次执行。共用 Runtime 在现有工具状态表中关联根会话权限请求和原生决策，仅忽略没有执行证据、没有其它字段且终态匹配审批结果的 tool_call_update；申请与决策日志继续由审批链路保留。任何实际工具开始、输出或不匹配终态均按工具处理，未知身份不隐藏，未关闭审批身份在下一 prompt 前清理。此规则不依赖 Agent 名称或 ID 格式，不回写历史数据。

工具终态经 ingestion 保留最多 8,000 字符 detail，供 Web/桌面和 Mobile 展开查看；中间更新仍为短摘要，避免累计输出放大持久化与传输。明确 execute 工具的 detail 视为结果，不再回退成命令字段；显式 command 与旧无类型元数据兼容保持。旧已截断历史不迁移，超限终态仍以省略号标记截断。

## 模型切换协议

模型配置项存在时，Runtime 用广告的配置 ID 调用 `session/set_config_option`；只有旧式 `models` 广告时调用 `session/set_model`。两者都没有时保留既有 `model` 配置兼容路径。空配置快照撤回配置本身及原配置派生的模型，不撤回独立 `models` 广告；避免 Hermes 返回空配置后使客户端错误回退默认模型。

`session/set_model` 成功后更新当前模型快照，失败不改变它。若上游接受目录外的自定义 ID，以该 ID 加入当前目录，名称沿用 ID、能力未知；不假造厂商能力。此逻辑供 Generic、Cursor/Kimi 和 Grok 共用，不加专用 UI 状态。官方 Hermes v2026.9.24 的真实请求及新进程恢复已验证；其它 Agent 仍须逐项实测。旧错误选择不自动迁移，无数据库结构变化。

## 会话关闭

Gajae v0.18.1 在当前客户端能力下广告 `agent` 认证，手工目录已修正默认方法；成功响应不检查模型可用性。空配置建会话、模式拒绝、缺模型错误及随后正常关闭已经过真实 CLI 验证，完整工具仍待验收，详见 [Gajae 接入边界](./gajae-acp-provider.md)。

停止 Cursor/Generic/Kimi 和 Grok 会话时，共用 Runtime 先对广告 `sessionCapabilities.close` 的已建会话发送 `session/close`，再释放本地协议和进程。未广告则保持原有资源释放方式；不为关闭而创建会话。关闭失败或超过 5 秒返回异常退出及“远端状态未确认”的说明，本地资源仍释放。`session.exited` 的 error 结果经共用 ingestion 保留为错误活动，普通或未标明异常的退出不增加工作记录。关闭不等于删除历史，也不证明活动工具副作用已撤销。

回合中子进程退出时，ACP 协议在观测到 `exitCode` 后即终止待定 RPC（不依赖 stdin EOF，避免 Windows shell 包装进程死后管道悬挂）。Cursor/Generic 路径在 `session/prompt` 失败时结算待定审批/用户输入、发出 `turn.completed`（failed），并在进程已退出时本地发布 `session.exited` 而不再死等 `session/close`。停止会话结算审批后，迟到的 `respondToRequest` 必须失败。真实远程/relay 断线迟到审批仍须隔离服务证据，mock/协议测试不能代替 A-7。

## Kiro 异步命令与执行

Kiro 的 \_kiro.dev/commands/available 通知复用标准会话更新入口：必须包含 sessionId 和 commands/prompts 至少一个数组，启动前缓存、当前根会话及重放隔离保持一致。空数组撤回广告；无效通知仅告警并保留快照。名称归一化和去重复用共享解析器，tools 不进入命令菜单。

仅当前会话广告的 commands 使用 \_kiro.dev/commands/execute，请求为 {sessionId, command: {command, args: {value}}}，无参数用空 args。prompts、help、compact 继续普通消息。响应 message/data 进入既有正文事件，有长度上限；拒绝、畸形结果、RPC 错误直接失败，不自动重发模型；附件混发明确拒绝。60 秒超时显示状态未知，本地取消不代表远端副作用撤销。

扩展请求在协议所属作用域内并行处理，避免长命令堵住 stdio 读入，导致取消、宿主回调回应和下一命令无法处理；通知仍按序消费，请求回应保留原 ID。通用 ACP 与 Cursor 共用该运行时，没有专有 Adapter 或第二套菜单。返回数据中的 UI 动作只显示，不自动改变客户端设置。

核对日期 2026-10-01；检索词 commands/available、commands/execute、parse_slash_command、stream_command。采用 [Kiro 官方 ACP 文档](https://kiro.dev/docs/cli/acp/)确认方法、[固定 Paseo 适配器](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/server/src/server/agent/providers/kiro-acp-agent.ts)确认广告转换、[官方 KiroCrew 请求源码](https://github.com/kirodotdev/KiroCrew/blob/df0ea7909cafa0fa8762e844bf4babc98e282d46/src/kiro_crew/acp/client.py)确认对象参数，优先于第三方猜测；不复制其固定等待或兼容回退。

协议进程测试覆盖广告替换/撤回、错误、参数、取消/超时后同连接继续执行及实例归属。真实版本的握手、工具和界面证据仍独立验收，见 [Kiro 验证边界](./kiro-acp-provider.md)。

## 尚未提供的

- 二进制分发暂不自动安装；目录显示手工配置或平台不可用状态。目录选择支持固定版本 npx 与 uvx；主机须预先安装对应运行器。
- 模型路由完全由 agent 自身解释，Code Work 不经网关校验其模型清单（`customModels` 只是展示目录）。
- 通用 agent 的工具面、审批语义取决于各自 ACP 实现，Code Work 只保证 fs/terminal 请求的工作区约束与审批链兜底。

## 工具结果的增量保留

工具实际结果与标题、类型、输入命令分别更新。已收到输出后，仅更新标题、类型或输入的通知保留原有结果详情；明确携带新输出时按新结果替换，不删除真正重复的正文。尚无结果时，输入变化继续更新派生摘要。状态与命令仍按同一 toolCallId 合并，不新增工具执行请求。

rawInput/rawOutput 的 null 与缺省都表示未提供新值，保留已有输入、结果与命令；false、0 和空字符串是合法原始值。MCP 文本优先级、单块输出及派生详情 8,000 字符尾部限制在此前提交已存在，本次只修增量合并，不扩大输出限额或修改历史数据。

通用 ACP、Cursor/Kimi 和 Grok 的生产合并入口共用 AcpSessionRuntime；结果经既有统一事件、ingestion 与公开活动投影提供给 Web/桌面和 Mobile。协议子进程回归覆盖结果→元数据→null→失败终态；公共投影核对长尾与命令分别保留。这些本地检查不替代真实 CLI、界面或设备验收。回滚撤回本次增量提交，无数据库迁移，不改账号或审批策略。

核对日期 2026-10-01；检索词 ACP ToolCallUpdate optional rawInput rawOutput null。采用 [ACP 官方 v1 工具调用文档](https://agentclientprotocol.com/protocol/v1/tool-calls)，因为它明确增量字段与 null 语义；仓库现有 schema 确认可选输入/输出接受原始 JSON。未复制其它项目实现或更改协议依赖。

工具 completed/failed 后，当前回合的合并表仍保留有界快照，用于继承后续补充通知未提供的状态、正文与命令。仅补元数据不会重新显示为进行中；补新结果仍更新同一调用。下一 prompt 通过已有清理入口移除终态快照和审批专用身份，保留尚未结束的实际工具；新回合不继承旧终态结果。内存保留量随当前回合工具数量增长，未新增无限跨回合缓存。原有根会话/重放门禁、取消补 failed 和权限身份过滤保持，终态更新沿原即时发出路径。

2026-10-01 的协议子进程回归在 Gajae 空闲等待期间验证成功/失败终态后的元数据与结果补充，随后在下一 prompt 验证同 ID 新调用不带旧输出；这不证明跨回合迟到通知有正确归属。上游更新没有回合 ID，不能凭同 toolCallId 猜新的执行或重新执行工具。回滚仅撤回终态快照保留与清理变更，无数据库迁移。

## JSON-RPC 通知与取消

共用协议层发送标准和扩展通知时，线上报文只包含 jsonrpc、method、params，省略 id。内部沿用 Effect 的 isNotification 标志；接收时也用该标志区分通知，不能把普通请求的空字符串 id 当通知丢掉。带空字符串 id 的扩展请求仍进入处理器，并回传相同 id。普通请求、回应及其错误关联沿用原编码。

复用现有 jsonRpcNotification 和 encodeJsonl，不修改依赖或另建传输层。不可序列化的 BigInt、循环对象继续以 AcpProtocolParseError / encode-message 失败；通知的内部 cause 由 Schema 编码器提供 SchemaError，公开错误说明不包含参数。通知没有 RPC 回执，发送成功不能独立证明远端取消完成；工具副作用、原 prompt 终态和会话关闭分别验收。

2026-10-01 核对；检索词 JSON-RPC notification id empty string、ACP session/cancel、Effect ndJsonRpc isNotification。采用 [JSON-RPC 2.0 规范](https://www.jsonrpc.org/specification#notification)确认省略 id 的语义、[ACP 官方取消合同](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)确认 session/cancel 为通知；与已安装 Effect 4.0.0-beta.103 的序列化实现和真实 CLI 原始报文对照，优先于 Schema 解码后忽略额外字段的旧断言。

定向检查覆盖四类通知的完整原始 JSON、入站标准通知、空字符串请求 ID 的回应、通知日志与编码错误。固定 Gajae 0.18.1 加本机模型响应端点通过连续文本、实际读取、批准命令、审批中取消和会话关闭；详见 [Gajae 边界](./gajae-acp-provider.md)。这是共用 Runtime 的本地及真实 CLI 证据，不替代界面、外部模型或其它 Agent 的实测。回滚撤回对应提交，无数据库迁移、不改变账户或审批策略。

取消时，共用 Runtime 先把 session/cancel 通知放入既有发送队列，再中断本地活动回合并返回。取消通知不再由脱离调用者的后台 fiber 发送；调用者紧接着关闭或提交下一消息时，不会在正常发送路径抢在取消通知之前入队。协议日志位于入队前，所以受控回归在该处设置屏障，核对取消和原 prompt 都尚未返回，放行后验证 cancelled 与 cancel→close 顺序。检查不依赖睡眠或轮询。

这里保证的是本地发送顺序，通知本身没有远端回执。保留既有通知失败时的本地中断策略，失败、工具副作用、远端终态和关闭仍分别验证；未扩大 5 秒关闭或 60 秒空闲预算。63 项 Runtime 和 Cursor/Grok 中断/停止/关闭回归通过，不代表每个官方 Agent 的取消和清理稳定。2026-10-01 最新 Gajae 原探针仍在关闭收到 terminal_uncertain / broker request failed，详见其文档；不增加重试或把失败改为成功。回滚撤回本次发送顺序提交，无迁移。

## ACP 子进程标准错误流

子进程客户端 layerChildProcess 在自身 Scope 中持续排空 child.stderr。stderr 不属于 ACP JSON-RPC，不并入 stdout、工具结果或协议日志，也不在内存中累计。客户端层关闭时取消读取任务；读取失败仅报告固定告警和 PID，不输出可能包含凭据的错误流或异常正文。协议解析、RPC 错误和实际退出码继续沿原错误合同处理，排空不会把这些失败改成成功。

2026-10-01 核对共用 Runtime、Cursor/Kimi、Grok 与 Generic ACP 的调用路径，它们复用同一子进程客户端层；手工调用底层 makeChildStdio 的低层调用者仍自行管理子进程。NodeChildProcessSpawner 默认 stderr=pipe，将它转接到 PassThrough；没有读者时背压会阻止子进程完成写入。真实 Node 子进程回归在每次 RPC 回复前先完成 8 MiB stderr 写入，连续两次检查原样回复及客户端 Scope 结束后的读取任务回收；旧客户端超时，修复后通过，不依赖睡眠、轮询或模型重试。

本修复证明共用传输不再被未读的 stderr 管道堵住，不证明所有 Agent 的外部账户、工具或关闭流程已通过。固定 Gajae 的 broker 生命周期错误单独记录于其文档。回滚撤回对应提交，无数据库迁移或账户配置变更。

本轮精确索引副本的 client/protocol/agent 与 Runtime 98项、Cursor/Grok停止/关闭7项通过（合计105项）；协议包及Server类型检查退出0，改动TS定向lint无输出。固定Gajae 0.18.1的未插桩工具探针整项通过一次，另一次基线诊断在session/new失败；二者及历史失败均保留于专页，不混为所有Agent稳定可用。


## 二进制归档校验

官方哈希缺省时的精确URL补充、来源与更新/回滚规则见 [二进制分发与哈希来源](./acp-binary-integrity.md)。哈希存在不表示Agent认证或工具已验收。


## 首批官方 CLI 验证

Qwen、Cline、Hermes的固定版本工具/取消/恢复探针、环境隔离及实际证据范围见 [首批可重复工具验证](./acp-first-batch-probes.md)。本机模型夹具不替代真实账户、外部推理或客户端验收。
