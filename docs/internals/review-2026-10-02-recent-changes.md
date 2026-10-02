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
