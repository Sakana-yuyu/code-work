import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_LAUNCH_PATH } from "../utils/workbenchRoutes.js";
import { removeWorkbenchTab, syncWorkbenchTab, workbenchState } from "./workbenchState.js";

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
