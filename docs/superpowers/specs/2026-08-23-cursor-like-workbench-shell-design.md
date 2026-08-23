# Cursor 式工作台壳层（BYOK 作底层）

## Status

- Date: 2026-08-23
- Decision: 用户已口头确认窗口结构、设置收纳、右侧 AI 栏；视觉主参考 Cursor 界面
- Approach: 增量 B（先定主界面再填能力）
- This spec supersedes the product assumption that the service console (`/`) is the primary window. Existing settings-workspace work (`docs/superpowers/specs/2026-07-31-settings-workspace-redesign-design.md`) is reused as the settings surface, not as a competing shell.

## Goal

Code Work 打开后就是 Cursor 风格的编辑器工作台。BYOK（模型、Key、路由、服务、账号）只出现在设置里。现有 IDE 安全边界和审批状态机保持不变。

## Problem

当前同时存在两套一级界面：

1. BYOK 控制台：首页、模型配置、控制中心、诊断各自成路由。
2. `/ide`：把文件树、Git、SSH、Agent、执行器授权堆在同一页。

用户要的是魔改后的 Cursor 壳，不是再做一个运营后台，也不是把 IDE 做成独立产品页。

## Visual reference

- **主参考**：Cursor 桌面工作台的布局与密度——顶栏、左侧活动栏、主侧栏、中间编辑器页签、右侧 AI 栏、底部面板/状态栏、齿轮进设置。
- **次参考**：VS Code 的活动栏/侧栏/编辑器/面板分工；Paseo 的工作区与 Agent 编排（本切片不做成 Agent 列表首页）。
- **禁止**：把 VS Code 或 Cursor 的源码、图标、字体、品牌资产拷进仓库或安装包。只学信息架构和交互，用本仓库已有 `frontend/src/style/tokens.css` 工作台色板。

## Non-goals (slice 1)

- 一次重做全部 Git/SSH 面板为完整 SCM UI。
- Paseo 式多 Agent 编排首页。
- 接入 Cursor 官方 Agent / exec bridge 作为主对话路径。
- 修改已安装 Cursor 客户端。
- 去掉审批、或允许前端提交主机绝对路径。
- 提交 `frontend/bindings/`。

## Architecture

### Shell

启动默认进入工作台（现有 `WorkbenchLayout` + 工作区内容），不再进入服务控制台首页。

| 区域 | Slice 1 行为 |
| --- | --- |
| 顶栏 | 当前工作区名；齿轮打开设置；窗口控件保持桌面现有行为 |
| 活动栏 | 资源管理器（默认）、搜索、源代码管理、设置入口。扩展/能力可后做 |
| 主侧栏 | 资源管理器 = 已有安全文件树（workspace ID + 相对路径） |
| 中间 | 编辑器页签 + 已有 CodeMirror；空窗口显示「打开文件夹」 |
| 右侧 | 固定 AI 栏（Cursor 的 Chat/Agent 栏位置），可拖宽度、可隐藏 |
| 底栏 | 状态栏；终端用现有 PTY，作为底部面板拉起，不再占用 `/ide` 独立区块当主界面 |
| 命令面板 | `Ctrl+Shift+P`：打开文件夹、设置、切换侧栏/AI |

上次打开的工作区下次启动恢复。没有工作区时中间是打开文件夹，不跳控制台。

`/ide` 上的 Git/SSH/执行器大表单移出主界面：日常在对应侧栏/底栏触发审批；完整管理进设置。

### Settings

齿轮打开设置工作区（优先复用 `/settings` 分类页，返回键回到工作台而不是 `/`）。

Slice 1 必须可从设置进入 **模型** 和 **服务**（否则 BYOK 失踪）。其余分类可以先挂现有页面。

1. 常规：语言、主题、恢复上次工作区
2. 模型：现有模型配置、供应商、Key
3. 路由：控制中心的路由/渠道/实验
4. 服务：代理开关、CA、Cursor 账号、Defender 排除（现首页运维）
5. Agent / 委派：执行器、MCP、写入授权
6. Git / SSH：密钥库与 known_hosts 策略
7. 诊断：日志、请求明细、健康检查

改模型、开关服务 = 设置。打开文件、对话、终端 = 工作台。危险操作仍走现有审批。

一级路由 `/`、`/model-config`、`/control-center` 不再作为启动落点；命令面板默认也不把它们当首页。需要时只从设置分类进入（可暂时 iframe/嵌合同一 Vue 视图）。

### Right AI pane

不是独立路由，和编辑器并存。

有：当前 BYOK 模型选择（数据来自设置）、当前工作区对话流（`StartIDEAgentRun` 事件，不经 Cursor exec bridge）、输入框、取消 run、effect 审批（写文件/Git/终端/MCP 必须 Claim 后才执行）、未配置模型时引导去「设置 → 模型」。

没有：多 Agent 编排首页、自动写盘、在 AI 栏里做 Git/SSH 表单。

默认约占编辑器区三分之一宽度。快捷键隐藏/显示（slice 1 用 `Ctrl+L` 或活动栏按钮，实现时与现有快捷键冲突则改文档并保持唯一绑定）。

现有右侧 `TaskPanel`（委派快照）不是 Cursor 对话栏。Slice 1 右侧改为 AI 对话；委派活动放到设置「Agent / 委派」，或后续再做独立面板。

### Backend

不新做一套 Agent 运行时。继续用：

- `internal/ide/workspace` 文件树/读写
- `internal/ide/approval` 单次、过期、可取消审批
- `internal/ide/agentrun` + BYOK `modeladapter` 路由
- `internal/ide/termsession` PTY
- 执行器 `write_workspace` 默认剥离，经 capability 审批授予

指纹格式、相对路径 Target、Git typed argv 等既有约束不变。

### Frontend routing

- 默认路由：工作台（打开上次工作区或空状态），不是 `Home.vue` 控制台。
- 设置：`/settings`（或工作台内设置活动），返回工作台。
- 浏览器预览仍用内存 fixture，不碰真实磁盘。
- 中文 UI 源文案走 `yarn i18n:scan`，补 en-US / ja-JP / ru-RU。

## Error handling

- 未注册工作区：AI 和编辑器明确要求先打开文件夹。
- 未配置模型：AI 栏引导设置，不打开控制台首页。
- 审批拒绝/过期：不写盘，栏内显示失败原因。
- 设置里服务启停失败：留在设置页显示错误，不把用户踢回旧首页。

## Compatibility

- 不降低 IDE 任务板上已完成切片的安全验收（路径、审批、私钥不进 DTO）。
- 不修改已安装 Cursor。
- 配置目录隔离规则不变。
- 旧书签若指向 `/` 或 `/model-config`，slice 1 可重定向到设置对应分类，避免空白。

## Slice 1 acceptance

1. 冷启动进入工作台，看不到服务控制台作为首页。
2. 能打开文件夹、浏览树、打开文本、按审批保存。
3. 右侧 AI 栏能选 BYOK 模型并完成一轮对话；写文件必须审批。
4. 齿轮能进入模型配置与服务开关；从设置返回工作台。
5. 浏览器 E2E 仍只用内存 fixture；页面不出现主机绝对路径或私钥。
6. 观感按 Cursor 工作台分区，而不是控制台卡片墙或 `/ide` 长表单页。

## Later slices (out of slice 1 plan, listed to avoid scope creep)

- 完整 SCM 侧栏（diff/stage 用 Git 面板而不是 `/ide` 表单）
- 底部问题/输出面板
- Paseo 式多 Agent 标签
- 设置分类全部视觉重排到 Cursor Settings 密度

## Risks

- 现有 `WorkbenchLayout` 在非 `/workbench`、`/ide` 路由会收起侧栏；默认路由改工作台后必须让文件编辑和 AI 都在「工作台表面」内，避免又变成无壳子页面。
- 把 Home/模型/控制中心嵌进设置时，要避免第二套顶栏或重复保存状态。
- Cursor 外观是参考不是像素复制；验收看分区和主路径，不看图标是否同源。
