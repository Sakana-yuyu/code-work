# Agoragentic ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `1.3.0`（registry `agoragentic-acp` / npm `agoragentic-mcp`）。

## 调用与配置

命令 `agoragentic-mcp --acp`。initialize 返回 `agentInfo.name=agoragentic`/`version=2.0.0`，`authMethods[0]` 仅有 `type=terminal`（缺 `id`/`name`）；产品侧 AuthMethod 可选字段容忍后握手可通过。

## R90 协议边界（agent-side）

在正确 `clientCapabilities` 下 initialize 成功（`protocolVersion` 数字或字符串均可）。随后：

| 方法                                               | 结果                 |
| -------------------------------------------------- | -------------------- |
| `session/new` / `newSession` / `session/create` 等 | **Method not found** |
| `tools/list` / `tools/call`                        | 成功（MCP 形状）     |

结论：`--acp` 旗标下实为 **MCP 工具面**，未实现 ACP `session/*`。R89 探针的「Method not found」来自该上游缺口（及错误字段时的校验失败），**非** Code Work Adapter 回归。建会话/NL 工具验收不可用 → A-4 记 **不支持**（不得升真实可用；不发明 `AGORAGENTIC_API_KEY` 也不能补上 session API）。

## 固定版本证据

| 项目                           | 结果                         |
| ------------------------------ | ---------------------------- |
| initialize（放宽 authMethods） | name/version 匹配            |
| session/new                    | Method not found（R90 实测） |
| tools/list                     | 返回 register 等工具         |

隔离：`C:\codework-cli-iso\agoragentic-1.3.0\node_modules\.bin\agoragentic-mcp.cmd`。证据：`%TEMP%\codework-a5-r90\ago-methods.json`。

## 可重复检查

```powershell
$env:CODEWORK_AGORAGENTIC_CLI_PATH = 'C:\codework-cli-iso\agoragentic-1.3.0\node_modules\.bin\agoragentic-mcp.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp\AgoragenticAcpCliProbe.test.ts
# 手动：initialize 后 session/new → Method not found；tools/list → OK
```

## 后续与回滚

待上游实现 ACP `session/new`（或官方改登记为 MCP-only）后再重测。回滚撤回分类与说明；无迁移。
