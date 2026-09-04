# 规格驱动开发内建能力方案

状态：A1-A8 已完成当前仓库可执行范围的最终独立验收；Android 真机与 Relay/Tunnel 实网补验受当前环境无设备/远端目标限制，风险和补验边界已记录。

本文档把 kamioj/spec-workflow 的核心能力转化为 Code Work 的一等产品能力。它不是一个新的 SKILL.md，也不是当前 Local Plugin 的普通贡献项，而是由 Code Work Server 管理状态、门禁、产物和 Agent 执行的一套内建工作流。

## 1. 目标与边界

### 1.1 目标

- 用户从对话输入框的“+”中显式启用“规格驱动开发”。
- 启用后，Agent 根据当前工作流状态、项目产物和用户意图，自动选择合适阶段。
- 用户选错阶段时，系统根据合法前置条件自动纠正，并向用户说明原因。
- 各阶段可以通过事件和状态转换互相唤醒、暂停、恢复和重试。
- 用户未启用时，普通对话和普通编码流程完全不使用该能力。
- 工作流能够从一个模糊想法推进到调研、设计、方案、实施、验证、验收和归档。
- 工作流状态可以跨回合、断线、多端和远程连接恢复。
- 每个 Goal 验收项只有在真实验证通过后才允许勾选，直到最终独立验收通过。

### 1.2 非目标

- 不把整个功能实现为依赖 SKILL.md 的技能。
- 不把工作流核心逻辑塞进 LocalPluginCommandAction。
- 不复制一套新的 Agent 调度器、Goal Loop 或 Task Graph。
- 不用 Prompt 递归替代服务端状态机。
- 不依赖 Claude/Codex 专属 Shell Hook 作为跨客户端的唯一门禁。
- 不因为项目中存在 spec/ 目录就自动启用。
- 不在用户没有明确启用时自动写入 spec/ 产物或接管已有变更。

## 2. 第三方工作流拆解

来源：

- [spec-workflow 中文说明](https://github.com/kamioj/spec-workflow/blob/main/README_cn.md)
- [spec-workflow Codex 移植说明](https://github.com/kamioj/spec-workflow/blob/main/codex/README.md)

### 2.1 16 个命令的产品化映射

原项目的 16 个命令应保留为内部能力节点，但不应全部平铺在“+”菜单中。

| 内部 ID  | 用户名称           | 作用                             |
| -------- | ------------------ | -------------------------------- |
| workflow | 从想法到可交付项目 | 启动完整主流程                   |
| loop     | 受控自主迭代       | 在预算和熔断条件内逐轮推进       |
| fix      | 轻量修复           | 对小改动使用简化流程             |
| status   | 查看工作流进度     | 查看当前阶段、门禁和阻塞原因     |
| stash    | 暂停工作流         | 暂停当前变更并保留上下文         |
| resume   | 继续工作流         | 恢复暂停中的变更                 |
| research | 调研与约束         | 形成调研事实、约束和待决问题     |
| ask      | 澄清待决问题       | 处理 TBD 问题并回填调研结论      |
| chat     | 讨论想法           | 讨论方向，不直接修改项目         |
| design   | 技术设计           | 梳理架构、接口和数据模型         |
| propose  | 生成实施方案       | 形成可审阅的 proposal            |
| revise   | 修改实施方案       | 修改方案的指定部分               |
| apply    | 执行实施           | 按批准后的方案派发实施任务       |
| verify   | 独立验证           | 使用新上下文验证代码、行为和约束 |
| ship     | 收口修复批次       | 统一审计并收口多个轻量修复       |
| archive  | 归档与复盘         | 归档变更并生成复盘资料           |

### 2.2 主流程

```text
调研
  ├── 仍有 TBD → 澄清待决问题 → 回到调研
  └── TBD 清空
        ├── 复杂任务 → 技术设计
        └── 简单任务 → 生成实施方案

生成实施方案
  └── 方案确认：等待用户批准
        ├── 拒绝 → 修改实施方案 → 再次确认
        └── 批准 → 执行实施

执行实施
  └── 独立验证
        ├── 失败 → 回到执行实施
        └── 通过 → 最终验收 → 归档
```

### 2.3 必须保留的硬约束

- Proposal 前必须不存在未处理的 TBD-N。
- Apply 前必须存在结构完整且已批准的 proposal。
- Verify 前必须有真实实施结果。
- Verify 失败不能进入归档，必须回到实施或修复阶段。
- Archive 前必须满足方案批准、实施完成、验证完成和最终验收条件。
- Loop 必须有最大轮数、成本或时间边界、取消入口和无进展熔断。
- 同一个项目第一版只允许一个 active change，避免多个线程同时改写同一份产物。

### 2.4 项目产物

保持与原工作流兼容的项目级产物：

```text
spec/
├── knowledge.md
├── changes/<change-name>/
│   ├── fix.md
│   ├── research.md
│   ├── research/
│   ├── design.md
│   ├── proposal.md
│   ├── tasks.md
│   ├── verify.md
│   └── retrospect.md
└── archive/<date-name>/
```

Code Work 内部状态负责运行控制；spec/ 负责项目可见的设计、实施和验证产物。两者不能互相替代。

## 3. Code Work 复用边界

### 3.1 可直接复用的能力

- [ComposerAddMenu.tsx](../../apps/web/src/components/chat/ComposerAddMenu.tsx) 已经提供“+”入口、图标、标题、描述和状态标记。
- [ChatComposer.tsx](../../apps/web/src/components/chat/ChatComposer.tsx) 已经接入线程 Goal 的设置、暂停、恢复和清除。
- [packages/contracts/src/orchestration.ts](../../packages/contracts/src/orchestration.ts) 已经提供类型化 WebSocket、线程 Goal、Proposal Plan、Session、Activity 和 Checkpoint 合同。
- [CompositionOrchestratorService.ts](../../apps/server/src/composition/CompositionOrchestratorService.ts) 已经提供 Task 派发、取消、恢复、重试和持久化运行恢复。
- [composition.ts](../../packages/contracts/src/composition.ts) 已经提供 Task、Task Graph、Agent Loop、能力授权和审计合同。
- [CompositionGoalLoop.ts](../../apps/server/src/composition/CompositionGoalLoop.ts) 已经提供最大轮数、截止时间、取消、完成标记和无进展熔断基础。
- Code Work 现有事件投影和 Receipt/Checkpoint 机制可以承担跨回合状态和恢复。

### 3.2 不应复用为核心的能力

当前 localPlugin.ts 的权限和动作只覆盖：

```text
workspace.read
clipboard.write
composer.prompt.write
timeline.write
composer.attachment.add
```

它适合前端声明式贡献，不适合工作流核心。不要为了接入 SpecWorkflow 而给 Local Plugin 增加任意 Shell、任意 RPC 或任意 Agent 派发权限。

Local Plugin 的浏览器本地存储也不能成为工作流状态的权威来源，因为工作流需要支持 Server、Web、Desktop、Mobile、远程连接和多设备同步。

### 3.3 官方插件能力边界

如果目标是修改 Code Work，本方案可以把它实现为真正的内建能力；如果目标是直接修改官方 Codex 宿主，则公开能力边界不同。

OpenAI 当前公开的插件模型由 Skills、MCP Server 和可选 UI 组成，插件还可以携带宿主相关 Hook，但公开文档没有提供把第三方仓库注册成官方宿主内建工作流引擎的接口。因此本项目不能把官方 Codex 本体改造成 Code Work 的内建领域模块，只能在官方宿主支持的 Plugin/Skill/MCP/Hook 形态中接入。[Plugin architecture](https://developers.openai.com/plugins/concepts/plugins) [Skills](https://developers.openai.com/plugins/concepts/skills) [Package your plugin](https://developers.openai.com/plugins/build/plugins)

本方案的 canonical implementation 是 Code Work 自己的 Contracts、Server Domain、状态持久化和多端 UI；未来如有需要，可以再提供一个薄的 Skill/Plugin 适配层，但不能反过来让 Skill 成为核心真相来源。

## 4. 内建能力架构

### 4.1 分层结构

```text
用户 + 菜单
    ↓ 显式启用当前线程
SpecWorkflow Capability Grant
    ↓
SpecWorkflow Router
    ↓
SpecWorkflow Decider / Projector
    ├── 阶段转换和硬门禁
    ├── 当前 change 和产物状态
    ├── 暂停、恢复、重试和幂等
    └── 事件、快照和订阅
    ↓
Composition Orchestrator
    ├── Agent Task
    ├── Task Graph
    ├── Verify Agent
    └── Goal Loop
    ↓
项目 spec/ 产物和用户可见状态
```

### 4.2 启用契约

默认值必须是：

```text
specWorkflow.enabled = false
```

用户点击“+ → 规格驱动开发”后，当前线程获得工作流能力授权。第一版默认只作用于当前线程；后续如果增加项目级启用，必须提供明确的“本项目后续线程也启用”选项，不能静默扩大范围。

禁用时必须同时满足：

- 不加载工作流阶段指令。
- 不自动进行工作流意图路由。
- 不启动 loop 或阶段继续器。
- 不写入新的 spec/ 产物。
- 不拦截普通对话和普通编码。
- 不因为已有 spec/ 文件而自动接管项目。
- 不删除用户已有的 spec/ 文件、代码或任务。

### 4.3 建议的状态模型

第一版使用专用、明确的状态模型，不建设通用工作流平台：

```text
SpecWorkflowState
├── workflowId
├── projectId
├── threadId
├── changeName
├── mode: full | fix | loop
├── enabled
├── stage
├── status
├── revision
├── activeTaskId
├── tbdCount
├── proposalGate
├── verificationStatus
├── acceptanceStatus
├── loopBudget
├── lastError
└── updatedAt
```

建议阶段：

```text
idle
research
ask
chat
design
propose
awaiting_approval
revise
apply
verify
awaiting_acceptance
archive
stash
blocked
failed
completed
```

### 4.4 事件驱动的互相唤醒

不要让阶段之间通过递归 Prompt 互相调用。阶段执行后只产生明确结果和事件，再由 Decider 选择合法下一步：

```text
阶段执行
  → 阶段结果事件
  → Decider 检查前置条件
  → StageAdvanced / WaitingApproval / Blocked / Failed
  → Reactor 启动下一阶段，或等待用户
```

建议事件包括：

```text
SpecWorkflowEnabled
SpecWorkflowDisabled
SpecChangeStarted
SpecResearchUpdated
SpecTbdDetected
SpecTbdResolved
SpecDesignReady
SpecProposalReady
SpecApprovalRequested
SpecProposalApproved
SpecProposalRejected
SpecImplementationStarted
SpecImplementationCompleted
SpecVerificationStarted
SpecVerificationFailed
SpecVerificationPassed
SpecAcceptanceRequested
SpecAccepted
SpecPaused
SpecResumed
SpecArchived
SpecBlocked
SpecFailed
```

所有会改变状态的命令都必须带有命令 ID、revision 或等效的幂等信息。重复点击批准、重复恢复和重复派发不能产生两个执行任务。

当前 Server 的终态反应已经落地为 `SpecWorkflowReactor`：普通 `apply` 成功后，只有持久化的
独立验证者身份存在、工作流仍 active 且能力仍 enabled 时才自动派发 `verify`；`verify`
成功后只自动进入 `acceptance`，不会替用户完成最终验收。暂停、失败、取消、超时或能力关闭
都会停止后续自动唤醒，并保留可重试的阶段状态。

### 4.5 Composition 适配与 Server service（Round 4-7、Round 12 已落地）

Server 领域层新增 `SpecWorkflowCompositionBridge`，它是 Router、Decider 与现有 `CompositionOrchestratorService` 之间的唯一适配边界：

- 先检查当前线程的 capability；未启用时直接失败，不能触发 Composition。
- 先调用 Router，再用 Decider 产生下一条 state event；桥接层不自行修改 snapshot。
- 只有合法进入 `apply` 或 `verify` 时才派发 Composition Task，Task/Run 身份由 `workflowId + stage + nextRevision` 稳定生成。
- Composition 已存在时按项目、线程、执行者、prompt digest 和 Run 身份核对后复用；身份不一致显式报幂等冲突，不猜测复用。
- `verify` 必须指定与实施者不同的独立执行者，并在本次 Task prompt 中保留独立验证约束。
- 暂停/恢复仍产生 Decider state event；暂停状态会阻止后续阶段派发，调用方负责把返回事件持久化并广播。
- `SpecWorkflowStateStore` 将完整 state event 和最新 state JSON 写入 SQLite；expected revision、连续 revision、事件重复重放和跨 Store 重建都由 Server 校验。
- `SpecWorkflowService` 负责 start/get/dispatch/pause/resume/subscribe，RPC 只调用该 service；WebSocket 层不复制阶段判断或 Task ID 生成逻辑。
- Composition Task 派发成功后保存 `activeTaskId`；Server service 复用现有 `CompositionTaskRuntimeProjectionService.awaitTaskCompletion` 等待真实 Task/Run 终态，不轮询数据库。
- `completed` 会由 Decider 生成 `record-task-result` 事件：apply 设置实施完成，verify 设置验证通过；`failed`、`cancelled` 和 `timed_out` 清除 active Task 并保留可重试阶段与稳定错误信息。
- `SpecWorkflowReactor` 消费上述终态后的已持久化状态：apply 成功自动唤醒独立 verify，verify 成功自动进入人工 acceptance；反应前再次检查 capability，避免用户关闭能力后仍启动后续任务。
- 已增加 InMemory Runtime Adapter → Runtime Agent Driver → Composition Orchestrator → Runtime Projector 的最小真实链路测试，重复终态事件不会重复写入 Composition 台账。

Round 4-7 已完成 Server service、持久化、RPC、最小真实 Runtime driver 链路、任务终态回写和启动关联恢复；Round 12 补齐了普通阶段终态到下一阶段的最小 Reactor 闭环。Loop 仍复用现有 Goal Loop Runner，不新增第二套循环器。

### 4.6 自动路由

用户点击菜单项或输入自然语言时，菜单动作只表示意图，不代表可以跳过门禁。

路由顺序固定为：

1. 检查当前线程是否已启用。
2. 读取当前工作流快照和 active change。
3. 确定性检查产物、TBD、Proposal、Tasks、Verify 和暂停状态。
4. 先根据当前状态确定合法阶段。
5. 只有自然语言不明确时才使用模型归类 typed intent。
6. 低置信度进入讨论或普通对话，不启动实施。
7. 向用户展示最终选择和原因。

#### 4.6.1 Provider typed intent 承载

普通自然语言不直接成为 Server 的自由文本命令，而是通过已启用线程的
Provider 回合承载 typed intent：

- `ProviderCommandReactor` 只有在当前线程 capability 已确认 `enabled=true` 时，才初始化线程级 workflow state，并把当前阶段、TBD、方案、实现、验证和验收状态注入 Provider 上下文。
- Provider 若确定用户确实要求工作流动作，只能在最终回复中返回唯一的 `[[SPEC_WORKFLOW_INTENT: ...]]` marker；服务端严格校验枚举和唯一性，并在聊天投影前剥离 marker。
- marker 剥离后，`ProviderRuntimeIngestion` 使用现有 `SpecWorkflowService.dispatch` 回传 typed intent；Router 的纠偏和 Decider 的 revision/阶段门禁仍是最终裁决，不接受 Prompt 自称完成或绕过审批。
- `apply/fix` 会记录当前 Provider 为实施者，并只从现有 Registry 选择状态为 `available` 且身份不同的 Driver 作为可选独立验证者；找不到时仍可完成实施，但不会伪造自动验证身份。
- `verify` 不由同一自然语言回合直接伪造独立身份；实施 Task 成功后的持久化 Reactor 才能按 handoff 自动唤醒独立验证。低置信度、普通讨论和无明确动作不应返回 marker。
- capability 未启用时，普通 Provider 输入保持原样，不初始化 workflow state、不注入协议、不解析或派发工作流意图；已有 `spec/` 文件也不会改变这个判断。
- `mode=fix` 是独立的轻量修复批次：从 `apply` 起步，允许多个已完成修复继续累积到同一 change 的 `fix.md`；修复终态不会逐项自动验证，`ship` 必须先由 Server 确认 `fix.md` 非空，再用不同于实施者的执行者派发一次独立 `verify`。验证失败保留批次并回到 `fix`，成功后仍经过人工最终验收才可归档。

例如：

| 用户动作               | 当前状态        | 结果                               |
| ---------------------- | --------------- | ---------------------------------- |
| 点击“执行实施”         | 没有已批准方案  | 转到方案生成或方案确认，不执行代码 |
| 点击“独立验证”         | 尚无实施结果    | 转到进度检查并提示缺少实施         |
| 点击“生成实施方案”     | 仍有 TBD-N      | 转到澄清待决问题                   |
| 点击“归档”             | 验证失败        | 拒绝归档并回到实施/修复            |
| 用户说“先聊聊方向”     | 尚未建立 change | 进入讨论，不写实施产物             |
| 用户说“继续刚才的项目” | 有暂停 change   | 恢复原阶段                         |

## 5. 用户界面和 i18n

### 5.1 “+”菜单

菜单只增加一个内建入口：

```text
规格驱动开发
从想法到方案、实施、验证和归档
```

启用后显示当前状态，例如：

```text
规格驱动开发
已启用 · 当前阶段：生成实施方案
- 方案确认：批准 / 拒绝
- 最终验收：完成最终验收
- 工作流：暂停 / 恢复
```

当状态为“最终验收”且验收仍待完成时，Web Composer 的“+”菜单和 Mobile
工作流控制面都会显示“完成最终验收”。该按钮只提交带当前 revision 的
`completeSpecWorkflowAcceptance` 命令；工作流未启用、已暂停、阶段不符或
revision 过期时，客户端不发起操作，Server 仍会再次执行状态门禁。

Local Plugins 区域继续用于真正的本地插件，不能把 SpecWorkflow 伪装成普通 Local Plugin。

### 5.2 用户名称

| 内部 ID  | 中文名称           | English                         |
| -------- | ------------------ | ------------------------------- |
| workflow | 从想法到可交付项目 | From idea to deliverable        |
| research | 调研与约束         | Research and constraints        |
| ask      | 澄清待决问题       | Clarify open questions          |
| chat     | 讨论想法           | Discuss the idea                |
| design   | 技术设计           | Technical design                |
| propose  | 生成实施方案       | Create implementation proposal  |
| revise   | 修改实施方案       | Revise implementation proposal  |
| apply    | 执行实施           | Implement the approved plan     |
| verify   | 独立验证           | Independent verification        |
| archive  | 归档与复盘         | Archive and retrospect          |
| status   | 查看工作流进度     | View workflow status            |
| stash    | 暂停工作流         | Pause workflow                  |
| resume   | 继续工作流         | Resume workflow                 |
| fix      | 轻量修复           | Lightweight fix                 |
| ship     | 收口修复批次       | Close the fix batch             |
| loop     | 受控自主迭代       | Controlled autonomous iteration |

HARD GATE 的用户文案使用：

```text
方案确认
必须由你确认后才能开始实施
```

技术 ID 不翻译，所有展示文案必须进入语言包，例如：

```text
specWorkflow.menu.title
specWorkflow.menu.description
specWorkflow.status.disabled
specWorkflow.status.enabled
specWorkflow.stage.research
specWorkflow.stage.awaitingApproval
specWorkflow.action.enable
specWorkflow.action.disable
specWorkflow.action.pause
specWorkflow.action.resume
specWorkflow.action.approve
specWorkflow.action.reject
specWorkflow.error.blockedByGate
specWorkflow.error.tbdRemaining
specWorkflow.error.noImplementationToVerify
```

## 6. 建议的代码落点

### 6.1 Contracts

新增独立合同文件 packages/contracts/src/specWorkflow.ts，包括：

- 阶段、状态和模式。
- Enable/Disable、Dispatch、Pause/Resume、Approve/Reject 命令。
- Workflow Intent。
- Workflow Event。
- Workflow Snapshot。
- 错误码和门禁原因。

沿用现有 Effect Schema 和类型化 RPC，不使用 unknown 传递核心状态。

### 6.2 Server

新增专用领域模块，建议放在 apps/server/src/specWorkflow/：

```text
SpecWorkflowDecider.ts
SpecWorkflowProjector.ts
SpecWorkflowService.ts
SpecWorkflowArtifactStore.ts
SpecWorkflowRouter.ts
```

该模块负责状态和门禁；Agent 执行复用 Composition，不重复实现 Orchestrator。

建议优先提供少量稳定 RPC：

- 获取和订阅 Workflow Snapshot。
- 启用/禁用当前线程工作流。
- 提交 typed intent 或阶段动作。
- 用户批准/拒绝方案。
- 暂停/恢复工作流。

### 6.3 Web/Desktop/Mobile

- Web 在现有 ComposerAddMenu 增加入口和状态展示。
- Desktop 复用 Web 的工作流界面，但必须验证打包态入口。
- Mobile 在线程页提供阶段查看、暂停/恢复、批准/拒绝、启用/停用和阻塞原因查看。
- 所有客户端都从 Server Snapshot 获取状态，不能各自维护一套工作流真相。

### 6.4 Mobile、连接方式与 Provider 边界

Mobile 复用 `packages/client-runtime/src/state/spec-workflow.ts` 的同一组
Environment RPC atoms，并以 `environmentId + threadId` 作为键。因此本地、远程 Bearer、
Code Work Connect 的 Relay/托管 Tunnel 和 SSH 连接不会各自维护工作流状态；状态真相仍在
对应环境的 Server。连接阶段不是 `connected` 时，Mobile 保留已知快照但禁用启用、审批、
暂停和恢复，并显示当前连接状态，避免离线时产生看似成功的控制操作。

Spec Workflow 不直接识别或启动 Provider CLI，而是把阶段任务交给现有 Composition
`assigneeId`/Agent Driver 边界。当前 Composition Provider 驱动（Codex、Claude、Cursor、
Grok、OpenCode）以及 BYOK 均沿用已有 Driver/Adapter；工作流本身不复制 Provider 协议。
若目标 Driver 不存在，或现有 Provider/Runtime 报告不可用、不支持或启动失败，Server 不会
跳过当前阶段或创建替代任务，而是保留 workflow 状态并返回稳定的
`composition-unavailable`，客户端显示可解释的降级信息。未知 Driver 的 profile 也由现有
Registry 标记为 `degraded/driver_profile_missing`，不能被当作完整支持。

## 7. 验证方案

### 7.1 状态机单元测试

至少覆盖：

- 未启用时所有工作流命令被拒绝或按普通对话处理。
- 启用后能够建立 change。
- research 存在 TBD 时不能进入 propose。
- TBD 清空后才能进入方案阶段。
- 未批准 proposal 时不能进入 apply。
- proposal 被拒绝后只能进入 revise 或重新 propose。
- apply 完成后才能进入 verify。
- verify 失败后回到 apply。
- verify 通过后进入 acceptance。
- 未完成 acceptance 不能 archive。
- stash/resume 能恢复原阶段。
- 重复点击 approve 不产生重复任务。
- 并发 dispatch 不能启动两个相同的执行任务。
- Server 重启和客户端重连后能恢复正确阶段。

### 7.2 产物测试

至少验证：

- research.md 能创建和更新。
- TBD-N 能正确检测。
- proposal.md 缺少必要章节时被拒绝。
- proposal 批准标记能正确处理。
- tasks 未完成时不能 archive。
- verify 账本能生成和读取。
- 归档后 active change 状态关闭。
- 已有 spec/ 项目可以被识别。
- 禁用工作流不会删除现有产物。
- 项目路径越界会被拒绝。

### 7.3 Agent/Composition 集成测试

至少验证：

- apply 确实产生真实 Composition Task。
- verify 使用独立上下文或独立任务。
- 任务失败后状态回到可恢复状态。
- 任务取消后工作流不会继续偷偷推进。
- Goal Loop 到达预算、截止时间和无进展限制时停止。
- Server 重启后能够恢复未完成任务。
- 客户端断线重连后收到最新工作流快照。

### 7.4 UI 验收路径

以下是发布前验收基准。Round 16 已在隔离 Web 线程完成“+ → 规格工作流（规格驱动开发）→ 已启用 → 状态显示 → 关闭回滚”和关闭后的普通 Provider 回合；Desktop 已完成隔离构建与启动冒烟。Mobile 真机和 Relay/Tunnel 实网仍需在对应部署环境补验。

```text
未启用
  → 发送普通需求
  → 不出现工作流状态
  → 不写 spec 产物

点击“+ → 规格工作流（规格驱动开发）”
  → 显示已启用
  → 输入一个新想法
  → 自动进入调研或讨论

用户错误点击“执行实施”
  → 服务端不绕过门禁
  → UI 显示真实原因
  → 自动转到合法阶段

生成 proposal
  → UI 停在方案确认
  → 用户批准
  → 才启动实施

实施完成
  → Reactor 自动派发独立验证（缺少独立验证者时停在实施完成）
  → 验证失败回到实施
  → 验证通过进入最终验收

最终验收
  → 用户在 Web/Mobile 工作流控制面点击“完成最终验收”
  → Server 校验 active、acceptance、pending 和 revision
  → 进入归档前置状态
  → 用户选择 ship/归档后才归档

暂停/断线/重连
  → 状态不丢
  → 恢复后继续原阶段
```

## 8. 风险和回滚

### 8.1 风险

- 模型意图判断错误：由确定性状态机和低置信度降级保护。
- 门禁被 Prompt 绕过：所有关键门禁必须在 Server Decider 中执行。
- 多线程并发修改同一 change：使用 active change 限制、revision 和任务租约。
- 旧 spec/ 被误接管：默认只读发现，用户明确选择后才接管。
- Codex/Claude Hook 版本漂移：不将第三方 Hook 作为 Code Work 核心依赖。
- 本地和远程状态不一致：服务端状态作为唯一运行控制面。
- 当前环境没有 Android 设备和真实 Relay/Tunnel 目标：无法在本轮运行真机/实网切换；Mobile/连接边界已有共享合同、连接状态禁用控制、Provider 降级和 focused type/test 证据，部署前必须补做对应真实环境验收。

### 8.2 回滚

```text
specWorkflow.enabled = false
```

禁用时停止新的工作流路由和 Reactor，不删除已有项目产物、不回滚用户代码、不清理用户变更。新事件和 Schema 应保持向后兼容；必要时通过服务端能力开关整体关闭。

## 9. Goal 持续执行清单

下面的 Goal 提示词是本方案的执行入口。每轮只能完成一个连贯增量；只有真实验证通过，才能勾选对应项。不能把“已写代码”“计划完成”或“测试未运行”当成完成。

### 9.1 八个独立验收项

- [x] A1：建立内建能力合同和关闭闸门。verify：新增合同通过 targeted type/test；默认关闭时发送普通需求不会进入工作流、不写新 spec/ 产物，启用/禁用状态可由 Server 读取和订阅。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 1。
- [x] A2：实现工作流状态机、事件投影和项目产物适配。verify：研究、TBD、设计、提案、批准、实施、验证、验收、归档的合法/非法转换测试通过；spec/changes/<change-name>/ 产物可创建、读取、恢复，非法跳转被服务端拒绝。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 2。
- [x] A3：实现 typed intent 自动路由和错误选择纠正。verify：至少覆盖“无批准方案点击实施”“有 TBD 点击提案”“无实施结果点击验证”“验证失败点击归档”四类测试，并证明路由不会跳过门禁。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 3。
- [x] A4：接入 Composition 执行、独立验证、暂停恢复和幂等。verify：apply/verify 产生真实可追踪 Task；重复命令不重复派发；取消、失败、Server 重启或客户端重连后能恢复正确阶段；Goal Loop 有预算、取消和无进展熔断。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 4-7。
- [x] A5：完成 Web/Desktop 的“+”入口、状态显示和完整 i18n。verify：zh-CN 和 en-US 的用户文案完整；菜单能启用、禁用、查看阶段、批准、拒绝、完成最终验收、暂停和恢复；通过变更范围内的测试、类型检查和构建；真实 Web 点击及隔离 Desktop 启动证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 8-9、Round 13、Round 16。
- [x] A6：完成 Mobile、远程连接和 Provider 边界验证。verify：Mobile 至少可以查看状态、批准/拒绝、完成最终验收、暂停/恢复；本地、远程、Tunnel/Relay 状态一致；每个受影响 Provider 明确支持或降级原因，并有针对性验证证据。Mobile/连接 focused evidence 见 `spec/changes/spec-workflow-native-feature/loop.md` Round 10、Round 13、Round 16；真机/实网因环境缺失未运行，风险已记录。
- [x] A7：补齐 fix、ship、loop、独立验证和归档收尾。verify：轻量修复批次、受控自主循环、验证失败回退、验收和归档均有可恢复路径；loop 不会与另一个循环器并发，也不会无预算运行；归档前置条件全部由 Server 执行。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 11、Round 15。
- [x] A8：完成最终独立验收、文档同步和回滚证明。verify：使用新上下文逐项重新执行 A1-A7 的验证命令和关键用户路径；所有结果记录在工作流账本和本文档；回滚开关经过验证；没有未说明的 not run、假通过、占位实现或未处理阻塞。Android 真机与 Relay/Tunnel 实网未运行的环境原因和风险已在 Round 16 记录。

## 10. 可直接复制到 Goal 的持续执行提示词

以下内容可以直接复制到 Goal。它把本方案、执行边界、逐项勾选规则和最终验收要求全部包含在内。

```text
目标：在当前 Code Work 仓库中，把 kamioj/spec-workflow 的核心能力实现为 Code Work 的一等“规格驱动开发”内建功能，而不是 Skill，也不是普通 Local Plugin。功能必须从对话输入框的“+”中显式启用；用户未启用时，Agent 不得擅自使用该工作流。启用后，Agent 根据当前线程的工作流状态、项目 spec/ 产物和用户意图自动选择合法阶段；用户选错入口时自动纠正并解释原因；阶段之间通过服务端事件、状态机和 Reactor 互相唤醒；直到所有验收项真实完成并通过最终独立验收。

先读并遵守：
1. E:/MyProject/code-work/AGENTS.md
2. E:/MyProject/code-work/docs/internals/spec-workflow-native-feature.md
3. 当前工作树状态、最近相关提交、相关合同、Composer、Server Composition 和现有测试。

执行边界：
- 这是 Code Work 的内建能力，不能通过新增或依赖 SKILL.md 才能运行；Goal 的循环机制可以使用，但交付物必须是 Code Work 的 Contracts、Server Domain、持久化状态、Web/Desktop/Mobile UI 和测试。
- 不要把 SpecWorkflow 塞进 LocalPluginCommandAction，不要给普通 Local Plugin 增加任意 Shell、任意 RPC 或任意 Agent 派发权限。
- 默认 specWorkflow.enabled=false。未启用时不得自动路由、不得启动 loop、不得启动阶段 Reactor、不得写新的 spec/ 产物、不得因为发现旧 spec/ 目录而接管。
- 启用范围第一版是当前线程；不得默认扩大到全局或整个项目。
- 服务端状态机和门禁是真相来源。Prompt、菜单和模型判断只能表达意图，不能绕过 TBD、方案批准、实施、验证和归档门禁。
- 自然语言只在启用线程的 Provider 回合中承载：先注入当前状态上下文，Provider 仅能回传唯一合法 `SPEC_WORKFLOW_INTENT` marker；服务端剥离 marker 后再调用 typed dispatch。未知、重复或低置信度 marker 不得执行，`verify` 的独立身份不得由模型伪造。
- 阶段之间用事件和合法状态转换互相唤醒，不要用 Prompt 递归调用下一阶段。
- 优先复用现有 orchestration、CompositionOrchestratorService、Task Graph、Agent Loop、Goal Loop、Checkpoint、Receipt、Thread Goal 和现有 Provider Adapter。
- 项目产物保持兼容：spec/knowledge.md、spec/changes/<change-name>/research.md、design.md、proposal.md、tasks.md、verify.md、retrospect.md、archive/。
- 用户展示名称必须完整 i18n，内部 stage ID 保持稳定；主要名称使用“规格驱动开发”“调研与约束”“方案确认”等清楚文案，不把 TBD、HARD GATE、apply 等技术词作为唯一用户名称。
- 不得修改、重置、清理、覆盖当前工作树中的无关用户改动；不要 git reset、git clean、git checkout、stash 或批量格式化无关文件。
- 所有新代码注释和新文档使用中文；保持既有代码风格；不要增加没有实际需要的通用抽象。
- 只运行变更范围相关的 focused tests、targeted typecheck/build；遵守仓库规则，不运行 repo-wide check 或完整全仓测试，除非用户明确授权。
- 不要自行启动浏览器或 computer use。若真实 UI 验收需要额外授权，记录未验证原因、风险和下一步，不得把静态检查冒充 UI 验收。
- 不得提交、推送或创建 PR，除非用户另行明确要求。

执行方式：
1. 第一轮先检查工作树、文档、相关代码和现有实现，建立或恢复唯一的工作流账本。不要假设功能不存在；先搜索已有实现、合同、测试和相似模式。
2. 每一轮只选择一个“连贯的增量”，优先选择下面第一个未完成验收项，或上一轮复盘中明确的下一步。不要在同一轮跨越多个验收项。
3. 每轮按顺序记录：Plan（这一轮为什么做它）、Act（改了哪些文件）、Verify（运行了什么命令和关键结果）、Retrospect（学到了什么、下一轮做什么）。
4. 只有 Verify 有真实证据时，才可以勾选一个验收项；一个验收项未完全满足就保持未勾选。不能一次勾选多个，不能用“代码已写”“理论上可用”“测试未运行”勾选。
5. 如果发现用户已有未提交改动和本任务重叠，先保留并分析，缩小修改范围；不能覆盖或替换。
6. 如果遇到三次连续同方向失败，停止机械重试，记录失败现象、已尝试方法、根因判断、回滚方式和新的最小方案，进入 paused 状态等待用户决定。
7. 所有验收项勾选后，进行一次全新的最终独立验收：重新读取文档和代码，逐项执行每个 verify 条件，特别验证“未启用时完全不介入”“错误入口不绕过门禁”“断线/重启可恢复”“多端/远程行为有证据”。最终独立验收失败的项目必须取消勾选并继续修复。
8. 只有 A1-A8 全部通过最终独立验收，才报告 Goal 完成。任何未运行、仅推断、仅 mock、仅静态检查或未获 UI 授权的项目都必须明确标记，不得声称完全完成。

验收清单（按完成一个勾选一个）：
- [x] A1：建立内建能力合同和关闭闸门。verify：合同通过 targeted type/test；默认关闭时普通需求不进入工作流、不写新 spec/ 产物；启用/禁用状态可以由 Server 读取和订阅。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 1。
- [x] A2：实现工作流状态机、事件投影和项目产物适配。verify：研究、TBD、设计、提案、批准、实施、验证、验收、归档的合法/非法转换测试通过；产物可以创建、读取和恢复；非法跳转被服务端拒绝。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 2。
- [x] A3：实现 typed intent 自动路由和错误选择纠正。verify：覆盖无批准方案点击实施、有 TBD 点击提案、无实施结果点击验证、验证失败点击归档四类测试，并证明路由不会绕过门禁。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 3。
- [x] A4：接入 Composition 执行、独立验证、暂停恢复和幂等。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 4-7。
- [x] A5：完成 Web/Desktop 的“+”入口、状态显示、审批/最终验收控制和完整 i18n；真实浏览器/Electron 点击验收保留到 A8。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 8-9、Round 13。
- [x] A6：完成 Mobile、远程连接、最终验收控制和 Provider 边界验证；真实设备/网络切换验收保留到 A8。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 10、Round 13。
- [x] A7：补齐 fix、ship、loop、独立验证和归档收尾。verify：轻量修复批次、受控自主循环、验证失败回退、验收和归档均有可恢复路径；loop 有预算且不会重复并发；归档前置条件由 Server 执行。证据见 `spec/changes/spec-workflow-native-feature/loop.md` Round 11、Round 15。
- [x] A8：完成最终独立验收、文档同步和回滚证明。verify：使用新上下文逐项重跑 A1-A7 的验证命令和关键路径；结果写入账本和本文档；回滚开关经过验证；没有未说明的 not run、假通过、占位实现或未处理阻塞。Android 真机与 Relay/Tunnel 实网未运行的环境原因和风险已在 Round 16 记录。

持续运行要求：
- 不要因为一轮结束就停止；如果还有未勾选项，结束本轮时写好 Retrospect 和下一轮 Plan，让 Goal 继续驱动下一轮。
- 不要同时运行两个工作流循环，也不要与其他 Stop 驱动循环器并行。
- 工作流可以在方案确认和最终验收处等待用户，但不能跳过这两个确认点。
- 每轮只完成一个连贯增量；每个验收项完成后立即勾选并记录证据，然后继续下一个未勾选项。
- 直到 A1-A8 全部经过最终独立验收，不要把任务报告为完成。
```

## 11. 当前交付状态

- 本文档已创建。
- A1 已完成：新增内建 Spec Workflow 能力合同、Server RPC 读写/订阅、SQLite migration 075、持久化 Store、授权映射和关闭闸门测试；未接入普通对话 dispatch，也未创建 `spec/` 工作流产物。
- A2 已完成：新增主流程状态机、连续 revision 事件投影、状态恢复和受 workspace root 保护的 Markdown 产物适配器。
- A3 已完成：新增 typed intent Router；未启用时 pass-through，误选 apply/verify/propose/archive 时分别返回等待确认、完成实施、澄清 TBD 或回到实施的 typed route。
- A4 已完成代码级验收：`SpecWorkflowCompositionBridge`、`SpecWorkflowStateStore` 和 `SpecWorkflowService` 已连接 capability、Router、Decider、SQLite snapshot/event、RPC、真实 Runtime driver、Task 终态回写和启动恢复，并覆盖独立 verify、稳定身份复用、未启用拒绝、暂停/恢复、完成/失败/取消及重建恢复。
- A5 已完成代码级验收：Web Composer “+” 入口、阶段/状态/审批/最终验收/暂停恢复控制、双语文案和 Desktop 共享 Web bundle 已接入；Round 16 已在隔离 Web 线程完成真实启用/状态显示/关闭回滚，Desktop 已完成隔离构建和启动冒烟。
- A6 已完成代码级验收：Mobile 线程页复用同一 RPC state atoms，支持状态查看、启用/停用、批准/拒绝、完成最终验收、暂停/恢复；连接目标显示本地、远程、Relay/Tunnel、SSH，非 connected 时控制禁用；现有 Composition Provider/Runtime 失败统一返回可解释的 `composition-unavailable`。Round 16 重新通过 Mobile presentation/typecheck；当前环境 `adb devices` 无设备，真机和真实 Relay/Tunnel 切换保留为部署环境补验，不伪造结果。
- A7 已完成代码级验收：`mode=fix` 从 apply 起步，可在同一 change 累积多个修复；Server 在 `ship/archive` 前检查非空 `fix.md`，只对批次派发一次独立 verify，失败保留批次并回到 fix；普通 full workflow 的 apply/verify 仍由 `SpecWorkflowReactor` 自动唤醒下一合法阶段。Loop 复用现有 Goal Loop Runner，具备预算、独立 reviewer、取消、持久输入和父 Task 未落库时的稳定身份恢复；最终 acceptance 仍保留人工门禁。Round 16 重新通过 fix/ship/loop/verifier/archive 相关 focused tests。
- Provider typed intent 承载已接入普通回合的发送与终帧收口：启用线程才注入状态协议，唯一合法 marker 才能回到 typed dispatch，marker 会在用户可见文本前剥离；纠偏原因写入线程 activity，关闭 capability 时保持普通回合零介入。Round 16 在隔离 Web 线程中用安全 Provider 请求复核了关闭后的普通回合，Server 测试重新覆盖 marker、关闭闸门和回滚。
- A8 已完成当前仓库可执行范围的最终独立验收：重新执行 A1-A7 相关 focused tests（17 个文件、96 个测试）、合同/客户端/桌面/移动定向 typecheck、Web/Desktop 构建、i18n/格式检查；真实 Web 已完成“+ → 规格工作流 → 已启用 → 工作流尚未开始 → 关闭”路径，隔离项目没有 `spec/` 写入；回滚开关在 Server 和真实 Web 均已验证。唯一明确环境边界是无 Android 设备和无真实 Relay/Tunnel 目标，已在风险中记录。
- Goal ledger 位于 `spec/changes/spec-workflow-native-feature/loop.md`，A1-A8 均已完成；尚未创建实现分支、提交或推送，保留当前工作树供维护者审阅和回滚。
