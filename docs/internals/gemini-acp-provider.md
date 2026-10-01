# Gemini CLI 的 ACP 接入与认证边界

核对日期：2026-09-30。固定验证版本为官方 `@google/gemini-cli@0.61.0`，Windows 上以 Node 启动 `bundle/gemini.js --acp`。已验证安装、真实握手、缺少认证的失败链路和添加向导；尚未验证成功登录后的文本、文件、命令、审批、取消及恢复，不能据此称为 Gemini 全功能验收。

## 入口与调用方式

复用 `GenericAcpDriver`、`AcpSessionRuntime` 和共用 ACP Adapter，不增加 Gemini 专用驱动。Web/桌面添加页的 **Gemini ACP** 按钮进入现有目录，搜索 `gemini`，预填名称 Gemini 与 `authMethodId=oauth-personal`。用户选择具体目录版本后才填入命令；保存仍是所选环境的 `acpAgent` 实例。

本次目录命令为 `npx -y @google/gemini-cli@0.61.0 --acp`；Windows 目录使用现有 `cmd.exe /d /s /c` 包装。已有安装可手工配置 `gemini --acp`。Node 版本须满足软件包的 `>=20` 声明。Mobile 可使用现有 ACP 手工配置，新增快捷按钮只涉及 Web/桌面。

运行顺序为 `initialize` → 配置的 `authenticate` → `session/new` 或 `session/load` → `session/prompt`。会话建成前的任一步失败都终止启动；认证请求返回成功不能被单独当作“账号可用”。

## 官方 0.61.0 协议实测

`initialize` 返回协议版本 1、`agentInfo.name=gemini-cli`、`agentInfo.version=0.61.0`，以及以下认证方法：

| 方法 ID | 上游说明 | 当前验证边界 |
| --- | --- | --- |
| `oauth-personal` | Google 账号登录 | 握手真实广告；快捷入口预填；尚未成功登录实测 |
| `gemini-api-key` | Gemini Developer API Key | 无密钥时 authenticate 返回空成功，session/new 返回 -32000 |
| `vertex-ai` | Vertex AI | 握手真实广告；未实测调用 |
| `gateway` | 自定义 AI API Gateway | 握手真实广告；未实测调用 |

旧通用默认值 `login` 不是 Gemini 支持的认证方式：官方返回 `-32602 Invalid params`，`data` 中列出允许的枚举值。API Key 缺失时的建会话错误为 `-32000 Gemini API key is missing or not configured.`。探针确认这两种失败之后均没有发送 prompt。

能力广告为 `loadSession=true`，输入支持 image/audio/embeddedContext，MCP 支持 HTTP/SSE。这些是 CLI 声明，不是 Code Work 对应功能的实测结果；尤其不能据此把上游输出音频或二进制资源的显示标为完成。未建成会话，因此本次没有获得模型、模式、命令或配置目录。

## 公共错误边界修复

官方 CLI 返回标准 JSON-RPC `error: { code, message, data? }`。Effect 的 NDJSON RPC 解码器把未带内部 Cause 标记的错误解释为 `Die`，导致核心请求跳过 `callRpc` 的声明错误转换，`Effect.result` 也无法捕获；扩展请求则失去原始错误码。

在 `packages/effect-acp/src/protocol.ts` 的公共响应入口，将符合既有 `isProtocolError` 形状的 Die 转成 Fail，再交给原有核心/扩展错误处理。`code`、`message`、`data` 保持原值；方法归属继续由既有请求关联获得。显式 Defect、畸形错误以及成功响应保持原行为。不改 Effect 依赖、不捕获所有缺陷、不在每个 Adapter 重复转换。

回归使用直接构造的标准 NDJSON 错误，而非 Effect 自己编码的 Cause 包装，覆盖核心 authenticate 与扩展请求。另验证显式 Defect 与畸形错误没有被吞掉；既有 Effect Cause 格式测试继续通过。

## 隔离验证与复现

在仓库外安装固定版本，未更新本机已有的 0.55.1，也未修改真实登录文件。安装日志提示 `@github/keytar` 安装脚本未获 allowScripts 允许；本轮未启用该脚本，版本与无认证 ACP 探针仍可正常执行，OAuth/keychain 成功路径另待验证。

`GeminiAcpCliProbe.test.ts` 是显式启用的官方 CLI 探针：

```powershell
$env:CODEWORK_GEMINI_CLI_PATH = 'C:/隔离安装目录/node_modules/@google/gemini-cli/bundle/gemini.js'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/GeminiAcpCliProbe.test.ts
```

未提供该变量时跳过，不在普通测试中安装软件或调用模型。探针创建临时工作目录与 `GEMINI_CLI_HOME`，覆写系统设置路径、移除常见 Google 密钥/项目环境变量、关闭遥测，使用生产 `AcpSessionRuntime` 验证真实错误。临时目录由作用域清理。独立 home 是配置隔离，不是操作系统沙箱。

| 验证项 | 结果 |
| --- | --- |
| 官方 0.61.0 安装、版本、initialize | 通过 |
| 错误 login 与缺失 API Key | 2 项真实 CLI 负向测试通过，未调用模型 |
| effect-acp client/protocol、官方探针、添加页 | 4 文件 29 项通过 |
| AcpJsonRpcConnection、GenericAcpDriver、Cursor/Grok Adapter | 4 文件 124 项通过 |
| effect-acp、Server、Web 类型检查 | 通过；Server 保留既有账号池建议 |
| 浏览器添加入口、版本、命令、认证预填、返回步骤 | 通过；360px/1280px 无整页横向溢出 |
| 登录成功、模型/工具/审批/取消/恢复 | 未验证：缺 Gemini 凭据。R56/R70 再扫：常见 `GEMINI_*`/`GOOGLE_*` 密钥环境变量均 unset；用户级 `.gemini` 无可用 oauth/token；隔离负向探针 **2/2** 仍绿（R70）。不发明密钥。 |
| Electron 壳、原生手机、远程/relay/tunnel | 本轮未实测 |

## One-shot 解锁（A-3 成功路径）

```powershell
$env:GEMINI_API_KEY = '<real-gemini-developer-api-key>'
# optional: $env:CODEWORK_GEMINI_CLI_PATH = "$([Environment]::GetFolderPath('ApplicationData'))\npm\node_modules\@google\gemini-cli\bundle\gemini.js"
powershell -File .\.t3\paseo-unblock\paseo-a3-gemini-probe.ps1
# 成功后更新本页矩阵 + paseo-provider-catalog.md A-3；勿仅凭负向探针勾选 A-3
```

浏览器没有保存真实 Gemini 实例或触发 OAuth。截图保存在仓库外审计目录，开发服务和浏览器保留供后续验收；未写在线数据库。没有运行全仓测试。

## 来源、后续验收与回滚

检索关键词：`site.geminicli.com docs acp --experimental-acp authentication GEMINI_CLI_HOME`、`site.github.com/google-gemini/gemini-cli releases latest ACP`。采用以下官方文档和实际发布包，避免以第三方介绍推断当前协议：

- [ACP 模式](https://geminicli.com/docs/cli/acp-mode/)：确认 `--acp` 和协议入口。
- [认证](https://geminicli.com/docs/get-started/authentication/)：确认 Google 登录、API Key 与 Vertex 的认证前提。
- [配置](https://geminicli.com/docs/reference/configuration/)：确认隔离 home 和系统设置路径。
- [官方发布](https://github.com/google-gemini/gemini-cli/releases)：版本来源；方法 ID 和错误行为以安装的 0.61.0 真实响应及 bundle 中 GeminiAgent 实现为准。

后续在用户完成所选服务器的官方登录或配置密钥后，继续真实模型、动态目录、读写、命令、原生 optionId 允许/拒绝、取消和新进程恢复，以及实际聊天 UI 与多端验证。密钥通过服务器环境或实例敏感变量配置，不写进命令、文档、聊天或日志。当前认证缺口不影响继续核验其它候选入口。

没有数据库迁移。回滚快捷入口不会删除已保存的通用 ACP 实例；公共错误转换可独立撤回，但会恢复标准上游错误逃逸到缺陷通道的问题。仅撤回本次对应文件差异，不覆盖已有账号池、其它 Provider 或前轮改动。
