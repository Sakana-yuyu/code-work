import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChildTree,
  applyRootTree,
  createExplorerTree,
  toggleDirectory,
  visibleExplorerRows,
} from "./ideExplorerTree.js";

test("expanding a directory keeps siblings visible", () => {
  const tree = createExplorerTree();
  applyRootTree(tree, {
    truncated: false,
    entries: [
      { path: "src", kind: "directory" },
      { path: "binary.dat", kind: "file", size: 8 },
    ],
  });

  assert.equal(toggleDirectory(tree, "src"), true);
  applyChildTree(tree, "src", {
    truncated: false,
    entries: [{ path: "src/main.go", kind: "file", size: 28 }],
  });

  const rows = visibleExplorerRows(tree);
  assert.deepEqual(rows.map((row) => row.path), ["src", "src/main.go", "binary.dat"]);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[0].label, "src");
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[1].label, "main.go");
  assert.equal(rows[2].depth, 0);
});

test("collapsing a directory hides children without dropping siblings", () => {
  const tree = createExplorerTree();
  applyRootTree(tree, {
    truncated: false,
    entries: [
      { path: "src", kind: "directory" },
      { path: "notes", kind: "directory" },
    ],
  });
  toggleDirectory(tree, "src");
  applyChildTree(tree, "src", {
    truncated: false,
    entries: [{ path: "src/main.go", kind: "file", size: 28 }],
  });

  assert.equal(toggleDirectory(tree, "src"), false);
  const rows = visibleExplorerRows(tree);
  assert.deepEqual(rows.map((row) => row.path), ["src", "notes"]);
  assert.equal(rows[0].expanded, false);
});

test("symlink rows are restricted and do not expand", () => {
  const tree = createExplorerTree();
  applyRootTree(tree, {
    truncated: false,
    entries: [{ path: "secret.link", kind: "symlink" }],
  });
  assert.equal(toggleDirectory(tree, "secret.link"), false);
  const rows = visibleExplorerRows(tree);
  assert.equal(rows[0].restricted, true);
  assert.equal(rows[0].expanded, false);
});
