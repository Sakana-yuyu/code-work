# Amp ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.9.0`（registry `amp-acp`）。本页记录官方 Windows 二进制握手；不代表 Amp 账号或工具验收。

## 调用与配置

官方分发为带 sha256 的 zip；命令为 `amp-acp.exe`（无额外 argv）。走共用 Generic ACP。广告认证方法 `setup`（交互式 API key）；本轮未运行 setup、未写入密钥。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| 官方资产 | `amp-acp-windows-x86_64.zip` |
| SHA-256 | `3b2c3d14d703fcf9572da9733e4941703a7744bd37ec4aaa75421d6002c0157b`，与 registry-snapshot 一致 |
| initialize | `agentInfo.name=amp-acp`、`version=0.9.0`；`authMethods=[{id:setup}]` |
| CLI `--help`/`--version` | 进程退出 0，无有用 stdout（stdio 面向 ACP） |
| 工具 / prompt | 本轮未发送 |

隔离路径：`C:\codework-cli-iso\amp-acp-0.9.0\amp-acp.exe`。

## 可重复检查

```powershell
$env:CODEWORK_AMP_CLI_PATH = 'C:\codework-cli-iso\amp-acp-0.9.0\amp-acp.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AmpAcpCliProbe.test.ts
```

## 后续与回滚

需真实 Amp API key 后再验 prompt/工具。回滚撤回探针与说明；无迁移。

## One-shot 解锁

```powershell
amp login
# 或：在 amp-acp session 路径完成 authenticate methodId=setup 并提供 Amp API key
# 然后 ToolProbe（文本+读/写）
$env:CODEWORK_AMP_CLI_PATH = 'C:\codework-cli-iso\amp-acp-0.9.0\amp-acp.exe'
```

## 来源

- ACP registry 快照 `apps/server/src/provider/acp/registry-snapshot.json`（amp-acp 0.9.0）
- [amp-acp v0.9.0 windows zip](https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-windows-x86_64.zip)
