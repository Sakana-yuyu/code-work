<div align="center">

<img src="docs/assets/logo.png" width="128" alt="CodexWork" />

# CodexWork

一个独立的桌面 AI 开发工作台：现代工作台界面壳 + 可自持密钥（BYOK）的多模型运行时。

</div>

## 项目定位

CodexWork 面向需要长时间使用编码代理的开发者，提供统一的 Web、桌面和移动端工作台。它连接你本机已有的 Codex、Claude、Cursor、Grok Build 与 OpenCode 订阅，让代码、终端、任务委派和远程控制保持在同一个工作流中。

## 项目结构

这是一个 TypeScript / Effect-TS monorepo：

| 目录           | 说明                                                        |
| -------------- | ----------------------------------------------------------- |
| `apps/server`  | WebSocket 服务、任务编排、Provider 适配器、持久化与远程连接 |
| `apps/web`     | 浏览器工作台与设置界面                                      |
| `apps/desktop` | Electron 桌面端及本地服务启动器                             |
| `apps/mobile`  | iOS 与 Android 移动端                                       |
| `packages/`    | 契约、客户端运行时、共享工具、SSH 和连接能力                |
| `docs/`        | 用户文档、内部架构说明和运维记录                            |

## 核心能力

- **BYOK 多供应商**：自带密钥接入 OpenAI、Anthropic、Gemini 及兼容中转，支持模型目录发现、上下文窗口匹配、余额查询与仪表盘。
- **任务委派**：内置执行器注册表、可用性探测、优先级与故障转移，支持审查、重试、改派、预算升级、视觉委派和子代理角色片段。
- **组合运行时**：任务图编排、工具代理（ToolBroker）、能力授予审批，以及跨重启委派收口与台账投影。
- **多端协同**：Web、桌面和移动端共享同一套契约与运行时，可从另一台机器或手机远程控制开发环境。

## 快速开始

```bash
pnpm install
pnpm dev          # 并行启动 contracts / server / web
pnpm dev:desktop  # 启动桌面端开发环境
pnpm tc           # 全仓类型检查
pnpm test         # 全仓测试
```

要求 Node.js 24+。BYOK 与委派配置说明见 [`docs/user/`](./docs/user/)，内部设计文档见 [`docs/internals/`](./docs/internals/)。

## 文档

- [安装与首次运行](./docs/user/install.md)
- [权限模式](./docs/user/permission-modes.md)
- [键盘快捷键](./docs/user/keybindings.md)
- [项目图标设置](./docs/user/project-settings.md)
- [从手机或另一台机器远程访问](./docs/user/remote-access.md)
- [应用与服务端同步](./docs/user/updating.md)
- [源码控制集成](./docs/user/source-control.md)
- [Codex Provider](./docs/user/providers-codex.md)
- [Claude Provider](./docs/user/providers-claude.md)
- [Linux 后台服务](./docs/user/background-service.md)

## 贡献

请先阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。本地开发需要 Vite+：

```bash
vp i
```

功能建议请提交 [Ideas 讨论](https://github.com/Sakana-yuyu/code-work/discussions/categories/ideas)，问题反馈请提交 Issue。

## 兼容性说明

仓库中的 `t3.json`、`t3.codes`、`npx t3`、`.t3` 和部分移动原生模块标识属于既有配置、发布或运行时兼容契约，不是产品名称；修改这些值会破坏已有项目配置、构建脚本或已发布客户端，因此保留在兼容边界内。

## License

[MIT](LICENSE)

<!-- contributors-start -->
<!-- contributors-end -->
