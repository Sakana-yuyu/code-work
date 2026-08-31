import { describe, expect, it } from "vite-plus/test";

import type { ByokDelegationConfig, ByokDelegationExecutor } from "@codework/contracts";

import {
  clampFailoverLimit,
  ExecutorAttemptError,
  ExecutorProbeRegistry,
  effectiveExecutorList,
  isExecutorCancellation,
  isSwitchableExecutorFailure,
  isValidExecutorId,
  normalizeExecutors,
  probeFromVersionRun,
  resolveExecutablePath,
} from "./DelegationExecutors.ts";

const executor = (overrides: Partial<ByokDelegationExecutor> = {}): ByokDelegationExecutor => ({
  id: "backup",
  name: "",
  enabled: true,
  priority: 100,
  command: "node backup.mjs",
  environmentVariables: [],
  probeArguments: "",
  ...overrides,
});

const delegationConfig = (
  overrides: Partial<ByokDelegationConfig> = {},
): ByokDelegationConfig => ({
  enabled: true,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
  ...overrides,
});

describe("normalizeExecutors", () => {
  it("drops invalid ids, reserved ids, empty commands and duplicates", () => {
    const rows = normalizeExecutors([
      executor({ id: "Bad Id" }),
      executor({ id: "default" }),
      executor({ id: "alpha", command: "  " }),
      executor({ id: "dup", command: "a" }),
      executor({ id: "dup", command: "b" }),
      executor({ id: "beta-1", command: " node b.mjs ", priority: -5 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["dup", "beta-1"]);
    expect(rows[1]?.command).toBe("node b.mjs");
    expect(rows[1]?.priority).toBe(0);
  });

  it("keeps enabled=true by default and filters empty env names", () => {
    const rows = normalizeExecutors([
      executor({ id: "gamma", environmentVariables: ["OPENAI_API_KEY", " ", "T3_HOME"] }),
    ]);
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.environmentVariables).toEqual(["OPENAI_API_KEY", "T3_HOME"]);
  });
});

describe("effectiveExecutorList", () => {
  it("keeps the legacy command as the synthetic default first, backups after", () => {
    const list = effectiveExecutorList(
      delegationConfig({
        executorCommand: "node main.mjs",
        executors: [
          executor({ id: "zeta", priority: 50 }),
          executor({ id: "alpha", priority: 100, enabled: false }),
          executor({ id: "beta", priority: 100 }),
        ],
      }),
    );
    expect(list.map((row) => row.id)).toEqual(["zeta", "beta", "default"]);
    expect(list[2]?.command).toBe("node main.mjs");
    expect(list[2]?.environmentVariables).toEqual([]);
  });

  it("returns an empty list when nothing is configured or enabled", () => {
    expect(effectiveExecutorList(delegationConfig())).toEqual([]);
    expect(
      effectiveExecutorList(delegationConfig({ executors: [executor({ enabled: false })] })),
    ).toEqual([]);
  });
});

describe("clampFailoverLimit / isValidExecutorId", () => {
  it("bounds the failover limit to 1..5 with default 3", () => {
    expect(clampFailoverLimit(undefined)).toBe(3);
    expect(clampFailoverLimit(0)).toBe(1);
    expect(clampFailoverLimit(99)).toBe(5);
    expect(clampFailoverLimit(Number.NaN)).toBe(3);
  });

  it("accepts lowercase ids only", () => {
    expect(isValidExecutorId("claude-code")).toBe(true);
    expect(isValidExecutorId("a_1.x")).toBe(true);
    expect(isValidExecutorId("-lead")).toBe(false);
    expect(isValidExecutorId("Has Space")).toBe(false);
    expect(isValidExecutorId("")).toBe(false);
  });
});

describe("ExecutorAttemptError classification", () => {
  it("treats not_found, spawn_failed and exit_nonzero as switchable", () => {
    for (const kind of ["not_found", "spawn_failed", "exit_nonzero"] as const) {
      const error = new ExecutorAttemptError(kind, "boom");
      expect(isSwitchableExecutorFailure(error)).toBe(true);
      expect(isExecutorCancellation(error)).toBe(false);
    }
  });

  it("treats cancelled as terminal and other errors as non-switchable", () => {
    const cancelled = new ExecutorAttemptError("cancelled", "stopped");
    expect(isSwitchableExecutorFailure(cancelled)).toBe(false);
    expect(isExecutorCancellation(cancelled)).toBe(true);
    expect(isSwitchableExecutorFailure(new Error("generic"))).toBe(false);
  });
});

describe("resolveExecutablePath", () => {
  const exists = (paths: ReadonlySet<string>) => (path: string) => paths.has(path);

  it("resolves bare names across PATH entries (posix)", () => {
    expect(
      resolveExecutablePath("claude", {
        platform: "linux",
        paths: ["/usr/bin", "/usr/local/bin"],
        pathExt: [],
        exists: exists(new Set(["/usr/local/bin/claude"])),
      }),
    ).toBe("/usr/local/bin/claude");
  });

  it("appends Windows PATHEXT for extensionless names", () => {
    expect(
      resolveExecutablePath("codex", {
        platform: "win32",
        paths: ["C:\\Tools"],
        pathExt: [".CMD", ".EXE"],
        exists: exists(new Set(["C:\\Tools\\codex.EXE"])),
      }),
    ).toBe("C:\\Tools\\codex.EXE");
  });

  it("keeps explicit extensions and directory-bearing paths intact", () => {
    expect(
      resolveExecutablePath("node.exe", {
        platform: "win32",
        paths: [],
        pathExt: [".CMD"],
        exists: exists(new Set(["node.exe"])),
      }),
    ).toBe("node.exe");
    expect(
      resolveExecutablePath("C:\\Program Files\\tool\\tool.exe", {
        platform: "win32",
        paths: [],
        pathExt: [],
        exists: exists(new Set(["C:\\Program Files\\tool\\tool.exe"])),
      }),
    ).toBe("C:\\Program Files\\tool\\tool.exe");
    expect(
      resolveExecutablePath("./missing-tool", {
        platform: "linux",
        paths: ["/usr/bin"],
        pathExt: [],
        exists: exists(new Set(["/usr/bin/missing-tool"])),
      }),
    ).toBeUndefined();
  });
});

describe("probeFromVersionRun", () => {
  it("maps spawn-not-found to not_installed and other spawn failures to unhealthy", () => {
    expect(probeFromVersionRun({ failureKind: "not_found", stdout: "", stderr: "" })).toEqual({
      state: "not_installed",
    });
    expect(probeFromVersionRun({ failureKind: "spawn_failed", stdout: "", stderr: "" })).toEqual({
      state: "unhealthy",
      diagnosticCode: "spawn_failed",
    });
  });

  it("maps non-zero exits to probe_failed with a bounded stderr preview", () => {
    const outcome = probeFromVersionRun({
      exitCode: 1,
      stdout: "",
      stderr: "x".repeat(500),
    });
    expect(outcome.state).toBe("unhealthy");
    expect(outcome.diagnosticCode).toBe("probe_failed");
    expect((outcome.diagnosticPreview ?? "").length).toBeLessThanOrEqual(160);
  });

  it("requires non-empty version output and keeps the first line on success", () => {
    expect(probeFromVersionRun({ exitCode: 0, stdout: "  \n", stderr: "" })).toEqual({
      state: "unhealthy",
      diagnosticCode: "version_missing",
    });
    const ready = probeFromVersionRun({ exitCode: 0, stdout: "claude 1.2.3\nmore", stderr: "" });
    expect(ready.state).toBe("ready");
    expect(ready.diagnosticPreview).toBe("claude 1.2.3");
  });
});

describe("ExecutorProbeRegistry", () => {
  it("caches probe results for the TTL and re-probes on command changes", async () => {
    let clock = 1_000;
    let calls = 0;
    const registry = new ExecutorProbeRegistry(
      async () => {
        calls += 1;
        return { state: "ready" as const };
      },
      () => clock,
    );
    const candidate = executor({ id: "probe-a" });
    const first = await registry.probe(candidate);
    const cached = await registry.probe(candidate);
    expect(calls).toBe(1);
    expect(cached.state).toBe("ready");
    expect(cached.probedAt).toBe(1_000);

    clock += 31_000;
    await registry.probe(candidate);
    expect(calls).toBe(2);
    expect(first.state).toBe("ready");

    await registry.probe(executor({ id: "probe-a", command: "node other.mjs" }));
    expect(calls).toBe(3);
  });

  it("coalesces concurrent probes into a single flight", async () => {
    let calls = 0;
    const registry = new ExecutorProbeRegistry(
      async () => {
        calls += 1;
        return { state: "ready" as const };
      },
      () => 1_000,
    );
    const candidate = executor({ id: "probe-b" });
    // Both calls enter probe() synchronously before either awaits, so the
    // second must join the first's in-flight promise.
    const [left, right] = await Promise.all([registry.probe(candidate), registry.probe(candidate)]);
    expect(calls).toBe(1);
    expect(left.state).toBe(right.state);
  });

  it("applies and clears the cooldown around switchable failures", async () => {
    let clock = 1_000;
    const registry = new ExecutorProbeRegistry(async () => ({ state: "ready" as const }), () => clock);
    const candidate = executor({ id: "probe-c", command: "node a.mjs" });
    expect(registry.isCoolingDown(candidate)).toBe(false);
    registry.recordFailure(candidate);
    expect(registry.isCoolingDown(candidate)).toBe(true);
    clock += 31_000;
    expect(registry.isCoolingDown(candidate)).toBe(false);
    registry.recordFailure(candidate);
    // Fixing the command clears the cooldown immediately.
    const fixed = executor({ id: "probe-c", command: "node fixed.mjs" });
    expect(registry.isCoolingDown(fixed)).toBe(false);
    registry.recordSuccess(candidate);
    expect(registry.isCoolingDown(candidate)).toBe(false);
  });
});
