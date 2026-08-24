# VS Code 壳与 Cursor 式 Agent 对齐设计

## 目标

将项目从“Wails/Vue 自定义工作台 + 右侧 Agent 面板”收敛为：

```text
VS Code Workbench
  + 原生编辑器、资源管理器、终端、源代码管理、扩展宿主
  + Cursor 式 Agent 扩展与 Agent Window
      + 本地 Agent Bridge
          + cursor-byok Agent Runtime
```

`E:\MyProject\code-work` 保留为当前可运行兼容客户端和浏览器预览验证壳；新的主方向不再继续把它扩展成 VS Code 替代品。

## 证据与判断

### 已确认的当前实现

- `frontend/src/layouts/WorkbenchLayout.vue` 是自定义 Wails/Vue 工作台布局。
- `frontend/src/components/ide/ReadonlyCodeEditor.vue` 使用 CodeMirror，不是 VS Code/Monaco 编辑器服务。
- `frontend/src/components/workbench/AgentChatPanel.vue` 已经接通工作区 Agent 运行、事件读取和副作用审批。
- `internal/ide/agentrun` 已经具备运行、事件、持久化、取消、效果提议和提交能力。
- `internal/client/ide_agent.go` 已经把写文件、Git、终端和 MCP 效果统一到审批边界。
- `E:\MyProject\cursor-byok` 已经具备 BidiAppend、RunSSE、forwarder、工具目录、MCP、Skills、子 Agent、history 和 debug 证据链。

### Cursor 式产品边界

根据 2026 年 8 月 23 日读取的 Cursor 官方文档，需对齐的不是单一聊天面板，而是以下工作流：

- Agent-first 窗口：Agent 可以跨本地、远端和云环境运行，编辑器是可切换的开发环境。
- Plan Mode：先研究代码库、提出问题、生成可审阅计划，再进入实现。
- Agent Review：针对本地变更执行独立审查，读取仓库规则并给出可定位的结果。
- 工具审批：终端、MCP、文件写入和其他副作用需要按运行模式和用户授权处理。
- 上下文系统：代码搜索、代码库索引、规则、技能和 MCP 共同构成 Agent 上下文。
- 子 Agent：使用独立上下文执行并行或专门任务，再向父 Agent 返回结果。

这些判断来自公开文档的产品能力描述，不代表对 Cursor 私有实现细节的逆向结论。

## 目标分层

### 1. VS Code Host

职责：

- 编辑器和编辑器组
- 文件树和工作区
- 内置终端
- Source Control 和 diff editor
- 扩展宿主
- 命令面板、快捷键、状态栏和布局持久化

约束：

- 不在 `code-work` 中重新实现 Monaco、终端、Git UI 或扩展宿主。
- 不把 `WorkbenchLayout.vue` 继续扩展为 VS Code 的替代实现。

### 2. Agent Extension / Agent Window

职责：

- 会话列表和独立 Agent Window
- Chat / Ask / Plan / Review 模式
- 当前文件、选区、工作区和 SCM 变更上下文
- 运行时间线、工具调用、审批卡片和结果摘要
- 计划、审查结果和变更 diff 的跳转
- 子 Agent 列表、父子关系、取消和重试

约束：

- UI 只消费稳定的 Agent Contract，不直接读取 provider 或 Cursor 私有协议。
- 不把单次 `startIDEAgentRun` 继续当作完整会话模型。

### 3. Agent Bridge

职责：

- 在 VS Code 扩展与 `cursor-byok` Runtime 之间传递请求和事件。
- 绑定 workspace、document、selection、branch、diff 和 terminal session。
- 将文件写入、Git、终端、MCP 等副作用转换为审批 Claim。
- 支持断线重连、事件重放、取消、重试和错误归因。

建议接口：

```text
CreateSession
ListSessions
SendPrompt
SetMode
GetPlan
StartReview
ListRuns
CancelRun
ReplayRun
PreviewClaim
ApproveClaim
RejectClaim
SubscribeEvents
```

事件至少包含：

```text
session_id
run_id
parent_run_id
sequence
kind
mode
workspace_id
tool_name
claim_id
replay_safe
status
payload_summary
```

### 4. cursor-byok Runtime

保留并继续复用：

- provider 和 BYOK 模型路由
- BidiAppend / RunSSE 兼容层
- forwarder 和工具目录
- Skills / MCP
- 子 Agent 调度
- history / context / debug
- 运行取消、重放和日志证据

需要收敛的职责：

- 删除其对 IDE 主布局的所有假设。
- 不再由 Runtime 决定左侧栏、标签栏或编辑器布局。
- 将现有 IDE API 重新整理为通用 Agent Contract，而不是只服务于 Wails 页面。

## 现有代码到目标结构的映射

| 当前代码 | 目标归属 | 调整方向 |
| --- | --- | --- |
| `frontend/src/layouts/WorkbenchLayout.vue` | 兼容客户端 | 保留验证用途，不作为 VS Code 主体继续膨胀 |
| `frontend/src/components/workbench/AgentChatPanel.vue` | Agent Extension 原型 | 提取会话、模式、事件和审批状态，不保留页面内临时状态 |
| `internal/ide/agentrun` | Agent Bridge / Runtime | 升级为通用 Run、Session、Claim 和 Event 模型 |
| `internal/client/ide_agent.go` | Agent Bridge | 把 IDE 前缀 API 迁移为通用 Agent API，保留兼容适配器 |
| `internal/ide/workspace` | VS Code Workspace Bridge | 只提供安全的 workspace-relative 文件能力 |
| `internal/ide/gitops` | VS Code SCM Bridge | 提供 diff、变更摘要和审批操作，不重做 SCM UI |
| `internal/ide/termsession` | VS Code Terminal Bridge | 提供终端会话和命令审批，不重做终端 UI |
| `internal/backend/forwarder` | Agent Runtime | 继续作为模型和工具编排核心 |
| `internal/backend/agent` | Agent Runtime | 继续作为协议和 provider 适配层 |
| `frontend/src/views/ControlCenter.vue` | Runtime 管理页 | 降级为设置/诊断入口，不进入 VS Code 主工作流 |

## 分阶段实施

### 第一阶段：建立边界，不迁移 UI

- 新增通用 Agent Contract，兼容现有 `StartIDEAgentRun` API。
- 把 `workspaceID`、模型、prompt、事件和 Claim 统一成可重放结构。
- 增加 Session、Mode、ParentRun 和 Sequence 字段。
- 保留现有 Wails 页面作为兼容客户端。
- 用契约测试保证旧浏览器 fixture 和新桥接接口同时可用。

验收：

- 现有 `frontend` 单测和 E2E 不回归。
- Agent 运行可取消、重放、断线后读取完整事件。
- 文件写入、Git、终端、MCP 都产生唯一 Claim，重复批准不会重复执行。

### 第二阶段：建立 VS Code 主工程

- 从 `microsoft/vscode` 建立独立上游跟踪工作树。
- 只增加自有扩展和本地 Bridge，不复制 Cursor 私有 bundle。
- 先实现一个 Agent Activity/Chat 入口和一个命令面板命令。
- 读取当前编辑器、选区、工作区和 SCM diff，发送到 Bridge。

验收：

- VS Code 原生编辑器、资源管理器、终端和 SCM 正常工作。
- Agent 可以读取当前文件和工作区上下文。
- Agent 结果可以定位到文件和行，不依赖 Wails 页面。

### 第三阶段：Agent-first 工作流

- Chat 模式：直接问答和工具调用。
- Plan 模式：生成可编辑、可批准的实施计划。
- Review 模式：扫描当前变更并输出文件/行级问题。
- Run History：显示运行、取消、失败、重试和重放。
- Approval Center：统一处理写文件、Git、终端、MCP、网络和子 Agent Claim。

验收：

- 一个 Agent 会话可从 Chat 切换到 Plan 或 Review。
- 计划批准后能创建实现运行，并保留 parent-child 关联。
- 审查结果可直接打开 diff 或源文件。

### 第四阶段：上下文与并行能力

- workspace rules
- skills
- MCP server trust
- codebase search/index
- subagent delegation
- 多工作区和远端环境

验收：

- Agent 能区分用户、仓库和工作区范围的规则。
- MCP 信任状态按工作区隔离。
- 子 Agent 具有独立上下文和可追踪父运行 ID。

## 当前不应继续做的事情

- 不再把 Wails 工作台继续做成完整 VS Code 替代品。
- 不再继续在 `/ide` 中堆终端、Git、SSH、模型配置和运维表单。
- 不再让 `AgentChatPanel.vue` 直接承载会话持久化、运行历史和所有审批逻辑。
- 不复制 Cursor 或 VS Code 的品牌资产、私有 bundle 或签名文件。
- 不把协议兼容测试当作 Cursor 客户端 UI 已完成的证据。

## 风险与回滚

- **迁移风险**：VS Code 上游构建、扩展 API 和本地 Bridge 会引入新的构建链路。回滚方式是保留当前 `main` 的 Wails 客户端作为兼容入口。
- **协议风险**：通用 Agent Contract 可能影响现有 Wails API。采用版本化接口和旧 API 适配器，不直接删除旧入口。
- **安全风险**：Agent 上下文可能包含敏感代码和工作区信息。Bridge 只传 workspace-relative 标识和必要摘要，日志默认脱敏。
- **体验风险**：第一阶段不会立即让当前 Wails 页面变成 VS Code。交付标签应区分“兼容客户端可用”和“VS Code 主工程可用”。

## 外部资料记录

- 检索日期：2026-08-23
- 检索关键词：Cursor Agent Window、Plan Mode、Agent Review、MCP、codebase indexing、Subagents
- 采用来源：Cursor 官方文档
  - [Agent Window](https://cursor.com/docs/agent/agents-window)
  - [Agent Review](https://cursor.com/docs/agent/agent-review)
  - [Plan Mode](https://cursor.com/docs/agent/plan-mode)
  - [MCP](https://cursor.com/docs/context/mcp)
  - [Subagents](https://cursor.com/docs/agent/subagents)
- 采用原因：这些页面直接描述 Cursor 当前公开的 Agent 工作流和能力边界；没有使用第三方文章推断其私有实现。
