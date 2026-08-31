import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_CONSOLE_PATH,
  WORKBENCH_LAUNCH_PATH,
  currentLocationPath,
  settingsReturnPath,
} from "./workbenchRoutes.js";

test("启动与设置返回都落在服务控制台", () => {
  assert.equal(WORKBENCH_LAUNCH_PATH, "/console");
  assert.equal(settingsReturnPath(), "/console");
  assert.equal(SERVICE_CONSOLE_PATH, "/console");
});

test("current location path reads history pathname or hash path", () => {
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { pathname: "/settings", hash: "" } };
    assert.equal(currentLocationPath(), "/settings");
    globalThis.window = { location: { pathname: "/index.html", hash: "#/console" } };
    assert.equal(currentLocationPath(), "/console");
  } finally {
    globalThis.window = previous;
  }
});
