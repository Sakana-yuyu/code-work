# Paseo 与 Multica clean-room 能力迁移架构

## 文档目的

本文固定 Code Work 吸收 Paseo 与 Multica 高价值能力时的架构边界、复用关系、目标状态机和验收证据。它是长期维护的内部架构约束，不是临时任务清单，也不把类型检查、协议 fixture 或静态页面描述为真实产品端到端能力。

本轮核验日期为 **2026-08-28**。目标草案中出现的 `2026-08-29` 尚未到达，因此不作为访问日期使用。

## 证据基线

| 对象            | 核验结果                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Code Work       | `E:\MyProject\code-work`，分支 `tcode`，HEAD 与 `origin/tcode` 均为 `55893618416a7c855834da5b0fe88b144b7b3e84` |
| GitHub 默认分支 | `origin/HEAD` 与远端 `HEAD` 均指向 `refs/heads/tcode`                                                          |
| 本地保护分支    | `sync/tcode-upstream` 指向 `5cd00f997cadeb63ff4369b3e8b83d67feb827af`，本迁移不删除、不改写                    |
| Paseo           | `E:\MyProject\paseo`，提交 `ed628ff82e1777f6a46f5f8963db6b4ac3ee2ce3`，工作树干净                              |
| Multica         | `E:\MyProject\multica`，提交 `64ec7f54163d918d5d7fd4dcae857f241b7842d0`，工作树干净                            |

核验时 Code Work 存在大量未提交的 BYOK、Delegation、迁移重编号、设置页、图标和文档改动。这些改动是并行工作，不属于本文所证明的稳定交付；后续提交必须精确暂存自己的文件。

## 许可与 clean-room 规则

### Paseo

Paseo 主体使用 Apache License 2.0，第三方组件继续服从各自许可证。可以研究其公开合同和行为，但任何源代码复用都必须同时检查原文件归属、第三方许可证和 NOTICE 要求。

本迁移默认优先在 Code Work 现有架构内自主实现，不直接搬运 Paseo 的组件、命名或界面。

### Multica

Multica 的 LICENSE 由 Apache License 2.0 与附加条件共同构成，附加条件限制未获商业许可时的托管服务、商业产品嵌入和 UI 派生使用，并要求相关品牌或归属处理。

因此 Multica 仅用于 clean-room 架构研究：

- 只提取问题、约束、失败模式和可验证行为。
- 不复制源码、数据库结构、API 形状、UI、品牌、文案或受限制资产。
- 不把 Multica 代码、进程或前端嵌入 Code Work 产品。
- Code Work 的合同、状态机、表结构、RPC 和界面均按自身术语与既有工程模式设计。

## Code Work 现有底座

以下能力必须复用，不能再建设第二套相互竞争的系统：

- `CompositionTask`、`CompositionTaskRun`、`CompositionTaskEvent`、依赖、Runtime Lease 和 SQLite 投影。
- `CompositionOrchestrator`、`CompositionTaskGraphExecutor`、Goal Loop、恢复重派和活性监督。
- `CompositionAgentDriverRegistry`、Runtime Adapter、Provider/IDE/Multica Driver。
- `CapabilityRegistry`、`CapabilityGrantRegistry`、`CapabilityPolicy` 与 `ToolBroker`。
- Provider/BYOK、checkpoint、resume、控制中心、Task Graph 和多端共享 RPC 基础设施。
- Web/Desktop 共用的设置系统，以及 Mobile 独立导航与 `packages/client-runtime` 共享状态层。

当前 `CompositionSquad` 只包含名称、Leader、成员、说明和归档时间；Store 只有 `upsertSquad/getSquad`。它能支撑投影和测试，但还不是用户可管理、可审计、可恢复的 Squad 产品。

## 参考能力与自主设计

| 参考问题                 | 观察到的有效约束                                                           | Code Work 自主设计方向                                                                                |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Paseo 持久化 Schedule    | every/cron/timezone、暂停恢复、立即运行、次数/过期限制、运行历史、重启恢复 | 在 Composition 之上建立 Automation 聚合；每次触发生成稳定 Run，幂等键为 `automationId + scheduledFor` |
| Paseo Workspace Scripts  | 声明、终端生命周期、端口代理、健康投影                                     | 复用 Code Work Terminal/Preview/Workspace，脚本进程只由 Workspace Script 服务持有和停止               |
| Paseo 插件贡献点         | 面板、命令、Timeline、附件、Theme 的明确宿主边界                           | 仅开放 schema 化、版本化、可禁用的贡献点；插件不直接访问内部 Store                                    |
| Multica Runtime claim    | 在线、心跳新鲜、作用域匹配、原子竞争后才能领取                             | 在 Driver 派发前执行统一 eligibility 判定；数据库状态迁移使用事务和比较条件，不依赖内存猜测           |
| Multica prepare lease    | claim 响应可能丢失；启动准备阶段需要短租约和安全重领                       | 将 Lease 与 Run 绑定，区分 `claimed/preparing/running`，支持续租、过期收回和 claim generation         |
| Multica failure taxonomy | 只有明确的瞬态白名单能自动重试                                             | 失败码结构化为类别、可重试性和恢复建议；未知错误默认不可自动重试                                      |
| Multica reconnect/orphan | Runtime 离线与任务失败分开；长任务不能只按墙钟误杀                         | Runtime 状态先转离线，任务进入 reconnect grace；结合 Runtime 心跳、任务活动和取消确认决定收口         |
| Multica Squad/Leader     | Leader、成员、依赖、动态分派、结果聚合、人工责任                           | 以 Composition Task Graph 为唯一执行事实，Squad 只负责模板、成员策略和默认权限                        |
| Multica Autopilot        | cron/webhook、Agent/Squad 目标、运行历史、责任和权限                       | Automation 目标支持 Agent、Squad、Goal Loop；触发秘密与执行权限分开管理                               |

## 目标架构

```text
Web / Desktop / Mobile / CLI / MCP
                |
                v
Typed RPC + Authorization + i18n
                |
                v
Squad / Automation / Workspace Script 应用服务
                |
                v
Composition Task / Run / Event / Dependency / Lease
                |
                v
Agent Driver Registry + Runtime Eligibility + Capability Policy
                |
      +---------+---------+----------+
      |                   |          |
 Provider/BYOK          IDE/CLI   外部 Runtime Adapter
```

关键原则：

1. Composition 是唯一任务事实源，Squad、Automation 和 Workspace Script 不复制 Task/Run 状态。
2. 外部 Runtime 只通过 Adapter 接入；协议细节不能泄漏进 Composition 核心。
3. UI 只消费稳定投影，不根据按钮点击结果自行推断最终状态。
4. 所有副作用必须有稳定幂等键；完成、取消和授权撤销必须能安全重放。
5. Runtime 可用性、任务活性和用户可见状态分开建模，避免把网络抖动直接等价为任务失败。

## Runtime 可靠性状态机

### 派发门禁

任务进入 Driver 前必须同时满足：

- Driver profile 为 `available`，或处于被策略明确允许的受限 `degraded` 状态。
- Runtime 最近一次可信探测或心跳未超过 freshness 窗口。
- Agent、项目、工作目录和所需 capability 均与 Runtime 支持范围匹配。
- 本次 Run 未被取消，且仍是该 Task 的最新可执行 Run。
- 同一幂等键或 claim generation 没有被其他执行者取得。

门禁失败必须产生稳定失败码或 blocker 事件，不能静默排队，也不能先发请求后补验证。

### Lease 生命周期

```text
queued -> claimed -> preparing -> running -> terminal
             |           |
             +-----------+-> lease expired -> reclaimable
```

- `claimed` 表示原子取得执行权，尚未证明执行器收到响应。
- `preparing` 允许执行器在解析工作区、凭据或 MCP 配置时续短租约。
- `running` 由执行器明确确认，不由服务器根据已发送响应推断。
- reclaim 必须比较 claim generation、状态、开始时间和 lease 到期时间，旧响应不得覆盖新一代 claim。
- 取消、终态和 Runtime 回收都必须释放 Lease，并撤销对应 capability handshake。

### 活性与重连

- Runtime heartbeat 决定 Runtime 是否在线；任务 activity 决定任务是否有进展。
- Runtime 刚离线时，运行中任务进入 reconnect grace，不立即失败。
- Runtime 明确重启时可以跳过普通网络 grace，进入 orphan recovery。
- Runtime 仍有新鲜心跳时，不得仅因总运行时长超过阈值杀死任务。
- 取消确认超过有界时间后才由 Watchdog 收口为 `timed_out`。

### 失败分类

至少区分：

- `cancelled`：用户或上游明确取消，不重试。
- `permission`：授权缺失、过期、撤销或 scope 不匹配，不自动重试。
- `configuration`：Runtime/模型/工作区配置错误，不自动重试。
- `capacity`：并发或配额暂时不足，可延迟重试。
- `transport`：连接中断、超时或服务端暂态错误，可在白名单内重试。
- `runtime_offline`：进入 reconnect/orphan 策略，不直接按普通错误重试。
- `agent`：模型或执行器返回的确定失败，默认不重试。
- `unknown`：证据不足，默认不自动重试并请求人工判断。

## Squad 聚合

Squad 是可版本化的协同模板，不是第二套执行引擎。目标模型至少包含：

- 基本信息：名称、说明、归档状态、创建与更新时间。
- Leader：唯一 Leader Agent，负责拆解、分派、汇总和升级人工处理。
- 成员：Agent、角色、顺序、是否必需、可承担能力、模型覆盖和并发权重。
- 策略：串行、并行、依赖图、review/critic、leader-workers。
- 运行约束：最大并发、最大重试、失败策略、部分成功策略、审批点。
- 默认授权：只保存 capability 请求模板；每次 Run 仍签发短期 task-scoped grant。
- 版本：运行记录绑定 Squad revision，后续编辑不能改变历史运行语义。

Leader 拆解的子任务必须成为真实 Composition Task；动态重派必须产生新 Run 或明确 assignee 变更事件，不能只改 UI 内存状态。

## Automation 聚合

Automation 至少支持：

- cadence：`every`、`cron + timezone`，后续可增加 webhook。
- target：Agent、Squad、Goal Loop。
- lifecycle：active、paused、completed、archived。
- limits：`maxRuns`、`expiresAt`、并发策略和失败策略。
- operations：创建、编辑、暂停、恢复、立即运行、查看历史、重试失败运行。
- recovery：服务重启时将中断执行记为明确结果，并重新计算下一次触发。

调度触发必须先持久化 Automation Run，再派发 Composition；相同 `automationId + scheduledFor` 只能产生一个有效触发。

## Workspace Script 聚合

Workspace Script 只管理声明式脚本和其运行投影：

- 声明来自项目配置，包含命令、工作目录、环境变量引用、端口和健康检查。
- 启动返回稳定 script run ID 和 terminal ID。
- 停止只允许操作该服务自己创建并持有的终端，不按进程名称结束进程。
- 终端退出负责清理端口代理、健康状态和运行投影。
- Agent 使用脚本必须经过 task-scoped capability 与审计。

## 控制面与界面

### RPC 贯通要求

任何新增能力必须完整覆盖：

```text
contracts -> persistence -> service -> authorization -> RPC handler
          -> client-runtime -> Web/Desktop/Mobile UI -> focused tests
```

不能用未注册路由、空按钮、fixture 数据或客户端本地状态冒充完整功能。

### 信息架构

- `Squads`：列表、创建/编辑、成员与策略配置、版本和归档。
- `Collaboration Runs`：任务图、当前执行者、状态、事件、重试、失败原因、审批和聚合结果。
- `Automation`：触发规则、目标、下一次运行、暂停状态和历史。
- `Workspace Scripts`：声明、运行状态、端口、健康、日志和启动/停止。
- `Inbox`：权限请求、review、失败升级和需要人工确认的恢复操作。

Web/Desktop 复用现有 Settings、Control Center 和 Task Graph 视觉语言；Mobile 使用自己的导航和适合窄屏的列表/详情结构。所有可见文字进入 i18n，不做营销式页面、卡片嵌套或持续高频动画。

## CLI、MCP 与插件边界

- CLI 与 MCP 只调用与 UI 相同的应用服务和授权策略。
- run/send/wait/logs/archive 等命令不得绕过 Task/Run/Event 事实源。
- Agent status/kill 只操作明确 ID；kill 必须验证归属和当前状态。
- 插件贡献点必须有 manifest 版本、schema 校验、权限声明、禁用和错误隔离。
- 插件不能直接读取凭据、数据库连接或内部 Effect Service。

## 分阶段交付与独立提交

1. Runtime eligibility、Lease、失败分类与恢复。
2. Squad 持久化模型、版本和应用服务。
3. Squad RPC、授权与 client-runtime。
4. Squad Builder 与 Collaboration Run Board。
5. Automation 数据模型、调度器、恢复和历史。
6. Automation 多端界面。
7. Workspace Scripts 服务与界面。
8. CLI/MCP 对等控制面。
9. 受控插件贡献点。
10. 真实客户端关键路径、故障演练、升级兼容和回滚验证。

每个提交只包含一个可独立验证、可通过 `git revert <hash>` 回滚的主题。提交前必须检查暂存文件清单、完整暂存 diff 和 `git diff --cached --check`。

## 验收证据

每项能力按以下等级分别报告：

| 等级 | 证据                                                         |
| ---- | ------------------------------------------------------------ |
| L1   | 合同、实现和迁移已进入分支                                   |
| L2   | 聚焦单元、集成、并发和幂等测试通过                           |
| L3   | 本地跨进程、数据库重启或真实客户端集成通过                   |
| L4   | 真实 Provider/IDE/Runtime 和 Web/Desktop/Mobile 关键路径通过 |
| L5   | 权限审计、故障演练、升级兼容、回滚和发布验证通过             |

类型检查、静态 i18n、mock transport 和 Node fixture 最多只能证明对应的局部等级，不能替代真实产品 E2E。

## 明确不采用

- 不复制 Multica UI、品牌、数据库结构或专有 API。
- 不让 Code Work 依赖 Multica 服务才能运行原生 Squad。
- 不为功能数量迁移与 Code Work 已有能力重复的实现。
- 不把 Cursor 私有 MITM、CA、RunSSE 或 BidiAppend 带入 Composition 核心。
- 不允许 Automation、Plugin 或外部 Runtime 绕过 Capability Policy。

## 回滚原则

- 代码提交逐个 `git revert`，不改写历史。
- 数据库变更提供向下迁移，或明确说明为何只能通过兼容读写回滚。
- 新控制面默认有功能开关；关闭后保留历史只读投影，不删除运行事实。
- Runtime 可靠性策略出现异常时，回退到“拒绝新派发、保留查询和人工恢复”，不得猜测式重试外部副作用。
