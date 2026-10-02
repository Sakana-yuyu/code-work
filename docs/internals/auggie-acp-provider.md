# Auggie ACP 接入与验证边界

核对日期：2026-09-30（R66 续）。固定官方目录版本 `0.36.0`（registry `auggie`）。本页记录 npm `@augmentcode/auggie` 握手与会话边界；不代表 Augment 账号或工具验收。

## 调用与配置

命令为 `auggie --acp`，公开环境 `AUGMENT_DISABLE_AUTO_UPDATE=1`。`authMethods=[]`，但 **session/new 仍要求终端 `auggie login`**——空 auth 广告 ≠ 可匿名建会话。本轮未发明密钥、未跑交互登录。

Windows 探针优先 `node …/node_modules/@augmentcode/auggie/augment.mjs --acp`（避开原始 `spawn(.cmd)` EINVAL；产品 `resolveSpawnCommand` 对 `.cmd` 走 shell 亦可）。

## 固定版本证据

| 项目          | 结果                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| initialize    | `agentInfo.name=auggie`、`version` 以 `0.36.0` 开头；`authMethods=[]`     |
| session/new   | 失败：`Authentication required… run auggie login`（`AuggieAcpToolProbe`） |
| 工具 / prompt | **阻断**：无登录不可建会话，不发送 prompt                                 |

隔离路径：`C:\codework-cli-iso\auggie-0.36.0\node_modules\.bin\auggie.cmd`（解析到同树 `augment.mjs`）。

## 可重复检查

```powershell
$env:CODEWORK_AUGGIE_CLI_PATH = 'C:\codework-cli-iso\auggie-0.36.0\node_modules\.bin\auggie.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AuggieAcpCliProbe.test.ts apps/server/src/provider/acp/AuggieAcpToolProbe.test.ts
```

## 后续与回滚

用户完成 `auggie login` 后再验文本/工具。回滚撤回探针与说明；无迁移。

## One-shot 解锁

```powershell
auggie login
$env:AUGMENT_DISABLE_AUTO_UPDATE = '1'
$env:CODEWORK_AUGGIE_CLI_PATH = 'C:\codework-cli-iso\auggie-0.36.0\node_modules\.bin\auggie.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AuggieAcpToolProbe.test.ts
```
