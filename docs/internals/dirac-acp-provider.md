# Dirac ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.5.16`（registry `dirac`）。

## 调用与配置

命令为 `dirac --acp`。广告认证 `dirac-provider-setup` / `openai-codex-oauth` / `dirac-env`（ACP `authenticate` 对 `dirac-env` 可报 Unsupported；环境/`dirac auth` 仍可生效）。

本地 Ollama（R86–R89，官方文档 `DIRAC_*` + `dirac auth`）：

| 变量/步骤                                                                  | 尝试值                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `dirac auth --provider openai --apikey ollama --modelid <model> --baseurl` | `http://127.0.0.1:11434/v1`                                                                             |
| `DIRAC_PROVIDER` / `DIRAC_MODEL` / `DIRAC_API_KEY` / `DIRAC_BASE_URL`      | `openai` / 模型 id / `ollama` / 同上                                                                    |
| `~/.dirac/data/globalState.json` `actModeOpenAiModelInfo`                  | `supportsReasoning: false`、`thinkingAlwaysOn: false`（否则 Ollama 报 model does not support thinking） |
| `DIRAC_NO_AUTO_UPDATE`                                                     | `1`（隔离 PATH 缺 npm 时避免 spawn npm ENOENT）                                                         |

## 固定版本证据

| 项目          | 结果                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initialize    | `agentInfo.name=dirac`、`version=0.5.16`                                                                                                                                                 |
| session/new   | Ollama openai 配置下成功                                                                                                                                                                 |
| prompt / 工具 | R89：`qwen2.5:7b` 发出 `list_files`/`read_file`，但反复打开虚构 `src/main.ts`（ENOENT），无 marker 回显、无写盘；`qwen2.5:3b`/`coder:3b` 易触发 YOLO consecutive mistakes → **仍未实测** |
| R90 约束再推  | 仅 `marker.txt` + customPrompt + 绝对路径提示 + 关 thinking：仍无 marker/写盘（prompt timeout 或路径幻觉）→ **仍未实测**；非 Adapter 缺陷                                                |

隔离路径：`C:\codework-cli-iso\dirac-0.5.16\node_modules\.bin\dirac.cmd`。证据：`%TEMP%\codework-a5-r89\dirac*-summary.json`。

## 可重复检查

```powershell
$env:DIRAC_NO_AUTO_UPDATE='1'
$env:DIRAC_PROVIDER='openai'; $env:DIRAC_MODEL='qwen2.5:7b'
$env:DIRAC_API_KEY='ollama'; $env:DIRAC_BASE_URL='http://127.0.0.1:11434/v1'
# 写入 globalState openAiBaseUrl + modelInfo.supportsReasoning=false 后：
dirac auth --provider openai --apikey ollama --modelid qwen2.5:7b --baseurl http://127.0.0.1:11434/v1
node %TEMP%\codework-a5-r89\dirac-retry7.cjs
```

## 后续与回滚

需模型稳定按路径读 `marker.txt`（或厂商端点）后再升真实可用。回滚撤回探针与说明；无迁移。

## One-shot 解锁

```powershell
dirac auth --provider openai --apikey <REAL_OR_LOCAL_KEY> --modelid <model> --baseurl <url>
# ToolProbe 必须回显 workspace marker.txt；本地 Ollama 路径幻觉时仍保持未实测
```
