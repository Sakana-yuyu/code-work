# MiniMax Code ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.2.7`（registry `minimax-code`）。本页记录 npm `@minimax-ai/code` 握手；不代表 MiniMax 账号或工具验收。

## 调用与配置

命令为 `mcode acp`。依赖 native `better-sqlite3`：`--ignore-scripts` 安装会在启动时报 bindings 缺失；需允许 install scripts 或预编译 `.node`。本轮未见 `authMethods` 字段（空/缺省）。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=minimax-code`、`version=0.2.7`；无 authMethods |
| ignore-scripts | 启动失败（better-sqlite3 bindings） |
| Windows spawn | 直接 spawn `.cmd` → EINVAL；spawn 裸 `.js` → EFTYPE；**Node** `process.execPath` + `cli.js acp` 可握手（R70 CliProbe 1/1） |
| session/new | 无登录返回 `-32000 Authentication required: Run mcode login and try again.` |
| 工具 / prompt | 会话未建成，未发送 |

隔离路径：`C:\codework-cli-iso\minimax-0.2.7-native\node_modules\@minimax-ai\code\cli.js`（native bindings 包）。

## One-shot 解锁

```powershell
mcode login
# Windows: Node + cli.js acp（勿直接 spawn .cmd）
$env:CODEWORK_MINIMAX_CLI_PATH = 'C:\codework-cli-iso\minimax-0.2.7-native\node_modules\@minimax-ai\code\cli.js'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/MinimaxAcpCliProbe.test.ts
# 成功后另跑 ToolProbe（marker/写）
```

## 可重复检查

```powershell
$env:CODEWORK_MINIMAX_CLI_PATH = 'C:\codework-cli-iso\minimax-0.2.7-native\node_modules\@minimax-ai\code\cli.js'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/MinimaxAcpCliProbe.test.ts
```
