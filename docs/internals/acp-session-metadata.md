# ACP 会话元数据

动态模型、模式、角色/权限与命令沿用 `AcpSessionRuntime`、`ProviderRuntimeEvent` 和线程活动。目录中的安装信息与会话广告分开：安装和版本检查不证明认证、模型权限或工具可用。

## 会话边界与优先级

`AcpRuntimeModel` 解析标准 `available_commands_update`，保留命令名称、说明和参数提示；同名命令去重。配置中的模型键优先于旧式 `models`，Cline 同时把 provider 和 model 标为模型类别时优先明确的 model 键。分组配置展开后仍保留原始模式 ID；角色/权限的合法空字符串以可逆前缀编码进入现有非空选项合同。

运行时按根会话缓存建会话之前的配置和命令。响应明确提供配置时采用响应；缺省或 null 才采用启动期间最新通知。空数组是明确撤回。失败重试清理启动缓存；子会话与重放不能覆盖根会话快照。恢复等待继续沿用既有回放屏障，不靠固定睡眠判断完成。

配置通知和主动写入维护同一份当前快照。模型、模式和角色/权限都在当前广告校验后写入；模式配置使用实际 configId，旧式 modes 使用 session/set_mode，旧式 models 使用 session/set_model。正常失败沿公共 AcpRequestError 返回，不改写当前值，也不再发送另一种请求掩盖失败。

## 公共事件与客户端

Cursor、Kimi、通用 ACP 与 Grok 将启动快照放入 session.started，将后续快照放入 session.configured。ProviderRuntimeIngestion 投影为 session.models.updated、session.mode.updated、session.config-options.updated 和 session.commands.updated；同一事件的模型/模式/配置活动使用不同 ID，payload 携带 providerInstanceId。

`packages/client-runtime` 的 providerModels/providerSkills 是 Web 与 Mobile 的共同解析入口。按线程内实例身份采用最新合法快照，不修改服务器全局目录。models=null 清除会话覆盖，models=[] 撤回广告；用户显式自定义模型保留，同名模型保留已知能力。mode=null 和空配置消除旧描述符，commands=[] 清除旧命令。

Web 在 ChatView 的共同 providerStatuses 入口合并，菜单、选择校验与发送使用同一结果。Mobile 将线程活动传到 Composer 和 modelOptions，发送队列沿同一目录归一化选项。上游模式使用现有 select 菜单，避免旧 plan/default 两态控件与原始模式冲突。命令选择填入输入框，完整名称和参数随普通 prompt 发送；厂商专用命令执行另行验证。

元数据活动用于控制菜单，不生成工具次数，也不逐条刷入工作日志。思考、上下文用量、资源附件与审批身份沿各自合同处理。

## 验证与回滚

定向回归覆盖启动/恢复响应优先级、通知替换和撤回、子会话/重放、标准与旧式 RPC、URI 模式、角色空值、实例隔离、同名能力、自定义模型以及双端菜单与发送选项。协议模拟进程证明应用链路，不能代替官方 Agent 的账号、推理或工具验收；实际 CLI 与设备结果分别登记。

本模块无数据库迁移，旧事件可以缺省这些可选字段。撤回模块提交即可回滚，不删除会话、账户或安装目录。已持久化的元数据保留，旧客户端不消费这些活动；不修改历史工具或账号状态。
