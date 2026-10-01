# pi-acp / Claude ACP / Codex ACP / Grok Build 握手边界

核对日期：2026-09-30。registry 额外/目录项的无登录握手摘要；均不代表账号或工具验收。

## pi-acp `0.0.34`

- 命令：`pi-acp`
- initialize：`agentInfo.name=pi-acp`、`version=0.0.34`；auth=`pi_terminal_login`（terminal）
- 探针：`PiAcpCliProbe` / `CODEWORK_PI_ACP_CLI_PATH`

## Claude ACP adapter `@agentclientprotocol/claude-agent-acp@0.84.0`

- 命令：`claude-agent-acp`
- initialize：name/version 匹配；`authMethods=[]`
- 探针：`ClaudeAcpCliProbe` / `CODEWORK_CLAUDE_ACP_CLI_PATH`
- 说明：这是 ACP 适配器包，不等于内置 Claude 专用驱动已替代。

## Codex ACP adapter `@agentclientprotocol/codex-acp@2.0.0`

- 命令：`codex-acp`
- initialize：name/version 匹配；auth=`api-key` / `chat-gpt`
- 探针：`CodexAcpCliProbe` / `CODEWORK_CODEX_ACP_CLI_PATH`

## Grok Build `@xai-official/grok@1.0.45`

- 命令须为 `grok agent stdio`（裸 `grok` 会进浏览器登录 TUI）
- initialize：**无 agentInfo**；auth=`grok.com`
- 探针：`GrokBuildAcpCliProbe` / `CODEWORK_GROK_BUILD_CLI_PATH`
- 说明：与专用 Grok 驱动并存；目录项不能自动合并。

## fast-agent `0.10.1`（uvx）

- 隔离 uv：`C:\codework-cli-iso\uv`（0.12.21）
- 命令：`uvx --from fast-agent-acp==0.10.1 fast-agent-acp -x`（env `FAST_AGENT_MODEL=codexplan`）
- initialize=`fast-agent-acp@0.10.1`；auth=`fast-agent-ai-secrets`；**session/new 成功**（无外部密钥）
- 探针：`FastAgentAcpCliProbe` / `CODEWORK_FAST_AGENT_CLI_PATH`
- 工具/模型仍需凭据，未发明

## minion-code `0.1.44`（uvx，阻断）

- 默认：`ImportError: AuthMethod`（`agent-client-protocol` 0.12.x）
- pin `0.8.0`：可 initialize，但 JSON-RPC 写 **stderr**，Code Work 无法消费
- 探针：`MinionCodeAcpCliProbe` 对默认入口断言 initialize **不成功**
- 详见 [minion-code-acp-provider.md](./minion-code-acp-provider.md)
