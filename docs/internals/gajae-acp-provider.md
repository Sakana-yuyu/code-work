# Gajae Code ACP 接入与验证边界

核对日期：2026-09-30。固定官方版本 `v0.18.1`，源码提交 `7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301`。本页记录真实 CLI 和 Code Work 的接入边界，认证成功不代表模型、账号余额或工具可用。

## 调用与配置

沿用 `gjc acp → AcpSessionRuntime → GenericAcpDriver / CursorAdapter → ProviderRuntimeIngestion`，客户端复用现有会话、工具、审批和历史显示。没有增加专用 Adapter。受测版本认证方法为 `agent`，配置实例时需显式填写。手工回退目录已预填 `agent`。2026-10-01 实时官方目录的 41 项中没有 Gajae，当前由手工条目补充；未添加面向假设在线条目的认证规则。已有实例仍须核对认证设置，通用缺省 `login` 会被该版本拒绝。

`initialize` 在当前客户端能力下广告 `agent`；官方源码仅在客户端声明终端认证能力时增加 `terminal`。`authenticate(agent)` 返回空对象，处理器不会因此验证模型凭据。未配置凭据也可以创建会话；空配置目录仍可能自动发现本机模型。只有没有可用模型时，`session/prompt` 才返回 `model_not_selected`，必须分别检查模型目录和真实请求。不能据此显示账号已登录、余额正常或推理成功。

模型在服务器的 Gajae 配置中设置。官方文档使用 `~/.gjc/agent/models.yml`，自定义 provider 可指定 `baseUrl`、`apiKey`、`api` 和 `models`，默认模型通过 `modelBindings.modelRoles.default` 绑定。`GJC_CODING_AGENT_DIR` 可指定绝对的 Agent 配置目录；`GJC_CONFIG_DIR` 是主目录下的目录名，两者不能混用。本次未导入宿主凭据或发送外部模型请求。

保留 `GJC_ACP_PERMISSION_MODE=prompt`，不自动切换为全部允许。上游取消默认针对当前 turn；额外的 owned 子任务策略尚未实测。空配置的会话响应广告 mode、thinking、steeringMode、followUpMode、toolInterruptPolicy；没有模型目录。不要从模式和配置数量推断模型支持数量。

本机模型验收复用官方 wire test 的 `profiles.acp-fixture.model_mapping.default`，启动命令为 `gjc --mode acp --mpreset acp-fixture`，provider 指向只监听 `127.0.0.1` 的 OpenAI Chat Completions 响应端点。该配置证明 CLI 实际读取并调用指定模型；响应由测试端点产生，不能证明外部模型推理或账号额度。Windows 的隔离环境不会继承宿主非系统变量；需在独立 `settings.json` 明确设置已安装 Git Bash 的 `shellPath`，否则真实 `bash` 工具失败并返回 `No bash shell found`。

## 固定版本证据

| 项目                | 结果                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| 官方资产            | `gjc-windows-x64.exe`，163,112,960 字节                                                                  |
| SHA-256             | `ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2`，与 GitHub 发布 digest 相同           |
| 版本 / 帮助         | `gjc/0.18.1`；`acp --help` 退出 0                                                                        |
| initialize          | 实际返回 `agentInfo.name=gajae-code`、`version=0.18.1`、认证方法 `agent`                                 |
| authenticate(login) | `-32603`，错误详情为 `Unknown ACP auth method: login`                                                    |
| authenticate(agent) | 返回 `{}`，仅证明方法被接受                                                                              |
| session/new         | 隔离空配置下成功；实际产生独立后台会话主机                                                               |
| 模式和命令          | 上游广告 plan，但实际设置返回 -32602 / unsupported，当前模式保持 default；异步命令包含 `skill:ultragoal` |
| 无可用模型 prompt   | 关闭隐式本地发现后返回 `-32603` / `model_not_selected`，没有助手正文；空目录本身不保证这一前置条件       |
| session/close       | 空配置及新目录单工具回合均返回 {}；多回合实测另出现文件锁清理错误与空闲回执超时，不能概括为所有情况正常  |

二进制和只读源码放在仓库外临时目录，没有全局安装、修改 PATH 或覆盖真实配置。Windows x64 实测不代表 ARM64；官方独立 Windows 资产仅列出 x64，本模块未修改目录平台判定。

提升权限的 Windows 进程可能把新目录的所有者设置成管理员组。第一次隔离启动报 `owner_mismatch:prepare:root_authority`；官方原生目录检查要求当前用户所有。只调整本次临时 Agent 目录为当前用户 SID 所有及仅该用户完整访问后，握手通过。没有关闭上游目录检查，没有修改用户现有主目录的 ACL。

## 可重复检查与关闭边界

本模块收录 `GajaeAcpCliProbe.test.ts` 与 `GajaeAcpToolProbe.test.ts`，需显式提供固定官方 CLI 路径。认证探针检查 login 拒绝、agent 接受、无可用模型时连续失败与关闭；只在自己的临时 settings.json 禁用六类隐式本地发现，并在发消息前确认版本和模型目录，前置条件不符时关闭会话且失败。工具探针使用独立本机端点。它重定向主目录、清空非系统宿主变量，使用仅监听本机的模型响应端点验证连续回合、读取、命令批准和审批期间取消；不代表外部模型或完整账号验收。

```powershell
$env:CODEWORK_GAJAE_CLI_PATH = 'C:/隔离工具目录/gjc.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/GajaeAcpCliProbe.test.ts
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/GajaeAcpToolProbe.test.ts
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
```

未设置路径时官方 CLI 探针跳过，不能记作实测通过。2026-10-01 的旧负向探针曾返回 end_turn；本轮在相同固定二进制下复现并记录模型配置：启动时已选择 ollama/qwen2.5:7b，后续实际收到助手正文。固定 model-registry 源码会在未显式配置时自动发现 127.0.0.1:11434 的 Ollama；空目录与清空凭据变量不能阻止该默认发现。本轮已复现负向探针的前置条件错误；旧运行没有原始模型通知，不能断言其每一步的内部原因。不需要改 ACP 错误映射或屏蔽正常本机模型。

负向探针沿用上游 disabledProviders 设置，在临时目录禁用 ollama、llama.cpp、lm-studio、omlx、vllm、sglang，保留宿主服务和配置。连续两个显式请求均要求 -32603 / model_not_selected、没有正文、没有隐式重试且明确关闭。不能把这里的 end_turn、认证接受或目录探测推广为外部模型、账户登录或余额正常。并行运行曾另遇 broker_startup_failed / machine-local identity is unavailable or malformed；Windows 上游读取系统 MachineGuid，未查明该次读取失败原因。探针不重试、不中和这个错误，官方探针分别执行也不能保证启动稳定：随后独立工具探针在 session/prompt 返回 SDK session attachment is unavailable: session not published。该次工具回归失败保留，未把较早的一次通过冒充最新稳定验收；本机服务是否存在、broker 能否启动与会话能否发布属于不同前置条件。

纠正早期记录：失败探针不能证明其前面的模式断言通过，先前“default → plan → default 成功”的表述已撤回。固定版本的原始 RPC 和产品 Runtime 都明确拒绝 plan。早期清理 EPERM 与 10 秒超时是真实失败观察，但本次原始连接、失败后关闭、混合请求 ID、独立 Runtime 及真实时钟探针均正常关闭，不能将旧超时归因于上游固定缺陷；旧测试超时的单一根因尚未确定。

产品此前停止会话时只释放进程，未调用已广告的 `session/close`。现在共用 Runtime 提供关闭方法，Cursor/Generic/Kimi 和 Grok 停止路径在释放协议资源前调用它。仅对已经建立且广告关闭能力的会话发送请求，不会为了关闭启动新会话。5 秒未返回则报告远端关闭状态未知，继续释放本地资源；上游报错也记为异常退出，不伪装为正常关闭。共用 ingestion 将异常退出说明保留为错误工作记录，正常退出不增加记录。进程崩溃、活动工具取消、恢复后的会话所有权仍须独立验收。

本次两个已知测试会话通过官方 `sdk session raw global --op session.close` 清理，携带各自 `sessionId`、`endpointGeneration`、`endpointIncarnation` 和幂等键；身份由同一隔离目录的 `session.list` 核对。官方返回成功，并说明端点不可达，已向持久化身份匹配的会话进程发送 SIGTERM。随后对该隔离目录 Broker 使用官方 `broker.shutdown`，收到成功响应并断开连接；只读进程检查确认没有残留 `gjc.exe`。没有按名称批量结束进程。这是测试清理成功，不能替代 ACP 优雅关闭成功。

固定版本源码文档提到 `sdk session close`，但实际公开命令注册与二进制帮助未提供该子命令，直接调用返回 usage。清理采用实际支持的 raw global 入口；后续不得只按说明文档推断 CLI 参数可用。

## 真实工具与输出

2026-09-30 使用官方 v0.18.1、本机响应端点及独立目录，区分原始协议和产品 Runtime 两层证据：

| 动作           | 实际结果                                                                                     | 边界                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文本           | CLI 返回 `GAJAE_LOOPBACK_OK`                                                                 | 本机固定响应，不是外部推理                                                                                                                                   |
| `read`         | 读取实际 source.txt，结果含 `GAJAE_SOURCE_72319`                                             | 原始协议和文件证据；尚未走浏览器                                                                                                                             |
| `write`        | 实际 approved.txt 内容为 `APPROVED`                                                          | 目录内写入未触发审批，不能声称所有写入都会询问                                                                                                               |
| `bash` 批准    | 原生 `allow_once` 回传；Git Bash stdout 为 `GAJAE_SHELL_72319`，Runtime 工具终态 completed   | 真实进程与标准输出；模型响应为夹具                                                                                                                           |
| `bash` 拒绝    | 原生 `reject_once` 回传，Runtime 终态 failed，详情为用户拒绝；denied.txt 不存在              | 拒绝的副作用检查通过                                                                                                                                         |
| 审批期间取消   | Runtime cancel + stopReason=cancelled；cancelled.txt 不存在；本回合已展示工具终态均为 failed | 官方 CLI + 本机夹具再验（`GajaeAcpToolProbe`，隔离 `C:\codework-cli-iso\gajae-0.18.1`）；底层仍可能无上游 cancelled 回应                                     |
| 连续两回合文本 | 两轮 `session/prompt` 均 `end_turn`，正文含 `GAJAE_LOOPBACK_OK`，无 conflict                 | Runtime 在非 cancelled 的 prompt 返回后等待 `update._meta.gjcPhase=idle`（仅 `agentInfo.name=gajae-code`）；60s 超时明确报远端状态未知，不自动重试或伪造完成 |

当前 `GajaeAcpToolProbe` 可在同一隔离会话验证连续文本、读取、命令批准与审批中取消；历史写入/拒绝记录来自原始协议探针，不能把当前测试名称当作覆盖这些动作的证据；`session/close` 偶发 5s 未知超时或 Windows 对 workspace 的 EBUSY，探针用非 scoped 临时目录 + 忽略 Busy 清理，关闭失败不掩盖前置断言。较早共享测试目录还出现 `cleanup_failed` 与 initialize 超时；无处理 Promise 拒绝已修正。不能替代进程崩溃恢复、外部模型或设备验收。

遇到明确关闭失败时先使用官方 SDK 核对端点身份清理；一项成功返回向持久化身份匹配的进程发送 SIGTERM。两项文件锁阻塞使 SDK 清理结果仍未知，最后只回收对应 `host_registered` 启动回执中的测试 PID，核对隔离 cwd、Windows 启动 FILETIME 和精确可执行路径，身份不符即停止。没有按名称或路径批量结束进程；最终进程检查无 gjc.exe 残留。

Gajae 的真实结果使用 `rawOutput.content` 的 MCP 文本数组；ACP 展示 `content` 同时包含命令预览、正文及正文摘要，可能重复。当前 HEAD 的共用 `AcpRuntimeModel` 已优先读取 MCP 文本结果，保留命令输入和 failed 状态；只限制已知文本块，图片与其它结果字段保持原样。每块原始文本及派生详情沿用 8,000 字符尾部上限，不对重复正文做全局去重，真实重复输出仍可保留。原始通知、data 与 detail 的有界副本分别保留。两项回归先复现重复内容和 20,012 字符绕过限制，再验证修复。该改动作用于共用 ACP 路径，无 Gajae 专用 Adapter，也不改合同或历史数据。

## 后续接入与回滚

连续回合 conflict 已在共用 Runtime 按 Gajae idle 信号收敛，并由官方 CLI 工具探针覆盖；恢复、聊天详情浏览器、外部模型账号、桌面、真实手机和远程模式仍待独立验收。已有本机夹具驱动的真实 CLI 工具/连续回合/审批取消证据，仍没有外部模型推理、账号余额、恢复或设备验收证据，不勾选完整接入完成。

本模块提交仅增加 `gajae-code` 的空闲等待和相关验证；共用 `session/close` 与取消补 failed 工具终态已在之前提交中存在。手工回退条目的认证默认值已存在；当前实时官方目录没有同 ID 条目。已有实例不自动迁移：若仍保存 `login`，在实例配置中改为 `agent`。本轮回滚只撤回 idle 等待和对应探针；此前关闭/取消提交及其它目录改动分别处理。无数据库迁移，不删除历史或修改用户凭据。

MCP 文本数组识别与长度限制可单独撤回；不撤回认证、关闭、Mobile 目录或账号池工作。

## 来源

检索词：`Gajae Code ACP authMethods agent terminal`、`gjc v0.18.1 windows x64`、`GJC_CODING_AGENT_DIR models.yml`、`session.close broker.shutdown`。访问日期 2026-09-30。优先采用官方固定 Release、同标签源码和实际二进制输出；网页缓存旧版本及文档命令示例不能覆盖实际结果。

- [官方 v0.18.1 Release](https://github.com/Yeachan-Heo/gajae-code/releases/tag/v0.18.1)：资产版本、大小和 digest。
- [固定 Windows 资产](https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.18.1/gjc-windows-x64.exe)：本次执行对象。
- [ACP 实现](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/packages/coding-agent/src/modes/acp/acp-agent.ts)：认证、会话配置、提示词和关闭语义。
- [官方 wire test](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/packages/coding-agent/test/acp-deep-interview-wire.test.ts)：本机模型预设与启动参数，已与同标签本地只读源码核对。
- [终端应用接入](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/docs/terminal-app-integrations.md)、[环境变量](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/docs/environment-variables.md)、[模型配置](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/docs/models.md)：配置和权限边界。
- [SDK CLI 说明](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/docs/sdk-session-cli.md)、[公开命令注册](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/packages/coding-agent/src/cli/public-command-registry.ts)：生命周期与实际入口，存在上述差异。

## 2026-10-01 空闲等待合同

仅已启动的当前根会话、非重放 session_info_update 的 update.\_meta.gjcPhase=idle 可以结束等待。该通知先于或后于 prompt RPC 返回都有效；其它会话、重放、其它更新类型与错误阶段不能放行。仅 agentInfo.name=gajae-code 启用等待，其它 ACP Agent 沿原路径。等待复用回合串行许可和 activePromptFiber，取消可结束 RPC 已完成后的等待阶段，失败/取消/超时均清理等待器。60 秒无 idle 返回 AcpRequestError，说明状态未知；本地结束不代表远端操作撤销。phase 不携带回合 ID，不能凭该信号证明远端取消已完成。

核对日期 2026-10-01；检索词 gjcPhase、publishPromptPhase、promptPhaseTails。采用上述固定官方提交的 ACP 源码，因它与受测二进制版本一致：上游以 session_info_update 发布工作/空闲阶段，RPC 结果和阶段发布有独立生命周期。实现复用现有标准通知和取消入口，不新建驱动、调度器或配置。

本轮协议子进程回归覆盖会话/重放隔离、早晚通知、等待期取消、状态未知超时、失败后恢复和其它 Agent。官方 opt-in 测试需要明确 CLI 路径，使用独立主目录和本机响应端点；跳过不算实测，原始历史记录不算本轮新鲜通过。回滚仅撤回本轮提交，无数据库迁移，不修改凭据/已有实例。

2026-10-01 增量合并核对：此前 MCP 结果识别与限长已经提交；仅元数据更新不能把已有正文变回命令摘要，null 原始输入/输出不清除旧值，明确新结果仍可替换。详见通用 ACP 文档的工具结果增量保留合同；本轮没有新增官方 CLI 或界面验收证据。

2026-10-01 目录核对采用 https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json 的实际响应，检索精确 gjc 及 gajae ID，共 41 项、匹配 0；因为它决定当前在线目录行为，不以未来可能收录来证明现存缺陷。响应证据仅为公开目录，不是安装、登录或模型验证。终态后补充通知的保留合同由共用 Runtime 提供，详见通用 ACP 文档；本轮未新增官方 Gajae CLI 验收。

## 无模型负向探针的来源与回滚

核对日期 2026-10-01，检索词 addImplicitDiscoverableProviders、disabledProviders、NoModelSelectedError、MODEL_NOT_SELECTED_PUBLIC_MESSAGE、turn.prompt、machine-local identity。采用同标签固定源码与官方资产原始 RPC，因它们分别解释自动发现、前检错误、SDK 安全消息和 ACP 出口；不按目录是否为空推断模型状态。

- [固定模型注册实现](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/packages/coding-agent/src/config/model-registry.ts)：隐式本地发现受 disabledProviders 控制。
- [固定模型说明](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/docs/models.md)：六类本地默认发现与禁用设置。
- [缺模型错误](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/packages/coding-agent/src/setup/model-onboarding-guidance.ts)、[SDK 错误出口](https://github.com/Yeachan-Heo/gajae-code/blob/v0.18.1/packages/coding-agent/src/sdk/host/control/dispatch.ts)：model_not_selected 的安全公开消息。

本增量只收录并修正可运行探针和本页，不修改生产默认发现、认证或错误映射。撤回对应提交即可回滚，无数据库迁移；测试设置只写入本次独立临时目录。
