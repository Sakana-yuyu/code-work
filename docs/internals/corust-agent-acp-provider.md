# Corust Agent ACP（R69）

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/corust-agent`。

- 归档：Windows x64 zip；SHA-256 `79d28ce683cb5c7d436a1c9abb759425314a57ec6aa4d02b5fcfb0c84ca124a2`。
- 命令：`corust-agent-acp.exe`。
- 握手：initialize=`corust-acp`（广告 version `0.1.0`，目录包版本 0.6.0）；auth=`oauth_browser`。
- session/new：Authentication required。工具未测；未发明 OAuth。

## One-shot 解锁

```powershell
# 完成 auth methodId=oauth_browser 浏览器登录后：
# corust-agent-acp.exe → ToolProbe（文本+工具副作用）
```
