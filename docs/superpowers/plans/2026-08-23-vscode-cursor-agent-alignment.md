# VS Code 壳与 Cursor 式 Agent 对齐执行计划

> 目标：以 VS Code Workbench 为主体，以 `E:\MyProject\cursor-byok` 为 Agent Runtime，不再继续把当前 Wails/Vue 工作台扩展成 VS Code 替代品。

## 当前状态

- [x] 盘点当前 `code-work` 工作台和 Agent 接入。
- [x] 运行前端单测、生产构建和关键 Playwright E2E。
- [x] 确认当前项目是 Wails/Vue 自定义工作台，不是 VS Code 源码壳。
- [x] 对照 Cursor 官方公开 Agent 工作流：Agent Window、Plan、Review、MCP、Subagents、代码库搜索。
- [x] 形成目标分层设计：VS Code Host、Agent Extension、Agent Bridge、cursor-byok Runtime。
- [x] 建立通用 Agent Contract，并保留旧 IDE API 兼容适配器（当前完成 Go/Wails 版本化 JSON 边界）。
- [ ] 增加独立 Connect/HTTP Bridge 传输，供 VS Code 扩展直接消费。
- [ ] 建立独立 VS Code 上游工作树和扩展工程。
- [ ] 接入当前文件、选区、工作区和 SCM diff 上下文。
- [ ] 实现 Agent Chat、Plan、Review 和统一 Approval Center。
- [ ] 接入 history、重放、子 Agent、Skills、MCP 和规则范围。
- [ ] 完成 VS Code 主工程的真实桌面 E2E。

## 第一提交范围

只处理 Agent Contract 和兼容适配，不改变现有 Wails 页面布局：

1. 定义 Session、Run、Event、Claim、Mode、ParentRun 和 Sequence。
2. 为现有 `internal/ide/agentrun` 增加版本化 JSON/Connect 边界。
3. 将 `StartIDEAgentRun` 等旧 API 映射到新 Contract。
4. 增加取消、重放、重复 Claim 和事件顺序测试。
5. 保留现有浏览器 fixture，确认旧 UI 和新接口同时可用。

## 第一阶段已完成内容

- `internal/agentcontract` 定义 `Session / Run / Event / Claim / Mode / Status`。
- `internal/ide/agentrun` 为新运行增加 `SessionID / ParentRunID / Mode`，旧入口默认使用 `chat` 模式。
- 旧历史运行缺少新字段时，读取阶段自动补齐 session 和 mode。
- `internal/client/agent_contract.go` 提供 Contract 适配器和 Claim 审批适配。
- `internal/bridge/ide.go` 暴露 `*AgentContract*` 和 `*AgentClaim*` 方法，避免与控制中心 `GetAgentRun` 重名。
- 新增 Contract、Runtime、Client、Bridge 测试；重复 Claim 仍由现有 approval fingerprint 约束。

## 第二提交范围

建立 VS Code 主工程，不迁移当前 Vue 工作台：

1. 使用 VS Code 上游源码作为独立基线。
2. 增加自有 Agent 扩展和本地 Bridge。
3. 实现打开 Agent Chat、发送当前编辑器上下文和显示流式事件。
4. 让文件写入通过 VS Code WorkspaceEdit 和 Claim 审批完成。
5. 增加真实桌面 E2E，证明 VS Code 原生编辑器与 Agent 能力同时可用。

## 验收标准

- VS Code 原生编辑器、资源管理器、终端和 SCM 是主界面，而不是 Vue 模拟版本。
- Agent 可从当前文件、选区、工作区和 diff 获取上下文。
- Agent 运行可取消、可重放、可审计，事件顺序稳定。
- 写文件、Git、终端、MCP 和子 Agent 操作都经过统一 Claim。
- Plan、Review、Chat 是同一会话模型的不同模式，不是互相割裂的页面。
- 当前 Wails 客户端可以继续作为兼容验证壳运行。

## 不在第一阶段

- 不复制 Cursor 私有 bundle。
- 不修改已安装的 `D:\Cursor助手\Cursor助手.exe`。
- 不删除当前 Wails/Vue 工作台。
- 不做生产发布、远端推送或安装包替换。
