import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ByokAdaptersImportRequest,
  ByokDelegationSnapshot,
  ByokDelegationSubmitRequest,
} from "./byokDelegation.ts";

const decodeSubmit = Schema.decodeUnknownSync(ByokDelegationSubmitRequest);
const decodeSnapshot = Schema.decodeUnknownSync(ByokDelegationSnapshot);
const decodeImport = Schema.decodeUnknownSync(ByokAdaptersImportRequest);

describe("ByokDelegation contracts", () => {
  it("decodes a submit request and trims the task", () => {
    const decoded = decodeSubmit({ instanceId: "instance-1", task: "  do something  " });
    expect(decoded.task).toBe("do something");
  });

  it("rejects an empty task", () => {
    expect(() => decodeSubmit({ instanceId: "instance-1", task: "   " })).toThrow();
  });

  it("decodes snapshots across every status", () => {
    for (const status of [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "queue_timed_out",
      "execution_timed_out",
    ] as const) {
      expect(
        decodeSnapshot({
          id: "delegation-1",
          status,
          taskPreview: "task",
          submittedAt: 1,
        }).status,
      ).toBe(status);
    }
    expect(() =>
      decodeSnapshot({ id: "d", status: "exploded", taskPreview: "t", submittedAt: 1 }),
    ).toThrow();
  });

  it("decodes an import request", () => {
    expect(decodeImport({ instanceId: "instance-1", yaml: "modelAdapters: []" }).instanceId).toBe(
      "instance-1",
    );
    expect(() => decodeImport({ instanceId: "instance-1", yaml: "" })).toThrow();
  });
});
