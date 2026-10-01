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

写入授权增量不增加厂商Driver、依赖或第二套权限系统。该轮取消沿既有RuntimeBridge/ProviderBridge合同，未重新验证真实产品PTY。原生allow_once和宿主approvalRequestId是独立身份，该轮的明确拒绝不能算完整审批成功；产品审批发起/返回的后续证据见下节。真实账号/余额、完整数据库Run生命周期、浏览器、Electron、手机、远程和44入口最终审计未由这项模式传递证明。

回滚只撤回本次可信模式传递、定向回归及稳定文档提交，无数据库或配置迁移；保留前次宿主取消修复、读取探针和其它未提交工作。撤回后恢复写入需要宿主审批的旧行为。

## 产品宿主单次审批与执行期限

源码基线38f60a5a3633f433f2385e796bf4530095ea7fc5。CapabilityPolicy已有单次approve，ToolBroker也已返回approvalRequestId；旧共同Adapter直接把需要审批转为ACP失败，没有发起宿主审批或把决定交回策略。本增量复用已有request.opened/request.resolved、pendingApprovals、respondToRequest及客户端审批合同，不新增厂商Driver、权限系统、公开协议字段或依赖。

共同invokeTool把内部审批回调交给ProviderBridge，再由RuntimeBridge的原在途claim等待。只有明确accept调用真实policy.approve，并用原task/run/agent/toolCallId、幂等键、参数及同一approvalRequestId执行一次；等待后重新核对Run归属、授权身份及持久化工作根，ToolBroker再次检查实际能力。decline拒绝，cancel和未提供的扩大授权决定取消，不升级会话模式。回调只能从服务端第二参数传入，原始工具参数中的伪造回调被忽略；公开HTTP/协议没有回调入口。原生ACP选项审批继续使用原合同，不能代替宿主授权。

宿主审批显示“允许本次、拒绝、取消”三个选项，沿既有file_change_approval或exec_command_approval呈现。事件仅含工具名、宿主调用身份和必要的相对路径，不包含写入正文或环境；同一requestId结算一次，完成/取消/关闭时清理等待项。该身份是宿主调用身份，不伪装成Goose原生工具ID；读取正文显示的协议限制仍按上节保留。

执行期限迁入RuntimeBridge，仅包围实际ToolBroker调用，人工审批等待不消耗默认30秒。取消和期限到达均在返回前中断并等待本次持有的执行分支，随后才释放幂等键所有权；不让迟到审批或工具结果产生后台副作用。最小运行时诊断发现本机已安装Effect beta.103的默认raceFirst返回后未中断实际败方，故用已有acquireUseRelease/forkChild/Fiber.interrupt明确持有并回收两个分支，不修改依赖或只改显示状态。调用可能需等待执行器完成中断清理，不能把返回取消当作外部远程操作已经撤销。

固定Goose 1.52.0配本机受控模型和真实ToolBroker/WorkspaceFileSystem，当前矩阵8个工具动作、7次Broker尝试；其中允许本次包含首次需要审批及一次原身份重试。Task/Run仍为受控有效记录，原生会话仍为auto/full-access，宿主单次审批独立验证。

| 宿主模式与决定            | 实际结果                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| full-access写入           | allowed.txt成功，沿前轮可信模式合同                                                                                                  |
| approval-required拒绝     | denied.txt不存在，原生工具与公共投影均failed                                                                                         |
| approval-required允许本次 | approved.txt字节恰为GOOSE_PRODUCT_WRITE_31579；两次Broker尝试具有相同参数、调用ID及幂等键，仅第二次附审批ID；原生及公共状态completed |
| approval-required取消     | cancelled.txt不存在，原生及公共状态failed，审批事件明确cancel；不据此伪造Goose原生工具cancelled状态                                  |
| 越界读写及缺文件          | 保留既有明确错误、工作区外字节不变和读取脱敏断言                                                                                     |

三次宿主request.opened与resolved逐一同ID配对，决定依次decline/accept/cancel；无正文泄露。普通产品协议子进程E2E同时覆盖read/accept/decline/cancel，无官方CLI时也执行。RuntimeBridge回归覆盖人工等待超过执行期限后允许、拒绝/取消/扩大授权不执行、Run归属变化拒绝、重复在途键不替换取消所有权、错误scope不能取消、取消后迟到允许不执行，以及执行期限后迟到结果无副作用。

本轮HEAD加精确索引的独立副本：普通Bridge/HTTP/协议/策略及产品Adapter回归38项通过、官方probe1项未opt-in跳过；指定固定官方CLI后产品矩阵1项通过；CursorAdapter/GenericAcpDriver/KimiProvider及AcpJsonRpcConnection回归117项通过。Server类型检查及8个变更TS文件定向lint退出0，仅保留原账号池2条类型建议与RuntimeBridge2条既有lint警告。第一次新增测试遗漏早退屏障而超时，修正测试屏障后明确旧生产没有等待审批；取消测试另明确复现迟到执行，修复后原断言通过。新增审批回调和取消清理的类型错误修正后重新跑正式矩阵，不计失败为成功。

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/composition/CompositionRuntimeToolBridge.test.ts apps/server/src/composition/CompositionProviderToolBrokerBridge.test.ts apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts
$env:CODEWORK_GOOSE_CLI_PATH = '<固定1.52.0目录>/goose.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GooseAcpToolBrokerProbe.test.ts
Remove-Item Env:CODEWORK_GOOSE_CLI_PATH
```

本节验证服务端事件、既有回应入口和真实文件副作用，尚未证明浏览器实际点击、Electron、手机、完整数据库Run生命周期或产品PTY进程树；无真实账户/余额或外部模型请求，44入口/P0–P5最终审计仍未完成。共用宿主回调影响Cursor、Generic ACP和Kimi；Grok独立实现无对应宿主ToolBroker入口，此增量不改它。回滚仅撤回本次单次审批/执行期限代码、回归及文档提交，无数据库迁移；保留前轮可信模式与终端取消修复及其它未提交工作。

## 真实任务入口读取关联对话模式

核对基线755dd3795d8b7d2c61073d25b4d8955c7dc2749b。前节固定Goose探针显式配置approval-required，生产CompositionProviderAgentDriverRegistry却未给Driver传模式，Driver默认为full-access。因此探针的单次审批成功不证明真实任务会遵守对话选择的审批模式。本增量在已有Registry/Driver共同入口修复，适用于全部经该入口派发的Provider，不增加Goose专用分支。

Registry live注入现有ProjectionSnapshotQuery.getThreadShellById，每次派发读取关联对话的runtimeMode；Driver复用原runtimeMode配置承载服务端解析，在握手和建会话前完成读取，Session及宿主ToolBrokerContext使用同一结果。需要审批→全权限→需要审批的变化在下次派发生效，不在Registry refresh时缓存某个对话的模式。关联对话不存在或查询失败明确返回provider_thread_not_found/provider_runtime_mode_lookup_failed，不建会话、不签发本次握手；不会在查询失败后改用默认全权限。

无关联对话的任务复用项目现有DEFAULT_RUNTIME_MODE，其当前值为full-access；本增量没有把全局默认改成需要审批。直接构造Driver的既有静态模式兼容，生产Registry始终提供对话查询。动态模式在启动身份中记录null，表示派发前尚无固定会话模式，不能宣称已知full-access；静态模式仍原样记录。能力授权、Run/工作根、原生和宿主单次审批继续沿前节门禁，未增加公开派发参数或让外部工具自报权限。

定向回归先明确旧Registry把四次派发全部设为full-access；修复后验证关联模式逐次读取、无关联的既有默认、缺失/查询错误无Adapter启动，以及Session/context一致与动态启动身份不伪造模式。公开审批投影另验证同一requestId、工具名/路径详情、仅accept/decline/cancel选项及对应结算决定，公共活动不包含原args或合成写入正文。既有审批组件已有显式options与完整detail，未为尚未复现的问题重写界面。

本轮按test-codework-app从精确源码独立副本启动完整dev，数据根独立于在线安装，并通过in-app浏览器配对、查看实际引导页面和服务器重启后的自动重连。准备时依赖镜像没有.bin/vp.cmd而spawn vp ENOENT，补齐副本内现有启动shim后启动；没有修改生产启动代码。服务端测试源变更触发watch重启和短暂代理错误，不能将其当产品审批失败。本轮发现并修复真实任务前置模式缺口，尚未执行宿主审批按钮点击矩阵；保留隔离环境和浏览器供后续真实任务验证。

复验入口为CompositionProviderAgentDriver.test.ts、CompositionProviderAgentDriverRegistry.test.ts、CompositionProviderToolBrokerBridge.test.ts、CompositionRuntimeToolBridge.test.ts和ProviderRuntimeIngestion.approval.test.ts，5文件55项通过；Server类型检查退出0，仅既有账号池2条建议；6个变更TS定向lint退出0，Registry测试原未使用ThreadId警告保留。新增测试首次未结束原Run而触发busy，按既有revokeCapabilityHandshake收尾后明确旧生产全权限错误；新增手动Effect runner触发净新增禁令，改用现有@effect/vitest后通过；没有修改lint基线或吞掉错误。旧静态构造的官方Goose矩阵不因本次Registry改动转化为数据库Run或浏览器审批证据。回滚仅撤回本次关联模式解析/服务注入/合同回归及文档，无数据库迁移；此前单次审批和可信模式传递保留。完整真实Run、恢复时模式快照、按钮允许/拒绝/取消/迟到回应、PTY、账户余额、多端与远程最终验收继续分项验证。

## 生产 Provider Projection 必须取得宿主工具 Bridge

2026-10-02对照8c0326c25b480f102c28c44c20afbd56da7e234b的完整生产服务，真实server.dispatchCompositionTask会在模型或工具执行前返回provider_capability_handshake_unsupported。问题不是ACP工具名称或审批组件，而是CompositionProviderAgentDriverProjection在构建时通过serviceOption读取Bridge；同级merge并不把兄弟Layer输出提供给它，且原Bridge反向依赖包含Projection的RuntimeDependencies，最终生产Driver静默登记为supportsToolBroker=false、supportsCapabilityHandshake=false。

现在生产Projection将CompositionRuntimeToolBridgeService作为必需依赖，缺失时启动失败，不把服务端漏接能力伪装为Provider不支持。server先用现有TaskStore、加密InputStore和ToolBroker构建Bridge，再显式提供给AgentDriverProjection。InputStore复用同一Layer，Bridge不再反向依赖整个RuntimeDependencies，避免循环构建和重复存储。工厂的可选Bridge仍用于明确不支持宿主工具的测试/调用方；生产live始终取得真实Bridge。没有新增工具、公开参数、Driver或权限系统，ToolBroker的Task/Run状态、握手、grant与工作根门禁保留。

复验CompositionProviderAgentDriverRegistry.test.ts的两项生产Layer回归：缺Bridge明确失败，提供Bridge后共同Profile同时支持工具与握手。负向用例只在测试Context故意缺服务，生产不绕过类型或依赖。再运行Driver、Registry、ProviderBridge、RuntimeBridge与公共审批投影5文件，共57项通过；Server类型检查和3个变更TS定向lint通过，原账号池建议及Registry测试ThreadId警告保留。

真实隔离home的项目/对话均通过现有业务命令建立。修复前Cursor与Generic ACP两次派发都返回不支持握手；修复后真实服务的Cursor Profile两项能力变为true，新派发已经创建会话、turn.started与持久化runtimeTaskId，实际宿主读取仍返回“Code Work ToolBroker未完成ACP请求”，任务明确failed。Web实际进入该业务对话后可见同一错误；这只是能力注入修复和失败可见性的证据，不是允许/拒绝/取消按钮通过。所用普通协议夹具不是官方Cursor或Goose推理；Cursor健康探测agent about超时与Generic ACP的Windows.cmd健康路径EINVAL分别保留，不能算真实CLI可用。

下一责任点是sendTurn回合尚未结束时Run/握手的权威持久化顺序。当前任务失败不能单凭错误文案确定是握手不匹配，须用受控回执和真实存储补确定性回归；不能放宽RuntimeBridge门禁或直接写running/handshake来制造按钮。宿主单次审批的前轮静态探针仍不能替代完整生产Run与Web实际点击。完整44入口/P0–P5、多端/远程及最终独立审计继续保持未完成边界。

回滚仅撤回本次Projection必需Bridge注入、server Layer解环、两个回归及对应说明，无数据迁移；保留关联模式、此前宿主单次审批与用户原有工作。隔离服务、业务项目/失败Run和浏览器跨轮保留，配对令牌不进入文档或截图。

## 真实 Run 启动、握手落库与审批闭环

2026-10-02对照eaf013dc56f09c77ccb45b0cf8d512abf1b69b13继续完整生产派发。ACP的sendTurn可能到prompt终态才返回，而Driver在它之前已签发握手；早到turn.started虽然把Task/Run变为running并保存runtimeTaskId，其可信pending绑定没有传递capabilityHandshakeId，RuntimeBridge因Run缺少身份而拒绝工具。现在现有Driver/Registry事件绑定携带服务端已验证的握手，Projector仅在turn.started从匹配agent/runtime的可信Driver绑定取得它，与running在同一存储事务提交。原始Provider事件payload不能授予身份；冲突握手或其它Driver归属被拒绝，已有握手不覆盖，终态/旧Run/重复事件仍遵守原锁定规则。

提前终态现在可以撤销已经落库的握手；同一Run的pending/active/history共享一次context回收责任，Projector先清理与sendTurn返回后清理不重复执行。回收仍调用既有clearToolBroker/revokeCapabilityHandshake，取消也复用它，没有新权限系统或数据迁移。恢复后没有进程内回收责任时仍沿既有持久化身份回收逻辑，不把原始事件声明当恢复凭据。

同一对话连续派发另有已证启动顺序问题：Cursor的startSession会关闭旧Session，关闭会清掉thread工具绑定。如果先configure本Run再调用startSession，新的绑定也会被删，真实第二次派发返回provider_session_start_failed。共同Driver现在通过已有listSessions先关闭精确instance/thread的旧Session，再配置本Run的可信绑定；没有修改Cursor私有Adapter或用户原差异。查询/关闭失败明确结算并清理握手，不继续启动。

确定性回归使用真实Orchestrator签发grant和派发、内存SQLite TaskStore、共同Driver/Projector与RuntimeBridge，在Deferred暂停sendTurn返回时核对可信握手和工具门禁，提前终态/重放只清理一次、后续Run不丢新绑定。工具执行替身只验证门禁后的计数，不冒充真实文件。另验其它agent/runtime、已有握手冲突与raw-only声明。旧握手漏存和旧Session清理新绑定各有失败回归；变更范围5文件87项、Orchestrator及ACP跨进程2文件32项通过，Server类型检查和5个TS定向lint通过。首轮测试raw.source错误字面量导致2项类型错误，修正为合法acp.jsonrpc而不绕过合同；原账号池建议及Node DEP0190警告保留。

真实隔离完整服务使用现有业务项目/对话/RPC派发普通ACP夹具，通过生产ToolBroker读取notes.txt的beta/gamma，Web实际出现同一工具文件路径与允许本次/拒绝/取消。允许后Run completed，approved.txt内容REAL_RUN_APPROVED，持久化工具表恰有一次read和一次write成功；拒绝与取消分别使用全新decline.txt/cancel.txt，两文件均不存在，对应Run只有一次read而无write执行。只读SQLite核对3个唯一审批request的resolved决定分别accept/decline/cancel，turnId与各实际Run匹配；没有手写业务投影或放宽门禁制造按钮。浏览器源码watch重启后自动恢复连接，批准/拒绝/取消均实际点击并记录截图。

普通夹具遇到被拒绝或取消的工具请求会终止prompt，因此这两次Run均failed/provider_turn_failed，Web仍显示通用ToolBroker错误；审批退出、决定结算与无文件副作用已经验证，不能声称负向错误解释完整或整轮取消语义已完成。批准后连续第二Run曾失败是本次旧Session顺序红灯，修复后连续拒绝/取消均实际进入审批。Cursor健康agent about超时和Generic ACP Windows.cmd健康路径EINVAL仍保留，本次不是官方Cursor/Goose外部推理或真实账户验证。

本次只证明生产可信握手、连续Run与这三项Web宿主写入审批闭环；极早工具请求与异步turn.started消费之间的因果屏障、产品PTY/迟到回应/恢复、工具结果历史详情、窄屏/桌面/手机、远程及44入口完整矩阵须分别验证。不能把119项定向检查或普通协议夹具替代44入口/P0–P5和最终新鲜独立审计。隔离服务/home/业务证据跨轮保留，令牌不进入文档和截图。

回滚仅撤回可信运行绑定字段、Projector原子握手激活、Driver共享回收与旧Session顺序、两个回归及本段说明；保留上一轮生产Bridge注入、关联模式和用户原工作，无迁移。

## 宿主请求等待启动事务提交

2026-10-02对照eee08ccc417653a7c275c88489d2512373f4a6f3复验极早请求。前段原子保存握手解决了漏存，但turn.started经异步订阅消费，Provider发出工具请求时投影事务仍可能未提交。确定性回归暂停真实Projector的事务提交，同时真实Orchestrator派发和Provider bridge发起读取；旧实现返回denied/task_not_running，而非工具执行错误。测试不直接写running/handshake，也不通过sleep/poll决定先后。

共同ProviderDriver现在为本Run创建启动确认信号，随既有可信pending/active/history绑定携带内部confirmRuntimeStart；Projector只有在turn.started的权威事务提交、Run为running且握手/Driver归属匹配后确认。Provider宿主bridge收到极早请求时先等待该信号，确认后仍由原RuntimeBridge完整重验Task/Run、握手、grant与工作根。这个Effect仅在服务端内存绑定中传递，不新增公开合同、UI参数、依赖或新权限框架，不从Provider raw payload授予确认。

等待确认最多30秒；未确认返回failed/provider_runtime_start_unconfirmed，不进入ToolBroker。提前回收先唤醒等待者，返回cancelled/tool_cancelled，后续不执行；若提前终态发生在握手尚未落库时，Projector可用同Driver可信绑定中的已签发握手调用既有撤销路径。单次回收责任沿前段releaseContext，确认后才允许的工具仍遵守原权限校验。等待中的请求取消或超时后，晚到投影不会重放请求或制造副作用；这不替代运行中PTY/进程树取消验证。

一个三场景回归复用同一真实存储和业务派发夹具：正常提交确认后工具执行一次；确认前投影cancelled终态则请求被取消且执行零次；TestClock推进30秒仍无确认则失败，随后实际释放迟到提交，执行次数仍零。定向5文件88项与Orchestrator/ACP跨进程2文件32项共120项通过；Server类型检查、5个TS定向lint通过。第一次类型检查发现测试手写errorCode可选类型与exactOptionalPropertyTypes不符，改用已有ProviderToolBrokerResult，未绕过合同或改基线；原账号池建议、Node DEP0190警告保留。

本轮保留完整隔离服务，以普通ACP夹具和现有业务RPC再次真实派发。Web实际出现barrier-approved.txt审批并点击允许本次，Run completed；文件为RUNTIME_START_BARRIER_APPROVED，读取结果beta/gamma。只读隔离SQLite确认对应turn的审批resolved/accept，工具表恰有一次read和一次write成功，截图保留批准后正文/审批退出。约41秒的实际审批等待没有被30秒启动确认期限截断，启动确认期限不等于人工审批或执行期限。

本轮浏览器仅复验正向允许；前段拒绝/取消的实际文件与决定证据仍是前轮结果，不重复累计为本轮通过。Cursor夹具健康agent about超时、Generic ACP Windows.cmd健康路径EINVAL仍未修复，也不冒充官方Cursor/Goose或外部账号推理。完整44入口/P0–P5、产品PTY、迟到审批/恢复、工具历史详情、窄屏/桌面/手机与远程及最终新鲜独立审计各自仍待验证。

回滚只撤回本段内部启动确认字段、Projector提交确认/提前终态回收、Provider bridge等待及三场景回归，保留前段握手落库/单次回收/旧Session顺序和用户工作，无数据迁移。隔离服务/home/业务记录跨轮保留，普通夹具配置已恢复，临时令牌不进入文档/截图/提交。

## 产品PTY执行与取消顺序

2026-10-02从b476ba6ba9b1382814ff555c3632ac39e49cf418继续完整生产Run，经现有ACP宿主Bridge、RuntimeBridge、ToolBroker与NodePtyAdapter验证终端。正常实际Node命令输出PRODUCT_PTY_EXIT，wait_for_exit得到退出码7，release成功；只读隔离存储确认一次terminal.exec、一次terminal.close，捕获子进程已退出。这里使用普通ACP请求夹具，但执行端是真实产品PTY，不是之前测试Bridge内的Node替身。

真实取消暴露共同顺序缺口：Cursor共同Adapter先发送ACP cancel，Agent终态可先投影为cancelled并撤销Run权限，随后terminal.kill被原门禁拒绝。现在先停止当前回合已登记且就绪的宿主终端，再结算待决审批/输入和通知Agent取消；所有终端仍各自尝试，停止失败保留明确错误，finally保证取消通知不会因停止失败被跳过。已有回合身份、迟到创建补停和权限门禁保留，没有新增取消框架或放宽终态权限。取消前后实际捕获的Node PID由存活变为退出，工具表只有一次exec和一次kill，取消RPC和Run均为cancelled。

显式terminal/kill复验又揭示Windows原生PTY停止返回-1，与项目内ACP生成schema要求非负uint32不一致，terminal/output无法编码，wait/release未完成。output与wait现在共用有界转换：仅有效uint32作为退出码，其余返回协议允许的null表示未知，不伪造成功0，也不改原生Manager快照。signal沿原已知信号转换。修复后真实kill、output、wait_for_exit、release顺序完整，两种退出查询都是null，输出仍包含PRODUCT_PTY_KILL；一次exec、一次kill、两次snapshot、一次close均成功，实际子进程已退出。

CompositionProviderAgentDriver.e2e.test.ts一个参数化回归使用真实ACP子进程、Orchestrator派发/grant、内存SQLite Store、可信Driver/Projector和RuntimeBridge，分别覆盖取消前kill仍在running作用域、原生负退出码的output/wait/release，以及停止失败仍向Agent发送取消并返回明确失败。测试执行替身仅检查顺序与结果转换，不冒充PTY；完整隔离服务的三种真实终端证明另列。以标准文件通知等待ACP create实际回复，不用固定睡眠或轮询。旧取消顺序回归明确kill执行时Run已cancelled；负退出码回归保持失败记录，原等待终态因编码失败超时后改为先等待实际派发回执再验终态，不放宽成功断言。

定向Composition/Runtime四文件79项、Cursor共同Adapter/真实Manager命令/Goose取消普通模式三文件45项共124项通过，4项官方CLI opt-in跳过不算通过；Server类型检查与两个变更TS定向lint均通过。第一次新增测试类型检查发现ToolBrokerInput与RuntimeInvocation不能互换，以及测试存储错误不符合invoke无错误合同；改为既有输入类型，存储错误在测试明确die，不用断言或屏蔽诊断。原账号池建议、Node DEP0190及ConPTY AttachConsole诊断保留。

开发node --watch在第一次PTY请求后触发重启并使RPC断开，留下孤立Run，这不是成功证明。复验只临时在隔离副本关闭watch、启动后恢复package原字节，保留同一home/项目/端口；自己捕获的服务会话受控重启，没有模式杀进程或写live userdata。夹具最初参数变量拼错使Node进入REPL，修正为现有indexed ARG_0，失败保留；这与产品取消顺序缺口分开。两个失败终端仅按本轮已捕获Run/terminalId使用原RPC关闭，未动用户终端，普通夹具原配置已恢复。

运行中取消后的进程停止已有证据，但终态后clearToolBroker尝试terminal.close仍受到正常门禁拒绝；本轮未证明取消自动release或迟到创建/完整进程树所有边界，必须继续核对可信资源回收责任，不从进程退出推导句柄/历史已经释放。terminal/wait沿现有snapshot轮询，本轮未新增等待轮询。没有本轮浏览器/Electron/手机/远程或官方CLI推理证明，不能以124项及真实PTY替代44入口/P0–P5与最终新鲜独立审计。

回滚只撤回本次共同Adapter取消先后、ACP退出码转换、参数化回归与本段说明，无迁移；保留前轮启动确认、握手、单次审批与用户原工作。共同实现影响Cursor、Generic ACP和Kimi；Grok独立宿主实现未改，非当前普通Cursor夹具入口的实际PTY验证仍单列。隔离完整服务、业务成功/失败记录跨轮保留。

## 终态后的可信宿主资源回收（2026-10-02）

上一节的首轮产品PTY验证只证明取消停止进程；后续真实隔离服务另证实终端Session仍留存。Run终态已落库，Adapter.clearToolBroker通过普通terminal.close请求清理会被正常权限门禁拒绝。公开工具调用继续要求Task/Run运行中，不开放终态清理特权。

共同CompositionRuntimeToolBridge复用已有在途调用表，新增仅由服务端Run绑定调用的releaseRunResources；Provider Bridge、HTTP和MCP未发布它。工具先登记claim再异步校验Store，使可信回收能取消并等待尚在校验或执行中的本Run调用，避免这些已登记的迟到创建越过关闭；终态后新请求继续由Store门禁拒绝。排空后用已有TerminalManager.close({threadId: runId})关闭原Run普通终端；ToolBroker原本就以runId作为终端分组，无新增资源表、服务或依赖。Manager沿已有锁、原生停止及历史持久化流程释放Session，保留终端历史；owned session仍由原owner处理，不扩大清理对象。

CompositionProviderAgentDriver的已有releaseContext先结束配置，再回收原Run资源，最后撤销握手。一次回收的Deferred记录成功或失败；并发或重复调用等待同一结果，关闭失败不会在下一次调用伪装为成功。回收失败使用provider_resources_release_failed沿原Driver错误合同返回；不将自动补偿或重新启动宣称为已完成。Adapter中已有通用清理的ignore未扩展成可信回收的成功判据。

定向旧实现回归明确releasedRuns为空；修复后的真实ACP子进程、Store、Orchestrator和Projector验证取消、正常release和停止失败都执行一次可信清理，终态已落库，重复回收不重复关闭。受控Deferred检查校验及执行两阶段的迟到请求被取消且无副作用，其它Run继续，公开终态terminal.close仍拒绝；关闭失败及重复失败保留原错误。HTTP、MCP和Provider Bridge夹具的内部回收回调故意抛错，普通调用测试通过，证明这些入口不调用该方法。8文件99项与相关Cursor Adapter/真实ManagerCommand/Goose普通取消3文件45项通过，共144项；4项官方opt-in跳过不计通过。Server正式tsgo通过，9个TS定向lint退出0，保留RuntimeBridge原unused/inline schema及Registry测试原unused共3条警告，未增加规则豁免或依赖。

同一隔离产品服务使用合法业务派发与grant、生产ToolBroker和真实PTY：旧Run取消后捕获子PID已退出，但已退出Session仍可通过原terminal.write路径查到；修复后的新Run取消前PID存活，取消后退出，精确Run/terminalId返回TerminalSessionLookupError，证明句柄回收。工具表exec与kill各一次且成功；内部回收不伪造普通terminal.close工具审计记录。新Run a85e7481-4008-4d4f-a9d3-6ffc4c33d66d的Task/Run均cancelled。终端查询夹具首次空data被合同拒绝，随后先确认子PID退出再查询；首次断言错误地查JSON中的message，实际RPC已返回类型化TerminalSessionLookupError，改为精确tag/Run/terminalId校验，不放宽回收判据。源码修复、真实句柄证明与这些夹具准备错误分别记录。

实际产品本次仍是普通Cursor ACP夹具；不等于官方Goose、全部44入口、所有子进程树、浏览器、多设备或远程验收。进程崩溃后的孤立Run恢复仍未完成，A-7/A-8保持未勾选；失败资源的后台重试、恢复和最终独立审计不以本轮替代。复验使用CompositionProviderAgentDriver.e2e.test.ts、CompositionProviderAgentDriver.test.ts、CompositionRuntimeToolBridge.test.ts和现有HTTP/MCP/Registry合同测试。回滚只撤回本模块的可信回收、claim登记先后、一次回收结果及对应fixture/文档，无数据库迁移；保留前轮取消停止顺序、退出码转换、启动确认和用户原工作。

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

## 历史工作记录（原文保留，不作本次验收）

# goose ACP 接入与验证边界

核对日期：2026-09-30（R78）。固定官方目录版本 `1.52.0`（registry `goose`）。本页记录官方 Windows `goose.exe acp` 与本机 Ollama 工具解锁。

## 调用与配置

命令为 `goose.exe acp`。走共用 Generic ACP。广告认证方法 `goose-provider`。

本地解锁：

| 变量 / 配置 | 值 |
| --- | --- |
| `GOOSE_PROVIDER` | `ollama` |
| `GOOSE_MODEL` | `qwen2.5:3b`（R75 曾用 `0.5b`，工具参数不合格） |
| `OLLAMA_HOST` | `127.0.0.1:11434` |
| 隔离 `config.yaml` | `active_provider: ollama`；建议禁用 `summon` 扩展，避免模型误调 `load` |

Ollama：`winget` 0.35.0；已 pull `qwen2.5:0.5b` 与 `qwen2.5:3b`（Clash fake-ip 下 R2 需 hosts，见 R75）。

ACP 客户端须广告并处理：`fs/read_text_file`、`fs/write_text_file`、`terminal/create`（及 output/wait_for_exit/kill/release）。缺 `terminal/*` 时 shell 会挂起（R78 早期矩阵）。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | `agentInfo.name=goose`、`version=1.52.0`；`authMethods=[{id:goose-provider}]` |
| session/new（R70，无 provider） | 失败：缺 `GOOSE_PROVIDER` |
| session/new + 文本（R75，0.5b） | 成功；工具 `read` 失败 `missing field path` |
| session/prompt + `developer__read`（R76，3b） | **成功**：`rawInput.path=marker-r76.txt`；`tool_call_update` completed；回复含 `R76_OLLAMA_MARKER_44117`；`stopReason=end_turn` |
| shell/write（R76 / R78 早） | 无 `terminal/*` 或写断言过严 → 超时 / HARD_PASS=0 |
| **R78 matrix3（qwen2.5:3b）** | **HARD_PASS=4/4**：read / write（`fs/write` 含 `R79_WRITE_OK`）/ shell（`terminal/create` + 文件 `R79_SHELL_OK`）/ reject（`approve` 模式 + deny，`rejected.txt` 不存在）。cancel：`session/cancel` 后仍 `stopReason=end_turn`（**未**证 cancelled） |
| **R79 cancel2** | 三种策略均 `stopReason=end_turn`（afterTerminal / earlyDouble / afterToolCall）；长 `ping` 工具已开战仍不返回 `cancelled`。**判定**：对本机 Ollama `qwen2.5:3b`+goose 1.52.0，硬 cancel 目前达不到；记为软上限，不冒充通过 |

隔离路径：`C:\codework-cli-iso\goose-1.52.0\extract\goose-package\goose.exe`。

证据：`%TEMP%\codework-ollama-r79\`（`goose-matrix3-summary.json`、`goose-matrix3.jsonl`、`goose-matrix3.console.txt`）；早先 R76/R78 目录仍保留对照。

## 可重复检查

```powershell
$env:GOOSE_PROVIDER='ollama'; $env:GOOSE_MODEL='qwen2.5:3b'; $env:OLLAMA_HOST='127.0.0.1:11434'
# 隔离 home 的 config.yaml；ACP 客户端实现 fs/* + terminal/*
# 再跑 read/write/shell/reject（mode=approve）/cancel
```

## 目录状态

A-4：**真实可用（本地 Ollama：读/写/命令/拒绝）**。cancel：R79 三策略仍 `end_turn`，视为该模型/版本下软上限；外部云账号与产品 UI 仍待；不以 0.5b、无 terminal 处理器或 summon 误调冒充。

## 回滚

撤回本说明与 R76/R78 证据记录；无迁移。
