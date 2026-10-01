# Devin CLI ACP（R69）

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/devin`。

- 归档：Windows x86_64 zip；SHA-256 `dded69a40dc54012612eda47e0935f2fb394b97cd38cb4d7d84b1e1d71c5f7ea`。
- 命令：`bin/devin.exe acp`。须隔离 `APPDATA`/`LOCALAPPDATA`，否则报 Failed to determine config directory。
- 握手：initialize agentInfo.name=`affogato` title=`Devin Agent`；auth=`devin-browser`。
- 工具未测；未发明登录。

## One-shot 解锁

```powershell
# 完成 auth methodId=devin-browser 登录后：
# bin/devin.exe acp → ToolProbe（隔离 APPDATA/LOCALAPPDATA）
```
