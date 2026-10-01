# Goose ACP 调用、工具与验证边界

核对日期2026-10-01。固定官方 Windows CLI 1.52.0，以已安装二进制的版本与实际协议结果为准；本次不下载或升级 CLI，不使用外部模型或账户。本页的当前证据来自已提交工具探针，旧独立脚本的 Ollama 实验保留为工作历史，不进入本次成功统计。

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
| GOOSE_MODE                       | approve，读写/命令按官方广告的审批选项回应                                     |
| extensions                       | developer enabled；summon disabled，配置属于临时数据根                         |
| GOOSE_DISABLE_SESSION_NAMING     | true，关闭自动会话标题模型任务，不允许后台请求消费工具动作                     |

本机 HTTP 端点支持 GET /v1/models 与 POST /v1/chat/completions 的标准 JSON/SSE；校验方法、路径、合成认证、所选模型和实际广告工具。只有当前最后一条 user 消息中的唯一动作标记才消费工具动作，历史消息不能触发重复执行。此端点合成模型选择与正文，真实 ACP 通知与文件/命令执行来自官方 CLI 和宿主处理器。

## 实际工具与生命周期

证据入口 [GooseAcpToolProbe.test.ts](../../apps/server/src/provider/acp/GooseAcpToolProbe.test.ts)。本次 Windows 受控模型路径如下，不能外推真实模型、账户或其它平台。

| 行为                | 当前证据与边界                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本/正文/模型/模式 | 固定 agentInfo/authMethods、approve 模式和当前 model 配置；实际正文标记可见，本机模型目录确实被请求                                                                                                  |
| 文件读取            | 官方广告 read 调用 fs/read_text_file，实际源文件仅读1次，下一模型请求的 role=tool 内容含旧源标记                                                                                                     |
| 读取显示限制        | Goose 的 ACP-aware 成功读取通知省略 content/rawOutput；当前共用 ACP 工具条目为 completed、详情为路径。本轮保留该真实边界，未伪造通知正文或重读文件；产品宿主代理结果与界面合并仍需独立检验           |
| 允许写入            | 官方 write，回传原 allow_once optionId；fs/write_text_file 恰1次，approved.txt 恰为 APPROVED                                                                                                         |
| 命令成功/失败       | 官方 shell 调用 terminal/create/wait_for_exit/output/release；Windows 原生 shell 执行受控 Node 命令，副作用计数恰x，正文有命令标记；exit7 原通知/公共工具状态为 failed，详情含7；终端创建与释放各2次 |
| 拒绝                | 回传原 reject_once optionId；denied.txt 不存在，官方工具终态 failed                                                                                                                                  |
| 取消                | 在写入审批尚未执行时发送 session/cancel，原 prompt 返回 cancelled、工具 failed、cancelled.txt 不存在；不代表运行中命令已停止                                                                         |
| 取消后继续          | 同一运行时下一独立 prompt=end_turn，无固定等待、自动重发或额外放宽生产超时                                                                                                                           |
| 新进程恢复          | 关闭旧 CLI 后新进程 session/load 成功；同 sessionId，唯一恢复 prompt 的实际模型请求 role=tool 同时包含旧 read 和 shell 标记；该恢复请求恰1次，恢复正文匹配，全流程工具动作恰6次                      |

旧独立 Ollama 脚本的三种取消实验均返回 end_turn，运行命令未被证明停止；当前审批取消通过不能抹去旧失败或代替运行中终端取消验收。此次没有修改生产取消逻辑，使用此前已交付的共同通知与取消结算合同。文件工具通知与宿主实际请求分别计数，不让通知驱动第二次执行。

探针的宿主处理器校验 sessionId、工作根路径和受控命令并执行真实副作用，但它是本机测试宿主，不能自称完整产品 ToolBroker。产品边界另跑 [CursorAdapterToolBroker.e2e.test.ts](../../apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts) 的真实工具代理加协议夹具，以及 [AcpJsonRpcConnection.test.ts](../../apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts) 的传输/取消合同；两者与真实 Goose CLI 结果分别登记。

## 复验、失败与回滚

```powershell
$env:CODEWORK_GOOSE_CLI_PATH = '<固定1.52.0目录>/goose.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/GooseAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_GOOSE_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts
```

未提供 opt-in 或非 Windows 时跳过，跳过不记为通过。HEAD加精确模块索引副本、workspace依赖指向副本：官方 CLI 探针1项通过；相关传输/产品工具代理67项通过，普通模式官方probe1项跳过。Server类型检查退出0，仅原账号池文件2条建议；本次探针定向lint与格式通过。首次准备器错误工具名、遗漏模型目录、Windows shell 引号及定向lint失败均保留外置日志，不能算产品缺陷；读取正文的通知缺失有真实失败和固定官方源码对应。

准备阶段未设置 GOOSE_PATH_ROOT 的诊断曾读取默认技能资料，该阶段不能证明数据隔离，并可能生成默认 Goose 会话；没有删除或回写真实 Goose 数据。最终探针显式设置官方绝对路径根，关闭 keyring，不复制账户/密钥或读取在线 Code Work 数据库。CLI、HTTP 连接、捕获终端及临时目录由 Scope 回收；只结束自己捕获的进程，不按名称批量结束。

本模块增加复验入口和明确能力记录，生产 Driver/账户/数据库未改；回滚只需撤回本次探针与文档提交，无迁移。运行中命令取消、读取显示与产品宿主结果的整合、外部推理/真实余额、MCP/媒体、Web/Electron/手机及远程连接均未由本次证明；44入口/P0–P5和最终独立审计仍未完成。

检索词 Goose v1.52.0 ACP tools cancel OpenAI config Paths，访问日期2026-10-01。采用固定官方 [ACP server](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server.rs)、[文件与终端实现](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/fs.rs)、[工具通知转换](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server/tool_calls/conversion.rs)、[OpenAI端点配置](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/providers/openai_def.rs)和[数据路径](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/config/paths.rs)，因为它们直接定义固定版本的协议/隔离/显示边界；不以 README、其它 ACP 客户端实现或最新版本行为推断本次结果。
