# ACP 助手图片

ACP `agent_message_chunk` 的 `image` 经共用解析器、Cursor/Generic/Kimi 与 Grok Adapter
进入 `content.delta.image`；复用资源分段边界，图片不会被前文未闭合 Markdown 吞入。
`agent_thought_chunk` 的图片仍沿原思考隐藏策略，不转为公开回复。重放和其它会话通知由原门禁过滤。

Ingestion 在发布消息前将 base64 保存为现有 `ChatAttachment`。内部
`thread.message.assistant.delta` 可携带附件快照；事件表、投影和客户端只保存 ID、类型、名称、
MIME、字节数，完成消息不清空既有附件。现有原子 `.part` 写入/重命名存储被复用，
附件 ID 来自线程、实例、回合、事件 ID 的稳定摘要，相同事件重试不产生额外文件。
线程前缀保持现有清理规则；无需数据库迁移。写盘成功后若消息事务失败，文件保留供同事件重试，
不会删除可能已被成功提交引用的资产；不能据此声称跨文件系统与数据库的分布式事务已实现。

入口接受 PNG/JPEG/GIF/WebP，校验规范 base64、非空、最多 10 MiB 以及 MIME 对应的格式签名，
不主动下载可选 `uri`，不接受可执行 SVG。签名检查不是完整图像解码，损坏图片在客户端显示不可用。
验证或写盘失败发布 `provider.image.failed` 错误活动，保留具体原因；不使用会被客户端翻译为泛化
“运行时错误”的摘要。ACP 原始记录和 canonical 日志调用均省略图片正文，公开投影也不带 base64。

Web/桌面复用用户附件的图片网格与大图预览，纯图片历史不作为空消息删除。Mobile 复用原有助手附件
及签名资产地址，两个客户端的图片解码失败都有可见反馈。地址仍通过当前环境授权和签名 URL 获取；
附件前缀用于归属及清理，现有资产接口没有新增逐线程 ACL，不能将前缀描述为独立访问授权。

验证包含协议子进程、流式/缓冲投影、原子写盘失败、编码/大小/类型边界、重复事件、线程隔离、
共享 reducer 和本地浏览器。真实官方 CLI、Electron 原生壳、原生手机及远程/relay/tunnel 尚需独立验收。
回滚撤回图片可选载荷、内部命令和消费分支及双端渲染即可；旧消息数据中的附件保持有效，无迁移操作。
协议来源为 [ACP v1 内容协议](https://agentclientprotocol.com/protocol/content)（2026-09-30），关键词 `ACP image data mimeType`，采用其必填 base64/MIME 定义；
支持格式和大小限制属于本产品边界，不冒称 ACP 只支持四种格式。

定向回归使用 `vp test run`：Server 的 ProviderImageAttachment、AttachmentUpload、AcpRuntimeModel、AcpCoreRuntimeEvents、CursorAdapter、GrokAdapter、ProviderService、ProviderRuntimeIngestion；Web 的 MessagesTimeline 和其 logic；共享 client-runtime 的 threadReducer。浏览器验证使用隔离 home 和协议模拟进程，不能代替真实厂商账号或设备验收。
