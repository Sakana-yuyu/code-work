const PREVIEW_IDE_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SELECTED_IDE_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const PREVIEW_FILES = Object.freeze({
  src: { kind: "directory" },
  "src/main.go": {
    kind: "file",
    text: "package main\n// needle\n",
    binary: false,
    truncated: false,
    size: 28,
    version: "preview-main",
  },
  notes: { kind: "directory" },
  "notes/large.txt": {
    kind: "file",
    text: "truncated-preview",
    binary: false,
    truncated: true,
    size: 300000,
    version: "preview-large",
  },
  "binary.dat": {
    kind: "file",
    text: "",
    binary: true,
    truncated: false,
    size: 8,
    version: "preview-binary",
  },
  "secret.link": { kind: "symlink" },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultWorkspaces() {
  return [
    {
      id: PREVIEW_IDE_WORKSPACE_ID,
      name: "preview-workspace",
      registeredAt: "2026-08-23T00:00:00.000Z",
    },
  ];
}

let workspaces = defaultWorkspaces();
let files = clone(PREVIEW_FILES);
let approvals = [];
let sshKeys = defaultSSHKeys();

function defaultSSHKeys() {
  return [
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "preview-key",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:previewfingerprint",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKey preview",
      createdAt: "2026-08-23T00:00:00.000Z",
    },
  ];
}

function publicApproval(record) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    runId: "",
    kind: record.kind,
    summary: clone(record.summary),
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    stateChangedAt: record.stateChangedAt,
  };
}

function requireFile(path) {
  const node = files[path];
  if (!node || node.kind !== "file") throw new Error("不是普通文件");
  return node;
}

export { PREVIEW_IDE_WORKSPACE_ID };

export function resetIDEWorkspacePreview() {
  workspaces = defaultWorkspaces();
  files = clone(PREVIEW_FILES);
  approvals = [];
  sshKeys = defaultSSHKeys();
}

function normalizeRelativePath(value, allowRoot) {
  const path = String(value || "");
  if (path === "") {
    if (allowRoot) return "";
    throw new Error("路径不合法");
  }
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("//")) {
    throw new Error("路径不合法");
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("路径不合法");
  }
  return parts.join("/");
}

function isSensitivePath(path) {
  return path.split("/").some((part) => {
    const name = part.toLowerCase();
    return name === ".env" || name.startsWith(".env.") || name === ".ssh" || name === ".git";
  });
}

function requireWorkspace(workspaceID) {
  const workspace = workspaces.find((item) => item.id === workspaceID);
  if (!workspace) throw new Error("工作区不存在");
  return workspace;
}

export function listIDEWorkspaces() {
  return Promise.resolve().then(() => clone(workspaces));
}

export function selectAndRegisterIDEWorkspace() {
  return Promise.resolve().then(() => {
    if (!workspaces.some((item) => item.id === SELECTED_IDE_WORKSPACE_ID)) {
      workspaces = [
        ...workspaces,
        {
          id: SELECTED_IDE_WORKSPACE_ID,
          name: "preview-selected",
          registeredAt: "2026-08-23T00:01:00.000Z",
        },
      ];
    }
    return clone(workspaces.find((item) => item.id === SELECTED_IDE_WORKSPACE_ID));
  });
}

export function removeIDEWorkspace(workspaceID) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    workspaces = workspaces.filter((item) => item.id !== workspaceID);
  });
}

export function getIDEWorkspaceTree(workspaceID, relativeDirectory) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const directory = normalizeRelativePath(relativeDirectory, true);
    const prefix = directory ? `${directory}/` : "";
    const entries = Object.entries(files)
      .filter(([path]) => {
        if (isSensitivePath(path)) return false;
        if (directory) {
          return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
        }
        return !path.includes("/");
      })
      .map(([path, node]) => ({
        path,
        kind: node.kind,
        size: node.kind === "file" ? node.size : 0,
      }));
    return { entries, truncated: false };
  });
}

export function readIDEWorkspaceText(workspaceID, relativeFile) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const path = normalizeRelativePath(relativeFile, false);
    if (isSensitivePath(path)) throw new Error("敏感路径不可访问");
    const node = files[path];
    if (!node || node.kind !== "file") throw new Error("不是普通文件");
    return {
      path,
      text: node.binary ? "" : node.text,
      size: node.size,
      binary: node.binary,
      truncated: node.truncated,
      version: node.version || "",
    };
  });
}

export function searchIDEWorkspace(workspaceID, relativePath, query) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const directory = normalizeRelativePath(relativePath, true);
    const needle = String(query || "");
    if (!needle) throw new Error("路径不合法");
    const prefix = directory ? `${directory}/` : "";
    const matches = [];
    for (const [path, node] of Object.entries(files)) {
      if (node.kind !== "file" || node.binary || node.truncated || isSensitivePath(path)) continue;
      if (directory && path !== directory && !path.startsWith(prefix)) continue;
      const lines = String(node.text || "").split("\n");
      lines.forEach((line, index) => {
        if (line.includes(needle)) {
          matches.push({ path, line: index + 1, text: line, textTruncated: false });
        }
      });
    }
    return { matches, filesScanned: 1, filesSkipped: 2, limitReached: false };
  });
}

export function previewIDEWorkspaceWrite(workspaceID, relativeFile, text, expectedVersion) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const path = normalizeRelativePath(relativeFile, false);
    if (isSensitivePath(path)) throw new Error("敏感路径不可访问");
    const node = requireFile(path);
    if (node.binary || node.truncated) throw new Error("文件不可写入");
    if (node.version !== expectedVersion) throw new Error("版本冲突");
    const now = "2026-08-23T00:02:00.000Z";
    const record = {
      id: globalThis.crypto?.randomUUID?.() || `33333333-3333-4333-8333-${String(approvals.length + 1).padStart(12, "0")}`,
      workspaceId: workspaceID,
      kind: "workspace_write",
      summary: { title: "保存文件", target: path, impactCodes: ["workspace_write"] },
      state: "pending",
      createdAt: now,
      expiresAt: "2026-08-23T00:07:00.000Z",
      stateChangedAt: now,
      path,
      text: String(text ?? ""),
      expectedVersion,
    };
    approvals = [...approvals, record];
    return {
      approval: publicApproval(record),
      path,
      expectedVersion,
      currentVersion: node.version,
      before: node.text,
      after: record.text,
    };
  });
}

export function approveIDEApproval(workspaceID, approvalID) {
  return Promise.resolve().then(() => transitionApproval(workspaceID, approvalID, "approved"));
}

export function rejectIDEApproval(workspaceID, approvalID) {
  return Promise.resolve().then(() => transitionApproval(workspaceID, approvalID, "rejected"));
}

export function cancelIDEWorkspaceApprovals(workspaceID) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    let count = 0;
    approvals = approvals.map((record) => {
      if (record.workspaceId !== workspaceID || (record.state !== "pending" && record.state !== "approved")) {
        return record;
      }
      count += 1;
      return { ...record, state: "canceled" };
    });
    return count;
  });
}

export function commitIDEWorkspaceWrite(workspaceID, approvalID, relativeFile, text, expectedVersion) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const path = normalizeRelativePath(relativeFile, false);
    if (isSensitivePath(path)) throw new Error("敏感路径不可访问");
    const node = requireFile(path);
    if (node.binary || node.truncated) throw new Error("文件不可写入");
    if (node.version !== expectedVersion) throw new Error("版本冲突");
    const index = approvals.findIndex((record) => record.id === approvalID && record.workspaceId === workspaceID);
    if (index < 0) throw new Error("审批不存在");
    const record = approvals[index];
    if (record.state !== "approved") throw new Error("审批状态无效");
    if (record.path !== path || record.text !== String(text ?? "") || record.expectedVersion !== expectedVersion) {
      throw new Error("审批与操作不匹配");
    }
    files = {
      ...files,
      [path]: {
        ...node,
        text: record.text,
        size: record.text.length,
        version: `${node.version}-saved`,
      },
    };
    approvals = approvals.map((item, itemIndex) => (itemIndex === index ? { ...item, state: "consumed" } : item));
    const saved = files[path];
    return {
      path,
      text: saved.text,
      size: saved.size,
      binary: false,
      truncated: false,
      version: saved.version,
    };
  });
}

export function getIDEGitSnapshot(workspaceID) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    return {
      available: true,
      branch: "main",
      ahead: 1,
      behind: 2,
      changes: [
        { path: "src/main.go", status: "modified" },
        { path: "notes.md", status: "untracked" },
      ],
      diff: "diff --git a/src/main.go b/src/main.go\n+needle\n",
      diffTruncated: false,
      remotes: [{ name: "origin", url: "https://github.com/org/repo.git" }],
    };
  });
}

function publicSSHKey(record) {
  return {
    id: record.id,
    name: record.name,
    algorithm: record.algorithm,
    fingerprint: record.fingerprint,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
  };
}

export function listIDESSHKeys() {
  return Promise.resolve().then(() => sshKeys.map(publicSSHKey));
}

export function importIDESSHKey(name, privateKey, passphrase) {
  return Promise.resolve().then(() => {
    const normalized = String(name || "").trim();
    if (!normalized || normalized.includes("..") || /[/\\]/.test(normalized)) throw new Error("SSH 密钥名称不合法");
    if (!String(privateKey || "").trim()) throw new Error("SSH 私钥无效");
    void passphrase;
    const id = globalThis.crypto?.randomUUID?.() || `55555555-5555-4555-8555-${String(sshKeys.length + 1).padStart(12, "0")}`;
    const record = {
      id,
      name: normalized,
      algorithm: "ssh-ed25519",
      fingerprint: `SHA256:preview-${id.slice(0, 8)}`,
      publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreview ${normalized}`,
      createdAt: "2026-08-23T00:03:00.000Z",
    };
    sshKeys = [...sshKeys, record];
    return publicSSHKey(record);
  });
}

export function generateIDESSHKey(name) {
  return importIDESSHKey(name, "generated", "");
}

export function removeIDESSHKey(keyID) {
  return Promise.resolve().then(() => {
    const next = sshKeys.filter((item) => item.id !== keyID);
    if (next.length === sshKeys.length) throw new Error("SSH 密钥不存在");
    sshKeys = next;
  });
}

function transitionApproval(workspaceID, approvalID, state) {
  requireWorkspace(workspaceID);
  const index = approvals.findIndex((record) => record.id === approvalID && record.workspaceId === workspaceID);
  if (index < 0) throw new Error("审批不存在");
  if (approvals[index].state !== "pending") throw new Error("审批状态无效");
  approvals = approvals.map((record, itemIndex) => (itemIndex === index ? { ...record, state } : record));
  return publicApproval(approvals[index]);
}
