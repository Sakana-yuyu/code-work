# Minion Code ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.1.44`（registry `minion-code` / uvx `minion-code@0.1.44`）。

## 调用与配置

目录命令：`uvx --from minion-code==0.1.44 minion-code acp`。本机隔离 uv：`C:\codework-cli-iso\uv`（0.12.21）。

## 阻断（不得标为握手成功）

### 1. 默认依赖 ImportError

`minion-code==0.1.44` 声明 `agent-client-protocol>=0.7.0`。默认解析到 `0.12.1` 后：

`ImportError: cannot import name 'AuthMethod' from 'acp.schema'`

（`AuthMethod` 在 `0.9.0+` 已移除。）进程在 ACP 之前退出。

### 2. pin 0.8 后 JSON-RPC 写在 stderr

证据性隔离 `minion-code==0.1.44` + `agent-client-protocol==0.8.0` 可 import，且能生成 initialize 结果，但响应写在 **stderr**，stdout 为空。Code Work `AcpSessionRuntime` 只消费 stdout NDJSON，因此仍无法建立会话。产品不因此改读 stderr（会与日志混流）。

| 项目                 | 默认 uvx / uv tool | pin `agent-client-protocol==0.8.0` |
| -------------------- | ------------------ | ---------------------------------- |
| 启动                 | ImportError        | 进程可起                           |
| initialize（stdout） | 无                 | **无**（结果在 stderr）            |
| auth                 | —                  | 广告 `openrouter-oauth`（未登录）  |
| 工具 / prompt        | 未发送             | 未发送                             |

上游需：收紧/适配 `agent-client-protocol`，并把 JSON-RPC 写回 stdout。

## 可重复检查

```powershell
# 默认失败
C:\codework-cli-iso\uv\uvx.exe --from minion-code==0.1.44 minion-code acp
# CliProbe（预期 initialize 不成功）
$env:CODEWORK_MINION_CODE_CLI_PATH = 'C:\codework-cli-iso\uv-tools\minion-code\Scripts\minion-code.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/MinionCodeAcpCliProbe.test.ts
```
