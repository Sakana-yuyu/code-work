# Cline ACP 的认证与模型配置接入

核对日期：2026-09-30。使用官方 `cline@3.0.65` 与 `@cline/cli-windows-x64@3.0.65`，实际运行 Windows x64 可执行文件。启动、握手、认证边界、会话配置，以及配本地模型端点的真实文件、命令、审批、取消和恢复已有证据。模型回复来自受控夹具，不证明外部账号或外部推理可用。

## 启动与凭据

目录命令为 `npx -y cline@3.0.65 --acp`，Windows 使用既有 `cmd.exe /d /s /c` 包装。npm 的 Node 包装器寻找平台二进制，二进制内含 Bun，无需用户单独安装 Bun。本次用 `--ignore-scripts` 安装官方包，平台可执行文件仍能直接运行，`--version` 返回 3.0.65。

官方 ACP 支持已经保存的登录凭据或 `CLINE_API_KEY`；配置 `CLINE_PROVIDER` 可固定模型供应商，`CLINE_MODEL` 指定初始模型。模型是否可选取决于实际供应商目录，不应将任意模型名称视为可用。官方 `auth --provider openai` 会规范化为 `openai-compatible`，ACP 直接读取的 `CLINE_PROVIDER` 不会做相同别名转换，环境变量应使用实际供应商 ID。请在目标服务器使用官方 `cline auth` 完成配置，或用环境/实例敏感变量传递密钥；不把密钥写进启动命令、聊天和日志。

3.0.65 的 `main.ts` 在 ACP 分支提前返回，未执行后面的 `--data-dir` 配置。隔离测试必须使用 `--config <home>` 与实际支持的 `CLINE_DATA_DIR=<data>`，供应商配置位于 `<data>/settings/providers.json`。不可仅凭传了 `--data-dir` 就断定配置已隔离；错误目录会使自定义端点丢失并回退到上游默认地址。本次失败探针使用的仅为合成密钥，但仍暴露了这个端点回退，修正后请求由本机 127.0.0.1 端点接收。探针清除继承的 `CLINE_*` 后显式配置数据目录、供应商和合成密钥。

Code Work 的 Cline 目录项预填**空认证方式**。这表示不发 `authenticate`，直接让 CLI 在 `session/new` 或 `session/load` 时使用已有凭据并校验认证。缺凭据依然返回上游错误。需要显式 OAuth 时，可手工填写官方方法 ID；本轮未启动 OAuth 浏览器或完成登录。

| 真实 initialize 广告 | 方法 ID        |
| -------------------- | -------------- |
| Cline 账号           | `cline`        |
| ClinePass            | `cline-pass`   |
| ChatGPT 订阅         | `openai-codex` |

`login` 不是 Cline 的认证方法。真实 CLI 返回 `-32602 Invalid params: Unsupported auth method: login`；跳过认证但没有任何凭据时，建会话返回 `-32000 Authentication required: Call authenticate before starting a session`。

## 公共路径修复

原路径存在三层空值丢失：Web/Mobile 清空字段时删除配置，解码后恢复 `login`；Cursor Adapter 的真值判断又把空字符串丢掉并落到 `cursor_login`；公共 Runtime 无条件发送认证请求。这使文档中“留空使用已有认证”的操作实际不可用。

现在复用现有字段和表单策略：

1. 合同将认证字段标为 `clearWhenEmpty=persist`。Web 使用既有保存逻辑，Mobile 同步支持此字段策略；显式空字符串不会被删除。
2. 未设置配置时仍保留原 `login` 默认。两端显示实际默认字符串，显式清空后才显示空值，避免页面为空但后台仍使用默认方法。
3. Adapter 只省略 `undefined`；Runtime 仅对非空方法调用 `authenticate`。不会因失败而改换方法、重新登录或绕过上游认证。
4. 目录选择使用前轮已有 `authMethodId` 合同，Cline 值为空，其它条目沿用各自已核对方法和原通用默认。

另一个实际响应缺口是 Cline 同时把 `provider` 与 `model` 标为 `category=model`，并把 provider 放在前面。此前模型列表和写回键均取第一个，造成供应商名称被当成模型。共用 `extractModelConfigId` 现在优先使用明确的 `model` 键；没有该键的 Agent 保留按类别选择其它键的能力。模型展示与写回共用这一选择，空模型列表保持空，不用三个登录供应商填补。

## 配置与能力实测边界

官方握手广告协议 1、loadSession 和图片输入；audio/embeddedContext 为 false。能力广告不能代替工具、图片或恢复的实际验证。

通过合成 `CLINE_API_KEY=local-test-only` 和 `CLINE_PROVIDER=openai`，CLI 可以在不调用模型的情况下建立会话。这个行为只说明建会话阶段不验证密钥有效性。该条件下 `availableModels=[]`、currentModelId 为空；保留真实结果，不声称已经接通 OpenAI 模型。

使用正确的 `openai-compatible` 配置后，实际模型目录包含 `gpt-4o`，选择后本机端点收到的模型也为 `gpt-4o`。设置任意 `CLINE_MODEL` 不保证它出现在上游目录；此前 `openai` 别名条件下的空目录不是所有 Cline 配置的结论。

会话广告 Plan/Act，初始为 Act，运行时切换 Plan 成功。`auto_approve` 是 boolean，初始 false；生产 Runtime 以布尔值切 true 后再切 false 均成功。工具验证保持 false；目前未将这个无类别 boolean 控件开放到聊天菜单，不能把协议写回通过当作用户侧自动批准开关已交付。

## 工具调用与显示

复用 `AcpSessionRuntime → CursorAdapter/GenericAcpDriver → ProviderRuntimeIngestion → Web/Mobile`，不新增 Cline 专属 Adapter。

| 官方工具       | 本次验证                                               | 展示合同                                                                                    |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `read_files`   | 读取独立临时目录中的合成文件                           | `files[].path` 用于审批路径；实际内容进入 detail，标题在缺省增量中保留                      |
| `apply_patch`  | 批准后文件内容正确；拒绝/取消后文件不存在              | 原生审批选项 ID，取消 stopReason=cancelled                                                  |
| `run_commands` | echo 输出成功；`exit 7` 明确失败                       | commands 按换行保留；`{query,result,success}[]` 转为结果详情，任一子结果失败时终态为 failed |
| `session/load` | 原进程退出后新进程恢复，后续模型请求仍含旧工具读取结果 | 同一 sessionId，不把重新建立空会话当作恢复                                                  |

上游原始批量输出仍保留在 data.rawOutput；已识别结果的文本按既有 8,000 字符尾部窗口限制。未知数组不猜测字段或状态。Web/桌面和 Mobile 复用已有 detail/status 消费与展开控件；Mobile 行摘要优先命令，完整结果在展开详情，不要求摘要重复完整日志。

实际浏览器联调发现通用 Adapter 人工审批曾写死 `allow-once` 等 ID，Cline 只接受其广告的 `allow_once`。共用 `selectAcpPermissionOptionId` 从 options 的 kind 选择原生 ID，Cursor/Generic/Kimi 与 Grok 共用；不再制造连字符 ID。缺少会话授权时至多批准一次；不存在所需选项时返回 cancelled，不扩大权限。官方探针直接使用 Runtime 曾无法暴露此 Adapter 缺口，因此保留真实子进程审批响应回归与浏览器验证。

## 可重复验证

```powershell
$env:CODEWORK_CLINE_CLI_PATH = 'C:/隔离安装目录/node_modules/@cline/cli-windows-x64/bin/cline.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/ClineAcpCliProbe.test.ts
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/ClineAcpToolProbe.test.ts
```

仅设置变量时运行官方探针。两个探针均使用作用域临时 workspace、`--config` 和 `CLINE_DATA_DIR`，不使用真实登录文件或启动 OAuth。CliProbe 只验证认证/配置，不发 prompt；ToolProbe 建立本地 HTTP 响应端点并发送真实 prompt，让官方 CLI 实际执行工具。独立目录是配置隔离，不是操作系统级沙箱。

| 检查                                                                                            | 结果                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 2026-09-30 隔离复测（`C:\codework-cli-iso\cline-3.0.65`，`--ignore-scripts`，cline.exe 3.0.65） | `ClineAcpCliProbe`+`ClineAcpToolProbe` 2 文件 **4** 项通过；本地夹具，非外部账号                        |
| 官方 CLI 三场景：错误方法、缺失密钥、合成密钥建会话与配置                                       | 通过；无模型请求                                                                                        |
| 官方探针、模型解析、通用 Driver、目录、Web/Mobile 表单                                          | 6 文件 89 项通过                                                                                        |
| 公共连接、Cursor 支持、Cursor/Grok Adapter、添加向导                                            | 5 文件 124 项通过                                                                                       |
| 默认值显示调整后的两端表单与添加向导                                                            | 3 文件 25 项通过；与上两行重复，不累加                                                                  |
| 添加向导 Cline 空方法实际保存载荷                                                               | 4 项测试再次通过                                                                                        |
| Server/Web/Mobile 类型检查                                                                      | 通过；Server 仅既有账号池 Effect 建议                                                                   |
| 浏览器                                                                                          | 未配置显示 login；选择 Cline 后为空；1280px/360px 无整页横向溢出，窄屏键盘可访问底部操作，返回/关闭有效 |

上述表格记录认证接入阶段的检查，不与后续重复运行累加。ToolProbe 补足真实 Cline 进程的模型、工具和持久恢复；Cursor Adapter 子进程测试还核对人工批准回传的原始 optionId。没有执行全仓测试。

工具增量最终覆盖 11 个定向测试文件、193 项：首次 192 通过、1 项 Grok 失败，原因是抽取公共函数后遗漏一个调用名；修正后 Grok 全部 43 项通过。补齐 Mobile 测试输入的必填字段后，其 37 项与类型检查再次通过。Server/Web/Mobile 类型检查均通过；定向 lint 只有原 Cursor 测试未使用参数警告。官方 CLI 两文件共 4 项包含在上述范围内，不重复累计。

浏览器在原隔离服务新增 `acpAgent_cline` 实例，由仓库外启动器运行真实官方 CLI，并绑定本地模型响应端点。初次人工“通过”复现错误 ID 被 Cline 拒绝；修复后的第二回合读取具体合成文件、批准批量命令，展开看到 `CLINE_BROWSER_SOURCE_72319`、`CLINE_BROWSER_OK` 和 `[Command exited with code 7]`。失败标记可见，刷新后历史仍在；1280px/360px 的 document.scrollWidth 均等于视口宽度。证据文件位于仓库外 `codework-pool-audit-20260929/cline-tools-1280.png`、`cline-tools-360.png`，不提交到仓库。

随后只读查询隔离数据库，确认第二回合只有两个 `toolCallId`，没有父子工具；两条生命周期已由双端现有合并逻辑收敛。原来的六行是两个真实工具加四条审批，虚高统计来自客户端把带 `requestKind` 的审批申请和结果也计为工具，并把大小写不同的 `Read file` 当作其它工具。

Web/桌面与 Mobile 现在根据活动类型排除审批的工具属性。审批标题保持可见，具体路径和命令仍可展开；审批通过不再显示为工具执行成功。读取分类兼容 `Read File`/`Read file`，命令批次仍按一次工具调用记录，详细结果保留每条子命令。混合工作日志使用原有折叠，失败调用始终保留，不新增隐藏历史或第二套去重机制。`summarizeToolGroup` 也按相同属性统计，防止其它调用方重新混入审批。

显示修复的 5 个定向文件共 240 项测试通过；Web 与 Mobile 类型检查通过。回归覆盖实时更新经过审批后仍只有一个工具、完成后两个真实工具加四条可检查审批、读取图标、失败输出与统计一致性。浏览器刷新同一个真实 Cline 历史回合后，审批使用明确标题，失败命令与 exit 7 输出可见，展开早期日志仍能查看全部审批和读取内容；1280px/360px 检查单独记录在 loop Round 24。此项没有重新调用外部模型或验证原生手机。

模型菜单鼠标/Enter 操作未生效，而页面提供的 Ctrl+1 选择成功；尚未判定为产品问题还是浏览器控制差异。开发热重载出现 WebSocket 中断，恢复监听后刷新正常。`unknown_binding` 来自 Composition 对 provider 回合查询对应 Run 的独立路径，当前代码证据不支持将它归为上述工具统计问题；绑定告警仍需专项检查，没有通过隐藏告警宣称恢复正常。

## 来源、未完成项与回滚

检索关键词：`site.docs.cline.bot ACP CLI --acp authentication config directory`、`site.github.com/cline/cline 3.0.65 acp`；访问日期为 2026-09-30。使用官方固定 tag、实际 npm 包及原始 RPC 响应，避免第三方文档与版本漂移。

- [官方 ACP 说明，cli-v3.0.65](https://github.com/cline/cline/blob/cli-v3.0.65/docs/usage/acp.mdx)：入口、环境凭据、模式与能力。
- [官方 AcpAgent](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/acpAgent.ts)：认证时机、会话与配置语义。
- [官方认证方法](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/auth.ts)：已保存凭据和 OAuth 入口。
- [官方自动批准配置](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/auto-approve.ts)：布尔配置，缺少类别字段。
- [官方命令入口](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/main.ts)：ACP 与 data-dir 的处理顺序。
- [官方存储路径](https://github.com/cline/cline/blob/cli-v3.0.65/sdk/packages/shared/src/storage/paths.ts)：CLINE_DATA_DIR 与供应商配置的实际路径。
- [官方审批实现](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/permissions.ts)：原生选项 ID 与拒绝/取消语义。
- [官方工具事件](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/session-updates.ts)：content_end 到 rawOutput 的转发。
- [npm 固定包](https://www.npmjs.com/package/cline/v/3.0.65)：安装来源，完整性 SHA-512 为 `6P2jgsJHp+JRUzlGR6Rp4W/zAwXPg8ihC2M9ec/VgKS4nnlGCB8Ftn17StcIjYFYtocJRkU8UGUnKF69zhv40Q==`。

后续仍须验证外部模型和真实账号、MCP、图片、自动批准聊天控件、Electron 壳、原生手机和远程连接。没有可用模型时明确报错，不能因合成密钥能建会话而显示已认证可用。

无数据库迁移。工具增量回滚只撤回批量输出解析、共享审批 ID 选择与文件路径提取及对应测试；会恢复原显示/审批缺陷，但不会撤销已执行工具。认证接入改动单独回滚，已有显式空认证配置若回退会再次触发错误方法。保留此前 ACP/账号池工作，没有删除用户数据、更新全局 Cline 或写在线数据库。

审批显示增量可单独撤回 Web/Mobile 分类和预览守卫及测试；持久化活动未变，无数据迁移或工具重执行。不要用文件级整体恢复覆盖此前的 ACP 与账号池修改。
