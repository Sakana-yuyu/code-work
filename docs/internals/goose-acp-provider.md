# Goose ACP 调用、工具与验证边界

核对日期2026-10-01。固定官方 Windows CLI 1.52.0，以已安装二进制的版本与实际协议结果为准；本次不下载或升级 CLI，不使用外部模型或账户。本页的当前证据来自已提交工具、取消与产品读写探针，旧独立脚本的 Ollama 实验保留为工作历史，不进入本次成功统计。

## 调用与隔离

实例入口 acpAgent:goose 复用 GenericAcpDriver → CursorAdapter → AcpSessionRuntime，共用协议、审批、工具代理和事件显示链；启动为 goose.exe acp。initialize 广告 goose/1.52.0、loadSession=true 和 goose-provider 认证方法。配置已提供本机模型时不调用 authenticate，不把初始化成功当作外部账户登录。

探针先创建临时工作目录与临时数据根，使用 isolatedProbeEnvironment 显式空置宿主凭据，再设置以下官方配置；HOME/APPDATA 在 Windows 上不足以证明 Goose 所有路径隔离，必须设置绝对 GOOSE_PATH_ROOT。

| 项目                             | 本机验证值与作用                                                               |
| -------------------------------- | ------------------------------------------------------------------------------ |
| GOOSE_PATH_ROOT                  | 临时 home，config/data/state/.agents 均由官方 Paths 路径规则派生               |
| GOOSE_DISABLE_KEYRING            | 1，禁用真实系统凭据库                                                          |
| GOOSE_PROVIDER / active_provider | openai；独立 config/config.yaml 的 providers.openai enabled/configured 为 true |
| GOOSE_MODEL                      | codework-loopback；HTTP 请求必须携带该模型，模型目录来自本机 /v1/models        |
| OPENAI_HOST / OPENAI_BASE_PATH   | 127.0.0.1 动态 HTTP 端口 / v1/chat/completions；只用合成 local-test-only Key   |
| GOOSE_MODE                       | 工具矩阵为approve，按原审批选项回应；运行中取消探针为auto，明确选择会话模式    |
| extensions                       | developer enabled；summon disabled，配置属于临时数据根                         |
| GOOSE_DISABLE_SESSION_NAMING     | true，关闭自动会话标题模型任务，不允许后台请求消费工具动作                     |

本机 HTTP 端点支持 GET /v1/models 与 POST /v1/chat/completions 的标准 JSON/SSE；校验方法、路径、合成认证、所选模型和实际广告工具。只有当前最后一条 user 消息中的唯一动作标记才消费工具动作，历史消息不能触发重复执行。此端点合成模型选择与正文，真实 ACP 通知与文件/命令执行来自官方 CLI 和宿主处理器。

## 实际工具与生命周期

证据入口 [GooseAcpToolProbe.test.ts](../../apps/server/src/provider/acp/GooseAcpToolProbe.test.ts)。本次 Windows 受控模型路径如下，不能外推真实模型、账户或其它平台。

| 行为                | 当前证据与边界                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本/正文/模型/模式 | 固定 agentInfo/authMethods、approve 模式和当前 model 配置；实际正文标记可见，本机模型目录确实被请求                                                                                                            |
| 文件读取            | 官方广告 read 调用 fs/read_text_file，实际源文件仅读1次，下一模型请求的 role=tool 内容含旧源标记                                                                                                               |
| 读取显示限制        | Goose 的 ACP-aware 成功读取通知省略 content/rawOutput；当前共用 ACP 工具条目为 completed、详情为路径。本轮保留该真实边界，未伪造通知正文或重读文件；产品宿主读取由下节独立验证；原生通知正文与界面合并仍未实现 |
| 允许写入            | 官方 write，回传原 allow_once optionId；fs/write_text_file 恰1次，approved.txt 恰为 APPROVED                                                                                                                   |
| 命令成功/失败       | 官方 shell 调用 terminal/create/wait_for_exit/output/release；Windows 原生 shell 执行受控 Node 命令，副作用计数恰x，正文有命令标记；exit7 原通知/公共工具状态为 failed，详情含7；终端创建与释放各2次           |
| 拒绝                | 回传原 reject_once optionId；denied.txt 不存在，官方工具终态 failed                                                                                                                                            |
| 取消                | 在写入审批尚未执行时发送 session/cancel，原 prompt 返回 cancelled、工具 failed、cancelled.txt 不存在；不代表运行中命令已停止                                                                                   |
| 取消后继续          | 同一运行时下一独立 prompt=end_turn，无固定等待、自动重发或额外放宽生产超时                                                                                                                                     |
| 新进程恢复          | 关闭旧 CLI 后新进程 session/load 成功；同 sessionId，唯一恢复 prompt 的实际模型请求 role=tool 同时包含旧 read 和 shell 标记；该恢复请求恰1次，恢复正文匹配，全流程工具动作恰6次                                |

旧独立 Ollama 脚本的三种取消实验均返回 end_turn，运行命令未被证明停止；当前审批取消通过不能抹去旧失败或代替运行中终端取消验收。上轮审批探针使用此前已交付的共同通知与取消结算合同；本次另修共用Adapter的宿主终端停止责任，详见下节。文件工具通知与宿主实际请求分别计数，不让通知驱动第二次执行。

探针的宿主处理器校验 sessionId、工作根路径和受控命令并执行真实副作用，但它是本机测试宿主，不能自称完整产品 ToolBroker。产品边界另跑 [CursorAdapterToolBroker.e2e.test.ts](../../apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts) 的真实工具代理加协议夹具，以及 [AcpJsonRpcConnection.test.ts](../../apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts) 的传输/取消合同；两者与真实 Goose CLI 结果分别登记。

## 运行中宿主终端取消

共用生产入口为 [CursorAdapter.ts](../../apps/server/src/provider/Layers/CursorAdapter.ts)，被CursorDriver、GenericAcpDriver及KimiDriver复用。原interruptTurn只发送ACP取消；ToolBroker.cancel仅结算策略，并不停止终端进程。固定Goose官方AcpTools.shell调用acp_shell时没有把cancellation_token传入宿主等待，因此本地回合显示cancelled后命令仍可能运行。修复在共同宿主边界，不新增Goose专用Driver或第二套终端管理器。

复用已有终端表，记录创建回合、输出限额及创建/停止状态；terminal.exec调用前登记句柄。取消先标记当前回合，再沿既有bridge对该回合已创建的终端逐个terminal.kill；收集全部停止结果后才返回错误，不因一项失败放弃其它终端。创建结果晚到时补停并返回明确ACP错误，不把句柄交回已取消回合。未授予当前Run的句柄、其它回合及空闲取消不重复停止；句柄继续供Agent查询退出与release/会话清理。

停止被拒或失败沿既有runtime.error公开返回“宿主终端停止未确认”，保留线程/回合归属及permission_error/provider_error类别；普通取消调用同时返回失败，晚到创建通过公开错误反馈。不会以本地cancelled冒充已停止，不输出原命令、环境或模型内容。原prompt RPC结算及共用续聊等待保持原合同，不虚构远端stopReason。

证据入口 [GooseAcpCancellationProbe.test.ts](../../apps/server/src/provider/acp/GooseAcpCancellationProbe.test.ts)：普通模式的协议夹具始终执行，旧HEAD明确没有terminal.kill请求，修复后通过。官方1.52.0、本机受控模型和实际捕获Node进程覆盖running、late、denied、late-denied：前两项确实退出，并在同连接下一回合收到正文GOOSE_NEXT_OK和completed回执；后两项仍运行且公开停止失败，最终会话清理关闭。每项停止尝试恰1次，额外未交给Adapter的进程仍活着，没有意外文件副作用。创建/等待/退出/完成均用实际屏障，无新增sleep或自动重发。

官方取消探针的bridge是受控终端替身，执行真实Node进程；不等于产品TerminalManager的PTY或进程树验证。普通协议夹具也不冒充官方CLI。产品ToolBroker协议E2E另跑，该取消探针不证明产品终端代理/浏览器联调；产品文件读取另由下节验证；原生prompt的远端stopReason未在本次Adapter探针中捕获。停止后续聊是实际正文/完成回执证据，停止失败不会被计为成功。历史Ollama end_turn失败保留；上轮读取通知缺正文的边界仍未解决。

## 产品读取、公开详情与接入条件

证据入口 [GooseAcpToolBrokerProbe.test.ts](../../apps/server/src/provider/acp/GooseAcpToolBrokerProbe.test.ts)，源码基线9a851cdc7a6d64c2f4a9de8974f6f1a8fe240977。固定官方1.52.0与本机受控模型，经Generic共用CursorAdapter → CompositionProviderToolBrokerBridge → CompositionRuntimeToolBridge → 真实ToolBroker/WorkspaceFileSystem；没有使用宿主读取替身，只有Task/Run查询采用受控的已授权记录。独立配置/数据根与auto模式沿前述规则，本次不使用真实账户。

实际发出3次read：工作区文件成功，工作区外文件在共同路径验证拒绝，缺文件由ToolBroker返回failed并转为明确ACP错误。越界请求不进入ToolBroker，源文件成功读取调用恰1次，另1次代理调用为缺文件；模型的对应role=tool身份/正文分别核对，三回合都结束。成功内容按现有ToolBroker规则把合成api_key值替换为[REDACTED]，原文件字节不改；模型/公开事件没有原合成密钥，也没有越界文件正文。此规则不变更生产脱敏策略或读取限额。

公开链路分别核对Adapter item.completed → runtimeEventToActivities → projectActivityPayload：三个原生读取终态为completed/failed/failed，成功详情为源路径，没有content/rawOutput/源正文，三个公共工具记录没有重复宿主执行记录。模型确实收到脱敏源正文，但这不能证明工具详情已显示正文。

原因有明确协议边界：固定官方 [Goose宿主读取请求](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/fs.rs)只有sessionId、path、line/limit，没有对应原生toolCallId；成功ACP-aware转换又省略正文。宿主调用使用共同Adapter生成的独立ID，本探针核对它不等于原生itemId。现有Invocation协调记录只保存归属/状态/指纹，不能从记录恢复历史正文。固定 [Paseo读取处理](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/server/src/server/agent/providers/acp-agent.ts)也只向CLI回传文件内容，不构造这项关联；不能假设对照项目已解决此边界。

读取正文接入需要Agent在同toolCallId的通知中返回实际结果，或双方协议明确给出宿主请求与工具的关联身份；条件具备后复用现有工具结果合并/预算/公共投影与客户端详情，不另造时间线。在未具备权威关联时，禁止按路径、最近调用或唯一已观察read猜身份：并行同路径和edit的内部读取都可能关联错。也不重读文件填充过去结果或增加第二条工具记录冒充原调用。本轮不改写原生通知，不声称正文显示已完成；浏览器、完整产品终端/持久化Run生命周期、远程连接另验。

复验设置CODEWORK_GOOSE_CLI_PATH后执行下列第一行；没有opt-in或非Windows时该项跳过，不算成功。HEAD加精确3文件索引的独立副本，官方产品读取1项通过；普通协议/RuntimeBridge/ProviderBridge回归17项通过、新官方probe1项跳过。Server类型检查及新probe定向lint退出0，只有原账号池2条类型建议；首次新增测试把未知data当对象访问而失败，改为现有Schema类型验证，并合并Layer提供以消除新生命周期告警后重跑。此模块是产品读取验收与明确边界，不是读取正文UI修复；回滚仅撤回该probe/文档模块，无数据迁移。

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GooseAcpToolBrokerProbe.test.ts
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GooseAcpToolBrokerProbe.test.ts apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts apps/server/src/composition/CompositionRuntimeToolBridge.test.ts apps/server/src/composition/CompositionProviderToolBrokerBridge.test.ts
```

## 产品写入与可信运行模式

核对基线5b7772d29ef2eecb4cad485bb7f8efc8e57fd188。上节读取模块的17项/3文件是前次证据；当前同一产品探针扩展为3次读取、3次写入，共6个真实Goose动作、4次真实ToolBroker调用。源码基线具备写入能力、会话为full-access时，allowed.txt仍返回denied；三层回归证实服务端运行模式在到达ToolBroker前丢失。

复用既有RuntimeMode与CapabilityPolicy：CompositionProviderAgentDriver把同一服务端模式绑定到Session和ProviderToolBrokerContext，CompositionProviderToolBrokerBridge只从可信context取模式，CompositionRuntimeToolBridge以内部第二参数接受并传给ToolBroker。公开HTTP/协议输入仍不携带该参数，原始工具输入声明runtimeMode=full-access不生效。未配置模式保持既有审批行为；full-access仍须通过Task/Run/Agent/Handshake、能力授权和持久化workspaceRoot检查，不能访问工作区外文件，策略本身没有修改。

真实官方1.52.0配本机受控模型验证：full-access和有效write授权创建allowed.txt，字节恰为GOOSE_PRODUCT_WRITE_31579；宿主approval-required拒绝denied.txt并返回tool_approval_required，文件不存在；越界write在共同路径校验拒绝，外部合成文件原字节不变。写入原生工具与公共状态分别为completed/failed/failed；原有读取脱敏、缺文件失败和读取正文显示限制仍按上节断言。

探针的ToolBroker binding在建会话时激活，因此每组写入先结束自己启动的会话，再配置并建新会话；不能在活动会话只配置pending binding后声称模式已经改变。负向宿主审批组仍让Goose使用原生auto，证明原生许可不能升级宿主模式；它不代表原生approve/allow_once已经完成产品审批授权。Driver回归另外检查Session与context在full-access/approval-required两种模式一致。

当前独立10文件索引副本：官方产品读写探针1项通过；Provider Driver/Registry/两层Bridge/真实本地HTTP/协议Client/CapabilityPolicy和产品Adapter回归56项通过，普通模式的官方probe1项因无opt-in跳过。HTTP测试直接提交带伪造full-access的JSON，进入Bridge时仍无可信模式；既有策略回归覆盖缺失、越权、过期、撤销授权，即使full-access仍拒绝。Server类型检查退出0，仅原账号池2条建议；定向lint退出0，RuntimeBridge原有未使用类型与内联Schema编译2条警告保留。

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/composition/CompositionProviderAgentDriver.test.ts apps/server/src/composition/CompositionProviderAgentDriverRegistry.test.ts apps/server/src/composition/CompositionProviderToolBrokerBridge.test.ts apps/server/src/composition/CompositionRuntimeToolBridge.test.ts apps/server/src/composition/CompositionRuntimeToolBridgeHttp.test.ts apps/server/src/composition/CompositionRuntimeToolBridgeProtocol.test.ts apps/server/src/composition/CapabilityPolicy.test.ts apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts
```

写入授权增量不增加厂商Driver、依赖或第二套权限系统。取消仍沿既有RuntimeBridge/ProviderBridge合同，本次未重新验证真实产品PTY。原生allow_once和宿主approvalRequestId是独立身份，approval-required下的产品审批发起/返回仍需下一增量验证；不把本次明确拒绝算完整审批成功。真实账号/余额、完整数据库Run生命周期、浏览器、Electron、手机、远程和44入口最终审计未由本次证明。

回滚只撤回本次可信模式传递、定向回归及稳定文档提交，无数据库或配置迁移；保留前次宿主取消修复、读取探针和其它未提交工作。撤回后恢复写入需要宿主审批的旧行为。

## 复验、失败与回滚

```powershell
$env:CODEWORK_GOOSE_CLI_PATH = '<固定1.52.0目录>/goose.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GooseAcpToolProbe.test.ts apps/server/src/provider/acp/GooseAcpCancellationProbe.test.ts
Remove-Item Env:CODEWORK_GOOSE_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GooseAcpCancellationProbe.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Layers/KimiProvider.test.ts
```

官方CLI检查未提供opt-in或非Windows时跳过，普通协议夹具仍执行，跳过不记为通过。源码基线397a4ddc0ee85ccb0433a89f42c83bca2968173f加精确4文件索引的独立副本、workspace依赖指向副本：官方工具矩阵1项、官方取消4项和普通夹具1项，共6项通过；普通模式相关传输/产品代理及Cursor/Generic/Kimi共119项通过、4项官方取消跳过，两批有夹具重叠不直接累加。另按runtime.error筛选既有 [ProviderRuntimeIngestion.test.ts](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts) 的错误状态/工作日志投影，2项通过、97项因筛选跳过；该结果不替代实际GUI。Server类型检查退出0，仅原账号池文件2条建议；改动2源码文件定向lint与4文件格式通过。旧生产实现的官方running检查明确进程仍运行，普通夹具明确无kill；修复后各原断言通过。本轮首次测试在最终回收重复stopSession时失败，改为已有hasSession防重，不吞错误；首次新增测试类型错误改为已有Schema解码模式后通过。首次准备器错误工具名、遗漏模型目录、Windows shell 引号及定向lint失败均保留外置日志，不能算产品缺陷；读取正文的通知缺失有真实失败和固定官方源码对应。

准备阶段未设置 GOOSE_PATH_ROOT 的诊断曾读取默认技能资料，该阶段不能证明数据隔离，并可能生成默认 Goose 会话；没有删除或回写真实 Goose 数据。最终探针显式设置官方绝对路径根，关闭 keyring，不复制账户/密钥或读取在线 Code Work 数据库。CLI、HTTP 连接、捕获终端及临时目录由 Scope 回收；只结束自己捕获的进程，不按名称批量结束。

本次模块修改共享Adapter和取消探针/文档，不涉及账户或数据库迁移；回滚仅撤回这一模块提交，需保留上轮工具探针和其它工作区修改。共用变化影响Cursor、Generic ACP和Kimi的宿主终端取消，Grok独立实现未改。读取显示与产品宿主结果的界面整合、产品PTY进程树、外部推理/真实余额、MCP/媒体、Web/Electron/手机及远程连接仍未由本次证明；44入口/P0–P5和最终独立审计未完成。

检索词 Goose v1.52.0 ACP tools cancel OpenAI config Paths，访问日期2026-10-01。采用固定官方 [ACP server](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server.rs)、[文件与终端实现](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/fs.rs)、[工具通知转换](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server/tool_calls/conversion.rs)、[OpenAI端点配置](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/providers/openai_def.rs)和[数据路径](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/config/paths.rs)，因为它们直接定义固定版本的协议/隔离/显示边界；不以 README、其它 ACP 客户端实现或最新版本行为推断本次结果。
