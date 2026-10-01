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

- stdout 逐行输出会话事件信封（`type` / `sessionId` / `turnId` / `payload`，形状同 ZCode 协议的 `mapSessionEvent`），最后一行 `type:"result"` 收尾。
- 会话 id 取自事件信封的 `sessionId`，存为 resume 游标 `{ zcodeSessionId }`，下一轮用 `--resume` 续接。
- 事件映射：`model.streaming`（`text_delta` / `reasoning_delta`）→ `content.delta`；`tool.updated`（`scheduled` / `started` / `progress` / `result` / `error`）→ `item.started/updated/completed`；`turn.completed` / `turn.failed` / `result` / 进程退出 → 终态。无流式增量时用 `turn.completed.response` 兜底。
- 运行时模式映射到 `--mode`：`full-access` → `yolo`，`auto*` → `edit`，其余 → `build`，计划模式 → `plan`。无头模式没有交互式审批。
- 中断 = 发出 `turn.aborted` 并终止本轮进程；上一轮进程的退出帧不会结算下一轮。

## BYOK 与号池

- 受管数据根 `ZCODE_DATA_BASE_DIR = <stateDir>/provider-homes/zcode/instance-<id>`；个人 Provider 配置固定写在 `<根>/.zcode/v2/provider_config.json`（schemaVersion 1，形状取自 ZCode 的 `provider-config-file-codec`）。
- 配置把网关注册为三个个人 Provider：`codework-anthropic`（anthropic-messages）、`codework-openai`（openai-chat-completions）、`codework-responses`（openai-responses，号池里的 Codex 官方账号只有 Responses 上游）。
- ZCode 没有 `--model`：每轮启动前按所选通道重写 `defaultModelSelection`。
- 环境清洗：剥掉第三方密钥与 `ZCODE_*_PROVIDER_CONFIG_FILE`，避免 CLI 连上自己的账号。
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

`apps/server/src/provider/zcode/`：配置生成（`zcodeByokConfig.test.ts`）、Start Plan 归一化/领取（`zcodeStartPlan.test.ts`）、凭据（`zcodeCredentials.test.ts`）、真实子进程适配器测试（`ZCodeAdapter.test.ts`，替身脚本 `apps/server/scripts/zcode-mock-agent.mjs`，`MOCK_ZCODE_MODE` 切换场景）。号池侧：`localAccountUsage.test.ts`、`localAccountModels.test.ts`、`LocalAccountPool.test.ts`、`byok/modelGateway*.test.ts`（Start Plan 通道路由与转发头断言）。

已知留白：适配器按 ZCode 源码里的 stream-json 事件形状编写并对替身验证，尚未对真实 `zcode` 二进制做端到端验证；MCP 宿主工具（`code-work` MCP）尚未注入 ZCode；体验套餐领取的验证码流程尚未用真实账号走过完整链路（端点与请求形状按桌面端 3.14.4 逆向对齐）。
