# 通用 ACP Agent（acpAgent）

`acpAgent` 是用户自配置的通用 Agent Client Protocol 入口：任意说 ACP（JSON-RPC over stdio）的 CLI 都能接入，设置里填完整启动命令即可。驱动实现在 `apps/server/src/provider/Drivers/GenericAcpDriver.ts`，注册于 `apps/server/src/provider/builtInDrivers.ts`。

与 Cursor / Kimi 的关系：GenericAcpDriver 不新写会话编排，直接复用 `apps/server/src/provider/Layers/CursorAdapter.ts` 的 ACP 适配层（Kimi 走同一路径，见 `Drivers/KimiDriver.ts`）。因此文件系统与终端请求经 ToolBroker 桥执行并受工作区约束，权限请求走既有审批链（`request.opened` → `thread.approval.respond`），与会话生命周期、终止树杀等行为和 Cursor/Kimi 完全一致。设置 schema 在 `packages/contracts/src/settings.ts`（`AcpAgentSettings`）。

## 命令配置

- `command`：完整启动命令，按引号语义拆分（复用 `PiAdapter.ts` 的 `splitPifamilyLaunchArgs`），首段是可执行文件，其余是参数。例如 `npx -y cline@3.0.46 --acp`。命令为空时驱动拒绝创建实例。
- `authMethodId`：会话建立时 ACP `authenticate` 请求使用的 method id，默认 `login`（Kimi 同值）。agent 不要求认证时可留空。
- `supportsModelSelection`（隐藏，默认 true）：agent 是否接受会话级模型选择。
- 探照灯：以 `<命令> --version` 探测（8 秒超时），ENOENT 如实报"未找到"；模型目录来自 `customModels`，登录与模型可用性由真实 ACP 会话确认，探测输出只做展示。
- 文本生成复用 `makeCursorTextGeneration`，同样以配置的命令拉起一次 ACP 会话。

## BYOK 网关注入：注入，不是强制

开启 `routeThroughByok` 后，驱动向子进程注入标准 OpenAI / Anthropic 环境变量，指向本地 BYOK 网关（`GenericAcpDriver.ts`）：

- `OPENAI_BASE_URL` = `/byok-gw/openai[/source/<instanceId>]/v1`，`OPENAI_API_KEY` = 网关 token；
- `ANTHROPIC_BASE_URL` = `/byok-gw/anthropic[/source/<instanceId>]`，`ANTHROPIC_AUTH_TOKEN` = 网关 token，并清空 `ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_OAUTH_TOKEN` 避免混用凭据。

语义要如实表述：这是 **BYOK 优先注入**，不是物理强制。只有读取这些变量的 agent 才会走网关；agent 完全可以无视环境变量用自己的登录态（典型如自带 OAuth 的 CLI）。这与 Pi / OhMyPi 的构造性强制（受管 models.json + 环境清洗，CLI 物理上接触不到其它凭据）是两回事，见 [pi-family-providers.md](./pi-family-providers.md)。网关侧本身仍 fail-closed：注入指向的来源里没有匹配通道时返回 404 / 协议错误，不会借用其它实例的凭据。

BYOK 源变化时，`ProviderInstanceRegistryHydration.ts` 只在 `routeThroughByok: true` 的 acpAgent 实例上计算 `__byokSourceFingerprint` 并触发忙碌边界内的实例重建。

## 尚未提供的

- **没有 ACP 目录（catalog）**。应用内 "ACP Registry" 仍保持 coming-soon 入口（`apps/web/src/components/settings/AddProviderInstanceDialog.tsx` 的 `COMING_SOON_DRIVER_OPTIONS`），不会列出可一键添加的 agent；用户只能手工填命令。
- 模型路由完全由 agent 自身解释，Code Work 不经网关校验其模型清单（`customModels` 只是展示目录）。
- 通用 agent 的工具面、审批语义取决于各自 ACP 实现，Code Work 只保证 fs/terminal 请求的工作区约束与审批链兜底。
