import { describe, expect, it } from "vite-plus/test";

import { __testables, resolveScheduler } from "./ByokDelegationService.ts";

const { parseExecutorCommand, buildChildEnv, preview } = __testables;

const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  maxConcurrency: 2,
  queueTimeoutMs: 5_000,
  executionTimeoutMs: 15_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  ...overrides,
});

const runToTerminal = (scheduler: ReturnType<typeof resolveScheduler>, input: string) =>
  new Promise<ReturnType<typeof scheduler.get>>((resolve) => {
    const unsubscribe = scheduler.subscribe((event) => {
      if (event.snapshot.status !== "queued" && event.snapshot.status !== "running") {
        unsubscribe();
        resolve(event.snapshot);
      }
    });
    scheduler.submit({ input });
  });

describe("ByokDelegationService helpers", () => {
  it("splits the executor command without a shell", () => {
    expect(parseExecutorCommand("  node   --eval  code  ")).toEqual(["node", "--eval", "code"]);
    expect(parseExecutorCommand("")).toEqual([]);
    // A token containing ; stays one token — no shell parsing happens.
    expect(parseExecutorCommand("echo hi; rm -rf /")).toEqual(["echo", "hi;", "rm", "-rf", "/"]);
  });

  it("resolves only allowlisted environment names from the process env", () => {
    process.env.__BYOK_TEST_ALLOWED = "visible";
    process.env.__BYOK_TEST_HIDDEN = "secret-value";
    const env = buildChildEnv(["__BYOK_TEST_ALLOWED"]);
    expect(env["__BYOK_TEST_ALLOWED"]).toBe("visible");
    expect(Object.keys(env)).not.toContain("__BYOK_TEST_HIDDEN");
    delete process.env.__BYOK_TEST_ALLOWED;
    delete process.env.__BYOK_TEST_HIDDEN;
  });

  it("truncates previews with an ellipsis", () => {
    expect(preview("abcdef", 3)).toBe("abc…");
    expect(preview("abc", 3)).toBe("abc");
  });
});

describe("delegation scheduler runtime", () => {
  it("runs a real executor end-to-end and returns its output", async () => {
    const scheduler = resolveScheduler(
      config({
        executorCommand: `"${process.execPath}" -e process.stdout.write("delegated-ok")`,
      }),
      "instance-exec",
    );
    const terminal = await runToTerminal(scheduler, "task");

    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.result).toBe("delegated-ok");
  }, 20_000);

  it("passes the task to the executor via stdin", async () => {
    const scheduler = resolveScheduler(
      config({
        executorCommand: `"${process.execPath}" -e process.stdin.once("data",d=>process.stdout.write(d.toString().trim()))`,
      }),
      "instance-stdin",
    );
    const terminal = await runToTerminal(scheduler, "echo-this-task");

    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.result).toBe("echo-this-task");
  }, 20_000);

  it("surfaces executor failures with exit code and stderr", async () => {
    const scheduler = resolveScheduler(
      config({
        executorCommand: `"${process.execPath}" -e process.stderr.write("boom");process.exit(3)`,
      }),
      "instance-fail",
    );
    const terminal = await runToTerminal(scheduler, "task");

    expect(terminal?.status).toBe("failed");
    expect(terminal?.error?.message).toContain("code 3");
    expect(terminal?.error?.message).toContain("boom");
    // Snapshot carries only the task input — no environment material.
    expect(terminal?.request.input).toBe("task");
  }, 20_000);

  it("kills executors that exceed the execution timeout", async () => {
    const scheduler = resolveScheduler(
      config({
        executionTimeoutMs: 300,
        executorCommand: `"${process.execPath}" -e setTimeout(()=>{},60000)`,
      }),
      "instance-timeout",
    );
    const terminal = await runToTerminal(scheduler, "task");

    expect(terminal?.status).toBe("execution_timed_out");
  }, 20_000);
});
