# TCode 优化体检记录（2026-08-28）

## Pre-description

- 任务目标：全面查看当前 `tcode` 分支，判断还需要优化的地方，并先落地一个确定的低风险优化切片。
- 关键假设：当前项目主体位于 `E:\MyProject\code-work\codework`，Git 根目录位于 `E:\MyProject\code-work`；本记录只描述当前本机工作区快照。
- 证据来源：`git status`、`git diff --stat`、`package.json`、`docs/internals/*`、`packages/contracts/*`、`apps/server/*`、`apps/web/*`、聚焦测试、类型检查、i18n 检查和图标资源校验。
- 是否使用降级方案：未联网；所有结论来自当前工作区和本机命令。未启动真实 Provider、真实 IDE 或真实 Multica daemon。
- 风险与回滚：当前工作区包含大量未提交改动，应按主题拆分提交；本轮选择的基线修复仅涉及默认配置和格式，回滚时可单独回退对应文件。

## 当前状态判断

当前分支不是空壳，已经具备较多 Composition Runtime、BYOK、委派、供应商、余额、上下文诊断、ToolBroker、IDE bridge 和 Multica 协议底座。但项目还不能宣称达到 L4/L5：真实 Provider API、真实 Cursor/VS Code、真实 Multica daemon、多端产品 E2E、升级兼容和回滚演练都仍需补齐。

项目内部文档使用如下成熟度分层，本记录沿用该口径：

| 等级                 | 含义                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| L1 已编码            | 实现已进入当前分支，但不能单独证明行为正确                                                   |
| L2 聚焦测试通过      | 对应单元、集成或回归测试已通过                                                               |
| L3 本地跨进程通过    | 使用本地子进程或协议 fixture 验证了进程边界、事件流或工具回流                                |
| L4 真实产品 E2E 通过 | 使用真实 Multica daemon、真实 Cursor/VS Code、真实 Provider API 或真实多端客户端完成关键路径 |
| L5 可发布            | 完成故障演练、权限审计、升级兼容、回滚和发布前验证                                           |

## 已确认的质量信号

- `git status --short --branch`：当前 `tcode` 领先 `origin/tcode` 125 个提交，工作区存在大量已修改和未跟踪文件。
- `git diff --stat`：当前快照约 80 个已跟踪文件变更，包含 BYOK、委派、Runtime、设置页、i18n、图标和文档。
- `node scripts/check-ui-i18n.mjs`：通过。
- `git diff --check`：通过。
- `node scripts/export-brand-icons.ts --check`：30 个生成图标资源为最新。
- BYOK/委派/发现/上下文/余额聚焦测试：7 个文件 68 个用例通过。
- 设置页相关聚焦测试：6 个文件 37 个用例通过。
- `@codework/contracts` 类型检查：通过。
- 修复前确认过两个 P0 基线问题：BYOK 委派默认配置曾存在 `supervision` 与 `subagentProfiles` 字段漂移；`CompositionControlCenterPanel.tsx` 曾存在格式检查问题。
- 上述两个问题已在本轮确定切片中收口，验证结果见下方“本轮验证结果”。

## 优先优化清单

1. P0：先把工程基线修绿。修复 BYOK 委派默认配置缺字段和控制中心面板格式问题，重新跑 Web/Server/Contracts typecheck、聚焦测试、i18n 和 diff check。
2. P0：抽一个统一的 BYOK 委派默认配置来源。当前默认配置散在 Server、Web 和测试中，合同字段变化后容易漂移。
3. P0：补真实 BYOK API E2E 验收矩阵。至少覆盖 DeepSeek、OpenAI-compatible、中转、余额查询、模型发现、流式输出、断线恢复、限流、凭据轮换和密钥不回显。
4. P0/P1：继续校验 DeepSeek 上下文诊断。目录和测试已有 1,000,000 tokens 规则，但 UI fixture 中仍可见旧的 128,000 场景，必须确保页面展示、自动匹配和保存语义一致。
5. P1：统一 BYOK、Providers、Delegation、Runtime 四页的信息架构与交互路径。建议形成「供应商卡片 -> 添加通道弹窗 -> 发现模型勾选 -> 模型组折叠卡片 -> 委派工作台运行 -> Runtime 状态确认」的单一路径。
6. P1：把 BYOK 委派状态源收敛到 Composition Run。当前调度器内存和 Composition 台账仍存在双源状态，重启恢复、多端刷新、取消状态和历史追踪会受影响。
7. P1：完善 Supplier/Profile/Account 控制中心。继续补多账号切换、账号快照、凭据版本历史、`rollbackCredential`、价格/余额/健康聚合、权重路由和 failover。
8. P1：贯通真实外部 Runtime 的 capability grant。ToolBroker 和 Capability 底座已存在，但 Provider 原生 Session/Turn、Multica 和真实 IDE Adapter 的 grant 下发、撤销回执、过期处理、审计查询仍缺生产闭环。
9. P2：接入真实 Multica daemon。当前主要是协议和 fixture 级验证，仍需真实身份、数据库、权限、Agent/Squad 查询、动态成员、Leader 汇聚和 `fetchOutput` 生产实现。
10. P2：接入真实 Cursor/VS Code IDE Adapter。自定义 JSON-RPC bridge 不等于真实官方 Extension、IPC 或 API handshake。
11. P2：建设 Request Lab、请求镜像和脱敏回放。应做成通用 Provider/Runtime 诊断能力，禁止默认重放带副作用工具调用。
12. P2：治理仓库边界与发布链路。外层 Go/Wails 风格项目与内层 TypeScript monorepo 并存，需明确开发、构建、发版、遗留代码边界。

## 本轮先做的确定切片

先做 P0 工程基线收口：

- 补齐 Web 侧 BYOK 委派默认配置中的 `supervision` 与 `subagentProfiles`。
- 视当前源码状态确认 Server 侧是否仍缺默认字段；若已经补齐，则不重复改动。
- 修复 `CompositionControlCenterPanel.tsx` 格式检查问题。
- 不改变 RPC、持久化结构、委派状态机、凭据存储或页面功能语义。

## 本轮验证结果

P0 工程基线收口已完成，验证结果如下：

- `vp fmt --check` 目标文件：通过。
- `vp run --filter @codework/contracts typecheck`：通过。
- `vp run --filter @codework/web typecheck`：通过；仍输出既有 Effect suggestion（`src/cloud/dpop.ts`、`src/components/settings/IdeSessionsSettings.logic.ts`），无 error 级问题。
- `vp run --filter codework typecheck`：通过；仍输出既有 Effect suggestion，包含 `CapabilityPolicy`、`CompositionIdeAgentDriver`、`CompositionRuntimeSettings`、`ByokDelegationService` 等文件，均非本轮 error 级阻塞。
- BYOK/委派/发现/上下文/余额聚焦测试：7 个文件 68 个用例通过。
- 设置页相关聚焦测试：6 个文件 37 个用例通过。
- `node scripts/check-ui-i18n.mjs`：通过。
- `git diff --check`：通过；仅提示 `docs/internals/byok-ai-handoff.md` 下一次被 Git 触碰时 CRLF 会转 LF。
- `node scripts/export-brand-icons.ts --check`：通过，30 个生成图标资源为最新；macOS 专用导出仍提示需 GUI 工作流时再处理。

## 本轮改动说明

- 新增体检文档：`docs/internals/tcode-optimization-review-2026-08-28.md`。
- 补齐 `ByokFeaturesSection.tsx` 的 BYOK 委派默认配置，加入 `supervision` 与 `subagentProfiles`。
- 修正 `ByokDelegationWorkspacePanel.tsx` 中监督模型选择器的 `null` 值处理，避免 Select 事件签名触发类型错误。
- 补齐监督策略、子 Agent 角色片段和委派运行徽标的中英文 i18n 文案。
- 格式化目标设置页/委派服务相关文件。
