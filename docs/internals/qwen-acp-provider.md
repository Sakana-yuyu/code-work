# Qwen ACP 工具与历史恢复合同

核对日期2026-10-01，Windows x64，固定官方@qwen-code/qwen-code 0.24.7、Node>=22。复用GenericAcpDriver → CursorAdapter → AcpSessionRuntime公共链路，没有新增Qwen专用驱动或重建历史逻辑。当前官方CLI与受控回环模型通过工具/审批及旧工具历史恢复；不表示真实账号、外部推理、余额、MCP、媒体或各客户端已验。

## 入口与配置

当前固定目录命令为npx -y @qwen-code/qwen-code@0.24.7 --acp --experimental-skills，认证方法openai。探针直接用Node --expose-gc执行已安装cli.js，Scope拥有CLI进程；官方包的cli-entry.js也是该程序的启动包装。配置OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL，模型和密钥由所选服务器环境或实例敏感字段提供，不能据authenticate成功推导额度或登录状态。

探针以独立HOME/USERPROFILE/APPDATA/LOCALAPPDATA及QWEN_HOME启动，显式覆盖系统默认/设置路径，关闭自动更新与遥测。isolatedProbeEnvironment空置非系统宿主变量，负向密钥为空字符串，避免启动层重新继承真实密钥。临时设置显式启用run_shell_command，关闭交互式shell，会话切到上游广告的default模式以验证逐项审批；不默认启用yolo/自动批准。

## 当前固定版本实测

| 阶段           | 断言与结果                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与能力     | qwen-code/0.24.7，广告authMethods仅openai、loadSession=true，模型目录非空，default模式实际选中；广告不能代替执行                                    |
| 认证错误       | login返回-32602，openai空Key返回-32603且含Missing API key；不把任意失败或会话建立当模型凭据成功                                                     |
| 正文/读取      | 本机/v1兼容端点校验实际model=codework-loopback，收到ACP正文；官方read_file读取源文件标记，原工具初始和终态标题相同                                  |
| 允许写入/命令  | 回传原allow_once选项ID，approved.txt实际内容APPROVED；run_shell_command原rawOutput.exitCode=0且输出含命令标记，本轮未增加非零命令检查               |
| 拒绝/取消      | 回传原reject_once选项ID，denied.txt不存在；审批阶段取消后原prompt=cancelled，cancelled.txt不存在，不表示运行中命令已被远端撤销                      |
| 取消后继续     | 同连接下一独立正文prompt=end_turn，才结束原CLI，不靠固定等待或自动重发                                                                              |
| 新进程恢复     | 第二CLI实际session/load成功恰1次，同sessionId；下一唯一恢复prompt触发的真实模型请求中，role=tool历史须同时包含旧QWEN_SOURCE_72319和QWEN_SHELL_72319 |
| 恢复回应与次数 | 恢复正文含QWEN_RESTORED_OK，恢复请求计数恰1，全部受控工具调用恰5；HTTP错误数组为空。标记响应、同ID或全局结果缓存都不能自证历史                      |

证据入口[QwenAcpCliProbe.test.ts](../../apps/server/src/provider/acp/QwenAcpCliProbe.test.ts)。旧探针已经能从同ID再次收到模型回应，但没有旧工具内容断言；本轮在模型端收到的实际请求体中检查历史，保留原认证/工具/审批断言及90秒截止。既有恢复实现通过，无需增加厂商补丁、伪造工具历史、模型重试或修改用户磁盘记录。

工具通知仅进入公共显示链，不让宿主再次执行CLI原生工具。工具内容/标题归一沿用[AcpRuntimeModel](../../apps/server/src/provider/acp/AcpRuntimeModel.ts)与[读取结果合同](../../apps/server/src/provider/acp/AcpReadFileOutput.test.ts)。本机响应端点负责合成模型选择和文本，真实文件/命令执行与ACP通知来自官方CLI；并非整应用、多端或外部账号联调。

## 复验与回滚

```powershell
$env:CODEWORK_QWEN_CLI_PATH = '<已安装固定0.24.7目录>/node_modules/@qwen-code/qwen-code/cli.js'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/QwenAcpCliProbe.test.ts
Remove-Item Env:CODEWORK_QWEN_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpReadFileOutput.test.ts apps/server/src/provider/acp/isolatedProbeEnvironment.test.ts
```

HEAD加精确模块索引、workspace依赖指向独立副本：官方CLI探针1项通过，14.83秒；读取结果/隔离环境两文件9项通过，普通Qwen probe未启用1项跳过，去重10项通过。Server类型检查退出0，仅既有账户文件两条建议；探针定向lint、格式通过。未重新执行旧未提交文档列出的浏览器、设备或130项结果，它们保留在工作历史，不进当前成功统计。

不复制真实Qwen配置或数据，不写在线数据库；独立HTTP连接、CLI与临时目录由Scope回收，不按名称批量结束进程。本模块是恢复验收/记录补强，回滚可撤回本轮探针断言和文档；生产恢复逻辑未改，无数据库迁移或账户状态变更。全部44入口/P0–P5及最终独立审计仍未完成。

检索词Qwen v0.24.7 loadSession restore history ACP，访问日期2026-10-01；采用[官方固定tag ACP入口](https://github.com/QwenLM/qwen-code/blob/v0.24.7/packages/cli/src/acp-integration/acpAgent.ts)、[官方认证说明](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)与[官方设置](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)，因为它们定义恢复/配置边界。网页tag文件未直接展现完整代码，本轮具体恢复实现另读取已安装固定0.24.7的loadSessionWithProfiler/projection/replay路径；实际恢复能力以探针为准，不由当前文档的其它认证协议推断该固定版本可用。


## 历史工作记录（原文保留，不作本次验收）

# Qwen Code 的 ACP 接入与工具验证

核对日期：2026-09-30。固定官方版本为 `@qwen-code/qwen-code@0.24.7`，要求 Node.js >=22。本轮实际启动官方 CLI，验证协议、文件和命令副作用；模型响应来自仅监听本机回环地址的测试端点，没有使用真实 Qwen 账号或外部模型。两类证据必须分开理解。

## 入口、认证与配置

复用 `GenericAcpDriver` → `AcpSessionRuntime` → 公共 ACP 事件解析，不增加 Qwen 专用 Adapter。在添加供应商的 ACP 目录搜索 Qwen，选择固定版本命令：

```text
npx -y @qwen-code/qwen-code@0.24.7 --acp --experimental-skills
```

Windows 目录使用已有 `cmd.exe /d /s /c` 包装。实际探针以 Node 的 `--expose-gc` 参数直接运行软件包 `cli.js`，对应官方 `cli-entry.js` 包装器启动的同一程序，并让测试作用域直接管理 CLI 进程。

目录合同新增可选 `authMethodId`，由服务端按已核对的 Agent ID 填入：Qwen 为 `openai`、Gemini 为 `oauth-personal`、Copilot 为 `copilot-login`。选择目录条目同时更新启动命令与认证方法；未知条目恢复通用 `login`，避免把前一个 Agent 的认证方式带过去。用户仍可手工修改，已有实例不会自动重写。

Qwen 的 OpenAI 协议配置使用 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。密钥通过所选服务器环境或实例敏感变量配置，不放到命令或日志中。`QWEN_HOME` 直接指向 Qwen 配置目录；测试同时覆盖系统设置路径、关闭遥测和自动更新。独立配置目录不等于操作系统沙箱。

官方配置还列出其它认证协议，但本轮 0.24.7 的真实 ACP initialize 只广告 `openai`。不能把枚举接受某个方法等同于成功认证；Qwen OAuth、Anthropic、Gemini、Vertex 和 Responses 路径均没有本轮成功调用证据。

## 官方 CLI 的实际响应

| 项目 | 0.24.7 实际结果 |
| --- | --- |
| initialize | 协议 1；agentInfo 为 qwen-code / Qwen Code / 0.24.7 |
| authMethods | 仅 openai，说明要求 OPENAI_API_KEY |
| 错误 login | -32602 Invalid params，保留上游枚举诊断 |
| openai 缺少密钥 | -32603，data.details 包含 Missing API key |
| 未认证建立会话 | 原始协议探针返回 -32000 Authentication required |
| 会话能力广告 | loadSession、list、resume；输入 image/audio/embeddedContext；MCP HTTP/SSE |
| 本地模型会话 | 模型目录含配置的 OpenAI 运行时模型；同时收到 model/mode 配置 |
| 模式 | plan/default/auto-edit/auto/yolo；此次初始值为 auto，探针显式切到 default |

广告能力不代表应用对应能力全部验收。例如图片、音频、MCP 以及真实外部模型仍需单独证据。需要逐项审批时应核对上游模式与 Code Work 权限，不能从 CLI 初始 auto 推断会出现每次审批。探针显式启用延迟加载的 `run_shell_command`，关闭交互式 shell，验证普通命令路径；Windows 此路径实际使用 cmd，不能假设是 PowerShell。

## 修复工具完成后名称退化的问题

Qwen 的 `tool_call_update` 可以只包含状态和内容，不重复初始标题。原公共解析器仍派生出默认标题 `Tool`，合并后覆盖已经显示的 `ReadFile …`。新行为只在上游确实携带标题时更新派生标题，内容、状态照常更新；缺省字段由现有合并逻辑保留。

修复位于 `AcpRuntimeModel.ts` 的公共边界，所有 ACP 调用者复用。回归先复现“原工具名称变成 Tool”的失败，再验证部分完成更新保留名称和结果。真实 Qwen 探针另外比较首条与最终工具标题；显式标题更新仍沿用原处理方式。

## 可重复验证

在仓库外安装固定官方包，将以下变量指向实际文件即可运行。未设置变量时跳过，不会在普通测试中自动下载 CLI 或调用付费模型。

```powershell
$env:CODEWORK_QWEN_CLI_PATH = 'C:/隔离安装目录/node_modules/@qwen-code/qwen-code/cli.js'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/QwenAcpCliProbe.test.ts
```

探针创建作用域临时 home/workspace，启动只监听 `127.0.0.1` 的 OpenAI 兼容响应端点，并使用仅用于该端点的合成密钥。模型回复和工具选择是测试生成的，工具执行和 ACP 响应来自真实 CLI。通过唯一 completion/tool-call ID 与当前 prompt 标记关联响应，避免后台请求消费下一步工具指令；等待协议结果和事件屏障，不使用固定等待猜测完成。

验证覆盖：错误认证、缺失密钥、模型及模式目录、文本流、读取真实临时文件、批准写入、命令退出码 0 和输出、原生 optionId 拒绝且文件未生成、取消且文件未生成，以及结束原进程后从同一隔离 home 恢复会话并再次响应。

| 验证范围 | 结果与边界 |
| --- | --- |
| 官方 Qwen 探针 + RuntimeModel/CoreRuntimeEvents + Cursor/Grok Adapter | 5 文件 130 项通过，41.82 秒 |
| 2026-09-30 隔离复测（`C:\codework-cli-iso\qwen-0.24.7`，`--ignore-scripts`，cli 0.24.7） | `QwenAcpCliProbe.test.ts` 1 项通过；本地夹具模型，非外部账号 |
| 目录、添加向导、目录选择器与官方探针 | 4 文件 21 项通过；与上行存在重复探针，不累计为独立测试数 |
| Server、Web、Mobile 类型检查 | 通过；Server 仅既有账号池 Effect 建议 |
| 本轮 8 个源码/测试 lint | 通过 |
| 浏览器添加流程 | Qwen 0.24.7 命令、openai 预填、从 Gemini 切换后更新认证；360px/1280px 无整页横向溢出 |
| 外部账号和模型、聊天工具 UI、Electron、原生手机、远程/relay/tunnel | 本轮未完成实测 |

官方包安装提示音频采集安装脚本未获 allowScripts 允许，本轮未启用，音频能力不在通过范围。浏览器只检查添加向导，没有保存真实 Qwen 实例或发送聊天。截图及原始探针结果保留在仓库外；没有写在线数据库。

## 来源与回滚

检索关键词：`site.qwenlm.github.io qwen-code ACP authentication --acp`、`site.github.com/QwenLM/qwen-code releases ACP`；访问日期为 2026-09-30。采用官方配置、认证文档和 npm 实际发布包，协议事实以固定版本执行结果为准，避免搜索缓存中的旧版本覆盖实际安装版本。

- [官方认证配置](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md)：认证协议与环境变量。
- [官方设置](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md)：配置路径、工具可见性、审批及 shell 设置。
- [官方发布记录](https://github.com/QwenLM/qwen-code/releases)：发布背景；固定包实际版本另由 CLI `--version` 确认。
- [npm 官方包](https://www.npmjs.com/package/@qwen-code/qwen-code/v/0.24.7)：本轮版本和 Node 引擎约束。安装记录 SHA-512 为 `NE+Ps9juMJS7DaHEVENIAJWCrzTiO/2bNq2TidmxmFc0ZbSMVKCfX3tlu2RY+CoP8xHFfUcy3MfQDQNszBJpJQ==`。

无数据库迁移。回滚仅撤回目录认证预填、公共标题缺省判断及对应测试，不覆盖其它 Provider 或账号池改动；已有 ACP 实例保留。撤回标题判断会恢复已经复现的工具名称退化。后续在所选环境具备合法模型凭据后补齐真实推理与聊天工具 UI，再验证多端和连接模式，不能用本地响应端点替代这些验收。
