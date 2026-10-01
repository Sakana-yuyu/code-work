# Cortex Code ACP（R69）

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/cortex-code`。

- 归档：官方 Windows amd64 tar.gz；维护者 SHA-256 `e58d6b8b20afd426bdde33694712959d2de66d8aacdb135eae824c15a1f2c56d`（写入快照与 overlay）。
- 命令：`cortex.exe acp serve`。
- 握手：initialize=`Cortex Code`；session/new 成功。
- 工具：无密钥下 `session/prompt` 返回 `stopReason=end_turn`（R70 复测同）；偶见 tool 相关通知样本，**仍未**验证读/写/命令/拒绝/取消副作用，不当作真实可用。
- R82 复测：注入 `OPENAI_BASE_URL=http://127.0.0.1:11434/v1` + `OPENAI_API_KEY=ollama` 仍 `end_turn`；流内明确 `No Snowflake connection available`——**不能**用本机 Ollama 解锁为真实可用。
- 其它平台：本轮未下载，快照保持空平台对象。

## One-shot 解锁

```powershell
# 按 Cortex/Snowflake 官方完成连接配置（账号/仓库/角色等）后：
# cortex.exe acp serve  → ToolProbe（marker 读/写）
# Ollama OpenAI-compat  alone 不够。
```
