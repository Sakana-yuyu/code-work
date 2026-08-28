import type { CompositionSquad } from "@codework/contracts";
import { createEmptyCompositionSquadDraft } from "@codework/client-runtime/composition/squad-builder";
import { describe, expect, it } from "vite-plus/test";

import {
  addSquadBuilderMember,
  buildSquadBuilderDuplicateRequest,
  buildSquadBuilderRevisionMutationRequest,
  buildSquadBuilderUpdateRequest,
  patchSquadBuilderMember,
  removeSquadBuilderMember,
  resolveSquadBuilderMembers,
  squadCollaborationModeLabelKey,
  squadMemberRoleLabelKey,
  sortSquadBuilderSquads,
  summarizeSquadBuilderConfiguration,
  toggleSquadBuilderApprovalStage,
} from "./SettingsSquadBuilderRouteScreen.logic";

const squad = (overrides: Partial<CompositionSquad>): CompositionSquad => ({
  squadId: "squad-a",
  name: "Alpha",
  leaderAgentId: "agent-lead",
  memberAgentIds: ["agent-lead"],
  ...overrides,
});

describe("sortSquadBuilderSquads", () => {
  it("keeps archived squads visible after active squads and sorts each group newest first", () => {
    expect(
      sortSquadBuilderSquads([
        squad({ squadId: "archived-new", archivedAtUnixMs: 40, updatedAtUnixMs: 40 }),
        squad({ squadId: "active-old", updatedAtUnixMs: 10 }),
        squad({ squadId: "active-new", updatedAtUnixMs: 20 }),
        squad({ squadId: "archived-old", archivedAtUnixMs: 30, updatedAtUnixMs: 30 }),
      ]).map((item) => item.squadId),
    ).toEqual(["active-new", "active-old", "archived-new", "archived-old"]);
  });
});

describe("resolveSquadBuilderMembers", () => {
  it("uses rich members in their configured order", () => {
    const members = resolveSquadBuilderMembers(
      squad({
        memberAgentIds: ["agent-worker", "agent-lead"],
        members: [
          {
            agentId: "agent-worker",
            role: "worker",
            order: 2,
            required: false,
            model: "worker-model",
            capabilityIds: ["read"],
            maxConcurrentTasks: 2,
          },
          {
            agentId: "agent-lead",
            role: "leader",
            order: 0,
            required: true,
            capabilityIds: ["read", "write"],
            maxConcurrentTasks: 1,
          },
        ],
      }),
    );

    expect(members.map((member) => member.agentId)).toEqual(["agent-lead", "agent-worker"]);
  });

  it("materializes legacy member ids without hiding the leader", () => {
    expect(
      resolveSquadBuilderMembers(squad({ memberAgentIds: ["agent-worker", "agent-lead"] })).map(
        (member) => ({ agentId: member.agentId, role: member.role }),
      ),
    ).toEqual([
      { agentId: "agent-worker", role: "worker" },
      { agentId: "agent-lead", role: "leader" },
    ]);
  });
});

describe("summarizeSquadBuilderConfiguration", () => {
  it("applies explicit defaults for legacy optional fields", () => {
    expect(summarizeSquadBuilderConfiguration(squad({ revision: undefined }))).toEqual({
      archived: false,
      collaborationMode: "serial",
      maxConcurrency: 1,
      maxRetries: 0,
      memberCount: 1,
      revision: 1,
    });
  });
});

describe("Squad Builder label keys", () => {
  it("maps every collaboration mode and member role to stable i18n keys", () => {
    expect(
      ["serial", "parallel", "dependency_graph", "review_critic", "leader_workers"].map((mode) =>
        squadCollaborationModeLabelKey(mode),
      ),
    ).toEqual([
      "squadBuilder.mode.serial",
      "squadBuilder.mode.parallel",
      "squadBuilder.mode.dependencyGraph",
      "squadBuilder.mode.reviewCritic",
      "squadBuilder.mode.leaderWorkers",
    ]);
    expect(["leader", "worker", "reviewer", "critic"].map(squadMemberRoleLabelKey)).toEqual([
      "squadBuilder.role.leader",
      "squadBuilder.role.worker",
      "squadBuilder.role.reviewer",
      "squadBuilder.role.critic",
    ]);
  });

  it("returns null for unknown values so callers can preserve forward compatibility", () => {
    expect(squadCollaborationModeLabelKey("future-mode")).toBe(null);
    expect(squadMemberRoleLabelKey("future-role")).toBe(null);
  });
});

describe("Squad Builder draft mutations", () => {
  it("adds and patches a worker without mutating the source draft", () => {
    const source = createEmptyCompositionSquadDraft();
    const withWorker = addSquadBuilderMember(source, "member-worker");
    const patched = patchSquadBuilderMember(withWorker, 1, {
      agentId: "agent-worker",
      role: "reviewer",
      capabilityIdsText: "fs.read",
    });

    expect(source.members).toHaveLength(1);
    expect(patched.members[1]).toMatchObject({
      clientId: "member-worker",
      agentId: "agent-worker",
      role: "reviewer",
      capabilityIdsText: "fs.read",
      required: true,
      maxConcurrentTasksText: "1",
    });
  });

  it("removes only the selected member and ignores an invalid index", () => {
    const source = addSquadBuilderMember(createEmptyCompositionSquadDraft(), "member-worker");

    expect(removeSquadBuilderMember(source, 1).members).toHaveLength(1);
    expect(removeSquadBuilderMember(source, 99)).toBe(source);
  });

  it("toggles approval stages without creating duplicates", () => {
    const source = createEmptyCompositionSquadDraft();
    const enabled = toggleSquadBuilderApprovalStage(source, "before_finalize", true);
    const enabledAgain = toggleSquadBuilderApprovalStage(enabled, "before_finalize", true);
    const disabled = toggleSquadBuilderApprovalStage(enabledAgain, "before_finalize", false);

    expect(enabled.approvalStages).toEqual(["before_finalize"]);
    expect(enabledAgain).toBe(enabled);
    expect(disabled.approvalStages).toEqual([]);
  });
});

describe("buildSquadBuilderUpdateRequest", () => {
  it("pins the expected revision after applying the shared create validation", () => {
    const draft = createEmptyCompositionSquadDraft();
    draft.squadId = "squad-edit";
    draft.name = "Edit Squad";
    draft.members[0] = { ...draft.members[0]!, agentId: "agent-lead" };

    const result = buildSquadBuilderUpdateRequest(draft, 7);

    expect(result.issues).toEqual([]);
    expect(result.request).toMatchObject({
      squadId: "squad-edit",
      expectedRevision: 7,
      leaderAgentId: "agent-lead",
    });
  });

  it("keeps validation failures and never emits a partial update request", () => {
    const result = buildSquadBuilderUpdateRequest(createEmptyCompositionSquadDraft(), 2);

    expect(result.request).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "required", path: "squadId" }),
        expect.objectContaining({ code: "required", path: "name" }),
      ]),
    );
  });
});

describe("Squad Builder lifecycle requests", () => {
  it("builds a deterministic duplicate request from the selected squad", () => {
    expect(
      buildSquadBuilderDuplicateRequest(
        squad({ squadId: "squad-source", name: "Source" }),
        "copy-1234",
        "Source copy",
      ),
    ).toEqual({
      sourceSquadId: "squad-source",
      squadId: "squad-source-copy-1234",
      name: "Source copy",
    });
  });

  it("pins archive and restore mutations to the current revision", () => {
    expect(buildSquadBuilderRevisionMutationRequest(squad({ revision: 9 }))).toEqual({
      squadId: "squad-a",
      expectedRevision: 9,
    });
    expect(buildSquadBuilderRevisionMutationRequest(squad({ revision: undefined }))).toEqual({
      squadId: "squad-a",
      expectedRevision: 1,
    });
  });
});
