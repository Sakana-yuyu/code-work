# 本地账号池、BYOK 模型网关与 CPA 兼容连接器

BYOK 实例保存模型通道，CLI 实例选择其中一条共享线路或聚合所有线路。Code Work 网关负责模型定位、凭据替换与同协议转发；本地官方账号池由 Code Work 自己保存元数据、选择账号并从服务端密钥存储取出凭据。CLIProxyAPI（CPA）的核心兼容入口已经移植为 Code Work 内置的同进程兼容层；外部 CPA、Sub2API 或其他模型服务仍可作为普通 BYOK 通道接入，但不是该入口的运行时依赖。

## Code Work 内置本地账号池

`packages/contracts/src/localAccount.ts` 定义本地账号元数据，`apps/server/src/provider/LocalAccountPool.ts` 负责凭据导入、启停、删除和轮询。`localAccountPool.accounts` 只进入服务器设置的元数据部分，`credentialRef` 对应的 JSON 原文由 `ServerSecretStore` 保存；RPC 结果不返回令牌。`publishLocalAccountPool` 把账号列表绑定到一个现有 Codex、Claude、Grok、Cursor 或 OpenCode 实例；Codex、Claude、Grok、OpenCode 使用本地 HTTP 网关，Cursor ACP 在每个会话启动时注入单账号环境变量（`CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`）。OpenCode 还必须在请求中选择 Codex 或 Grok 平台。

网关为绑定实例发布 `supplierID: "codework-local-account"` 的本地路由。Codex API Key 使用 OpenAI `/v1/responses`，Codex OAuth 使用 ChatGPT `/backend-api/codex/responses` 并转发 `chatgpt-account-id`、`OAI-Product-Sku: codex`；Claude 使用 Anthropic Messages 端点，OAuth 凭据附加 `oauth-2025-04-20`；Grok 的订阅 OAuth 凭据使用 `cli-chat-proxy.grok.com` 并附加 CLI 会话头，`xai::api_key` 才使用 xAI API 端点。OpenCode 绑定时必须选择 Codex 或 Grok 平台，因为它只消费 OpenAI 兼容路由；其中 Codex 只能使用 API Key 账号。请求开始时 `pickLocalAccount` 按 `round-robin` 或 `fill-first` 选择启用账号；账号声明模型时按模型过滤，空模型列表作为官方 CLI 通配账号参与选择，但不会生成共享 BYOK 模型路由。凭据只持久化在 `ServerSecretStore`，运行时解密到内存和上游请求头，不进入 settings、RPC 或日志。账号池没有可用账号、凭据无效或请求中的模型无法匹配时返回协议错误，不回退到外部 BYOK。

外部 Agent 访问使用独立的 `local-gateway-keys` SecretStore key ring。`CliProxy` 的 create/rotate/revoke/list RPC 只返回摘要，创建和轮换结果携带一次性明文 Key；HTTP 网关同时接受内部 `byok-gateway-token` 与外部 Key，但后者会把路由过滤为 `localProvider`，不能读取普通 BYOK 凭据。Key 是随机高熵值，比较使用常量时间比较；SecretStore 读取或 key ring 解析失败时拒绝请求。外部 URL 仍复用 `/byok-gw/openai/v1` 和 `/byok-gw/anthropic`，服务端默认回环监听，跨主机暴露必须由部署者配置可达监听地址和 HTTPS 反代。

这是请求级代理，不会修改正在运行的官方 CLI 进程，也不会在已开始的流式响应中切换账号。首个账号在响应体开始前遇到网络错误、401、403、429 或 5xx 时，最多换用一个健康账号重放；没有第二个健康账号时保留原错误。官方 OAuth 刷新协议和系统 keyring/Keychain 仍可能要求用户通过官方 CLI 重新登录；本地导入是凭据材料的受控保存与轮询入口，不等价于官方 API 兼容性保证。

实现依据（检索日期 2026-09-05）：关键词为 `Codex auth.json account_id`、`Claude OAuth token refresh`、`Grok CLI OAuth chat proxy`；采用 [OpenAI Codex 登录存储](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)、[xAI Grok CLI 设置](https://docs.x.ai/build/settings) 和 [CLIProxyAPI 的公开执行器实现](https://github.com/router-for-me/CLIProxyAPI/tree/main/internal/runtime/executor)，用于确认凭据字段、官方端点和协议头。CPA 源码只作为公开协议参考，运行时不依赖它。

## 共享来源与请求路径

`packages/contracts/src/settings.ts` 中，Codex、Claude、Grok 和 OpenCode 的配置包含 `routeThroughByok` 与可选的 `byokSourceInstanceId`。Web 的 `ProviderConnectionSection` 和移动端的 `SettingsProvidersRouteScreen` 提供来源选择；CLI 账号池一键接入时，服务端会把有匹配账号的已启用实例自动写入同一来源；未设置来源时保留聚合全部已启用 BYOK 实例的行为。

`apps/server/src/provider/byok/modelGateway.ts` 挂载在现有 HTTP 监听器上：

- 未限定来源：`/byok-gw/anthropic/*`、`/byok-gw/openai/*`。
- 指定来源：`/byok-gw/anthropic/source/<instanceId>/*`、`/byok-gw/openai/source/<instanceId>/*`；OpenAI 客户端 Base URL 还包含 `/v1`。
- `gatewayAdapterRoutes(settings, sourceInstanceId)` 只读取选定且已启用的 BYOK 实例，并筛选有 URL、密钥的 `openai` / `anthropic` 通道。来源不存在时得到空列表，不回退到其他实例。
- `GET /v1/models` 返回当前来源中匹配协议的通道。模型选择器和请求使用通道 ID，转发前 `rewriteGatewayModel` 将其改为上游真实 `modelId`。
- 有 `model` 字段时必须匹配同协议通道 ID；未知模型返回 404。Claude 模型 ID 的尾部上下文限定符（如 `[1m]`）在匹配时会被移除。没有 `model` 字段的辅助请求，只在该来源与协议恰有一个通道时转发，否则返回 400。

每个请求重新读取服务器设置，因此模型通道的 URL、密钥和模型修改无需重启网关。上游响应流保持原样；网关不会把 Anthropic Messages、OpenAI Responses 或 Chat Completions 相互转换。`openai` 是通道协议分类，不是上游同时支持 Responses 与 Chat Completions 的能力证明。

网关令牌由 `ServerSecretStore.getOrCreateRandom("byok-gateway-token", 32)` 生成，使用常量时间比较鉴权。CLI 通过子进程环境读取令牌；上游密钥由服务器替换，不进入客户端设置响应。CLI 与 Code Work 服务器运行在同一环境，注入的地址使用服务器本机 `127.0.0.1`，客户端通过本地、远程或隧道连接不改变这条路径。

## 各 CLI 注入点与边界

仅当实例配置 `routeThroughByok: true` 时注入：

| CLI      | 注入方式                                                                                                                                                            | 上游要求                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Codex    | `CodexDriver.ts` 注入令牌环境变量；`gatewayCodexConfigArgs` 通过 `gatewayAppServerArgs` 向 app-server 传递 `-c` 参数，设置 `byok_gateway` 与 `wire_api="responses"` | OpenAI Responses        |
| Claude   | `ClaudeDriver.ts` 注入 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`，并清空冲突的 API Key / OAuth 环境变量                                                          | Anthropic Messages      |
| Grok     | `GrokDriver.ts` 在独立 `GROK_HOME` 的 `config.toml` 中维护模型块，设置 `base_url`、`env_key`、`api_backend="chat_completions"`                                      | OpenAI Chat Completions |
| OpenCode | `OpenCodeDriver.ts` 将 `byok_gateway` 合并进 `OPENCODE_CONFIG_CONTENT`，使用 `@ai-sdk/openai-compatible` 与当前来源模型表                                           | OpenAI Chat Completions |

Codex 配置逐项作为 argv 传递，保留 TOML 引号，并在原有启动参数之后应用。Codex、Claude、Grok 通过 `routedServerProviderModels` 发布限定来源与协议的模型快照，鉴权标记为 `BYOK Gateway`；OpenCode 使用注入的 provider 模型表。这些状态表示路由配置，不代表上游实际推理成功。

`apps/server/src/provider/grokHome.ts` 为代理实例和新增 Grok 实例派生 `stateDir/provider-homes/grok/instance-<id>`。原生默认 `grok` 实例仍使用个人默认目录；显式设置 `GROK_HOME` 时使用该目录，但代理模式拒绝个人默认 `~/.grok`。驱动仅维护独立目录内的标记模型块，不复制个人凭据；关闭路由时，当前独立目录中的托管块会被移除。

OpenCode 同时设置 `serverUrl` 与 BYOK 路由时，驱动拒绝创建：外部 OpenCode 服务的模型必须在其所属环境配置，本地进程环境变量无法接管外部进程。Cursor 的 `endpoint` / `-e` 使用专有协议，需要专用兼容桥，普通 CPA / Sub2API 地址不能直接作为该端点；真实 Cursor ACP 桥接验证尚未完成。Gemini 协议通道也不进入此网关。

## 忙碌实例的配置切换

`ProviderInstanceRegistryHydration.ts` 为已接管的 CLI 计算仅在内存中使用的来源摘要。所选 BYOK 的模型、端点、密钥或启用状态变化会触发已有实例更新；Claude 只依赖 Anthropic 通道，另外三个 CLI 只依赖 OpenAI 通道。摘要不进入持久设置，driver 解码时会移除该字段。

`ProviderInstanceRegistryLive.ts` 保存期望配置，对存在活跃调用、`activeTurnId`、`running` 或 `connecting` 会话的实例保留当前运行项，并标记待切换。更改、停用和删除均按这个边界处理；同一实例后续保存覆盖前一次期望配置。

待切换快照显示“配置已保存，等待当前轮次结束后生效”。此时拒绝新的会话启动和新一轮请求，避免使用旧配置继续接收工作；现有事件流中的轮次完成、中止、会话退出或状态变化，以及活跃调用释放，会唤醒配置重建。这个机制只保护 Provider 实例配置切换；网关通道变更会影响后续请求，内置兼容层没有独立进程可供停止，也不会等待 Provider 轮次结束。

## 内置 CLIProxyAPI 兼容层

`packages/contracts/src/cliProxy.ts` 定义类型化请求与结果，`server.cliProxy` 通过 `AuthTerminalOperateScope` 授权。`apps/server/src/provider/CliProxy.ts` 只协调本地账号池、BYOK 实例和外部 Agent Key；`CliProxyRuntime.ts` 是同进程状态对象，不包含 `child_process`、可执行文件路径、独立监听器或外部 CPA 网络请求。Web 与移动端使用同一 RPC，账号列表仅投影展示字段，不返回账号令牌或完整授权文件。绑定实例 ID 从设置持久化状态恢复，不依赖服务进程重启前的内存字段。

本地凭据由 `LocalAccountPool.ts` 解析并写入 `ServerSecretStore`。`connectByok` 为每个声明的模型生成稳定的 `local:<instance>:<provider>:<model>` 适配器，同时在 `localAccountPool.providerInstances` 建立绑定；绑定后导入同平台账号会自动扩展对应绑定，避免新账号只存在于目录而永远不参与路由。`modelGateway.ts` 会把带 `supplierID: "codework-local-account"` 的目录条目解析为本地路由，避免把 `/v1` 网关再当作自己的上游。账号选择、凭据刷新、401/403/429/5xx 换号和请求体模型还原都发生在同一 HTTP listener 内。
账号启停支持单个和批量 RPC；批量请求只更新账号池元数据，不触碰凭据存储，也不改变实例绑定。

内置兼容入口（其中部分是 Code Work 为现有客户端提供的扩展别名，不等同于上游逐字复刻）：

- `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`：OpenAI 核心子集；`Anthropic-Version` 或 `claude-cli` User-Agent 会让 `/v1/models` 返回 Anthropic 目录。
- `POST /v1/messages`、`POST /v1/messages/count_tokens`：Anthropic Messages 核心子集。
- `GET/POST/PUT/DELETE /v0/management/auth-files`、`GET /v0/management/auth-files/models`、`POST/PATCH /v0/management/auth-files/status`、`GET/POST/PATCH /v0/management/config`、`GET/PUT/PATCH /v0/management/routing/strategy`：只管理 Code Work 本地账号池的兼容子集。上传支持受限的原始 JSON 和 multipart 文件；多文件失败时返回部分成功结果。`POST/PATCH config` 与 `PUT/PATCH routing/strategy` 是内置扩展的安全策略写入口，完整配置导出和下载不开放。

`/v1` 接受内部 `byok-gateway-token`（供本地驱动使用）和通过 RPC 创建的外部 Agent Key；外部 Key 只能访问 `localProvider` 路由。`/v0/management` 只接受 `X-Management-Key` 管理头，拒绝 `/v1` 使用的 `Authorization`、`x-api-key` 和查询参数，避免推理令牌提升为凭据管理权限。Key 比较使用常量时间比较，凭据永不进入设置 RPC 或日志。

这不是把上游 CPA 可执行程序作为依赖，也不宣称完整实现其所有端点。当前明确未覆盖：完整 OAuth/PKCE 与 xAI device flow、Gemini/Interactions、Realtime/WebSocket、插件、视频/图像扩展、`auth-files/download`、`config.yaml`、weighted-round-robin 和其余 management API；内置凭据导入只要求受支持的 provider 和有效令牌，模型声明是发布共享 BYOK 路由时的必要条件，但官方 CLI 本地账号可以不声明模型。需要这些能力时必须另行实现并增加端到端验收；不能用 `running: true` 或“模型已列出”代替真实推理验证。

## 验证范围与路由注意事项

内置管理接口、账号池状态与本地协议测试，应与真实账号 OAuth、真实 CLI 的 ACP / app-server 会话、工具调用和推理结果分开报告。当前测试只证明兼容子集的路由、鉴权、凭据脱敏和账号切换边界；不能将“运行中”或“模型已列出”合并视为端到端验收。

网关测试入口为 `apps/server/src/provider/byok/modelGateway.test.ts`，内置兼容层服务测试入口为 `apps/server/src/provider/CliProxy.test.ts`。当前路由器不匹配 `HttpRouter.add("*", …)`，因此逐协议注册 `GET`、`POST`；`…/*` 已包含裸前缀，不能重复添加同方法的前缀路由。
