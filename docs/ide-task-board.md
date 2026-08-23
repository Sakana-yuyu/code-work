# Code Work AI IDE 任务表

> 此表是 AI IDE 改造的唯一进度记录。每完成一个可验收切片，必须在同一次改动中更新状态、完成证据和后续依赖。
>
> 状态：`未开始` · `进行中` · `阻塞` · `已完成`

## 安全与发布前置

| ID | 状态 | 工作项 | 依赖 | 验收标准 | 完成证据 |
| --- | --- | --- | --- | --- | --- |
| SAFE-001 | 已完成 | 固化 Goal/调度器加固改动 | 无 | 预算、完成判定、验证取消、只读工具和 scheduler 生命周期有回归测试；改动独立提交 | 已独立提交：Goal 预算/完成判定/验证取消、只读工具约束、scheduler 生命周期与并发/panic 回归测试 |
| SAFE-002 | 已完成 | 建立 IDE workspace 授权与敏感文件策略 | SAFE-001 | 前端不能提交原始主机路径；所有操作仅接受 workspace ID + 相对路径；路径逃逸、符号链接逃逸和敏感文件均被拒绝 | `internal/ide/workspace` 与 `internal/client`/`internal/bridge` 定向测试通过；Wails 只暴露 `SelectAndRegisterIDEWorkspace`（无路径参数），后续操作仅接受 workspace ID + 相对路径 |
| SAFE-003 | 进行中 | 建立 IDE 审批状态机 | SAFE-002 | 写文件、clone、Git mutation、Agent effect 和外部 executor write 都要求单次、过期、可取消审批 | `internal/ide/approval` 已由 workspace_write 与 `ssh_known_host`/`ssh_host_key_changed` 消费；均为单次、过期、可取消。clone/Git mutation/Agent/executor write 尚未接入 |

## IDE 基础切片

| ID | 状态 | 工作项 | 依赖 | 验收标准 | 完成证据 |
| --- | --- | --- | --- | --- | --- |
| IDE-001 | 已完成 | 工作区注册、私有存储、文件树/安全读取/搜索 | SAFE-002 | 可选择并注册根目录；安全列目录、读文本、搜索；二进制/大文件/受限路径有明确状态 | `go test ./internal/ide/workspace ./internal/client`：注册摘要不含主机路径；敏感/逃逸/符号链接拒绝；二进制与截断状态明确 |
| IDE-002 | 已完成 | Wails bridge、绑定、浏览器 mock 和 `/ide` 路由 | IDE-001 | 浏览器预览使用内存 fixture，不访问真实文件系统；桌面使用生成 binding | `/ide` 路由与 `IdeWorkspace.vue` 已接入 `clientApi`；browser-preview 走内存 fixture；`npx playwright test e2e/ide-workspace.spec.mjs` 通过；已 `wails3 generate bindings` |
| IDE-003 | 已完成 | Explorer、文档 tab、CodeMirror 只读编辑器 | IDE-002 | 可展开树、打开安全文本、显示版本/截断/受限状态；tab 与旧路由 tab 独立 | Explorer 展开后兄弟条目仍可见；文档 tab 不写入 `workbenchState.tabs`；只读 CodeMirror 显示文本，二进制/截断/受限/版本有明确状态；`npx playwright test e2e/ide-workspace.spec.mjs` 通过 |
| IDE-004 | 已完成 | 编辑保存与 diff 审批 | IDE-003, SAFE-003 | ETag/版本冲突可见；用户写入经预览/审批；无静默覆盖 | `WriteText` 拒绝过期版本/二进制/截断且不改磁盘；保存需 pending→approve→claim；`npx playwright test e2e/ide-workspace.spec.mjs` 覆盖预览审批保存 |

## Git 与 SSH

| ID | 状态 | 工作项 | 依赖 | 验收标准 | 完成证据 |
| --- | --- | --- | --- | --- | --- |
| GIT-001 | 已完成 | 只读 Git 状态、分支、diff 与 remote 摘要 | IDE-001 | 使用系统 Git typed argv；不执行 raw shell；remote URL 不泄密 | `gitstatus` 用 allowlist argv + `exec.CommandContext`，不经 shell；`SanitizeRemoteURL` 去掉 userinfo 并遮蔽本地路径；`GetIDEGitSnapshot(workspaceID)` 摘要不含主机路径/凭据；`go test ./internal/ide/gitstatus ./internal/client ./internal/bridge` 与 `npx playwright test e2e/ide-workspace.spec.mjs` 通过 |
| SSH-001 | 已完成 | 应用管理 SSH 私钥 vault | SAFE-003 | 私钥 DPAPI 加密，普通 DTO/日志/前端绝不含私钥或口令 | `internal/ide/sshvault` 用 Windows DPAPI（测试注入 protector）加密；`List/Import/Generate/RemoveIDESSHKey` 只返回名称/指纹/公钥；Wails 不暴露 PrivateMaterial；`go test ./internal/ide/sshvault ./internal/client ./internal/bridge` 与 `npx playwright test e2e/ide-workspace.spec.mjs` 通过 |
| SSH-002 | 已完成 | SSH host 指纹与 known_hosts 审批 | SSH-001 | 不自动接受 host key；仅审批后写入 managed known_hosts | `internal/ide/knownhosts` 探测只采集指纹并返回 `ErrUntrustedHostKey`，不写文件；Lookup unknown/mismatch 不写入；`PreviewIDEKnownHost`→`Approve`→`CommitIDEKnownHost` 后才 Append/Replace；Wails 不暴露 FilePath/Append；`go test ./internal/ide/knownhosts ./internal/client ./internal/bridge` 与 `npx playwright test e2e/ide-workspace.spec.mjs` 通过 |
| GIT-002 | 未开始 | Clone 与 Git mutation 审批 | GIT-001, SSH-001, SSH-002 | clone/stage/commit/fetch/pull/push 都是 typed operation + approval | — |

## 终端与 Agent

| ID | 状态 | 工作项 | 依赖 | 验收标准 | 完成证据 |
| --- | --- | --- | --- | --- | --- |
| TERM-001 | 未开始 | 用户拥有的 PTY terminal session | IDE-001, SAFE-003 | 预定义 shell profile、PTY 输出/输入/resize/interrupt/close；关闭杀子进程 | — |
| AGENT-001 | 未开始 | 真实 delegation 活动面板替换 TaskPanel 演示 | IDE-002 | 展示真实 task snapshots、attempts、取消与 MCP 状态；不伪造任务 | — |
| AGENT-002 | 未开始 | 独立 BYOK IDE Agent run、事件和持久化 | IDE-001, SAFE-003 | 直接使用既有模型路由；可取消/重放安全事件；不经 Cursor exec bridge | — |
| AGENT-003 | 未开始 | Agent effect 审批与 patch review | AGENT-002, IDE-004, GIT-002 | write/shell/Git/MCP effects 等待审批；Agent 只提交 proposal | — |
| AGENT-004 | 未开始 | Codex/Claude/Gemini 等外部 executor 接入 | AGENT-002, SSH-001 | 默认 readonly；workspace-write 经 capability approval；区分 CLI 登录与 BYOK 模型 | — |

## 回归与发布

| ID | 状态 | 工作项 | 依赖 | 验收标准 | 完成证据 |
| --- | --- | --- | --- | --- | --- |
| QA-001 | 未开始 | IDE Go 安全/持久化/进程测试 | 每个后端切片 | workspace、审批、Git/SSH、PTY、Agent 均有定向单测 | — |
| QA-002 | 未开始 | 浏览器 fixture 与 Playwright IDE E2E | IDE-002 起 | 不访问真实文件/Git/SSH/PTY/provider；覆盖 approval/cancel/conflict | — |
| QA-003 | 未开始 | Windows 桌面与发布包 smoke | 所有切片 | binding 生成、前端构建、Go 测试、Windows build 通过；无凭据泄露 | — |
