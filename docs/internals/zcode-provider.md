# ZCode Provider

ZCode（[zai-org/ZCode](https://github.com/zai-org/ZCode)）以 `zcodeAgent` 驱动接入，支持官方登录与 BYOK 两种形态；BYOK 模式经本地网关使用共享线路及账号池，官方模式使用实例自己的官方登录。

## 账号形态

`config.authMode` 决定实例用谁的模型：

- `byok`（默认）：写指向 Code Work 网关的个人 Provider 配置，见下文 BYOK 一节。
- `official`：登录的官方 Coding Plan 账号。登录不再调用 zcode CLI，而是服务端
  原生复刻其 OAuth 流程（`server.zcodeLogin` RPC，`provider/zcode/zcodeLoginFlow.ts`）：
  `POST zcode.z.ai/api/v1/oauth/cli/init` 拿授权 URL 展示给用户，后台轮询
  `oauth/cli/poll/<flowId>`；ready 后按上游 `coding-plan-api-key.ts` 的 biz 流程
  （zai 先 `/api/auth/z/login` 换 biz token；bigmodel 直接用 OAuth token）找/建
  `zcode-api-key` 并取回 `secretKey` 拼出 Coding Plan API Key。凭据按 CLI 完全
  一致的格式写 `<受管根>/.zcode/v2/credentials.json`（AES-256-GCM `enc:v1:`，
  密钥派生自 OS 用户主目录/用户名，本机同用户可解密）。官方模型固定为
  `account:<family>-individual-coding-plan` 下的 GLM-5.3/5.3-Flash/5.2/5-Turbo；
  `defaultModelSelection` 指向内置 Provider，受管的 codework-\* Provider 声明保留，
  切回 BYOK 不丢配置。快照用凭据文件上报登录态与账号名/邮箱。

## 传输：每轮一个进程

ZCode 没有 ACP。适配器每轮启动 `zcode --prompt=<文本> --output-format stream-json --mode <mode> --cwd <dir> [--resume <sessionId>] [--attach <图片>]`：

- **运行时解析**（`zcodeBundledRuntime.ts`）：显式 `binaryPath` → 内嵌 bundle → PATH。
  内嵌 bundle 是 `apps/server/vendor/zcode/zcode.cjs`（上游 `pnpm cli:build` 产出的
  ~30MB 单文件 esbuild bundle，vendored 授权文件 LICENSE/NOTICE/THIRD-PARTY-NOTICES
  随带），首次使用释放到 `<stateDir>/bin/zcode/`（`source.sha` 记 `size-mtime` 标记），
  经 `process.execPath` 执行——桌面端是 Electron 可执行文件，spawn 环境附带
  `ELECTRON_RUN_AS_NODE=1`；开发态下 execPath 即 node。打包时
  `build-desktop-artifact.ts` 把 `apps/server/vendor` 一并放入 server.asar。

- 用 `node scripts/vendor-zcode.mjs <ZCode 仓库> [--source-ref <branch|tarball>]` 刷新
  vendored 运行时：它跑上游 `pnpm install` + `apps/zcode-cli` 的 build，拷贝上面五个文件，
  并写 `vendor/zcode/VERSION.json`（产品版本 / CLI 版本 / Built-in Provider 配置 revision /
  `sourceRef`）。内嵌运行时不跑 `--version` 探针，供应商卡片显示的版本就来自这份清单
  （`readZCodeBundleVersion`）；所以刷新 vendor 目录后必须同一次提交带上 VERSION.json。

  `sourceRef` 只记录能被独立核对的来源。**注意 `git -C` 会穿透到外层仓库**：tar 包解出来的
  上游目录没有 `.git`，`git -C <dir> rev-parse HEAD` 不会失败，而是回退到包含它的仓库（也就是
  本仓库），于是清单里会写进一个和 ZCode 毫无关系的 commit——历史清单里的 `3473c21` 就是这么
  来的（该 commit 在 `zai-org/ZCode` 中不存在）。脚本现在先用 `--show-toplevel` 确认源目录
  本身就是工作树根，否则跳过 commit 并要求显式 `--source-ref`。

  `provider/zcode-builtin.json` 取的是 CLI 构建产物，可能混入 test 环境的配置叠加（表现为
  同一条 `providerSiteRules` 出现两次）。它必须与上游 `config/provider/zcode-builtin.json`
  对齐：同 `revision` 时用 `git hash-object` 比对 blob 哈希即可确认。脚本对重复规则只告警，
  不擅自改写上游数据。

- 释放布局必须保留 `provider/zcode-builtin.json` 的**相对位置**：ZCode 的
  `resolveBundledZCodeBuiltinProviderConfig` 只在「入口同级的 `provider/zcode-builtin.json`」
  与「入口上溯五级的 `config/provider/zcode-builtin.json`」两个候选里找，找不到就抛
  "无法定位 CLI ZCode Built-in Provider Config"。`<stateDir>/bin/zcode/zcode.cjs` +
  `<stateDir>/bin/zcode/provider/zcode-builtin.json` 正好命中第一个候选（实测
  stderr 打印 `ZCode Built-in skipped (not-due)`；同步器报 `missing` 是 CDN 刷新没拿到
  release，与本地布局无关）。

- stdout 逐行输出会话事件信封（`type` / `sessionId` / `turnId` / `payload`，形状同 ZCode 协议的 `mapSessionEvent`），最后一行 `type:"result"` 收尾。`result` 帧的 `usage` / `projection` 挂在**顶层**，不在 `payload` 里。
- 会话 id 取自事件信封的 `sessionId`，存为 resume 游标 `{ zcodeSessionId }`，下一轮用 `--resume` 续接。
- 事件映射：
  - `model.streaming`：`text_delta` / `reasoning_delta` → `content.delta`；`tool_input_start/delta/end` → `item.started` + `item.updated`。参数 delta 是**不完整 JSON 片段**，适配器累计后只在「已能解析且序列化结果变了」时发一次更新（指纹去重），超过 4KB 停止预览（完整入参由随后的 `tool.updated` 补上）。若 `tool.updated/scheduled` 来得晚，参数流已经开过行，则改发 `item.updated`，避免同一 `toolCallId` 落两条 `tool.started`。
  - `tool.updated`（`scheduled` / `started` / `progress` / `result` / `error`）→ `item.started/updated/completed`，摘要优先展示命令原文。
  - `session.titleUpdated` → `thread.metadata.updated{name}`，丢弃占位标题（`New session` 等）；写入侧 `canReplaceThreadTitle` 保证只覆盖仍是默认标题的线程。`title` 的 `source` 字段（`default`/`first_input`/`generated`/`custom`）不参与判断。
  - `permission.requested` → **一次性 `runtime.warning`**，不映射成 `request.opened`。无头 `-p` 加载的是 `createHeadlessPermissionBroker`：只有 `CreateWorkflow`/`AmendWorkflow` 放行，其余一律交给 deny broker 直接拒绝，没有任何界面能让人批准。开成交互审批只会留下永远挂起的卡片。
  - `turn.completed` / `turn.failed` / `result` / 进程退出 → 终态。无流式增量时用 `turn.completed.response` 兜底。
- 用量每回合**只发一条** `thread.token-usage.updated`，在 `result` 帧落地时发出：
  - `projection.contextUsed` → `usedTokens`（上下文占用，进度条读的就是它）、`projection.contextWindow` → `maxTokens`、`projection.totalTokenCount` → `totalProcessedTokens`（线程累计账单）。上游 `contextUsed` 只累计 `main_turn` 的 ModelComplete，标题生成/压缩/子代理都被排除。
  - `turn.completed.usage`（`ModelUsageSummary`，本回合口径）提供 `inputTokens`/`outputTokens`/`cachedInputTokens`/`reasoningOutputTokens`/`toolUses`/`durationMs` 与对应 `last*`，先记账、等 `result` 到达时合并成一条。**不能**把 `usage.totalTokens` 当 `usedTokens`：那是本回合计费量，会让上下文进度条显示成个位数。
  - 也不把 `tokenCount` 填 `totalProcessedTokens`：它是每回合的量，填进累计字段会让「本轮比上轮省 token」被下游的回退守卫整条丢弃。
  - 只发一条是为了 `deriveModelResponseCount`：客户端按 `context-window.updated` 行数算「N 步」，多发一条就凭空翻倍。
- 运行时模式映射到 `--mode`：`full-access` → `yolo`，`auto*` → `edit`，其余 → `build`，计划模式 → `plan`。
- 中断 = 发出 `turn.aborted` 并终止本轮进程；上一轮进程的退出帧不会结算下一轮。进程未走到 `result` 就退出（崩溃/被杀）时补发已记账的用量。

### 模型绑定：换模型必须换线程

ZCode 没有 `--model`；会话选中的 Provider/Model 落在它自己的会话库里，`--resume` 时以会话库为准。上游 `bootstrap/src/app/runtime-config.ts` 在 resume 时不套用 `configuredDefaultModelSelection`，因此**改写 `provider_config.json` 的 `defaultModelSelection` 只影响新建会话**。

真实二进制（上游 0.17.0，本地探针 Provider 记录请求 model）验证：首轮按配置用 `probe-model`；把 `defaultModelSelection` 改成 `probe-model-b` 后 `--resume`，请求仍然是 `probe-model`。

所以适配器声明 `sessionModelSwitch: "unsupported"`，并让 `zcodeAgent` 快照带 `requiresNewThreadForModelChange: true`：客户端在已落地线程上换模型直接拦成"换新线程"，服务端 `sendTurn` 在 `zcodeSessionId` 存在且所选模型与会话模型不同时 fail-closed，绝不按旧模型静默跑一轮。

## BYOK 与号池

- 受管数据根 `ZCODE_DATA_BASE_DIR = <stateDir>/provider-homes/zcode/instance-<id>`；个人 Provider 配置固定写在 `<根>/.zcode/v2/provider_config.json`（schemaVersion 1，形状取自 ZCode 的 `provider-config-file-codec`）。
- 配置把网关注册为三个个人 Provider：`codework-anthropic`（anthropic-messages）、`codework-openai`（openai-chat-completions）、`codework-responses`（openai-responses，号池里的 Codex 官方账号只有 Responses 上游）。
- ZCode 没有 `--model`：每轮启动前按所选通道重写 `defaultModelSelection`（只对新建会话生效，见上）。
- 环境清洗：剥掉第三方密钥与 `ZCODE_*_PROVIDER_CONFIG_FILE`，避免 CLI 连上自己的账号。
  注意这条只清洗**进程环境**：ZCode 在 `--prompt` 路径还会用 `dotenv`（`override: false`）
  读取 `--cwd` 目录的 `.env`。实测个人 Provider 配置里的 `api-key` 优先，`.env` 里的
  `ZCODE_API_KEY` / `OPENAI_API_KEY` 不会改写已验证的请求目标与鉴权头；但被清洗掉的
  环境变量仍可能被项目 `.env` 重新注入，用于给未在配置里声明 api-key 的 Provider 兜底。
- 来源：`byokSourceInstanceId` 未设置时读全部通道（含号池发布的 `local:*` 路由）；号池「一键接入」会把该字段写成号池 BYOK 实例。

## 号池：登录添加账号与 zcode 账号转发

号池页与供应商原生登录同一交互：选平台（Codex/Claude/Grok/ZCode 国际/ZCode 国内）→
登录 → 完成官方授权。CLI 系平台在弹出的终端里跑官方登录命令；ZCode 走服务端原生
OAuth：前端展示授权链接并每 2s 轮询 `status`，`ready` 后凭据已写入
`<stateDir>/local-pool-logins/<sessionId>`（sessionId 同时充当 terminalId），
`CliProxy.importLocalLogin` 读取该目录凭据、导入号池并删除目录——与 CLI 登录的
导入路径完全一致。macOS 钥匙串里的 Claude 登录态不落文件，无法导入（改用导入文件）。

zcode 账号池条目存的是归一化凭据快照：Coding Plan API Key（`api_key`）与登录态 JWT（`zcode_jwt`）至少其一。仅有 Key 的账号走 ZCode 平台网关 `https://zcode.z.ai/api/v1/ultra-zai|ultra/anthropic`（Anthropic 协议，Bearer Key，与 CLI 改写后的实际发送地址一致）；完成过官方登录的账号（含只有 JWT、没有 Coding Plan Key 的"体验套餐"账号）额外发布 `local:<实例>:zcode-start:<模型>` 通道，指向体验套餐推理网关 `https://zcode.z.ai/api/v1/zcode-plan/anthropic`、Bearer JWT，模型固定为 GLM-5.3-Flash/GLM-5.2/GLM-5-Turbo。体验套餐通道选号只认 JWT：Key-only 账号被轮到时直接换下一个、不冷却不记失败，池内没有任何 JWT 时返回明确错误。转发时**不伪造 ZCode 身份**：剥掉客户端带来的 `x-stainless-*`/`x-app`，`user-agent` 仅在本来就是 `ZCode/*` 时透传。adapter 以 anthropic 路由发布（zcode 与 claude 同协议——网关路由此前错标 openai，已修正），可绑给 zcodeAgent 与 claudeAgent 实例；跨机器导入的 credentials.json 解密失败会明确报错，需重新登录。上游没有 JWT 刷新接口（桌面端同样抛"暂未提供"），过期即报错提示重新登录；`ensureLocalAccountCredential` 把 `zcode_jwt` 视为有效令牌，JWT-only 账号不会进刷新流程。

### 用量、模型目录与领取活动（serverCliProxy）

- **用量**：`localAccountUsage` 按账号并发 4 查询官方接口并归一化成窗口/指标/套餐视图。Codex `wham/usage`+`subscriptions`+id_token plan_type 兜底；Claude `oauth/usage`+`oauth/profile`（Team/Max/Pro/Free、Fable 周窗 iguana_necktie）；Grok OAuth `cli-chat-proxy.grok.com/v1/billing`（周+月）；ZCode 合并 Coding Plan 订阅/quota、体验套餐余额（`zcode-plan/billing/balance`，Bearer JWT）、`client/configs` 的活动文案（150% 配额）与可领取预览（`billing/preview`）、MCP 额度与近一年活动统计。结果同时带 `captchaConfig`（阿里云验证码 sceneId/prefix/region）。
- **模型拉取**：`fetchLocalAccountModels` 优先使用平台目录，部分平台允许回退默认目录；账号不存在、凭据刷新失败和服务不可用仍明确报错——codex OAuth 走 `backend-api/codex/models`，claude/xai API-Key 走各自 `/v1/models`，zcode 合并官方目录与体验套餐 capabilities，其余落 `LOCAL_POOL_DEFAULT_MODELS` 静态目录并标注 `source:"catalog"`；`setLocalAccountModels` 写回后自动刷新 BYOK 实例通道目录，空数组=不限模型。
- **领取活动**：`claimLocalAccountOffer` 需要客户端先渲染阿里云验证码 2.0 拿 `captchaVerifyParam`，服务端 POST `billing/claim`（Bearer JWT + `X-Aliyun-Captcha-Verify-Param`(+Region) + `X-ZCode-App-Version` + `X-Platform`，与桌面端 claimManualPlan 同款）代领；结果透传上游 code/message（成功时省略），客户端以上游文案优先展示。web/desktop 在 `ClaimOfferDialog` 内嵌 SDK；脚本或域名校验失败回退"去官方客户端领取"。

## 测试

`apps/server/src/provider/zcode/`：配置生成（`zcodeByokConfig.test.ts`）、Start Plan 归一化/领取（`zcodeStartPlan.test.ts`）、凭据（`zcodeCredentials.test.ts`）、内嵌运行时释放与版本清单（`zcodeBundledRuntime.test.ts`）、真实子进程适配器测试（`ZCodeAdapter.test.ts`，替身脚本 `apps/server/scripts/zcode-mock-agent.mjs`，`MOCK_ZCODE_MODE` 切换场景）。替身会依次吐出 `session.titleUpdated`（占位 + 正式）、`permission.requested`、`tool_input_*` 参数流与带 `projection` 的 `result`，因此标题镜像、审批提示、参数流去重和上下文占用都在同一条 happy path 里被断言。号池侧：`localAccountUsage.test.ts`、`localAccountModels.test.ts`、`LocalAccountPool.test.ts`、`byok/modelGateway*.test.ts`（Start Plan 通道路由与转发头断言）。

事件形状以真实二进制取证过：上游 0.17.0 的 `stream-json` 输出（含 `turn.completed.usage`、`result.projection.contextUsed/contextWindow`、`session.titleUpdated`）与本地 OpenAI 兼容探针 Provider 的请求记录一致。

已知留白：MCP 宿主工具（`code-work` MCP）尚未注入 ZCode；体验套餐领取的验证码流程尚未用真实账号走过完整链路（端点与请求形状按桌面端 3.14.4 逆向对齐）；上游还提供 `zcode app-server --stdio`（常驻会话、`session/setModel`、steering、权限回调），迁移到它可以补上"中途换模型"，代价是替换每轮一进程的传输层。
