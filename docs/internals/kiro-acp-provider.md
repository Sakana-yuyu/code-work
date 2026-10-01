# Kiro ACP 接入与验证边界

核对日期：2026-09-30。本次采用官方 stable manifest 的 `2.26.0`，不是文档示例中的旧版本，也不根据网页导航中的版本推断已发布二进制。Paseo 固定目录中的 Kiro 是手工安装入口，Code Work 同样使用环境内已安装的 CLI。

## 调用链和现有能力

`kiro-cli acp` 经 stdio JSON-RPC 进入 `AcpSessionRuntime → CursorAdapter / GenericAcpDriver → ProviderRuntimeIngestion`，工具、审批和历史沿共用链路进入客户端，不新增专属 Adapter。命令行支持 `--agent`、`--model`、`--effort`，实际 `2.26.0` 帮助还列出 `--agent-engine v1|v2|v3`，默认 v2。不同引擎的协议和认证不能相互冒充验收。

已有 `_kiro.dev/commands/available` 处理保留异步命令快照和会话隔离。广告为 commands 的内置命令走 `_kiro.dev/commands/execute`，请求包含 `sessionId` 与 `command: { command, args }`；prompts、`/help` 和 `/compact` 沿既有普通消息路径。响应成功时显示 message/data，失败不重新发给模型，避免重复副作用。取消或超时只证明结束等待，不证明上游撤销完成。详细合同见 [通用 ACP 实现](./generic-acp-provider.md)。

模型配置优先使用上游广告的配置项；旧式 `models` 广告走 `session/set_model`。Kiro 官方文档列出该方法，但本次没有取得实际握手，因此不能将文档描述记作当前 CLI 验收通过。工具调用同理：已有共用能力和协议夹具不是官方工具执行证据。

## 平台和安装

官方安装文档声明 CLI 支持 Windows 11、macOS、Linux；Linux 要求 glibc 2.34+ 或使用 musl 版本。所核对的 stable manifest 只提供 Windows x64 MSI。Windows ARM64 的原生支持没有实际验证；当前模块不修改目录平台判定，不能把待整理的平台改动当已交付能力。Linux ARM64 与 macOS 通用包不受这个限制。目录现有参数只有 OS/arch，Windows 最低系统版本通过安装说明表达，没有声称已按 build 自动筛选。

本机为 Windows 10 build 19045 x64，PATH 无 Kiro。检查官方 `install.ps1` 后，仅下载固定版本 MSI 并用 Windows Installer 管理提取模式放到仓库外临时目录；没有执行普通 `/i` 系统安装，没有修改 PATH、注册全局安装、运行登录或复制真实凭据。提取成功不能当作普通安装成功。

| 项目 | 实际证据 |
| --- | --- |
| 下载 | 官方 stable manifest 中的 `2.26.0/kiro-cli-x86_64-pc-windows-msvc.msi` |
| 包大小 | 199,565,312 字节 |
| SHA-256 | `3caff2be8071b0466e292c90ac02592d9b6a5b818b489f30ee0d55a84a318942`，与官方清单一致 |
| 管理提取 | `msiexec /a ... /qn TARGETDIR=...` 退出 0 |
| 版本 | `kiro-cli-chat 2.26.0`，退出 0 |
| 帮助 | `acp --help` 退出 0，包含上述引擎及模型选项 |
| ACP | 进程退出 1，stderr 为 `error: home directory not found`；没有 initialize 响应 |

探针采用独立 cwd 和 HOME/USERPROFILE/APPDATA/LOCALAPPDATA，不继承模型密钥；后两次按线索补充 HOMEDRIVE/HOMEPATH 以及二进制中可见的 KIRO_HOME/KIRO_DATA_DIR，结果相同。三次均在握手前失败后停止继续猜测环境变量。这是当前受测组合的启动阻断，尚不能确定源于 Windows 10、提取运行方式还是 CLI 的目录初始化逻辑。没有通过放开用户真实主目录来换取表面成功。

WSL 的只读发行版查询退出 1 并返回安装帮助，本轮没有可用的 Linux 验证结果，也没有安装操作系统组件。后续应在官方支持的 Windows 11 普通安装或独立 Linux/macOS 测试环境重验。

## 验证方法与未完成项

先在目标环境使用官方安装入口，然后检查版本及 ACP 帮助。使用隔离配置目录、已授权测试凭据连接真实进程，顺序验证 initialize、认证、session/new、异步命令广告、无副作用命令、模型切换、文本、读写/命令、批准/拒绝/取消与 session/load。保留原始 RPC 和实际副作用，屏蔽凭据。先验证进程能握手，再调整认证方法；本次未根据文档擅自改变默认认证配置。

共用协议的可重复回归：

```powershell
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AcpRegistryCatalog.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts
```

Kiro 的实际认证、会话、内置命令执行、推理、工具、MCP、取消恢复、浏览器/Electron/真实手机和远程模式均未通过验收；`--version` 不能抵消握手失败。本轮回滚撤回命令扩展与协议处理提交；不删除实例或历史，无数据库迁移。上述固定二进制记录来自 2026-09-30，本轮没有重复三次同类失败的启动探测。

## 来源

检索词：`kiro-cli acp installation Windows`、`set_model commands/execute`、`KIRO_HOME home directory not found`。访问日期 2026-09-30。优先采用官方实际发布清单、官方脚本和固定二进制输出；搜索没有提供目录失败的可靠官方解释，因此不引用第三方猜测。

- [官方安装文档](https://kiro.dev/docs/getting-started/installation/)：平台和系统要求。
- [官方 Windows 安装脚本](https://cli.kiro.dev/install.ps1)：发布地址、SHA-256 校验及安装方式；本次只读检查。
- [官方 stable manifest](https://prod.download.cli.kiro.dev/stable/latest/manifest.json)：本次取到 2.26.0，后续 latest 会变化，应重新核对。
- [固定 Windows 发布包](https://prod.download.cli.kiro.dev/stable/2.26.0/kiro-cli-x86_64-pc-windows-msvc.msi)：实际提取与命令验证对象。
- [官方 ACP 文档](https://kiro.dev/docs/cli/acp/)：stdio、核心方法、异步命令与扩展方法；仅作合同来源，不代替实测。

## 2026-10-01 命令模块核对

本轮补全异步命令广告、对象执行及取消/超时后同连接恢复，定向夹具经真实子进程和通用 ACP 实例验证。它不证明官方 Kiro 执行。官方 KiroCrew 固定源码还使用日期字符串协议版本，而当前通用客户端采用标准数值版本；文档示例与真实版本可能不同，当前 Windows 进程未返回 initialize，版本协商兼容性仍待实际响应确认，未擅自全局转换类型。原生工具、流式命令正文与 RPC 结果的组合、data 中专有 UI 操作及真实登录继续保留验收边界。

本轮检索日期、关键词、采用来源及原因见通用 ACP 文档的 Kiro 节。
