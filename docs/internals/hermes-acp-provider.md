# Hermes ACP 接入

核对日期：2026-09-30。固定官方发布 `v2026.9.24`，提交 `f97608f178d1ffeca59860195ab7da295f7c8e5f`；Python 包及 ACP 握手版本为 `0.21.5`，依赖 `agent-client-protocol==0.9.0`。本机实际平台为 Windows x64、Python 3.12.14。

## 调用方式与边界

Hermes 已复用 Code Work 的通用 ACP 驱动，不需要专属 Adapter：

```text
目录 hermes → hermes acp → stdio JSON-RPC
→ AcpSessionRuntime → CursorAdapter / GenericAcpDriver
→ ProviderRuntimeIngestion → Web、桌面共用界面、Mobile
```

官方同时提供 `hermes-acp` 与 `python -m acp_adapter`。目录使用已安装的 `hermes acp`；手工安装条目不强制锁定用户版本，也不安装同名 PyPI 软件。版本、平台、认证和模型能力应以运行环境中的真实 CLI 为准。

官方源码要求 Python `>=3.11,<3.14`。测试从固定 tag 的官方仓库安装 ACP extra 到独立 venv，没有修改全局 Python、用户 Hermes 配置或 Code Work 的在线数据库。命令示例：

```powershell
# 在官方源码 checkout 中、已激活独立 venv 时执行。
python -m pip install -e '.[acp]'
hermes-acp --version
hermes-acp --check
```

实际输出分别为 `0.21.5` 和 `Hermes ACP check OK`。其它平台只有官方文档支持声明，尚未以本轮测试证明。

Windows 文件和命令工具依赖 Git for Windows 的 Git Bash，`--check` 通过不代表工具可执行。固定版本的官方 `tools/environments/local.py` 优先读取 `HERMES_GIT_BASH_PATH`，然后检查安装目录和 PATH。实机探针显式配置实际 `C:/Program Files/Git/bin/bash.exe`；第一次探针清空 ProgramFiles 后无法发现它，真实读文件失败，没有将此错误当作空结果或成功。

## 认证和配置

在 Hermes 所在环境先执行 `hermes model` 配置 provider。添加 Code Work 实例时，认证方法预填为空，使用已配置的 Hermes 凭据；命令仍为 `hermes acp`。若使用独立 Hermes 目录，通过实例环境变量设置 `HERMES_HOME`，敏感密钥使用既有敏感变量字段。

空认证方法只省略可选 `authenticate` RPC，不替代上游的凭据校验。Hermes 在初始化时广告已配置 provider 的 ID（探针为 `custom`）及 `hermes-setup`；后者要求终端中的交互配置，Code Work 没有在后台自动执行它。

此固定版本的 `authenticate("login")` 虽然未被广告，但返回空成功对象：上游处理器返回 `None`，Python ACP 路由将其规范化为 `{}`。因此不能把这项调用成功标为登录成功，也不能声称旧 `login` 一定阻断建会话。本次目录修改消除不属于上游协议的多余认证请求；缺少配置的行为仍由建会话实测判断。

本机配置探针使用独立 `HERMES_HOME` 与如下合成配置，所有地址只指向临时本机 HTTP 服务：

```yaml
model:
  provider: custom
  default: hermes-probe-model
  base_url: http://127.0.0.1:<临时端口>/v1
platform_toolsets:
  acp: [file, terminal, no_mcp]
```

`OPENAI_API_KEY` 使用合成值 `local-test-only`。由于 ACP Runtime 会合并宿主环境，探针显式清空其它继承变量并重定向 HOME、USERPROFILE、APPDATA、LOCALAPPDATA；仅保留启动必需系统变量。独立目录不是操作系统沙箱。

模型目录服务只对 `/v1/models` 返回本机模型，其它路由返回 404。官方 CLI 还可能发送 `POST /api/show` 探测 Ollama 能力；这不是生成请求。探针没有发 `session/prompt`，不得据此宣称文本或工具执行成功。

## 模型、模式和工具

| 能力 | 当前证据 | Code Work 处理 |
| --- | --- | --- |
| 模型目录 | 实际握手后的会话目录包含 `custom:hermes-probe-model` | 保留上游带 provider 前缀的 ID，复用动态模型目录 |
| 编辑模式 | 实际 `default → accept_edits → default` 请求成功 | 复用任意 ACP 模式选择；不把它当作全局执行授权 |
| 认证方法 | `custom`/`hermes-setup` 广告，未广告 `login` 仍可能返回空成功 | 默认留空，先使用上游 CLI 完成配置 |
| 缺少配置 | 独立空目录、无密钥时 `session/new` 实际失败 | 不把空认证方法当作成功登录，不隐藏上游失败 |
| 文件、命令、审批 | 官方 CLI 真实读取、允许写入、echo 成功、exit 7 失败、拒绝及取消后文件不存在 | 原生 allow_once/deny 选项回传；文本工具结果进入共用 detail |
| 正文、用量 | CLI 请求本机模型并返回正文；浏览器显示上下文占用 | 模型回复为合成值，思考和精确计费用量未实测 |
| 恢复 | 结束首个 CLI 进程，以相同 sessionId 新启动后继续 prompt；保留实际读文件历史及切换后的模型请求 | SessionDB 恢复已实测；模型选择、下一回合及页面刷新另经浏览器验证，不等于全部故障恢复 |

`accept_edits` 对应工作区/临时目录编辑策略，`dont_ask` 对应会话编辑策略；敏感路径与命令权限仍有上游自己的检查。工具执行应核对原生选项 ID、实际文件/输出、失败、拒绝与取消，沿用通用 ACP 的审批映射。

## 工具结果与实际界面

`HermesAcpToolProbe.test.ts` 运行官方 CLI，临时 HTTP 端点按每轮唯一标记提供 OpenAI 格式回复。只在实际广告工具时返回对应函数调用，读取内容、写入文件、命令结果、权限选择和恢复历史分别断言。除 `/v1/models` 与 `/v1/chat/completions` 外，对已核对的本机能力探测路由返回 404（Ollama、LM Studio、llama.cpp 及模型详情）；未知请求仍使探针失败。

实际发现并修复：Hermes 完成通知同时携带 kind 和文本 content，旧解析让 read/execute/edit/search 的路径或命令摘要覆盖文本输出。共用 AcpRuntimeModel 现在优先保留已经限制为尾部 8,000 字符的文本结果，结构化批量结果仍优先；不复制专用 Adapter。四组回归均从旧行为失败变为通过。

2026-09-30 浏览器以隔离实例 `acpAgent_hermes` 执行官方 CLI：目录预填空认证、选择默认模型、握手后显示 `custom:hermes-probe-model`；实际读取、echo 输出、exit 7 失败标记、写入审批与文件落盘均可核对。开发服务途中自动重启，旧审批操作得到明确过期反馈，随后同一线程恢复并完成新审批。1280px 与 360px 下文档宽度等于视口宽度，已保存截图。

模型标签错误已定位并修复：旧隔离库记录显示，显式选择 `custom:hermes-probe-model` 后，应用误发 `session/set_config_option`。官方处理器只保存配置并返回空 `config_options`，没有切换模型；共用 Runtime 随后清空独立模型目录，下一次发送才持久化回退值 `gpt-5.6-sol`。因此服务重启只是观察到问题的时点，并非已证实的根因。

共用 Runtime 现在优先使用广告的模型配置项；只有旧式 `models` 广告时使用 `session/set_model`。空配置仍撤回原配置，但不清除独立广告的模型；原配置派生模型的撤回行为保留。成功切换更新当前模型，成功接受的目录外自定义 ID 以原 ID 显示，不虚构名称或能力；失败保持原状态。旧历史中已保存的错误模型不自动迁移，应重新选择正确模型。

2026-09-30 官方 CLI 探针确认请求从 `hermes-probe-model` 切到 `hermes-probe-alternate`，新 CLI 进程恢复后继续请求后者。浏览器实际选择自定义模型、完成下一回合并刷新后，21 项目录及所选标签保留；原生日志确认成功调用 `session/set_model`，隔离库保存正确模型 ID。本次浏览器两轮为合成文本回复，没有调用工具；实际工具证据来自独立官方 CLI 探针和前述页面回合。

桌面壳、原生手机、远程/relay/tunnel、真实外部模型账号以及完整工具面仍未验收。测试中的合成回复不代表外部推理成功，单次恢复也不代表所有故障恢复完成。

## 2026-09-30 隔离复测

仓库外：`git clone --depth 1 --branch v2026.9.24` → `C:\codework-cli-iso\hermes-v2026.9.24`；Python 3.13.14 venv；`pip install -e '.[acp]'` → `hermes-acp` **0.21.5**，`--check` → `Hermes ACP check OK`。本机 PATH 仍无 hermes。

```powershell
$env:CODEWORK_HERMES_CLI_PATH = 'C:\codework-cli-iso\hermes-v2026.9.24\venv\Scripts\hermes-acp.exe'
$env:CODEWORK_HERMES_GIT_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/HermesAcpCliProbe.test.ts apps/server/src/provider/acp/HermesAcpToolProbe.test.ts
```

结果：2 文件 **4** 项通过。首次漏设 `CODEWORK_HERMES_GIT_BASH_PATH` 时工具探针因 Git Bash 找不到失败；补齐后读写/命令/拒绝/取消/恢复再验通过。仍非外部模型或设备验收。

## 可重复检查和回滚

```powershell
$env:CODEWORK_HERMES_CLI_PATH = 'C:/隔离安装目录/venv/Scripts/hermes-acp.exe'
$env:CODEWORK_HERMES_GIT_BASH_PATH = 'C:/Program Files/Git/bin/bash.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/HermesAcpCliProbe.test.ts
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/HermesAcpToolProbe.test.ts
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AcpRegistryCatalog.test.ts
```

未设置变量时官方探针跳过；跳过不能计为通过。源码和临时安装位于仓库外，测试结束释放自己的 CLI、HTTP 端点及临时配置。项目不新增 Python 运行依赖。

2026-09-30 定向验证：官方探针、目录、GenericAcpDriver 和 Web 添加向导共 4 文件 29 项通过；Server 类型检查及三文件 lint/fmt 检查通过。官方三场景包括缺少配置时的 session/new 失败，不含推理或工具执行。最初对模型字段和 HTTP 探测的错误断言已按实际响应修正，详情见本次 loop Round 25。

随后工具阶段验证：Hermes 工具探针、AcpRuntimeModel、AcpCoreRuntimeEvents、Cursor/Grok Adapter、Web 命令详情和 Mobile 活动派生共 7 文件 182 项通过；配置探针及目录另 2 文件 17 项通过，共 9 文件 199 项。Server 类型检查、4 文件 lint/fmt 通过。未完成显示问题已在上文单独列出，不由自动测试数量抵消。

审批生命周期补验：官方 `permissions.py` 在审批决策后发送仅含工具 ID 和 completed/failed 的通知，用于关闭权限气泡。共用 Runtime 复用工具状态表记录根会话的审批身份和真实决策；只有未出现执行证据、终态匹配决策且不带其它字段时才忽略该重复终态。实际工具开始、携带内容、未知 ID 或允许后失败均保留。未结束的审批身份在下一回合清理，不使用 Hermes 名称、ID 前缀或 `Tool` 文案过滤。

2026-09-30 新浏览器会话实际点击“通过”后显示四项工具和申请/结果两项日志，没有新增空白 Tool。读取和 echo 成功，exit 7 失败；写入已有文件因 Hermes 要求先完整读取目标文件而失败，原文件未修改。这证明实际执行失败仍保留，不能将审批通过描述为写入成功。1280px/360px 无页面横向溢出。旧会话已持久化的空白历史不迁移。中途一次开发服务重启及失效临时模型端口导致的中断单独记录，不算通过。

本轮定向矩阵去重后共 7 文件 213 项通过，包括真实官方 CLI 工具探针、三个原生审批结果、真实执行前后更新、携带输出、状态不匹配、外部会话和下回合 ID 复用；Server 类型检查通过。回滚仅撤回 AcpSessionRuntime 的审批身份关联、对应协议夹具和断言，不整体恢复含其它轮次改动的文件，无数据库迁移。

回滚只需撤回手工目录 Hermes 的空认证默认及说明、对应回归和文档；不回退前几轮共用 ACP 实现，不整体恢复已有脏文件。无需数据库迁移。已添加实例的认证方法属于用户保存的配置，不随目录回滚自动改写。

工具输出修复独立回滚：仅撤回 AcpRuntimeModel 中 detail 的文本 content 优先级和本次四组断言、Hermes 工具探针及对应说明；不要撤回前几轮批量结果、标题保留或账号池改动。浏览器端点及配置位于仓库外，仅用于本次验证。

## 来源与未完成项

检索词：`Hermes agent ACP server official NousResearch`；访问日期：2026-09-30。采用官方固定发布源码与实际安装输出，避免把主分支新行为直接套到已安装版本。

- [官方 ACP 指南](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/acp.md)：入口、依赖和模型配置。
- [官方认证广告](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/acp_adapter/auth.py)：provider 方法与终端配置方法。
- [官方服务实现](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/acp_adapter/server.py)：模式、认证返回和会话请求。
- [官方会话持久化](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/acp_adapter/session.py)：配置加载、Agent 构造与恢复。
- [官方审批生命周期](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/acp_adapter/permissions.py)：决策后关闭审批气泡的终态通知。检索词 `await_permission tool_call_id update_tool_call`，核对固定版本源码与实际 CLI，避免把权限结束当执行结束。
- [官方依赖清单](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/pyproject.toml)：Python 范围、版本与 ACP extra。

工具详情已在共用链路修复：终态 ingestion 保留最多 8,000 字符，超过上限显示省略号；中间流式更新仍用短摘要和现有载荷压缩。Web/Mobile 对明确 execute 工具不再从输出 detail 推测命令，旧无元数据的命令兼容分支保留；Web 即使缺少命令也能显示明确的 stdout。没有添加 Hermes 专属组件。

2026-09-30 真实官方 CLI 配本机模型的新页面回合中，终端失败详情为 34 字符、`terminal result` 仅一次，文件保护失败详情为完整 864 字符；两项失败和审批记录均保留。1280px/360px 无页面横向溢出，360px 下展开详情自身也不溢出。既有写入保护继续生效，未覆盖测试文件。此前已按 180 字符持久化的旧历史不自动回填，此修复对新终态生效。

详情阶段共 8 文件 294 项测试通过，覆盖 ingestion/公开投影、Web/Mobile 派生、时间线渲染和性能；Server/Web/Mobile 类型检查、7 文件 lint/fmt 通过。回滚仅撤回终态详情上限、双端命令回退边界及对应测试说明，无数据库迁移；不要整体恢复脏文件。真实外部模型、其它平台和远程/设备仍待验收。CLI 实际工具、本机合成模型与浏览器证据分开登记，完整 44 入口验收仍保持原范围。

模型阶段共 7 文件 213 项通过，覆盖旧式模型新建/恢复、空配置独立语义、切换失败保留、Cursor/Grok 既有 Adapter、共享目录与 Web 草稿；其中包含实际官方 CLI 模型切换、工具和新进程恢复探针。Server 类型检查、4 文件 lint/fmt 通过。回滚只撤回本轮 AcpSessionRuntime 的模型 RPC 路由、空配置与模型快照处理及对应回归，不整体恢复文件，无数据库迁移。

模型核对关键词：`set_session_model set_config_option config_options`，访问日期 2026-09-30。采用上列固定版本官方 `acp_adapter/server.py` 与实机请求，因其明确区分真正切换模型和通用配置存储，不能以 RPC 返回成功推断模型已切换。
