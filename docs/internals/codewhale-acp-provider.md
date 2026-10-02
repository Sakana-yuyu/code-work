# CodeWhale ACP 接入与验证边界

核对日期：2026-09-30（R87）。固定官方版本 `v0.10.0`（提交元数据 `1be1a703b975`）。本页记录隔离安装、握手与本地 Ollama 工具证据。

## 调用与配置

目录预填 `codewhale serve --acp`，走共用 `AcpSessionRuntime → GenericAcpDriver`。官方 Runtime 文档说明 ACP 适配为保守基线：stdio JSON-RPC；完整运行时仍可用 HTTP/MCP 入口。

本地模型（R87）：用 DeepSeek provider 指向本机 Ollama OpenAI-compat，**未**发明云厂商密钥：

- 环境：`DEEPSEEK_API_KEY=ollama`、`DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1`
- 或 `~/.codewhale/config.toml`：

```toml
[providers.deepseek]
api_key = "ollama"
base_url = "http://127.0.0.1:11434/v1"
model = "qwen2.5:3b"
```

## 固定版本证据

| 项目           | 结果                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 官方资产       | `codewhale-windows-x64-portable.zip`，72,410,428 字节                                                                        |
| SHA-256        | `cfdd13ecb92d559fe36799025e7c1958341a057d8e6bb4f3c07baba03cf3b1d7`，与 `codewhale-binary-sha256.txt` 一致                    |
| 版本           | `codewhale 0.10.0 (1be1a703b975)`                                                                                            |
| `serve --help` | 含 `--acp`                                                                                                                   |
| initialize     | `agentInfo.name=codewhale`、`version=0.10.0`；`authMethods=[{id:codewhale-terminal-auth,type:terminal}]`                     |
| R87 ToolProbe  | session 成功；marker 回读 + `write-r87.txt` 含 `R87_WRITE_OK`；shell 未硬过 → **真实可用**（本地夹具）；外部 DeepSeek 账号待 |

隔离路径：`C:\codework-cli-iso\codewhale-0.10.0\portable\codewhale-windows-x64-portable\codewhale.exe`。证据：`%TEMP%\codework-a5-r87\codewhale-ds-summary.json`、`ws-codewhale-ds/write-r87.txt`。

## 可重复检查

```powershell
$env:CODEWORK_CODEWHALE_CLI_PATH = 'C:\codework-cli-iso\codewhale-0.10.0\portable\codewhale-windows-x64-portable\codewhale.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/CodeWhaleAcpCliProbe.test.ts
```

未设置路径时探针跳过。通过仅证明握手与广告的认证方法形状。工具副作用见 R87 隔离 ToolProbe。

## 后续与回滚

下一步：外部 DeepSeek 凭据下回归；拒绝/取消/shell 硬测。回滚撤回探针与目录说明即可；无数据库迁移。

## 来源

- [v0.10.0 Release](https://github.com/Hmbown/CodeWhale/releases/tag/v0.10.0)
- [RUNTIME_API ACP 段](https://github.com/Hmbown/CodeWhale/blob/main/docs/RUNTIME_API.md#acp-stdio-adapter-codewhale-serve---acp)
- [INSTALL.md](https://github.com/Hmbown/CodeWhale/blob/main/docs/INSTALL.md)
