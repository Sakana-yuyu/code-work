# Code Work

一个独立的桌面开发工作台项目。

目标是构建具有现代开发工作台体验的界面壳：活动栏、侧边栏、编辑/任务工作区、状态栏与可扩展的 AI 面板；第一版保留 Cursor BYOK 的完整功能内核，并以独立的应用数据目录运行。

## 当前状态

- 底层基线：`cursor-byok` 提交 `9ac2f25ea77b7db666b5dbcf2ca2ea4dd4538edc`。
- 产品数据与现有 cursor-byok 隔离；不会自动读取、迁移或删除其配置、账号、证书和历史记录。
- VS Code 与 OpenAI Codex 仅作为本地参考源码，用于研究信息架构、交互与可访问性；其源码和品牌资产不进入本项目的产品代码或构建产物。

详细的参考来源记录见 `docs/reference-provenance.md`。
