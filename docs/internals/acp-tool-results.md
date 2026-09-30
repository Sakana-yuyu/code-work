# ACP 工具结果与客户端详情

通用 ACP、Cursor、Kimi 和 Grok 共用工具解析与生命周期。新 Agent 优先复用这条链路；不同工具结果的兼容集中在协议边界，不复制客户端组件或 Provider Adapter。目录可选、握手成功和工具可用是不同证据。

## 数据链路

`AcpRuntimeModel.parseSessionUpdateEvent` 解析 `tool_call` / `tool_call_update`；`mergeToolCallState` 按同一 `toolCallId` 合并缺省字段。Adapter 通过 `makeAcpToolCallEvent` 发出已有的 `item.updated` / `item.completed`。`ProviderRuntimeIngestion` 写入工作记录，`ActivityPayloadProjection` 为实时推送和历史查询裁剪数据。Web 的 `session-logic`、`MessagesTimeline.logic` 和 Mobile 的 `threadActivity` 消费同一合同。

标题、命令输入和输出详情分别保留。增量没有标题时沿用已知标题；没有明确命令输入的 `execute` 工具不能把 stdout 放进命令字段。旧无类型元数据的历史仍按原有规则读取，保存的新记录保留明确的 `data.kind`。

## 外部结果形状

- 批量命令输入的 `commands: string[]` 逐条分行显示，避免把多条命令拼成一条 shell 命令。这里只生成显示数据，不重新执行它们。
- 完整的 `{query: string, result: string, success: boolean}[]` 结果转成展开详情；协议状态为 `completed` 而任何子结果 `success=false` 时，整次调用显示失败。缺字段或未知数组不猜测失败语义，原始结构保留。
- 已知 MCP `rawOutput.content` 的文本块优先于 ACP 展示正文，防止同时显示厂商附加的命令预览和重复摘要。非文本块和其它结果字段保留；此规则不做全局文本去重。
- 没有上述原始文本结果时保留 ACP 文本内容；只有没有正文时才使用路径或命令摘要。批量文件输入通过已有共享路径提取器的 `files` 键处理。

这些形状依据已捕获的真实 CLI 响应形成兼容规则，不能用 Agent 名称、工具 ID 前缀或标题来猜测执行结果。

## 上限、审批和显示

已知 ACP 文本保留最多 8,000 字符的末尾，`[Earlier output truncated]` 标记计入此上限。分块内容沿原顺序保留图片、差异等非文本块。终态 `detail` 同样最多 8,000 字符，供展开与刷新历史查看；中间更新继续保留短摘要，避免累计输出随通知次数放大写入和传输。其它 Provider 的超限终态仍按既有省略号规则裁剪。

审批活动描述申请和决策，保持可见及可检查，但不计入工具数量或执行成功。工具开始、更新和终态按调用 ID 合并；执行失败保持失败。Web 把 ACP `search` 归为代码搜索，`fetch` 保持网络检索；两端对规范化的文件读取显示对应读取图标与分类。

## 验证与回滚

定向回归覆盖原始批量失败结果进入公共活动、三种长正文通过公开投影保留末尾、未知形状、部分更新、输入/输出分离、审批与真实工具混排，以及双端失败展开详情。保留原有累计输出合并、限长与普通 Provider 回归，不用固定等待替代事件证据。

类型检查、协议 fixture、真实浏览器、真实 CLI 和外部账号分别记录；本模块测试不能证明每个目录 Agent 都已登录或执行工具。旧已截断历史无法恢复，本步骤不迁移历史或账户数据。回滚对应 Git 提交即可恢复此前解析和显示行为，不删除会话、安装目录或其它工作。
