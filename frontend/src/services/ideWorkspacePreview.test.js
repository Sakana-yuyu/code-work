import assert from "node:assert/strict";
import test from "node:test";

test("preview IDE workspace fixture never uses the host filesystem", async () => {
  const api = await import("./ideWorkspacePreview.js");
  api.resetIDEWorkspacePreview();
  const workspaces = await api.listIDEWorkspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].id, api.PREVIEW_IDE_WORKSPACE_ID);
  assert.equal(workspaces[0].name, "preview-workspace");
  assert.equal(JSON.stringify(workspaces).includes("C:"), false);
  assert.equal(JSON.stringify(workspaces).includes("/Users/"), false);
  assert.equal(JSON.stringify(workspaces).includes("\\\\"), false);

  const tree = await api.getIDEWorkspaceTree(workspaces[0].id, "");
  const paths = tree.entries.map((entry) => entry.path);
  assert.ok(paths.includes("src"));
  assert.ok(paths.includes("binary.dat"));
  assert.equal(paths.includes(".env"), false);

  const text = await api.readIDEWorkspaceText(workspaces[0].id, "src/main.go");
  assert.equal(text.binary, false);
  assert.match(text.text, /needle/);
  assert.equal(Boolean(text.version), true);
  assert.equal(JSON.stringify(text).includes("C:"), false);

  const binary = await api.readIDEWorkspaceText(workspaces[0].id, "binary.dat");
  assert.equal(binary.binary, true);
  assert.equal(binary.text, "");

  const truncated = await api.readIDEWorkspaceText(workspaces[0].id, "notes/large.txt");
  assert.equal(truncated.truncated, true);

  await assert.rejects(() => api.readIDEWorkspaceText(workspaces[0].id, "../outside"), /路径不合法|敏感/);
  await assert.rejects(() => api.readIDEWorkspaceText(workspaces[0].id, ".env"), /敏感/);

  const search = await api.searchIDEWorkspace(workspaces[0].id, "", "needle");
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].path, "src/main.go");

  const selected = await api.selectAndRegisterIDEWorkspace();
  assert.equal(selected.name, "preview-selected");
  const listed = await api.listIDEWorkspaces();
  assert.equal(listed.length, 2);
  for (const item of listed) {
    assert.equal("root" in item, false);
    assert.equal(JSON.stringify(item).includes("C:"), false);
  }
});
