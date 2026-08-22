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
  await palette.getByRole("option", { name: /切换任务面板/ }).click();
  await expect(page.getByRole("complementary", { name: "任务面板" })).toHaveCount(0);

  await page.keyboard.press("Control+J");
  await expect(page.getByRole("complementary", { name: "任务面板" })).toBeVisible();

  await page.keyboard.press("Control+B");
  await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toHaveCount(0);
  await page.keyboard.press("Control+B");
  await expect(page.getByRole("complementary", { name: "工作台侧栏" })).toBeVisible();
});

test("任务面板明确只运行 shell 演示", async ({ page }) => {
  await openWorkbench(page);

  const taskPanel = page.getByRole("complementary", { name: "任务面板" });
  await expect(taskPanel).toContainText("不读取工作区、不运行 Agent，也不会调用远程模型");
  await expect(taskPanel.getByRole("button", { name: "添加演示任务" })).toBeDisabled();

  await taskPanel.getByLabel("新建演示任务").fill("整理下一步工作");
  await taskPanel.getByRole("button", { name: "添加演示任务" }).click();
  await expect(taskPanel).toContainText("整理下一步工作");
  await expect(taskPanel).toContainText("已完成演示流程；未执行外部操作。");
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
