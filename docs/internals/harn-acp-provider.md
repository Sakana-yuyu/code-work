# Harn ACP 接入与验证边界

核对日期：2026-10-01（Round 111）。固定官方目录版本 `0.10.151`（registry `harn`）。本页记录官方 Windows `harn.exe serve acp` 握手、建会话与 prompt 诊断；此前的 Ollama 结果注明原轮次，不作为本轮重测证据。

## 调用与配置

命令为 `harn serve acp`（可省略 `.harn` 文件，进入无文件的附接服务）。认证 `none`。`session/new` 需要扩展字段 `environmentPolicy: { kind: "inherited"|"isolated"|"granted" }`（字符串枚举无效）。产品侧：`NewSessionRequest` 增加可选 `environmentPolicy`，生成器保留同一可选扩展；`AcpSessionRuntime` 在 `agentInfo.name=harn` 时默认 `{ kind: "inherited" }`。调用方的显式策略优先，其它 agent 不自动添加策略，恢复已有会话仍使用 `session/load`。本轮官方二进制复验的是 inherited；其它策略只完成合同和传参回归。

`host/capabilities` 缺省回复始终复用 `initialize.clientCapabilities` 的 fs/terminal 配置，未广告的能力为 false，调用方仍可用已有 `handleExtRequest` 覆盖。回复不自动启用文件或终端访问。本轮真实握手的认证方法同时包含 `id=none` 和 `name=Local (no authentication)`，不需要放松认证方法的必填字段。

官方编辑器文档要求宿主在 ACP 会话中用自然语言驱动读写（[acp-editor-hosts](https://github.com/burin-labs/harn/blob/main/docs/src/acp-editor-hosts.md)），并配置 LLM；此前的隔离 `harn doctor` 检查显示各 provider 凭据均为缺失（未发明密钥）。

资料核对使用检索词 `Harn ACP editor hosts`、`environmentPolicy`、`host/capabilities`，访问日期 2026-10-01。采用官方项目的宿主文档作为调用方式依据；具体扩展字段以隔离的官方 0.10.151 二进制原始消息和本轮 Runtime 探针为依据，避免用其它项目的实现推测 Harn 行为。doctor 与 Ollama 配置结论属于此前轮次的记录，本轮未重新检查用户环境。

## 固定版本证据

| 项目                         | 结果                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initialize                   | `agentInfo.name=harn`、`version=0.10.151`；`authMethods=[{id:none}]`；广告 mode/model 等 configOptions                                                                                                                                                                                                                                                   |
| authenticate                 | `none` 成功                                                                                                                                                                                                                                                                                                                                              |
| session/new                  | 带 `environmentPolicy.kind=inherited` 成功；默认 mode=`ask`                                                                                                                                                                                                                                                                                              |
| NL prompt（R70–R72）         | `Reply with exactly: HARN_OK` → **`Compilation error`**（`harn.acp.prompt_error.v1`）。词法器把英文正文当地源解析。**不是** Code Work 配置错误；需合法 LLM 后按官方 smoke 再验                                                                                                                                                                           |
| 表达式 + `host/capabilities` | 正文 `1 + 1` 时 Harn 发 `host/capabilities`（params=`{sessionId}`），随后发 `sessionUpdate:"progress"`，包含 `update._meta.harn.message/phase/progress/data`。仅有效的非空字符串会话信封、progress 标记和 Harn 元数据对象作为 ExtNotification 保留；非法标准通知、未知类型及非法进度仍按原协议报错，不作通用解析降级。表达式结束不证明文件或命令工具成功 |
| 工具读/写/命令/拒绝/取消     | 未通过；无 LLM 凭据时官方 NL smoke 不可用。表达式 end_turn ≠ 工具真实可用                                                                                                                                                                                                                                                                                |
| Ollama 配置（R76）           | `harn quickstart --non-interactive --provider ollama --model qwen2.5:3b` 成功；`harn local list` 显示 ollama **up** 且已加载 `qwen2.5:3b`。ACP `session/prompt` 英文 NL 仍 **Compilation error**（词法器当 Harn 源码）——配置本地 LLM **未**解锁 ACP NL 工具路径                                                                                          |
| R90 复验 host/capabilities   | 外部探针补齐 `host/capabilities` 回复后：NL → 即时 `Compilation error`（非 timeout）；表达式 `1+1` → `end_turn`。R89 裸探针 timeout 是**探针缺默认回复**；产品 `AcpSessionRuntime` 已默认回复，无需再改 Adapter                                                                                                                                          |

隔离路径：`C:\codework-cli-iso\harn-0.10.151\extract\harn.exe`。

注意：Harn 会拒绝未知环境变量（`HARN-ENV-001`）；探针勿注入自造 `HARN_*` 名。

## 后续真实工具验收

```powershell
harn doctor
# 按官方为所选 provider 配置真实 LLM 凭据（Ollama 本地配置未解锁 ACP NL）
# ACP 英文 NL 须不再 Compilation error，再跑读/写 ToolProbe
$env:CODEWORK_HARN_CLI_PATH = 'C:\codework-cli-iso\harn-0.10.151\extract\harn.exe'
```

## 可重复检查

```powershell
$env:CODEWORK_HARN_CLI_PATH = 'C:\codework-cli-iso\harn-0.10.151\extract\harn.exe'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/HarnAcpCliProbe.test.ts
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/HarnAcpToolProbe.test.ts
```

## 实现边界与回滚

共同调用链为目录实例 → GenericAcpDriver → AcpSessionRuntime → effect-acp 的 NewSessionRpc / 通知协议。扩展只位于 ACP 合同、生成器和 Runtime 边界，不新增 Harn 专用传输或独立调度器。Harn 进度载荷沿现有 ExtNotification 通道保留，尚未映射为聊天进度 UI；普通文本和标准工具通知继续使用原来的解析链。

定向回归覆盖能力缺省/显式/覆盖、Harn 与其它 agent 的会话策略、会话恢复、策略拒绝非法值、专有进度之后的标准通知，以及非法通知的错误脱敏。真实 CLI 探针覆盖无凭据握手、表达式完成及自然语言的上游 Compilation error；不把任何传输错误都算作这一已知失败。探针使用临时 HOME、工作目录和受限系统环境，未执行读写/命令工具矩阵，也未操作真实账号、浏览器或手机。

本轮从 HEAD 加本模块索引构建的独立源码通过协议/Client/Agent 32 项、Runtime/GenericAcpDriver 55 项和官方 Harn CLI 3 项，共 90 项。Server、effect-acp 定向类型检查和修改文件 lint 通过。生成器的实际转换与实际生成 schema 在内存文件系统中另验缺省、三种合法策略、四种非法策略和三种非法上游定义；外部格式器在该检查中替代，完整 generate 命令因本机缺少原有 bun 格式器未执行，不能将这项局部检查称为完整再生成验收。

回滚本轮提交即可撤回 Harn 会话策略和宿主扩展兼容，无数据库迁移。重新生成 schema 时保留生成器的环境策略扩展，并运行 Runtime 的合同回归，避免扩展字段在 RPC 编码时被删除。

## 待验证能力

1. 配置合法 LLM 后按官方 smoke 验自然语言读写与工具；不发明密钥。
2. 可选：把 Harn `progress` 映射进产品进度 UI（当前仅容忍不崩）。
