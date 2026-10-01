# Nova ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `1.1.48`（registry `nova` / npm `@compass-ai/nova`）。本页记录握手；**广告身份为 `kore-cli@1.0.0`，不是 `nova`**。

## 调用与配置

命令为 `nova acp`。auth=`kore-terminal-auth`（terminal setup）；本轮未运行 setup、未发明密钥。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| npm 包 | `@compass-ai/nova@1.1.48` |
| initialize | `agentInfo.name=kore-cli`、`version=1.0.0`；`authMethods=[{id:kore-terminal-auth,type:terminal}]` |
| 工具 / prompt | 本轮未发送 |

隔离路径：`C:\codework-cli-iso\nova-1.1.48\node_modules\.bin\nova.cmd`。

## One-shot 解锁

```powershell
nova setup
# 完成 kore-terminal-auth 终端登录后：
$env:CODEWORK_NOVA_CLI_PATH = 'C:\codework-cli-iso\nova-1.1.48\node_modules\.bin\nova.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/NovaAcpCliProbe.test.ts
```

## 可重复检查

```powershell
$env:CODEWORK_NOVA_CLI_PATH = 'C:\codework-cli-iso\nova-1.1.48\node_modules\.bin\nova.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/NovaAcpCliProbe.test.ts
```
