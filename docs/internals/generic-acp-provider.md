# 通用 ACP Agent（acpAgent）

`acpAgent` 是用户自配置的通用 Agent Client Protocol 入口：任意说 ACP（JSON-RPC over stdio）的 CLI 都能接入，设置里填完整启动命令即可。驱动实现在 `apps/server/src/provider/Drivers/GenericAcpDriver.ts`，注册于 `apps/server/src/provider/builtInDrivers.ts`。

与 Cursor / Kimi 的关系：GenericAcpDriver 不新写会话编排，直接复用 `apps/server/src/provider/Layers/CursorAdapter.ts` 的 ACP 适配层（Kimi 走同一路径，见 `Drivers/KimiDriver.ts`）。因此文件系统与终端请求经 ToolBroker 桥执行并受工作区约束，权限请求走既有审批链（`request.opened` → `thread.approval.respond`），与会话生命周期、终止树杀等行为和 Cursor/Kimi 完全一致。设置 schema 在 `packages/contracts/src/settings.ts`（`AcpAgentSettings`）。

## 命令配置

- `command`：完整启动命令，按引号语义拆分（复用 `PiAdapter.ts` 的 `splitPifamilyLaunchArgs`），首段是可执行文件，其余是参数。例如 `npx -y cline@3.0.46 --acp`。命令为空时驱动拒绝创建实例。
- `authMethodId`：会话建立时 ACP `authenticate` 请求使用的 method id，默认 `login`（Kimi 同值）。agent 不要求认证时可留空。
- `supportsModelSelection`（隐藏，默认 true）：agent 是否接受会话级模型选择。
- 探照灯：以 `<命令> --version` 探测（8 秒超时），ENOENT 如实报"未找到"；模型目录来自 `customModels`，登录与模型可用性由真实 ACP 会话确认，探测输出只做展示。
- 文本生成复用 `makeCursorTextGeneration`，同样以配置的命令拉起一次 ACP 会话。

## BYOK 网关注入：注入，不是强制

开启 `routeThroughByok` 后，驱动向子进程注入标准 OpenAI / Anthropic 环境变量，指向本地 BYOK 网关（`GenericAcpDriver.ts`）：

- `OPENAI_BASE_URL` = `/byok-gw/openai[/source/<instanceId>]/v1`，`OPENAI_API_KEY` = 网关 token；
- `ANTHROPIC_BASE_URL` = `/byok-gw/anthropic[/source/<instanceId>]`，`ANTHROPIC_AUTH_TOKEN` = 网关 token，并清空 `ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_OAUTH_TOKEN` 避免混用凭据。

语义要如实表述：这是 **BYOK 优先注入**，不是物理强制。只有读取这些变量的 agent 才会走网关；agent 完全可以无视环境变量用自己的登录态（典型如自带 OAuth 的 CLI）。这与 Pi / OhMyPi 的构造性强制（受管 models.json + 环境清洗，CLI 物理上接触不到其它凭据）是两回事，见 [pi-family-providers.md](./pi-family-providers.md)。网关侧本身仍 fail-closed：注入指向的来源里没有匹配通道时返回 404 / 协议错误，不会借用其它实例的凭据。

BYOK 源变化时，`ProviderInstanceRegistryHydration.ts` 只在 `routeThroughByok: true` 的 acpAgent 实例上计算 `__byokSourceFingerprint` 并触发忙碌边界内的实例重建。

## ACP 目录

新增 `server.getAcpRegistryCatalog` 读取 ACP 官方目录。服务端按自身平台标记二进制条目的可用性，只把参数安全且固定版本的 npx 分发转换为可选择的启动命令；目录失败时向导仍保留手工命令入口。选择条目只填写现有 `acpAgent.command`，实例保存、探测与会话启动继续走原有驱动。npx 可能在探测时下载软件包，界面会先明确提示。目录查询需要环境读取权限，并限制响应大小与等待时间。

## Kiro 异步命令与执行

Kiro 的 \_kiro.dev/commands/available 通知复用标准会话更新入口：必须包含 sessionId 和 commands/prompts 至少一个数组，启动前缓存、当前根会话及重放隔离保持一致。空数组撤回广告；无效通知仅告警并保留快照。名称归一化和去重复用共享解析器，tools 不进入命令菜单。

仅当前会话广告的 commands 使用 \_kiro.dev/commands/execute，请求为 {sessionId, command: {command, args: {value}}}，无参数用空 args。prompts、help、compact 继续普通消息。响应 message/data 进入既有正文事件，有长度上限；拒绝、畸形结果、RPC 错误直接失败，不自动重发模型；附件混发明确拒绝。60 秒超时显示状态未知，本地取消不代表远端副作用撤销。

扩展请求在协议所属作用域内并行处理，避免长命令堵住 stdio 读入，导致取消、宿主回调回应和下一命令无法处理；通知仍按序消费，请求回应保留原 ID。通用 ACP 与 Cursor 共用该运行时，没有专有 Adapter 或第二套菜单。返回数据中的 UI 动作只显示，不自动改变客户端设置。

核对日期 2026-10-01；检索词 commands/available、commands/execute、parse_slash_command、stream_command。采用 [Kiro 官方 ACP 文档](https://kiro.dev/docs/cli/acp/)确认方法、[固定 Paseo 适配器](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/server/src/server/agent/providers/kiro-acp-agent.ts)确认广告转换、[官方 KiroCrew 请求源码](https://github.com/kirodotdev/KiroCrew/blob/df0ea7909cafa0fa8762e844bf4babc98e282d46/src/kiro_crew/acp/client.py)确认对象参数，优先于第三方猜测；不复制其固定等待或兼容回退。

协议进程测试覆盖广告替换/撤回、错误、参数、取消/超时后同连接继续执行及实例归属。真实版本的握手、工具和界面证据仍独立验收，见 [Kiro 验证边界](./kiro-acp-provider.md)。

## 尚未提供的

- 二进制和 uvx 分发暂不自动安装；目录会显示它们的手工配置或平台不可用状态。目录选择支持 npx 固定版本条目。
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
