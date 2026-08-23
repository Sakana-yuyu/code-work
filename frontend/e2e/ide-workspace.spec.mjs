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

function explorer(page) {
  return page.getByLabel("资源管理器");
}

test("浏览器预览用内存工作区浏览、读取和搜索，不暴露主机路径", async ({ page }) => {
  await openIde(page);

  await expect(page.getByRole("button", { name: /preview-workspace/ })).toBeVisible();
  await expect(explorer(page).getByRole("button", { name: "src", exact: true })).toBeVisible();
  await expect(explorer(page).getByRole("button", { name: "binary.dat", exact: true })).toBeVisible();
  await expect(page.getByText(".env")).toHaveCount(0);

  const gitPanel = page.getByLabel("源代码");
  await expect(gitPanel.getByRole("heading", { name: "源代码" })).toBeVisible();
  await expect(gitPanel.getByText("分支 main · 领先 1 · 落后 2")).toBeVisible();
  await expect(gitPanel.getByText("origin · https://github.com/org/repo.git")).toBeVisible();
  await expect(gitPanel.getByText("needle")).toBeVisible();
  await expect(gitPanel.getByRole("button", { name: "src/main.go 已修改" })).toBeVisible();

  await explorer(page).getByRole("button", { name: "src", exact: true }).click();
  await expect(explorer(page).getByRole("button", { name: "binary.dat", exact: true })).toBeVisible();
  await explorer(page).getByRole("button", { name: "src/main.go", exact: true }).click();
  await expect(page.getByRole("tab", { name: "main.go" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "工作区" })).toBeVisible();
  await expect(page.getByText("package main")).toBeVisible();
  await expect(page.getByText("版本 preview-main")).toBeVisible();
  await expect(page.getByText("文本")).toBeVisible();

  await page.getByLabel("代码编辑器").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// saved");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("保存 src/main.go 需要审批")).toBeVisible();
  await page.getByRole("button", { name: "批准保存" }).click();
  await expect(page.getByText("版本 preview-main-saved")).toBeVisible();
  await expect(page.getByText("// saved")).toBeVisible();

  await explorer(page).getByRole("button", { name: "binary.dat", exact: true }).click();
  await expect(page.getByRole("tab", { name: "binary.dat" })).toBeVisible();
  await expect(page.getByText("二进制文件不可预览。")).toBeVisible();

  await explorer(page).getByRole("button", { name: "notes", exact: true }).click();
  await explorer(page).getByRole("button", { name: "notes/large.txt", exact: true }).click();
  await expect(page.getByText("已截断")).toBeVisible();
  await expect(page.getByText("版本 preview-large")).toBeVisible();

  await explorer(page).getByRole("button", { name: "secret.link", exact: true }).click();
  await expect(page.getByText("此路径不可访问。")).toBeVisible();
  await expect(page.getByRole("tab", { name: "secret.link" })).toBeVisible();

  await page.getByRole("button", { name: "关闭 main.go" }).click();
  await expect(page.getByRole("tab", { name: "main.go" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "工作区" })).toBeVisible();

  await page.getByLabel("搜索工作区").fill("needle");
  await page.locator(".search-row").getByRole("button", { name: "搜索" }).click();
  await page.getByRole("button", { name: "src/main.go:2" }).click();
  await expect(page.getByRole("tab", { name: "main.go" })).toBeVisible();

  await page.getByRole("button", { name: "源代码管理" }).click();
  await expect(page.getByRole("button", { name: "工作区 Git" })).toBeVisible();

  const sshPanel = page.getByLabel("SSH 密钥");
  await expect(sshPanel.getByRole("heading", { name: "SSH 密钥" })).toBeVisible();
  await expect(sshPanel.getByText("preview-key")).toBeVisible();
  await expect(sshPanel.getByText(/SHA256:previewfingerprint/)).toBeVisible();
  await sshPanel.getByLabel("密钥名称").fill("ci-key");
  await sshPanel.getByLabel("私钥").fill("-----BEGIN OPENSSH PRIVATE KEY-----\npreview-secret-material\n-----END OPENSSH PRIVATE KEY-----");
  await sshPanel.getByLabel("口令").fill("preview-passphrase");
  await sshPanel.getByRole("button", { name: "导入密钥" }).click();
  await expect(sshPanel.getByText("ci-key")).toBeVisible();
  await expect(sshPanel.getByLabel("私钥")).toHaveValue("");
  await expect(sshPanel.getByLabel("口令")).toHaveValue("");

  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[A-Za-z]:\\/);
  expect(body).not.toContain("/Users/");
  expect(body).not.toContain("\\\\");
  expect(body).not.toContain("ghp_");
  expect(body).not.toContain("preview-secret-material");
  expect(body).not.toContain("preview-passphrase");
  expect(body).not.toContain("BEGIN OPENSSH PRIVATE KEY");
});

test("选择工作区只增加内存 fixture，不访问真实文件系统", async ({ page }) => {
  await openIde(page);
  await page.getByRole("button", { name: "选择并注册工作区" }).click();
  await expect(page.getByRole("button", { name: /preview-selected/ })).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[A-Za-z]:\\/);
  expect(body).not.toContain("/home/");
});
