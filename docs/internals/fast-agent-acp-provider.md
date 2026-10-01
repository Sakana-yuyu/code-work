# Fast-agent ACP 接入与宿主工具验证

核对日期2026-10-01，Windows x64，固定已安装官方fast-agent-acp 0.10.1。当前通过GenericAcpDriver → CursorAdapter → AcpSessionRuntime接入，复用现有宿主文件/终端与ToolBroker；不增加专用Driver。下列结果来自官方CLI与本机受控OpenAI兼容端点，不表示外部推理、账号、额度、MCP或多端已验。

## 配置与调用

当前目录快照固定uvx --from fast-agent-acp==0.10.1 fast-agent-acp -x，默认FAST_AGENT_MODEL=codexplan。目录型号只是启动默认，用户应在所选服务器环境配置真正可用的模型和认证；auth方法fast-agent-ai-secrets接受不等于模型凭据有效。

官方允许通过--config-path、--model与--home指定配置、型号与独立持久化目录。以下为本机探针的配置形状，端口由测试动态分配、key为合成值，不能照抄作为真实账号凭据：

```yaml
default_model: generic.codework-loopback
generic:
  api_key: local-test-only
  base_url: http://127.0.0.1:<本机测试端口>/v1
```

启动参数为-x --model generic.codework-loopback --config-path <独立配置> --home <独立数据目录>；客户端广告并处理fs/read_text_file、fs/write_text_file及terminal/create/output/wait_for_exit/kill/release。默认工具审批保留，没有使用--no-permissions或--no-home；后者会关闭持久化及审批，不适合验证这些能力。

## 官方CLI本机结果

| 动作             | 可复验证据与结果                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份、认证、会话 | 精确agentInfo.name=fast-agent-acp、version=0.10.1，authenticate成功，实际session/new成功；模式agent，命令目录非空                                          |
| 模型正文         | 官方CLI向动态本机/v1/chat/completions发送实际请求，校验模型与合成授权头，ACP正文收到端点标记；不是外部模型推理                                             |
| 读取             | 官方read_text_file请求宿主，源文件实际内容进入工具详情与下一模型请求；源文件读取一次                                                                       |
| 授权写入         | 使用实际allow_once选项ID；宿主只写approved.txt一次，实际内容为APPROVED；写入前读取尚不存在的目标须回复ACP错误，不能让请求悬挂                              |
| 命令成功         | 官方execute触发宿主terminal/create，执行真实Node进程并追加shell-count.txt；内容恰为x，详情和模型工具结果含命令输出标记                                     |
| 命令失败         | 第二真实Node进程退出7，原工具终态failed，详情保留退出码；两个终端均实际release                                                                             |
| 拒绝             | 选原reject_once的optionId，denied.txt不存在，工具终态failed，无宿主写入                                                                                    |
| 取消与继续       | 在写入审批阶段取消，原prompt stopReason=cancelled，cancelled.txt不存在、工具failed；同连接下一正文回合成功。未验证正在运行的长命令取消或远端撤销           |
| 新进程恢复       | 实际session/load成功且同sessionId；下一模型请求必须包含role=tool的旧读取标记，再检查恢复正文。仅同ID或合成回复不能满足该断言                               |
| 计数与边界       | 六次受控工具动作，宿主写入1次、终端创建2次/释放2次；通知用于显示，不额外执行副作用。未验证模型切换、外部账号、MCP、媒体、其它平台、Web/Electron/手机或远程 |

官方动作探针见[FastAgentAcpToolProbe.test.ts](../../apps/server/src/provider/acp/FastAgentAcpToolProbe.test.ts)。该探针的宿主处理器直接读写隔离文件并运行捕获进程，验证官方请求/实际副作用；产品宿主执行链另外由[CursorAdapterToolBroker集成合同](../../apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts)和[ACP传输合同](../../apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts)验证，不能将探针宿主替身写成整应用联调。

## 复验、失败与回滚

```powershell
$env:CODEWORK_FAST_AGENT_CLI_PATH = '<已安装固定版本>/Scripts/fast-agent-acp.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/FastAgentAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_FAST_AGENT_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
```

HEAD加精确模块索引的独立源码副本：官方探针1项通过；两文件共用合同67项通过，普通测试中的官方探针1项未启用跳过，去重68项通过。Server类型检查退出0，仅原有账户文件两条建议；探针定向lint/格式通过。旧未提交握手探针、Ollama工作记录及其临时目录没有当成当前交付。

准备阶段终端处理器未绑定外层Scope，类型检查拒绝；写新文件前的缺文件读取被探针错误地转为缺陷，RPC无明确回应，出现90秒截止。修正仅在新探针：资源绑定外层Scope、缺文件返回AcpRequestError；原超时和断言保留，没有增加等待、自动重发或修改生产驱动。诊断插桩只用于定位，正式通过来自无插桩原探针。生产文件/终端及密钥设置未改变。

独立HOME/USERPROFILE/APPDATA/LOCALAPPDATA与配置复用isolatedProbeEnvironment，显式空置非系统宿主变量，不继承真实账号或本机Ollama。Scope回收本次CLI、终端及临时目录，HTTP服务器关闭自身连接；只结束捕获的子进程，不按名称批量操作。全目标44入口和最终独立审计仍保持未完成。模块回滚可撤回此探针/说明与能力表更新；使用时可停用对应实例并保留历史，无数据库迁移。

检索词fast-agent ACP permissions、config base_url，访问日期2026-10-01。采用[官方ACP说明](https://fast-agent.ai/acp/)及[官方配置参考](https://fast-agent.ai/ref/config_file/)，因为它们定义审批、终端选择与自定义端点；固定版本具体工具名、旧文件读取及load_session另以已安装官方0.10.1源码核对，不以当前网站外推所有旧版本能力。目录与固定44统计见[入口验收合同](./acp-provider-validation.md)。


## 历史工作记录（保留原文，不作当前验收）

# fast-agent ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.10.1`（registry `fast-agent` / uvx `fast-agent-acp==0.10.1`）。

## 调用与配置

目录命令：`uvx --from fast-agent-acp==0.10.1 fast-agent-acp -x`，公开环境 `FAST_AGENT_MODEL=codexplan`。本机隔离：`C:\codework-cli-iso\uv`（uv 0.12.21）+ `C:\codework-cli-iso\uv-tools\fast-agent-acp\Scripts\fast-agent-acp.exe`。

本地 Ollama（R85）：`--model openai.qwen2.5:3b --no-permissions`，`OPENAI_BASE_URL=http://127.0.0.1:11434/v1`，`OPENAI_API_KEY=ollama`；auth method `fast-agent-ai-secrets`。

ACP 客户端须广告并处理：`fs/read_text_file`、`fs/write_text_file`、`terminal/create`（及 output/wait_for_exit/kill/release）。缺 `terminal/*` 时 shell 会挂起。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=fast-agent-acp` / `version=0.10.1`；auth=`fast-agent-ai-secrets` |
| authenticate | 成功；返回配置说明 meta（secrets.yaml / env） |
| session/new | 成功，返回 `sessionId` 与 mode=`agent` |
| **R85 工具（Ollama）** | 读 marker、写 `write-r85.txt`=`R85_WRITE_OK`、`terminal/create` 落盘 `shell-r85.txt`=`R85_SHELL_OK`；tool kinds read/edit/execute |
| 拒绝 / 取消 | 本轮未硬测 |

证据：`%TEMP%\codework-a5-r85\fast-agent-summary.json`、`ws-fast-agent\`。

## 可重复检查

```powershell
$env:CODEWORK_FAST_AGENT_CLI_PATH = 'C:\codework-cli-iso\uv-tools\fast-agent-acp\Scripts\fast-agent-acp.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/FastAgentAcpCliProbe.test.ts
# 或隔离 Ollama 探针：node %TEMP%\codework-a5-r85\ollama-acp-batch2.cjs fast-agent
```
