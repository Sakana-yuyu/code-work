# DimCode ACP 接入与验证边界

核对日期：2026-09-30（R87）。固定官方目录版本 `0.5.15`（registry `dimcode`）。本页记录 npm `dimcode acp` 握手与本地 Ollama 工具证据。

## 调用与配置

命令为 `dimcode acp`（Windows 探针优先 `node …/node_modules/dimcode/bin/dim.mjs acp`）。首次启动会下载平台二进制。`authMethods=[]`。

本地模型（R87）：

```text
dim provider add ollama --api-key ollama --base-url http://127.0.0.1:11434/v1 --model qwen2.5:3b
dim provider enable ollama
dim provider switch ollama
```

注意：内置 `openai` 适配走 `/v1/responses`，Ollama 不支持；须用 `ollama` provider 指向 `…/v1`（chat/completions）。会话默认 permission=`read-only`，写工具前可 `session/set_config_option` 为 `workspace-write`。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=dimcode`、`version=0.5.15`；`authMethods=[]` |
| session/new | 配好 ollama provider 后成功；模型 `ollama/qwen2.5:3b` |
| R87 ToolProbe | 多次 `glob`/`grep`；grep `marker.txt` 回显 `R87_OLLAMA_MARKER_55011` → **真实可用**（本地读工具）；`write-r87.txt` 未写出 |
| R66 | 无密钥时 session/new 失败（历史） |

隔离路径：`C:\codework-cli-iso\dimcode-0.5.15\`。证据：`%TEMP%\codework-a5-r87\dimcode-b2-summary.json` / `dimcode-b2.jsonl`。

## 可重复检查

```powershell
$env:CODEWORK_DIMCODE_CLI_PATH = 'C:\codework-cli-iso\dimcode-0.5.15\node_modules\.bin\dimcode.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/DimcodeAcpCliProbe.test.ts apps/server/src/provider/acp/DimcodeAcpToolProbe.test.ts
```

## 后续与回滚

下一步：workspace-write 下硬测写盘与 shell。回滚撤回探针与说明；无迁移。
