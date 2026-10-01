# A-5 关键路径证据（Round 148）

**Date:** 2026-10-02  
**Isolate home:** `E:/MyProject/code-work/.t3-a5-r148`  
**Evidence root:** `%TEMP%/codework-a5-r148/evidence`（完整清单见同目录 `manifest.json`）  
**Keypath thread:** `5144a1e5-5f55-4a70-9af1-c071b82a1107`  
**Override:** 真机可跳过；本轮 Mobile 证据来自 AVD `emulator-5554`。连接模式证据不豁免（本项为客户端关键路径，A-7 另证）。

## Surfaces

| Surface    | Evidence files                                                                                                                                                                                         | Covered                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Web 1280   | `web-1280-disconnect-reconnect.png`, `web-1280-approval-tools.png`, `web-1280-tool-details-expanded.png`, `web-1280-model-select.png`, `web-1280-slash-commands.png`, `web-1280-completed-history.png` | 断线重连、审批、工具详情、模型选择、斜杠命令、完成历史                                          |
| Web 360    | `web-360-approval-tools.png`                                                                                                                                                                           | 窄屏审批/工具可见                                                                               |
| Electron   | `electron-cdp-after-sidebar.png`, `electron-earlier-logs.png`, `electron-tool-detail.png`, `electron-cdp-slash.png`, `electron-final-text.txt`                                                         | 同线程：审批 requested/resolved、工具 `cat server/package.json` 与输出、`/model` 斜杠、历史回复 |
| Mobile AVD | `mobile-avd-home.png`, `mobile-avd-worklog-full.png`, `mobile-avd-tool-detail.png`                                                                                                                     | 线程列表、工作日志含 Command approval requested / Approval resolved / Ran command、工具详情     |

## Activity trail (server)

`thread-approved.json` / activities：`approval.requested` → `approval.resolved` → `tool.completed`；助手正文 `hello from mock`。

## Explicit non-claims

- 未把 AVD 等同未豁免的物理真机。
- Mobile AVD 本轮未单独截取模型选择器与斜杠命令面板；Web+Electron 已覆盖命令/模型入口。
- Electron 断线重连 UI 未单独重截；Web 1280 已有 disconnect/reconnect 证据，Electron 加载同一 isolate Web 渲染层。
- 未跑全仓性能基准；无卡顿断言仅基于交互过程中 UI 可操作、无持续动画卡死观察。

## Rollback

本轮只新增证据说明与台账，无生产代码变更。撤回对应 docs/spec 提交即可；isolate `.t3-a5-r148` 与 TEMP 证据可手工删除，不触及 `~/.t3/userdata`。
