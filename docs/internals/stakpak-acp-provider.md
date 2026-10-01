# Stakpak ACP（R69 / R90）

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/stakpak`。

- 归档：Windows x86_64 zip；SHA-256 `67e610b0c8539982fe5dbd8d795abaf6cfc1b70f7b560880f0eddabe41d0490a`。
- 命令：`stakpak.exe acp`。
- 握手：initialize=`stakpak@0.3.88`；authMethods 可为空广告。
- session/new（R69）：Authentication required（浏览器登录）。
- session/new（R89/R90，无真实账号）：`-32603 Internal error`，`Failed to create session: API error 503 Service Unavailable`（上游 HTML 503）→ **厂商 API/鉴权**，非 Code Work Adapter 协议缺陷。工具未测。

## One-shot 解锁

```powershell
stakpak login
# 确认厂商 API 健康（session/new 不得再 503）后：
# stakpak.exe acp → ToolProbe
```
