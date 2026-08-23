import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_LAUNCH_PATH } from "../utils/workbenchRoutes.js";
import {
  readLayout,
  removeWorkbenchTab,
  syncWorkbenchTab,
  toggleWorkbenchSidebar,
  toggleWorkbenchTaskPanel,
  workbenchState,
} from "./workbenchState.js";

const LAYOUT_STORAGE_KEY = "code-work.workbench.layout.v1";

function withWindowLocation(pathname, hash, run) {
  const previous = globalThis.window;
  const storage = {
    [LAYOUT_STORAGE_KEY]: JSON.stringify({
      activeActivity: "explorer",
      sidebarVisible: true,
      taskPanelVisible: true,
    }),
  };
  globalThis.window = {
    location: { pathname, hash },
    localStorage: {
      getItem: (key) => (Object.hasOwn(storage, key) ? storage[key] : null),
      setItem: (key, value) => {
        storage[key] = String(value);
      },
    },
  };
  workbenchState.sidebarVisible = true;
  workbenchState.taskPanelVisible = true;
  try {
    run(storage);
  } finally {
    globalThis.window = previous;
    workbenchState.sidebarVisible = true;
    workbenchState.taskPanelVisible = true;
  }
}

function resetTabs() {
  workbenchState.tabs.splice(0, workbenchState.tabs.length);
}

test("sync maps slash and empty path to a single IDE home tab", () => {
  resetTabs();
  syncWorkbenchTab({ path: "/", meta: { workbenchLabel: "工作区", workbenchIcon: "folder" } });
  assert.equal(workbenchState.tabs.length, 1);
  assert.equal(workbenchState.tabs[0].id, WORKBENCH_LAUNCH_PATH);
  assert.equal(workbenchState.tabs[0].closable, false);

  syncWorkbenchTab({ path: "", meta: { workbenchLabel: "工作区", workbenchIcon: "folder" } });
  assert.equal(workbenchState.tabs.length, 1);
  assert.equal(workbenchState.tabs[0].id, WORKBENCH_LAUNCH_PATH);
  assert.equal(workbenchState.tabs.some((tab) => tab.id === "/"), false);
});

test("closing the last workspace tab lands on a single IDE tab", () => {
  resetTabs();
  syncWorkbenchTab({ path: "/console", meta: { workbenchLabel: "服务", workbenchIcon: "service" } });
  const fallback = removeWorkbenchTab("/console");
  assert.equal(fallback, WORKBENCH_LAUNCH_PATH);
  assert.equal(workbenchState.tabs.length, 1);
  assert.equal(workbenchState.tabs[0].id, WORKBENCH_LAUNCH_PATH);
  assert.equal(workbenchState.tabs[0].closable, false);
  assert.equal(workbenchState.tabs.some((tab) => tab.id === "/"), false);
});

test("sidebar and AI toggles persist only on the workbench surface", () => {
  withWindowLocation("/ide", "", (storage) => {
    toggleWorkbenchSidebar();
    assert.equal(workbenchState.sidebarVisible, false);
    assert.equal(JSON.parse(storage[LAYOUT_STORAGE_KEY]).sidebarVisible, false);
  });

  withWindowLocation("/settings", "", (storage) => {
    toggleWorkbenchSidebar();
    assert.equal(workbenchState.sidebarVisible, false);
    assert.equal(JSON.parse(storage[LAYOUT_STORAGE_KEY]).sidebarVisible, true);
    assert.equal(readLayout().sidebarVisible, true);
  });

  withWindowLocation("/", "#/settings", (storage) => {
    toggleWorkbenchTaskPanel();
    assert.equal(workbenchState.taskPanelVisible, false);
    assert.equal(JSON.parse(storage[LAYOUT_STORAGE_KEY]).taskPanelVisible, true);
  });

  withWindowLocation("/", "#/ide", (storage) => {
    toggleWorkbenchTaskPanel();
    assert.equal(workbenchState.taskPanelVisible, false);
    assert.equal(JSON.parse(storage[LAYOUT_STORAGE_KEY]).taskPanelVisible, false);
  });
});
