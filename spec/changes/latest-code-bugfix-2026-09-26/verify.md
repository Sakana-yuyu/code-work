# 最终独立审计：latest-code-bugfix-2026-09-26

conclusion: pass

findings: []

审计日期：2026-09-26，Asia/Shanghai；本次独立命令证据采集于 16:12–16:17，收尾保护检查时间为 16:17:35。审计对象 HEAD：`50e71e8ed13827a4001c11c8e154d4372c33d366`。结论只覆盖下列 12 个文件、六项已确认问题及 A-1 至 A-4，不代表全仓无 bug，也不代表真实 UI、设备或供应商环境验收通过。

## 前置说明与范围

审计者为未参与实现的全新上下文 spec-verifier。完整阅读了本变更 `loop.md` 的 Acceptance、Round 1–7 和 Lessons，根 `AGENTS.md`，以及已安装 spec-core 的 `references/code-charter.md`。本变更是轻量 spec-loop，按轮次决策记录核验，不要求补造 proposal、index 或 design；`spec/knowledge.md` 不存在，故无独立 ruling 子文档可读。复用检查以实际调用链和轮次中的责任检索记录为准。

本次没有修改产品和测试文件，没有改 `loop.md`。只写本报告；临时日志、旧实现快照及 Git 同步验证副本均位于：

`C:/Users/Administrator/AppData/Local/Temp/codework-final-audit-20260926-161203/`

原有用户文件保护基准和交付清单来自 `C:/Users/Administrator/AppData/Local/Temp/codework-bugfix-01a0dcac/` 的 `preserved-files.json`、`final-review-files.json`，由审计者重新计算哈希核对，而非直接采信实现方结果。

逐一阅读的完整差异为 11 个 tracked 文件，加 1 个新增未跟踪测试：

| 产品文件                                                        | 对应本次测试文件                                                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/composition/ToolBroker.ts`                     | `apps/server/src/composition/ToolBroker.test.ts`                                                                                                                             |
| `apps/server/src/composition/ByokAgentLoop.ts`                  | `apps/server/src/composition/ByokAgentLoop.test.ts`、`apps/server/src/composition/CompositionByokAgentDriver.test.ts`、`apps/server/src/provider/Layers/ByokAdapter.test.ts` |
| `apps/server/src/provider/byok/ByokModelDiscoveryService.ts`    | `apps/server/src/provider/byok/ByokModelDiscoveryService.test.ts`                                                                                                            |
| `apps/web/src/components/settings/ByokModelAdaptersSection.tsx` | `apps/web/src/components/settings/ByokModelAdaptersSection.save.test.tsx`（新增）                                                                                            |
| `apps/mobile/src/lib/threadActivity.ts`                         | `apps/mobile/src/lib/threadActivity.test.ts`                                                                                                                                 |

## A-N 逐项验收

| 验收项                       | 判定 | 独立证据与适用边界                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 安全同步并保留原文件     | pass | 当前工作区 HEAD、origin/main 与新执行的 `git ls-remote origin refs/heads/main` 全部一致，均为上述 SHA；原有 15 个文件 SHA-256 全部不变。为遵守只读审计，没有在产品工作区再次执行 pull；在从当前 HEAD 创建的独立 Git 元数据副本中，实际运行 `git pull --ff-only origin main`，退出 0，输出 `Already up to date.`，副本 HEAD/origin/main 同样一致。原工作区 Round 1 的历史 pull 记录与当前同步后置条件一致，但本报告不把历史命令冒充为本次在产品工作区执行。 |
| A-2 调用链排查及真实回归     | pass | 六类问题均有明确输入、根因、影响范围，见下表。独立 `git archive HEAD` 快照保留旧产品源码，仅复制当前回归测试；新用例选择结果为 19 failed、2 passed、132 skipped。失败均为目标行为断言，没有依赖缺失或运行环境错误。当前源码相同测试包含在 313 项全部通过的独立运行中。                                                                                                                                                                                     |
| A-3 相关测试、包级检查、格式 | pass | 14 文件 313 项通过，另 TerminalManager attach 7 项通过；Server/Web 正式 tsgo、Mobile 正式 tsc 均退出 0；12 文件格式检查与 `git diff --check` 退出 0。Mobile 额外 tsgo 为基线既存失败，详见专节，未宣称通过。没有执行全仓检查。                                                                                                                                                                                                                             |
| A-4 独立终审和边界说明       | pass | 已独立复核 A-1 至 A-3、全部交付 diff、相关调用方和取消/错误/终态边界。没有经反驳阶段后仍存续的实际缺陷；未执行的环境验证在末节列出。本报告完成后，主线程才可据此更新 A-4；审计者未提前勾选。                                                                                                                                                                                                                                                               |

## 六项问题与调用链复核

| 问题及定位                                             | 输入、原根因与影响                                                                                                                                                                                     | 当前行为与独立证明                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 终端增量等待，`ToolBroker.ts:510`                      | 命令启动快照为空，后续只有 output/exited/error/closed 等增量。旧实现仅接受终态 snapshot，8 秒后交还旧快照，且取得退订函数的取消边界可能漏退订。影响所有使用同一 canonical `terminal.exec` 的执行路径。 | 检查真实 `TerminalManager.attachStream`（`Manager.ts:3650`）、事件转换、去重窗口及合同。最新快照按增量更新；错误/关闭进入现有失败路径；超时仍明确返回 running 最新状态；`acquireRelease + scoped` 覆盖释放。旧实现六项失败，当前六项通过；结果包含即时完成时间、非零退出码、元数据及一次退订断言。另真实 Manager attach 七项通过。                                                           |
| 重复命令误报成功，`ByokAgentLoop.ts:705`               | 同一命令第四次调用被拦截后，旧 Loop 正常返回，调用方发布 completed；同一批次之后的写入工具仍会执行。                                                                                                   | Loop 使用已有 `ByokAgentModelError` 失败退出，保留失败工具回调。核对只读并发分段与副作用工具串行屏障，terminal.exec 不在并行只读集合中，失败阻止后续 segment。真实 `ByokAdapter` 与 `CompositionAgentService → CompositionByokAgentDriver` 均发布 runtime.error/failed；现有 `CompositionFailurePolicy` 对该错误不自动重试。旧实现三个回归失败，当前均通过。                                 |
| 目录缓存跨凭据复用，`ByokModelDiscoveryService.ts:169` | 相同实例/适配器/地址换 API Key 或自定义头，原 fingerprint 不变；普通命中和强制刷新失败回退都可能返回旧账号目录。                                                                                       | fingerprint 纳入 API Key/customHeaders 并存 SHA-256 摘要；两个缓存入口继续使用同一 fingerprint。核对 Web/Mobile forceRefresh 到共享 RPC `ws.ts:2686` 的实际调用路径。四个换凭据/换头、成功/失败回归旧实现均失败，当前通过，同凭据缓存与错误披露保持既有行为。并发旧请求即使较晚写回，其旧 fingerprint 也不能被新凭据调用命中或回退；未增加并发缓存层。                                       |
| 保存覆盖目录，`ByokModelAdaptersSection.tsx:1122`      | 目标未变、仅编辑名称时，原对象顺序使模板覆盖保存的目录列表、manual_only 和 false；空数组同样被覆盖。                                                                                                   | 只调换默认值和既有值的合并顺序；沿用 `canRetainByokAdapterCredentials` 的供应商/协议/地址边界。通过实际编辑和保存回调检查 onChange：旧实现保留自定义目录、保留空目录两项失败；目标变化和默认值两项本来通过；当前四项全通过。共享凭据边界及 Mobile 对应逻辑回归也通过。                                                                                                                       |
| 无调用 ID 跨回合合并，`threadActivity.ts:562`          | 相邻回合的无调用 ID 同名工具具有相同 collapseKey，原实现合并了两个回合。                                                                                                                               | 复用 Web `session-logic.ts:1306` 的 turnId 相等条件；下一回合 started/completed 两种输入在旧实现失败，当前均保留两条记录。同回合既有生命周期回归保持通过。                                                                                                                                                                                                                                   |
| 折叠隐藏运行/失败项，`threadActivity.ts:1466`          | 多个活动中旧实现直接 slice 仅留最后一项，运行中的工具及失败详情被隐藏。                                                                                                                                | 单次遍历保留 inProgress、failure 和最新活动，只统计实际可隐藏旧项，没有隐藏项便不生成空展开按钮。核对 `use-thread-composer-state → buildThreadFeed → ThreadFeed → deriveThreadFeedPresentation` 及展开/收起状态更新。有/无旧成功记录两项在旧实现失败，当前通过，包含失败详情和展开后顺序断言；既有大数据惰性详情回归也通过。历史整回合折叠规则未改，本结论不将其扩写为所有历史回合永久展开。 |

## Mobile 编译器更正

直接读取三个包的 `package.json` 后确认：Server/Web 的 `typecheck` 是 `tsgo --noEmit`，Mobile 是 `tsc --noEmit`。Round 7 修正的是执行工具名称，维持了用户“受影响包类型检查”的验收目标。没有改 package.json、tsconfig、文件包含范围或诊断屏蔽，因此该更正可接受。

审计者分别重新执行当前 Mobile 和 `mobile-head-50e71e8/apps/mobile` 的额外 `tsgo --noEmit`，均退出 1、69 条导航参数被推导为 never 的诊断。使用 `git ls-tree -r HEAD apps/mobile` 取得对象清单，逐个按 Git blob 规则计算快照中 788 个文件的 SHA-1：788 项匹配，0 项差异。快照的依赖及 packages/scripts junction 仅用于模块解析。

本次新日志 `mobile-current-extra.log` 和 `mobile-head-extra.log` 的 SHA-256 相同：

`5F5E5BA50068E98EFDA21994E416FB5AF447AFFC5B2E1AC75DD4CB87E7680529`

因此这里只认定“Mobile 正式 tsc 通过；额外 tsgo 既存失败且本次没有增加诊断”，不认定 tsgo 通过。

## 章程、范围和复用审计

defended:

- 8 秒无输出仍返回 running 快照 → `loop.md` Round 2 Act/Verify 明确决定，状态和最新元数据可见；没有把进程结束或成功伪造成已发生。error/closed 则显式失败。
- 同凭据刷新失败使用旧目录 → 本次未新增的 `ByokModelDiscoveryService.ts:397` 分支，Round 4 明确保留；返回 stale=true 且携带 error。新增 fingerprint 只限制跨凭据误用，没有静默查询改道。
- fingerprint 中旧字段的空值默认 → 与原 diff 对照属原逻辑搬入摘要；新增 customHeaders 的空串表示无自定义头，未捕获任何执行错误或制造业务结果。
- 定向 lint 警告 → 当前和旧源码快照各 41 条、退出 0，去除行列号后排序比较 0 差异；ByokAdapter 旧测试可选链还经 git blame 确认来自已有提交。它们不属于本次新增缺陷。
- 没有 UI 截图 → 用户明确排除浏览器/设备验证，未要求为满足通用截图流程越界启动。组件回调和派生逻辑测试不能替代真实视觉验收，列为环境边界。

机器规则配置已定位到 `C:/Users/Administrator/.codex/plugins/cache/spec-workflow/spec/0.9.0/skills/spec-core/rules/sgconfig.yml`；当前 `Get-Command ast-grep` 与 `Get-Command sg` 均无结果。

not run: ast-grep not installed (scoop install main/ast-grep / npm i -g @ast-grep/cli)

按章程要求对 changed diff 和新增测试人工检索/复核 catch、fallback、`||`、`??`、默认返回和新旧逻辑并存。新增逻辑未发现吞错后成功返回、无授权写入回退、隐藏查询改道或保留旧逻辑作为失败兜底。`DEVLOG:` 在 diff 和新增测试中均为 0。

没有新增生产类、公共 helper、组件、页面、依赖、合同、配置开关、权限校验或数据库结构。唯一新增文件是保存行为回归，复用 `reactHookHarness`、`reactElementTree`，与相邻 `CliProxySettingsSection.test.tsx:3`、`ProviderConnectionSection.login.test.tsx:3` 的模式一致。终端客户端 reducer 虽承担显示缓冲处理，但不保留完整返回快照的 PID/退出信息，不能直接替代本次等待逻辑；该复用检索已由 Round 2 记录并经源码确认。SHA-256 写法复用相邻 `ByokBalanceService.ts:123`；Mobile 回合判断复用 Web 同层逻辑。所有行为修改可追溯到 Round 1 的六条线索及 Round 2–6 的明确实施决定，未发现无来源扩展。

反驳流程已完成：先列出超时、缓存回退、警告和缺失截图等可疑项，再核对上述代码归属与明确决策，最后无存续 finding。没有把未执行项或先前缺陷编造成当前变更的新缺陷。

## 实际验证命令与关键结果

以下命令由审计者本次执行；`vp`/编译器均使用仓库 `node_modules/.bin/*.cmd`，没有使用全仓递归检查。

1. `git status --short`、`git diff --name-only`、`git diff --stat`、分组 `git diff -- <12 文件中的 tracked 文件>` 及 `Get-Content` 新增测试：完整检查 11 个 tracked 差异和新增测试，其余 untracked 未纳入源码交付。
2. `git rev-parse HEAD origin/main` 与 `git ls-remote origin refs/heads/main`：退出 0，三个引用均为本报告 HEAD。
3. 对两个 JSON 清单逐项运行 `Get-FileHash -Algorithm SHA256`：`preserved: 15/15 unchanged`、`delivery: 12/12 unchanged`。
4. `git clone --no-checkout --shared E:/MyProject/code-work <审计目录>/sync-proof`，在副本设置与原仓库相同 origin 后执行 `git -C <副本> pull --ff-only origin main`、`git -C <副本> rev-parse HEAD origin/main`：全部退出 0，Already up to date，无原工作区 Git 状态或源码改写。
5. 下列定向测试命令退出 0，14 文件、313 项通过，完整日志 `tests.log`：

```powershell
.\node_modules\.bin\vp.cmd test run apps/server/src/composition/ToolBroker.test.ts apps/server/src/composition/ToolBroker.persistence.test.ts apps/server/src/composition/ByokAgentLoop.test.ts apps/server/src/composition/CompositionAgentService.test.ts apps/server/src/composition/CompositionByokAgentDriver.test.ts apps/server/src/provider/Layers/ByokAdapter.test.ts apps/server/src/provider/byok/ByokModelDiscoveryService.test.ts apps/server/src/provider/byok/ModelCatalog.test.ts apps/web/src/components/settings/ByokModelAdaptersSection.save.test.tsx apps/web/src/components/settings/ByokModelAdaptersSection.test.ts packages/client-runtime/src/byok/credentialScope.test.ts apps/mobile/src/features/settings/SettingsByokRouteScreen.logic.test.ts apps/mobile/src/lib/threadActivity.test.ts apps/web/src/session-logic.test.ts
```

6. `.\node_modules\.bin\vp.cmd test run apps/server/src/terminal/Manager.test.ts -t 'attach'`：退出 0，7 项通过、65 项按过滤条件未执行。
7. 在 `apps/server` 与 `apps/web` 各运行 `..\..\node_modules\.bin\tsgo.cmd --noEmit`，在 `apps/mobile` 运行 `..\..\node_modules\.bin\tsc.cmd --noEmit`：均退出 0，无诊断。日志分别为 `server-typecheck.log`、`web-typecheck.log`、`mobile-typecheck.log`。
8. 从 `final-review-files.json` 读取精确 12 路径，运行 `.\node_modules\.bin\vp.cmd fmt --check @files`：退出 0，`All matched files use the correct format`，12 files；`git diff --check`：退出 0。
9. 当前工作区和旧源码快照分别运行 `.\node_modules\.bin\vp.cmd lint @files`：均退出 0，各 41 条警告。`Compare-Object` 比较去行列号并排序后的日志，message differences=0。日志 `lint-current.log`、`lint-head.log`。
10. 使用 `git archive --format=tar --output=<审计目录>/head-regression.tar HEAD apps/server apps/web apps/mobile/src apps/mobile/package.json apps/mobile/tsconfig.json package.json vite.config.ts tsconfig.base.json pnpm-workspace.yaml`、`tar -xf ... -C <审计目录>/head-regression` 创建快照，仅链接相同依赖及未修改的 packages/scripts/oxlint 配置，并复制 7 个当前测试文件。`git hash-object <五个旧产品文件>` 对照 `git ls-tree HEAD <同五路径>`：五项全部一致。随后在快照根运行：

```powershell
.\node_modules\.bin\vp.cmd test run apps/server/src/composition/ToolBroker.test.ts apps/server/src/composition/ByokAgentLoop.test.ts apps/server/src/composition/CompositionByokAgentDriver.test.ts apps/server/src/provider/Layers/ByokAdapter.test.ts apps/server/src/provider/byok/ByokModelDiscoveryService.test.ts apps/web/src/components/settings/ByokModelAdaptersSection.save.test.tsx apps/mobile/src/lib/threadActivity.test.ts -t 'terminal.exec 等待增量|重复命令保护|隔离模型目录缓存|适配器保存目录配置|无调用 ID|折叠保留运行'
```

退出 1，7 文件，19 failed、2 passed、132 skipped（有意定向过滤）；完整读取 `head-red.log`，确认失败点正是原行为差异。

11. 在当前与基线 Mobile 目录运行 `E:/MyProject/code-work/node_modules/.bin/tsgo.cmd --noEmit`：均退出 1；完整读取两个日志、`Select-String ': error TS'` 计数各 69，`Get-FileHash` 哈希相同。`git ls-tree -r HEAD apps/mobile` 加逐文件 blob SHA-1 核对：788 checked，0 mismatches。
12. 章程工具定位：`Get-ChildItem ~/.codex/plugins/cache, ~/.agents/skills -Recurse -Filter sgconfig.yml`；CLI 检测 `Get-Command ast-grep,sg -ErrorAction SilentlyContinue`；人工模式检查 `git diff -- @files | Select-String` 及新增测试检索；两处 DEVLOG 计数均为 0。部分初始路径检索命中了不存在的候选文件，随后用 `rg --files` 纠正至实际 `packages/client-runtime/src/state/terminalSession.ts`、`apps/mobile/src/state/use-thread-composer-state.ts`、`apps/server/src/ws.ts`；没有将路径缺失算作通过。
13. 只读责任与边界检查使用 `rg -n`、`Get-Content`、`git blame`：包括 Loop 全部产品调用方、TerminalManager/合同/reducer、发现服务缓存两入口及两端 RPC、凭据保留 helper、Mobile feed/展开状态、Web 对应生命周期判断、相邻测试 harness、Balance 指纹、三个 package.json 与 usage.md。差异 hunk 与 blame 决定归属，未把整文件先前问题混入本次 finding。
14. 报告写入后再次按两个清单运行 SHA-256 核对：原有 15/15、交付 12/12 不变；`git diff --check` 退出 0，HEAD 不变。报告 UTF-8 严格解码成功，BOM=False。

## 未执行环境验证与风险边界

- 未启动浏览器、Electron、模拟器、真机、开发服务器或真实供应商；没有截图、视觉布局、实时流畅度、真实 PTY 端到端以及本地/远程/relay/tunnel 实机证据。测试使用已有 Layer、可控事件与本地 HTTP 替身。
- 未运行全仓 test/typecheck/check，也未构建安装包。正式类型检查覆盖的是受影响 Server/Web/Mobile 三包；Agent 与 UI 结论限于上述调用链和定向回归。
- 未读取或使用 live `~/.t3/userdata`，未写运行数据库；没有支付/余额算法、生产发布、推送、PR 或 OTA 操作。
- ast-grep 未安装，已执行指定人工后备审计；不能将此写为 AST 规则扫描通过。Mobile 额外 tsgo 的 69 条既存诊断保留为明确工具边界。
- 回退本批产品修改不需要数据迁移；若后续决定撤销，应只撤销本报告列出的产品/测试差异并保留用户其他工作，本次审计没有执行回退。

pending live check: 用户以后另行授权时，可对真实 Web/桌面保存操作、Mobile 工具可见性与展开收起、真实终端增量及网络断连执行环境验收；这些本轮明确排除的项目不作为本次 pass 的证据。
