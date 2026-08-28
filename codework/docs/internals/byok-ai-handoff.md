# BYOK / Composition 交接（给下一位 AI）

接手前先读本文，再读 [composition-runtime-progress.md](./composition-runtime-progress.md) 与 [byok-multica-migration-matrix.md](./byok-multica-migration-matrix.md)。进度文档记「已完成什么」；迁移矩阵记「架构边界与取舍」；本文记「你现在该做什么、绝对不要推翻哪些判断、工作区里有哪些陷阱」。

接收方默认 **零上下文**。不要凭感觉重做已闭环的切片。

## Task

继续 `tcode` 分支上的 BYOK / Composition 收口。优先做**代码能独立完成**的缺口；不要把「需要真实 API key / 真实 Cursor / 真实 Multica daemon」的工作伪装成已完成。

当前最高价值、可编码的下一刀（按顺序，做完再开下一刀）：

1. **委派取消/重试接到 composition cancel**（控制中心委派行目前只读；取消仍走调度器 RPC）。
2. **DelegationScheduler 单一状态源**（台账已是投影，内存调度器仍是 `submit`/`list` 权威；投影失败被降级为不中断委派）。
3. **凭据版本历史 + `rollbackCredential`**（多账号回滚的前置合同；Code Work 没有独立 Account Profile 存储）。
4. 不要主动开：Request Lab、权重路由/failover、真实 IDE Adapter、真实 Multica daemon。除非用户点名。

BYOK 真实 API E2E 是主线**唯一非代码阻塞项**，需要用户提供真实凭据后才能做。没有 key 就不要假装在做 E2E。

## Context

仓库：`E:\MyProject\code-work`，应用在子目录 `codework/`（pnpm + Effect TS v4 + vite-plus）。分支：`tcode`。上游 `t3code` 以 subtree 合入 `codework/`，最近一次是 v0.0.35（合并提交 `05d694cfa`）。本地品牌是 `@codework/`，不是 `@t3tools/`。

上一会话完成了两批 BYOK 缺口：

| 提交 | 内容 |
| --- | --- |
| `cfb79999e` | 余额看板、Supplier 启停/凭据轮换、resume 自动重派 RPC+Web 按钮、delegation 台账投影、Mobile 控制中心/注册表面板、上游 20 处 i18n |
| `02d01f440` | Mobile 恢复重派按钮；控制中心消费 `byok-delegation:*`；进程重启后 in-flight 委派收口为 `byok_delegation_interrupted` |
| `c1d029843` | 本交接文档 |
| `6d6a6f65` `feat(auth): 兼容读取旧 t3_session cookie 并静默迁移` | 读 `t3_session_*`、写 `codework_session_*`、过期旧 cookie；升级后不掉线 |

相对 `origin/tcode` 领先约 107+ 提交，**尚未 push**。不要擅自 push。

## Current state

### 已闭环（不要重做）

- Composition Task/Run/Event/Lease、Goal Loop（完成标记、预算、pivot、验证子代理、台账、跨重启 supervisor、自动重派/放弃）。
- BYOK 模型循环 + ToolBroker；checkpoint 落盘；`resume` = 恢复已落盘部分输出，**不**续跑中断的模型流。
- `settleAndRedispatchRecoveredByokRun` + RPC `server.controlCenterByokResumeRedispatch` + Web/Mobile「Recover & redispatch」。
- 控制中心投影字段 `byokResume`（checkpoint 链校验结果）与纯函数 `isByokResumeRedispatchable`（在 `@codework/contracts`）。
- BYOK 余额/健康看板 `serverByokBalanceDashboard`（`empty` ≠ `error`，不吞查询失败）。
- Supplier 启停 + 凭据轮换（结果/错误 **零回显** 凭据值）。
- Delegation 台账投影 `byok-delegation:*`（prompt 只落 sha256，原文不进台账）。
- 控制中心展示委派行：可选字段 `byokDelegation`，独立徽标，**不套 Goal Loop 五态**。
- 重启收口：`scanByokDelegationRun` / `recoverInterruptedByokDelegations`，boot + `ByokDelegationService.make` 首次调用。
- Mobile：`SettingsControlCenter`、`SettingsSupplierRegistry`；Desktop 走共享 Web `/settings/integrations`。
- server 包 typecheck 已从约 520 错清到 0；`server.test.ts` 路由层 133 通过（含本轮新 handler）。
- `node scripts/check-ui-i18n.mjs` 应对 web/mobile/desktop 全绿。
- 会话 cookie 品牌改名兼容：写入 `codework_session_*`，读取同时接受 `t3_session_*`（同 scope），HTTP 层把旧 cookie 静默迁到新名并 expire 旧名。`getSessionState` 与 environment-authenticated 请求都会迁移。auth 测试 28 通过。

### 仍缺（代码）

见进度文档 §1 / §2 / §6。摘要：

- Delegation **双源**：调度器内存仍是 `submit`/`list` 权威；未入队拒绝（disabled/未配置）不落台账。
- 委派行只读；取消/重试未接 `serverCancelCompositionTask`。
- 凭据无版本历史，无法账号级 rollback。
- 模型分组、权重路由、自动匹配、failover：只有底层零件。
- Request Lab / 请求镜像 / 脱敏回放：未做。
- Provider 原生 Session/Turn 的真实 capability grant 闭环：未做。

### 仍缺（环境，本次不要假装完成）

- 真实 OpenAI/Anthropic/Gemini 凭据 E2E。
- 真实 Cursor/VS Code Adapter。
- 真实 Multica daemon 与 `fetchOutput` 生产实现。

### 工作区陷阱

接手时先 `git status`。cookie 兼容已提交，auth 目录不应再是脏的。若仍有未提交文件，先问用户，不要和委派切片混提交。

**不要去修的既有噪音：**

- Mobile typecheck 约 17 处：用户并行的 `T3ComposerEditor` / `CodeworkComposerEditor` 改名级联。不要改那些文件。
- `bootService.test.ts` Windows EPERM fsync。
- `ServerSecretStore.test.ts` Windows chmod。
- `build-desktop-artifact.test.ts` 若干 Windows 失败。
- `CompositionMcpRuntimeAdapter.e2e.test.ts` stdio E2E。
- 不要 `pnpm install`：国内镜像缺 `@distilled.cloud/aws@0.30.2`，锁文件已齐。

**进度文档已知过时句：** §「下一最小实施顺序」第 6 条仍把「委派台账消费端 UI」写在剩余里。代码与 §6「已清偿」已做完。改进度文档时顺手划掉，不要据此重做 UI。

## Decisions（必须遵守，不要推翻）

1. **`byok_resume_interrupted` 不能单独当按钮门槛。** 该 failureCode 只由结算函数写入；带此码的 Run 必有结算行，再点只会 `already_settled`。门槛必须用 `isByokResumeRedispatchable`：有最新 Run、排除 `redispatchSettled`，然后接受该 failureCode **或** `byokResume.recoverable`。Web/Mobile 必须共用 contracts 里那一个谓词。
2. **`compositionTaskError` 不能映射 BYOK resume 失败。** 它按 `_tag` 取码，会把九种失败塌成两种。用 `compositionByokResumeError`，解包 `code`。
3. **resume 不续跑模型流。** 只恢复落盘正文 + 可选重派新 Run。结果 RPC 只回段数/字节数，不回恢复正文。投影也不进正文。
4. **委派 prompt/输出永不进台账或控制中心投影。** 只有 `sha256:` 摘要、状态、错误码、字符数。
5. **委派行不要套 Goal Loop 五态扫描。** 五态只扫 `goalloop:*`。用可选 `byokDelegation` 区分，不要按 `projectId` 从任务列表里滤掉委派。
6. **余额 `empty` 与 `error` 严格区分。** `empty` = 查询成功且余额耗尽；`error` 保留原始错误码。不要把失败显示成 0 余额。
7. **凭据零回显。** RPC 结果与错误 detail 只含实例/适配器/字段名。写入新密钥必须清 `*Redacted` 标志。
8. **taskId 用 randomUUID。** 调度器 `delegation-N` 跨重启会复用，不能当台账主键。`runtimeTaskId` 才挂调度器 ID。
9. **迟到低阶状态不回退已推进的 Task/Run。** 只补事件行。
10. **Provider Instance ≠ Cursor 账户。** 账号级回滚要先做凭据版本历史，不要假装改 enabled 就是多账号。
11. **上游合并策略：** 保留本地 `@codework` 品牌与 i18n，采纳上游功能。迁移号 042/043 已被本地占用，上游那两支已重编为 054/055。不要改回 042。
12. **真实 IDE / 真实 Multica = 后期。** 当前阶段只对接 BYOK Driver。
13. **会话 cookie 写新名、读旧名。** 生产写入 `codework_session_*`；读取接受同 scope 的 `t3_session_*`；认证成功后 Set-Cookie 新名并 expire 旧名。不要改回只认旧名，也不要去掉兼容读取。

## What was tried

- 用 `latestRun.failureCode === "byok_resume_interrupted"` 做恢复按钮门槛 → 按钮恒失败。已改为投影 `byokResume`。
- 用共用 `compositionTaskError` 映射 resume RPC → 九码塌成两码。已加专用 mapper。
- 控制中心原先只扫 `goalloop:*`，看不到 BYOK checkpoint 链 → 加了 `byokResume` 字段。
- 用调度器计数器当 taskId → 跨重启碰撞。已改 UUID。
- `pnpm install --lockfile-only` 走 npmmirror → 缺 `@distilled.cloud/aws@0.30.2`。锁文件请用官方 `https://registry.npmjs.org/`。
- 并行改 `apps/web/src/i18n/messages.ts` 曾 `ftruncate`。对该文件：**最后改、先 re-read、锚定 StrReplace、禁止整文件 Write**。

## Relevant files

| 路径 | 为什么重要 |
| --- | --- |
| `docs/internals/composition-runtime-progress.md` | 进度与「仍缺」；做完节点必须更新 |
| `docs/internals/byok-multica-migration-matrix.md` | 迁移边界；Provider Instance ≠ Account |
| `packages/contracts/src/composition.ts` | `byokResume`、`byokDelegation`、`isByokResumeRedispatchable`、resume RPC schema |
| `packages/contracts/src/byokBalance.ts` | 余额看板合同 |
| `packages/contracts/src/supplierAdmin.ts` | 启停/凭据轮换合同 |
| `packages/contracts/src/rpc.ts` | WS 方法注册 |
| `packages/client-runtime/src/state/server.ts` | 查询/命令原子（singleFlight） |
| `apps/server/src/ws.ts` | handler；改前确认服务依赖（如 `CompositionTaskInputStore`） |
| `apps/server/src/auth/RpcAuthorization.ts` | ReadScope / OperateScope |
| `apps/server/src/auth/utils.ts` / `http.ts` | cookie 名解析、legacy 读取、静默迁移 |
| `apps/server/src/composition/CompositionByokResumeRedispatch.ts` | resume 结算+重派 |
| `apps/server/src/composition/CompositionByokDelegationProjection.ts` | 委派台账投影 |
| `apps/server/src/composition/CompositionByokDelegationSupervisor.ts` | 重启收口 |
| `apps/server/src/composition/CompositionControlCenterProjection.ts` | 控制中心只读聚合 |
| `apps/server/src/composition/CompositionTaskRuntimeProjectionService.ts` | boot 扫描入口 |
| `apps/server/src/provider/byok/ByokDelegationService.ts` | 调度器 + 投影注入；内存仍是 list 权威 |
| `apps/server/src/provider/byok/ByokBalanceDashboardCore.ts` | 余额聚合 |
| `apps/server/src/provider/SupplierAdminCore.ts` | 启停/凭据纯函数 |
| `apps/web/src/components/settings/CompositionControlCenterPanel.tsx` | Web 控制中心 |
| `apps/web/src/components/settings/ByokBalanceDashboardPanel.tsx` | 余额看板 |
| `apps/web/src/components/settings/SupplierRegistryPanel.tsx` | Supplier 操作面 |
| `apps/mobile/src/features/settings/SettingsControlCenterRouteScreen*` | Mobile 控制中心 + `*.logic.ts` 纯函数 |
| `apps/mobile/src/features/settings/SettingsSupplierRegistryRouteScreen*` | Mobile 注册表 |
| `apps/web/src/i18n/messages.ts` 与 `apps/mobile/src/i18n/messages.ts` | 双语；改 UI 文案必须走 `t()` |

对照实现时只读 `E:\MyProject\cursor-byok`，不要改那个仓库。

## Constraints

- 不要 `pnpm install`。不要 push。不要 `git config`。不要 `--no-verify`。
- Effect：`Clock.currentTimeMillis` 不用 `Date.now()`；不用 `node:path`，用 `effect/Path`；`exactOptionalPropertyTypes` → 可选字段条件展开；`Context.Service` key 用 `codework/` 前缀。
- 改 UI 文案：`t()` + `en`/`zh-CN` 同步 + `node scripts/check-ui-i18n.mjs`。
- 新 RPC 必须四层：contracts schema → `rpc.ts` → `ws.ts` handler → `RpcAuthorization` → client-runtime 原子 → UI。少一层就是没做完。
- 验证用针对性 `vp test run <files>` 与触及包 `typecheck`。不要全仓 `vp check` / 全量 test，除非用户要求。
- Windows 提交不要依赖 bash HEREDOC；用 `git commit -m "..." -m "..."`。
- 提交前 `git diff --cached --name-only` 确认没有 `.t3/`、没有 secrets。
- 用户并行 ComposerEditor 改名：碰了会和别人的工作树打架。

## Acceptance criteria（下一刀通用）

- [ ] 进度文档对应「仍缺」划掉或改写成精确剩余，并附测试证据。
- [ ] `pnpm --filter codework typecheck` 与 `@codework/web` / `@codework/contracts` / `@codework/client-runtime` 为 0 error。
- [ ] mobile typecheck 不新增（允许维持 ComposerEditor 那 17 处）。
- [ ] 新行为有聚焦测试；敏感路径有「正文/密钥不进投影/日志」断言。
- [ ] i18n 门禁通过。
- [ ] 没有把 fixture / fake transport 写成 L4 真实产品 E2E。

## 建议的第一刀（委派操作面）

控制中心委派行接到取消（复用 `serverCancelCompositionTask` 或显式映射到调度器 cancel，但台账必须落到 `cancelled`）。不要给委派行挂 Goal Loop 的 redispatch/abandon。重试若要做：新 Run + 新 UUID task，不要复活已 `byok_delegation_interrupted` 的 Run。Cookie 兼容已提交，不要重做。

## 仓库惯例（短）

工作目录：`codework/`。包过滤：`pnpm --filter codework` 是 server；web 是 `@codework/web`。测试：`pnpm --filter codework exec vp test run src/...`。i18n：`node scripts/check-ui-i18n.mjs`。

## 不要做的事

- 不要重做余额看板、Supplier 凭据表单、resume 重派、Mobile 控制中心复用、委派只读展示、重启收口。
- 不要把 Goal Loop supervisor 的 `goal_loop_interrupted` 语义套到 BYOK resume 或 delegation 上；三者 failureCode 不同，结算前缀不同。
- 不要在本仓库改已安装的 Cursor.app / `.cursor-app-formatted`。
- 不要把百分比完成度写进进度文档。
