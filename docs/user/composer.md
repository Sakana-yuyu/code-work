# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Code Work keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## 思考强度

在网页或桌面版输入框底部，点击模型旁的强度标签，可以打开分档滑条。
拖动或使用方向键调整强度；滑条只显示当前模型实际支持的档位。
拖动时连续跟手，松手后吸附到对应档位；下方标签与弹层中的强度颜色同步变化。
星光从右向左流动，越靠左越稀疏，Ultra 档最明显；这只是强度提示，不代表精确费用或用量。
关闭弹层或切走页面后星光暂停，开启系统的减少动态效果时不播放动效。
右上角的重置按钮将强度恢复为模型默认值，其他模型选项保持不变。
模型支持快速模式时，可以点击左上角的闪电按钮切换。

在弹层的强度标题中打开全部模型选项，可通过「强度标签语言」选择中文或 English，默认英文。
这项选择只影响强度名称，不改变界面语言、模型或实际推理档位；会保存在当前客户端，刷新后继续使用。

Android 和 iPhone 可在「设置 → 外观 → 强度标签语言」选择中文或 English，默认英文。
会话模型菜单中的当前强度和可选档位会跟随这个设置，重开应用后保留；手机与电脑分别保存各自的选择。

点击弹层中的强度标题，可以打开原有完整选项列表，继续设置上下文长度、
思考开关等选项。模型选择器仍然独立保留。选择会沿用原有草稿和模型偏好保存方式，
用于后续发送的消息；不会改变已经运行的回合。窄窗口和移动客户端继续使用原有紧凑选项菜单。

## 规格工作流节点

在已有对话中点击输入框的“+”→“规格工作流”，再选择要执行的节点。
可以单独选择调研、澄清需求、讨论想法、技术设计、编写或修订方案、实施任务、
独立验证、检查验收、归档、查看进度、暂停、恢复、快速修复、验证修复批次或受控迭代。
需要从头到尾推进时，明确选择“完整流程”。

选中后，Web 和桌面端会在输入框上沿显示“规格工作流 · 技术设计”这样的状态条，
与目标使用相同的附着式样式；同时启用目标时分行显示。移动客户端保留输入框内的节点胶囊。
选择本身不会发送消息；输入你的需求并发送后，Agent 执行所选部分。
点击胶囊可以更换节点，点击旁边的 × 会停用工作流。
选择保存在当前对话中，刷新页面或从其他设备打开同一对话后仍然保留。

单节点执行完成后停止，不会自动开始下一阶段。“讨论想法”不修改文件，
“查看进度”不会自动创建工作流。调研、设计等文档节点可以独立重做；
重新编写或修订方案后必须重新批准。实施、独立验证和归档仍需满足前置条件，
缺少条件时会解释原因。受控迭代最多执行 3 轮。
移除胶囊会阻止后续工作流派发，但不会删除现有文件或回滚已经完成的代码；
已运行的任务仍通过原有停止操作控制。

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, Code Work hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. Code Work opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
