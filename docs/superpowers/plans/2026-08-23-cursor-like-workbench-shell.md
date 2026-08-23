# Cursor 式工作台壳层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第一刀让应用冷启动进入 Cursor 式工作台（编辑器 + 右侧 BYOK Agent 栏），模型与服务只从设置进入，不再把控制台当首页。

**Architecture:** 抽出纯函数路由辅助，把 `/` 重定向到 `/ide`，旧首页挪到 `/console`。工作台右侧用 Agent 对话栏替换委派 `TaskPanel`。`/ide` 中间只保留文件树和编辑器；Git/SSH/执行器表单移出主列。设置返回工作台，并从分类进入现有模型页与服务页。

**Tech Stack:** Vue 3、Vue Router、现有 Wails `clientApi`、Playwright 浏览器预览 fixture、`node:test` 单测、静态 i18n。

## Global Constraints

- 规范：`docs/superpowers/specs/2026-08-23-cursor-like-workbench-shell-design.md`
- 前端不提交主机绝对路径；IDE API 只用 workspace ID + 相对路径
- Agent 走 `startIDEAgentRun`，不经 Cursor exec bridge；写文件/Git/终端/MCP 必须审批 Claim
- 不拷贝 VS Code / Cursor 源码、图标、字体、品牌资产；只学分区
- 中文 UI 源文案；改文案后 `yarn i18n:scan`，补 `en-US` / `ja-JP` / `ru-RU`；锁文件只用 `frontend/yarn.lock`
- 不提交 `frontend/bindings/`
- 浏览器 E2E 只用内存 fixture
- 每个任务独立可测，提交信息用中文、写原因

## File map

| File | Responsibility |
| --- | --- |
| `frontend/src/utils/workbenchRoutes.js` | 启动路径、工作台表面判定、设置返回路径、旧控制台路径 |
| `frontend/src/utils/workbenchRoutes.test.js` | 上述纯函数单测 |
| `frontend/src/utils/agentChatModels.js` | 从用户配置里选出默认 BYOK 模型 ID |
| `frontend/src/utils/agentChatModels.test.js` | 模型选择单测 |
| `frontend/src/router/index.js` | `/` → `/ide`；新增 `/console` 挂原 `Home.vue` |
| `frontend/src/layouts/WorkbenchLayout.vue` | 表面路由用辅助函数；右侧渲染 Agent 栏；`Ctrl+L` 切换 |
| `frontend/src/views/Settings.vue` | 返回 `/ide` |
| `frontend/src/components/workbench/PrimarySidebar.vue` | 资源管理器不再把控制台当一级主入口 |
| `frontend/src/views/WorkbenchWelcome.vue` | 欢迎页不再推销控制台首页 |
| `frontend/src/components/workbench/AgentChatPanel.vue` | 右侧 Cursor 式 AI 栏 |
| `frontend/src/views/IdeWorkspace.vue` | 主列只留工作区选择、树、编辑器、保存审批 |
| `frontend/e2e/workbench-shell.spec.mjs` | 启动工作台 + AI 栏 |
| `frontend/e2e/ide-workspace.spec.mjs` | 主列不再依赖 Git/SSH/Agent 长表单也能保存 |
| `frontend/e2e/routes-smoke.spec.mjs` 及其他 `goto("/")` | 控制台用例改走 `/console` |

---

### Task 1: 启动落在工作台

**Files:**
- Create: `frontend/src/utils/workbenchRoutes.js`
- Create: `frontend/src/utils/workbenchRoutes.test.js`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/layouts/WorkbenchLayout.vue`
- Test: `yarn test:unit`（在 `frontend/`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `WORKBENCH_LAUNCH_PATH = "/ide"`
  - `SERVICE_CONSOLE_PATH = "/console"`
  - `isWorkbenchSurfacePath(path: string): boolean`
  - `settingsReturnPath(): string`（恒为 `WORKBENCH_LAUNCH_PATH`）

- [ ] **Step 1: Write the failing test**

Create `frontend/src/utils/workbenchRoutes.test.js`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_CONSOLE_PATH,
  WORKBENCH_LAUNCH_PATH,
  isWorkbenchSurfacePath,
  settingsReturnPath,
} from "./workbenchRoutes.js";

test("launch and settings return target the IDE workbench", () => {
  assert.equal(WORKBENCH_LAUNCH_PATH, "/ide");
  assert.equal(settingsReturnPath(), "/ide");
  assert.equal(SERVICE_CONSOLE_PATH, "/console");
});

test("workbench surface includes editor and welcome only", () => {
  assert.equal(isWorkbenchSurfacePath("/ide"), true);
  assert.equal(isWorkbenchSurfacePath("/workbench"), true);
  assert.equal(isWorkbenchSurfacePath("/"), false);
  assert.equal(isWorkbenchSurfacePath("/console"), false);
  assert.equal(isWorkbenchSurfacePath("/settings"), false);
  assert.equal(isWorkbenchSurfacePath("/model-config"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit`

Expected: FAIL，缺少 `./workbenchRoutes.js`

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/utils/workbenchRoutes.js`:

```javascript
export const WORKBENCH_LAUNCH_PATH = "/ide";
export const SERVICE_CONSOLE_PATH = "/console";

export function isWorkbenchSurfacePath(path) {
  return path === "/ide" || path === "/workbench";
}

export function settingsReturnPath() {
  return WORKBENCH_LAUNCH_PATH;
}
```

In `frontend/src/router/index.js`:
- 将 `path: "/"` 的 `component: LegacyHome` 改为 `redirect: WORKBENCH_LAUNCH_PATH`（从 `@/utils/workbenchRoutes.js` 导入常量）
- 将 `path: "/service", redirect: "/"` 改为 `redirect: SERVICE_CONSOLE_PATH`
- 新增：

```javascript
{
  path: SERVICE_CONSOLE_PATH,
  component: LegacyHome,
  meta: { showIcon: false, title: "服务", workbenchLabel: "服务", workbenchIcon: "service", directlyClose: false },
},
```

In `frontend/src/layouts/WorkbenchLayout.vue`，用 `isWorkbenchSurfacePath(route.path)` 替换本地 `isWorkbenchSurfaceRoute()` 的 path 判断。离开工作台表面时不要把 `sidebarVisible` / `taskPanelVisible` 写进持久化的 false 之后无法恢复：离开时仅本地隐藏可以保留现状，但进入 `/ide` 或 `/workbench` 时若当前是隐藏且 localStorage 里曾为 true，则恢复 `readLayout()` 的值。最小实现：离开表面时不要赋值 `false` 到 `workbenchState`（设置页可以没有侧栏，因为设置页自己有分类栏）；若现有逻辑在 `/settings` 必须收起侧栏，进入表面时调用已有 persist 读取函数恢复。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `yarn test:unit`

Expected: PASS，含新的 workbenchRoutes 用例

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/workbenchRoutes.js frontend/src/utils/workbenchRoutes.test.js frontend/src/router/index.js frontend/src/layouts/WorkbenchLayout.vue
git commit -m "让应用启动进入工作台，把服务控制台降为 /console。"
```

---

### Task 2: 设置回到工作台，侧栏不再推销控制台

**Files:**
- Modify: `frontend/src/views/Settings.vue`（`handleBack` 约第 79 行）
- Modify: `frontend/src/components/workbench/PrimarySidebar.vue`
- Modify: `frontend/src/views/WorkbenchWelcome.vue`
- Modify: `frontend/src/layouts/WorkbenchLayout.vue`（命令「打开服务控制台」改为设置分类或 `/console`）
- Modify: `frontend/src/components/settings/categories/CursorServiceSettings.vue`（已有 `openModelConfigWindow`；加一行说明「完整模型列表在模型配置」的按钮若已存在则复用）
- Test: `frontend/e2e/routes-smoke.spec.mjs` 里 `/` 仍可访问（重定向后应落到工作台且 `#root` 非空）；macOS 标题栏用例 `goto("/")` 仍能看到「打开设置」

**Interfaces:**
- Consumes: `settingsReturnPath()`, `SERVICE_CONSOLE_PATH`, `WORKBENCH_LAUNCH_PATH`
- Produces: 设置返回工作台；资源管理器一级入口以工作区/设置为准

- [ ] **Step 1: Write the failing test**

在 `frontend/src/utils/workbenchRoutes.test.js` 已有 `settingsReturnPath`。再加一个会失败的约定测试（若尚未断言 PrimarySidebar 文案，则在本任务用 E2E 作为失败点）：

扩展 `frontend/e2e/workbench-shell.spec.mjs`，新增：

```javascript
test("齿轮打开设置后返回工作台而不是服务控制台", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("code-work.workbench.layout.v1", JSON.stringify({
      activeActivity: "explorer",
      sidebarVisible: true,
      taskPanelVisible: true,
    }));
  });
  await seedPreviewTestPlan(page, {}, basePreviewConfig());
  await page.goto("/ide");
  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.getByRole("button", { name: "返回" }).click();
  await expect(page).toHaveURL(/\/ide/);
  await expect(page.getByRole("heading", { name: "服务控制台" })).toHaveCount(0);
});
```

（若设置页返回按钮的 accessible name 不是「返回」，先打开 `Settings.vue` / `SettingsPageHeader.vue` 用实际 name。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/workbench-shell.spec.mjs -g "齿轮打开设置"`

Expected: FAIL（仍回到 `/` 或看见控制台标题）

- [ ] **Step 3: Write minimal implementation**

`Settings.vue` 的 `handleBack`：

```javascript
import { settingsReturnPath } from "@/utils/workbenchRoutes.js";

function handleBack() {
  void router.replace(settingsReturnPath());
}
```

`PrimarySidebar.vue` 的 `explorer.items` 改为：

```javascript
items: [
  { label: "工作区", path: "/ide", icon: "folder" },
  { label: "开始使用", path: "/workbench", icon: "workbench" },
  { label: "设置", path: "/settings", icon: "settings" },
],
```

控制台、控制中心、模型配置从 explorer 一级列表删除。search 里保留「模型与供应商」→ `/model-config`。settings 面板保留「设置」，把「控制中心」改成可选或删除。

`WorkbenchWelcome.vue`：去掉「打开服务控制台」主按钮和第二张 quick card；主路径只留打开工作区与设置。

`WorkbenchLayout.vue` 命令 `open-service`：`navigate("/settings?category=cursor-service")`。

`CursorServiceSettings.vue`：确保有按钮打开 `/model-config`（已有 `openModelConfigWindow` 则补文案「在设置中管理服务；模型列表使用模型配置」）。

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```
npx playwright test e2e/workbench-shell.spec.mjs -g "齿轮打开设置"
npx playwright test e2e/routes-smoke.spec.mjs
```

Expected: 新用例 PASS。routes-smoke 的 `"/"` 仍 PASS（重定向到 `/ide`）。若 macOS 标题栏用例因首页不再渲染 `.title-bar` 的同一结构而失败，改为 `goto("/ide")`。

把仍假设控制台首页的 E2E 改为 `goto("/console")`：

- `e2e/provider-usage-windows.spec.mjs`
- `e2e/delegation-task-polling.spec.mjs`
- `e2e/goal.spec.mjs`
- `e2e/cursor-account-card.spec.mjs`
- `e2e/modal-markdown-lazy.spec.mjs`（若依赖首页卡片）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/Settings.vue frontend/src/components/workbench/PrimarySidebar.vue frontend/src/views/WorkbenchWelcome.vue frontend/src/layouts/WorkbenchLayout.vue frontend/src/components/settings/categories/CursorServiceSettings.vue frontend/e2e
git commit -m "把设置返回和工作台入口从服务控制台拆开。"
```

---

### Task 3: 右侧 BYOK Agent 栏

**Files:**
- Create: `frontend/src/utils/agentChatModels.js`
- Create: `frontend/src/utils/agentChatModels.test.js`
- Create: `frontend/src/components/workbench/AgentChatPanel.vue`
- Modify: `frontend/src/layouts/WorkbenchLayout.vue`（右侧 `TaskPanel` 换为 `AgentChatPanel`）
- Modify: `frontend/src/components/workbench/StatusBar.vue`（「任务」改为「AI」）
- Modify: `frontend/src/views/IdeWorkspace.vue`（删除主列 BYOK Agent 区块，逻辑迁到面板或共享函数）
- Test: `frontend/src/utils/agentChatModels.test.js`；`frontend/e2e/ide-workspace.spec.mjs` 与 `workbench-shell.spec.mjs`

**Interfaces:**
- Consumes: `startIDEAgentRun`, `cancelIDEAgentRun`, `getIDEAgentRunEvents`, `previewIDEAgentEffect`, `commitIDEAgentEffect`, `approveIDEApproval`, `rejectIDEApproval`, `loadUserConfig`
- Produces: `pickDefaultAgentModelID(config): string`；面板 props `{ workspaceID: string }`

- [ ] **Step 1: Write the failing test**

`frontend/src/utils/agentChatModels.test.js`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { pickDefaultAgentModelID } from "./agentChatModels.js";

test("picks the first enabled adapter id", () => {
  const id = pickDefaultAgentModelID({
    modelAdapters: [
      { id: "preview-demo-openai", enabled: true, displayName: "Demo OpenAI" },
      { id: "preview-demo-claude", enabled: true, displayName: "Demo Claude" },
    ],
  });
  assert.equal(id, "preview-demo-openai");
});

test("skips disabled adapters and empty config", () => {
  assert.equal(pickDefaultAgentModelID({
    modelAdapters: [{ id: "off", enabled: false }],
  }), "");
  assert.equal(pickDefaultAgentModelID(null), "");
  assert.equal(pickDefaultAgentModelID({}), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit`

Expected: FAIL，缺少 `pickDefaultAgentModelID`

- [ ] **Step 3: Write minimal implementation**

```javascript
export function pickDefaultAgentModelID(config) {
  const adapters = Array.isArray(config?.modelAdapters) ? config.modelAdapters : [];
  const ready = adapters.find((item) => item && item.enabled !== false && String(item.id || "").trim());
  return ready ? String(ready.id).trim() : "";
}
```

`AgentChatPanel.vue`（结构，中文源文案）：

- `aria-label="AI 对话"`
- 无 `workspaceID`：提示「先打开文件夹」
- 无模型：提示「去设置 → Cursor 与服务 / 模型配置」+ 按钮 `navigate("/model-config")`（不要 `navigate("/")`）
- 有模型：`<select>` 绑定模型 ID；`<pre aria-label="Agent 输出">`；输入 placeholder「询问工作区」；按钮「开始运行」「取消」「预览写入」；审批块与现 `IdeWorkspace.vue` Agent 段相同（批准执行 / 拒绝）
- 调用现有 `startIDEAgentRun(workspaceID, modelID, prompt)` 等 API，行为从 `IdeWorkspace.vue` 原函数搬迁，不要经 exec bridge

`WorkbenchLayout.vue`：

```vue
<AgentChatPanel
  v-if="workbenchState.taskPanelVisible"
  :workspace-id="route.path === '/ide' ? ideWorkspaceId : ''"
  @close="toggleWorkbenchTaskPanel"
/>
```

若 `workspace-id` 暂时拿不到，slice 1 允许面板自己 `listIDEWorkspaces()` 取当前列表第一项，或提供 `provide/inject`。最小：面板内部调用 `listIDEWorkspaces()`，与 `IdeWorkspace.vue` 的 `activeWorkspaceID` 可能短暂不一致时，以 `IdeWorkspace` 通过 `sessionStorage` 键 `code-work.ide.active-workspace-id` 同步：

- `IdeWorkspace` 在 `activeWorkspaceID` 变化时写入该键
- `AgentChatPanel` 读取该键

`StatusBar`：按钮 title「切换 AI 栏 (Ctrl+L)」，可见文字「AI」。`handleGlobalKeydown` 增加 `l`（无 Shift）调用 `toggleWorkbenchTaskPanel`；保留 `j` 以免旧习惯失效。

从 `IdeWorkspace.vue` 删除 `<section aria-label="BYOK Agent">` 整段。

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```
yarn test:unit
npx playwright test e2e/ide-workspace.spec.mjs e2e/workbench-shell.spec.mjs
```

Expected: 单测 PASS。E2E：原 ide-workspace 里 Agent 断言改为在 `getByLabel("AI 对话")` 上操作（询问工作区、开始运行、预览回复、预览写入、批准执行）。`workbench-shell` 里「任务面板」用例改为：

- 可见 `AI 对话`
- 无模型或无工作区时出现设置引导，而不是「添加演示任务」
- 不再断言委派快照文案（委派从右侧栏移除，覆盖保留在 `e2e/delegation-executors.spec.mjs`）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/agentChatModels.js frontend/src/utils/agentChatModels.test.js frontend/src/components/workbench/AgentChatPanel.vue frontend/src/layouts/WorkbenchLayout.vue frontend/src/components/workbench/StatusBar.vue frontend/src/views/IdeWorkspace.vue frontend/e2e
git commit -m "把 BYOK Agent 放到工作台右侧栏，避免再占独立页面。"
```

---

### Task 4: `/ide` 主列收成编辑器

**Files:**
- Modify: `frontend/src/views/IdeWorkspace.vue`
- Modify: `frontend/e2e/ide-workspace.spec.mjs`（Git/SSH/终端若仍要覆盖：改为折叠区或设置入口；slice 1 至少保证保存审批仍在）

**Interfaces:**
- Consumes: 现有 workspace 读写与审批 API
- Produces: `/ide` 中间列只有工作区选择、树、搜索、编辑器、保存审批；可选底部「打开终端」一条按钮

- [ ] **Step 1: Write the failing test**

在 `e2e/ide-workspace.spec.mjs` 增加（或修改现有长用例拆出）：

```javascript
test("工作区主列是编辑器而不是运维表单墙", async ({ page }) => {
  await openIde(page);
  await expect(page.getByRole("heading", { name: "执行器写入权限" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "SSH 密钥" })).toHaveCount(0);
  await expect(page.getByLabel("AI 对话")).toBeVisible();
});
```

Git/SSH 的原有断言从默认可见主列移除。若仍需回归，另开 `test.describe("设置中的 Git SSH")` 并 `test.skip` 直到后续切片，或把 Git 只读摘要留在源代码管理侧栏。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/ide-workspace.spec.mjs -g "工作区主列是编辑器"`

Expected: FAIL，页面上仍有那些 heading

- [ ] **Step 3: Write minimal implementation**

从 `IdeWorkspace.vue` 模板删除这些 `<section>`（保留 script 里的函数可一并删以免死代码）：

- Git 操作表单（克隆 URL 等）
- SSH 密钥导入
- 已知主机表单
- 执行器写入权限
- 终端大表单（slice 1 可留状态栏入口；若删终端块，`e2e` 里终端断言改为 skip 或移到后续任务）

保留：工作区列表、选择并注册、文件树、搜索、页签、只读/可写编辑器、保存预览/批准。

只读 Git 摘要（分支、ahead/behind）可留在侧栏「源代码管理」或编辑器下方一行，不要表单。

空工作区：中间显示「打开文件夹」，按钮仍调用 `selectAndRegisterIDEWorkspace`。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx playwright test e2e/ide-workspace.spec.mjs`

Expected: 浏览/保存/审批 PASS；已删除区块的旧断言已改掉。页面 `innerText` 仍不得出现 `E:\`、`/Users/`、私钥 PEM、口令。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/IdeWorkspace.vue frontend/e2e/ide-workspace.spec.mjs
git commit -m "把工作区主列收成编辑器，运维表单不再占据 Cursor 式中间区。"
```

---

### Task 5: i18n 与壳层文案扫尾

**Files:**
- Modify: 本切片新增中文源文案的 `.vue`
- Modify: `frontend/src/i18n/locales/zh-CN.json`（scan 生成）
- Modify: `frontend/src/i18n/locales/en-US.json`
- Modify: `frontend/src/i18n/locales/ja-JP.json`
- Modify: `frontend/src/i18n/locales/ru-RU.json`
- Modify: `frontend/src/i18n/generated/catalog.json`

**Interfaces:**
- Consumes: `frontend/plugins/static-i18n-plugin.js` 扫描规则
- Produces: 无空翻译；中文源文案不进 locale 文件当 key

- [ ] **Step 1: Scan**

Run（在 `frontend/`）：

```
yarn i18n:scan
```

- [ ] **Step 2: Fill empty keys**

对 en-US / ja-JP / ru-RU 中 `": ""` 的新 key 补翻译。例如：

- 「AI 对话」→ Chat / AI チャット / Чат
- 「询问工作区」→ Ask the workspace / ワークスペースに質問 / Спросить рабочую область
- 「去设置配置模型」等按实际新增字面量填写

- [ ] **Step 3: Verify**

```
yarn i18n:scan
yarn test:unit
npx playwright test e2e/ide-workspace.spec.mjs e2e/workbench-shell.spec.mjs e2e/routes-smoke.spec.mjs e2e/delegation-executors.spec.mjs
```

Expected: 无新增空串；上述 E2E PASS。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n
git commit -m "为工作台壳层新文案补齐静态翻译。"
```

---

## Spec coverage

| Spec 要求 | Task |
| --- | --- |
| 冷启动不是服务控制台 | 1 |
| 工作台表面含编辑器 | 1、4 |
| 齿轮进设置，返回工作台 | 2 |
| 设置能进模型与服务 | 2（`cursor-service` + `/model-config`） |
| 右侧 AI + BYOK + 审批 | 3 |
| 无模型引导去设置不是首页 | 3 |
| `/ide` 不是表单墙 | 4 |
| 中文 + 扫描 + 三语 | 5 |
| 浏览器 fixture、无主机路径/私钥 | 3、4 E2E |
| 不拷贝 Cursor/VS Code 资产 | 全程只用现有 glyphs/tokens |
| Git/SSH 完整 SCM、多 Agent | 明确不在本计划 |

## 本计划之后（不要在执行时膨胀）

- 源代码管理侧栏接 Git 摘要与 typed mutation
- 底部终端面板
- 设置里嵌完整 Home 运维卡片
- 执行器写入授权进设置 Agent 分类
