# Junie ACP（R69）

隔离目录：`C:/codework-cli-iso/a4-empty-shells-r69/junie`。

- 归档：Windows amd64 zip（~316 MiB）；SHA-256 `937a4e3e7e701d784f7161975d62c2e72de6b9da20b049bdc657eda675fd9820`；目录版本 **3419.22.0**。
- 命令：`junie/junie.exe --acp=true`。
- 隔离 stdio 探针：initialize=`@jetbrains/junie` version `26.9.22 (3419.22)`；session/new 成功；auth=`jetbrains-account`。
- `AcpSessionRuntime.start` 本机可长时间挂起，故未纳入 Effect CliProbe 强制绿灯；不以挂起否定 stdio 握手证据。
- 工具未测；未发明 JetBrains 账号。

## One-shot 解锁

```powershell
# 完成 JetBrains 账号登录（auth=jetbrains-account）后：
# junie/junie.exe --acp=true → ToolProbe
```
