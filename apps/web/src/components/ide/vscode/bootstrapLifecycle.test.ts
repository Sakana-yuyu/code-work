import { describe, expect, it, vi } from "vite-plus/test";
import { desktopResourceScheme, runInBackground } from "./bootstrapLifecycle";

describe("IDE resource protocol", () => {
  it("supports canonical and legacy schemes across all desktop channels", () => {
    expect(desktopResourceScheme("codework:")).toBe("codework");
    expect(desktopResourceScheme("codework-dev:")).toBe("codework-dev");
    expect(desktopResourceScheme("codework-preview:")).toBe("codework-preview");
    expect(desktopResourceScheme("t3code:")).toBe("t3code");
    expect(desktopResourceScheme("t3code-dev:")).toBe("t3code-dev");
    expect(desktopResourceScheme("t3code-preview:")).toBe("t3code-preview");
    expect(desktopResourceScheme("https:")).toBeUndefined();
  });
});

describe("IDE bootstrap background tasks", () => {
  it("does not wait for a background task to finish", async () => {
    let resolve!: () => void;
    const task = new Promise<void>((done) => {
      resolve = done;
    });

    expect(runInBackground(() => task, vi.fn())).toBeUndefined();

    resolve();
    await task;
  });

  it("forwards background task failures", async () => {
    const error = new Error("theme sync failed");
    const onError = vi.fn();

    runInBackground(async () => {
      throw error;
    }, onError);
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
