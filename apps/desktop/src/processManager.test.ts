import { describe, expect, it } from "vitest";

import { ProcessManager } from "./processManager";

describe("ProcessManager", () => {
  it("can be instantiated", () => {
    const pm = new ProcessManager();
    expect(pm).toBeInstanceOf(ProcessManager);
  });

  it("spawns a process and receives output", async () => {
    const pm = new ProcessManager();
    const chunks: string[] = [];

    const done = new Promise<void>((resolve) => {
      pm.on("output", (chunk) => {
        chunks.push(chunk.data);
      });
      pm.on("exit", () => {
        resolve();
      });
    });

    const sessionId = pm.spawn({ command: "echo", args: ["hello"] });
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    await done;

    expect(chunks.join("").trim()).toBe("hello");
  });

  it("can kill a spawned process", async () => {
    const pm = new ProcessManager();

    const exited = new Promise<number | null>((resolve) => {
      pm.on("exit", (exit) => {
        resolve(exit.code);
      });
    });

    const sessionId = pm.spawn({ command: "sleep", args: ["10"] });
    pm.kill(sessionId);

    const code = await exited;
    expect(code).not.toBe(0);
  });
});
