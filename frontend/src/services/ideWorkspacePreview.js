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
const executorWriteGrants = new Set();
let sshKeys = defaultSSHKeys();
let knownHosts = defaultKnownHosts();

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

function defaultKnownHosts() {
  return [
    {
      host: "github.com",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:previewhostfingerprint",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewHost github.com",
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
  executorWriteGrants.clear();
  sshKeys = defaultSSHKeys();
  knownHosts = defaultKnownHosts();
  terminals = [];
  agentRuns = [];
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

function normalizeSSHHost(value) {
  const host = String(value || "").trim();
  if (!host || host.includes("..") || /[/\\@]/.test(host) || /^[A-Za-z]:/.test(host)) {
    throw new Error("SSH 主机不合法");
  }
  return host;
}

function normalizeSSHPort(value) {
  const port = Number(value) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH 主机不合法");
  return port;
}

function normalizeHostPublicKey(value) {
  const publicKey = String(value || "").trim();
  if (!publicKey || /begin .+private key/i.test(publicKey)) throw new Error("SSH 主机公钥无效");
  return publicKey;
}

function publicKnownHost(entry) {
  return {
    host: entry.host,
    port: entry.port,
    algorithm: entry.algorithm,
    fingerprint: entry.fingerprint,
    publicKey: entry.publicKey,
  };
}

function presentedKnownHost(host, port, publicKey) {
  const known = knownHosts.find((item) => item.host === host && item.port === port);
  if (known && known.publicKey === publicKey) return publicKnownHost(known);
  return {
    host,
    port,
    algorithm: "ssh-ed25519",
    fingerprint: `SHA256:preview-${host}-${port}`,
    publicKey,
  };
}

function lookupKnownHost(host, port, publicKey) {
  const presented = presentedKnownHost(host, port, publicKey);
  const known = knownHosts.find((item) => item.host === host && item.port === port);
  if (!known) return { status: "unknown", presented };
  if (known.publicKey === publicKey) return { status: "matched", presented, known: publicKnownHost(known) };
  return { status: "mismatch", presented, known: publicKnownHost(known) };
}

export function listIDEKnownHosts() {
  return Promise.resolve().then(() => knownHosts.map(publicKnownHost));
}

export function probeIDEHostKey(host, port) {
  return Promise.resolve().then(() => {
    const normalizedHost = normalizeSSHHost(host);
    const normalizedPort = normalizeSSHPort(port);
    return presentedKnownHost(
      normalizedHost,
      normalizedPort,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewProbe ${normalizedHost}`,
    );
  });
}

export function previewIDEKnownHost(workspaceID, host, port, publicKey) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const presentedHost = normalizeSSHHost(host);
    const presentedPort = normalizeSSHPort(port);
    const presentedKey = normalizeHostPublicKey(publicKey);
    const result = lookupKnownHost(presentedHost, presentedPort, presentedKey);
    const preview = {
      approval: { id: "", workspaceId: workspaceID, runId: "", kind: "", summary: { title: "", impactCodes: [] }, state: "", createdAt: "", expiresAt: "", stateChangedAt: "" },
      status: result.status,
      host: result.presented.host,
      port: result.presented.port,
      algorithm: result.presented.algorithm,
      fingerprint: result.presented.fingerprint,
      publicKey: result.presented.publicKey,
      knownFingerprint: result.known?.fingerprint || "",
    };
    if (result.status === "matched") return preview;
    const kind = result.status === "mismatch" ? "ssh_host_key_changed" : "ssh_known_host";
    const now = "2026-08-23T00:04:00.000Z";
    const record = {
      id: globalThis.crypto?.randomUUID?.() || `66666666-6666-4666-8666-${String(approvals.length + 1).padStart(12, "0")}`,
      workspaceId: workspaceID,
      kind,
      summary: { title: result.status === "mismatch" ? "主机密钥已变更" : "信任 SSH 主机", impactCodes: [kind] },
      state: "pending",
      createdAt: now,
      expiresAt: "2026-08-23T00:09:00.000Z",
      stateChangedAt: now,
      host: presentedHost,
      port: presentedPort,
      publicKey: presentedKey,
    };
    approvals = [...approvals, record];
    return { ...preview, approval: publicApproval(record) };
  });
}

export function commitIDEKnownHost(workspaceID, approvalID, host, port, publicKey) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const presentedHost = normalizeSSHHost(host);
    const presentedPort = normalizeSSHPort(port);
    const presentedKey = normalizeHostPublicKey(publicKey);
    const result = lookupKnownHost(presentedHost, presentedPort, presentedKey);
    if (result.status === "matched") return result.presented;
    const index = approvals.findIndex((record) => record.id === approvalID && record.workspaceId === workspaceID);
    if (index < 0) throw new Error("审批不存在");
    const record = approvals[index];
    if (record.state !== "approved") throw new Error("审批状态无效");
    const expectedKind = result.status === "mismatch" ? "ssh_host_key_changed" : "ssh_known_host";
    if (record.kind !== expectedKind || record.host !== presentedHost || record.port !== presentedPort || record.publicKey !== presentedKey) {
      throw new Error("审批与操作不匹配");
    }
    const next = result.status === "mismatch"
      ? knownHosts.filter((item) => !(item.host === presentedHost && item.port === presentedPort))
      : knownHosts;
    knownHosts = [...next, result.presented];
    approvals = approvals.map((item, itemIndex) => (itemIndex === index ? { ...item, state: "consumed" } : item));
    return result.presented;
  });
}

const GIT_OPERATION_TITLES = {
  git_clone: "克隆仓库",
  git_stage: "暂存文件",
  git_commit: "创建提交",
  git_fetch: "获取远程",
  git_pull: "拉取远程",
  git_push: "推送到远程",
};

function normalizeGitOperation(operation) {
  const kind = String(operation?.kind || "");
  if (!GIT_OPERATION_TITLES[kind]) throw new Error("Git 操作不合法");
  const remoteUrl = String(operation?.remoteUrl || "").trim();
  if (remoteUrl) {
    if (/[;&|<>$`]/.test(remoteUrl) || /:\/\//.test(remoteUrl) && /\/\/[^/]*:[^/]*@/.test(remoteUrl) || remoteUrl.toLowerCase().startsWith("file:") || /^[A-Za-z]:[\\/]/.test(remoteUrl)) {
      throw new Error("Git 操作不合法");
    }
    if (!remoteUrl.startsWith("https://") && !remoteUrl.startsWith("ssh://") && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(remoteUrl)) {
      throw new Error("Git 操作不合法");
    }
  }
  const directory = String(operation?.directory || "").trim().replaceAll("\\", "/");
  if (directory && (directory.includes("..") || directory.startsWith("/") || /^[A-Za-z]:/.test(directory))) {
    throw new Error("Git 操作不合法");
  }
  const paths = Array.isArray(operation?.paths) ? operation.paths.map((item) => String(item || "").replaceAll("\\", "/")) : [];
  if (paths.some((item) => !item || item.includes("..") || item.startsWith("/") || /^[A-Za-z]:/.test(item))) {
    throw new Error("Git 操作不合法");
  }
  const message = String(operation?.message || "").trim();
  const remote = String(operation?.remote || "origin").trim() || "origin";
  const stageAll = Boolean(operation?.stageAll);
  if (kind === "git_clone" && !remoteUrl) throw new Error("Git 操作不合法");
  if (kind === "git_stage" && !stageAll && paths.length === 0) throw new Error("Git 操作不合法");
  if (kind === "git_commit" && !message) throw new Error("Git 操作不合法");
  return {
    kind,
    remoteUrl,
    remote,
    directory: directory || (kind === "git_clone" ? "." : ""),
    paths,
    message,
    stageAll,
    argv: [],
  };
}

export function previewIDEGitOperation(workspaceID, operation) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const normalized = normalizeGitOperation(operation);
    const now = "2026-08-23T00:05:00.000Z";
    const record = {
      id: globalThis.crypto?.randomUUID?.() || `77777777-7777-4777-8777-${String(approvals.length + 1).padStart(12, "0")}`,
      workspaceId: workspaceID,
      kind: normalized.kind,
      summary: { title: GIT_OPERATION_TITLES[normalized.kind], impactCodes: [normalized.kind] },
      state: "pending",
      createdAt: now,
      expiresAt: "2026-08-23T00:10:00.000Z",
      stateChangedAt: now,
      operation: normalized,
    };
    approvals = [...approvals, record];
    return {
      approval: publicApproval(record),
      operation: {
        kind: normalized.kind,
        argv: ["git", normalized.kind.replace("git_", "")],
        remoteUrl: normalized.remoteUrl,
        remote: normalized.remote,
        directory: normalized.directory,
        paths: normalized.paths,
        message: normalized.message,
        stageAll: normalized.stageAll,
      },
    };
  });
}

export function commitIDEGitOperation(workspaceID, approvalID, operation) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const normalized = normalizeGitOperation(operation);
    const index = approvals.findIndex((record) => record.id === approvalID && record.workspaceId === workspaceID);
    if (index < 0) throw new Error("审批不存在");
    const record = approvals[index];
    if (record.state !== "approved") throw new Error("审批状态无效");
    if (record.kind !== normalized.kind) throw new Error("审批与操作不匹配");
    approvals = approvals.map((item, itemIndex) => (itemIndex === index ? { ...item, state: "consumed" } : item));
    return {
      kind: normalized.kind,
      title: GIT_OPERATION_TITLES[normalized.kind],
    };
  });
}

let terminals = [];
let agentRuns = [];

const TERMINAL_PROFILES = [
  { id: "powershell", name: "PowerShell" },
  { id: "cmd", name: "命令提示符" },
];

function publicTerminal(session) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    profileId: session.profileId,
    profileName: session.profileName,
    cols: session.cols,
    rows: session.rows,
    state: session.state,
  };
}

function requireTerminal(sessionID) {
  const session = terminals.find((item) => item.id === sessionID);
  if (!session || session.state === "exited") throw new Error("终端会话不存在");
  return session;
}

export function listIDETerminalProfiles() {
  return Promise.resolve(TERMINAL_PROFILES.map((item) => ({ ...item })));
}

export function openIDETerminalSession(workspaceID, profileID, cols, rows) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const profile = TERMINAL_PROFILES.find((item) => item.id === profileID);
    if (!profile) throw new Error("终端配置不合法");
    const session = {
      id: globalThis.crypto?.randomUUID?.() || `term-${terminals.length + 1}`,
      workspaceId: workspaceID,
      profileId: profile.id,
      profileName: profile.name,
      cols: Number(cols) || 80,
      rows: Number(rows) || 24,
      state: "running",
      output: "预览终端已连接\r\n",
    };
    terminals = [...terminals, session];
    return publicTerminal(session);
  });
}

export function writeIDETerminalSession(sessionID, data) {
  return Promise.resolve().then(() => {
    const session = requireTerminal(sessionID);
    session.output += String(data || "");
  });
}

export function resizeIDETerminalSession(sessionID, cols, rows) {
  return Promise.resolve().then(() => {
    const session = requireTerminal(sessionID);
    session.cols = Number(cols) || session.cols;
    session.rows = Number(rows) || session.rows;
  });
}

export function interruptIDETerminalSession(sessionID) {
  return Promise.resolve().then(() => {
    const session = requireTerminal(sessionID);
    session.output += "^C\r\n";
  });
}

export function closeIDETerminalSession(sessionID) {
  return Promise.resolve().then(() => {
    const session = requireTerminal(sessionID);
    session.state = "exited";
  });
}

export function getIDETerminalOutput(sessionID) {
  return Promise.resolve().then(() => {
    const session = terminals.find((item) => item.id === sessionID);
    if (!session) throw new Error("终端会话不存在");
    return {
      sessionId: session.id,
      data: session.output,
      seq: session.output.length,
      exited: session.state === "exited",
    };
  });
}

function publicAgentRun(run) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    modelId: run.modelId,
    prompt: run.prompt,
    status: run.status,
    createdAtUnixMs: run.createdAtUnixMs,
    updatedAtUnixMs: run.updatedAtUnixMs,
  };
}

export function startIDEAgentRun(workspaceID, modelID, prompt) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const text = String(prompt || "").trim();
    if (!text) throw new Error("Agent 请求不合法");
    const now = Date.now();
    const run = {
      id: globalThis.crypto?.randomUUID?.() || `agent-${agentRuns.length + 1}`,
      workspaceId: workspaceID,
      modelId: String(modelID || "preview-demo-openai"),
      prompt: text,
      status: "completed",
      createdAtUnixMs: now,
      updatedAtUnixMs: now,
      events: [
        { runId: "", seq: 1, kind: "started", text, replaySafe: true, atUnixMs: now },
        { runId: "", seq: 2, kind: "delta", text: `预览回复：${text}`, replaySafe: true, atUnixMs: now },
        { runId: "", seq: 3, kind: "finished", text: "", replaySafe: true, atUnixMs: now },
      ],
    };
    run.events = run.events.map((event) => ({ ...event, runId: run.id }));
    agentRuns = [...agentRuns, run];
    return publicAgentRun(run);
  });
}

export function cancelIDEAgentRun(runID) {
  return Promise.resolve().then(() => {
    const run = agentRuns.find((item) => item.id === runID);
    if (!run) throw new Error("Agent 运行不存在");
    run.status = "canceled";
    return publicAgentRun(run);
  });
}

export function getIDEAgentRun(runID) {
  return Promise.resolve().then(() => {
    const run = agentRuns.find((item) => item.id === runID);
    if (!run) throw new Error("Agent 运行不存在");
    return publicAgentRun(run);
  });
}

export function listIDEAgentRuns(workspaceID) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    return agentRuns.filter((item) => item.workspaceId === workspaceID).map(publicAgentRun);
  });
}

export function getIDEAgentRunEvents(runID) {
  return Promise.resolve().then(() => {
    const run = agentRuns.find((item) => item.id === runID);
    if (!run) throw new Error("Agent 运行不存在");
    return clone(run.events);
  });
}

export function replayIDEAgentRun(runID) {
  return getIDEAgentRunEvents(runID).then((events) => events.filter((event) => event.replaySafe));
}

export function previewIDEAgentEffect(runID, effect) {
  return Promise.resolve().then(() => {
    const run = agentRuns.find((item) => item.id === runID);
    if (!run) throw new Error("Agent 运行不存在");
    const path = normalizeRelativePath(effect?.path, false);
    const node = requireFile(path);
    const now = "2026-08-23T00:10:00.000Z";
    const record = {
      id: globalThis.crypto?.randomUUID?.() || `77777777-7777-4777-8777-${String(approvals.length + 1).padStart(12, "0")}`,
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: "agent_effect",
      summary: { title: `写入 ${path}`, impactCodes: ["workspace_write"] },
      state: "pending",
      createdAt: now,
      expiresAt: "2026-08-23T00:15:00.000Z",
      stateChangedAt: now,
      path,
      text: String(effect?.text ?? ""),
      expectedVersion: node.version,
      effectId: globalThis.crypto?.randomUUID?.() || `effect-${approvals.length + 1}`,
    };
    approvals = [...approvals, record];
    run.events = [...run.events, {
      runId: run.id,
      seq: run.events.length + 1,
      kind: "effect_proposed",
      text: record.summary.title,
      replaySafe: false,
      effect: { id: record.effectId, kind: "workspace_write", path, text: record.text, expectedVersion: record.expectedVersion, summary: record.summary.title },
      atUnixMs: Date.now(),
    }];
    return {
      approval: publicApproval(record),
      effect: { id: record.effectId, kind: "workspace_write", path, text: record.text, expectedVersion: record.expectedVersion, summary: record.summary.title },
    };
  });
}

export function commitIDEAgentEffect(runID, approvalID, effect) {
  return Promise.resolve().then(() => {
    const run = agentRuns.find((item) => item.id === runID);
    if (!run) throw new Error("Agent 运行不存在");
    const path = normalizeRelativePath(effect?.path, false);
    const node = requireFile(path);
    const index = approvals.findIndex((record) => record.id === approvalID && record.workspaceId === run.workspaceId);
    if (index < 0) throw new Error("审批不存在");
    const record = approvals[index];
    if (record.state !== "approved") throw new Error("审批状态无效");
    if (record.kind !== "agent_effect" || record.path !== path || record.text !== String(effect?.text ?? "")) {
      throw new Error("审批与操作不匹配");
    }
    if (node.version !== record.expectedVersion) throw new Error("版本冲突");
    files = { ...files, [path]: { ...node, text: record.text, version: `${node.version}-agent` } };
    approvals = approvals.map((item, itemIndex) => (itemIndex === index ? { ...item, state: "consumed" } : item));
  });
}

export function previewIDEExecutorWriteCapability(workspaceID, executorID) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const now = "2026-08-23T00:12:00.000Z";
    const record = {
      id: globalThis.crypto?.randomUUID?.() || `88888888-8888-4888-8888-${String(approvals.length + 1).padStart(12, "0")}`,
      workspaceId: workspaceID,
      kind: "executor_write",
      summary: { title: "允许执行器写入工作区", impactCodes: ["executor_write"] },
      state: "pending",
      createdAt: now,
      expiresAt: "2026-08-23T00:17:00.000Z",
      stateChangedAt: now,
      executorId: String(executorID || ""),
    };
    approvals = [...approvals, record];
    return {
      approval: publicApproval(record),
      executorId: record.executorId,
      authKind: String(executorID || "").includes("byok") ? "byok_model" : "cli_login",
    };
  });
}

export function commitIDEExecutorWriteCapability(workspaceID, approvalID, executorID) {
  return Promise.resolve().then(() => {
    requireWorkspace(workspaceID);
    const index = approvals.findIndex((record) => record.id === approvalID && record.workspaceId === workspaceID);
    if (index < 0) throw new Error("审批不存在");
    const record = approvals[index];
    if (record.state !== "approved") throw new Error("审批状态无效");
    if (record.kind !== "executor_write" || record.executorId !== String(executorID || "")) {
      throw new Error("审批与操作不匹配");
    }
    executorWriteGrants.add(String(executorID || ""));
    approvals = approvals.map((item, itemIndex) => (itemIndex === index ? { ...item, state: "consumed" } : item));
  });
}

export function applyExecutorPreviewPolicy(items) {
  return clone(items || []).map((item) => {
    const id = String(item?.id || "");
    const granted = executorWriteGrants.has(id);
    const capabilities = (Array.isArray(item?.capabilities) ? item.capabilities : []).filter(
      (capability) => capability !== "write_workspace" || granted,
    );
    return {
      ...item,
      capabilities,
      authKind: id.includes("byok") ? "byok_model" : "cli_login",
    };
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
