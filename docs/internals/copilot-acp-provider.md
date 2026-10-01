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
