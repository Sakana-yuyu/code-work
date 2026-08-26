import { assert, it } from "@effect/vitest";

import { listCompositionToolDescriptors } from "./CompositionToolRegistry.ts";

it("为统一 Runtime Tool Plane 暴露稳定且无重复的 canonical capability 描述符", () => {
  const descriptors = listCompositionToolDescriptors();

  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.capabilityId),
    [
      "t3.workspace.read_file",
      "t3.workspace.write_file",
      "t3.terminal.open",
      "t3.terminal.write",
      "t3.git.status",
      "t3.git.diff",
      "t3.preview_status",
      "t3.preview_open",
      "t3.preview_navigate",
      "t3.preview_snapshot",
    ],
  );
  assert.equal(
    new Set(descriptors.map((descriptor) => descriptor.capabilityId)).size,
    descriptors.length,
  );
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.capabilityId === "t3.terminal.write"),
    {
      capabilityId: "t3.terminal.write",
      kind: "tool",
      version: "1",
      status: "available",
      grants: { read: false, execute: true, mutate: false },
      approval: "on_first_use",
      source: "t3",
    },
  );
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.capabilityId === "t3.preview_snapshot"),
    {
      capabilityId: "t3.preview_snapshot",
      kind: "tool",
      version: "1",
      status: "available",
      grants: { read: true, execute: false, mutate: false },
      approval: "never",
      source: "t3",
    },
  );
});
