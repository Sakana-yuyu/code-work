import { expect, test } from "@playwright/test";
import { basePreviewConfig, seedPreviewTestPlan } from "./helpers.mjs";

async function openIde(page) {
  await page.addInitScript(() => {
    localStorage.setItem("code-work.workbench.layout.v1", JSON.stringify({
      activeActivity: "explorer",
      sidebarVisible: true,
      taskPanelVisible: false,
    }));
  });
  await seedPreviewTestPlan(page, {}, basePreviewConfig());
  await page.goto("/ide");
  await expect(page.getByRole("heading", { level: 1, name: "工作区" })).toBeVisible();
}

test("浏览器预览用内存工作区浏览、读取和搜索，不暴露主机路径", async ({ page }) => {
  await openIde(page);

  await expect(page.getByRole("button", { name: /preview-workspace/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "src" })).toBeVisible();
  await expect(page.getByRole("button", { name: "binary.dat" })).toBeVisible();
  await expect(page.getByText(".env")).toHaveCount(0);

  await page.getByRole("button", { name: "src" }).click();
  await expect(page.getByRole("button", { name: "binary.dat" })).toBeVisible();
  await page.getByRole("button", { name: "src/main.go" }).click();
  await expect(page.getByRole("tab", { name: "main.go" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "工作区" })).toBeVisible();
  await expect(page.getByText("package main")).toBeVisible();
  await expect(page.getByText("版本 preview-main")).toBeVisible();
  await expect(page.getByText("文本")).toBeVisible();

  await page.getByRole("button", { name: "binary.dat" }).click();
  await expect(page.getByRole("tab", { name: "binary.dat" })).toBeVisible();
  await expect(page.getByText("二进制文件不可预览。")).toBeVisible();

  await page.getByRole("button", { name: "notes" }).click();
  await page.getByRole("button", { name: "notes/large.txt" }).click();
  await expect(page.getByText("已截断")).toBeVisible();
  await expect(page.getByText("版本 preview-large")).toBeVisible();

  await page.getByRole("button", { name: "secret.link" }).click();
  await expect(page.getByText("此路径不可访问。")).toBeVisible();
  await expect(page.getByRole("tab", { name: "secret.link" })).toBeVisible();

  await page.getByRole("button", { name: "关闭 main.go" }).click();
  await expect(page.getByRole("tab", { name: "main.go" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "工作区" })).toBeVisible();

  await page.getByLabel("搜索工作区").fill("needle");
  await page.locator(".search-row").getByRole("button", { name: "搜索" }).click();
  await page.getByRole("button", { name: "src/main.go:2" }).click();
  await expect(page.getByRole("tab", { name: "main.go" })).toBeVisible();

  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[A-Za-z]:\\/);
  expect(body).not.toContain("/Users/");
  expect(body).not.toContain("\\\\");
});

test("选择工作区只增加内存 fixture，不访问真实文件系统", async ({ page }) => {
  await openIde(page);
  await page.getByRole("button", { name: "选择并注册工作区" }).click();
  await expect(page.getByRole("button", { name: /preview-selected/ })).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[A-Za-z]:\\/);
  expect(body).not.toContain("/home/");
});
