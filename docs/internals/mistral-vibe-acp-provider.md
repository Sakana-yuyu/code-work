当前提交结论以文末“2026-10-01 当前提交实现”和HEAD文档为准；以下旧握手/账号记录不作为本轮工具验收。

# Mistral Vibe ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `2.25.8`（registry `mistral-vibe`）。本页记录官方 Windows `vibe-acp.exe` 握手；不代表 Mistral 账号或工具验收。

## 调用与配置

命令为 `vibe-acp.exe`（无额外 argv）。走共用 Generic ACP。广告认证方法 `browser-auth`（Mistral AI Studio 浏览器登录）；本轮未登录、未发明密钥。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=@mistralai/mistral-vibe`、`version=2.25.8`；`authMethods=[{id:browser-auth}]` |
| 工具 / prompt | 本轮未发送 |

隔离路径：`C:\codework-cli-iso\mistral-vibe-2.25.8\extract\vibe-acp.exe`。

## 可重复检查

```powershell
$env:CODEWORK_MISTRAL_VIBE_CLI_PATH = 'C:\codework-cli-iso\mistral-vibe-2.25.8\extract\vibe-acp.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/MistralVibeAcpCliProbe.test.ts
```

## 后续与回滚

需真实 Mistral 登录后再验 prompt/工具。回滚撤回探针与说明；无迁移。

## One-shot 解锁

```powershell
$env:MISTRAL_API_KEY = '<real-mistral-key>'
# 或完成 browser-auth（Mistral AI Studio）
$env:CODEWORK_MISTRAL_VIBE_CLI_PATH = 'C:\codework-cli-iso\mistral-vibe-2.25.8\extract\vibe-acp.exe'
# ToolProbe（勿用 ollama 占位 key）
```

## 2026-10-01 当前提交实现

# Mistral Vibe ACP 接入与工具结果

核对日期2026-10-01，Windows x64，固定官方vibe-acp.exe 2.25.8。当前通过既有通用ACP接入；官方自定义OpenAI兼容模型配置可在独立本机端点完成实际工具验证，不必把Mistral浏览器登录当作所有配置的前提。默认Mistral账号、外部推理及多端界面本轮未验证。全部44入口目标与最终独立审计保持原范围，单个探针不证明总体完成。

## 调用与隔离配置

既有acpAgent实例 → GenericAcpDriver → CursorAdapter → AcpSessionRuntime，不新增Mistral驱动。命令为vibe-acp.exe；本次显式--legacy-harness，固定官方帮助支持该参数，选择公共Python harness，未使用要求内部安装的--experimental-harness。不能外推为默认rollout或所有harness已经验证。二进制及其_internal资产使用仓库外已有官方安装，不在测试中下载或更新。

initialize实际返回@mistralai/mistral-vibe@2.25.8并广告loadSession=true。配置VIBE_HOME为独立目录，config.toml定义backend=generic、api_style=openai的自定义provider和两个模型。模型Key只用于本机端点，与Mistral账号分开；不调用authenticate，session/new仍由CLI校验所选配置。以下合成示例需用自己的端点、模型及凭据环境变量替换，不把示例Key写入生产配置：

~~~toml
active_model = "codework-loopback"
default_agent = "ask"
enable_telemetry = false
enable_update_checks = false
enable_auto_update = false
enable_connectors = false
[[providers]]
name = "codework-local"
api_base = "http://127.0.0.1:<本机端口>/v1"
api_key_env_var = "CODEWORK_MISTRAL_MODEL_KEY"
api_style = "openai"
backend = "generic"
[[models]]
name = "codework-loopback"
provider = "codework-local"
alias = "codework-loopback"
~~~

测试还限制allowed_models为两个合成模型、enabled_tools为read_file/write_file/bash，关闭通知，使用ask审批模式；真实模型工具目录与响应来自官方CLI。isolatedProbeEnvironment显式清空非系统宿主变量，覆盖HOME/USERPROFILE/APPDATA/LOCALAPPDATA和VIBE_HOME；运行器设置合成宿主MISTRAL_API_KEY与错误VIBE_HOME证明它们不决定本次结果。Scope拥有临时目录、CLI和随机127.0.0.1端口HTTP服务，没有固定睡眠或吞清理错误。这是配置隔离，不是操作系统沙箱。

## 固定官方实际结果

| 项目 | 本次证据 | 结论 |
| --- | --- | --- |
| 版本/握手 | 固定安装资产SHA-256/大小和initialize精确版本 | 通过，限Windows固定安装 |
| 自定义模型/正文 | 原始HTTP路径、Bearer合成Key、模型名与流消息断言；正文事件到达 | 通过本机端点，不是外部模型推理 |
| 动态配置 | 当前ask模式；模型配置currentValue；切换后实际请求使用第二模型；命令目录非空 | 通过；未执行全部斜杠命令/模式 |
| 读取 | 原生read_file；工具结果回到模型；完成事件含实际文件正文 | 通过 |
| 写入/审批 | 原生write_file；按广告kind找到原optionId返回；目标文件精确内容 | 通过 |
| 命令成功/失败 | 原生bash执行echo标记与exit 7；完成结果/输出、失败状态/7分别验证 | 通过；不是仅模型宣称执行 |
| 拒绝/取消 | 原上游reject_once与cancel；目标文件不存在，相关工具failed；取消stopReason明确 | 通过；不证明远端任务撤销 |
| 恢复 | 关闭原CLI后新进程session/load同ID；下一实际模型请求的tool消息必须含之前读取正文 | 通过；不以同ID或合成回答自证历史 |
| MCP/媒体/外部账号/多端/远程 | 本轮未运行 | 未验证 |

MistralVibeAcpToolProbe.test.ts只在显式CODEWORK_MISTRAL_VIBE_CLI_PATH时运行。共用回归115项通过、普通未启用官方探针1项跳过；真实官方工具探针单独1项通过，去重116项。Server类型检查、三个变更TS定向lint及格式检查通过。旧握手探针接受任意会话结果，不作为本次工具验收，原文件保留未纳入此提交。

## 文件详情修复

真实读取包同时包含content展示摘要“Read 1 line”和rawOutput.content完整正文。原makeToolCallState优先摘要，使模型已经收到文件内容但工具详情看不到；实际探针先以缺正文失败。共用解析现在仅对kind=read且结构化content为非空字符串优先使用有界正文，复用8000字符预算。原摘要、路径、rawOutput和原帧仍保留，不重新读文件或执行工具。空值/非文本/其它工具不推断为文件正文，MCP数组和批量输出原路径保持。

[AcpReadFileOutput.test.ts](../../apps/server/src/provider/acp/AcpReadFileOutput.test.ts)覆盖真实形状、长尾预算、失败/无正文和其它工具；经AcpCoreRuntimeEvents、ProviderRuntimeIngestion到公开历史投影检查正文不再次丢失。共用显示层可收到修复后的detail，但本轮未打开Web/Desktop/Mobile，不将数据链测试称为浏览器验收。

## 复验、来源与回滚

~~~powershell
$env:CODEWORK_MISTRAL_VIBE_CLI_PATH = '<固定2.25.8目录>/vibe-acp.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/MistralVibeAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_MISTRAL_VIBE_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpReadFileOutput.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts
~~~

检索词Mistral Vibe ACP custom provider/config.toml/base_url，访问2026-10-01。采用[官方配置](https://docs.mistral.ai/vibe/code/cli/configuration)、[配置字段](https://docs.mistral.ai/vibe/code/cli/configuration-reference)、[固定2.25.8 ACP源码](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/acp/agent.py)、[固定模型合同](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/core/config/models.py)，因为它们定义配置和实际调用边界；在线文档可漂移，结论由固定未插桩官方CLI和实际HTTP/文件/事件确认。入口与安装沿用[通用ACP说明](./generic-acp-provider.md)。

无新增依赖、秘密存储或数据库迁移，可独立撤回本提交；撤回后读取正文又会被摘要覆盖，已保存实例和历史不删除，已执行文件/命令不因撤回代码而撤销。真实外部模型、Mistral登录、MCP和多端连接仍需对应证据；旧文档的“必须真实Mistral登录才可工具验证”不适用于本次官方generic模型路径。
