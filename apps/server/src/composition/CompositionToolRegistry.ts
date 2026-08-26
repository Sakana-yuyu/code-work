import type { CompositionCapabilityDescriptor } from "@t3tools/contracts";

const descriptors = [
  {
    capabilityId: "t3.workspace.read_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.workspace.write_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: false, mutate: true },
    approval: "every_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.open",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.write",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.git.status",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.git.diff",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_status",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_open",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_navigate",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_snapshot",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.ide.invoke",
    kind: "tool",
    version: "1",
    status: "degraded",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
] satisfies ReadonlyArray<CompositionCapabilityDescriptor>;

export const listCompositionToolDescriptors = (): CompositionCapabilityDescriptor[] =>
  descriptors.map((descriptor) => ({
    ...descriptor,
    grants: { ...descriptor.grants },
  }));

export const compositionToolCapabilityId = (canonicalToolName: string): string =>
  `t3.${canonicalToolName}`;
