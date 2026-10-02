> 当前提交实现以文末“2026-10-01 当前提交实现”一节及HEAD文档为准。以下旧账号/浏览器结果保留为历史工作记录，未在本轮复验。

# Copilot ACP 接入与官方 CLI 验证

核对日期：2026-09-30。实际版本为 GitHub Copilot CLI **1.0.89**，Windows x64，官方 npm 包 `@github/copilot@1.0.89`。本记录只证明下面列出的路径，不代表所有平台、全部模型或整个供应商计划已验收。

## 入口与调用

Web／桌面“添加供应商”中的 GitHub Copilot ACP 按钮进入既有 ACP 目录，并筛选 `github-copilot-cli`；用户确认版本后填入命令。保存仍使用 `acpAgent`，不增加另一套驱动、会话或工具状态。实例保存到当前选择的服务器环境。Mobile 可通过已有 ACP Agent 手工配置入口使用，尚无同样的目录快捷按钮。

安装在 PATH 时命令为 `copilot --acp`；目录使用固定版本 `npx -y @github/copilot@1.0.89 --acp`，Windows 沿用共享启动层。初始化、模式、命令、工具更新、审批、取消和恢复复用 AcpSessionRuntime → CursorAdapter → 既有事件投影。详细合同见 [通用 ACP 实现](./generic-acp-provider.md)。

实际 initialize 广告认证方法 `copilot-login`。本机已有 GitHub CLI 登录态，Copilot 直接使用后端认证；没有运行 OAuth 授权或复制 token。原始探针也确认当前版本接受 `authenticate` 的 `login`，但这是该版本兼容行为，配置建议使用广告的 `copilot-login`。登录本身应使用官方终端 `copilot login`；不能把版本探测成功或单独 authenticate 成功当成模型可用。

## 实测矩阵

| 路径                         | 实际证据                                                                                    | 结论                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 版本与握手                   | 官方 native CLI 返回 1.0.89；initialize/new 成功                                            | 通过                                              |
| 认证与文本                   | 既有 GitHub CLI 登录态下，真实模型返回指定短句；没有 COPILOT*PROVIDER*\* 覆盖               | 通过，不代表所有账号有资格                        |
| 模式                         | URI Agent → Plan → Agent，读取运行时当前模式一致                                            | 通过                                              |
| 权限默认                     | 会话配置 `allow_all` 为 `off`                                                               | 没有自动开启无人值守                              |
| 读文件与写入                 | 读取隔离 workspace/source.txt；允许一次工具请求后 approved.txt 字节内容正确                 | 通过                                              |
| 命令工具                     | 真正调用 PowerShell 工具执行指定 Write-Output，工具为 execute/completed，回复包含实际结果   | 通过                                              |
| 拒绝                         | 返回上游 reject_once 的 optionId，denied.txt 不存在                                         | 通过                                              |
| 取消                         | 收到权限请求时发送 session/cancel；stopReason=cancelled，cancelled.txt 不存在               | 通过                                              |
| 进程重启与恢复               | 关闭首个 CLI，再以同一独立 home 调用 session/load；新回复正确引用之前读取的内容             | 通过                                              |
| 命令发现                     | 真实 available_commands_update 包含 usage 等条目                                            | 通过                                              |
| 模型目录                     | new 未返回 models，配置没有 model 类别；`/model` 返回交互式 CLI 才支持模型选择器            | 本次未广告，不能伪造菜单或宣称动态模型验证通过    |
| custom agent、allow_all 切换 | 合成无工具 profile 被官方广告；角色 → 默认空字符串、on → off 写回后读取一致，模式仍为 Agent | 官方 1.0.89 通过；未在 Allow All 开启期间执行工具 |
| 浏览器                       | 快捷按钮 → 所选环境目录 → 固定版本命令，返回命名；360px 无横向溢出                          | 入口通过；未做真实 Copilot 聊天 UI 全链路         |
| Electron／原生手机／远程连接 | 本轮未运行                                                                                  | 未验证                                            |

官方 CLI 探针是 `apps/server/src/provider/acp/CopilotAcpCliProbe.test.ts`。仅显式设置二进制路径时运行，会使用现有登录并产生模型用量；普通测试不会安装 CLI 或调用模型。

```powershell
$env:CODEWORK_COPILOT_CLI_PATH = 'C:\codework-cli-iso\copilot-1.0.89-npm\node_modules\.bin\copilot.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/CopilotAcpCliProbe.test.ts
Remove-Item Env:CODEWORK_COPILOT_CLI_PATH
```

2026-09-30 续（R53）：取消步曾未收到权限回调（`permissions` 仅 `allow/allow/reject`），不把那次标为通过。
2026-09-30 续（R54）：探针改为先 `fork` prompt、在 `handleRequestPermission` 见到取消步权限后再断言；隔离 `@github/copilot@1.0.89` + 既有 `gh` 登录下 **1/1 通过**（约 40s），含取消 `stopReason=cancelled` 与恢复。取消矩阵行恢复为通过；仍不是 Electron/真机/聊天 UI 全链路。

探针使用独立临时 COPILOT_HOME 和工作目录，测试材料是合成文本，权限按上游一次性选项回应。只关闭自身启动的进程，测试完成清理自身临时数据。它不是操作系统沙箱：既有 GitHub CLI 登录会作为认证后备，CLI 仍可能发现用户级技能目录；没有复制凭据，也不打印 token。测试通过真实事件和队列 drain 同步，没有添加固定等待。

曾尝试断言所有 CLI 都会提供非空模型列表，实际失败；直接检查 Copilot 原始响应确认没有该广告，撤掉的是错误的探针假设，没有向生产模型目录填入假数据。模型目录仍以实际广告为准，custom agent 与权限选择按下面的会话配置合同处理。

## 会话角色与权限的实现

2026-09-30 在官方 CLI 的独立 `COPILOT_HOME/agents` 创建 `codework-profile.agent.md`，frontmatter 使用 name、description 和 `tools: []`。原始 `session/new` 广告三个 select 配置：`mode`（URI 模式）、`agent`（category `_agent`）和 `allow_all`（category `permissions`）。默认角色的 value 是空字符串，权限默认 off；配置响应和异步 `config_option_update` 都返回完整列表。

角色和权限使用现有 `SelectProviderOptionDescriptor` / `ModelSelection.options`，无需新建 Copilot Adapter。`toAcpConfigOptions` 只开放已核对的 `_agent` 和 `permissions` 两类 select：ID 为 `acpConfig:` 加 URI 编码后的原始 configId，候选值为 `value:` 加 URI 编码后的原值。因而默认角色显示为 Copilot，内部选项 `value:` 可通过既有非空字符串合同，提交时精确还原为空字符串；空格、百分号、分组候选同样保留。其它类别继续由原实现处理，不猜测未知控件。

`session.started` 和 `session.configured` 增加可选 configOptions；共用 ingestion 投影为实例归属的 `session.config-options.updated`。Web、桌面和 Mobile 共用 `applySessionModelCatalogs`，将当前配置合并到当前线程同实例的模型参数；空列表撤回，坏快照不替换最近合法快照，元数据不作为工具日志展示。每次提交前 `applyAcpConfigSelections` 按最新广告逐项校验，失效值和类型错误阻止 prompt；缺省不写配置，相同值由原运行时跳过。模式先设置，角色与显式权限后设置，避免模式改变权限后覆盖用户选择。

通用 ACP 增加“CLI 默认模型”选择，含义是让 CLI 使用自己的默认模型，并非声称发现了某个具体模型。上游没有提供模型信息时保留此入口；未广告 `default` 模型时不发送模型覆盖请求。真正的动态模型广告仍替换目录；完整快照撤回已有 model 类别时清空会话广告。这样 Copilot 没有模型列表也能启动，并显示角色和权限。

注意权限存在两个独立控制面：Copilot 的 Allow All 开启后，CLI 可能不再发审批请求；Code Work 的“完全访问”等运行模式则控制收到请求后的处理。需要人工审批时，应选择 **Allow All Off + 受监督**。本次不默认开启 Allow All，也不把它等同于 Autopilot；实际 on/off 往返后模式仍为 Agent。更改在下一条消息提交时应用，已执行的工具不会因此撤销。

验证：官方 opt-in 探针在原生产运行时中完成 profile → 默认、on → off、失效角色拒绝，并复验文本、读写、命令、拒绝、取消、恢复；最终 1 项通过，用时约 36 秒。GenericAcpDriver 子进程 fixture 从真实启动到事件投影、两次 prompt 和原始 configId/value 日志验证完整往返；默认角色写回值确为空字符串，未发送模型覆盖。浏览器使用明确标注的协议 fixture：CLI 默认入口启动、审查角色选择、恢复 Copilot、Off 保持、360px 更多控件和刷新后的状态；这仍不是官方 Copilot 聊天 UI 或原生手机实测。

## 来源与回滚

检索词：`Copilot CLI ACP --acp authentication COPILOT_HOME`、`copilot acp auth config-dir`。采用 [GitHub 官方 ACP 文档](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)、[官方认证说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) 和 [配置目录说明](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)，并以安装包实际 `--help`、原始 ACP 报文和运行时探针确认当前版本行为。文档说明与具体版本可能不同，以版本化实测边界为准。

新增检索词：`site:docs.github.com Copilot CLI custom agent agents .agent.md tools`。访问日期同为 2026-09-30。采用 [官方自定义 Agent 配置参考](https://docs.github.com/en/copilot/reference/custom-agents-configuration)、[CLI 调用自定义 Agent](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents) 及上述配置目录说明，因为这些来源直接定义 agents 目录、frontmatter 和空 tools 的含义，再以实际 ACP 响应验证字段。

无需迁移数据库。撤回添加页快捷入口和目录初始搜索参数即可回到原向导；已有 acpAgent 实例继续有效。官方探针可独立撤回，不影响生产运行时。不要撤回之前的账号池或共用 ACP 修复。

角色/权限闭环回滚时撤回本次可选事件字段、ACP 转换和写回、共享菜单合并与 CLI 默认入口即可；应先将活动会话 Allow All 设为 Off，并结束这些测试会话。客户端已保存的选项会随目录撤回而移除，回滚代码不会反向撤销已经执行的工具。不要覆盖此前各轮的 ACP 模式、用量、命令或账号池改动。

## 2026-10-01 当前提交实现

# Copilot ACP 接入与离线工具验证

核对日期2026-10-01，Windows x64，官方npm包@github/copilot 1.0.89及同版本@github/copilot-win32-x64/copilot.exe。本页记录当前提交模块的实际验证；历史真实GitHub账号探针和浏览器报告不作为本次外部推理/设备验收。原6内置+38ACP目标和A-8最终审计仍未由本模块完成。

## 调用与配置

Copilot复用GenericAcpDriver、AcpSessionRuntime、公共ACP工具事件和客户端合同，不新增Driver或会话状态。安装在PATH时配置copilot --acp，Windows命令解析复用既有启动层；本探针直接启动固定官方native可执行文件，不能把它作为.cmd/npx重新验证的证据。目录与环境选择仍沿[通用ACP入口](./generic-acp-provider.md)。

Copilot支持GitHub后端认证，也支持官方BYOK模式。本次采用COPILOT_OFFLINE=true、COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:<随机端口>/v1、TYPE=openai、WIRE_API=completions、合成API Key及COPILOT_MODEL=codework-loopback，不执行GitHub认证。保存实例时认证方法填空字符串表示省略authenticate；不是其它认证方法名，也不是登录成功。官方1.0.89 help与当前官方文档均说明该路径无需GitHub登录；离线模式关闭GitHub认证、遥测、更新与网络工具。探针只验证配置生效后的本机请求，并非操作系统网络沙箱或外部认证证明。

环境复用isolatedProbeEnvironment，显式空置宿主非系统变量并覆盖HOME/USERPROFILE/APPDATA/LOCALAPPDATA/COPILOT_HOME。测试运行器额外提供合成宿主GH_TOKEN、旧Provider Key和Allow All true，子进程仍用本机Key且allow_all=off。不打印/复制真实凭据，不修改用户安装配置或在线数据库。CLI只广告view/create/powershell三种测试工具，禁用builtin MCP与自定义指令，使用独立home/agents下的合成无工具角色。

## 会话角色、模式与默认模型

模式ID保留官方URI的#agent/#plan，Agent → Plan → Agent真实RPC往返后读取一致。角色agent属于\_agent类别，权限allow_all属于permissions；复用现有toAcpConfigOptions/applyAcpConfigSelections，客户端候选value:表示原始空字符串默认角色，acpConfig:编码原configId。角色codework-profile → 默认和allow_all on → off写回后广告一致，失效角色在发送前明确拒绝。开启Allow All期间没有执行工具。

本次new没有模型目录广告；COPILOT_MODEL是BYOK请求设置，不是运行时发现的模型。保留现有CLI默认模型入口，不伪造目录/切换证据。命令目录收到usage，但没有逐条执行斜杠命令。Allow All与应用处理审批的运行模式是两层控制：人工审批应保持Allow All Off，配置生效不撤销已执行工具。

## 当前实测矩阵

| 路径                    | 当前结果                                                                       | 证据边界                                 |
| ----------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| 安装/握手               | 已安装固定官方1.0.89，精确握手断言                                             | 没有本轮重新安装或证明所有平台           |
| 认证/文本               | 无GitHub登录的离线BYOK建会话，真实CLI请求本机模型且收到正文                    | 模型回复是合成回应；外部账号和推理未验证 |
| 角色/权限/模式          | 空角色编码、profile/default、on/off、非法角色拒绝、URI模式往返                 | 复用既有合同，不代表所有自定义角色行为   |
| 读取                    | view实际读取source.txt，模型tool响应包含合成文件内容；read/completed           | 没有搜索、MCP或远程文件验证              |
| 写入/允许               | create经原生allow_once optionId，approved.txt字节为APPROVED                    | 原生工具执行一次，宿主不重复执行         |
| 命令成功                | PowerShell Write-Output实际输出；rawOutput.exitCode=0且completed               | 只执行合成命令                           |
| 命令失败                | exit 7原始ACP仍completed，但结构化shell_exit为7；派生failed、退出码7，保留原帧 | 不从正文猜测退出码                       |
| 拒绝/取消               | 原始reject_once optionId或cancelled；对应文件不存在，取消回合终态正确          | 取消不是已执行副作用的撤销               |
| 新进程恢复              | 同sessionId启动第二个CLI；下一模型请求含之前读取的文件内容，回复标记收到       | 不是浏览器刷新、服务器崩溃或设备恢复     |
| Web/Desktop/Mobile/连接 | 本轮未执行                                                                     | 不用共享协议测试替代界面或真实设备       |

CopilotAcpToolProbe.test.ts是当前可重复入口，只在显式CODEWORK_COPILOT_OFFLINE_CLI_PATH时运行实际CLI，普通测试跳过不计通过。模型端点校验路径、Bearer合成Key、wire model、原始OpenAI请求与SSE；按当前prompt标记和上游工具目录消费动作，防后台请求误领工具。Scope回收自身listener/进程/临时目录，事件drain同步，不使用固定睡眠。

实际探针1项通过（约9.01秒）；7个相关测试入口77项通过、1项未启用官方探针跳过（约6.87秒），单独启用后本模块去重78项通过。Server类型检查与4个变更TS定向lint通过。初次加入exit7断言时实际失败，原始结构化输出确认根因；归一后正式原探针通过，诊断/重复不计测试总数。

## 退出结果归一与显示

CopilotAcpToolResult只处理握手name=Copilot、tool_call_update/completed且未明确属于其它kind的通知。rawOutput.contents中恰好一个type=shell_exit提供数值安全32位非负exitCode时，保留所有结果字段并补rawOutput.exitCode；0保持completed，非零改failed。已有顶层退出字段不覆盖，文本标记、其它Agent、畸形数值或多个shell退出不推断。多退出结果没有唯一结束码，当前明确保留边界，不泛化为批量规则。

这次适配放在共用会话通知入口，恢复后的通知使用同一路径；派生工具状态进入既有合并、持久化和各客户端合同，rawPayload仍是原始通知。3项边界测试覆盖实际无kind终态、0/7、原帧不变、其它Agent/阶段/工具、已有退出字段、畸形或多结果。没有再次执行原生命令，不改变其它Agent的工具解析。

## 复验与回滚

```powershell
$env:CODEWORK_COPILOT_OFFLINE_CLI_PATH = '<固定1.0.89目录>/node_modules/@github/copilot-win32-x64/copilot.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/CopilotAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_COPILOT_OFFLINE_CLI_PATH
```

历史CopilotAcpCliProbe.test.ts依赖既有GitHub登录并会产生模型用量，本模块没有执行或交付它，不能与当前离线探针共用变量/默认启用。真实账号测试应另行核对授权和范围。

检索词Copilot CLI ACP BYOK、COPILOT_OFFLINE、custom providers，访问2026-10-01。采用[GitHub官方ACP说明](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)、[官方认证与离线模式](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)、[官方自定义Provider说明](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli)及固定1.0.89 help providers/environment，因为这些定义实际启用方式；功能结论以固定二进制和本次协议/副作用实测为准。当前在线文档可能更新，不能替代固定版本断言。

没有依赖、账户或数据库迁移。撤回本模块归一化入口/助手、测试与说明即可；会退回上游completed标签，但已执行命令不撤销，原始历史不删除。保留此前通用ACP配置/模式/账号池/Gemini恢复保护，不把回滚本模块等同于回滚全部Provider。
