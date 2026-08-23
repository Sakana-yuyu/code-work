export function createExplorerTree() {
  return {
    entries: [],
    truncated: false,
    children: Object.create(null),
    expanded: new Set(),
    revision: 0,
  };
}

function bump(tree) {
  tree.revision += 1;
}

function findEntry(tree, path) {
  const walk = (entries) => {
    for (const entry of entries) {
      if (entry.path === path) return entry;
      const childState = tree.children[entry.path];
      if (childState) {
        const found = walk(childState.entries);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(tree.entries);
}

export function entryBasename(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || path;
}

export function applyRootTree(tree, result) {
  tree.entries = Array.isArray(result?.entries) ? result.entries.slice() : [];
  tree.truncated = Boolean(result?.truncated);
  tree.children = Object.create(null);
  tree.expanded = new Set();
  bump(tree);
}

export function applyChildTree(tree, directoryPath, result) {
  tree.children[directoryPath] = {
    entries: Array.isArray(result?.entries) ? result.entries.slice() : [],
    truncated: Boolean(result?.truncated),
  };
  tree.expanded.add(directoryPath);
  bump(tree);
}

export function toggleDirectory(tree, path) {
  const entry = findEntry(tree, path);
  if (!entry || entry.kind !== "directory") return false;
  if (tree.expanded.has(path)) {
    tree.expanded.delete(path);
    bump(tree);
    return false;
  }
  tree.expanded.add(path);
  bump(tree);
  return !tree.children[path];
}

export function visibleExplorerRows(tree) {
  const rows = [];
  const walk = (entries, depth) => {
    for (const entry of entries) {
      const expanded = entry.kind === "directory" && tree.expanded.has(entry.path);
      const childState = tree.children[entry.path];
      rows.push({
        path: entry.path,
        kind: entry.kind,
        size: entry.size || 0,
        depth,
        label: entryBasename(entry.path),
        expanded,
        restricted: entry.kind === "symlink",
        truncated: Boolean(childState?.truncated),
      });
      if (expanded && childState) walk(childState.entries, depth + 1);
    }
  };
  walk(tree.entries, 0);
  return rows;
}
