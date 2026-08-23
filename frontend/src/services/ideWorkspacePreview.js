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

export { PREVIEW_IDE_WORKSPACE_ID };

export function resetIDEWorkspacePreview() {
  workspaces = defaultWorkspaces();
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
    const entries = Object.entries(PREVIEW_FILES)
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
    const node = PREVIEW_FILES[path];
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
    for (const [path, node] of Object.entries(PREVIEW_FILES)) {
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
