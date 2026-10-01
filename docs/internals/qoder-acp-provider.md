# Qoder CLI ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.2.14`（registry `qoder`）。本页记录 npm `@qoder-ai/qodercli` 握手；不代表 Qoder 账号或工具验收。

## 调用与配置

命令为 `qodercli --acp`。auth=`qodercli-login` / `qoder-personal-access-token`；本轮未发明 PAT。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=qoder-cli`、`version=0.2.14`；auth 含上述两项 |
| 工具 / prompt | 本轮未发送 |

隔离路径：`C:\codework-cli-iso\qoder-0.2.14\node_modules\.bin\qodercli.cmd`。

## One-shot 解锁

```powershell
qodercli login
# 或配置 qoder-personal-access-token（PAT，勿写入文档/日志）
$env:CODEWORK_QODER_CLI_PATH = 'C:\codework-cli-iso\qoder-0.2.14\node_modules\.bin\qodercli.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/QoderAcpCliProbe.test.ts
```

## 可重复检查

```powershell
$env:CODEWORK_QODER_CLI_PATH = 'C:\codework-cli-iso\qoder-0.2.14\node_modules\.bin\qodercli.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/QoderAcpCliProbe.test.ts
```
