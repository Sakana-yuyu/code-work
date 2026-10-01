# VT Code ACP（R69 / R85）

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/vtcode`。

- 归档：Windows msvc zip；SHA-256 `0056d86329d3a07202956d02b46a1b74d41913756c05a56f0671e34bea34f522`。
- 命令：`vtcode.exe --provider ollama --model qwen2.5:3b --workspace <cwd> acp`；环境 `VT_ACP_ENABLED=1`、`VT_ACP_ZED_ENABLED=1`、`OLLAMA_HOST=127.0.0.1:11434`。
- 握手：initialize=`vtcode`；session/new 成功（含 modes）。
- **R85 工具（Ollama `qwen2.5:3b`）**：`session/prompt` → `end_turn`；marker 出现在工具流；`write-r85.txt` 含 `R85_WRITE_OK`。shell 副作用本轮未硬过。证据：`%TEMP%\codework-a5-r85\vtcode-summary.json`。
- 无密钥时旧路径 `session/prompt` → Internal error（R69）；不发明厂商 API key。
