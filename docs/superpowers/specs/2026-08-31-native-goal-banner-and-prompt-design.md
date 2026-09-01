# 原生 Goal 持续任务与 Composer 状态条设计

## 状态

已获用户批准进入设计阶段。本文档覆盖 TCode 原生 Goal 的持续任务体验、
本机 Codex Goal 语义对齐、Composer 顶部状态条，以及 Cursor/VS Code 真实
对接降级为待办的范围调整。

## 目标

把 Goal 从一次性输入项变成当前会话的持久任务：用户设置目标后，目标始终
挂在 Composer 上方，直到完成、暂停、放弃或清除。目标状态由服务端事实源
驱动，刷新页面、重新打开会话和服务重启后仍可恢复。

Goal 使用 Code Work 原生 Composition/Goal Loop 运行链路，不依赖 Cursor 或
VS Code 进程。Paseo、Multica 和本机 Codex 仅作为产品语义和交互参考，
不复制它们的源码、品牌、文案或受限制资产。

## 现有能力与复用边界

本机 Codex 的 `goals_1.sqlite` 已有 `thread_goals` 持久模型，包含：

- `thread_id`、`goal_id`、`objective`；
- `active`、`paused`、`blocked`、`usage_limited`、`budget_limited`、`complete`；
- `token_budget`、`tokens_used`、`time_used_seconds`；
- `created_at_ms`、`updated_at_ms`。

Code Work 的 `packages/effect-codex-app-server/src/_generated/schema.gen.ts`
已经生成以下协议：

- `thread/goal/set`；
- `thread/goal/get`；
- `thread/goal/clear`；
- `thread/goal/updated`；
- `thread/goal/cleared`。

实现优先复用这些协议和现有线程状态来源，不创建第二套 Goal 表、第二套
状态枚举或只存在于前端的伪 Goal。

## 非目标

本轮不实现：

- 启动或控制真实 Cursor 进程；
- 启动或控制真实 VS Code 进程；
- Cursor/VS Code JSON-RPC、握手、跨进程 E2E；
- 通过 IDE 在线状态决定原生 Goal/Squad 是否可用；
- 删除所有 IDE 类型和历史协议；它们可以保留为未来扩展边界，但不得进入
  默认启动链路或阻塞 Goal；
- 新建与 Composition/Goal Loop 竞争的任务引擎；
- 修改支付、资金、退款、结算、分润或账户余额逻辑。

未来待办只记录在文档和设置说明中：

> 未来接入 Cursor / VS Code：在不影响原生 Goal/Squad 的前提下，再评估
> 外部 IDE adapter、权限、连接恢复和真实产品验收。

## 用户体验

### 1. 未设置 Goal

Composer 底部显示与现有模式控件同风格的 `目标` 控件。控件使用现有图标
体系、尺寸、圆角和 hover 行为；窄屏时只显示图标并保留可访问名称。

点击后进入 Goal 编辑状态，输入区显示：

```text
描述你的目标，定义可衡量的成果，以获得最佳效果
```

Goal 编辑不应覆盖普通消息草稿；取消编辑时恢复原来的 Composer 草稿。

### 2. Goal 运行中

成功设置 Goal 后，在 Composer 上方渲染固定状态条，视觉上接近 Codex 的
“进行中的目标”行：

- 左侧：Goal 图标和状态文案 `进行中的目标`；
- 中间：目标标题或经过安全截断的 objective 摘要；
- 右侧：从 `createdAt` 和暂停累计时间计算的持续时间；
- 操作按钮：暂停/继续、放弃或清除、展开详情；
- 状态条不随普通消息滚动离开 Composer；
- 不使用营销式大卡片，不嵌套卡片，不引入新的视觉主题。

状态条必须支持键盘操作、焦点可见、按钮具备可访问名称，目标摘要过长时
不得撑破布局。

### 3. 状态终态

- `active`：显示“进行中的目标”，允许暂停和清除；
- `paused`：显示“已暂停”，允许继续和清除；
- `blocked`：显示“需要处理”，允许展开详情和清除；
- `usage_limited`：显示“已达到用量限制”，允许查看详情和清除；
- `budget_limited`：显示“已达到预算限制”，允许查看详情和清除；
- `complete`：显示“目标已完成”和最终摘要，随后由用户清除或由产品策略
  收起，但不能错误显示为 active。

只有服务端返回完成、清除、放弃或明确错误终态后，才能解除持续挂载。

## 数据流

```text
Composer 目标按钮
  -> 本地编辑态
  -> thread/goal/set
  -> 服务端 thread goal 持久层
  -> thread/goal/updated
  -> client runtime / thread store
  -> Composer 顶部 Goal 状态条
```

读取流程：

```text
打开或切换会话
  -> thread/goal/get
  -> 线程状态源
  -> 恢复 Goal 条和 Composer 目标上下文
```

清除流程：

```text
用户清除/放弃
  -> thread/goal/clear
  -> 删除后续请求注入
  -> thread/goal/cleared
  -> 解除 Composer 顶部挂载
```

Goal objective 进入后续每轮模型请求的稳定上下文，但动态状态、计时器、
用量变化和 UI 提醒必须使用 latest-only 状态或本轮后缀，不得无限追加到
历史消息。

## 状态与一致性

1. `threadId` 是唯一归属边界，不能跨线程读取、修改或清除 Goal。
2. `objective` 必须做非空、长度和控制字符校验；保留用户原文，不在 UI 中
   直接拼接未脱敏异常。
3. `goalId` 稳定且由服务端生成或验证，客户端不得伪造另一线程的目标身份。
4. `set` 具备幂等语义；重复提交相同 objective 不产生重复 Goal 或重复事件。
5. 状态只能按允许的迁移变更，不能把 `complete` 回退为 `active`。
6. 持久化失败时 UI 保持旧状态并显示稳定错误码，不得先显示成功再静默回滚。
7. 同一会话的多个窗口收到 `updated/cleared` 后必须收敛到服务端版本。
8. Goal 与 Composition Task/Run/Runtime lease 的关联必须可追踪，不能把
   已清除或已完成的 Goal 投影为 running。

## 原生 Goal Loop 与 Squad 边界

Goal 负责会话级的长期 objective；Goal Loop/Composition 负责真实执行、
任务拆分、Run、事件、lease、能力授权、重试和恢复。二者关系如下：

- Goal objective 是运行上下文，不替代 Task/Run/Intent；
- Goal Loop 的持久启动 claim、accepted receipt、replay/reconcile、
  startup scan、旧 capability 兼容和真实 SQLite 跨 Runtime 验收继续使用
  现有可靠性路线；
- Squad 使用同一 Goal objective，不为 IDE 另建输入协议；
- 一个坏 Driver、未连接 IDE 或缺失外部适配器不得阻塞健康的原生候选。

## Cursor/VS Code 降级策略

1. 默认 Driver Registry 不注册或不激活真实 Cursor/VS Code 外部启动器。
2. 不在原生 Goal 设置和 Composer 中显示“连接 Cursor/VS Code”操作。
3. 保留必要的类型/协议文件时，必须明确它们是未来扩展，不得被默认恢复、
   startup scan 或 command-ready 路径自动调用。
4. 删除或禁用真实 IDE 对接时，不能删除 Goal、Squad、BYOK 或 Multica
   原生运行能力。
5. 当前验收只证明 TCode 原生 Goal/Squad 可用；IDE 接入列为后续独立任务。

## i18n 与视觉约束

- `zh-CN` 是源语言，所有新增可见文案进入现有 i18n 体系；
- 不在组件中硬编码第二套英文、日文或其他翻译文本；
- 使用现有 Lucide 图标、ComposerControl、Tooltip、Button 和布局工具；
- 卡片圆角遵循现有规范，不超过 8px；Goal 状态条作为 Composer 邻接行，
  不做卡片套卡片；
- 长标题使用截断或换行，不能遮挡计时、按钮或输入区；
- 同时验证桌面宽度和窄屏 Composer 折叠状态。

## 测试设计

### 单元与组件测试

- Goal 状态枚举和合法迁移；
- objective 校验、截断和摘要展示；
- `active/paused/blocked/usage_limited/budget_limited/complete` 映射；
- Composer 点击目标、编辑、提交、取消和清除；
- 状态条固定在 Composer 上方；
- 刷新/切换会话后的恢复；
- 窄屏只显示图标时的可访问名称和布局不溢出；
- 重复 updated/cleared 通知不会产生重复状态或重复请求。

### 服务端与协议测试

- `thread/goal/set/get/clear` 归属校验；
- 幂等 set 和稳定 goalId；
- 非法状态迁移拒绝；
- 持久化失败时不产生假成功；
- 清除后后续请求不再注入 objective；
- 旧线程/未知线程访问 fail-closed。

### 真实恢复测试

Goal 本轮至少要有一个真实服务重启恢复测试：

1. Runtime A 设置 active Goal；
2. 关闭 Runtime A、Store 和数据库连接；
3. 使用同一个 SQLite 文件创建全新的 Runtime B；
4. 读取 Goal，确认 objective、goalId、status 和时间字段一致；
5. 清除后重启，确认 Goal 不会重新出现。

该测试不得复用第一套 Runtime 的 Map、Ref、Registry 或前端缓存。

Goal Loop 既有的跨 Runtime Run Start 验收继续按其独立提交和独立审查执行，
不能用 Goal UI 测试替代。

## 修改边界与提交拆分

建议按以下独立提交实施：

1. `docs`: 本设计文档与修订后的 Goal objective 文本；
2. `contracts/runtime`: 复用或补齐 thread goal 客户端调用和状态投影；
3. `web`: Composer 目标按钮、目标编辑态和顶部持续状态条；
4. `server`: Goal 状态持久化/通知接线和原生 Goal 上下文注入；
5. `docs`: Cursor/VS Code 未来接入待办和当前降级说明；
6. `tests`: 组件、协议、重启恢复和浏览器关键路径验证。

每个提交只包含一个主题，精确暂存，提交前审查完整 staged diff、路径边界、
`git diff --cached --check` 和对应聚焦测试。不得把当前工作区已有的 BYOK、
品牌资源、移动端或其他未提交改动混入。

## 完成条件

只有以下全部成立才能宣称本轮 Goal UI/原生能力完成：

1. Goal 可从 Composer 创建、持续显示、暂停、继续、清除并进入完成态；
2. 页面刷新、会话切换和服务重启后状态一致；
3. objective 确实进入后续请求上下文，清除后不再注入；
4. 服务端事实源、通知和客户端状态能收敛，不能靠前端假状态；
5. 没有 Cursor/VS Code 时原生 Goal/Squad 仍可运行；
6. 真实 SQLite 跨 Runtime 重建测试通过；
7. 目标测试、Server/Web typecheck、精确 lint/format、i18n scanner、
   `git diff --check` 和浏览器关键路径通过；
8. Cursor/VS Code 真实对接已明确记录为待办，不再阻塞当前完成条件；
9. 每笔提交可独立解释、验证和使用 `git revert <hash>` 回滚。
