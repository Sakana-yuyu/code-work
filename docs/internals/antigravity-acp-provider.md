# Google Antigravity ACP（registry binary，R69）

与专用 `AntigravityDriver` **不是**同一自动安装路径。本文件只记录官方 registry 二进制。

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/antigravity-acp`。

- 归档：Windows x86_64 zip；SHA-256 `9b82493819bc14613baa76264d55ad307ddd8ab4a8d6e110edb32da35498c07b`。
- 命令：`agy_acp_server.exe`。
- 握手：initialize=`antigravity-acp@1.2.1`。
- session/new：需 oauth-personal / gemini-api-key / agent-platform 等；**未发明密钥**。工具未测。

## One-shot 解锁

```powershell
$env:GEMINI_API_KEY = '<real-google-ai-key>'
# 或完成 oauth-personal / agent-platform 登录
# 然后对 agy_acp_server.exe 跑 ACP ToolProbe（文本+工具副作用）
```
