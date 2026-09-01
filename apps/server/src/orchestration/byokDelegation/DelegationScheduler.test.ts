// @effect-diagnostics globalTimers:off - Tests exercise scheduler timeout behavior.
import { describe, expect, it } from "vite-plus/test";
import {
  DelegationQueueFullError,
  DelegationScheduler,
  type DelegationExecutionContext,
} from "./DelegationScheduler.ts";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const eventually = async (assertion: () => void) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await wait(2);
    }
  }
  assertion();
};

describe("DelegationScheduler", () => {
  it("enforces concurrency and a queue limit of maxConcurrency * 4", async () => {
    let running = 0;
    let peak = 0;
    const scheduler = new DelegationScheduler<{ value: number }, number>(
      {
        execute: async ({ input }) => {
          running += 1;
          peak = Math.max(peak, running);
          await wait(5);
          running -= 1;
          return input.value;
        },
      },
      { maxConcurrency: 2 },
    );

    const accepted = Array.from({ length: 10 }, (_, value) =>
      scheduler.submit({ input: { value } }),
    );
    expect(scheduler.queueLimit).toBe(8);
    expect(() => scheduler.submit({ input: { value: 10 } })).toThrow(DelegationQueueFullError);
    await eventually(() => expect(peak).toBe(2));

    await eventually(() =>
      expect(scheduler.list().filter((x) => x.status === "succeeded")).toHaveLength(10),
    );
    expect(accepted.map(({ id }) => scheduler.get(id)?.result)).toEqual(
      Array.from({ length: 10 }, (_, value) => value),
    );
    expect(peak).toBe(2);
  });

  it("applies queue and execution timeouts independently and aborts execution", async () => {
    const contexts: DelegationExecutionContext[] = [];
    let releaseFirst: (() => void) | undefined;
    const scheduler = new DelegationScheduler<string, string>(
      {
        execute: ({ input }, context) => {
          contexts.push(context);
          if (input === "first") {
            return new Promise((resolve) => {
              releaseFirst = () => resolve(input);
            });
          }
          return new Promise(() => undefined);
        },
      },
      { maxConcurrency: 1 },
    );

    const first = scheduler.submit({ input: "first" });
    const queued = scheduler.submit({ input: "queued", queueTimeoutMs: 5 });
    await eventually(() => expect(scheduler.get(queued.id)?.status).toBe("queue_timed_out"));
    expect(contexts).toHaveLength(1);

    releaseFirst?.();
    await eventually(() => expect(scheduler.get(first.id)?.status).toBe("succeeded"));
    const executing = scheduler.submit({ input: "executing", executionTimeoutMs: 5 });
    await eventually(() => expect(scheduler.get(executing.id)?.status).toBe("execution_timed_out"));
    expect(contexts[1]?.signal.aborted).toBe(true);
  });

  it("cancels queued and running work through AbortController", async () => {
    const signals = new Map<string, AbortSignal>();
    const scheduler = new DelegationScheduler<string, string>(
      {
        execute: ({ input }, { signal }) => {
          signals.set(input, signal);
          return new Promise(() => undefined);
        },
      },
      { maxConcurrency: 1 },
    );

    const running = scheduler.submit({ input: "running" });
    const queued = scheduler.submit({ input: "queued" });
    expect(scheduler.cancel(queued.id)).toBe(true);
    expect(scheduler.get(queued.id)?.status).toBe("cancelled");
    expect(signals.has("queued")).toBe(false);

    await eventually(() => expect(signals.has("running")).toBe(true));
    expect(scheduler.cancel(running.id)).toBe(true);
    expect(scheduler.get(running.id)?.status).toBe("cancelled");
    expect(signals.get("running")?.aborted).toBe(true);
    expect(scheduler.cancel(running.id)).toBe(false);
  });

  it("returns immutable cloned requests, results, snapshots, and events", async () => {
    const input = { nested: { value: 1 } };
    const events: unknown[] = [];
    const scheduler = new DelegationScheduler<typeof input, typeof input>(
      { execute: ({ input: requestInput }) => Promise.resolve(requestInput) },
      { maxConcurrency: 1 },
    );
    scheduler.subscribe((event) => events.push(event));

    const submitted = scheduler.submit({ input });
    input.nested.value = 99;
    await eventually(() => expect(scheduler.get(submitted.id)?.status).toBe("succeeded"));
    const snapshot = scheduler.get(submitted.id);

    expect(snapshot?.request.input.nested.value).toBe(1);
    expect(snapshot?.result?.nested.value).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.request.input.nested)).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(() => {
      (snapshot!.request.input.nested as { value: number }).value = 2;
    }).toThrow();
    expect(scheduler.get(submitted.id)?.request.input.nested.value).toBe(1);
  });

  it("uses monotonic snapshot sequence and event IDs", async () => {
    const eventIds: number[] = [];
    const sequences = new Map<string, number[]>();
    const scheduler = new DelegationScheduler<number, number>(
      { execute: ({ input }) => Promise.resolve(input) },
      { maxConcurrency: 1 },
    );
    scheduler.subscribe(({ id, snapshot }) => {
      eventIds.push(id);
      const values = sequences.get(snapshot.id) ?? [];
      values.push(snapshot.sequence);
      sequences.set(snapshot.id, values);
    });

    const first = scheduler.submit({ input: 1 });
    const second = scheduler.submit({ input: 2 });
    await eventually(() => expect(scheduler.get(second.id)?.status).toBe("succeeded"));

    expect(eventIds).toEqual(eventIds.map((_, index) => index + 1));
    expect(sequences.get(first.id)).toEqual([1, 2, 3]);
    expect(sequences.get(second.id)).toEqual([1, 2, 3]);
  });

  it("sanitizes errors and invokes terminal retention hooks", async () => {
    const terminal: string[] = [];
    const error = Object.assign(new Error("bad\nsecret"), {
      code: "E_BAD\tCODE",
      stack: "must not leak",
      extra: "must not leak",
    });
    const scheduler = new DelegationScheduler<string, never>(
      { execute: () => Promise.reject(error) },
      {
        maxConcurrency: 1,
        retention: {
          onTerminal: (snapshot) => {
            terminal.push(snapshot.id);
          },
          shouldRetain: () => false,
        },
      },
    );

    const submitted = scheduler.submit({ input: "fail" });
    await eventually(() => expect(terminal).toEqual([submitted.id]));
    expect(scheduler.get(submitted.id)).toBeUndefined();

    const retained = new DelegationScheduler<string, never>(
      { execute: () => Promise.reject(error) },
      { maxConcurrency: 1 },
    );
    const failed = retained.submit({ input: "fail" });
    await eventually(() => expect(retained.get(failed.id)?.status).toBe("failed"));
    expect(retained.get(failed.id)?.error).toEqual({
      name: "Error",
      message: "bad secret",
      code: "E_BAD CODE",
    });
  });
});
