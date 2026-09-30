# ACP 文本流与上下文用量

共同链路为 `effect-acp` 解码、`AcpRuntimeModel`、`AcpSessionRuntime`、Cursor/Grok Adapter、`ProviderRuntimeEvent`、`ProviderRuntimeIngestion` 与客户端派生数据。Generic ACP 和 Kimi 复用 Cursor 路径；Grok 使用同一解析与事件工厂，保留自己的回合活性监测。

## 文本语义

- `agent_message_chunk` 的文本进入 `assistant_text`。
- `agent_thought_chunk` 的文本进入 `reasoning_text`，保持原始类型。它结束上一段正文；之后的正文创建新的 assistant item，防止跨思考段合并。
- 现有公开时间线只持久化 `reasoning_summary_text` 摘要；原始思考不改名为摘要，也不写入正文。原始流与 Grok 活性判断可继续使用 `reasoning_text`。
- 子会话通知、恢复重放沿已有根会话门禁过滤。直接消费 `ContentDelta` 的诊断探针只把 `assistant_text` 算作正文。

这一步没有新增原始思考显示入口。媒体、结构化资源与厂商扩展命令的支持另有边界，不能由文本测试推断其可用性。

## 用量语义

`usage_update.used` 是当前上下文占用，映射为 `usedTokens`。零值有效，必须生成新快照并替换旧值；`size` 为正时映射为 `maxTokens`，零窗口表示未知，省略上限。不能从上下文占用推算累计处理 token、费用或账号余额。

上游 `cost` 保留在原始事件中用于诊断，不进入上下文快照，不转换成余额。账户可用额度须使用账户接口及其独立状态。原始协议诊断记录沿现有日志策略管理。

用量经 `thread.token-usage.updated` 转为 `context-window.updated` 活动。Cursor/Grok 均允许没有活动回合的用量通知；此时 `turnId` 缺省，不制造回合。Grok 将用量处理放在活动回合门禁前，但仍经过根会话和重放过滤；用量不刷新模型输出活性，也不解除工具等待。

共享客户端按同一回合归并可解析的上下文快照，包括零占用；其它回合及无效记录保持原有语义。Web 的上下文指示器从快照派生，Mobile 沿原有策略隐藏这类工作记录。Web/Desktop 复用相同派生逻辑，不需要新的客户端协议字段。

## 验证与维护

最小定向验证：

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts packages/client-runtime/src/state/threadReducer.test.ts apps/web/src/lib/contextWindow.test.ts
```

协议 fixture 验证零占用、未知上限、费用不混入、空闲通知、回合归属、重放/子会话隔离和正文分段；客户端回归验证零快照替换及上下文派生。fixture 证明应用协议链路，不能替代各官方 CLI 的认证、真实额度接口、Electron/手机或远程连接验收。

回滚应撤销本模块的独立提交，保留其它模块提交及工作树改动。没有数据库迁移、新依赖或账户数据改写；回滚后旧版本会重新忽略原始思考与零占用通知，需明确告知这一行为差异。
