import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_CONSOLE_PATH,
  WORKBENCH_LAUNCH_PATH,
  isWorkbenchSurfacePath,
  settingsReturnPath,
} from "./workbenchRoutes.js";

test("launch and settings return target the IDE workbench", () => {
  assert.equal(WORKBENCH_LAUNCH_PATH, "/ide");
  assert.equal(settingsReturnPath(), "/ide");
  assert.equal(SERVICE_CONSOLE_PATH, "/console");
});

test("workbench surface includes editor and welcome only", () => {
  assert.equal(isWorkbenchSurfacePath("/ide"), true);
  assert.equal(isWorkbenchSurfacePath("/workbench"), true);
  assert.equal(isWorkbenchSurfacePath("/"), false);
  assert.equal(isWorkbenchSurfacePath("/console"), false);
  assert.equal(isWorkbenchSurfacePath("/settings"), false);
  assert.equal(isWorkbenchSurfacePath("/model-config"), false);
});
