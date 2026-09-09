# Code-OSS 上游来源与集成边界

核对日期：2026-09-08（页内工作台重构后更新）。检索词：VSCodium REH Web、monaco-vscode-api 版本对齐、VS Code extension host、VS Code Marketplace alternatives。采用官方仓库、官方 Release 元数据与 Microsoft 扩展 API 文档，避免依赖界面仿制实现。

## 上游

- 服务端运行包：[VSCodium REH Web 1.121.03429](https://github.com/VSCodium/vscodium/releases)，Code-OSS 提交 `824c4c46a288b839f13b24022655329c2aeb9f81`。版本不是随意选择：客户端 `@codingame/monaco-vscode-api@33.0.9` 基于 VS Code 1.121.0，两端必须共享同一 VS Code 基线，否则远程协议握手与 `--connection-token-file` 校验无法通过。
- [REH Web 说明](https://github.com/VSCodium/vscodium/blob/master/docs/others.md)：本集成只把它当远程扩展宿主与文件 / 终端通道，浏览器工作台不再使用其页面。
- [扩展宿主配置](https://code.visualstudio.com/api/advanced-topics/extension-host)：Web Worker 与 Node 宿主的能力及扩展位置差异。
- [VSCodium 扩展目录说明](https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md)：Open VSX 与第三方发行版兼容性。
- Code-OSS MIT 许可保留在 `License.txt`；运行包中的版权头和第三方许可不移除。微软 Marketplace 品牌、专有扩展和服务不随开源核心自动授权。

## 集成方式

客户端（`apps/web/src/components/ide/vscode/`）：`@codingame/monaco-vscode-api` 在宿主文档内直接初始化 VS Code 服务（约 40 个 service override），`attachPart` 把活动栏、侧栏、编辑器、面板、状态栏挂进 Code Work 自己的网格节点——没有 iframe、没有整页嵌套。扩展画廊指向 Open VSX；`ProxyWebSocket` 把管理通道改写进授权代理前缀，保留二进制帧协议。选区读取走文档内 `ICodeEditorService`，不依赖扩展宿主。

服务端（`apps/server/src/ide/`）：`codeossRelease.ts` 固定各平台 Release 制品 URL 和官方 SHA-256；`codeossInstall.ts` 临时目录下载、校验、解包、原子发布，不改写打包后的 JS。缓存修订号 4 保留卸载服务读取的 `defaultChatAgent` 元数据、改名 Code Work IDE，并注入无额外菜单贡献的只读选区桥扩展；新旧运行包使用独立目录，避免覆盖活动会话。安装期按固定版本和哈希补给 TypeScript 库。`codeossRuntime.ts` 以 `--connection-token-file` 启动 REH，继续禁用 Copilot/Copilot Chat，只监听回环地址；`codeossHttp.ts` 提供授权代理——静态资源与根路径 HTML 原样透传，WebSocket 二进制管道直通，不把 Code Work 的 Cookie 或 Authorization 转发上游。

授权：入口使用随机能力路径，服务端保存原会话票据并逐请求检查有效性及操作权限；撤销事件会关闭对应进程。能力路径不写入 HTTP 访问日志。

主题资源：`resourceUriProvider` 将远程资源转换为当前会话代理下的 `/vscode-remote-resource?path=...`，复用 REH 原生资源端点及上述授权检查。图标字体、SVG 和主题文件均使用浏览器可读取的同源地址，不能直接把 `vscode-remote://` 留给 CSS，也不能遗漏会话路径。非远程资源保留原加载方式；路径参数单独编码，避免中文、空格、百分号等文件名被破坏。

界面配色：`themeSync.ts` 在工作台单例初始化后持续监听应用根节点的实际主题变量，映射到主题范围内的 `workbench.colorCustomizations`（内存配置），并注册 Code Work Light / Dark 承载应用主题，沿用默认代码高亮。反向同步只响应已确认的颜色主题配置变更，等待上游完成主题加载，再复用 `vscodeThemeImport.ts` 和现有自定义主题库保存配色；预览取消不改写全局偏好。保存的 IDE 主题标识用于下次恢复原主题，扩展缺失时使用保存的界面颜色。系统深浅模式统一由应用驱动，保留上游高对比度检测。同步不修改扩展主题文件，不包含文件图标、代码高亮或其他扩展能力。

## 验证与边界

界面语言复用对话的 `getCurrentLanguage()` 结果，包括已经解析的系统语言。进入 IDE 时先按需加载与服务同版本的简体中文或日文语言包（`33.0.9`），英文使用上游默认文案；完成后才动态导入工作台，避免模块初始化时固化错误语言。运行中的工作台更换语言需要重新加载，界面提供保存后手动重新加载的提示。语言包不参与 Vite 依赖预构建，以保留内置扩展翻译资源的 URL 转换；Web Worker 的语言和文案由上游扩展宿主初始化协议传递。2026-09-08 检索 `monaco-vscode-api localization language pack`，采用[上游版本固定的本地化说明](https://github.com/CodinGame/monaco-vscode-api/blob/v33.0.9/README.md#localization)，因为该说明直接对应当前依赖及其加载顺序要求。

定向测试（`apps/server/src/ide/codeoss*.test.ts`）覆盖制品校验与版本守护、缓存迁移和产品元数据、TypeScript 供库、代理透传与二进制 WebSocket、会话撤销后拒绝访问、选区桥扩展协议。浏览器交互证据（无主 IDE iframe、真实文件渲染、选区→草稿芯片、插件卸载及 VSIX 重装）记录在交接任务文件。

文档内 Web Worker 扩展宿主与 REH 内 Node 扩展宿主遵循上游分工；不能宣称兼容所有微软专有插件或仅桌面宿主插件。其他平台制品有固定哈希，但需要各平台实际运行验收。浏览器交互、扩展激活及调试/终端实际操作与 HTTP/CLI 验证是不同层次，未执行时不能合并宣称通过。
