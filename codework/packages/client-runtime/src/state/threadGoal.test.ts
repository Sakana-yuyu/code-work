import { EnvironmentId, ThreadId } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentThreadGoalAtoms } from "./threadGoal.ts";

describe("Thread Goal environment atoms", () => {
  it("exposes isolated get/events and lifecycle commands per thread", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const atoms = createEnvironmentThreadGoalAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");

    expect(Object.keys(atoms)).toEqual(["get", "events", "set", "pause", "resume", "clear"]);
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
