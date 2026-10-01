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
