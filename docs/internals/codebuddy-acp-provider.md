# CodeBuddy ACP 调用、工具结果与恢复

核对日期2026-10-01，Windows x64，固定官方npm包@tencent-ai/codebuddy-code@2.159.0。本模块通过既有通用ACP接入，实际官方CLI加本机模型端点验证工具和新进程恢复；不代表腾讯/企业账号认证、外部推理、多端视觉或全部44入口验收。

## 调用与配置

acpAgent实例 → GenericAcpDriver → CursorAdapter → AcpSessionRuntime。产品调用codebuddy --acp，复用现有启动、动态配置、工具、审批与恢复。Windows探针用Node直接运行官方bin/codebuddy入口，避免cmd shim；安装位于仓库外，本次不下载、安装或修改官方包，不新增专属Driver或依赖。

实际initialize不返回agentInfo，authMethods精确为iOA/external/internal/selfhosted，loadSession=true。只配置models.json仍在session/new得到Authentication required（-32000，category=auth），模型端点没有请求。固定版本使用官方第三方CODEBUDDY_API_KEY和CODEBUDDY_BASE_URL后，实际新建会话成功，不调用authenticate。selfhosted是企业认证入口，不能把自定义模型和企业登录混为一谈。

在所选服务器的独立CodeBuddy配置目录创建models.json，按官方格式提供自定义模型；示例中的模型、端点和密钥环境变量应替换为自己的配置：

```json
{
  "models": [
    {
      "id": "my-model",
      "name": "自定义模型",
      "vendor": "OpenAI",
      "apiKey": "${MY_MODEL_KEY}",
      "url": "${MY_MODEL_COMPLETIONS_URL}",
      "maxInputTokens": 32768,
      "maxOutputTokens": 4096,
      "supportsToolCall": true,
      "relatedModels": { "lite": "my-model", "reasoning": "my-model", "subagent": "my-model" }
    }
  ],
  "availableModels": ["my-model"]
}
```

CODEBUDDY_BASE_URL为服务基址；models.json的url为完整chat/completions地址，不能互换。探针同时显式设置CODEBUDDY_CONFIG_DIR、CODEBUDDY_API_KEY、CODEBUDDY_BASE_URL；settings.json选择模型、default权限模式、空插件/env，启动--acp --model codework-loopback --permission-mode default --tools Read,Write,PowerShell。--tools限制工具目录，并不等于授予所有工具执行权限，审批仍用厂商原optionId。

固定新会话模型广告初值为codework-loopback，动态选择需要当前广告中的custom-local:codework-alternate，裸codework-alternate被拒绝；切换后下一实际模型请求使用第二模型。新进程的--model重新设置默认模型，恢复时先核对实际配置，再重新选择广告模型；不声称模型选择自动持久化。

隔离测试复用isolatedProbeEnvironment，空置非系统宿主变量，覆盖HOME/USERPROFILE/APPDATA/LOCALAPPDATA及XDG目录；独立项目、配置、数据、随机127.0.0.1 HTTP和合成Key由Scope持有。运行器故意设置合成宿主OPENAI_API_KEY及错误CODEBUDDY_CONFIG_DIR，实际仍使用探针自己的配置。此为配置隔离，不是操作系统沙箱或网络封锁，不访问在线数据库或真实账号余额。

## 实际结果与显示修复

| 项目                    | 固定官方实际证据与边界                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| 握手与动态配置          | 版本/help、四认证广告、loadSession=true；非空斜杠命令目录与模型配置；没有执行全部斜杠命令              |
| 模型与正文              | 实际本机HTTP路径、合成Bearer、所选模型及SSE正文；不是外部模型推理                                      |
| Read                    | 原生读取，role=tool含真实文件内容，工具详情含CODEBUDDY_SOURCE_72319                                    |
| Write允许               | 原allow_once optionId，目标文件精确APPROVED                                                            |
| 命令                    | 原生PowerShell输出标记与exit 7；非零归失败，详情保留退出码，原completed帧仍保留                        |
| 拒绝                    | 原reject_once optionId，目标文件不存在，工具failed                                                     |
| 取消                    | 审批中session/cancel、回合cancelled，目标文件不存在，已显示工具结束为failed；没有执行取消的写入        |
| 新进程恢复              | session/load同ID，下一实际模型请求中role=tool仍含旧读取正文；不是仅凭同ID或合成回复自证                |
| 取消后立即继续          | 前一模块曾返回cancelled；当前已修复RPC终结顺序并明确保护窗口，见下文当前实现；窗口内未发送，不自动重发 |
| 账号/MCP/媒体/多端/连接 | 本轮未验证，不用本机工具结果替代这些验收                                                               |

第一处实际缺陷：exit 7通知status=completed，CodeBuddy专有codebuddy.ai/rawResponse.exitCode=7才是命令结果。CodebuddyAcpToolResult只识别Bash/PowerShell专有toolName、completed和缺省/null或execute类型的有效32位非负整数；0保持完成，非零归failed，rawOutput增加exitCode。其它工具/阶段、缺码/畸形码、已有exitCode不覆盖，不从正文猜测。原content、元数据、rawOutput字段及rawPayload保留，未重执行命令。

第二处实际缺陷：session/load重放会发tool_call_update/status cancelled，标准Schema只接受pending/in_progress/completed/failed，旧协议因此终止。协议层仅以已确认codebuddy.ai/toolCancelReason=permission_denied或session_interrupted识别扩展，复用ToolCallUpdate标准字段校验，保留原载荷并派发ExtNotification。Runtime将厂商取消归现有failed终态，缺正文时给明确拒绝/取消原因；原始rawPayload仍为cancelled，会话归属、启动和重放门禁沿用标准入口。未知原因、非法工具字段和其它非法状态仍报协议错误，不作通用容错。

工具状态与detail进入既有共享事件/显示链，未增加第二套执行器或时间线。恢复期间的旧消息仍由现有重放门禁处理，本模块不会把旧工具再次作为新动作展示。单元检查覆盖非零/零码、已有值、null/畸形边界、厂商取消正文及原帧；协议检查覆盖原扩展载荷、后续标准通知与五种非法字段。

## 复验与证据边界

[CodebuddyAcpToolProbe.test.ts](../../apps/server/src/provider/acp/CodebuddyAcpToolProbe.test.ts)显式CODEWORK_CODEBUDDY_CLI_PATH才运行，该变量指向固定官方Node入口。实际六次工具动作通过；13文件相关回归256项通过，普通opt-in探针1项跳过，另实际官方探针1项通过，去重257项。Server定向类型检查、变更运行时与helper的lint、所有索引文件格式检查通过。旧CodebuddyAcpCliProbe只验握手且接受任意会话结果，原样保留，未纳入本次提交或成功证据。

```powershell
$env:CODEWORK_CODEBUDDY_CLI_PATH = '<官方2.159.0安装>/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/CodebuddyAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_CODEBUDDY_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/CodebuddyAcpToolResult.test.ts packages/effect-acp/src/protocol.test.ts
```

CodeBuddy另有标题/摘要模型请求，摘要正文会包含本轮用户标记，不能以includes(marker)认定用户请求。夹具仅以固定单条text/<user_query>完整消息识别工具动作和恢复证据；其它请求仍严格校验路径、Bearer和所选模型，不能消耗工具动作或充当历史验收。失败、诊断和最终未插桩检查分别保留；后台摘要误匹配不通过放宽历史断言解决。

检索词CodeBuddy ACP models.json CODEBUDDY_API_KEY CODEBUDDY_BASE_URL toolCancelReason，访问2026-10-01。采用[官方ACP说明](https://www.codebuddy.ai/docs/cli/acp)、[官方模型配置](https://www.codebuddy.ai/docs/cli/models)、[官方权限与身份说明](https://www.codebuddy.ai/docs/cli/iam)和固定已安装2.159.0官方包的help/headless实现，因为它们定义实际调用与厂商字段；在线文档可漂移，IAM复查一度502，认证结论同时以本轮已读取文档、固定官方实现及实际请求为据。调用与安装总览见[通用ACP实现](./generic-acp-provider.md)。

无数据库迁移、依赖或密钥存储变更，可独立撤回本模块；撤回后非零命令可再次误显示成功，专有取消重放可再次终止连接。撤回代码不会撤销已执行命令/文件副作用，保存实例与历史仍保留。全部44/P0–P5目标与A-8最终新鲜独立审计保持未完成。

## 取消后继续（当前实现）

2026-10-01固定官方2.159.0补充复查：原Runtime发送session/cancel后中断原prompt RPC，丢弃原请求回复，并发送非标准@effect/rpc/Interrupt。随后新prompt早于上一回合真正结束，可被厂商取消并返回cancelled，实际模型请求为0。ACP标准要求取消后仍接收回合更新，直到原session/prompt回复cancelled才算完成；参见[官方取消合同](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)。

共同Runtime现在将标准prompt RPC保留在会话Scope，本地Deferred只结束显示和待定根会话审批，回传审批cancelled。下一prompt持串行许可等待原RPC：最多5秒，未确认终结则返回-32000/session/prompt，“新请求未发送，请重新连接会话”，不重复发送。重复并发取消及空闲取消不再产生额外通知。Kiro原生扩展命令保留原有可中断RPC行为，Gajae空闲等待可本地取消，不把等待绑定到原RPC。

固定CodeBuddy实现还维护500毫秒取消保护窗口，原RPC回复可能先到。仅收到stopReason=cancelled且\_meta["codebuddy.ai/outcome"]="CANCELLED"时，Runtime从收到该回复起保守保留500毫秒窗口；窗口内明确返回-32000、“CodeBuddy取消保护窗口尚未结束；新请求未发送，请稍后重试”。这比厂商从取消开始计时略保守，避免依赖传输时间。窗口结束后下一次用户请求才允许发送。没有固定sleep、后台自动重发或新厂商配置，不宣称所有版本都具备同一保护策略。

子进程夹具以Deferred和实际RPC回复控制顺序，证明原RPC待定时没有第二prompt，普通取消确认后可以继续；CodeBuddy窗口内未发送，虚拟时钟推进500毫秒后成功；并发/空闲取消仅一通知且没有@effect/rpc/Interrupt。静默不回复路径证明5秒内显式失败。官方本机工具探针追加严格连续调用合同：窗口内必须是明确未发送错误、启动请求数不变；若实际时间已越过窗口则必须end_turn，不能接受新回合再次cancelled作为成功。原文件无取消写入，新进程恢复历史检查继续保留。

检索词session/cancel、pendingCancellations、lastCancelAtBySession、isCancelBarrierActive；访问2026-10-01。采用固定已安装官方dist/codebuddy-headless.js中A4=500的判断、实际ACP帧与官方ACP规范，因为它们分别解释厂商额外限制和标准终结顺序。官方资产未修改，本机模型端点不证明腾讯认证、外部推理或多端视觉。撤回本次取消模块可恢复旧行为，无迁移；原取消请求/已执行操作无法靠代码回滚撤销。完整44入口和最终独立验收仍未完成。

Grok的xAI扩展同样复用本取消入口。实际原生回执诊断确认旧扩展先结算prompt_complete兜底，再调用Runtime.cancel，竞态会先中断原RPC并丢失取消目标；现在先Runtime.cancel，最终再结算扩展等待，取消失败也会收尾本地兜底。迟到通知测试等待实际Agent正文回执后取消，保留取消后的输出过滤断言；不能只用turn.started推断原生请求已发出。没有新增专属取消调度器。
