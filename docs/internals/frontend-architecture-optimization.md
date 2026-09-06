# Frontend Architecture & Optimization Guide

> 本文档记录 Code Work 前端工程（Web / Desktop / Mobile）的设计哲学、现状评估、性能与交互治理策略，以及最新的优化改进。

---

## 1. 架构定位与设计哲学

Code Work 的前端服务于高强度的 Agent 编码任务，核心遵循以下基本原则：

1. **协议与事件源驱动（UI stays dumb, Orchestration stays pure）**
   - 前端不承载复杂的核心调度与本地乐观推断，主要消费服务端的事件流（Event Stream）与只读投影（Read Model）。
   - 跨端共享协议收敛于 `packages/contracts`（Schema 与 RPC 定义），通用客户端状态与 RPC 包装收敛于 `packages/client-runtime`。
2. **极速响应与低延迟优先（Anti-Slop & Performance First）**
   - 杜绝常驻高开销动画与 GPU 飙升图层，确保高刷新率显示器下无掉帧。
   - 惰性反序列化与按需计算：对于 MCP `toolData` 等高频但默认折叠的调试信息，仅在用户交互展开时进行解析与着色。
3. **功能单一归属与界面简洁性**
   - 每个配置项和操作路径只保留一个清晰的原生入口，避免多层跳转死循环或重复只读面板。
   - 规范化双语 i18n，统一使用 stable key 与系统专有名词原生本地化映射。

---

## 2. 核心架构与模块分布

```
apps/
├── web/                 # React 19 + Vite 主前端（被 Desktop Electron 容器复用）
│   ├── src/components/
│   │   ├── chat/        # 核心对话时间线、流式渲染、工具块、Checkpoint 回退
│   │   ├── settings/    # 提供商实例、BYOK 网关、CLI Proxy、环境偏好配置
│   │   └── ui/          # 基础组件库（基于 Tailwind CSS 与 Radix/Base UI）
│   └── src/hooks/       # 服务端投影与设置 Hook
├── mobile/              # React Native (Expo/Hermes) 移动端应用
└── desktop/             # Electron 外壳与 Native Shell 集成
packages/
├── contracts/           # 类型安全的 RPC 契约与 Schema
└── client-runtime/      # 共享状态机、连接管理与终端会话模型
```

---

## 3. 痛点分析与治理策略

| 模块 / 痛点                | 现象与风险                                                                                   | 治理策略                                                                                                          |
| :------------------------- | :------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| **ChatView 时间线巨石**    | 单一时间线承担了流式文本、Diff 预览、ToolBlock、图片生成等多种异构卡片，Props 穿透深。       | 按消息卡片类型插件化解耦；强化 `React.memo` 隔离，确保单条消息打字不引起历史消息整树 Re-render。                  |
| **设置与向导表单生命周期** | 弹窗（如 `AddProviderInstanceDialog`）复用时，上一次残留的草稿或错误提示可能污染新向导流程。 | **本次已优化**：引入弹窗打开/关闭生命周期联动，弹窗显隐及驱动类型切换时重置步骤与表单状态，防污染。               |
| **跨端体验对齐（Parity）** | Web/Desktop 与 Mobile 技术栈差异，复杂设置项（如 BYOK、Proxy）移植滞后。                     | 优先抽取 `client-runtime` 纯业务逻辑，移动端重聚焦在「查看监控、轻量审批、Diff 阅读」，而非 100% 像素级表单平移。 |
| **包体积与加载性能**       | 早期急加载包过大导致首屏冷启动白屏时间变长。                                                 | 坚持 Dynamic Import 路由懒加载与按需代码分割（拆分后主包控制在 ~3.6MB 水平）。                                    |

---

## 4. 本次优化落地详情

### 4.1 实例添加向导状态与生命周期鲁棒性 (`AddProviderInstanceDialog`)

- **问题**：在快速添加不同 Provider 实例或重新打开弹窗时，如果用户上一次在步骤中途关闭，重新打开可能沿用过时的 step、label、accentColor 或校验拦截状态，甚至导致向导卡在错误的 step 视图。
- **优化实施**：
  - 在 `AddProviderInstanceDialog` 中对齐 `open` 和 `initialDriver` 的响应式生命周期。
  - 在弹窗打开时，自动原子化重置向导步进（`wizardStep -> 0`）、清空临时覆盖项与提交拦截标志（`hasAttemptedSubmit -> false`）。
  - 保留并兼容 `configByDriver` 暂存缓存，确保同一会话内切换 driver 不丢失输入，同时避免跨会话脏数据残留。

### 4.2 顺滑过渡与生硬跳变治理（Smooth Transitions）

针对向导步骤切换、连接模式切换及详情标签页硬切造成的生硬视觉跳跃（Abrupt Layout Pops），按性能规范实施了轻量标准的过渡动效：

1. **向导分步平滑淡入 (`AddProviderInstanceDialog`)**：
   - 之前各 Step 仅依靠 `hidden`（`display: none`）直接截断，导致外层 `AnimatedHeight` 伸缩过程中内部内容突兀闪现或留白。
   - 现为每个步骤容器加入淡入微动效（`animate-in fade-in-50 duration-150` 与 `transition-opacity duration-200 ease-out`），配合 `AnimatedHeight` 形成高度伸缩与渐现同步的自然过渡。
2. **连接模式切换高度与内容过渡 (`ProviderConnectionSection`)**：
   - 切换 Native、API Key 与 Gateway 模式时，表单高度差异巨大。引入 `<AnimatedHeight>` 柔和包裹动态区域，并为新增输入字段添加渐显过渡。
   - 反馈状态（`feedback` 错误/成功提示）增加了 `animate-in fade-in-50` 平滑淡入，防止错误突然顶开布局。
3. **卡片标签页切换过渡 (`ProviderInstanceCard`)**：
   - 在 "Configuration" 与 "Models" 切换时，移除生硬瞬间替换，赋予淡入与透明度平滑过渡。
4. **全链路严格遵循 Accessibility & Performance 准则**：
   - 每一个动效均显式添加 `motion-reduce:animate-none` 与 `motion-reduce:transition-none`。
   - 时间窗口严格收敛在 150ms ~ 200ms 内，杜绝常驻循环重绘与多余 GPU 占用。

---

## 5. 后续演进建议

1. **流式 Markdown 增量 Parser**：将流式输出的 Markdown token 缓存粒度下沉到行级，避免长文本生成时的全量重解析。
2. **多端状态测试矩阵**：针对 Provider Connection、CLI Proxy 等复杂网络面板增加跨端 mock 快照用例，避免 Web 修改后破坏 Mobile 契约。
