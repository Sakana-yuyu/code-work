# 首批 ACP Agent 的可重复工具验证

Qwen、Cline、Hermes、Gemini 使用现有 GenericAcpDriver 和公共 ACP Runtime。这里交付的是固定官方 CLI 的可重复验证入口，不增加另一套 Driver、工具状态或客户端展示。核对日期2026-10-01，Windows x64；模型回复及工具选择由仅监听127.0.0.1的合成端点产生，文件/命令副作用和ACP通知来自实际CLI。此结果不能证明外部模型推理、账号余额或全部设备/连接可用。

## 当前执行结果

| Agent  | 固定版本                    | 认证/配置                                                                                        | 已执行动作                                                                                                              | 未证明的范围                                                                                    |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Qwen   | @qwen-code/qwen-code 0.24.7 | openai合成凭据；错误login、明确空密钥失败；模型/模式目录与default模式                            | 文本、读取、允许写入、shell输出/退出码0、原生optionId拒绝、取消、同sessionId新进程恢复                                  | 外部认证/推理、真正UI、设备、远程；恢复后只证明会话ID和再次响应，未断言旧文件结果仍在模型请求中 |
| Cline  | 3.0.65                      | 省略authenticate，独立providers.json使用openai-compatible；模型选择gpt-4o，auto_approve保持false | 文本、read_files内容、apply_patch写入、run_commands成功/exit7失败、拒绝、取消、新进程恢复后请求含旧读取结果             | 本轮无OAuth/外部模型；没有再次验证Web/Desktop/Mobile或连接                                      |
| Hermes | v2026.9.24，握手0.21.5      | 独立custom本机端点；两个模型实际请求，default模式，显式Git Bash路径                              | 文本、read_file内容、write_file、terminal成功/exit7失败、拒绝、取消、新进程恢复后请求含旧读取结果、审批ID不作为真实工具 | 本轮无外部账号/模型；没有再次验证Web/Desktop/Mobile或连接                                       |

三条官方CLI探针本次各1项通过；完整测试包含每行列出的多个动作，不能把动作数量当成独立测试数。Qwen约12.12秒、Cline约7.13秒、Hermes约29.06秒。独立模型端点收到真实CLI请求并返回合成回应；文本标记本身不证明模型推理，工具验证另断言文件内容、命令结果、工具终态及未生成的拒绝/取消文件。

首批范围还包含Copilot：其真实模型探针需要既有账户，当前不重复调用，尚未提交的历史探针也不作为本页交付文件；Gemini的本机工具与版本恢复限制见下节。本页没有替代Copilot或整个首批验收。全部44入口及最终门槛仍见 [入口验收合同](./acp-provider-validation.md)。

## 运行与环境隔离

先在仓库外准备相应固定官方安装，将变量指向实际入口，不在测试中自动安装或调用付费模型。Qwen路径是官方cli.js，由Node启动；Cline路径是官方平台可执行文件；Hermes路径是独立venv中的hermes-acp，Windows另需Git for Windows。

```powershell
$env:CODEWORK_QWEN_CLI_PATH = '<实际安装目录>/node_modules/@qwen-code/qwen-code/cli.js'
$env:CODEWORK_CLINE_CLI_PATH = '<实际安装目录>/node_modules/@cline/cli-windows-x64/bin/cline.exe'
$env:CODEWORK_HERMES_CLI_PATH = '<实际安装目录>/venv/Scripts/hermes-acp.exe'
$env:CODEWORK_HERMES_GIT_BASH_PATH = 'C:/Program Files/Git/bin/bash.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/QwenAcpCliProbe.test.ts apps/server/src/provider/acp/ClineAcpToolProbe.test.ts apps/server/src/provider/acp/HermesAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_QWEN_CLI_PATH, Env:CODEWORK_CLINE_CLI_PATH, Env:CODEWORK_HERMES_CLI_PATH, Env:CODEWORK_HERMES_GIT_BASH_PATH
```

普通测试未提供路径时跳过官方CLI，不把跳过写成成功。握手断言固定版本，其他版本应先核对协议再更新测试，不能只放宽版本或移除失败断言。探针仅用合成材料与独立临时数据，复用Scope收尾、原生审批选项、当前prompt身份和事件drain，不靠固定睡眠。

公共测试助手 [isolatedProbeEnvironment](../../apps/server/src/provider/acp/isolatedProbeEnvironment.ts)保留PATH/PATHEXT及Windows系统/临时目录项，显式空置其余宿主变量，再覆盖HOME、USERPROFILE、APPDATA和LOCALAPPDATA。三个调用点各自添加QWEN_HOME、CLINE_DATA_DIR或HERMES_HOME、固定本机端点与合成凭据；Hermes只显式恢复Python UTF-8与Git Bash路径。CLI仍可访问机器资源，这属于配置隔离，不是操作系统沙箱。

不能只删除环境键：启动层合并宿主环境时会补回它。Qwen旧探针在合成宿主OPENAI_API_KEY存在时错误地使缺密钥会话成功；当前探针使用显式空字符串，真实CLI负向检查恢复失败。环境助手回归同时核对合并后凭据/代理/旧配置目录仍空、系统项保留和原输入没有被修改。助手只供测试使用，生产Agent实例的凭据继承策略保持原行为。

Qwen关闭自动更新/遥测、重定向系统设置，并限定shell可见性；Cline 3.0.65使用真正读取的CLINE_DATA_DIR和providers.json，不能仅依赖--data-dir；Hermes按官方custom配置指定端点、文件/terminal工具并禁用测试MCP。上游工具内容来自事件，显示通知不让宿主重复执行原生工具。

## 来源与回滚

公开来源访问日期2026-10-01，检索词Qwen ACP authentication、Cline ACP cli-v3.0.65、Hermes ACP f97608f。采用 [Qwen固定版本认证说明](https://github.com/QwenLM/qwen-code/blob/v0.24.7/docs/users/configuration/auth.md)、[Cline固定版本ACP说明](https://github.com/cline/cline/blob/cli-v3.0.65/docs/usage/acp.mdx)及 [Hermes固定提交ACP实现](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/acp_adapter/server.py)，因为它们定义配置及实际协议入口；本页成功动作仍以固定安装包执行结果为依据。

无需数据迁移。可独立撤回三探针、环境助手/回归及本页说明，不修改生产Driver、账号池、目录或用户实例。已经交付的认证方法、工具合并、审批和客户端显示修复应保留；此测试模块不是那些生产修复的替代实现。

## Gemini 0.61.0 的工具与恢复边界

核对日期2026-10-01，Windows x64，固定官方@google/gemini-cli 0.61.0，以Node运行bundle/gemini.js --acp --model gemini-2.5-pro。仍复用GenericAcpDriver、AcpSessionRuntime和共同工具/客户端合同，没有新增Gemini专用Driver。GeminiAcpToolProbe.test.ts显式启用后运行实际CLI，模型端点仅监听127.0.0.1；不能证明外部Google认证、额度、推理、设备或远程连接。

使用官方gateway认证方法、GOOGLE_GEMINI_BASE_URL和合成GEMINI_API_KEY。环境助手覆盖GEMINI_CLI_HOME及系统设置路径，关闭遥测和自动更新。独立设置中tools.core限制为read_file/write_file/run_shell_command；0.61.0同时把core工具设为允许，必须再声明confirmationRequired=[write_file,run_shell_command]才能测试原生审批，不能把工具白名单误当审批开关。default模式保持启用，未选yolo。

真实广告的模型为auto、gemini-2.5-pro、gemini-3.8-flash、gemini-3.5-flash-lite；探针选择已广告gemini-2.5-pro，并核对实际请求URL中的型号。默认/自动编辑/yolo/plan是模式广告，当前只验证default写回；命令目录非空，不等于逐条命令执行。Google API请求和SSE响应按现有Schema校验、prompt标记、唯一响应/工具ID关联，不让后台请求消费下一工具动作。

| 验证项     | 当前结果与边界                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 安装/握手  | 使用仓库外已安装的官方0.61.0，握手断言精确版本，不采用工作树中的宽松版本断言                                            |
| 认证       | gateway合成本机配置成功；原GeminiAcpCliProbe的login错误和缺API Key失败2项重新通过；不是外部认证证明                     |
| 文本/读取  | 正文标记收到；真实read_file内容进入模型functionResponse，工具归一状态completed                                          |
| 写入/允许  | 回传上游allow_once的原始optionId，实际approved.txt内容一致                                                              |
| 命令       | echo输出实际可见；exit 7的模型结果含Exit Code: 7，归一后失败状态/退出码可见，原始ACP帧仍保持completed用于追溯           |
| 拒绝/取消  | 回传原始reject_once选项或cancelled；denied.txt/cancelled.txt均不存在，取消回合终态正确                                  |
| 新进程恢复 | 0.61.0有上游历史丢失缺陷，Code Work在发送session/load前报明确错误，旧会话文件字节不变；当前不支持恢复，不能记为成功恢复 |

实际工具探针1项通过（约12.79秒），两个负向认证项通过（约8秒）；普通相关入口134项通过、三项未启用的官方CLI测试跳过。独立执行3个官方项后，本模块去重共137项通过。Server类型检查、4个变更TS文件定向lint通过；没有重新验证UI/Electron/Mobile/远程。

命令适配只处理gemini-cli的run_shell_command\_\_调用、execute类型、completed终态、无已有rawOutput、唯一标准文本Command exited with code: N，且N为非零有效32位退出码。转换保留正文与原始帧，通过现有失败工具合同进入各客户端，既不重复执行也不推断成功退出码0。纯stdout恰好完全等于该上游标记仍有歧义；有输出的非零退出在0.61.0普通ACP显示中可能不携带退出码，当前不能可靠判定，保留未验证边界。上游提供结构化退出码后应移除文本适配，不能泛化为所有Agent/任意报错正文。

恢复反证显示：上游session/load先initializeSessionConfig，初始化同ID记录时追加仅含session_context的$set.messages，再查SessionSelector；官方读取器据此清除旧消息并认为没有可恢复会话。本模块仅阻止agentInfo.name=gemini-cli且version=0.61.0的恢复，错误reason为gemini-0.61.0-session-load-history-loss，不静默新建会话或重试。其他版本仍按原路径处理，不能据此断言其它版本安全。探针比较目标会话已有jsonl内容，不把上游可清理的空启动记录误当用户历史。

```powershell
$env:CODEWORK_GEMINI_CLI_PATH = '<固定0.61.0安装目录>/node_modules/@google/gemini-cli/bundle/gemini.js'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GeminiAcpCliProbe.test.ts apps/server/src/provider/acp/GeminiAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_GEMINI_CLI_PATH
```

检索词Gemini ACP gateway、0.61.0 acpSessionManager/loadSession、shell returnDisplay，访问2026-10-01。采用[官方ACP说明](https://geminicli.com/docs/cli/acp-mode/)、[固定版本端点实现](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/core/contentGenerator.ts)、[会话管理](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpSessionManager.ts)、[工具事件](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpSession.ts)和[shell结果](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/tools/shell.ts)，因为它们定义实际协议及调用顺序；故障与成功结论来自固定安装包和隔离历史文件的本次实测，不来自能力广告。

没有迁移、账号或依赖变化。本模块可独立撤回；撤回恢复保护会重新暴露0.61.0的已证历史丢失路径，使用该版本时应保留保护或禁用其恢复。首批Copilot、全部44入口及A-8独立审计仍未由本模块完成。
