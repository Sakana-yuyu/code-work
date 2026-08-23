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

  const preview = await api.previewIDEWorkspaceWrite(workspaces[0].id, "src/main.go", "package saved\n", text.version);
  assert.equal(preview.path, "src/main.go");
  assert.equal(preview.approval.state, "pending");
  await assert.rejects(() => api.commitIDEWorkspaceWrite(workspaces[0].id, preview.approval.id, "src/main.go", "package saved\n", text.version), /审批状态无效/);
  await api.approveIDEApproval(workspaces[0].id, preview.approval.id);
  const saved = await api.commitIDEWorkspaceWrite(workspaces[0].id, preview.approval.id, "src/main.go", "package saved\n", text.version);
  assert.equal(saved.text, "package saved\n");
  assert.notEqual(saved.version, text.version);
  await assert.rejects(() => api.commitIDEWorkspaceWrite(workspaces[0].id, preview.approval.id, "src/main.go", "package saved\n", saved.version), /审批/);
  await assert.rejects(() => api.previewIDEWorkspaceWrite(workspaces[0].id, "notes/large.txt", "nope", "preview-large"), /文件不可写入/);

  const git = await api.getIDEGitSnapshot(workspaces[0].id);
  assert.equal(git.available, true);
  assert.equal(git.branch, "main");
  assert.equal(git.ahead, 1);
  assert.equal(git.behind, 2);
  assert.equal(git.remotes[0].url, "https://github.com/org/repo.git");
  assert.match(git.diff, /needle/);
  assert.equal(JSON.stringify(git).includes("ghp_"), false);
  assert.equal(JSON.stringify(git).includes("C:"), false);
  assert.equal(JSON.stringify(git).includes("/Users/"), false);

  const listedKeys = await api.listIDESSHKeys();
  assert.equal(listedKeys[0].name, "preview-key");
  assert.equal("privateKey" in listedKeys[0], false);
  const imported = await api.importIDESSHKey("ci-key", "-----BEGIN OPENSSH PRIVATE KEY-----\npreview-secret-material\n-----END OPENSSH PRIVATE KEY-----", "preview-passphrase");
  assert.equal(imported.name, "ci-key");
  assert.equal(JSON.stringify(imported).includes("preview-secret-material"), false);
  assert.equal(JSON.stringify(imported).includes("preview-passphrase"), false);
  assert.equal(JSON.stringify(imported).includes("BEGIN "), false);
  const afterImport = await api.listIDESSHKeys();
  assert.equal(JSON.stringify(afterImport).includes("preview-secret-material"), false);
  await api.removeIDESSHKey(imported.id);

  const listedHosts = await api.listIDEKnownHosts();
  assert.equal(listedHosts[0].host, "github.com");
  assert.equal(listedHosts[0].fingerprint, "SHA256:previewhostfingerprint");
  assert.equal("filePath" in listedHosts[0], false);
  const beforeProbe = listedHosts.length;
  const probed = await api.probeIDEHostKey("ci.example", 22);
  assert.equal(probed.host, "ci.example");
  assert.match(probed.publicKey, /^ssh-ed25519 /);
  assert.equal((await api.listIDEKnownHosts()).length, beforeProbe);
  await assert.rejects(() => api.probeIDEHostKey("C:\\\\windows", 22), /SSH 主机不合法/);
  await assert.rejects(
    () => api.previewIDEKnownHost(workspaces[0].id, "ci.example", 22, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"),
    /SSH 主机公钥无效/,
  );
  const hostPreview = await api.previewIDEKnownHost(
    workspaces[0].id,
    "ci.example",
    22,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewHost ci.example",
  );
  assert.equal(hostPreview.status, "unknown");
  assert.equal(hostPreview.approval.state, "pending");
  await assert.rejects(
    () => api.commitIDEKnownHost(workspaces[0].id, hostPreview.approval.id, "ci.example", 22, hostPreview.publicKey),
    /审批状态无效/,
  );
  assert.equal((await api.listIDEKnownHosts()).length, beforeProbe);
  await api.approveIDEApproval(workspaces[0].id, hostPreview.approval.id);
  const committedHost = await api.commitIDEKnownHost(
    workspaces[0].id,
    hostPreview.approval.id,
    "ci.example",
    22,
    hostPreview.publicKey,
  );
  assert.equal(committedHost.host, "ci.example");
  assert.equal((await api.listIDEKnownHosts()).some((item) => item.host === "ci.example"), true);
  const changed = await api.previewIDEKnownHost(
    workspaces[0].id,
    "github.com",
    22,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewHost other",
  );
  assert.equal(changed.status, "mismatch");
  assert.match(JSON.stringify(hostPreview) + JSON.stringify(committedHost), /SHA256:/);
  assert.equal(JSON.stringify(hostPreview).includes("BEGIN "), false);
  assert.equal(JSON.stringify(listedHosts).includes("ide-ssh-known-hosts"), false);

  const selected = await api.selectAndRegisterIDEWorkspace();
  assert.equal(selected.name, "preview-selected");
  const listed = await api.listIDEWorkspaces();
  assert.equal(listed.length, 2);
  for (const item of listed) {
    assert.equal("root" in item, false);
    assert.equal(JSON.stringify(item).includes("C:"), false);
  }
});
