import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_CONSOLE_PATH,
  WORKBENCH_LAUNCH_PATH,
  currentLocationPath,
  isCurrentWorkbenchSurface,
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

test("current location path reads history pathname or hash path", () => {
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { pathname: "/settings", hash: "" } };
    assert.equal(currentLocationPath(), "/settings");
    assert.equal(isCurrentWorkbenchSurface(), false);

    globalThis.window = { location: { pathname: "/", hash: "#/ide?x=1" } };
    assert.equal(currentLocationPath(), "/ide");
    assert.equal(isCurrentWorkbenchSurface(), true);

    globalThis.window = { location: { pathname: "/", hash: "#/settings?category=cursor-service" } };
    assert.equal(currentLocationPath(), "/settings");
    assert.equal(isCurrentWorkbenchSurface(), false);
  } finally {
    globalThis.window = previous;
  }
});
