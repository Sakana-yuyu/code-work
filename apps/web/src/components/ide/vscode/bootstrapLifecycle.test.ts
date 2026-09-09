import { describe, expect, it, vi } from "vite-plus/test";
import { registerAndWaitForExtension, runInBackground } from "./bootstrapLifecycle";

describe("IDE bootstrap background tasks", () => {
  it("扩展入队后继续等待注册事件，失败时释放监听", async () => {
    let added: (event: { added: { identifier: { value: string } }[] }) => void = () => {};
    const dispose = vi.fn();
    const service = {
      extensions: [],
      onDidChangeExtensions: vi.fn((listener) => {
        added = listener;
        return { dispose };
      }),
    };
    let finished = false;
    const ready = registerAndWaitForExtension(
      service,
      "codework.app-color-themes",
      async () => {},
    ).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    added({ added: [{ identifier: { value: "unrelated" } }] });
    await Promise.resolve();
    expect(finished).toBe(false);
    added({ added: [{ identifier: { value: "codework.app-color-themes" } }] });
    await ready;
    expect(finished).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      registerAndWaitForExtension(service, "failed", async () => {
        throw new Error("注册失败");
      }),
    ).rejects.toThrow("注册失败");
    expect(dispose).toHaveBeenCalledTimes(2);
  });
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
