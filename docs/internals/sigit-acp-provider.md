# siGit ACP 接入与验证边界

核对日期：2026-09-30（R88）。固定官方目录版本 `1.5.10`（registry `sigit`）。

## 调用与配置

命令为 `sigit`（无额外 argv）。auth=`sigit`（浏览器登录广告仍在）。本机可选用本地/Ollama 模型路径（启动日志曾选 `Qwen 2.5 3B`）。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=sigit`、`version=1.5.10`；`authMethods=[{id:sigit}]` |
| R87 | 默认 `onde-large` not found → 未升 |
| R88 ToolProbe | session 成功；`read_file` 读 `marker.txt` 回显 `R88_OLLAMA_MARKER_77129` → **真实可用**；写未硬过 |

隔离路径：`C:\codework-cli-iso\sigit-1.5.10\`。证据：`%TEMP%\codework-a5-r88\sigit-summary.json` / `sigit.jsonl`。

## 可重复检查

```powershell
$env:CODEWORK_SIGIT_CLI_PATH = 'C:\codework-cli-iso\sigit-1.5.10\node_modules\.bin\sigit.cmd'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/SigitAcpCliProbe.test.ts
```

## 后续与回滚

下一步：硬测写盘/shell；外部 siGit 账号。回滚撤回说明即可。
