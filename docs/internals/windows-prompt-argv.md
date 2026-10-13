# Windows 正文参数的长度边界

正文经 argv 发送的入口统一使用 `apps/server/src/provider/promptArgv.ts`。该函数复用 `resolveSpawnCommand` 的实际路径解析和转义结果，在 spawn 前校验，不重写正文、不截断、不自动切换启动入口或重试。

| Provider / 入口                             | 正文传输方式与决定                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Antigravity 对话                            | `-p` 参数；完整参数形成后、`turn.started` 和 spawn 前校验                                          |
| Antigravity 标题、分支名、提交信息、PR 内容 | 共用生成入口的 `-p` 参数；spawn 前校验，验证消息保留到 `TextGenerationError.detail`                |
| ZCode（配置的 cmd/exe、内置 Node 运行时）   | `--prompt=` 参数；启动前缀、resume、附件与额外参数一并计入，通过共用启动函数可选 `argvPrompt` 启用 |
| Codex                                       | 对话使用 app-server RPC；文本生成写 stdin，不检查正文 argv                                         |
| Claude                                      | 对话使用 SDK 输入流；文本生成写 stdin，不检查正文 argv                                             |
| Cursor / Grok / Kimi / Generic ACP 家族     | ACP `session/prompt`，不检查正文 argv                                                              |
| Pi / OhMyPi                                 | JSONL RPC，不声明 `argvPrompt`，沿用原启动路径                                                     |
| OpenCode / BYOK                             | SDK/HTTP；BYOK 外部委派正文写 stdin，不检查正文 argv                                               |

第一层以 UTF-8 字节数早拒明显不可能装入命令行的输入。上限为 `3 × (32767 − 1)`；这是根据每个 UTF-16 单元最多编码为三个 UTF-8 字节推导的保守预判，**不是 Windows 的原生字节限额**。合法的较长中文输入不会因错误的单字节假设而被拒绝，后续仍须通过完整命令行检查。

第二层与第三层依据解析后的 `resolved.shell` 互斥：cmd/bat 计入现有转义参数以及 Node `/d /s /c` 外层包装，完整字符串最多 8191 个 UTF-16 单元；直接进程计入 Node/libuv 参数引号、引号前及结尾反斜线膨胀、参数分隔符和终止 NUL，最多 32767 个 UTF-16 单元。启动命令、模型、恢复标识和其他参数占用同一预算，不以固定正文字符数替代完整检查。批处理自身的额外内部展开由该脚本决定，守卫只能校验本应用实际交给外壳的命令行。

错误使用既有 `ProviderAdapterValidationError` 的可选 `code`：超限为 `AGENT_PROMPT_TOO_LARGE`，消息包含阶段、长度/限额和缩短输入、文件引用、stdio/RPC/HTTP、直接可执行文件或内置运行时的建议，不包含原始正文、路径或密钥。既有 cmd 多行拒绝转换为 `AGENT_PROMPT_UNSUPPORTED`；直接进程保留换行。ZCode 沿原失败收尾链结束回合并恢复 ready，Antigravity 对话在创建回合前拒绝。

此能力在供应商所处服务器执行，Web/Desktop/Mobile 与本地/远程/隧道共用同一结果。客户端无需新控制项或条件回退；没有 wire schema、权限、默认 runtimeMode、数据结构或持久化迁移变化。用户可修正输入后重发；回退该主题提交即可恢复旧启动行为。

2026-10-13 检索关键词为 `CreateProcessW lpCommandLine 32767`、`cmd.exe maximum string length 8191`、`libuv quote_cmd_arg`。采用 [Microsoft CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) 与 [cmd 限制说明](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation)确定平台限制，采用 [libuv 官方进程实现](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)及本机 Node v24.18.1 内置 `child_process` 源码确认序列化行为；以平台和运行时原始资料为依据，未复制参考项目源码，长度计数独立推导。边界测试与运行证据见 [port-progress](./port-progress.md) 第42主题；使用建议见[用户说明](../user/windows-prompts.md)。
