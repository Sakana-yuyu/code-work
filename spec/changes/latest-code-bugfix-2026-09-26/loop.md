---
goal: 安全拉取最新代码，排查并修复有复现证据的明显 bug 和逻辑问题
status: done
max_rounds: 10
no_progress_fuse: 3
started: 2026-09-26
---

# Loop: latest-code-bugfix-2026-09-26

## Acceptance

- [x] A-1 安全同步 origin/main 并保留原有未跟踪文件。（verify: git pull --ff-only origin main 成功，记录 HEAD 与 origin/main，核对原有文件 SHA-256）
- [x] A-2 检查近期 Agent 执行、模型路由和时间线调用链，修复确认的明显问题。（verify: 记录每个问题的输入、根因和影响范围；新增针对性回归用例在原实现失败、修复后通过）
- [x] A-3 修复通过相关测试、受影响包类型检查和变更文件格式检查。（verify: 执行定向 vp test；按各包 package.json 执行类型检查，Server/Web 为 tsgo --noEmit，Mobile 为 tsc --noEmit；执行 vp fmt --check、git diff --check；禁止全仓检查。Mobile 额外 tsgo 的既存诊断另行报告，见 Round 7）
- [x] A-4 独立终审逐项验收并报告边界。（verify: 全新上下文 spec-verifier 复核 A-1 至 A-3 和修复 diff；没有未关闭的实际缺陷；报告未做的环境验证）

## Rounds

### Round 1

#### Plan

用户已确认上述范围与默认 10 轮预算。先安全同步远端并在近期发布的 Agent、模型路由、时间线修改中确定可复现的问题，形成下一轮的小范围修复输入。

#### Act

尚未修改产品代码。读取仓库规则、现有 loop 状态、技术栈及 Effect 文档；原有两个 loop 均为 done。仅使用研究 Agent 定位调用链，独立验收留到最后。原有未跟踪文件的 SHA-256 保存在系统临时目录 codework-bugfix-01a0dcac/preserved-files.json。

#### Verify

`git fetch origin` 和 `git pull --ff-only origin main` 均退出码 0，后者输出 Already up to date。HEAD 与 origin/main 均为 `50e71e8ed13827a4001c11c8e154d4372c33d366`。原有未跟踪文件 SHA-256 复核为 `preserved=15/15`，`git diff --check` 通过。基线 `.\node_modules\.bin\vp.cmd test run apps/server/src/composition/ToolBroker.test.ts apps/server/src/composition/ByokAgentLoop.test.ts` 为 2 文件 63 项通过；这些旧用例未证明新发现已修复。

实施前代码研究发现以下高置信线索，必须新增失败回归后再认定修复：

1. `ToolBroker.ts:519` 仅处理可见 snapshot，忽略 Manager 在首次 snapshot 后发出的 output/exited/error；8 秒后返回 started 旧快照。现有测试 stub 直接给终态快照，未覆盖真实协议。
2. `ByokAgentLoop.ts:775` 第四次相同命令被阻止后成功 return，`ByokAdapter.ts:1195` 与 `CompositionByokAgentDriver.ts:469` 因而发布 completed；应复用现有错误通路保留失败终态。
3. `apps/mobile/src/lib/threadActivity.ts:1463` 无条件只保留最后一条活动，会隐藏先前仍 inProgress 或 failure 的并发工具；`usage.md` 要求保留实时工具和失败详情。
4. 同文件 `shouldCollapseToolLifecycleEntries:565` 缺少 turnId 边界，无调用 ID 的相同工具开始事件可跨轮被合并。Web `session-logic.ts:1306` 已有可复用的边界判断。
5. `ByokModelDiscoveryService.ts` 的发现缓存指纹不包含 API Key 和自定义请求头；相同地址换账号可能仍使用旧账号模型目录。研究 Agent 的内存请求复现显示第二次没有发出新请求，尚待正式回归。
6. Web `ByokModelAdaptersSection.tsx` 的保存构造先保留旧目录配置，再被供应商模板覆盖；需用无目标变化、只改名称的输入验证目录配置不被重置。

#### Retrospect

同步没有新提交，因此后续修复以当前 1.0.27 最近改动为准。测试桩若跳过真实流的初始快照和增量事件顺序，会隐藏生产路径 bug。下一轮只修复 terminal.exec 的输出/退出/错误等待链路并覆盖超时与退订；随后依次处理 Loop 失败终态、模型目录缓存与保存、移动端工具活动。独立验收保留到所有修复自检完成后，真实客户端尚未授权，不声称做过浏览器或设备验收。

### Round 2

#### Plan

按第 1 轮 Retrospect，只修复 terminal.exec 从初始快照到增量输出、退出、错误的等待链路，覆盖无输出超时和取消退订；不修改重复命令保护、目录或客户端逻辑。

#### Act

检索并核对 ToolBroker 的所有终端 handler、TerminalManager.attachStream、合同 TerminalAttachStreamEvent 和客户端 terminalSession reducer。客户端 reducer 只保存显示缓冲、不保留退出码和 PID，不能直接复用为工具返回快照，因此在既有 awaitTerminalCommandOutput 内维护最新快照；未新增服务或公共抽象。

修改 `apps/server/src/composition/ToolBroker.ts`：处理初始/重启快照及 output、exited、cleared、activity 增量，保留输出、退出码、序列和最新元数据。error/closed 走现有工具失败通路。仍无输出时最多等 8 秒，返回最新快照而非启动旧快照。用 acquireRelease + scoped 保证成功、失败和取消时释放订阅。

修改 `apps/server/src/composition/ToolBroker.test.ts`：复用既有 Layer 和真实 handler，使用可控订阅回执与 TestClock 覆盖 output、exited、error、closed、timeout、cancelled 六种情况；不使用真实 sleep，不改原有未跟踪测试。回归同时验证即时事件无需等满 8 秒、非零退出码、最新快照与恰好一次退订。

#### Verify

先只新增测试运行 `.\node_modules\.bin\vp.cmd test run apps/server/src/composition/ToolBroker.test.ts -t 'terminal.exec 等待增量'`：旧实现 6 项失败，输出/退出返回空 running 旧快照，错误/关闭被误报 succeeded，超时元数据过期，取消边界未退订。完成修复后同命令 6 项通过。

最终 `.\node_modules\.bin\vp.cmd test run apps/server/src/composition/ToolBroker.test.ts apps/server/src/composition/ToolBroker.persistence.test.ts apps/server/src/composition/ByokAgentLoop.test.ts` 为 3 文件 76 项通过；另 `vp test run apps/server/src/terminal/Manager.test.ts -t 'attach'` 为 7 项通过、65 项未选。共 83 项相关检查通过。

在 `apps/server` 执行 `..\..\node_modules\.bin\tsgo.cmd --noEmit`，首次发现新增原生 Date 不符合 Effect 日期规则，改用与 Manager 相同的 DateTime 后重跑退出码 0。两个变更文件 `vp fmt --check` 与 `git diff --check` 通过。定向 `vp lint` 退出码 0，但列出原文件已有的未使用 import 与内联 Schema 编译警告；没有把警告描述为零。原有未跟踪文件再次校验 `preserved=15/15`。

本轮恢复服务端公共工具行为，Web/桌面/手机及调用该工具的 Agent 都经过同一 handler；未改 RPC 合同、provider 专有适配器或 UI。未启动浏览器或真实供应商服务。

#### Retrospect

输出流只在最初发送一次 snapshot，后续需要消费增量；订阅还必须在获取成功与取消交界处安全释放。测试用虚拟时钟验证 8 秒边界，用 Deferred 回执保证事件确实已订阅。A-2/A-3 尚不能整体勾选，其余五处线索仍待修复。下一轮只处理重复命令保护成功返回导致任务误报 completed：复用现有错误类型，补 Loop 和实际调用方终态回归，再做相关包检查。

### Round 3

#### Plan

按第 2 轮 Retrospect，修复重复终端命令保护触发后的错误终态，并验证主会话与组合 Agent 两条真实调用链；本轮不改模型目录或客户端逻辑。

#### Act

检索 runByokAgentLoop 的所有调用方：主会话 ByokAdapter 用 Effect.exit 判断失败；CompositionAgentService 将 Loop 错误映射为保留 code 的服务错误，再由 CompositionByokAgentDriver 发布 runtime.error 和 failed 终态。两条现有失败通路可直接复用，CompositionFailurePolicy 对此非瞬时错误默认要求手动处理，不自动重试。

只修改产品文件 `apps/server/src/composition/ByokAgentLoop.ts`：保留相同命令三次阈值、开始/失败工具回调，在第四次命令被阻止后立即返回现有 ByokAgentModelError，携带 repeated_terminal_command、中文说明和 retryable=false。移除延后成功返回的标记和不再到达的特殊工具消息分支，防止同一批后续副作用工具继续执行。

更新 `ByokAgentLoop.test.ts` 的既有保护测试，验证三次执行、失败回调、错误结果以及后续写入工具未执行。新增 `CompositionByokAgentDriver.test.ts` 集成用例，经过真实 CompositionAgentService 和 Loop；新增 `ByokAdapter.test.ts` 的 SSE HTTP 模拟用例，经过真实模型驱动与主会话适配器。两个调用方产品代码不需改动。

#### Verify

先只改测试执行 `vp test run apps/server/src/composition/ByokAgentLoop.test.ts apps/server/src/composition/CompositionByokAgentDriver.test.ts apps/server/src/provider/Layers/ByokAdapter.test.ts -t '重复命令保护'`：3 项全部失败。旧 Loop 执行了本应被阻止的后续写入（总调用 4 次），组合 Driver 只发 started/completed，主会话缺少 runtime.error。修复后同一命令 3 项全部通过，两端终态 state=failed，错误包含 repeated_terminal_command。

最终相关 `ByokAgentLoop.test.ts`、`CompositionAgentService.test.ts`、`CompositionByokAgentDriver.test.ts`、`ByokAdapter.test.ts`、`ToolBroker.test.ts` 共 5 文件 105 项通过。`apps/server` 的 `tsgo --noEmit` 退出码 0；4 个本轮文件的 `vp fmt --check`、`git diff --check` 均通过。定向 lint 退出码 0，修正了新增测试的 filter/at 建议后，只剩 ByokAdapter.test.ts 原有两处可选链警告。测试调整后单独复跑新增 Adapter 回归通过。

本轮没有增加框架、错误类或失败状态；不涉及其他 CLI provider 行为。未推送、发布或启动真实供应商及客户端。

#### Retrospect

保护停止必须从共享 Loop 直接失败退出；否则调用方把普通返回值当成任务完成，并且后续工具仍可能产生副作用。测试要经过最终事件出口，不能只检查工具结果里的 failed 字段。当前完成两类服务端修复，尚余目录缓存、目录编辑保存和两项手机端活动问题。下一轮只修复模型发现缓存的凭据与请求头隔离，新增换 Key/换头和新凭据失败不得复用旧目录的回归，随后再处理 Web 保存覆盖。

### Round 4

#### Plan

按第 3 轮 Retrospect，只修复模型发现缓存与 API Key、自定义请求头的绑定，覆盖普通缓存命中以及强制刷新失败的旧目录回退。

#### Act

核对 discover 的缓存读取与失败回退均使用同一 fingerprintFor；Web 与 Mobile 的发现按钮经同一 serverDiscoverByokModels RPC，均传 forceRefresh=true，仍会受到失败回退分支影响。草稿发现不使用该缓存。检索到 ByokBalanceService 已用 NodeCrypto SHA-256 处理包含凭据的指纹，直接复用同一模式，不新增依赖或缓存层。

修改 `apps/server/src/provider/byok/ByokModelDiscoveryService.ts`：将 apiKey 与 customHeaders 加入原有连接及目录字段指纹，并只存储 SHA-256 摘要，防止更换账号后命中或回退到旧账号目录。

修改相邻 `ByokModelDiscoveryService.test.ts`：复用现有 settings 和 HTTP 测试工具，交叉覆盖 API Key/请求头变化、刷新成功/失败四个场景，同时验证同一新凭据仍可缓存命中，公开结果不携带凭据和自定义头。

#### Verify

新增回归先在旧实现执行 `vp test run apps/server/src/provider/byok/ByokModelDiscoveryService.test.ts -t '隔离模型目录缓存'`，4 项均失败：普通查询没有第二次 HTTP 请求；强制刷新失败回显 first-model、cached、stale=true。

修复后 `vp test run apps/server/src/provider/byok/ByokModelDiscoveryService.test.ts apps/server/src/provider/byok/ModelCatalog.test.ts` 为 2 文件 26 项通过。四种新场景均发送新凭据请求，失败时返回 failed、空目录与 upstream_http；同凭据既有 stale 回退行为测试仍通过。`apps/server` 的 `tsgo --noEmit` 退出码 0；两个变更文件 `vp fmt --check`、`git diff --check` 通过；定向 lint 退出码 0，仅原文件已有的未使用 Option/error 和空对象展开警告。原有未跟踪文件 SHA-256 为 `preserved=15/15`。

无真实供应商请求，所有 HTTP 响应来自本地测试替身；不涉及支付或余额计算修改。两端 RPC 合同及页面未变。

#### Retrospect

forceRefresh 只绕过正常命中，不绕过失败时的 stale 目录回退，因此缓存指纹必须同时约束两个入口。当前已有三类服务端修复，目录保存和手机端两项问题尚未完成。下一轮只修复 Web 编辑适配器时模板覆盖已保存目录配置，覆盖同目标仅改名称与切换供应商后的目录重置边界。

### Round 5

#### Plan

按第 4 轮 Retrospect，只修复 Web 编辑适配器时供应商模板覆盖已保存目录配置的问题，验证同一目标的保留行为及目标变化后的重置边界。

#### Act

检索 handleSave、addSelectedDraftModels、applyRelayEdit 及 Mobile buildByokAdapter，并核对共享 canRetainByokAdapterCredentials。错误局限于 Web handleSave：已有目录先展开，模板默认值随后覆盖。新增模型没有既存目录，其他编辑路径没有相同覆盖顺序问题，因此无需修改。

产品代码仅调整 `apps/web/src/components/settings/ByokModelAdaptersSection.tsx` 的对象展开顺序：模板先提供默认值，同一供应商、协议和地址的已保存目录随后覆盖。继续使用原有目标判断，不新增抽象。空目录数组与 appendModelCatalogCandidates=false 均得到保留，切换目标不携带旧目录。

新增 `ByokModelAdaptersSection.save.test.tsx`，复用仓库 React hook harness 和元素遍历工具，通过实际编辑与保存回调捕获 onChange 对象。四项用例覆盖自定义目录、空目录、目标地址变化及无既存目录时的模板默认值；同时编辑分组名称，验证保存确实生效。

#### Verify

先在旧实现执行新增 save 测试：4 项中 2 项失败，已有目录和空目录均被模板覆盖，manual_only 变成 openai_models，false 变成 true；目标变化与模板默认值两项通过。修复后全部通过。

最终 `vp test run apps/web/src/components/settings/ByokModelAdaptersSection.save.test.tsx apps/web/src/components/settings/ByokModelAdaptersSection.test.ts packages/client-runtime/src/byok/credentialScope.test.ts apps/mobile/src/features/settings/SettingsByokRouteScreen.logic.test.ts` 为 4 文件 47 项通过；共享凭据边界测试还覆盖供应商及协议切换。首次测试命令含两个不存在的路径，仅实际运行 2 文件 38 项，纠正路径后按上述 4 文件结果验收，没有把忽略路径当成已验证。

`apps/web` 的 `tsgo --noEmit` 首次发现新增测试样本缺少必需的 balanceAccessToken 和 customHeaders；补齐空字符串后检查通过。两个变更文件的 `vp fmt --check`、`vp lint` 与 `git diff --check` 均退出码 0，无本轮 lint 警告。原有未跟踪文件 SHA-256 为 `preserved=15/15`。

Web 与桌面共用此组件；Mobile 相关逻辑测试通过。组件回调测试不等于真实客户端验收，本轮未启动浏览器、设备、服务器或真实供应商请求。撤销本轮两个文件的差异即可回退，无数据迁移。

#### Retrospect

目录配置需要区分模板默认值与用户已有值；只需调整既有对象的合并优先级，不需要增加状态或公共函数。当前四类修复已完成自检，A-2/A-3 仍待手机端问题处理后整体验收。下一轮只处理手机端工具活动生命周期：折叠时保留仍运行及失败活动，并阻止无调用 ID 的工具跨 turn 合并；先建立失败回归，再运行手机端定向测试和包级检查。最终独立审计继续保留到修复整合结束。

### Round 6

#### Plan

按第 5 轮 Retrospect，本轮只处理手机端工具活动生命周期：运行中或失败的工具保持可见，无调用 ID 的同名工具不能跨回合合并。复用现有活动派生和折叠路径，不修改原生组件或引入新状态。

#### Act

核对完整调用链：use-thread-composer-state 构造 buildThreadFeed，ThreadFeed 调 deriveThreadFeedPresentation，再由 appendPresentedFeedEntry 生成虚拟列表行与展开按钮。现有折叠直接 slice 只保留末条，丢失状态语义；无调用 ID 的 collapseKey 只含工具类型、名称和详情，shouldCollapseToolLifecycleEntries 未检查 turnId。Web 相应函数已有回合边界判断，直接复用该规则。

仅修改 `apps/mobile/src/lib/threadActivity.ts`：生命周期合并增加 turnId 相等条件；原折叠循环按顺序保留 inProgress、failure 和最新活动，仅把其余旧记录计入隐藏列表。没有隐藏记录时不生成空展开按钮。保持单次线性遍历、现有展开方式及详情惰性计算，不新增依赖。

相邻 `threadActivity.test.ts` 新增四项参数化回归：第二回合分别出现同名 started/completed 时保留两个回合记录；有/无旧成功记录时，完整 buildThreadFeed → deriveThreadFeedPresentation 路径保留运行项、失败项和失败详情，隐藏计数正确，展开后顺序与原记录一致且可再次折叠。

#### Verify

旧实现执行 `vp test run apps/mobile/src/lib/threadActivity.test.ts -t '无调用 ID|折叠保留运行'`：4 项均失败。两个回合只剩后一个活动；运行与失败活动同时被折叠，只剩 latest 成功项。

修复后 `vp test run apps/mobile/src/lib/threadActivity.test.ts apps/web/src/session-logic.test.ts` 为 2 文件 128 项通过，包括四项新回归、同回合生命周期合并、工具完成后更新、历史展开及已有 5000 条记录惰性详情检查。两个本轮文件的 `vp fmt --check`、`vp lint` 以及 `git diff --check` 均通过；原有未跟踪文件再次校验 `preserved=15/15`。

Mobile 包执行 `tsgo --noEmit` 失败，诊断集中于导航调用参数被推导为 never，没有本轮两个文件的诊断。核对 `apps/mobile/package.json` 后，使用该包正式 typecheck 所声明的 `tsc --noEmit` 检查，退出码 0。暂不把 tsgo 失败归因为已证明的基线问题，也不据 tsc 通过勾选 A-3；下一轮核实编译器差异与总体检查记录。

第 1 轮六条线索均已有原实现失败、修复后通过的回归证据，勾选 A-2 作为待独立审计的自检声明。此处恢复所有 provider 共享的手机端活动派生行为，Web 对应规则回归通过；不涉及连接协议或 RPC 变更。既有 docs/user/usage.md 的运行和失败活动可见约定与修复一致，无需新增文档。未启动浏览器、模拟器、设备或真实供应商服务。

#### Retrospect

活动聚合不能把名称相同当成跨回合身份，也不能按位置隐藏仍需处理的运行和失败状态。本轮两类问题已完成修复，但包级检查暴露 tsgo 与 Mobile 正式 tsc 命令的结果差异。下一轮以整体验收准备为唯一增量：核实该差异是否在未修改的 Mobile 基线存在，按仓库实际编译器记录可重复结果，完成累计差异和验收证据核对，再进入独立最终审计；不为消除预览编译器诊断盲改产品导航。

### Round 7

#### Plan

按第 6 轮 Retrospect，本轮唯一增量是整体验收准备：核实 Mobile 的编译器差异，执行累计修复的相关检查，核对验收范围。没有新增产品代码，也没有派发中途审计 Agent。

#### Act

在系统临时目录 `codework-bugfix-01a0dcac/mobile-head-50e71e8` 用 git archive 导出 HEAD 的完整 apps/mobile，依赖目录及未修改的 packages/scripts 通过 junction 只用于解析，不连接任何运行数据。基线 threadActivity.ts 的 Git blob 与 HEAD 均为 `45ccc940ce6c3cbdef970b3db80925ac4b1a88ff`，没有把当前修复复制进基线。

核对三个包的 package.json：Server/Web 的正式 typecheck 是 tsgo，Mobile 明确是 tsc。A-3 的用户目标仍是“受影响包类型检查通过”；将原来误写为所有包统一 tsgo 的执行细节纠正为各包正式命令，不改类型配置、不跳过文件、不压制诊断。额外 tsgo 的失败及基线对比完整保留，不能将其称为通过。

#### Verify

基线 Mobile 初次运行因临时快照未包含 scripts 解析路径，多出两个缺失模块诊断；补齐原仓库 scripts 解析链接后重跑得到与当前工作区完全相同的 69 条导航类型诊断。`mobile-head-tsgo.log` 与 `mobile-current-tsgo.log` 的 SHA-256 均为 `5F5E5BA50068E98EFDA21994E416FB5AF447AFFC5B2E1AC75DD4CB87E7680529`，两个 tsgo 命令均退出码 1。现在已证明该差异在未修改 Mobile 基线存在，本任务没有新增 tsgo 诊断；没有修改导航实现或编译器配置。

最终累计执行 `vp test run apps/server/src/composition/ToolBroker.test.ts apps/server/src/composition/ToolBroker.persistence.test.ts apps/server/src/composition/ByokAgentLoop.test.ts apps/server/src/composition/CompositionAgentService.test.ts apps/server/src/composition/CompositionByokAgentDriver.test.ts apps/server/src/provider/Layers/ByokAdapter.test.ts apps/server/src/provider/byok/ByokModelDiscoveryService.test.ts apps/server/src/provider/byok/ModelCatalog.test.ts apps/web/src/components/settings/ByokModelAdaptersSection.save.test.tsx apps/web/src/components/settings/ByokModelAdaptersSection.test.ts packages/client-runtime/src/byok/credentialScope.test.ts apps/mobile/src/features/settings/SettingsByokRouteScreen.logic.test.ts apps/mobile/src/lib/threadActivity.test.ts apps/web/src/session-logic.test.ts`：14 文件 313 项通过。

三包正式编译器分别执行 Server `tsgo --noEmit`、Web `tsgo --noEmit`、Mobile `tsc --noEmit`，均退出码 0。12 个产品与测试变更文件的 `vp fmt --check` 全部通过；定向 lint 退出码 0，仍报告原有 ToolBroker Schema 编译/未使用 import、ByokAdapter 旧测试可选链和发现服务旧警告，没有声称零警告。`git diff --check` 通过。HEAD 与 origin/main 仍为 `50e71e8ed13827a4001c11c8e154d4372c33d366`，原有文件校验 `preserved=15/15`。

累计产品差异只涉及 ToolBroker、ByokAgentLoop、ByokModelDiscoveryService、ByokModelAdaptersSection 和 threadActivity 五处，另有七个回归测试文件；未新增依赖、状态协议、数据库结构、配置屏蔽或运行服务。A-3 根据正式编译器与相关测试证据勾选，A-4 继续未勾，不能提前声称独立审计已完成。

#### Retrospect

编译器名称不能脱离各包配置机械统一：Mobile 正式 tsc 通过，额外预览 tsgo 有可重复的既存诊断。六项已确认问题和累计验证现在具备审计材料。下一步进入最终独立验收阶段，派发全新上下文 spec-verifier 审查 A-1 至 A-3、全部修复及原有文件保护，并审查本轮编译器选择的理由；完成独立报告后才勾 A-4 和设置 done。A-4 本身是最终审计，不能为触发机械“全勾”提前造出审计通过记录；下一轮作为最终验收阶段执行该项。若有实质缺陷，保持 running 并在剩余轮次修复。

### Round 8

#### Plan

按第 7 轮 Retrospect，进入唯一的最终独立验收阶段，完成 A-4。A-1 至 A-3 均已有自检证据；A-4 自身要求审计，因此在实际审计前保持未勾，不为触发驱动器全勾条件编造记录。本阶段不再实施新功能。

#### Act

派发全新上下文 spec-verifier `final_spec_audit`，不继承实现会话，要求只读复核全部 12 文件、六项问题、每项 verify、章程与保留文件，只允许写本变更 `verify.md`。审计者自行运行检查、导出旧产品源码配合当前测试重现红灯，并核对额外 tsgo 的完整诊断与基线文件。主代理未改产品源码，额外复查远端引用、文件哈希、新增 UTF-8 文件与未完成标记。

#### Verify

独立报告 `verify.md` 结论为 pass、findings=[]，A-1 至 A-4 逐项通过。审计者重新执行 14 文件 313 项回归，另执行真实 TerminalManager attach 7 项；Server/Web 正式 tsgo、Mobile 正式 tsc 均通过，12 文件格式和 diff 检查通过。旧 HEAD 产品源码快照配合当前测试得到 19 项目标行为断言失败、2 项既有边界通过，独立确认六类修复有效。

审计者逐文件核对 Mobile 基线 788 个 Git blob，0 差异；当前/基线额外 tsgo 均为 69 条既存诊断，完整日志哈希一致。当前/旧源码定向 lint 均退出 0、各 41 条警告，去除行列号后文本一致，0 新警告。ast-grep 未安装，按章程规定改为人工差异和失败处理分支审查；该项明确不算 AST 扫描通过，未安装工具。未发现新增静默失败、隐藏回退、重复抽象或未授权范围扩展。

同步复核中，HEAD、origin/main、远端 main 仍均为 `50e71e8ed13827a4001c11c8e154d4372c33d366`；独立临时 Git 副本执行 pull --ff-only 也为 Already up to date，原工作区没有被再次 pull 改写。原有文件 15/15、交付文件 12/12 哈希不变，主代理读完报告后再次复核 reviewedFileDrift=0、git diff --check 通过。新增测试无 BOM，新增差异 TODO/NotImplemented/DEVLOG 计数为 0。

完整独立命令、红灯输出、文件/行号、章程结论和环境边界见 verify.md；审计原始证据目录为 `C:/Users/Administrator/AppData/Local/Temp/codework-final-audit-20260926-161203/`。未执行真实浏览器、Electron、设备、供应商、PTY 端到端或远程连接验证，也未跑全仓检查或构建安装包；这些用户明确排除的环境验证没有被算作通过。未提交、推送、发布或创建 PR，原有工作完整保留。

#### Retrospect

独立审计重现了旧代码的目标失败，并验证修复、正式类型检查和保护约束，无需追加修复轮次。A-4 现在依据真实审计报告勾选，四项验收均完成，状态设为 done。本次目标在 8/10 轮结束；不扩写为全仓无缺陷或真实客户端验收完成。用户未要求归档或发布，保留本地差异、loop.md 和 verify.md 供审阅，不执行归档、推送或发布。

## Lessons

### L-1 范围与状态保护（source: Round 1）

用户已授权本次同步和修复，不包含推送、发布和浏览器操作。已有未跟踪测试、脚本与旧 loop 全部保持原样；本次显式 spec-loop 所需 ledger 留为未跟踪工作记录，不进入提交。

### L-2 终端流验证（source: Round 1）

TerminalManager.attachStream 的真实协议是一次初始 snapshot 加后续增量事件；回归需按该协议驱动，不能仅以终态 snapshot stub 代表命令执行。PowerShell 的 rg 使用 --glob，不传路径中的星号。

### L-3 订阅生命周期与 Effect 日期（source: Round 2）

订阅获取和释放使用 acquireRelease + scoped，避免在取得退订函数但尚未进入 ensuring 的交界处泄漏。Effect 代码里的时间戳使用 DateTime.now/formatIso；定向单元测试通过仍须跑受影响包 tsgo，才能发现此类项目规则诊断。

### L-4 工具失败与任务失败（source: Round 3）

工具观察中的 failed 不等于任务终态失败。中止整个执行链的保护必须返回共享 Loop 错误，让 ByokAdapter 和 CompositionAgentService/Driver 现有错误分支发布最终 failed；立即退出也防止同批后续工具执行。

### L-5 目录缓存凭据隔离（source: Round 4）

缓存隔离既作用于 TTL 命中，也作用于 forceRefresh 的失败回退。凭据与自定义请求头应进入内部摘要，不能仅凭实例、适配器 ID 和 URL 判断目录仍属于同一账号；原始密钥不应成为额外缓存字段。

### L-6 保存优先级与测试范围（source: Round 5）

模板提供默认值，目标未变时以已保存配置为准；空数组和 false 也是有效用户配置。定向测试会忽略不存在的过滤路径，必须核对实际执行文件数。组件真实回调可用现有 harness 验证提交对象，但不能据此声称通过真实浏览器交互验收。

### L-7 手机活动边界与正式检查命令（source: Round 6）

先在同回合内合并生命周期，再按状态决定历史折叠；运行和失败记录保持可见，隐藏计数只包含实际可隐藏记录。包级类型检查应先核对 package.json：Mobile 声明 tsc，Server/Web 使用 tsgo；不同编译器结果必须分别记录，不能把一种通过等同于另一种通过。

### L-8 基线诊断与验收递归（source: Round 7）

验证工具差异可通过未修改源码快照和相同依赖对比完整诊断，不能只看报错位置就认定与改动无关。若验收项本身要求独立终审，应在最终审计阶段实际完成后勾选，不能为了让驱动器看到全勾提前声明通过。

### L-9 独立审计的旧实现对照（source: Round 8）

在临时快照中保留旧产品源码、仅配入当前回归，可在不倒换工作区文件的前提下独立证明原缺陷。正式编译器、额外工具、人工后备审查和真实环境验证应分开报告；相同警告的基线对照不能写成零警告。
