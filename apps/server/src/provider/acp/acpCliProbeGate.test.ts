// @effect-diagnostics nodeBuiltinImport:off - 测试直接构造隔离的本地文件夹和临时 CLI。
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { isProbeExecutableAvailable, isProbeScriptAvailable } from "./acpCliProbeGate.ts";

const isWindows = HostProcessPlatform.defaultValue() === "win32";

let root: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-probe-gate-"));
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("isProbeExecutableAvailable", () => {
  it.each([undefined, "", " \t "])("rejects an unset or blank command %j", (command) => {
    expect(isProbeExecutableAvailable(command, {})).toBe(false);
  });

  it("rejects an explicitly configured missing path", () => {
    expect(isProbeExecutableAvailable(NodePath.join(root, "missing.exe"), {})).toBe(false);
  });

  it.each(["absent", "empty", "missing-directory"])(
    "rejects a bare command when PATH is %s",
    (scenario) => {
      const env =
        scenario === "absent"
          ? {}
          : { PATH: scenario === "empty" ? "" : NodePath.join(root, "missing") };
      expect(isProbeExecutableAvailable("codework-test-cli", env)).toBe(false);
    },
  );

  it("rejects a directory even with an executable extension", () => {
    const directory = NodePath.join(root, "directory.exe");
    NodeFS.mkdirSync(directory);
    expect(isProbeExecutableAvailable(directory, {})).toBe(false);
  });

  it("accepts an executable temporary file without running it", () => {
    const command = NodePath.join(root, isWindows ? "probe.cmd" : "probe");
    NodeFS.writeFileSync(command, "");
    if (!isWindows) NodeFS.chmodSync(command, 0o755);
    expect(isProbeExecutableAvailable(command, {})).toBe(true);
  });

  it("resolves a temporary command through PATH and Windows PATHEXT", () => {
    const command = NodePath.join(root, isWindows ? "probe.CMD" : "probe");
    NodeFS.writeFileSync(command, "");
    if (!isWindows) NodeFS.chmodSync(command, 0o755);
    const env = isWindows ? { Path: root, PATHEXT: ".CMD" } : { PATH: root };
    expect(isProbeExecutableAvailable("probe", env)).toBe(true);
  });

  it("rejects a file without executable permissions or a Windows executable extension", () => {
    const command = NodePath.join(root, "probe.txt");
    NodeFS.writeFileSync(command, "");
    if (!isWindows) NodeFS.chmodSync(command, 0o644);
    expect(isProbeExecutableAvailable(command, { PATHEXT: ".EXE;.CMD" })).toBe(false);
  });
});

describe("isProbeScriptAvailable", () => {
  it.each([undefined, "", " \t "])("rejects an unset or blank script path %j", (scriptPath) => {
    expect(isProbeScriptAvailable(scriptPath)).toBe(false);
  });

  it("rejects an explicitly configured missing script", () => {
    expect(isProbeScriptAvailable(NodePath.join(root, "missing.js"))).toBe(false);
  });

  it("rejects a directory", () => {
    expect(isProbeScriptAvailable(root)).toBe(false);
  });

  it("accepts a readable Node script without requiring executable permissions", () => {
    const scriptPath = NodePath.join(root, "probe.js");
    NodeFS.writeFileSync(scriptPath, "");
    if (!isWindows) NodeFS.chmodSync(scriptPath, 0o644);
    expect(isProbeScriptAvailable(scriptPath)).toBe(true);
  });
});
