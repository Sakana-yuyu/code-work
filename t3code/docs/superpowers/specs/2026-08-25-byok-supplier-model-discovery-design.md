# BYOK 供应商目录与自动模型发现设计

## 状态

已获用户批准进入第一批实现设计。本文档只覆盖“供应商目录与自动模型发现”，不改变当前 BYOK 的聊天运行时协议，也不包含余额、提示词模板、委派或 YAML 导入的实现。

## 目标

把现有 `SupplierCatalog`、`ModelCatalog` 和 BYOK provider 设置连接成一条真实、可测试的数据流：

1. Web 设置页使用服务端维护的供应商模板元数据，不再维护一套容易漂移的模板副本。
2. 用户可以针对一个 BYOK adapter 主动发现可用模型。
3. 发现请求具备超时、响应大小限制、兼容 JSON 解码和跨源重定向脱敏。
4. 发现结果只包含非敏感模型元数据，并按 adapter 隔离缓存。
5. 发现到的模型不会自动污染模型选择器；用户明确选择后才创建或更新本地 adapter。
6. 用户手工填写的模型、上下文窗口、价格等字段不会被自动发现覆盖。
7. API key 继续只存在 `ServerSecretStore`，不出现在 settings JSON、RPC 返回、DOM、日志或测试输出中。

## 非目标

本批次不实现：

- 余额/用量查询；
- prompt template 注入；
- delegation scheduler UI 或外部 CLI 执行器；
- cursor-byok YAML 导入；
- Gemini 原生协议；
- tool call、权限审批、附件或完整 coding-agent 能力；
- 一次性切换到 supplier-oriented runtime contract。

当前 legacy `ByokModelAdapter` 继续作为运行时和持久化兼容格式。本批次只增加 supplier/discovery 元数据层。

## 现状与约束

当前真实运行链路是：

```text
ProviderSettingsPanel
  -> serverUpdateSettings
  -> ServerSettingsService / ServerSecretStore
  -> ByokDriver
  -> ByokAdapter / byokChatClient
```

现有纯能力模块：

- `apps/server/src/provider/byok/SupplierCatalog.ts`
- `apps/server/src/provider/byok/ModelCatalog.ts`

当前缺口：

- Web 端仍有独立的少量供应商模板；
- provider health probe 只直接拼接 `/models`，没有使用完整候选 URL、协议过滤和目录元数据；
- 目录结果没有设置页 RPC、稳定缓存或用户确认后的 adapter 更新流程。

API key、余额 token、用户 ID、自定义敏感 Header 都视为秘密。所有新接口必须复用现有 secret materialization/redaction 边界，不允许为了发现功能把秘密放入通用 DTO。

## 架构

### 1. 服务端 SupplierCatalog 作为唯一模板来源

新增一个面向 Web 的非敏感 catalog 投影函数，返回供应商选择所需的安全字段：

- stable supplier id；
- 显示名称和协议；
- 默认 base URL；
- 是否允许自定义 URL；
- 模型目录策略和显式目录 URL；
- 默认模型和非敏感模型元数据；
- 图标/网站等非敏感展示信息。

投影不能返回：

- API key；
- balance access token/user id；
- 自定义请求头内容；
- 任何已 materialize 的 secret。

Web 侧只保留表单状态和用户输入，不再复制完整供应商模板规则。

### 2. ByokModelDiscoveryService

在 server provider/byok 下新增服务层，负责：

```text
adapter settings + materialized secret
  -> buildModelCatalogCandidates
  -> safe HTTP fetch
  -> decode/filter/normalize model catalog
  -> per-adapter cache
  -> redacted discovery result
```

输入使用内部结构，允许服务端读取 secret store；输出使用专用公开 DTO，只包含：

- adapter id；
- model id；
- owner/provider（若上游提供）；
- context window；
- pricing；
- capabilities；
- discoveredAt；
- cache state；
- 非敏感错误摘要。

不得复用包含 apiKey 或自定义 Header 的 settings DTO 作为 RPC 返回值。

### 3. 目录地址和请求安全

候选地址顺序：

1. adapter 显式 `modelCatalogURL`；
2. supplier 模板提供的显式目录 URL；
3. `ModelCatalog.buildModelCatalogCandidates()` 根据 protocol、supplier 和 base URL 推导的候选；
4. 对 `manual_only` supplier 不发起隐式请求。

每个候选请求：

- 总超时 15 秒；
- 最大响应体 4 MiB；
- 只允许 `http`/`https`；
- 遵循重定向前记录 trusted origin；
- 跨 trusted origin 重定向时移除 Authorization、Proxy-Authorization、Cookie、Referer、x-api-key、x-goog-api-key 和自定义认证头；
- 解析失败或上游错误只返回脱敏的稳定错误分类，不返回请求头、完整 URL 中的 secret query 或原始响应体。

请求头由 protocol 生成；自定义 Header 只在服务端读取并发送，永不回传。

### 4. 发现结果筛选和缓存

结果处理顺序：

1. 解码数组、`data`、`models`、`items` 等兼容 envelope；
2. 归一化 model id；
3. 按 model id 去重；
4. 按 supplier/protocol 过滤不兼容条目；
5. 保留 context/pricing/capabilities 元数据；
6. 稳定排序。

缓存 key 至少包含：

```text
providerInstanceId + adapterId + catalog configuration fingerprint
```

fingerprint 不得包含或持久化明文 secret；可以使用不可逆摘要，且日志中不输出摘要原文以外的敏感材料。缓存先采用进程内 TTL，默认短 TTL，并支持显式 `forceRefresh` 清除该 adapter 缓存。

provider reload 或 adapter 配置变化时清理对应缓存。

### 5. RPC

新增两个 server WS RPC：

- 获取安全供应商目录；
- 发现某个 adapter 的模型。

请求只带 instance/adapter 标识、可选 forceRefresh 和用户明确填写的非秘密 catalog 覆盖字段。服务端从当前 settings + secret store 读取真实配置，并校验 instance/adapter 的归属，防止跨实例读取。

返回结构包含：

- `status: ready | cached | empty | failed`；
- `models`；
- `fetchedAt`；
- `stale`；
- 稳定错误 code/message key；
- 不包含任何秘密。

### 6. 用户确认后写回 adapter

Web 发现面板允许多选发现模型。点击“添加模型”后，客户端生成 legacy `ByokModelAdapter` patch：

- 新模型使用稳定生成的 adapter id；
- 复用当前 adapter 的非敏感连接字段和 secret 引用；
- API key 不从客户端重新读取或回传；
- discovered context/pricing 只填充当前字段为空或明确标记为自动的值；
- 已存在 adapter 只更新非手工元数据；
- 用户手工覆盖的 context/pricing/model id 保持不变。

保存仍走现有 `serverUpdateSettings`，由服务端完成 secret 持久化和 redaction。发现面板不能直接写文件或调用独立的 cursor-byok 进程。

## Web 交互

在现有 BYOK adapter 设置卡中增加：

- “发现模型”按钮；
- 加载状态和禁用重复请求；
- 上次刷新时间；
- 结果数量；
- 空态、部分失败和可重试错误；
- 模型 id、供应商、上下文窗口、价格、能力摘要；
- 多选后“添加所选模型”；
- 已配置模型标记；
- 手工覆盖字段提示。

所有可见文本、tooltip、placeholder、aria-label、toast 和错误提示使用稳定 i18n key，并同时维护英文和 zh-CN catalog。品牌名、协议名、模型 ID、URL 和技术标识保持原样。

## 错误处理

错误分为：

- `missing_credentials`：adapter 没有可用 secret；
- `unsupported_catalog`：供应商明确要求手动配置；
- `invalid_endpoint`：URL 非 http/https 或无法归一化；
- `timeout`：请求超时；
- `response_too_large`：超过 4 MiB；
- `redirect_blocked`：不安全重定向；
- `upstream_http`：上游返回错误状态；
- `invalid_payload`：响应不是支持的模型目录格式；
- `no_models`：请求成功但没有可用模型。

Web 只展示本地化的错误标题和安全摘要。原始响应体、认证头和可能包含凭据的 URL 不进入日志、RPC 或 DOM。

缓存命中时保留上次成功结果；瞬时失败可以返回 stale 结果并标记 `stale: true`，确定性失败不伪装成成功。

## 测试策略

服务端：

- SupplierCatalog 安全投影不泄漏秘密；
- URL 候选顺序和 manual-only 行为；
- JSON envelope、字段别名、去重、排序和 protocol 过滤；
- 超时、4 MiB 上限和跨源重定向脱敏；
- cache hit、force refresh、stale 结果和配置变更失效；
- RPC instance/adapter 所属校验；
- 添加模型 patch 不覆盖手工字段；
- settings redaction 回归。

Web：

- 供应商目录渲染和稳定 id；
- 发现加载/空态/错误/重试；
- 多选添加模型；
- secret 不进入请求 DTO 或渲染 DOM；
- 中英文 i18n catalog 完整性；
- 现有 ProviderSettingsPanel、ByokModelAdaptersSection 回归。

验证命令：

```text
cmd //c "node_modules\\.bin\\tsc.CMD --noEmit"
node ./node_modules/vite-plus/bin/vp test run --project unit
git diff --check
```

浏览器验收：

- `/settings/providers` 能读取服务端供应商目录；
- 配置一个 adapter 后可以主动刷新模型目录；
- 发现结果不显示任何 API key 或自定义认证头；
- 选择模型并保存后，模型选择器显示新 adapter；
- 手工上下文窗口和价格不会被刷新覆盖；
- 失败、空态、重试和上次成功缓存均显示为中文。

## 分批交付

第一子批：

1. SupplierCatalog 安全投影和 contracts；
2. ModelCatalog 请求安全与候选 URL 接入；
3. ByokModelDiscoveryService、缓存和 server RPC；
4. 服务端测试。

第二子批：

1. Web 供应商目录替换本地模板；
2. adapter 发现面板和多选添加；
3. i18n、Web 测试和浏览器验收。

只有两个子批都通过验证后，第一批“供应商目录与自动模型发现”才视为完成。
