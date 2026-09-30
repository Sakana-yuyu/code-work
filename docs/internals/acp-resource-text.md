# ACP 资源链接与嵌入文本

## 调用链与承载

`effect-acp` 按现有 schema 解码 `resource_link` 和含 `text` 的 `resource`；`AcpRuntimeModel` 将其转为已有 `ContentDelta`。`AcpSessionRuntime` 复用 assistant item 的开始/结束事件，为每个正文资源独立分段。Cursor、Generic ACP、Kimi 与 Grok 继续使用原有正文事件工厂和持久化链路，Web/桌面、Mobile 复用现有 Markdown。没有新增公开消息合同、数据库表或客户端状态。

## 显示与隔离

资源链接保留标题或名称、实际 URI、查询参数、片段及说明；嵌入文本保留 URI 与原文，包括空文本。标题转义 Markdown 标点，说明和嵌入正文使用长于内部反引号串的代码围栏，其中的 HTML、图片或链接语法只作为文本。

HTTP(S)、file URI 交给客户端既有链接入口；其它协议或不可解析 URI 显示“不支持直接打开”和原始值。转换器不按 URI 下载资源，也不把无法打开的 URI 换成其它地址。文件链接的打开能力仍取决于当前环境与客户端原有权限。

每个正文资源前后结束活动文本段，防止相邻正文未闭合的 Markdown 围栏吞入资源或后文。各段保留不同 item ID 和原有顺序。子会话与恢复重放仍由共用 Runtime 门禁排除；思考资源保持 `reasoning_text`，不伪装成公开摘要。资源正文沿现有消息大小与持久化约束，解析器不另外截掉内容。

中间资源消息沿原工作记录折叠，展开后可查看；完成后的消息继续使用既有历史投影。本模块仅处理资源链接与嵌入文本，图片、音频、blob 的资产存储及实际官方 CLI 输出须分别验收。

## 验证与回滚

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

解析回归覆盖正文/思考、链接标点、危险协议、空文本及长文本；协议子进程覆盖四段顺序、item ID、子会话和重放隔离；Ingestion 覆盖流式与缓冲消息的持久化。客户端 Markdown 回归核对合法链接和围栏内原文。模拟协议与组件回归不能替代官方账号、实际 provider、Electron 或手机验收。

回滚使用撤销本模块独立提交的新提交，保留其它模块、会话历史和未提交内容。无需数据库迁移；旧版本会重新忽略这两类正文内容，不删除已保存的消息。

协议核对：2026-09-30；关键词 `ACP ContentBlock resource_link embedded text resource`；采用 [ACP 官方 v1 内容协议](https://agentclientprotocol.com/protocol/v1/content)与仓库生成 schema，因为两者明确区分资源引用和嵌入内容。可直接打开的协议范围和 Markdown 分段属于本产品的显示边界。
