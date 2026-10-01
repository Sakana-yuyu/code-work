# DeepAgents ACP 接入与验证边界

核对日期：2026-09-30（R87）。固定官方目录版本 `0.1.7`（registry `deepagents`；握手广告 `deepagents-acp@0.0.1`）。

## 调用与配置

命令为 `deepagents-acp`（可选 `--model`）。走共用 Generic ACP。广告认证 `anthropic` / `openai` / `deepagents-setup`。

本地 Ollama（R86/R87）：隔离安装 `@langchain/openai`（peer），`--model openai:qwen2.5:3b`，`OPENAI_BASE_URL=http://127.0.0.1:11434/v1`，`OPENAI_API_KEY=ollama`，auth `openai`。**未**发明 Anthropic key。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| 包版本 | npm `0.1.7` |
| initialize | `agentInfo.name=deepagents-acp`、`version=0.0.1` |
| session/new | 成功 |
| R85 | 缺 `@langchain/anthropic` 时默认 Claude 模型 prompt Internal error |
| R86 | Ollama 流可启；模型常调用 `task` 且 subagent 类型非法 → Internal error |
| R87 | 约束 prompt 禁用 task/subagent；`read_file` 完成并回显 `R87_OLLAMA_MARKER_55011` → **真实可用**；`edit` 宣称写入 `write-r87.txt` 但文件长度 0；shell 未硬过 |

隔离路径：`C:\codework-cli-iso\deepagents-0.1.7\node_modules\.bin\deepagents-acp.cmd`。证据：`%TEMP%\codework-a5-r87\deepagents-c3-summary.json` / `deepagents-c3.jsonl`。

## 可重复检查

```powershell
cd C:\codework-cli-iso\deepagents-0.1.7
npm install @langchain/openai @langchain/core @langchain/langgraph --no-fund
node %TEMP%\codework-a5-r87\targeted-r87-da.cjs deepagents
```

## 后续与回滚

下一步：修空写盘/再验 shell、拒绝、取消。回滚撤回探针与说明；无迁移。
