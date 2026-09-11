# Workspace IDE 架构约束

IDE 模式在宿主文档内直接渲染 VS Code 工作台（`@codingame/monaco-vscode-api`），由服务端同机运行的 VSCodium REH（远程扩展宿主）提供协议后端。改动前先读本文与 `apps/web/src/vendor/vscode/README.md`。注意：内嵌工作台不是 composition 的 `vscode_ide` IDE Runtime，也不存在 VSCode agent 供应商——边界与协议契约见 [vscode-ide-boundary.md](./vscode-ide-boundary.md)。

## 双侧版本对齐（硬约束）

- 客户端 `@codingame/monaco-vscode-api@33.0.9`（VS Code 1.121.0）必须与服务端 REH 制品版本一致，否则握手失败。
- 版本锚点在 `apps/web/package.json` 与 `apps/server/src/ide/codeossRelease.ts`（五平台 SHA256 固定），`codeoss.test.ts` 有基线守护测试。两侧任何一侧升级都要同步另一侧并更新该测试。

## 无 iframe 集成

- 工作台通过 `bootstrap.ts` 在 Code Work 文档内初始化（约 40 个 service override + `attachPart` 挂载到应用网格）。页面里唯一允许的 iframe 是 monaco 自带的 `web-worker-ext-host-iframe`（web 扩展隔离），不得引入整页工作台或 `postMessage` 桥。
- 服务端 `codeossHttp.ts` 只做协议代理：`/api/ide/{capability}/*` → 回环 REH 端口；不注入脚本/样式到工作台页面，不转发 Code Work Cookie/Authorization（回环仅认 `vscode-tkn` 连接令牌）。

## 会话与生命周期

- `ide.open` RPC（`Codeoss.ts`）按会话签发票据并启动 REH 子进程；capability（64 hex）既是 URL 段也是 REH 连接令牌。
- REH 会话在 `node --watch` 重启后死亡（sessions map 内存态）。`VscodeWorkbench` 的看门狗通过 `ide.open(retry:true)` 重新探测，capability 变化后由 `sessionWatchdog.ts` 限制重载次数并重建客户端；恢复验收必须包含编辑输入、文件保存和终端回显，不能仅以 ready 或重载成功判定。`HotExitBackupService` 通过 IndexedDB 按远程工作区身份保存工作副本备份，恢复、保存清理和环境隔离有定向测试；真实浏览器的脏内容跨重载仍需在关闭自动保存的稳定窗口补验。
- 扩展数据全部位于 CODEWORK_HOME 的 `ide/extensions`（跨 REH 会话共享）与 `ide/profiles/{hash}`（REH 会话态），不得读写用户已有 VS Code/Cursor 配置。

## 上游占位尺寸与布局

monaco 以 9999px 占位尺寸挂载 part。宿主必须约束网格行高并在挂载后调用 `relayoutWorkbenchPart`（`VscodeWorkbench` 的 ResizeObserver/resize 驱动），否则编辑器区塌陷或 view-lines 不渲染。

面板行不能固定占用空间：`VscodeWorkbench` 根据 `Parts.PANEL_PART` 的可见性将网格第二行切换为 `minmax(0, 40%)` 或 `0px`。终端/问题/输出面板打开时保留面板高度，关闭后编辑器恢复满高，避免空面板把主编辑区压缩成大片空白。

## 编辑器 API 陷阱（踩过的坑）

- `Selection.isEmpty` 继承自 `Range.prototype`，是方法不是属性——按属性读恒真值，用 start/end 字段判折叠。
- `VSBuffer.buffer` 是 `Uint8Array` 视图，`instanceof ArrayBuffer` 恒 false。
- 路径匹配：模型 URI 是 `/c%3A/...` 小写百分号编码，工作区根是 `/C:/...`——用解码+大小写不敏感前缀匹配。

## 品牌与模式切换

- `codeossInstall.ts` 改写 product.json 品牌名，并保留上游扩展卸载服务读取的 `defaultChatAgent` 元数据；运行参数仍显式禁用 Copilot/Copilot Chat。缓存修订号 4 使用独立目录，旧会话继续使用原运行包，新会话取得修复后的产品配置和已移除无效菜单的桥接扩展。保留元数据不启用内置 Agent。
- 对话/IDE 模式切换在 `workspaceLayout.ts`：同一工作台节点保留、180ms 单次透明度过渡、`prefers-reduced-motion` 跳过；偏好持久化在 `codework.workspaceLayout`，viewport <1000 时禁用 IDE。

## 主题与背景

- `themeSync.ts` 同步应用与原生工作台的界面配色；`initializeThemeSync` 先等待扩展注册，才能从默认主题取得语法配色并注册 Code Work 主题。冷启动时直接读取主题列表会得到空清单。
- 桌面 `codework:` / `t3code:` 协议在初始化前复用上游只读 `FetchFileSystemProvider`。否则中文包的打包资源被当成待扩展激活的文件系统，扩展扫描与主题初始化会互相等待。桌面 CSP 允许内联 JSON 的 `data:` 读取及会话代理返回的 HTTP(S) 图标字体，脚本来源限制保持独立。
- Code Work 主题注册到 Web Worker 宿主；`whenReady()` 在扩展增量队列繁忙时可能先返回，须等待对应 `onDidChangeExtensions` 注册回执后读取主题列表，不能用定时器猜测就绪。
- 背景继续由 `ThemeDecorationSync`、`ThemeBackdrop` 和现有主题资源库管理。全局/内容层共用，文件树挂载侧栏背景；`workbenchBackground.css` 只在有背景装饰时移除原生编辑区、面板和侧栏的重复底色，浮层使用已有材质变量。
- xterm 使用独立画布，`themeSync.ts` 在背景、原生主题、终端配置及实例变化时更新透明背景；移除装饰后恢复主题底色。等待隐藏终端的画布不能阻塞工作台启动，卸载后不再改写选项。透明色只用于渲染，不写进保存的插件配色。
- 有全局/内容背景时，透明终端底色同时进入内存主题，避免 `xterm.refresh()` 覆盖一次性选项；CSS 需覆盖新版 `.xterm-scrollable-element`，不能只处理旧 `.xterm-viewport`。活动栏普通、选中和悬停图标统一按侧栏配置底色取黑/白对比色。侧栏分区头（资源管理器/大纲/时间线的 `.pane-header`）同样纳入透明清单，否则默认分区底色会在启动完成、主题落地后盖住背景装饰。
- IDE 的视频控制复用全局播放器；不另建视频实例。文件图标、语法高亮及其他插件行为不属于同步范围。
- 主题选择器预览只改变原生主题，确认写入配置后才导入应用主题库。插件禁用或不可用时以 Code Work 主题承载保存的配色，不清除用户已保存的主题；扩展卸载流程应独立验收，不能用禁用代替卸载。

## 选区与拖宽

- 选区芯片沿 `trackActiveEditorSelection → onSelection → ChatView` 更新现有草稿，同一 IDE 选区只保留一个芯片，不自动发送。桥接扩展没有额外的发送菜单；更新 manifest 后须同步运行包缓存，避免已安装版本仍贡献旧死命令。
- IDE 对话与原预览面板共用 `useResizableWidth`，保留各自的宽度偏好。IDE 下限 280px，上限随容器变化；首轮容器测量和窄屏回退不能覆盖用户已保存宽度。取消拖动恢复起始宽度且不保存，键盘走同一套边界与持久化路径。

## 测试入口

`apps/server/src/ide/*.test.ts`（安装/代理/聊天扩展/运行时）与 `apps/web/src/components/ide/**`（bootstrap 相关、布局、主题同步、项目起点）。REH 行为验证以浏览器实测为准（任务文件记录取证链），测试只守护纯逻辑。
