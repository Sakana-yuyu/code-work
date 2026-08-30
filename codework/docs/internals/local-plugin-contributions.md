# 受控本地插件贡献架构

> 面向维护者。本文描述当前已经实现的本地插件贡献合同、运行边界和扩展方式。

本地插件是 Web 客户端中的声明式扩展机制。用户导入一个 JSON manifest，宿主验证后把它保存到浏览器本地存储，并把其中的贡献映射到已有产品表面。Desktop 复用 Web 渲染器，因此共享这些宿主表面；Mobile 当前没有本地插件注册或渲染入口。

这套机制不加载插件代码。manifest 不能携带脚本、模块地址、HTML 或任意表达式，插件也不能获得 Zustand、Effect Atom、Composer Store、右侧面板 Store 等内部状态对象。

## 信任模型

本地插件的安全边界由四项约束共同形成：

1. **声明式合同**：只接受 [`packages/contracts/src/localPlugin.ts`][contract] 定义的数据结构。
2. **显式权限**：安装时校验 contribution 与 permission 的闭包，调用时再次检查当前权限。
3. **受限端口**：adapter 只获得完成该动作所需的最小函数，不获得 Store 或通用宿主对象。
4. **失败隔离**：生命周期、调用和渲染失败写入插件 failure journal；异常不向其他插件或宿主主循环传播。

manifest 中的显示文本始终作为 React 文本节点渲染。宿主不执行 `eval`、动态 `import()`、插件脚本或任意 HTML。

## 版本合同

当前合同包含两个独立版本：

- `manifestVersion: 1`：控制 manifest 外层存储和字段结构。
- `apiVersion: { major: 1, minor: 0 }`：控制 contribution 语义和宿主能力协商。

版本协商遵循以下规则：

- major 不同，拒绝安装。
- 请求的 minor 高于宿主 minor，拒绝安装。
- major 相同且请求 minor 不高于宿主 minor，允许安装。

合同还固定了以下资源上限：

- 插件 ID 最长 96 个字符，只允许小写字母、数字、点和连字符。
- 显示文本最长 160 个字符，内容文本最长 4,000 个字符。
- 每类 contribution 最多 32 个。
- 单个 Attachment contribution 的 `maxBytes` 不得超过 20,000,000 字节。
- 单个 manifest 最多声明 8 个权限。

结构解码完成后，`validateLocalPluginManifest` 继续执行语义校验：重复权限、同类重复 contribution ID、缺失权限、悬空面板引用、悬空 Timeline 引用、未声明的工作区上下文和不支持的模板字段都会被拒绝。

## 模块边界

| 边界                                    | 责任                                                | 不负责                      |
| --------------------------------------- | --------------------------------------------------- | --------------------------- |
| `packages/contracts/src/localPlugin.ts` | schema、版本协商、权限闭包和引用校验                | 浏览器存储、UI、运行副作用  |
| `localPluginPolicy.ts`                  | 把未知输入解码为允许注册的 manifest                 | 生命周期状态和 UI 文案      |
| `localPluginStorage.ts`                 | 版本化序列化和 `codework:local-plugins:v1` 本地存储 | 注册查询和调用              |
| `localPluginRegistry.ts`                | 当前插件快照、启用贡献枚举、权限查询                | 持久化和副作用              |
| `localPluginLifecycle.ts`               | 恢复、安装/更新、启用、禁用、卸载                   | contribution 的产品行为     |
| `localPluginFailureJournal.ts`          | 记录最近的恢复、生命周期、调用和渲染失败            | 重试、持久化和错误恢复      |
| `localPluginIsolation.ts`               | 把单次 contribution 异常转换为可观察结果            | 决定具体 contribution 行为  |
| `localPluginTemplate.ts`                | 检查并渲染受限工作区模板                            | 读取任意工作区或 Store 数据 |
| `localPlugins/adapters/*`               | 把一个 contribution 转为最小宿主端口调用            | 直接读写内部 Store          |
| 宿主 hook/组件                          | 订阅 registry、提供端口、渲染结果和用户反馈         | 重新实现插件策略或生命周期  |

新增能力应沿用这些边界。现有大型宿主文件只保留一个通用拼接点；contribution 的条件、权限和失败处理留在相邻 adapter 中。

## 生命周期与持久化

`LocalPluginLifecycle` 是唯一写入插件注册状态的入口：

1. `restore` 从本地存储读取版本化文档，重新解码每个 manifest，通过后一次性发布 registry 快照。
2. `install` 既用于首次安装，也用于同 ID 更新；更新保留原有启用状态和安装时间。
3. `enable`、`disable` 和 `uninstall` 生成新的完整注册列表。
4. 所有写操作都先持久化，成功后才替换内存 registry；写入失败时旧快照保持不变。

浏览器无法访问 `localStorage` 时，runtime 使用进程内易失存储，避免宿主初始化失败。该降级只保留当前页面生命周期内的插件状态。

failure journal 默认保留最近 100 条内存记录，不跨页面重载持久化。设置页订阅 registry 和 failure snapshot，可查看插件权限、贡献计数、启用状态和最近失败，也可按插件清除失败记录。

## 权限模型

| 权限                      | 当前允许的能力                                             |
| ------------------------- | ---------------------------------------------------------- |
| `workspace.read`          | 渲染显式声明的 `workspace.name`、`workspace.root` 模板字段 |
| `clipboard.write`         | 通过 Command Center 的剪贴板端口写入文本                   |
| `composer.prompt.write`   | 插入命令提示词或 Attachment 的 `promptPrefix`              |
| `timeline.write`          | 向当前线程的本地 Timeline journal 追加声明式事件           |
| `composer.attachment.add` | 把通过 contribution 过滤的图片交给现有 Composer 附件入口   |

权限检查分两层：

- **安装阶段**：manifest 只要声明了需要某权限的 contribution 或字段，就必须同时声明对应权限。
- **调用阶段**：adapter 重新读取当前插件，检查仍然存在、仍然启用、权限仍然有效且 contribution 仍然存在。

因此，从旧 registry 快照枚举出来的陈旧 UI 动作在插件被禁用、卸载、撤销权限或删除 contribution 后也不能继续执行。

## Contribution 闭环

### Workspace Panel

`workspacePanels` 声明标题、描述、分段正文和可选工作区字段。adapter 把每个启用贡献映射为稳定的右侧面板 surface；真正渲染时重新解析插件和 contribution。

模板只支持 manifest 在 `context` 中显式声明的 `workspace.name` 和 `workspace.root`。未知 token、未声明字段或缺少 `workspace.read` 权限都会失败。面板组件使用局部 Error Boundary，单个面板渲染异常不会关闭其他右侧面板或聊天视图。

### Command Center

`commands` 当前支持四类声明式动作：

- `workspace.open-panel`
- `clipboard.write`
- `composer.prompt.insert`
- `timeline.post`

`localPluginCommandAdapter.ts` 只枚举具有真实宿主端口、能够形成用户闭环的动作。调用时 adapter 验证引用和权限，再调用 `openWorkspacePanel`、`writeClipboard`、`insertPrompt` 或 `postTimeline`。Command Palette 只负责把通用命令项拼入现有结果列表和显示失败 toast，不包含插件动作分支。

### Timeline

`timeline` 定义稳定 ID、标题和 `info`、`success`、`warning`、`error` 四种 tone。实际事件由 `timeline.post` 命令通过受限端口写入。

Timeline 使用独立的 `codework:local-plugin-timeline:v1` journal，不复用 provider `WorkLogEntry`：

- 每条事件包含插件 ID、Timeline ID、线程键、标题、消息、tone 和创建时间。
- 全局最多保留 500 条，每线程最多保留 100 条。
- 持久化成功后才发布内存快照。
- 禁用、卸载、撤销权限或删除 contribution 后，历史事件保留但不显示；恢复有效状态后重新显示。
- 恢复、写入和单行渲染失败记录到既有 failure journal，单行 Error Boundary 防止异常拖垮整个虚拟列表。

### Attachment

`attachments` 定义标题、描述、允许的图片 MIME、单文件字节上限和可选 `promptPrefix`。当前 schema 只允许 PNG、JPEG、WebP 和 GIF。

Command Center 中的 Attachment 动作按以下顺序执行：

1. 重新检查插件、启用状态、contribution 和权限。
2. 用 contribution 的 `accept` 创建一次性原生文件选择器。
3. 按文件检查 MIME 和 `maxBytes`，无效文件不会进入 Composer。
4. 至少有一个有效文件时，等待 `ChatComposerHandle.addDroppedFiles` 的 `Promise<boolean>` 结果，并复用现有压缩、附件数量限制、草稿状态和上传队列。
5. `promptPrefix` 通过独立的 `insertTextAtEnd` 端口插入，不直接操作 Composer Store。

用户取消选择、全部文件被拒、原生选择器失败、Composer 不可用或端口抛错都会成为该插件的一条调用失败。部分文件被拒时，有效文件仍会附加，Command Center 显示本地化警告。

## 失败隔离与可观察性

`runIsolatedLocalPluginContribution` 是调用和渲染的统一异常边界。它返回判别联合，而不是让异常继续冒泡：

```ts
type IsolatedLocalPluginResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: LocalPluginFailure };
```

每条失败至少包含插件 ID、阶段、消息和时间；贡献失败还包含 contribution kind 与 ID。生命周期失败不发布未持久化状态，贡献失败不禁用其他插件，UI 渲染失败不卸载插件。

Timeline journal 与插件注册 storage 的恢复错误也会被记录。宿主 UI 通过 toast、不可用状态或设置页 failure 列表向用户暴露结果，不使用静默吞错作为隔离手段。

## 新增 Contribution 的步骤

新增 contribution 必须按以下顺序扩展：

1. 在 `packages/contracts/src/localPlugin.ts` 增加独立 schema、类型、数量/长度限制和语义校验。
2. 明确所需权限；在安装阶段形成权限闭包，在调用或渲染阶段再次检查。
3. 只在 `LocalPluginContributionByKind` 中增加稳定类型映射，让通用 registry 继续按 kind 枚举。
4. 在 `apps/web/src/localPlugins/adapters/` 新增小型 adapter，定义最小宿主端口并返回可观察结果。
5. 为浏览器 API、持久化或渲染增加相邻边界模块，不把实现塞入大型宿主组件。
6. 在现有产品表面增加一个通用拼接点；不得向宿主持续增加按插件 ID 或 contribution ID 分支。
7. 先写 adapter、权限重检、生命周期变化和失败隔离测试，再接入宿主。
8. 更新本文，记录真实支持的闭环和明确不支持的能力。

公共抽象只在已有稳定合同或真实重复时提取。单个 contribution 的特殊行为应留在自己的 adapter，不提前构造通用脚本运行时、事件总线或跨端插件框架。

## 明确不支持

当前实现有意不提供以下能力：

- 插件脚本、动态模块、`eval`、任意 HTML 或 CSS 注入。
- 对内部 Store、RPC client、Provider 进程、文件系统或 ToolBroker 的直接访问。
- 服务端分发、远程同步或跨设备安装本地插件。
- Mobile 本地插件宿主。
- 通用二进制附件；Attachment 只接受合同列出的图片类型。
- 插件自定义持久化、后台任务、网络请求、支付、资金、结算或分润逻辑。

这些限制使插件贡献保持为本地、声明式、可撤销的 UI 扩展，不把本地 manifest 提升为任意代码执行边界。

## 验证边界

相关验证分布在以下测试中：

- `packages/contracts/src/localPlugin.test.ts`：schema、版本协商、权限闭包和引用校验。
- `apps/web/src/localPlugins/localPluginPolicy.test.ts`：允许/拒绝策略。
- `localPluginStorage.test.ts`、`localPluginLifecycle.test.ts`、`localPluginRegistry.test.ts`：持久化、事务发布、启停和枚举。
- `localPluginFailureJournal.test.ts`：失败限长、订阅和清理。
- `localPluginTemplate.test.ts`：工作区字段检查与渲染。
- `adapters/localPluginWorkspacePanelAdapter.test.ts`：面板解析与权限重检。
- `adapters/localPluginCommandAdapter.test.ts`：受限命令端口和调用隔离。
- `localPluginTimelineJournal.test.ts`、`adapters/localPluginTimelineAdapter.test.ts`：Timeline 持久化、投影和失效隐藏。
- `adapters/localPluginAttachmentAdapter.test.ts`、`localPluginAttachmentPicker.test.ts`、`localPluginAttachmentComposerPort.test.ts`：附件过滤、取消、陈旧动作、文件选择和 Composer 异步失败隔离。
- `LocalPluginWorkspacePanel.test.tsx`、`LocalPluginTimelineRow.test.tsx`：局部渲染错误边界。
- `LocalPluginsSettings.test.tsx`：管理入口、计数、权限和失败展示。

[contract]: ../../packages/contracts/src/localPlugin.ts
