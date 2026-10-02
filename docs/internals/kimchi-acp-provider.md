# Kimchi ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `1.1.39`（registry `kimchi`，非 Paseo 38 同 ID）。本页记录官方 Windows `kimchi.exe --mode acp` 握手；不代表 Kimchi 账号或工具验收。

## 调用与配置

命令为 `kimchi --mode acp`。广告认证方法 `kimchi-agent` / `kimchi-agent-us`（浏览器登录）；本轮未登录。

## 固定版本证据

| 项目          | 结果                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| initialize    | `agentInfo.name=kimchi`、`version=1.1.39`；auth 含 `kimchi-agent`、`kimchi-agent-us` |
| 工具 / prompt | 本轮未发送                                                                           |

隔离路径：`C:\codework-cli-iso\kimchi-1.1.39\extract\bin\kimchi.exe`。

## 可重复检查

```powershell
$env:CODEWORK_KIMCHI_CLI_PATH = 'C:\codework-cli-iso\kimchi-1.1.39\extract\bin\kimchi.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/KimchiAcpCliProbe.test.ts
```

## 后续与回滚

需真实 Kimchi 登录后再验 prompt/工具。回滚撤回探针与说明；无迁移。
