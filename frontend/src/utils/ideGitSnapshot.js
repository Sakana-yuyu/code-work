export const EMPTY_IDE_GIT_SNAPSHOT = Object.freeze({
  available: false,
  branch: "",
  ahead: 0,
  behind: 0,
  changes: [],
  remotes: [],
  diff: "",
  diffTruncated: false,
});

export function gitChangeStatusLabel(status) {
  switch (String(status || "")) {
    case "untracked":
      return "未跟踪";
    case "modified":
      return "已修改";
    case "added":
      return "已新增";
    case "deleted":
      return "已删除";
    case "renamed":
      return "已重命名";
    case "copied":
      return "已复制";
    case "conflict":
      return "冲突";
    default:
      return "已变更";
  }
}

export function normalizeGitSnapshot(value) {
  if (!value || typeof value !== "object") return { ...EMPTY_IDE_GIT_SNAPSHOT };
  return {
    available: Boolean(value.available),
    branch: String(value.branch || ""),
    ahead: Number(value.ahead) || 0,
    behind: Number(value.behind) || 0,
    changes: Array.isArray(value.changes) ? value.changes : [],
    remotes: Array.isArray(value.remotes) ? value.remotes : [],
    diff: String(value.diff || ""),
    diffTruncated: Boolean(value.diffTruncated),
  };
}
