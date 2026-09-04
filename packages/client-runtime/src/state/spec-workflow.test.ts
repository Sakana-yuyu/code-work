import { EnvironmentId, ThreadId } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentSpecWorkflowAtoms } from "./spec-workflow.ts";

describe("Spec Workflow environment atoms", () => {
  it("exposes capability get/events/set per thread", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const atoms = createEnvironmentSpecWorkflowAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");

    expect(Object.keys(atoms)).toEqual([
      "get",
      "events",
      "state",
      "stateEvents",
      "set",
      "reviewProposal",
      "completeAcceptance",
      "pause",
      "resume",
    ]);
    expect(atoms.get({ environmentId, input: { threadId: ThreadId.make("thread-1") } })).toBe(
      atoms.get({ environmentId, input: { threadId: ThreadId.make("thread-1") } }),
    );
    expect(atoms.get({ environmentId, input: { threadId: ThreadId.make("thread-1") } })).not.toBe(
      atoms.get({ environmentId, input: { threadId: ThreadId.make("thread-2") } }),
    );
    expect(
      atoms.events({ environmentId, input: { threadId: ThreadId.make("thread-1") } }),
    ).not.toBe(atoms.events({ environmentId, input: { threadId: ThreadId.make("thread-2") } }));
  });
});
