# ZCode Provider

ZCode（[zai-org/ZCode](https://github.com/zai-org/ZCode)）以 `zcodeAgent` 驱动接入，和 Pi 一样只有 BYOK 一种形态：模型调用全部经本地 BYOK 网关，号池（本地 CLI 账号）路由随网关一并发布。

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

zcode 账号池条目存的是解密后的 Coding Plan API Key（不含 OAuth token），上游按
`zcode_family` 选 ZCode 平台网关 `https://zcode.z.ai/api/v1/ultra-zai|ultra/anthropic`
（Anthropic 协议，Bearer Key，与 CLI 改写后的实际发送地址一致）；adapter 以
`local:<实例>:zcode:<模型>` 的 anthropic 路由发布，可绑给 zcodeAgent 与 claudeAgent
实例；跨机器导入的 credentials.json 解密失败会明确报错，需重新登录。

## 测试

`apps/server/src/provider/zcode/`：配置生成（`zcodeByokConfig.test.ts`）与真实子进程适配器测试（`ZCodeAdapter.test.ts`，替身脚本 `apps/server/scripts/zcode-mock-agent.mjs`，`MOCK_ZCODE_MODE` 切换场景）。

已知留白：适配器按 ZCode 源码里的 stream-json 事件形状编写并对替身验证，尚未对真实 `zcode` 二进制做端到端验证；MCP 宿主工具（`code-work` MCP）尚未注入 ZCode。
