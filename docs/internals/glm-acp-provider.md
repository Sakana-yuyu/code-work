# GLM ACP Agent 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `1.13.0`（registry `glm-acp-agent`）。

## 调用与配置

命令为 `glm-acp-agent`（无额外 argv）。广告认证 `z-ai-api-key` / `z_ai_api_key`（`Z_AI_API_KEY`）。

本地 Ollama（R86，OpenAI-compat 覆盖）：

| 变量 | 值 |
| --- | --- |
| `Z_AI_API_KEY` | `ollama`（占位；不发明 Z.AI 真 key） |
| `ACP_GLM_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `ACP_GLM_AVAILABLE_MODELS` / `ACP_GLM_MODEL` | `qwen2.5:3b`（可选） |

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=glm-acp-agent`、`version=1.13.0`；auth 含 z-ai-api-key / z_ai_api_key |
| **R86 工具（Ollama）** | marker 回读 + `write-r86.txt`=`R86_WRITE_OK`；tool kinds read/edit/execute/fetch；shell 未硬过 |
| 拒绝 / 取消 | 本轮未硬测 |

证据：`%TEMP%\codework-a5-r86\glm-acp-agent-summary.json`、`ws-glm-acp-agent\`。

隔离路径：`C:\codework-cli-iso\glm-acp-1.13.0\node_modules\.bin\glm-acp-agent.cmd`。

## 可重复检查

```powershell
$env:Z_AI_API_KEY='ollama'
$env:ACP_GLM_BASE_URL='http://127.0.0.1:11434/v1'
node %TEMP%\codework-a5-r86\ollama-unlock-batch.cjs glm-acp-agent
```

## 后续与回滚

外部 Z.AI 账号与拒绝/取消仍待。回滚撤回探针与说明；无迁移。
