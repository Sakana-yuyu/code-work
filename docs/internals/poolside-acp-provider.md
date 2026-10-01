# Poolside ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `1.0.16`（registry `poolside`）。本页记录官方 Windows amd64 二进制握手；不代表 Poolside 账号或工具验收。

## 调用与配置

资产 `pool-windows-amd64.tar.gz`，SHA-256 `3e324f1a4b5855ba5363232c06461ec9d6d2ae1a341c827221e79779f8f2bc6f` 与 registry 一致。命令 `pool-windows-amd64.exe acp`。`authMethods=[]`。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=pool-acp`、`version=1.0.16`；`authMethods=[]` |
| session/new（R70） | 失败：`Authentication required` / `Run pool login …`（空 authMethods ≠ 可匿名会话） |
| 工具 / prompt | 会话未建成，未发送 |

隔离路径：`C:\codework-cli-iso\poolside-1.0.16\extract\pool-windows-amd64.exe`。

## One-shot 解锁

```powershell
pool login
# 然后 ACP ToolProbe
$env:CODEWORK_POOLSIDE_CLI_PATH = 'C:\codework-cli-iso\poolside-1.0.16\extract\pool-windows-amd64.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/PoolsideAcpCliProbe.test.ts
```

## 可重复检查

```powershell
$env:CODEWORK_POOLSIDE_CLI_PATH = 'C:\codework-cli-iso\poolside-1.0.16\extract\pool-windows-amd64.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/PoolsideAcpCliProbe.test.ts
```
