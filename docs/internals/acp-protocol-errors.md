# ACP 请求错误的公共边界

通用 ACP、Cursor、Kimi 和 Grok 使用同一个 `effect-acp` 传输。认证、建会话、模型配置和扩展请求的正常失败都应返回可捕获的 `AcpRequestError`；不能靠每个 Adapter 捕获所有内部缺陷来兼容上游错误。

## 原始错误与内部缺陷

标准 JSON-RPC 响应使用 `{jsonrpc: "2.0", id, error: {code, message, data?}}`。当前 Effect NDJSON RPC 解码会将外部普通错误放入 `Exit.Failure` 的 `Die` 项。`protocol.ts` 在公共 `Exit` 分发处复用 `isProtocolError`，只把完整的数值 `code`、字符串 `message` 形状转为 `Fail`。

核心请求随后沿 `client` 的 `callRpc` 转成 `AcpRequestError`。扩展请求沿 `extPending` 按请求 ID 匹配，使用同一个错误类。两条路径均保留上游错误码、消息、可选数据和请求方法，不改为通用成功或空结果，也不在失败后自动执行另一个请求。

显式 `Defect`、错误码类型无效等畸形错误继续保持缺陷语义；不会因含有一个 `message` 就被吞成正常失败。协议或进程终止继续由既有终止流程结束等待。正常请求失败只关闭对应请求，连接上的其它请求和后续明确请求仍可正常响应；新请求使用不同 ID。

## 可重复证据

`packages/effect-acp/src/client.test.ts` 将原始 NDJSON 错误分别送入核心 `authenticate` 和扩展请求，核对 `code/message/data/method`，并在同一连接继续完成后续成功请求。`protocol.test.ts` 核对显式缺陷和畸形错误仍原样进入错误通道。测试复用既有内存 stdio 和请求队列，不用固定等待，也不创建第二套传输。

实际 Gemini CLI 0.61.0 的可选探针位于 `apps/server/src/provider/acp/GeminiAcpCliProbe.test.ts`。显式设置 `CODEWORK_GEMINI_CLI_PATH` 为该版本官方 bundle 路径后才运行：无效的 `login` 方法在认证时失败，缺 Gemini API Key 的建会话失败；两者必须是 `AcpRequestError`，并核对没有发送 `session/prompt`。认证方法返回成功不能代替会话或模型可用证据。

探针的 HOME、USERPROFILE、APPDATA、LOCALAPPDATA 和 Gemini 配置目录指向作用域临时目录；除系统启动所需变量外，对宿主环境显式设置空值。Runtime 的 `extendEnv` 会重新合并宿主值，只从传入对象删除密钥变量不能隔离真实凭据。临时目录在子进程作用域结束后清理，不写入共享 Code Work 数据。

## 交付边界与回滚

这是共用传输的错误处理修复，不表示所有 Agent 已认证、可调用模型或完成工具验收。Harn 的 `environmentPolicy`、上游认证字段扩展、动态模型与会话命令分别按自身合同验证，不混入本模块。

撤回本模块提交即可恢复此前错误处理，无数据库迁移，不删除账户、会话或安装目录。旧行为会重新出现普通错误逃逸到内部缺陷的已知问题，回滚时应保留该边界说明。
