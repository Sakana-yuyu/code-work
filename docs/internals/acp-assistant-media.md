# ACP 助手音频与二进制附件

## 协议和实现边界

核对日期：2026-09-30。检索关键词：ACP v1 content、audio、embedded resource blob。采用 [ACP 官方 v1 内容协议](https://agentclientprotocol.com/protocol/v1/content)，因为它定义当前 workspace schema 使用的内容块；音频使用 `mimeType/data`，嵌入资源使用 `resource.uri/mimeType/blob`。上游协议支持这些类型，并不保证每个 Agent 都会输出或接受它们。

本模块处理 `agent_message_chunk` 中的音频和嵌入 blob。用户上传仍沿用图片合同，工具中的媒体、外部 URI 回源和录音输入不属于本模块。`agent_thought_chunk` 保留 reasoning 类型，不把私有思考附件持久化到公开助手回复。

## 共用链路

`AcpRuntimeModel` 解析独立段，`AcpSessionRuntime` 允许空文本媒体继续传递；Cursor、Generic ACP、Kimi 共用 Cursor Adapter，Grok 使用相同事件转换。`content.delta` 的音频/blob 字节只在服务端消费。原始协议摘要和 ProviderService 的规范事件日志都省略 base64 正文。

`ProviderRuntimeIngestion` 调用 `ProviderBinaryAttachment`，复用 `storeAttachmentUpload` 的原子临时文件写入与附件签名访问。公开消息仅保存类型、ID、名称、MIME 和大小。线程、实例、回合和事件 ID 构成稳定键，重试和重复通知保留同一附件；附件完成与历史重载不依赖实时 token 流设置。失败按 `provider.audio.failed` 或 `provider.file.failed` 进入同一可见活动，图片继续使用原有错误类型。

每项上限为 10 MiB，拒绝空值、不规范 base64、未知音频格式和危险 blob MIME。音频允许 AAC、FLAC、MP4、MPEG、OGG、WAV/WAVE/X-WAV、WebM。Blob 默认 `application/octet-stream`，拒绝脚本、HTML、SVG 和常见可执行文件声明。这是类型门禁，不是内容鉴定或病毒扫描；解码器错误由客户端明确显示。`uri` 只用于取文件名，不下载 URI，也不读取 Agent 工作区；实际路径始终由服务端附件 ID 决定。

## 显示和错误

Web 与桌面共用原生 audio 控件，默认只预载元数据，提供文件名作为可访问名称；解码失败显示音频不可用。Blob 显示文件名与有名称的下载链接，通过现有签名附件地址下载。纯附件回复没有空回复占位。切换 Agent 时历史摘要只含名称，不传递签名地址，也不把音频或文件称为图片。

Mobile 复用签名附件 URL 和系统打开能力；已有附件组件独立为 `MessageAttachmentMedia`，保留图片预览与错误行为。音频/文件打开失败明确提示并保留原按钮供重试，屏幕阅读器可读取失败提示；只接收最后一次打开操作的结果，迟到的旧操作成功或失败不能覆盖新错误。系统是否提供播放器或下载处理器取决于设备，组件测试不能代替真实手机验收。

## 验证与回滚

定向检查：`ProviderBinaryAttachment.test.ts`、ACP 解析/事件转换、Cursor/Grok Adapter 子进程夹具、ProviderService 日志脱敏、ProviderRuntimeIngestion 的两种投影模式、Web 时间线与历史摘要、Mobile 附件交互和现有 URL 帮助函数。浏览器夹具使用有效 PCM WAV、正常 blob、不合法 base64、危险 MIME 与错误 WAV，分别核对播放、暂停、下载字节、错误和刷新历史；所有数据只在隔离 home 中生成。

无数据库迁移，撤回本模块提交即可回滚。已有媒体附件引用可留在历史数据中；退回仅支持图片的旧客户端将不能显示音频/文件，因此含这些附件的环境应协调服务端与客户端版本。不要删除在线附件目录或数据库来回滚。真实 Agent 输出、Electron 原生壳及原生手机、完整远程矩阵仍需各自证据，不能用协议夹具冒充。
