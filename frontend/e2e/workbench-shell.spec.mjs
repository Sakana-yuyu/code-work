import { expect, test } from "@playwright/test";
import { basePreviewConfig, seedPreviewTestPlan } from "./helpers.mjs";

async function openWorkbench(page) {
  await page.addInitScript(() => {
    localStorage.setItem("code-work.workbench.layout.v1", JSON.stringify({
      activeActivity: "explorer",
      sidebarVisible: true,
      taskPanelVisible: true,
    }));
  });
  await seedPreviewTestPlan(page, {}, basePreviewConfig());
  await page.goto("/workbench");
  await expect(page.getByRole("heading", { name: "把完整能力放进更清晰的工作台。" })).toBeVisible();
}

test("活动栏和命令面板驱动同一组 Workbench 操作", async ({ page }) => {
  await openWorkbench(page);

  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toContainText("快速定位功能");

  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { name: /切换 AI 栏/ }).click();
  await expect(page.getByRole("complementary", { name: "AI 对话" })).toHaveCount(0);

  await page.keyboard.press("Control+J");
  await expect(page.getByRole("complementary", { name: "AI 对话" })).toBeVisible();

  await page.keyboard.press("Control+B");
  await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toHaveCount(0);
  await page.keyboard.press("Control+B");
  await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toBeVisible();
});

test("AI 对话栏在无工作区时引导打开文件夹，而不是演示任务", async ({ page }) => {
  await openWorkbench(page);

  const agent = page.getByRole("complementary", { name: "AI 对话" });
  await expect(agent).toBeVisible();
  await expect(agent.getByRole("button", { name: "添加演示任务" })).toHaveCount(0);
  await expect(agent).toContainText("先打开文件夹");
  await expect(agent).not.toContainText("不会创建演示任务");
  await expect(agent).not.toContainText("Review the active workspace changes");
});

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
  await expect(page.getByRole("heading", { name: "通用" })).toBeVisible();
  await page.getByRole("button", { name: "返回" }).click();
  await expect(page).toHaveURL(/\/ide/);
  await expect(page.getByRole("heading", { name: "服务控制台" })).toHaveCount(0);
});

test("资源管理器一级入口是工作区、开始使用和设置", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("code-work.workbench.layout.v1", JSON.stringify({
      activeActivity: "explorer",
      sidebarVisible: true,
      taskPanelVisible: true,
    }));
  });
  await seedPreviewTestPlan(page, {}, basePreviewConfig());
  await page.goto("/ide");

  const sidebar = page.getByRole("complementary", { name: "工作台侧栏" });
  const explorerNav = sidebar.getByRole("navigation", { name: "资源管理器" });
  await expect(explorerNav.getByRole("button", { name: "工作区" })).toBeVisible();
  await expect(explorerNav.getByRole("button", { name: "开始使用" })).toBeVisible();
  await expect(explorerNav.getByRole("button", { name: "设置" })).toBeVisible();
  await expect(explorerNav.getByRole("button", { name: "服务控制台" })).toHaveCount(0);
  await expect(explorerNav.getByRole("button", { name: "控制中心" })).toHaveCount(0);
  await expect(explorerNav.getByRole("button", { name: "模型配置" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "工作台主导航" }).getByRole("button", { name: "搜索" }).click();
  await expect(sidebar.getByRole("button", { name: "模型与供应商" })).toBeVisible();
});

test("开始页面主路径只保留工作区与设置", async ({ page }) => {
  await openWorkbench(page);
  await expect(page.getByRole("button", { name: "打开工作区" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "调整设置" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "打开服务控制台" })).toHaveCount(0);
});

test("打开服务设置命令进入服务设置而不是控制台首页", async ({ page }) => {
  await openWorkbench(page);
  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { name: /打开服务设置/ }).click();
  await expect(page).toHaveURL(/\/settings\?category=cursor-service/);
  await expect(page.getByRole("heading", { name: "服务控制台" })).toHaveCount(0);
});

test("设置页切换侧栏不会把工作台栏持久化为隐藏", async ({ page }) => {
  await openWorkbench(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "通用" })).toBeVisible();
  await page.keyboard.press("Control+B");
  await page.goto("/ide");
  await expect(page.getByRole("heading", { level: 1, name: "工作区" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toBeVisible();
});

test("无模型时引导去模型配置，而不是服务控制台", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("code-work.workbench.layout.v1", JSON.stringify({
      activeActivity: "explorer",
      sidebarVisible: true,
      taskPanelVisible: true,
    }));
  });
  await seedPreviewTestPlan(page, {}, { ...basePreviewConfig(), modelAdapters: [] });
  await page.goto("/ide");
  await expect(page.getByRole("heading", { level: 1, name: "工作区" })).toBeVisible();

  const agent = page.getByRole("complementary", { name: "AI 对话" });
  await expect(agent).toBeVisible();
  await expect(agent.getByText("去设置 → Cursor 与服务 / 模型配置")).toBeVisible();
  await expect(agent.getByText("服务控制台")).toHaveCount(0);
  await agent.getByRole("button", { name: "打开模型配置" }).click();
  await expect(page).toHaveURL(/\/model-config/);
  await expect(page).not.toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "服务控制台" })).toHaveCount(0);
});

test("窄屏布局不产生横向页面溢出", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  try {
    await openWorkbench(page);
    await page.getByRole("button", { name: "扩展与能力" }).click();
    await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toContainText("能力与集成");
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
  } finally {
    await context.close();
  }
});
