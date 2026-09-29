---
goal: 统一多 Agent 输出并优化流式界面、工具调用、号池、网关、多供应商选择与余额查询
status: done
max_rounds: 24
no_progress_fuse: 3
started: 2026-09-25
---

# Loop: unified-agent-provider-experience

## Acceptance

- [x] A-1 现有 Codex、Claude、Cursor、Grok、OpenCode 及已启用 Agent 的正文和工具事件进入共用时间线，保留实时状态和失败详情。（verify: 定向适配器到时间线集成测试覆盖各运行器及工具开始、完成、失败）
- [x] A-2 长任务中的流式正文和工具调用保持顺畅，历史可折叠且实时内容可见。（verify: 运行长事件流的可重复性能基准并记录数据；经授权后在真实客户端观察关键路径）
- [x] A-3 本地号池与共享网关在多账号、失效账号、来源切换和模型路由下行为明确且安全。（verify: 运行相关服务端定向测试，覆盖选择、鉴权、失败和切换）
- [x] A-4 网页、桌面和手机端能按各自支持能力选择多供应商渠道，保存配置后模型来源与实际路由一致。（verify: Web、Mobile 定向组件或逻辑测试及服务端路由测试；桌面通过共享 Web 路径验证）
- [x] A-5 对已支持供应商按其真实接口分别查询余额或配额，并清楚区分零余额、不支持和查询失败；不泄露密钥。（verify: 各支持档案的 HTTP 模拟测试、合同和界面状态测试）
- [x] A-6 对照 CC Switch 与同类产品的公开实现，把经过证据核实的产品行为和限制写入相应文档。（verify: 文档列出来源、访问日期、采用理由、现有实现与差距，且与定向测试结果一致）

## Rounds

### Round 1

#### Plan

先核对并验证当前工作区已存在的 Agent 循环和时间线改动，保留用户工作；明确它们对 A-1、A-2 的实际贡献和剩余缺口，再选择最小的连贯修复。

#### Act

核对未提交的 `ByokAgentLoop`、`ToolBroker` 与 `MessagesTimeline` 改动，保持其余用户文件不动。修复 `apps/server/src/composition/ToolBroker.ts` 的 Deferred 完成调用：终端首段输出到达时以 `Deferred.succeed` 传入快照值，消除原写法的类型错误。确认终端管理器的 `attachStream` 会先交付当前快照，再交付后续事件，短命令不会因先完成而漏掉输出。

#### Verify

`apps/server`: `vp test run src/composition/ByokAgentLoop.test.ts src/composition/ToolBroker.test.ts`，59 项通过；`tsgo --noEmit -p tsconfig.json` 通过（修改前在 `ToolBroker.ts:522` 报 Effect/Exit 类型不匹配）。`apps/web`: 时间线两组定向测试 100 项通过，`tsgo --noEmit -p tsconfig.json` 通过。`node scripts/check-ui-i18n.mjs` 对 Web、Mobile、Desktop 通过；`git diff --check` 通过。此轮未做真实浏览器观察，因此 A-1、A-2 仍未勾选。

#### Retrospect

现有折叠和重复命令抑制已有单元测试，但一次编译错误仍能绕过这些测试；后续每轮同时跑受影响包的类型检查。下一轮量化长事件流在时间线中的派生与渲染成本，针对实测瓶颈做一个可回滚的性能改动，并保留失败、正文和实时工具的可见性。

### Round 2

#### Plan

按上一轮 Retrospect 量化长事件流的时间线派生和稳定行比较成本；先查是否存在足够大的瓶颈，再决定是否改算法，避免为无证据的卡顿引入新复杂度。

#### Act

新增 `apps/web/src/components/chat/MessagesTimeline.performance.test.ts`，生成 501、2001、8001 条交错的推理与工具事件，验证折叠、展开、实时工具保留和稳定行，并提供 `TIMELINE_BENCH=1` 的可重复计时入口。浏览器验证按仓库 `AGENTS.md` 请求用户同意，尚未进行。测量未发现派生计算需要立即改动，因此本轮未修改算法。

#### Verify

在 `apps/web` 运行 `TIMELINE_BENCH=1 vp test run src/components/chat/MessagesTimeline.performance.test.ts --project unit --reporter verbose`：501 条折叠/展开中位数 0.51/0.67 ms；2001 条 1.97/1.52 ms；8001 条 5.24/6.72 ms，原日志标作 p90 的数字分别为 0.95/0.84、2.38/1.98、6.01/7.94 ms。第 20 轮复核发现这组 10 次采样取的是最大值，不能作为 p90；保留原日志值供追溯。折叠 8001 条保留 3 行，展开为 8002 行。时间线三组定向测试 101 项通过；Web `tsgo --noEmit -p tsconfig.json` 通过；新增文件格式检查通过。首次类型检查发现可选属性传 `undefined` 与 exactOptionalPropertyTypes 冲突，改成条件展开后通过。此为 Node 侧派生性能，不等于真实浏览器帧耗时，A-2 仍未勾选。

#### Retrospect

当前 8001 条事件的纯派生和稳定比较在本机 p90 不到 8 ms；尚无证据支持重写时间线算法。下一轮核查各 Agent 的原生事件到共用时间线的映射，补最薄弱的适配器集成验证或修复遗漏。浏览器许可到达后再测真实渲染与滚动。

### Round 3

#### Plan

按上一轮计划检查 Agent 原生事件到共用时间线的路径，优先修复会让整个运行期间没有实时正文和工具进度的适配器。

#### Act

发现 `AntigravityAdapter.ts` 原先等 `agy` 进程结束才解析完整 stdout；且递归提取 `result.response` 会把已经流出的正文再次追加。按官方 `stream-json` 结构改为逐行消费 `step_update`：`agent_response.text_delta` 即时发 `content.delta`，`tool` 的 `ACTIVE` / `DONE` 发同一 `itemId` 的 `item.updated` / `item.completed`，`tool_info.error` 标为失败。`result.response` 仅在缺少正文增量时补齐；`result.status` 与退出码共同判断终态，保存顶层或内层 `conversation_id`。修改 `AntigravityAdapter.test.ts` 加入进程未退出即可观察正文、工具完成/失败、结果错误和仅有终端结果的测试；同步更新 `docs/internals/providers.md` 与 `docs/user/install.md`。

#### Verify

服务端 `vp test run src/provider/Layers/AntigravityAdapter.test.ts`：3 项通过，其中运行时测试在进程退出 Deferred 尚未完成时收到 `content.delta`，并核对同一工具项的进行中/完成、失败详情、结果错误与无重复正文。`ProviderRuntimeIngestion.activity.test.ts` 5 项通过，覆盖 `item.updated` / `item.completed` 到共享活动的投影。服务端 `tsgo --noEmit -p tsconfig.json` 通过；四个改动文件格式检查与 `git diff --check` 通过。依据为 2026-09-25 检索 `Antigravity CLI stream-json step_update tool_info result` 后读取的官方文档 `https://antigravity.google/docs/cli/headless/`，它直接列出 NDJSON 事件字段、工具错误和终态，优先于按字段名猜测。真实已登录 `agy` 会话和客户端显示仍未验证，因此 A-1 未勾选。

#### Retrospect

官方协议显示 `result.response` 是完整答案，不是增量；旧的递归抓取会造成重复正文和延迟。跨运行器验收必须同时查事件发出时机与协议字段。下一轮检查其余内建驱动及 Web/Mobile 投影的一致性，重点找工具状态或失败在移动端丢失的路径。

### Round 4

#### Plan

核查移动端和网页端对共享工具事件的投影，优先修复运行中工具或失败信息在手机时间线丢失的问题。

#### Act

移动端 `buildThreadFeed` 已接受 `tool.updated`，但把 `inProgress` 与无信号的中性行都映射为 `neutral`；`deriveThreadFeedPresentation` 和 `ThreadWorkLog` 都过滤中性工具，导致工具运行期间不显示。将运行中状态单独保留为 `inProgress`，维持原有中性噪声过滤，失败状态优先。新增移动端测试，验证进行中工具即时出现在时间线，完成事件归并为完成行；补充手机端用户文档。

#### Verify

移动端 `vp test run src/lib/threadActivity.test.ts`：31 项通过；`tsc --noEmit` 通过；三处改动文件格式检查与 `git diff --check` 通过。测试在数据投影层验证时间线行，尚未在真实手机客户端观察；根据仓库 `AGENTS.md`，浏览器/电脑使用需要用户明确许可，许可尚未到达。A-1、A-2 保持未完成。

#### Retrospect

共享服务端事件到达客户端并不等于可见：显示层的状态压缩和过滤同样会遮蔽实时工具。下一轮逐个检查 Codex、Claude、Cursor、Grok、OpenCode 的正文和工具生命周期映射，并使用共用入口做定向验证；之后再处理号池、网关与余额状态。

### Round 5

#### Plan

核查 Codex、Claude、Cursor、Grok、OpenCode 原生事件进入共用时间线的路径，修复工具开始阶段不可见且完成后可能重复的问题。

#### Act

五个适配器及共用 `ProviderRuntimeIngestion` 均可发出/投影工具生命周期事件，但 Web 和 Mobile 工作日志原先都丢弃 `tool.started`。让开始事件带 `inProgress` 状态进入两端时间线，后续按同一工具调用 ID 归并更新与完成；手机端补齐交错工具调用按 ID 归并，失败仍保留终态与详情。网页对无 ID 的开始标记继续在终态到来后消除重复。新增 Web、Mobile 测试，覆盖仅有开始事件、开始后失败、进行中更新和两个工具交错结束；更新内部协议文档。

#### Verify

服务端五个适配器定向测试 214 项通过；Web 时间线三组定向测试 191 项通过，Mobile 工作日志 32 项通过。Web `tsgo --noEmit -p tsconfig.json`、Mobile `tsc --noEmit`、六处文件格式检查和 `git diff --check` 通过。最初 Web 测试以命令类型模拟错误详情，因命令预览规则把详情当作命令而失败，改为符合 MCP 工具语义的 fixture 后通过。真实客户端长任务及各供应商已登录会话仍未验证，A-1、A-2 保持未完成。

#### Retrospect

跨运行器的适配器测试全绿仍可能遗漏客户端直接过滤的事件；共用时间线必须从原生事件、服务端投影、客户端归并直到可见行逐层核对。下一轮检查号池与共享网关的账号健康、失败切换、模型路由和安全边界；浏览器许可到达后补真实客户端性能观察。

### Round 6

#### Plan

核对本地账号池与共享网关的账号可用性、失败切换和模型路由；优先修复会让有效账号无法承接请求的明确边界。

#### Act

发现混合账号池中一旦有账号声明 `models`，网关就不会为同池未声明模型的通配账号生成请求模型路由，导致其可服务的新模型被 404 拒绝。现在只要存在无模型声明的启用账号，就为请求中的新模型补一条不重复的临时路由，实际选择仍由 `pickLocalAccount` 按账号模型限制筛选。新增路由单测与 HTTP 运行时测试，验证受限 API Key 账号不接新模型而通配 OAuth 账号接管；新增 429 换号测试，确认首账号失败响应不会混入第二账号的成功流。更新用户文档中的混合账号池说明。

#### Verify

修改前本地账号池/网关现有定向测试 65 项通过；修改后 68 项通过。新增运行时测试初次用内部渠道 ID 模拟外部 `/v1` 裸模型请求，得到 404；按该入口实际请求格式改为裸模型名后通过，断言 OAuth 上游 URL、凭据与原始模型名。服务端 `tsgo --noEmit -p tsconfig.json` 通过；四处改动文件格式检查与 `git diff --check` 通过。现有测试还覆盖冷却持久化、模型限制与外部 Key 无法访问普通 BYOK；真实上游与传输故障切换尚未验证，A-3 不勾选。

#### Retrospect

目录生成和账号选择是两道独立关口：选择器能匹配通配账号，但若网关事先没有发布请求模型的路由，选择器根本不会运行。后续重点检查多供应商设置保存后的客户端目录与实际路由一致性，以及余额查询对零值、无接口和失败的区分；账号池网络失败与耗尽路径仍需补足。

### Round 7

#### Plan

核对多供应商余额查询的真实接口与缓存隔离，先修复会把前一个账号余额显示给轮换后账号、或把已停用接口当成可查询能力的明确错误。

#### Act

`ByokBalanceService.ts` 的缓存指纹原先遗漏 API Key，只记录余额 Token 的长度；现在对协议、地址、供应商、余额档案、账号标识及两个密钥字段共同计算 SHA-256 摘要，避免同长度密钥轮换复用旧余额，同时不在缓存键里存明文。SiliconFlow 官方 `.cn` / `.com` 地址的自动余额档案停止盲探通用计费路径；目录标为无已核验公开账号接口，显式选择通用计费或 NewAPI 的中转仍按用户配置查询。新增密钥轮换、官方域名与相似中转域名测试，更新用户与内部文档。

#### Verify

`apps/server` 的 `vp test run src/provider/byok/ByokBalanceService.test.ts src/provider/byok/ByokBalanceDashboardCore.test.ts src/provider/byok/BalanceCore.test.ts src/provider/byok/SupplierCatalog.test.ts`：46 项通过，包含零值、无接口、查询失败及密钥不回显的原有和新增案例。`tsgo --noEmit -p tsconfig.json` 通过；六个相关文件格式检查与 `git diff --check` 通过。格式初检发现一个测试文件需整理，运行定向格式化后复检通过。2026-09-25 检索 `SiliconFlow /user/info retired replacement account API` 并核对 `https://docs.siliconflow.cn/docs/release-notes/overview`：官方公告旧接口 2026-08-14 停用，替代接口待公告；对照 `https://github.com/farion1231/cc-switch-website/blob/main/public/docs/en/2-providers/2.5-usage-query.md` 的旧用量模板，采用较新的官方公告。尚未接入 OpenRouter 等更多供应商的专属接口，A-5、A-6 仍未勾选。

#### Retrospect

余额能力要以供应商当前官方接口和实际凭据范围判断，不能照搬产品模板的历史标签；同长度密钥轮换也必须刷新缓存。下一轮核对 OpenRouter 官方 `/api/v1/credits` 和 `/api/v1/key` 的凭据权限、余额与 Key 限额语义，做可验证的专属查询并明确失败状态。

### Round 8

#### Plan

按上一轮 Retrospect 核对 OpenRouter 官方账户额度与普通 Key 限额的权限和字段语义，接入独立查询路径，并让多端展示明确区分两种数值。

#### Act

新增 `parseOpenRouterCredits` 与 `parseOpenRouterKeyLimit`：管理密钥查询官方 `/api/v1/credits`，按账户已购额度和累计用量得到账户剩余；普通推理 Key 查询 `/api/v1/key`，只显示本 Key 支出限额，不冒称账户余额。仅精确匹配 `https://openrouter.ai` 官方主机时采用官方路径；管理密钥被拒绝时保留失败，不退回另一种指标；相似中转域名的自动余额查询不发送管理密钥。网页与手机余额行增加 Key 专属标签，包括无 Key 支出上限的状态，补齐英中日文案。新增解析、HTTP 模拟和 Web 展示测试，更新用户与内部文档。

#### Verify

2026-09-25 检索 `OpenRouter credits management key current API key limit_remaining` 后读取 `https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits` 和 `https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key`：官方文档分别声明管理密钥权限、账户字段和当前 Key 限额字段，因此以一手接口定义作为实现依据。服务端五组相关定向测试 54 项通过，Web `UsagePlanView.test.tsx` 5 项通过；服务端和网页 `tsgo --noEmit -p tsconfig.json`、手机 `tsc --noEmit` 通过；`node scripts/check-ui-i18n.mjs` 对 Web/Mobile/Desktop 通过；13 文件格式检查与 `git diff --check` 通过。格式化前先复制已修改文件到临时目录，核对格式器只调整本轮新增行及条件表达式缩进，没有重写其他用户改动。真实 OpenRouter 凭据和实际客户端仍未验证，A-5 尚未勾选。

#### Retrospect

同一家供应商的“账户余额”与“Key 限额”权限、数值范围不同；失败时若自动切换数据源，会给用户一个看似成功却含义改变的数字。下一轮检查网页、桌面共用路径和手机的多供应商选择、配置保存与模型路由是否一致，并补有真实状态边界的定向验证。

### Round 9

#### Plan

核对 Web、桌面共享设置页和手机在切换供应商、协议或地址后，保存的凭据、模型目录与实际网关路由是否仍指向同一目标；修复可导致旧密钥误用或发送给旧供应商目录的路径。

#### Act

新增共享 `canRetainByokAdapterCredentials` 判断：仅供应商、协议、标准化地址均相同时，编辑表单才可复用服务端保存的 API Key。Web 单适配器与批量通道编辑、Mobile 适配器编辑在目标变化时清理旧密钥及脱敏标记、余额令牌、账号标识、自定义请求头和模型目录元数据，并要求重新输入推理密钥。服务端模型发现只自动查询与当前推理地址同源的目录，过滤其他供应商残留的已知模板地址；显式配置的跨域目录继续保留高级用法。新增两端表单、共享判断、模型发现与多供应商网关路由测试，更新用户及内部文档。

#### Verify

共享包 2 项、Mobile 6 项、Web 33 项、服务端 58 项定向测试通过；Web、Mobile、Server、client-runtime 类型检查通过；10 个相关代码文件格式检查与 `git diff --check` 通过。服务端新增测试验证 DeepSeek/OpenRouter 两个所选模型分别使用各自的地址、Key 与上游模型。真实 Web/桌面/手机客户端尚未观察：仓库 `AGENTS.md` 要求浏览器或电脑使用前取得用户许可，许可未到达；A-4 保持未完成。所有已有无关工作区改动均未清理或提交。

#### Retrospect

供应商选择不能只改显示标签：旧脱敏凭据和模型目录必须与新目标一起失效，否则配置保存成功后仍可能访问旧渠道。跨域模型目录是显式高级配置，应与模板自动目录分开处理。下一轮复核供应商余额能力标签与实际查询档案、失败状态及多端展示是否一致；之后继续 A-3 的账号池失效路径与 A-1/A-2 的真实客户端验收。

### Round 10

#### Plan

逐一核对供应商余额能力声明、服务端真实查询路径和 Web/Mobile 的零余额、无接口、失败展示；先补一个有明确公开实现依据的供应商查询，并消除会把“未接入”误报为“查询失败”的路径。

#### Act

参考 CC Switch 的 Kimi API 余额脚本和 CodexBar 的 Moonshot 区域说明，新增精确官方主机限定的 Moonshot 国内/国际 `GET /v1/users/me/balance` 查询：分别标记 CNY/USD，保留零余额，失败不退回通用计费；不回显凭据。目录只为已接入专属接口的 Moonshot、DeepSeek、OpenRouter 与智谱标记可查询，Kimi Coding、MiniMax、Novita、StepFun、火山、ZenMux 等未接入的档案改为 `none`。已知官方模板在自动模式下直接返回 `unsupported_profile`，避免盲探通用计费路径；中转和明确选择通用计费或 NewAPI 仍可查询。Web/Mobile 对余额耗尽的行恢复重新查询入口，对不支持的行只显示状态；同步更新用户与内部文档。

#### Verify

2026-09-25 检索 `Moonshot API balance available_balance CC Switch`、`site:github.com/farion1231/cc-switch moonshot.ai/v1/users/me/balance`，读取 `https://github.com/farion1231/cc-switch/discussions/5544` 与 `https://github.com/steipete/CodexBar/blob/main/docs/moonshot.md`：前者给出 `.cn` 请求与字段，后者列出 `.cn` / `.ai` 区域地址。采用公开可核对的实际请求示例，未取得 Moonshot 官方接口文档或本项目真实凭据，故仅以模拟 HTTP 验证而不声称线上实测。服务端 `BalanceCore`、`ByokBalanceService`、`ByokBalanceDashboardCore`、`SupplierCatalog` 共 56 项测试通过；Web `UsagePlanView` 6 项通过；服务端/Web/Mobile 类型检查、9 个相关代码文件格式检查和 `git diff --check` 通过。A-5 仍有供应商和真实账号待验收，保持未勾选。

#### Retrospect

目录“可查余额”只能表示本服务端已经实现了相应接口，不能直接继承 CC Switch 的模板能力；余额为零则是可再次刷新的成功结果。下一轮查 Novita/StepFun 等剩余供应商的现行接口、鉴权和返回字段，能核实时再接入专属查询并保持四态区分；之后核查账号池失效切换与长任务真实客户端。

### Round 11

#### Plan

核对 Novita/StepFun 的现行余额接口，优先采用能从供应商一手文档确认地址、鉴权与字段的接口，并避免把订阅套餐用量与开放平台账户余额混为同一数值。

#### Act

StepFun 国内、国际官方文档均提供 `GET /v1/accounts`、Bearer API Key 与 `balance` 字段；新增 `parseStepFunAccount` 和精确主机加 `/v1` 推理路径限制的地区查询，国内/国际分别标记 CNY/USD。目录新增 `stepfun_api`、`stepfun_api_en` 开放平台预设；既有 `stepfun`、`stepfun_en` 保留 `/step_plan`，标签明确为 Step Plan，继续显示未接入套餐用量。解析只使用当前 `balance`，不把累计充值或赠额相加。服务端改为尊重显式 `balanceProfile: "none"`，即使后来有官方接口也不发起查询。补解析、服务端 HTTP、公开目录测试与用户/内部文档；Novita 接口未找到同等完整的供应商一手文档，留待后续核验。

#### Verify

2026-09-25 检索 `StepFun API account balance GET /v1/accounts official` 并读取 `https://platform.stepfun.com/docs/zh/api-reference/accounts/get`、`https://platform.stepfun.ai/docs/en/api-reference/accounts/get`：官方原文给出两区请求地址、Bearer 头和 `object/type/balance` 响应。国内/国际货币由对应官方账户页面的 ¥/$ 显示推断，接口响应不含货币字段。服务端 `BalanceCore`、`ByokBalanceService`、`ByokBalanceDashboardCore`、`SupplierCatalog`、`SupplierCatalogTransport` 共 63 项测试通过；服务端 `tsgo --noEmit -p tsconfig.json`、7 个相关代码文件格式检查与 `git diff --check` 通过。格式化前备份已修改文件，复核仅调整本轮新增断言和条件表达式缩进。无真实 StepFun 凭据或手机客户端实际操作证据，A-4、A-5 未勾选。

#### Retrospect

同一家供应商的 Step Plan Credits 与开放平台 API 现金余额有不同的入口和含义；应分别建预设，不能在套餐通道上显示账户零余额并暗示套餐已耗尽。下一轮从 Novita 官方 CLI 和文档核验余额接口、凭据类型与响应；若可证明则接入，若不充分则保留“不支持”并转向账号池失效切换的端到端验收。

### Round 12

#### Plan

从 Novita 官方 CLI 核验余额接口、凭据和单位；若证据完整，则在现有余额看板接入精确官方域名查询，并保持零余额、无字段及请求失败的区别。

#### Act

核对 Novita 官方 `novita-cli` 的 `NovitaClient.get_balance()`、`account_balance` 命令和 `format_balance`：CLI 用 `NOVITA_API_KEY` Bearer 请求 `GET /v3/user`，读取顶层 `credit_balance`，按万分之一美元换算。新增 `parseNovitaAccount` 和 `ByokBalanceService` 官方端点尝试链，仅在 HTTPS 且主机精确为 `api.novita.ai` 时启用；更新 Novita 预设为可查询。缺字段、非法数值与 HTTP 错误不补零，也不退回通用计费。新增解析、正数/零值/缺字段/HTTP 错误、相似主机与目录测试，并更新用户与内部文档。保留显式“不查询”及中转显式通用计费能力。

#### Verify

2026-09-25 检索 `Novita CLI account balance credit_balance /v3/user`，读取 `https://github.com/novitalabs/novita-cli/blob/main/novita_cli/core/client.py`、`https://github.com/novitalabs/novita-cli/blob/main/novita_cli/novita_cli.py`、`https://github.com/novitalabs/novita-cli/blob/main/novita_cli/utils/output.py`，采用供应商官方 CLI 的实际请求和换算，未将 CLI 缺字段默认零值搬进余额看板。服务端五组定向测试 66 项通过；`tsgo --noEmit -p tsconfig.json`、八个相关文件格式检查和 `git diff --check` 通过。首次测试发现旧用例仍将 Novita 列为未接入，更新期望后重跑通过。尚无真实 Novita 凭据或客户端交互核验，A-4、A-5 仍未勾选。

#### Retrospect

官方 CLI 能提供请求地址、鉴权、字段和单位的直接证据，但 CLI 为显示友好而把缺失字段默认为零的行为不适合余额看板。下一轮转向 A-3：核查账号池在传输失败、不可用账号和切换后的网关响应及状态持久化，补端到端定向测试并修复已确认的边界。

### Round 13

#### Plan

复核 A-3 的多账号失效切换：从账号选择、网关重试和共享入口的现有测试定位真实缺口，修复三账号以上场景，并验证禁用账号、传输失败与响应流隔离。

#### Act

发现网关把本地账号池尝试次数固定为两次，且 HTTP 状态导致的换号只在第一次尝试后生效；因此前两个账号故障时第三个健康账号永远接不到请求。改为以账号池候选 ID 的去重数量约束尝试次数，每个已选账号仍由 `triedLocalIds` 排除，凭据失效、传输失败与可换号 HTTP 状态都可继续选择下一账号。已有响应开始交付后不重放。新增 runtime 测试：四个绑定账号中一个禁用，首个连接失败、第二个 503、第三个成功，核对实际 Bearer Key、失败账号冷却和最终流只包含第三个账号。更新用户文档的换号规则。

#### Verify

服务端 `vp test run src/provider/byok/modelGateway.local.runtime.test.ts src/provider/byok/modelGateway.test.ts src/provider/LocalAccountPool.test.ts src/provider/LocalPoolUsage.test.ts`：四组 75 项通过；服务端 `tsgo --noEmit -p tsconfig.json`、三文件格式检查和 `git diff --check` 通过。首次新测试使用了不属于当前测试路由层的外部 `/v1` 入口，返回 404；改用测试层实际注册的内部共享网关入口后通过。类型检查首次指出测试中的直接 `Date.now()`，换用 Effect Clock 后通过。现有同组测试还验证 401/429 换号、模型限制与通配账号、共享入口外部 Key 隔离、来源绑定、模型映射、冷却快照持久化。由这些定向证据勾选 A-3；真实官方端点的生产账号仍未实测。

#### Retrospect

账号池重试上限要由候选账号数量决定，不能把双账号的测试结果外推到三账号池；已有 `triedLocalIds` 能保证一个请求内不重复试同一账号。下一轮转向 A-1：沿五个 Agent 的原生事件、服务端投影到共享时间线做集成验证，补足当前仅分层单测可能漏掉的协议边界。

### Round 14

#### Plan

按上轮计划追踪五个 Agent 的原生事件、服务端投影与共用时间线；优先补齐现有适配器测试中缺少的工具失败生命周期投影，避免仅凭各层测试通过就推断整条链路正确。

#### Act

检查 `ProviderRuntimeIngestion` 的工具投影和五个适配器定向测试后，发现 OpenCode 只有正文增量测试，没有原生工具状态进入共用活动记录的测试。在 `OpenCodeAdapter.test.ts` 添加同一工具的 `pending → running → error` 与相邻正文事件，实际启动 OpenCode 测试适配器订阅模拟 SDK 事件，再经 `runtimeEventToActivities` 投影；核对 `tool.started`、`tool.updated`、`tool.completed` 的同一调用 ID、失败状态与详情。未改变产品运行时代码。

#### Verify

服务端 Codex、Claude、Cursor、Grok、OpenCode 五组适配器及 `ProviderRuntimeIngestion.activity` 定向测试共 220 项通过；服务端 `tsgo --noEmit -p tsconfig.json`、新增测试文件格式检查与 `git diff --check` 通过。新测试首次类型检查发现将带可选第二参数的投影函数直接传给 `flatMap` 会误收数组索引，改为显式回调后通过。当前新增的跨层投影只覆盖 OpenCode；其他适配器通过各自事件测试，但尚未逐个执行适配器到时间线的集成断言，A-1 保持未勾选。真实客户端观察尚未获仓库要求的授权，A-2 仍未勾选。

#### Retrospect

提供正文与工具原生事件的适配器测试不能单独证明共享投影后的时间线语义；尤其失败状态和工具 ID 需要在边界两侧核对。下一轮为 Codex、Claude、Cursor、Grok 的已有原生事件测试补投影断言，并对照 Web/Mobile 的实时与失败显示测试，完成 A-1 的定向集成矩阵。

### Round 15

#### Plan

完成 A-1 的适配器到共用时间线定向集成矩阵：补上 Codex、Claude、Cursor、Grok，以及已启用的 Antigravity、BYOK、Pi、Omp 的投影断言，并核对网页、手机的实时与失败状态。

#### Act

在八类适配器现有的原生事件测试中，把实际生成的 `ProviderRuntimeEvent` 送入 `runtimeEventToActivities`：Codex 核验失败/拒绝终态，Claude 核验同 ID 开始与完成，Cursor 核验进行中与完成，Grok 核验进行中；Antigravity 核验进行中、完成、失败，BYOK、Pi、Omp 核验同 ID 开始与完成。OpenCode 上轮已覆盖待执行、运行与失败。ACP 共用映射新增 Cursor/Grok 失败详情投影测试。修正内部文档对 ACP 初始工具事件的表述：其首次更新可为 `item.updated`，仍实时显示。未改产品运行时代码。

#### Verify

九类适配器与 ACP 共用映射的完整定向矩阵 10 文件 252 项通过；服务端 `ProviderRuntimeIngestion` 两组与 ACP 共用映射共 87 项通过；Web `session-logic`/`MessagesTimeline` 129 项、Mobile `threadActivity` 32 项通过；服务端 `tsgo --noEmit -p tsconfig.json`、十文件格式检查和 `git diff --check` 通过。首次四类测试中 Claude 断言少算原生流提供的 `tool.completed`，据实际事件补齐同 ID 完成态后全矩阵重跑通过；Omp 的活动 ID 是 provider 工具 `tool-read-1`，与 ToolBroker 调用 ID `omp-host-ht-1` 不同，按各层真实身份修正断言后重跑通过。该证据覆盖当前仓库九类可用适配器从事件生成到共用服务端投影，以及 Web/Mobile 消费共用活动合同的状态展示，勾选 A-1。真实客户端帧率和滚动仍属 A-2，尚未取得浏览器/电脑使用许可。

#### Retrospect

同一工具可同时有 provider item ID 与 ToolBroker invocation ID，时间线应沿用前者归并；不能把两个身份的名称当作缺陷。ACP 首次工具状态为 `item.updated` 也必须立即可见。下一轮转向 A-4：复核 Web/桌面共享设置路径、手机供应商选择与保存后的模型路由合同，补强缺失的定向测试；真实客户端验证仍需遵守仓库的浏览器许可要求。

### Round 16

#### Plan

沿网页、桌面共用设置页和手机独立设置页核对供应商选择、保存配置与服务端模型路由；优先修复供应商切换后已保存模型来源与表单不一致的问题。

#### Act

发现网页 `readByokModelAdapters` 丢弃服务端返回的 `supplierID` 与目录元数据，编辑表单又把供应商固定为“自定义”；已存脱敏密钥在原供应商上修改名称也会被误判成跨供应商复用。现在重读并预填原供应商、路由和目录字段，同一供应商/协议/地址下编辑时保留目录；切换目标仍按既有凭据边界清除旧值。手机端供应商卡片原先保留旧模型 ID、窗口和显示名，并把“自定义”写成供应商 ID；现在切换会要求重新选模型，自定义使用空供应商 ID。补网页重读/编辑、手机卡片到保存、服务端脱敏设置再保存的定向回归测试，更新用户文档。

#### Verify

Web 设置测试 34 项与包级 `tsgo --noEmit -p tsconfig.json` 通过；Mobile 设置逻辑测试 7 项与 `tsc --noEmit` 通过；服务端 `serverSettings` 57 项及 `modelGateway` 38 项、服务端包级 `tsgo --noEmit -p tsconfig.json` 通过。相关代码格式检查与 `git diff --check` 通过。桌面 `DesktopWindow.ts` 使用 `window.loadURL(applicationUrl)` 加载共享 Web 渲染器，故复用同一网页设置路径。上述证据涵盖配置重读、保存、手机切换与服务端来源/模型路由，勾选 A-4；尚未获得仓库要求的真实浏览器/电脑使用许可，交互手感和帧率留在 A-2。

#### Retrospect

服务端保留供应商元数据仍不够，客户端反序列化和编辑表单也必须保留同一身份；切换供应商时则应清空旧模型选择。下一轮核对 A-5 的已支持余额档案、HTTP 模拟、界面四态及密钥脱敏证据，补最薄弱的端到端路径。

### Round 17

#### Plan

核对已支持余额档案的 HTTP 模拟、合同、看板分类与客户端显示；修复缺少密钥时“不支持”和“查询失败”被混淆的边界。

#### Act

`ByokBalanceService.balance` 原先在判断通道能力前检查 API Key：显式“不查询”、Gemini 原生接口和已知未接入余额接口的供应商，若尚无 Key 会错误返回 `missing_credentials`。把缺少密钥检查移到能力判断之后；可查询通道缺 Key 仍返回凭据错误，且无网络请求。新增三类无 Key 且不支持通道的服务端回归测试；网页余额看板测试补查询错误显示断言，与既有零余额和不支持状态并列；用户文档说明三态及未填 Key 的边界。

#### Verify

服务端 `BalanceCore`、`ByokBalanceService`、`ByokBalanceDashboardCore`、`SupplierCatalog`、`SupplierCatalogTransport` 五组 67 项通过，覆盖通用/NewAPI、DeepSeek、Moonshot、Novita、StepFun、OpenRouter、智谱接口的模拟响应、端点约束、零值、失败、供应商目录及密钥不出响应。合同 `byokBalance` 3 项、共享客户端余额合并 4 项、Web `UsagePlanView` 6 项通过；服务端与 Web 包级类型检查、相关文件格式检查及 `git diff --check` 通过。移动端 `UsageRouteScreen` 消费相同看板健康状态并显示 `ok/empty/unsupported/error` 标签及错误提示；本轮未进行真实设备或凭据查询。根据上述 HTTP、合同和网页界面状态证据勾选 A-5；真实供应商账户结果仍取决于用户自己的凭据与上游可用性。

#### Retrospect

余额查询的第一步应判断渠道是否支持或被用户关闭，再检查查询凭据；否则“无接口”会被伪装成“凭据缺失”。下一轮完成 A-6：用公开来源核对 CC Switch 与同类产品在 Agent 输出、供应商选择及余额能力上的具体做法，写明 Code Work 已实现行为、边界和差距。

### Round 18

#### Plan

核对 CC Switch、Conductor 与 Codex App 的一手公开资料，按供应商选择、额度语义、多 Agent 能力和长任务体验对照当前实现；把采纳理由和剩余差距写成可维护的产品文档。

#### Act

新增 `docs/internals/agent-provider-product-comparison.md`，逐项列出公开来源、Code Work 源码/测试证据、采纳约束及差距，并从 `docs/internals/providers.md` 链接。明确 CC Switch 写入 CLI 配置与本项目运行时共享网关的生效边界不同；官方余额、套餐窗口、单 Key 限额不可混用；不同 Agent 的原生能力不能因共用时间线而被假定相同；工作区隔离和真实帧率不由共用 UI 或纯计算基准自动保证。将未接入的任意余额脚本与真实客户端性能列为差距，不把同类产品的供应商模板直接当作本项目已实现能力。

#### Verify

2026-09-25 检索 `CC Switch provider switch usage query manual template`、`Conductor agent modes parallel agents workspaces`、`OpenAI Codex app multiple agents worktrees`，读取 CC Switch 官方仓库的 `2.2-switch.md`、`2.1-add.md`、`2.5-usage-query.md`，Conductor 官方 `agent-modes`、`parallel-agents`、`harnesses` 文档，以及 OpenAI 的 Codex App 官方介绍；另核对 SiliconFlow 官方更新日志确认旧 `/user/info` 已停用。采用产品方一手说明和供应商公告，优先于第三方能力列表；链接与采用理由均在新文档。对照当前源码并重跑服务端网关/余额 72 项、Web 时间线基准/余额展示 7 项、Mobile 工具时间线/供应商设置 39 项，全部通过。两个文档格式检查通过，文档列出的本地证据路径逐一存在，`git diff --check` 通过。根据公开来源、日期、实现和差距的对照证据勾选 A-6。

#### Retrospect

同类产品最可借鉴的是明确区分配置状态与运行状态、余额数据源、Agent 能力及工作区边界，而不是照搬每个模板。下一轮回到 A-2：在现有长流基准上记录可复现数据；若仓库要求的浏览器/电脑许可到达，再验证真实渲染和滚动，否则如实保留未验收状态。

### Round 19

#### Plan

复测 A-2 的长事件流，分别量化派生与稳定行比较的成本；增加连续工具更新和失败详情的回归路径，只在测到明确瓶颈时改运行时代码。

#### Act

确认 Web 时间线使用 `LegendList` 虚拟列表，展开历史的 8002 条数据行并非 8002 个同时挂载的 DOM 节点。扩展 `MessagesTimeline.performance.test.ts` 的可选计时，单独记录稳定行比较耗时，并模拟 8001 条历史事件后连续 20 次更新同一个实时工具；验证每次新详情可见、旧折叠行引用稳定、最终失败详情仍保留。稳定行比较未显示值得引入新算法的成本，因此本轮只增强测量与回归，不改时间线运行时代码。

#### Verify

在 `apps/web` 运行 `TIMELINE_BENCH=1 vp test run src/components/chat/MessagesTimeline.performance.test.ts --project unit --reporter verbose`，2 项通过。8001 条事件的折叠/展开派生加稳定比较中位数分别为 5.62/6.90 ms，原日志标作 p90 的数字为 7.07/15.13 ms；其中稳定比较中位数分别为 0.03/0.80 ms，原日志标作 p90 的数字为 0.09/1.34 ms。连续 20 次实时工具更新中位数 6.30 ms，原日志标作 p90 的数字为 10.19 ms。第 20 轮复核发现 10 次采样取了最大值、20 次采样取了第 19 个排序值，均不是 p90；保留原日志值供追溯。Web 包级 `tsgo --noEmit -p tsconfig.json`、改动文件格式检查和 `git diff --check` 通过。测量为本机 Node 侧派生耗时，且采样有环境波动；仓库要求的浏览器/电脑使用许可未收到，真实客户端的帧率、滚动与工具流显示未验收，A-2 保持未勾选。

#### Retrospect

展开模式的稳定比较仅占本轮测得成本的一小部分，基于此重写比较器缺乏收益依据。最后一轮应核对已有证据和许可状态；若仍无法运行真实客户端验证，明确列出 A-2 的未验收边界与下一步，而不是把纯计算基准写成界面顺滑的证明。

### Round 20

#### Plan

补齐 A-2 长历史下连续流式正文的可重复验证，并复核基准统计口径；在轮数上限前明确已证明行为与真实客户端尚缺的证据。

#### Act

在 `MessagesTimeline.performance.test.ts` 增加 8002 条事件中连续 20 次增长助手正文的场景，逐次确认最新正文、运行中工具及历史折叠入口同时存在，旧折叠行保持稳定。复核发现旧基准的 p90 索引错误：10 次采样用了最大值，20 次采样用了第 19 个排序值；改为偶数样本取两中心值平均的中位数和最近秩 p90，并在第 2、19 轮记录原值的统计口径，保留追溯。未改运行时代码。

#### Verify

在 `apps/web` 运行 `TIMELINE_BENCH=1 vp test run src/components/chat/MessagesTimeline.performance.test.ts --project unit --reporter verbose`，3 项通过。修正统计口径后，8001 条事件折叠/展开派生加稳定比较中位数为 5.21/6.67 ms，p90 为 6.67/7.34 ms；8001 条事件连续工具更新中位数 5.63 ms、p90 6.90 ms；8002 条事件连续正文更新中位数 6.11 ms、p90 10.08 ms。Web 包级 `tsgo --noEmit -p tsconfig.json`、测试文件格式检查与 `git diff --check` 通过。A-1、A-3、A-4、A-5、A-6 的代码和定向测试证据仍在前轮记录；A-2 还缺仓库要求经许可后的真实客户端帧率、滚动和流式显示观察，未勾选。Node 测量不能替代真实客户端验收。

#### Retrospect

20 轮预算已用尽，5 项验收有定向证据，A-2 仍缺真实客户端验证；不能将此目标或 spec-loop 标记完成。停在轮数上限，保留现有实现与记录。若用户批准浏览器/电脑使用并延长轮数，应先在 Web 与桌面共享路径运行长流关键场景，记录帧耗时、滚动和工具/正文呈现；发现问题时依据实测修复，再对全部验收项做独立终审。

### Round 21

#### Plan

按用户授权把轮数上限延至 24，使用隔离开发数据在真实 Web 客户端观察长历史、失败、展开、滚动及新 Agent 回合的正文和工具生命周期；避免触碰共享 `~/.t3/userdata` 与现有工作区内容。

#### Act

将 `max_rounds` 由 20 调整为用户同意的 24。通过仓库 `test-codework-app` 流程，以 `E:\MyProject\code-work\.t3\spec-loop-long-stream` 为独立 baseDir 启动服务（server 13773、web 5733），用一次性配对链接登录受控浏览器。停服后按当前数据库 schema 在隔离目录写入 1 项目、1 线程、2 消息及 1202 条交错的推理/工具活动，再复启服务。首次 fixture 使用合同不支持的 `tone=thinking`，导致详情解码失败；依据 `OrchestrationThreadActivityTone` 改为 `info` 后，页面正常显示。随后在隔离空工作区通过 UI 发送仅运行一次 `pwd`、不修改文件的短任务，实际观察新的流式正文、工具开始、完成和最终回答。

#### Verify

SQLite 查询确认隔离库有 1 项目、1 线程、2 条预置消息和 1202 条预置活动；修正后活动 tone 分别为 `info` 600、`tool` 601、`error` 1。浏览器可见长历史的折叠入口、保留的失败标识与退出码详情、预置正文；点击折叠入口可展开完整日志。真实 Codex 回合在页面先出现预说明，再出现“正在运行 pwd”，最终显示十条正文；完成后的“工作了 29s”内仍可展开命令与输出。上滚约三页再回到最新正文，未观察到白屏或布局溢出。隔离工作区目录仍为空，原仓库 `git status` 文件集合未发生额外变化。浏览器日志中曾有由直接写入投影但缺失编排历史的 fixture 引起的 `unknown_binding` 警告，因此不把它归为正常运行路径的产品故障。此轮没有可靠的浏览器帧耗时数字，不能仅凭截图宣称“无掉帧”；A-2 暂不勾选。

#### Retrospect

直接写入投影可复现长历史的视觉状态，但 `running` 会话重启后会被判为孤儿，不能拿它验证实时流；实时路径应由真实 Agent 回合补证。下一轮用受控浏览器可复现的帧时长/长任务指标测量长历史展开与滚动；若发现明确瓶颈再做最小修复，否则整理 A-2 的性能边界并进入终审。

### Round 22

#### Plan

在第 21 轮的隔离长历史页面补浏览器帧时长数据，对照稳定空闲与连续滚动，并测一次历史展开。临时测量代码在读数完成后移除，避免给正式界面增加持续的帧回调。

#### Act

浏览器快捷键未打开性能面板，因此在 `MessagesTimeline` 临时加入仅开发模式、仅 `timelineFrameBench=1` 页面启用的 `requestAnimationFrame` 采样器：只记录页面可见时相邻回调的间隔，保留最近 120 帧，输出排序后第 `floor(0.95 × 样本数)` 项、最大值和超过 50 ms 的数量。用 1280×720 的受控浏览器打开第 21 轮的 1202 条活动隔离数据，记录稳定空闲值，再对时间线执行 4 组各上滚 20 页、下滚 20 页，另展开一条旧思考摘要。测完精确删除采样器，并去掉查询参数重新打开页面。

#### Verify

稳定空闲的 120 帧窗口：p95 16.8 ms、最大 16.9 ms、超过 50 ms 为 0；连续双向滚动后的 120 帧窗口：p95 16.8 ms、最大 66.7 ms、超过 50 ms 为 1。旧思考摘要点击后能显示正文，测量窗口曾见 p95 16.8 ms、最大 66.8 ms、超过 50 ms 为 1；虚拟列表在该位置实际挂载 33 行。初次载入仍有开发环境启动成本：载入后的前 50 帧窗口 p95 133.4 ms、最大 216.7 ms、超过 50 ms 为 8，不据此宣称冷启动无卡顿。两组连续滚动后页面保持正文、工具和失败行可见，无白屏；删去临时代码并重开普通页面后，测量浮层消失、历史与最终回答正常显示。第 20 轮的 8001 条派生基准与第 21 轮的真实正文/工具生命周期共同补齐 A-2 的验证条件。上述帧数据只代表本机开发构建和此隔离数据，不能推算其他硬件或生产冷启动；A-2 以长任务运行期间的滚动和可见性验收勾选。

#### Retrospect

将初次载入与稳定交互分开记录，避免用 dev 热加载噪声掩盖交互结果，也不把一次 66.7 ms 间隔说成绝对零掉帧。六项验收现均有定向证据；下一轮按 spec-loop 流程做独立终审，重点核对适配器覆盖、余额真实接口及 A-2 的证据边界。若终审发现缺口，剩余轮数用于修复和复验。

### Round 23

#### Plan

六项自检已勾选，按 spec-loop 的终审规则交给全新上下文的 spec-verifier 逐项重验 `verify:` 条款，并将其结论原样入账；本轮不改产品代码。

#### Act

发现本机缺少随 spec-workflow 0.9.0 提供的 `spec-verifier.toml`，按技能预检查复制到 `C:\Users\Administrator\.codex\agents\spec-verifier.toml`，SHA-256 与随包配置一致。派发全新上下文的独立验证 Agent；它读取当前工作树和验收记录，复跑定向检查，并在隔离 Web 页面亲自查看长历史、失败详情与新 `pwd` 回合。依据其失败结论撤回 A-6 勾选，并创建 `verify.md` 记录原始发现。

#### Verify

验证 Agent 的结论为 `fail`：A-1 至 A-5 的 `verify:` 条款均有本轮独立证据，A-6 不通过。服务端适配器、投影、网关和余额定向测试 18 文件 430 项，另投影 5 项通过；Web 6 文件 234 项、Mobile 2 文件 39 项、共享运行时 2 项通过。Server/Web/Mobile 类型检查、UI i18n、`git diff --check` 均退出码 0。8001 条事件折叠/展开派生中位数 5.96/7.24 ms、p90 8.54/8.05 ms；真实 Web 客户端复查能见折叠、失败详情和新回合正文/工具生命周期，本次复查未重新采集浏览器帧耗时。独立发现 `docs/internals/agent-provider-product-comparison.md:14` 仍称“真实浏览器/桌面滚动帧率、掉帧和手机设备交互尚未验收”，与第 22 轮已完成的 Web 帧采样及本轮 Web 复查相矛盾；原始发现见 `verify.md` 的 V-1。A-6 的“文档与测试结果一致”条件尚未成立，故终审未通过。

#### Retrospect

浏览器验收改变了产品能力证据边界，旧对照文档不会自动更新。下一轮只修正该文档的 Web 已验收与桌面/手机未验收边界，核对来源日期和限制表述，再请独立验证 Agent 按 V-1 复查修复 diff；在确认 A-6 成立前不把循环标记完成。

### Round 24

#### Plan

按第 23 轮 Retrospect 修复独立终审的 V-1：对照文档应把已完成的 Web 浏览器长流观察和帧间隔测量，与尚未做的桌面独立外壳及手机实机验收准确分开。只修改该文档，并保留原有公开来源和能力限制。

#### Act

修改 `docs/internals/agent-provider-product-comparison.md` 的 Codex App 对照行，明确 Web 开发构建已有隔离客户端观察和帧间隔数据、桌面独立外壳与手机实机未验收。新增“Web 长流交互的验收边界”小节，记录 2026-09-25 的 1280×720 视口、1202 条活动、真实 `pwd` 回合、最近 120 帧采样法、四组双向滚动、稳定与滚动帧间隔，以及开发构建首次载入的峰值；更新“当前产品边界”中原先把全部真实客户端验收写作未来工作的句子。未改公开产品来源或产品代码。

#### Verify

定向 `vp fmt --check docs/internals/agent-provider-product-comparison.md` 首次发现表格排版需整理；对该单文件运行 `vp fmt` 后复检通过。`rg` 确认 V-1 引用的“真实浏览器/桌面滚动帧率、掉帧和手机设备交互尚未验收”原句计数为 0；文档保留截至日期、检索词、公开来源链接、采用理由、当前实现与差距，并分别陈述 Web 已测与桌面/手机待测。文档 UTF-8 无 BOM、无行尾空格；`git diff --check` 退出码 0。第 23 轮独立测试证据仍适用，因为本轮只改文档。A-6 按本轮自检重新勾选；V-1 在 `verify.md` 保持 open，待最终独立复验。

#### Retrospect

更正对照文档时，必须连同正文中的验收边界一并核查，否则只改表格仍会留下相反结论。六项验收均已自检勾选；下一轮按 spec-loop 最终验收规则，仅针对 V-1 和本轮文档修复 diff 做独立复验，不把实现方的自检当成通过结论。

### Round 25

#### Plan

按 spec-loop 允许的最终验收轮，仅复查第 23 轮唯一未关闭的 V-1 与第 24 轮文档修复 diff；代码未变更，沿用前一轮独立完整审计的机器检查证据，不重复无关测试。

#### Act

派发全新上下文的 spec-verifier，读取 `verify.md` 的 V-1、当前产品对照文档和 loop 第 21、22、24 轮证据，自行做定向格式、编码、旧句、测试路径和性能测试检查。将其 `conclusion: pass` 原样写入 `verify.md` round 2，V-1 标为 `fixed(r2)`，无新发现。结束由本任务启动、绑定独立 `.t3/spec-loop-long-stream` 的开发服务；捕获的 PTY session 8559 已退出，5733/13773 不再监听。

#### Verify

最终独立结论为 pass，`verify.md` round 2 为 0 个 open 发现。逐项核对：A-1 的现有 Agent 原生事件至共用时间线由上一轮服务端适配器与投影共 435 项定向测试覆盖；A-2 的 8001/8002 事件可重复派生基准、长历史真实 Web 客户端正文/工具/失败可见性，以及第 22 轮 120 帧滚动指标均已记录，开发冷载峰值单列；A-3 的多账号、失效、鉴权、来源和模型路由由服务端定向测试覆盖；A-4 的 Web 234 项、Mobile 39 项及服务端路由检查通过，桌面复用 Web 路径；A-5 的余额 HTTP 模拟、零值/无接口/失败、密钥不回显和 Web 状态检查通过；A-6 的公开来源、访问日期、采用理由、现状与差距在修复后的对照文档中，V-1 复验通过。修复轮另跑 `MessagesTimeline.performance.test.ts` 3 项通过、文档格式和 UTF-8/空格检查通过；没有新代码改动。真实供应商账号余额、桌面独立外壳、手机实机与生产冷启动未现场验证，文档明确其边界，不将其充作本次定向验收证据。

#### Retrospect

最终验收与代码自检分离：完整审计发现的文档漂移在修复轮独立关闭后，六项 `verify:` 条款都有当前可追溯证据。`spec-archive` 仅在用户明确要求归档时调用；本轮把 loop 标为 done，不移动或删除工作区内容。

## Lessons

### L-1 终端事件与类型检查（source: Round 1）

`TerminalManager.attachStream` 先送当前快照再订阅后续事件。Effect Deferred 完成快照应使用 `Deferred.succeed(deferred, snapshot)`；仅跑相关单元测试不能替代包级类型检查。

### L-2 性能定位（source: Round 2）

长时间线先分别测量派生/稳定行与浏览器渲染；`TIMELINE_BENCH=1` 的定向测试可复现前者，不能替代后者。当前纯计算尚未出现需要改算法的瓶颈。

### L-3 Antigravity Headless 协议（source: Round 3）

`agy --output-format stream-json` 的正文在 `step_update.step_update`，工具状态同处，`result.result.response` 是完整答案；`result.status` 可能为 `SUCCESS`、`ERROR`、`CANCELED` 等。进程退出码不能单独表示业务成功。

### L-4 移动端实时工具状态（source: Round 4）

`tool.updated` 在移动端会先转成工作日志状态，展示前还经过时间线折叠和组件过滤；运行中与无信号的中性工具必须分别表示，才能保留实时进度并抑制历史噪声。

### L-5 工具开始事件与归并（source: Round 5）

`ProviderRuntimeIngestion` 已投影 `item.started`，但客户端曾直接丢弃 `tool.started`。开始事件应立即显示为进行中；后续更新和终态沿用 `itemId` / `toolCallId`，并行工具需按调用 ID 归并，不能只靠相邻标题。

### L-6 混合账号池模型路由（source: Round 6）

请求模型先经过 `gatewayAdapterRoutes` 发布，再由 `pickLocalAccount` 选择账号；同池部分账号声明模型、部分账号不声明时，前者的目录不能阻止后者为本次请求生成临时路由。外部 `/v1` 兼容入口接收裸模型名，内部渠道 ID 是另一种调用约定。

### L-7 余额缓存与接口时效（source: Round 7）

缓存命中必须关联实际凭据内容而不泄露明文；只比对密钥长度无法隔离账号。供应商目录的“支持余额”标签需要以当前官方文档复核，旧接口退役后应显示未接入，而非持续探测或把失败当成零余额。

### L-8 OpenRouter 两种额度（source: Round 8）

`/api/v1/credits` 需要管理密钥，代表账户已购额度与用量；`/api/v1/key` 可用普通 Key 查询，但 `limit_remaining` 只代表当前 Key 的支出上限。管理密钥失败不能静默回退到 Key 限额，官方密钥不能发往仅有相似名称的中转域名。

### L-9 供应商切换的凭据边界（source: Round 9）

脱敏 Key、余额 Token、请求头和模型目录都绑定在供应商、协议与目标地址上；表单切换目标时不能自动继承。模型发现的模板 URL 应与推理地址同源，并拒绝其他供应商遗留的模板目录；显式跨域目录则由用户单独配置。

### L-10 余额能力与零值展示（source: Round 10）

供应商目录的用量状态必须反映当前服务端已实现的查询，不应把其他产品支持的接口误写成自身能力。自动模式下的已知官方域名若没有接入余额接口，应直接返回“不支持”；成功返回 `0` 则是“余额耗尽”，仍允许用户刷新，不能禁用查询按钮。

### L-11 套餐与账户余额（source: Round 11）

供应商的订阅套餐配额和开放平台账户余额即使共享品牌，也必须分别标明数据源与路由。StepFun `/step_plan` 不是官方 `/v1/accounts` 账户查询的适配器；只在精确 API 主机和 `/v1` 推理路径上查询账户余额。累计充值与累计赠额不是当前可用余额，显式“不查询”必须始终有效。

### L-12 官方 CLI 的显示默认值（source: Round 12）

官方 CLI 的请求实现能核实余额接口、凭据和单位，但其面向终端的缺字段默认零值不能照搬到产品余额状态。解析必须要求字段实际存在且为有效整数，才能区分真实零余额与上游格式变化。

### L-13 账号池尝试边界（source: Round 13）

本地账号池若固定只尝试两个账号，三账号以上场景会在健康账号尚未轮到时过早失败。按候选账号数量设上限、逐次排除已尝试 ID，并且只在响应流交付前重放，才能同时保证可用性与输出不混流。

### L-14 适配器到时间线的证据（source: Round 14）

适配器发出 `item.*` 与投影器能处理 `item.*` 是两份分层证据，不能替代把同一组原生事件实际送过投影边界的测试。OpenCode 的 `pending/running/error` 需保持同一 `callID`，终态 `failed` 和错误详情必须留在 `tool.completed` 活动中。

### L-15 多协议工具身份（source: Round 15）

Cursor/Grok ACP 的首次工具调用可能表现为 `item.updated`，只要状态为进行中就应马上进入工作日志。Omp 等工具可同时有 provider item ID 与 ToolBroker invocation ID；时间线归并使用 provider item ID，不能混用另一个层级的调用 ID。

### L-16 供应商身份的客户端往返（source: Round 16）

供应商选择不能只在服务端配置中正确：客户端读取、编辑表单、脱敏凭据复用和重新保存都要保留同一 `supplierID`。切换供应商时应让旧模型选择失效，避免把旧模型 ID 送到新供应商地址。

### L-17 余额能力先于凭据（source: Round 17）

余额健康中的“不支持”描述渠道能力或用户选择，与是否填入 API Key 无关。仅对可查询渠道检查缺失凭据，才不会把未接入接口的供应商误报成查询失败。

### L-18 产品能力的证据边界（source: Round 18）

供应商管理器修改 CLI 配置与运行时 Agent 网关不是同一种切换；其他产品的用量模板也不是本服务端已接入接口的证据。对照文档应并列记录产品方来源、本仓库实现和未验收差距，尤其不能用时间线派生基准推断真实帧率。

### L-19 长流成本应拆开测量（source: Round 19）

虚拟列表的数据行数不能直接换算成同时挂载的 DOM 数量；派生、稳定比较和真实浏览器绘制应分别量化。连续更新同一工具时还要验证新状态、历史折叠引用和失败详情，避免只测静态历史。

### L-20 性能数字的统计口径（source: Round 20）

少量基准样本应明确中位数和百分位的取法；排序数组的最后一项是最大值，不是 p90。流式正文与工具需在同一长历史中各自验证，纯派生时间无法推断真实浏览器的帧耗时。

### L-21 隔离视觉数据与真实运行（source: Round 21）

投影 fixture 要符合合同枚举，否则详情接口会解码失败；直接写入的 `running` 会话缺少编排与 provider 运行态，服务重启后可能成为孤儿。用隔离投影验证长历史布局，用真实 Agent 回合验证正文和工具的实时生命周期，并分别记录证据边界。

### L-22 帧指标的场景边界（source: Round 22）

浏览器帧采样需说明窗口长度、百分位算法、页面可见性、视口和交互步骤。开发构建冷载、稳定空闲与滚动应分开记录；短暂超时帧和主观无白屏可以同时成立，不能互相替代。

### L-23 验收证据变更需同步产品对照（source: Round 23）

独立终审发现 A-6 的差距栏仍写 Web 浏览器验收未完成；完成新的真实客户端测量后，应逐句更新“已验证”和“待验证”的边界，否则代码与测试通过也不能证明对照文档当前准确。

### L-24 文档修复应覆盖全部同义表述（source: Round 24）

同一验收状态可能同时出现在产品对照表与边界段落；修复一处发现后，搜索并核对所有同义表述，明确数据的构建、设备和测量条件。浏览器稳定交互数据不能推导桌面、手机或冷启动结论。

### L-25 未跟踪文档的独立验收（source: Round 25）

`git diff --check` 不覆盖未跟踪文件；独立验证应另做单文件格式、编码、空格与旧句检查。修复轮只复查仍 open 的发现和其修复范围，保留上一轮完整审计的证据边界。
