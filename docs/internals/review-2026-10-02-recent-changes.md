# 近两天变更审查（2026-09-30 ~ 2026-10-02）

范围：54 个提交，主线为 ACP/Paseo Provider 集成、Composition 宿主工具与终端生命周期、
账号池/CliProxy/额度查询、effect-acp 认证兼容、附件/图标路径、Web/Mobile ACP 目录 UI。

## 审查方法与已验证事实

- `tsc --noEmit`（apps/server）：5 个错误，见 B-1、B-2。
- 定向 vitest 通过：AssetAccess、AcpRuntimeModel、CliProxy、localAccountUsage、attachmentStore（117 tests）。
- 其余结论来自代码阅读，标注"待复现"的未跑实测。
- 工作区另有未提交的 Web/Mobile 设置页改动（ACP 目录/Provider 对话框），未纳入本次结论。

## 问题清单

### B-1 [高] apps/server 类型检查失败：一次性脚本引用不存在的 RPC

- 位置：`apps/server/scripts/_a5-r148-refresh-providers.mts`（4 个错误：`providersRefresh` 不存在、索引 any、Effect 环境 `unknown`）。
- 影响：脚本是 Round 148 证据采集的草稿，提交进了仓库且无法编译，会让 server typecheck 一直红。同时违反 AGENTS.md "不提交 agent scratch 文件"。
- 方案：删除该脚本（证据已在 `docs/internals/paseo-a5-keypath-r148.md`）；若需保留，改为引用真实 RPC 名并补类型。
- 通过标准：`tsc --noEmit -p apps/server/tsconfig.json` 中不再出现 `scripts/_a5-r148` 条目；`git ls-files | grep "scripts/_"` 无草稿文件。

### B-2 [中] `HostPowerMonitor.ts(69)` 类型错误

- 位置：`apps/server/src/background/HostPowerMonitor.ts:69`，`Effect<boolean>` 与 `Effect<void>` 分支返回类型不一致（exactOptionalPropertyTypes 下报错）。
- 影响：server typecheck 红；分支一个返回 boolean 一个返回 void，调用方语义可能不一致（待确认是否由近两天改动引入，该文件最后一次提交为仓库根重构）。
- 方案：统一两个分支返回 `Effect<boolean>`（void 分支显式返回 false/true），或统一为 void。
- 通过标准：该文件无 TS 错误；HostPowerMonitor 相关测试通过；server tsc 错误数为 0。

### B-3 [中] 附件扩展名推断：`image` 分支与 `audio/file` 分支完全重复，且用图片推断函数处理音频/文件

- 位置：`apps/server/src/attachmentStore.ts` `attachmentRelativePath`（提交 7d1c4258d）。
- 影响：重复代码；音频/二进制附件使用 `inferImageExtension`，对 `audio/*` 或任意 mime 可能落到错误/空扩展名，`resolveAttachmentPathById` 依赖固定扩展名表，存在"写入路径与查找路径不一致 → 附件找不到"的风险（待用 mp3/wav/pdf/zip 复现）。
- 方案：合并 case；为 audio/file 使用独立的 `inferAttachmentExtension`（优先 fileName 扩展名，其次 mime 映射），并保证结果始终在 `ATTACHMENT_FILENAME_EXTENSIONS` 内。
- 通过标准：新增测试覆盖 png/jpg/webp/mp3/wav/pdf/zip/无扩展名文件，`resolveAttachmentPath` 与 `resolveAttachmentPathById` 对每种都返回同一文件；`attachmentStore.test.ts` 全绿。

### B-4 [中] 格式化回归：多处提交未经 `vp fmt`

- 位置：`ProviderService.ts`（三元缩进被改坏）、`historyBootstrap.ts`（单行超宽）。
- 影响：CI `vp check` 的格式检查会失败；该提交本意是"扩展名推断"，混入无关格式改动。
- 方案：对近两天改动文件运行 `vp fmt`，不要手工缩进。
- 通过标准：对这些文件 `vp fmt --check` 无差异；diff 中无纯格式噪音。

### B-5 [中] 资产 URL 的 `sourcePath` 对外部图标返回本机绝对路径

- 位置：`apps/server/src/assets/AssetAccess.ts`（5ed3bafb8）、`packages/contracts/src/assets.ts`。
- 影响：远程/隧道客户端能拿到服务器本机绝对路径（用户名、目录结构泄露），违反 "Remote ready"；Windows 路径分隔符也会因不同客户端而表现不一致。
- 方案：外部覆盖图标的 `sourcePath` 不返回绝对路径（返回 `undefined` 或脱敏的 `~/…`/文件名）；仅项目内路径返回斜杠相对路径。
- 通过标准：AssetAccess 测试新增"外部图标响应不含绝对路径（不匹配 `^[A-Za-z]:\\|^/`）"；项目内图标仍为 `/` 分隔相对路径；现有 14 个测试全绿。

### B-6 [中] ZCode 额度百分比去掉了 0~1 小数换算

- 位置：`apps/server/src/provider/localAccountUsage.ts` `fetchZCodeUsage`（0e395cb0b：`percent * (percent <= 1 ? 100 : 1)` → `percent`）。
- 影响：若上游 `percentage` 为 0~1 小数，50% 会显示为 0.5%，且 `percent==1`（用满）显示成 1%。需确认上游真实口径，当前改动无法区分"1%"与"100%"。
- 方案：以抓取到的真实响应样例为准写 fixture；若上游为 0~100，保留当前并加注释和测试；若混用，按字段（如同时有 `usedPercent`/`ratio`）区分，而不是用阈值猜。
- 通过标准：fixture 测试覆盖 `percentage: 1`、`0.5`、`50`、`100` 四种输入，输出与官方控制台展示一致；`localAccountUsage.test.ts` 通过。

### B-7 [低-中] `autoRouteLocalAccountPool` 取消 `models.length > 0` 过滤

- 位置：`apps/server/src/provider/CliProxy.ts`（0e395cb0b）。
- 影响：模型列表尚未拉取/为空的账号也会被绑定到实例，可能出现实例存在但无可用模型，选择器出现空实例或请求 404。
- 方案：保留绑定（为了刷新后能补模型），但在 UI/路由层对 `models.length===0` 的账号标记"待同步"并从可选模型中排除；或绑定后立即触发 `setLocalAccountModels` 刷新。
- 通过标准：测试覆盖"无模型账号：已绑定、不出现在模型选择、刷新后出现"；CliProxy 测试通过。

### B-8 [低] `scanNativeAccounts` / `localAccountUsage` 在无 hostDeps 时由静默 break 改为报错

- 影响：行为改进，但纯远程/受限环境下前端若未处理 `upstream_error` 会弹出泛化错误（待核对 `CliProxySettingsSection` 对该码的处理）。
- 通过标准：Web 在 hostDeps 缺失场景展示可读提示而非原始 detail；对应组件测试覆盖。

### B-9 [中] 多端覆盖与未提交改动

- 近两天 ACP 目录 UI 在 Web 与 Mobile 同步修改，但工作区仍有大量未提交改动（`SettingsProvidersRouteScreen`、`AcpRegistryCatalogPicker`、`AddProviderInstanceDialog`、i18n）；提交前需保证 Web/Mobile/ja 三份文案键一致。
- 方案：提交前跑 i18n 键一致性测试（`apps/web/src/i18n/runtime.test.ts`）与 mobile logic 测试。
- 通过标准：`messages.ts` 与 `ja.ts` 键集合一致；相关 Web/Mobile 单测通过；`git status` 中不再有这批悬空改动。

### B-10 [低] 仓库卫生

- 5000+ 行 `spec/changes/paseo-provider-integration/loop.md`、`docs/internals/paseo-a8-fresh-audit-r14x.md` 等逐轮审计文件已提交；未跟踪的 `.codegraph/`、`.harn/`、`.harn-runs/` 未被忽略。
- 违反 AGENTS.md "不提交计划/研究笔记/agent scratch"；`docs/user/` 还需避免出现仓库工具/源码路径。
- 方案：将 loop 日志与逐轮审计移出仓库（或合并为一份最终审计放 `docs/internals/`）；`.gitignore` 加入 `.codegraph/ .harn/ .harn-runs/`。
- 通过标准：`git status` 无上述未跟踪目录；仓库中无 `*-r14[0-9].md` 逐轮文件；`docs/user/` 中 grep 不到 `apps/`、`packages/` 路径。

### B-11 [低] 大批量实机/CLI 探针测试的稳定性

- `*AcpCliProbe.test.ts`（约 30 个）、`A7*.live.test.ts`（约 3400 行）依赖外部 CLI/端口/网络。
- 风险：在无 CLI 的 CI 上失败或超时；与已知 flaky 列表叠加。
- 方案：缺少 CLI 时 `skipIf`；live 测试用独立 vitest project/环境变量开关，默认不进常规 `vp test`。
- 通过标准：干净环境（无任何 ACP CLI）下常规 server 测试 0 失败；开启 `LIVE=1` 时才执行 live 测试。

## 修复优先级

1. B-1、B-2（让 typecheck 变绿）
2. B-3、B-5、B-6（真实行为风险）
3. B-4、B-9（提交前格式/多端一致性）
4. B-7、B-8、B-10、B-11

## 全局验收（只跑触及范围，不跑全仓检查）

- `npx tsc --noEmit -p apps/server/tsconfig.json`：0 错误。
- `vp test run` 针对：attachmentStore、AssetAccess、localAccountUsage、CliProxy、HostPowerMonitor 及新增测试，全绿。
- 对改动文件 `vp fmt --check` 无差异；`vp lint` 针对改动目录无新增告警。
- 上述每项按其"通过标准"逐条勾选后再合入。

## 修复结果

验收基线：本轮从 `60054903d990abbc80711d94329594a9eb5644ea` 开始，初始工作区干净。原审查中部分描述已被此前提交修正；以下以实际工作区和本轮命令结果为准。所有测试均为指定文件的定向运行，没有运行全仓检查、启动应用开发服务器或浏览器，也没有访问真实 `~/.t3/userdata`、提交或推送。下列命令省略的工作目录均为仓库根目录；应用内命令另行标明。

### B-1：已修复（本轮开始前已不存在）

- `apps/server/scripts/_a5-r148-refresh-providers.mts` 在磁盘和 Git 跟踪列表中均不存在，本轮未再执行删除。
- `git grep -n '_a5-r148-refresh-providers' -- ':!docs/internals/review-2026-10-02-recent-changes.md'` 无命中；唯一说明性引用为本审查文档。`git ls-files ':(glob)**/scripts/_*'` 无输出。
- 已完整核对原 `docs/internals/paseo-a5-keypath-r148.md`；用户确认后按 B-10 移至仓库外归档，内容和既有证据均保留，归档路径见 B-10。
- 初始 server tsc 仅报告 B-2 的 1 个错误，没有 `scripts/_a5-r148` 条目；修复 B-2 后为 0 错误。

### B-2：已修复

- `HostPowerMonitor.report` 的公开契约为 `Effect<void>`，调用链为 `Stream.runForEach(monitor.report)` 及 `BackgroundPolicy.reportHostPowerState`，均不消费 PubSub 的布尔发布结果。将发布分支转为 `void`，保留无变化分支，不改变发布条件。
- 修复前 `npx tsc --noEmit -p apps/server/tsconfig.json` 复现 TS2345；修复后在 `apps/server` 运行 `npx tsc --noEmit -p tsconfig.json`：退出码 0、0 错误。
- 在 `apps/server` 运行 `npx vitest run src/background/HostPowerMonitor.test.ts src/background/BackgroundPolicy.test.ts`：2 文件、17 测试通过。

### B-3：已修复

- 重复分支在本轮开始前已合并；本轮补独立二进制扩展名推断，优先采用允许列表中的文件名扩展名，其次 MIME 映射，最后 `.bin`。可生成扩展名均包含在按 ID 查找列表中，保留图片既有 MIME 优先规则。
- 同步修复 `AttachmentUpload` 和 Provider 二进制写盘调用，避免写入/读取规则分离；旧版 `.bin` 等存量附件仍可按原推断路径读取。
- 先写回归测试：16 组初始路径用例及真实写盘用例共复现 11 个失败；另行补旧版附件兼容性用例，修复前复现 1 个失败。覆盖 png、jpg、webp、mp3、wav、pdf、zip、无扩展名、文件名/MIME 冲突、未知扩展名与存量 `.bin`。
- 在 `apps/server` 运行 `npx vitest run src/attachmentStore.test.ts src/assets/AttachmentUpload.test.ts src/assets/ProviderBinaryAttachment.test.ts src/orchestration/Normalizer.attachments.test.ts src/imageMime.test.ts`：5 文件、60 测试通过。随后 `npx tsc --noEmit -p tsconfig.json`：0 错误。
- 既有 Provider WAV 字节断言改为读取明确要求的 `.wav` 文件，不降低字节相等、重试幂等或危险类型拒绝断言。

### B-5：已修复

- 外部覆盖图标省略 `sourcePath`；项目内仍返回 `/` 分隔的相对路径。同步纠正 `packages/contracts/src/assets.ts` 的既有注释，不改变授权机制。
- 先将外部图标用例加强为 `sourcePath === undefined` 且不匹配 `^[A-Za-z]:\\|^/`：修复前 1 失败、13 通过；修复后在 `apps/server` 运行 `npx vitest run src/assets/AssetAccess.test.ts`：原有 14 测试全通过；server tsc：0 错误。
- `git grep -n -E 'sourcePath|projectFavicon' -- apps/web/src apps/mobile/src packages/client-runtime/src`：Web 的 `assetUrls.ts` 仅透传可选字段，图标组件以签名 URL 展示；Mobile 无此字段依赖，同样使用 URL。无依赖绝对 `sourcePath` 的调用点。

### B-6：无法完成官方对照（口径方案已确认，本地回归已验证）

- 现有 `localAccountUsage.test.ts` 已明确断言 `percentage: 0.5` 输出 `percent: 0.5`。`BalanceCore.ts` 同端点解析使用 `percentage / 100` 作为内部比例；`docs/internals/agent-account-pool.md` 记录的官方源码对照也规定直接使用百分数。因此保留当前实现，不恢复阈值猜测。
- 增加内联响应 fixture：`1 → 1%`、`0.5 → 0.5%`、`50 → 50%`、`100 → 100%`。这些是沿用已有响应形状的合约测试数据，不能冒充本次抓取的真实响应。
- 本项无法诚实构造“修复前应失败”的测试：四组正确期望在当前实现均通过；反而恢复旧公式会违反已有 `0.5` 用例。没有为制造红测篡改正确预期。
- 在 `apps/server` 运行 `npx vitest run src/provider/localAccountUsage.test.ts src/provider/byok/BalanceCore.test.ts src/provider/zcode/zcodeStartPlan.test.ts`：3 文件、47 测试通过，其中 localAccountUsage 16 测试通过。
- 2026-10-02 用户确认“决策点按照你推荐的完成”：采用现有证据支持的 0–100 已用百分数口径，保留四组精确 fixture，不恢复 `<= 1` 阈值猜测；体验套餐 `used_units / total_units` 继续采用另一种明确字段口径。没有为此修改生产逻辑或放宽断言。确认后重新运行上述三个测试文件，47 项全部通过。
- 方案决策已完成，不再等待口径选择；原通过标准中的“官方响应与控制台一致”仍缺四组配对样例，因此记录为无法完成官方对照，而不是将用户授权等同于真实验证。没有访问真实账号、userdata 或启动浏览器抓取样例，也没有伪造官方 fixture。

### B-4：已修复

- 范围由 `git log --since='2026-09-30T00:00:00+08:00' --format= --name-only --diff-filter=ACMR` 与本轮修改文件合并、去重，仅保留现存源代码/配置，排除 vendored 和本地工具目录，共 229 文件。未全仓格式化，未改动其他说明性文档。
- 对明确文件列表分批运行 `node_modules/.bin/vp fmt <files>` 与 `node_modules/.bin/vp fmt --check <files>`：229 文件全部通过。包含 `ProviderService.ts`、`historyBootstrap.ts`、`attachmentStore.ts` 及阶段 1/2 文件。
- 45 个纯格式文件进行了 TypeScript 语法树（JSON 使用结构值）及注释比对：44 个直接一致；`AcpSessionRuntime.ts` 仅去掉冗余括号，忽略括号节点后语法树一致。格式化没有增删既有注释或改变断言。较大行数变化来自原有长行展开，不包含额外重构。
- 在 `apps/server` 定向运行 GenericAcpDriver、CursorAdapter、GrokAdapter、ProviderService、AcpAdapterSupport、AcpCoreRuntimeEvents、AcpJsonRpcConnection、AcpRegistryCatalog、AcpRuntimeModel、isolatedProbeEnvironment 的测试文件：10 文件、313 测试通过。在 `packages/effect-acp` 运行 `npx vitest run src/protocol.test.ts`：31 测试通过。
- 对阶段 1/2 的 11 个修改文件运行 `node_modules/.bin/vp lint <files>`：0 warnings、0 errors。最终整合后另做修改文件 fmt/lint 复核。

### B-9：已修复（一致性核验，无擅自提交或回滚）

- `96b2ed2a2` 已在本轮开始前提交审查中提及的 ACP Web/Mobile 改动；初始 `git status --short` 为空。本轮未提交或回滚这批改动。
- 用 Node 直接导入 Web/Mobile 的 `messages.ts`（en、zhCN）及独立 `ja.ts`，比较 `Object.keys` 集合：本项初验时 Web 三语各 5572 键、Mobile 三语各 2486 键；B-8 增加错误提示后为 5573 / 2487，B-7 补充待同步提示后为 5574 / 2488，missing/extra 均为空。Node 直接导入 Mobile 文案时有既有 `MODULE_TYPELESS_PACKAGE_JSON` 提示，没有为掩盖提示修改模块配置。
- 在 `apps/web` 运行 `npx vitest run src/i18n/runtime.test.ts src/components/settings/AcpRegistryCatalogPicker.test.tsx src/components/settings/AcpRegistryCatalogPicker.interaction.test.tsx src/components/settings/AddProviderInstanceDialog.environment.test.tsx src/components/settings/AddProviderInstanceDialog.test.ts src/components/settings/AddProviderInstanceWizardSteps.test.tsx src/components/settings/ProviderConnectionSection.test.ts src/components/settings/ProviderSettingsForm.test.ts src/components/chat/MessagesTimeline.test.tsx src/historyBootstrap.test.ts`：10 文件、108 测试通过。时间线测试输出既有 `useRouter must be used inside a <RouterProvider>` 警告，不影响断言。
- 在 `apps/mobile` 运行 `npx vitest run src/features/settings/SettingsProvidersRouteScreen.logic.test.ts src/lib/threadActivity.test.ts`：2 文件、54 测试通过，其中指定设置逻辑测试 13 项通过。

### B-7：已修复（含独立复核补充路径）

- 保留空模型账号绑定与 CLI 自动线路配置，移除可选目录的默认模型回退；空模型账号不发布适配器、选择目录或 ZCode 体验套餐目录。`connectByok` 以存在可绑定账号为条件，允许空模型池首次连接。
- 初轮绿色后独立复核发现三个漏测路径：完整 `local:...` 模型标识被重复加前缀、空池连接后跨平台导入未更新绑定、界面仍展示旧默认目录。没有以初轮绿色掩盖这些缺口，已返回 B-7 补回归与修复。
- 界面补修：Web/Mobile 空模型账号显示“待同步模型”，Web 卡片不再展示平台默认模型，仍允许空账号绑定并保留拉取入口；同步后展示声明模型，再次清空恢复待同步。登录、保存空列表、空模型说明同步修正英中日文案。两端新增状态往返组件用例各复现 1 个失败；修复后 Web 相关 3 文件 28 测试、Mobile 相关 2 文件 15 测试通过；两端 tsc 均为 0 错误，8 个补修文件 lint 为 0 warnings / 0 errors。最终三语键为 Web 5574、Mobile 2488，missing/extra 均为空。
- 对 Codex、Claude、Grok、ZCode 验证：空模型账号已绑定但目录为空；`setLocalAccountModels` 同步后目录出现且绑定不变；再次清空后退出目录。保留显式请求模型的通配语义，不将它混同为可选目录；保留多账号去重、禁用/恢复与网关字节行为的既有断言。
- 服务端补修：完整模型标识仅在匹配当前实例/平台时剥离前缀，保留裸模型和 Claude `[1m]`，拒绝错池/错平台/空尾；账号导入使用既有账号池绑定键识别空目录 BYOK 池，不接管普通空 BYOK。新增 14 项覆盖真实 HTTP 转发及空池跨平台导入的禁用、恢复、删除、重新导入。校准一个新用例的 OpenAI 错误类型后，有效红测为 11 失败 / 116 通过，补修后同一四文件命令为 127 通过（26 / 21 / 46 / 34）、0 跳过；server tsc 为 0 错误。首次 12 失败中的错误 fixture 没有冒充生产 bug，既有错误映射未改。
- 独立只读复核再次核对上述三项，均已关闭；没有弱化既有断言。
- 初轮在 `apps/server` 运行 `../../node_modules/.bin/vp test run src/provider/CliProxy.test.ts src/provider/LocalAccountPool.test.ts src/provider/byok/modelGateway.test.ts src/provider/byok/modelGateway.local.runtime.test.ts`：修复前 12 失败、101 通过；初轮修复后 113 通过、0 失败、0 跳过（25 / 21 / 42 / 25）；补修后的最终计数为上述 127。`npx tsc --noEmit -p tsconfig.json`：0 错误。
- 7 个修改文件 `vp fmt --check` 与 `git diff --check` 通过。定向 lint 的 1 error / 3 warnings 均用 `git show HEAD` 确认为既有：runtime 测试的 `Effect.runSync`、LocalAccountPool 测试的未使用导入、CliProxy 测试的内联 Schema 编译、modelGateway 的正则多余转义；没有扩大本项范围修复。将原有两行“默认目录”注释原位纠正为绑定与显式请求/目录的区别，没有新增或删除注释。

### B-8：已修复

- Web 额度刷新和原生登录扫描、Mobile 额度刷新均将 `CliProxyError` 的 `upstream_error` 映射为稳定文案 `cliProxy.upstreamUnavailable`，说明服务器能力/连接问题及重试方式；不直接展示底层 detail。其他错误保留原有处理，失败后解除忙碌状态，保留重试入口。
- 先补两个 Web 回归用例：修复前 2 失败、16 通过。修复后在 `apps/web` 运行 `npx vitest run src/components/settings/CliProxySettingsSection.test.tsx src/components/settings/CliProxyLoginCard.test.tsx src/i18n/runtime.test.ts`：3 文件、27 测试通过。
- 新增 Mobile 对应组件回归；在 `apps/mobile` 运行 `npx vitest run src/features/settings/CliProxySettingsSection.test.tsx src/features/settings/SettingsProvidersRouteScreen.logic.test.ts`：2 文件、14 测试通过（新增组件 1 项、既有设置逻辑 13 项）。使用现有 Hook harness，没有启动浏览器或设备。
- 新键同步 Web/Mobile 英、中、日文案。重新比较三语键集合：Web 各 5573 键、Mobile 各 2487 键，missing/extra 均为空，新提示值均非空。分别在 `apps/web`、`apps/mobile` 执行 `npx tsc --noEmit -p tsconfig.json`：均 0 错误；10 个 B-8 文件 `vp fmt` 完成，定向 lint 为 0 warnings / 0 errors。

### B-10：已修复（用户确认后移至仓库外归档）

- `.gitignore` 已有 `.codegraph/`、`.harn/`、`.harn-runs/`，不重复添加。`git check-ignore -v .codegraph/probe .harn/probe .harn-runs/probe` 分别命中第 48、49、50 行；这些目录未出现在 `git status --short`。
- `git grep -n -E 'apps/|packages/' -- docs/user` 无输出（退出码 1 表示无匹配），无需修改用户文档。
- 2026-10-02 用户确认“决策点按照你推荐的完成”，据此将下列五份逐轮记录归档至仓库外 `E:/MyProject/code-work-archives/review-2026-10-02-b10/`，保持原相对目录。先检查源文件与 HEAD 一致、目标不存在，再逐字节复制；五份 SHA-256 均一致后才移除仓库内副本，移除后再次校验归档。没有覆盖既有文件、改写归档内容或执行 Git 暂存/提交。

  | 原仓库路径（也是归档下的相对路径）                | SHA-256                                                            |
  | ------------------------------------------------- | ------------------------------------------------------------------ |
  | `spec/changes/paseo-provider-integration/loop.md` | `66e70fd23a68de485edfa5e6be684d04b09fd5a9d13ad852baccbc28b5bf69f5` |
  | `docs/internals/paseo-a5-keypath-r148.md`         | `210371b1fef25506811f24fcf0ca32a6f74c4ba0354c9004c1aaee9c29801e81` |
  | `docs/internals/paseo-a8-fresh-audit-r147.md`     | `8e44b0defdd17ec20e776e2bbbbc7a4f434b997fa460eca74b6f61799762ffa7` |
  | `docs/internals/paseo-a8-fresh-audit-r148.md`     | `8b090bca6cca5bcba915c4f9c8116e20b32211507b5dfb6e1a4b7d4d7d32e9d5` |
  | `docs/internals/paseo-a8-fresh-audit-r149.md`     | `802895fd4e88dd48ed1e5e5171f97fadcfdf2b9764c6ea4ce8f2a4fa880ef222` |

- 归档前按完整路径、短文件名及相对链接核对引用：五份之外仅本审查文档有说明性引用，无其他文档断链。工作树中已无 `*-r14[0-9].md` 文件及上述 loop；Git 将五份记录为待提交删除，不重写历史，旧版本仍可从 HEAD 恢复。
- 必要历史结论保留：Paseo Round 149 的 A-1…A-8 完成结论仅在当时“真实账号登录和物理手机豁免”的边界内成立；A-5 使用 Web、Electron、AVD，A-7 使用真实隔离服务的本地、LAN、TCP/产品 SSH tunnel（OR），Agent 为 mock，未验证 Connect/Tailscale。没有完成全仓检查、44 个官方 CLI 全量真实验收或官方 Gemini 真实账号成功验证。该结论不是本轮重新执行实机验收，豁免不可外推；原截图、JSON 证据和隔离环境均未删除，证据丢失或契约回退时须重新判定对应验收项。
- 归档 loop 还记载 `externalLauncher.reveal` 当时已获授权纳入、待逐模块核验；本次没有重新调查其当前完成状态，不把历史待核等同当前 bug，也不因归档将其永久排除。
- 持久约束仍由 `docs/internals/acp-provider-validation.md`、`docs/internals/paseo-provider-catalog.md`、`docs/internals/goose-acp-provider.md` 与 `docs/internals/paseo-multica-clean-room-architecture.md` 维护；本次只把必要历史结论合并至本审查文档，没有新建说明性文档，也没有扩大归档范围。

### B-11：已修复（门控验证通过，未执行实机流程）

- 36 个 CLI probe 保留原显式 opt-in，并检查真实依赖可用性；复用共享同步可执行文件解析，覆盖 PATH、Windows PATHEXT 和文件类型/权限。Gemini、MiniMax、Qwen 保留 Node 脚本启动语义，检查 Node 与可读脚本；FactoryDroid 同时要求 COMSPEC；FormerEmptyShell 的 6 个实际注册项分别检查，避免一个缺失导致其他项全部跳过。
- 4 个 A7 live 使用 `it.effect.skipIf(process.env.LIVE !== "1")`，默认不执行。CLI 默认与依赖缺失两轮均通过真实 Vitest 验证；没有导入或运行 `LIVE=1` 的实机 body。
- focused helper 17 测试通过。先写测试时因 helper 尚不存在出现 1 suite 导入失败、0 tests，不伪称为“17 个断言红”。另行内存注册行为审计：CLI 修复前 36 个缺依赖仍启用，修复后 116 项条件检查通过；LIVE 对 `undefined / "" / "0" / "true" / "1"` 的审计由 4 通过 / 16 失败变为 20 全通过。`LIVE=1` 仅求值注册条件，未执行 body。
- 默认轮彻底删除 LIVE 和所有 probe opt-in，包含 36 CLI、4 live、helper 及本轮仅格式化的 Codebuddy/Dimcode/Gajae 3 个 ToolProbe：44 文件，1 通过 / 43 跳过；17 测试通过 / 61 跳过 / 0 失败。
- 显式缺依赖轮设 LIVE=0，将 33 个 CLI_PATH、PATH、COMSPEC、EMPTY_SHELL 指向不存在位置，同时开启 Cursor/Grok opt-in 与 GROK_LIVE_TURN：41 文件，1 通过 / 40 跳过；17 测试通过 / 58 跳过 / 0 失败。证明不只是未 opt-in 才跳过，错误 CLI 路径也不会进入实机测试。
- 精确调用为下方内存命令；只读取本轮触及文件，不安装依赖、不创建验证脚本。两轮均在 Windows 执行，不能冒充 POSIX 实测或整个 server suite 通过。遵照“不全仓检查”和“不启动 dev server”，验收范围限定为触及的常规测试与门控测试；真实 CLI/live 功能未执行。

  ```sh
  node --input-type=module <<'NODE'
  import * as fs from 'node:fs';
  import * as os from 'node:os';
  import * as path from 'node:path';
  import * as crypto from 'node:crypto';
  import * as cp from 'node:child_process';
  const repo = 'E:/MyProject/code-work';
  const cwd = `${repo}/apps/server`;
  const acp = `${cwd}/src/provider/acp`;
  const orch = `${cwd}/src/orchestration`;
  const probes = fs.readdirSync(acp).filter(n => n.endsWith('AcpCliProbe.test.ts'))
    .sort().map(n => `${acp}/${n}`);
  const live = fs.readdirSync(orch).filter(n => /^A7.*\.live\.test\.ts$/.test(n))
    .sort().map(n => `${orch}/${n}`);
  const tools = cp.execFileSync('git', ['-C', repo, 'diff', '--name-only', '--',
    'apps/server/src/provider/acp/*AcpToolProbe.test.ts'], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean).map(p => `${repo}/${p}`);
  const runner = `${repo}/node_modules/.pnpm/vitest@4.1.9_@types+node@24_c7d0bcb158c80190ad8e8ed3163452ed/node_modules/vitest/vitest.mjs`;
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (/^LIVE$/i.test(key) || (/^CODEWORK_/i.test(key) &&
        /CLI_PATH|ACP_PROBE|EMPTY_SHELL|LIVE_TURN/i.test(key))) delete baseEnv[key];
  }
  const missingEnv = { ...baseEnv, LIVE: '0' };
  for (const key of Object.keys(missingEnv)) {
    if (/^(PATH|COMSPEC)$/i.test(key)) delete missingEnv[key];
  }
  const missing = path.join(os.tmpdir(), `codework-b11-absent-${crypto.randomUUID()}`);
  if (fs.existsSync(missing)) throw new Error('Expected absent dependency root');
  const cliKeys = new Set(probes.flatMap(p => [...fs.readFileSync(p, 'utf8')
    .matchAll(/process\.env\.(CODEWORK_[A-Z_]+_CLI_PATH)/g)].map(m => m[1])));
  for (const key of cliKeys) missingEnv[key] = path.join(missing, 'absent-cli.exe');
  Object.assign(missingEnv, {
    PATH: missing, COMSPEC: path.join(missing, 'absent-cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', CODEWORK_A4_EMPTY_SHELL_ROOT: missing,
    CODEWORK_CURSOR_ACP_PROBE: '1', CODEWORK_GROK_ACP_PROBE: '1',
    CODEWORK_GROK_LIVE_TURN: '1',
  });
  for (const [label, env, extra] of [
    ['DEFAULT', baseEnv, tools], ['MISSING_CLI', missingEnv, []],
  ]) {
    const files = [...probes, ...live, `${acp}/acpCliProbeGate.test.ts`, ...extra];
    console.log(label, files.length, env.LIVE ?? '(unset)');
    const result = cp.spawnSync(process.execPath, [runner, 'run', ...files],
      { cwd, env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  NODE
  ```

- 42 文件 fmt/check 通过；门控范围 lint 为 0 errors / 1 warning，FormerEmptyShell 的空对象回退在 HEAD 第 151 行已存在。server tsc 0 错误。40 个既有测试文件的 46 处注册参数/body AST、159 条注释与 HEAD 一致；没有改变断言、超时或实机流程，只增加门控。

### 整合验收记录

- 最终整合后的普通服务端定向测试：25 文件、578 测试通过、0 失败、0 跳过（包含 B-7 补修新增 14 项；此前初轮为 564）。以下命令在 `apps/server` 执行，随后 `npx tsc --noEmit -p tsconfig.json` 退出码 0、0 错误：

  ```sh
  npx vitest run src/background/HostPowerMonitor.test.ts src/background/BackgroundPolicy.test.ts src/attachmentStore.test.ts src/assets/AttachmentUpload.test.ts src/assets/ProviderBinaryAttachment.test.ts src/orchestration/Normalizer.attachments.test.ts src/imageMime.test.ts src/assets/AssetAccess.test.ts src/provider/localAccountUsage.test.ts src/provider/byok/BalanceCore.test.ts src/provider/zcode/zcodeStartPlan.test.ts src/provider/Drivers/GenericAcpDriver.test.ts src/provider/Layers/CursorAdapter.test.ts src/provider/Layers/GrokAdapter.test.ts src/provider/Layers/ProviderService.test.ts src/provider/acp/AcpAdapterSupport.test.ts src/provider/acp/AcpCoreRuntimeEvents.test.ts src/provider/acp/AcpJsonRpcConnection.test.ts src/provider/acp/AcpRegistryCatalog.test.ts src/provider/acp/AcpRuntimeModel.test.ts src/provider/acp/isolatedProbeEnvironment.test.ts src/provider/CliProxy.test.ts src/provider/LocalAccountPool.test.ts src/provider/byok/modelGateway.test.ts src/provider/byok/modelGateway.local.runtime.test.ts
  ```

- 最终整合后的 Web：12 文件、127 测试通过。以下命令在 `apps/web` 执行，随后 `npx tsc --noEmit -p tsconfig.json` 退出码 0、0 错误：

  ```sh
  npx vitest run src/i18n/runtime.test.ts src/components/settings/AcpRegistryCatalogPicker.test.tsx src/components/settings/AcpRegistryCatalogPicker.interaction.test.tsx src/components/settings/AddProviderInstanceDialog.environment.test.tsx src/components/settings/AddProviderInstanceDialog.test.ts src/components/settings/AddProviderInstanceWizardSteps.test.tsx src/components/settings/ProviderConnectionSection.test.ts src/components/settings/ProviderSettingsForm.test.ts src/components/chat/MessagesTimeline.test.tsx src/historyBootstrap.test.ts src/components/settings/CliProxySettingsSection.test.tsx src/components/settings/CliProxyLoginCard.test.tsx
  ```

- 最终整合后的 Mobile：在 `apps/mobile` 运行 `npx vitest run src/features/settings/CliProxySettingsSection.test.tsx src/features/settings/SettingsProvidersRouteScreen.logic.test.ts src/lib/threadActivity.test.ts`：3 文件、56 测试通过；随后 `npx tsc --noEmit -p tsconfig.json` 退出码 0、0 错误。
- ACP 协议：在 `packages/effect-acp` 运行 `npx vitest run src/protocol.test.ts`：1 文件、31 测试通过。
- 上述最终整合测试合计 41 文件、792 测试通过，不包含单独验证门控的外部探针；B-7 补修前初轮为 776。Cursor/Grok/GenericAcpDriver 的 mock 子进程产生既有 Node `DEP0190` 提示；Web 时间线产生既有 RouterProvider 提示，未修改配置或断言掩盖警告。没有运行已知 flaky 的 GitManager/ProviderRegistry 测试，未把它们误记为通过。
- 最终对 101 个修改源文件运行 `node_modules/.bin/vp lint --format=json <files>`：退出码 1，1 error / 5 warnings，逐项与 `git show HEAD` 源码核对均为既有，不能称为 lint 全绿。诊断为 `modelGateway.local.runtime.test.ts:735` 的 `Effect.runSync`（error）、`CliProxy.test.ts:726` 内联 Schema、`LocalAccountPool.test.ts:3` 未使用导入、`CursorAdapter.test.ts:1272` 未使用参数、`modelGateway.ts:332` 多余正则转义、`FormerEmptyShellAcpCliProbe.test.ts:155` 多余空对象回退（warnings）。没有新增 lint 诊断，没有修改规则或加入抑制。
- 最终注释核查：对 98 个已修改且原先已跟踪的源文件比较 AST 注释。只有 3 文件原位纠正文案：`LocalAccountPool.ts` 的两行默认目录描述、Web `CliProxySettingsSection.tsx` 的两行默认目录描述、`packages/contracts/src/assets.ts` 的一行外部图标描述；各文件注释数量不变，其余内容一致。没有添加或删除既有注释。
- 多端检查：B-8 的设置页入口覆盖 Web 与 Mobile，Desktop 复用 Web，无新增 Electron IPC；B-3 的共享服务端附件写盘/读取及旧文件兼容覆盖所有客户端；B-5 的可选 sourcePath 契约与两端消费已核对；B-7 覆盖 Codex/Claude/Grok/ZCode 池目录，Cursor 保留既有不支持账号池路由的边界，未改其他 Provider。没有新增线上协议字段、单向操作或硬编码 origin。依据用户限制，只更新本审查文档，没有新增用户文档或运行浏览器验证。
- 最终实际影响 108 个仓库路径：28 个功能/回归/文案文件、42 个 CLI/live 门控文件、32 个近期纯格式文件、本审查文档，以及用户确认后归档移出的 5 份逐轮记录。现存的 103 个修改/新增文件 `node_modules/.bin/vp fmt --check <files>` 无差异；5 份归档保持原字节，不对历史证据重新格式化。32 个最终纯格式文件用 TypeScript AST（忽略冗余括号）或 JSON 结构比较，与 HEAD 语义一致。没有扩展至全仓格式化。
- 修改的测试共 68 文件：24 个普通测试均出现在最终通过日志；44 个门控/外部探针测试另见 B-11，没有遗漏文件。外部依赖跳过仅限 B-11 明确授权的范围，普通测试没有 skip。
- 最终 `git diff --check` 无输出，暂存区为空，HEAD 仍为 `60054903d990abbc80711d94329594a9eb5644ea`。新增文件仅 Mobile 组件回归及门控 helper/回归 3 个必要源文件；删除状态仅为 B-10 用户确认移出的 5 份记录，仓库外副本已逐份校验。没有仓库内临时文件、未授权 commit、push 或 PR。测试临时目录由测试自行清理，诊断输出仅在系统临时目录。
- 本次决策落实只修改验收记录并归档日志，没有再次改动生产代码或测试。B-6 的 47 项定向测试重新通过；此前三端类型检查与 792 项普通测试结果仍对应同一源码，不重复全量执行。B-10 已完成，B-6 的口径决策已完成但官方配对证据仍不足，未宣称严格目标全部验收通过。

### 本轮修改文件清单

#### 功能、回归和文案（28 文件）

```text
apps/mobile/src/features/settings/CliProxySettingsSection.test.tsx
apps/mobile/src/features/settings/CliProxySettingsSection.tsx
apps/mobile/src/i18n/ja.ts
apps/mobile/src/i18n/messages.ts
apps/server/src/assets/AssetAccess.test.ts
apps/server/src/assets/AssetAccess.ts
apps/server/src/assets/AttachmentUpload.test.ts
apps/server/src/assets/AttachmentUpload.ts
apps/server/src/assets/ProviderBinaryAttachment.test.ts
apps/server/src/assets/ProviderBinaryAttachment.ts
apps/server/src/attachmentStore.test.ts
apps/server/src/attachmentStore.ts
apps/server/src/background/HostPowerMonitor.ts
apps/server/src/provider/CliProxy.test.ts
apps/server/src/provider/CliProxy.ts
apps/server/src/provider/LocalAccountPool.test.ts
apps/server/src/provider/LocalAccountPool.ts
apps/server/src/provider/byok/modelGateway.local.runtime.test.ts
apps/server/src/provider/byok/modelGateway.test.ts
apps/server/src/provider/byok/modelGateway.ts
apps/server/src/provider/localAccountUsage.test.ts
apps/web/src/components/settings/CliProxyLoginCard.test.tsx
apps/web/src/components/settings/CliProxyLoginCard.tsx
apps/web/src/components/settings/CliProxySettingsSection.test.tsx
apps/web/src/components/settings/CliProxySettingsSection.tsx
apps/web/src/i18n/ja.ts
apps/web/src/i18n/messages.ts
packages/contracts/src/assets.ts
```

#### 外部依赖门控（42 文件）

```text
apps/server/src/orchestration/A7OrchestrationMediated.live.test.ts
apps/server/src/orchestration/A7RemoteLan.live.test.ts
apps/server/src/orchestration/A7SshProductTunnel.live.test.ts
apps/server/src/orchestration/A7TunnelForward.live.test.ts
apps/server/src/provider/acp/AgoragenticAcpCliProbe.test.ts
apps/server/src/provider/acp/AmpAcpCliProbe.test.ts
apps/server/src/provider/acp/AuggieAcpCliProbe.test.ts
apps/server/src/provider/acp/AutohandAcpCliProbe.test.ts
apps/server/src/provider/acp/ClaudeAcpCliProbe.test.ts
apps/server/src/provider/acp/ClineAcpCliProbe.test.ts
apps/server/src/provider/acp/CodeWhaleAcpCliProbe.test.ts
apps/server/src/provider/acp/CodebuddyAcpCliProbe.test.ts
apps/server/src/provider/acp/CodexAcpCliProbe.test.ts
apps/server/src/provider/acp/CopilotAcpCliProbe.test.ts
apps/server/src/provider/acp/CursorAcpCliProbe.test.ts
apps/server/src/provider/acp/DeepagentsAcpCliProbe.test.ts
apps/server/src/provider/acp/DimcodeAcpCliProbe.test.ts
apps/server/src/provider/acp/DiracAcpCliProbe.test.ts
apps/server/src/provider/acp/FactoryDroidAcpCliProbe.test.ts
apps/server/src/provider/acp/FastAgentAcpCliProbe.test.ts
apps/server/src/provider/acp/FormerEmptyShellAcpCliProbe.test.ts
apps/server/src/provider/acp/GajaeAcpCliProbe.test.ts
apps/server/src/provider/acp/GeminiAcpCliProbe.test.ts
apps/server/src/provider/acp/GlmAcpCliProbe.test.ts
apps/server/src/provider/acp/GooseAcpCliProbe.test.ts
apps/server/src/provider/acp/GrokAcpCliProbe.test.ts
apps/server/src/provider/acp/GrokBuildAcpCliProbe.test.ts
apps/server/src/provider/acp/HarnAcpCliProbe.test.ts
apps/server/src/provider/acp/HermesAcpCliProbe.test.ts
apps/server/src/provider/acp/KiloAcpCliProbe.test.ts
apps/server/src/provider/acp/KimchiAcpCliProbe.test.ts
apps/server/src/provider/acp/MinimaxAcpCliProbe.test.ts
apps/server/src/provider/acp/MinionCodeAcpCliProbe.test.ts
apps/server/src/provider/acp/MistralVibeAcpCliProbe.test.ts
apps/server/src/provider/acp/NovaAcpCliProbe.test.ts
apps/server/src/provider/acp/PiAcpCliProbe.test.ts
apps/server/src/provider/acp/PoolsideAcpCliProbe.test.ts
apps/server/src/provider/acp/QoderAcpCliProbe.test.ts
apps/server/src/provider/acp/QwenAcpCliProbe.test.ts
apps/server/src/provider/acp/SigitAcpCliProbe.test.ts
apps/server/src/provider/acp/acpCliProbeGate.test.ts
apps/server/src/provider/acp/acpCliProbeGate.ts
```

#### 近期纯格式文件（32 文件）

```text
apps/mobile/src/lib/threadActivity.ts
apps/server/scripts/acp-mock-agent.ts
apps/server/scripts/tcp-forward-tunnel.mjs
apps/server/src/provider/Drivers/GenericAcpDriver.test.ts
apps/server/src/provider/Layers/CursorAdapter.test.ts
apps/server/src/provider/Layers/CursorAdapter.ts
apps/server/src/provider/Layers/GrokAdapter.test.ts
apps/server/src/provider/Layers/GrokAdapter.ts
apps/server/src/provider/Layers/ProviderService.test.ts
apps/server/src/provider/Layers/ProviderService.ts
apps/server/src/provider/acp/AcpAdapterSupport.test.ts
apps/server/src/provider/acp/AcpAdapterSupport.ts
apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts
apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
apps/server/src/provider/acp/AcpRegistryCatalog.test.ts
apps/server/src/provider/acp/AcpRuntimeModel.test.ts
apps/server/src/provider/acp/AcpRuntimeModel.ts
apps/server/src/provider/acp/AcpSessionRuntime.ts
apps/server/src/provider/acp/CodebuddyAcpToolProbe.test.ts
apps/server/src/provider/acp/DimcodeAcpToolProbe.test.ts
apps/server/src/provider/acp/GajaeAcpToolProbe.test.ts
apps/server/src/provider/acp/XAiAcpExtension.ts
apps/server/src/provider/acp/isolatedProbeEnvironment.test.ts
apps/server/src/provider/acp/isolatedProbeEnvironment.ts
apps/server/src/provider/acp/registry-snapshot.json
apps/web/src/components/chat/MessagesTimeline.test.tsx
apps/web/src/components/chat/MessagesTimeline.tsx
apps/web/src/historyBootstrap.ts
packages/effect-acp/scripts/generate.ts
packages/effect-acp/src/_generated/schema.gen.ts
packages/effect-acp/src/protocol.test.ts
packages/effect-acp/src/protocol.ts
```

#### 验收记录（1 文件）

- `docs/internals/review-2026-10-02-recent-changes.md`：仅在末尾追加本节修复结果、命令、限制和文件清单，原审查结论保留作为历史基线。

#### 用户确认后归档移出（5 文件）

下列仓库路径记录为删除；完整副本位于 `E:/MyProject/code-work-archives/review-2026-10-02-b10/` 下同一相对路径，SHA-256 见 B-10。

```text
spec/changes/paseo-provider-integration/loop.md
docs/internals/paseo-a5-keypath-r148.md
docs/internals/paseo-a8-fresh-audit-r147.md
docs/internals/paseo-a8-fresh-audit-r148.md
docs/internals/paseo-a8-fresh-audit-r149.md
```
