# Research: t3-byok-agent-squad-composition

## Scope

本研究比较当前 `t3code` 分支与 `E:/MyProject/cursor-byok` 的代码能力，并吸收 Multica 的多 Agent 协同模型。研究只做代码与架构判断，不修改业务代码，不把 dirty worktree 的未提交修改当成已发布能力。

## Practices

- T3 已有 `ProviderDriver`、`ProviderAdapter`、BYOK model adapter、Provider Runtime 事件、Workspace、MCP、Preview、Checkpoint、Orchestration 和原生 CLI provider；新能力应在 Adapter/Driver 边界组合，而不是重写客户端壳。
- `cursor-byok` 已有模型协议兼容、工具准入、工具 Schema 规范化、工具执行桥、多个 delegation executor、原生 Task/Subagent 生命周期、路由/failover、Cursor MITM 与 IDE 能力扫描；但这些能力属于另一个 Go/Wails 产品边界，不能仅凭目录存在就认为已接入 T3。
- T3 当前 BYOK 直连会话的实现注释明确表示没有结构化 tool input/output 和 approval flow；因此“BYOK 能调用模型 API”与“BYOK Agent 能使用 T3 工具”是两个不同的交付目标。
- Multica 官方把 Agent 定义为可复用身份与配置，把 Runtime 定义为实际执行计算环境，把 Task 定义为一次具体运行，把 Squad 定义为由 Leader 协调成员的协作组；Squad 默认先唤醒 Leader，不会自动同时启动所有成员。
- Multica 官方 daemon 负责发现本机 CLI、领取任务、执行和回传结果；本机代码目录与本地 CLI 凭据留在执行机，但自定义环境变量和部分 MCP 配置可能随任务传递，因此 T3 仍需独立的 grants、脱敏和 OS 级隔离策略。

## Constraints

- 模型 API 驱动、Agent/CLI 驱动、Tool Broker、IDE Adapter 和 Multi-Agent Orchestrator 必须是不同的合同；一个模型 driver 不得直接获得默认文件系统或 IDE 权限。
- 所有模型工具调用必须经过“声明 -> 准入 -> 授权/审批 -> 执行 -> 结果回填”的循环；没有闭环的 BYOK 只能标记为文本模式。
- 多 Agent 任务必须有稳定的 Agent、Runtime、Task、Run、父子关系、事件序列、租约和取消语义；`parallel` 只有在工作区写入租约不冲突时才允许。
- IDE API 只能使用真实连接 Runtime、扩展或 MCP 描述符探测到的操作；未知 profile 不得猜测执行。
- 外部 Multica 应作为 Runtime/Task/Squad 兼容适配器，T3 仍保留自己的事实源和客户端合同，避免两套 Workspace、权限、恢复和审计生命周期分裂。

## Open [TBD]

本轮无未决 [TBD]。用户已确认完整目标与分期边界。

## Decided

- DEC-1：模型与 Agent 驱动分离，因为模型协议、Runtime 生命周期和 IDE 权限的失败/恢复边界不同。
- DEC-2：Tool Broker 由 T3 主机统一托管，因为 BYOK 模型和外部 CLI 都需要同一份工具准入、审批、脱敏和幂等语义。
- DEC-3：Squad 默认 Leader-first，而不是全成员并发，因为 Multica 官方语义是 Leader 先读上下文再决定下一步；并行只作为有依赖证明的优化。
- DEC-4：Multica 通过适配器接入而不取代 T3 事实源，因为 T3 已有多端 Contracts、Thread、Checkpoint 和 Provider Runtime。
- DEC-5：Cursor 账户、MITM、协议镜像、Request Lab 和 Control Center 列为兼容层，不阻塞通用多驱动与多 Agent 核心。
- DEC-6：第一批实现先交付合同、能力注册、BYOK Agent Loop、最小 Task/Run 事件投影和单个可验证 Tool Broker 闭环；原生 Squad UI、完整多 Runtime、Multica daemon 和 Cursor 专属兼容按后续任务推进。
- DEC-7：外部 Agent Runtime 默认要求独立 OS 用户或容器；不能满足时必须显式标记为低信任模式，不把普通进程启动当成沙箱。
- DEC-8：Multica remote server 不是第一批的必选依赖；先固定 `MulticaAdapter` 合同和 daemon 兼容边界，避免把外部服务可用性混入 T3 核心启动。

## Evidence

### 本地代码

- T3：`E:/MyProject/code-work/t3code/apps/server/src/provider/ProviderDriver.ts`、`ProviderAdapter.ts`、`Layers/ByokAdapter.ts`、`provider/byok/ByokDelegationService.ts`、`orchestration/byokDelegation/DelegationScheduler.ts`、`packages/contracts/src/providerRuntime.ts`。
- `cursor-byok`：`E:/MyProject/cursor-byok/internal/backend/agent`、`delegation`、`forwarder`、`routing`、`mitm`、`requestlab`、`controlcenter`、`cursoraccount`、`cursorcapabilities`、`computeruse`、`skills`、`terminalenv`。
- 版本与状态：T3 `51cffa02`；父仓库 `37b9e750`；`cursor-byok` `2ce7481`。`cursor-byok` 有未提交 i18n、host、Agent Contract bridge 相关修改；T3 子仓库干净，父仓库把 `t3code/` 显示为未跟踪目录。

### 外部来源

- 检索关键词：`multica-ai multica official GitHub Agent Squad Task daemon runtime`、`Multica Docs core concepts agents tasks squads daemon runtimes`。
- 访问日期：2026-08-25。
- 最终采用来源：Multica 官方 GitHub README、`CLI_AND_DAEMON.md`、官方文档 `concepts`、`agents`、`tasks`、`squads`、`daemon-runtimes`。
- 采用理由：这些页面由 Multica 官方仓库和官方文档维护，分别说明产品定位、CLI/daemon 行为、Agent/Runtime/Task/Squad 数据语义和本地执行边界，优先于第三方介绍。
