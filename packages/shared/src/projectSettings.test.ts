import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type CodeworkProjectFile,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  hasProjectSettingsOverrides,
  resolveProjectFileBackedSetting,
  resolveProjectModelSelection,
  resolveProjectRuntimeMode,
  resolveProjectSettings,
} from "./projectSettings.ts";

const projectId = ProjectId.make("project-1");
const modelSelection = createModelSelection(ProviderInstanceId.make("instance-1"), "model-1");

const withOverrides = (
  overrides: ServerSettings["projectSettingsOverrides"],
  rest: Partial<ServerSettings> = {},
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...rest,
  projectSettingsOverrides: overrides,
});

describe("resolveProjectSettings", () => {
  it("returns environment values when the project has no overrides", () => {
    const settings = withOverrides(
      {},
      {
        defaultRuntimeMode: "auto-accept-edits",
        worktreeSubmodules: "top-level",
      },
    );
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.values.defaultRuntimeMode).toBe("auto-accept-edits");
    expect(resolved.values.worktreeSubmodules).toBe("top-level");
    expect(resolved.values.defaultThreadEnvMode).toBe("local");
    expect(resolved.values.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(resolved.sources.worktreeSubmodules).toBe("environment");
  });

  it("lets the project override beat the environment value", () => {
    const settings = withOverrides(
      {
        [projectId]: { defaultRuntimeMode: "full-access", worktreeSubmodules: "none" },
      },
      { defaultRuntimeMode: "approval-required", worktreeSubmodules: "recursive" },
    );
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.values.defaultRuntimeMode).toBe("full-access");
    expect(resolved.values.worktreeSubmodules).toBe("none");
    expect(resolved.sources.defaultRuntimeMode).toBe("project");
    expect(resolved.sources.worktreeSubmodules).toBe("project");
  });

  it("reads file-backed keys from t3.json between the project and environment tiers", () => {
    const settings = withOverrides({}, { worktreeSubmodules: "top-level" });
    const projectFile = {
      worktreeSubmodules: "none",
      defaultThreadEnvMode: "worktree",
    } as CodeworkProjectFile;
    const resolved = resolveProjectSettings(settings, projectId, null, projectFile);
    expect(resolved.values.worktreeSubmodules).toBe("none");
    expect(resolved.values.defaultThreadEnvMode).toBe("worktree");
    expect(resolved.sources.worktreeSubmodules).toBe("t3.json");
    expect(resolved.sources.defaultThreadEnvMode).toBe("t3.json");
  });

  it("lets the project override beat t3.json", () => {
    const settings = withOverrides({
      [projectId]: { worktreeSubmodules: "top-level" },
    });
    const projectFile = { worktreeSubmodules: "none" } as CodeworkProjectFile;
    const resolved = resolveProjectSettings(settings, projectId, null, projectFile);
    expect(resolved.values.worktreeSubmodules).toBe("top-level");
    expect(resolved.sources.worktreeSubmodules).toBe("project");
  });

  it("folds legacy project record fields below the overrides map", () => {
    const settings = withOverrides({
      [projectId]: { defaultThreadEnvMode: "local" },
    });
    const project = {
      defaultModelSelection: modelSelection,
      defaultThreadEnvMode: "worktree" as const,
    };
    const resolved = resolveProjectSettings(settings, projectId, project);
    // Map entry wins over the record field.
    expect(resolved.values.defaultThreadEnvMode).toBe("local");
    // Unmapped keys still read the record field.
    expect(resolved.values.defaultModelSelection).toEqual(modelSelection);
    expect(resolved.sources.defaultModelSelection).toBe("project");
  });

  it("treats a stored null model selection as a real override, not inherit", () => {
    const settings = withOverrides({ [projectId]: { defaultModelSelection: null } });
    const project = { defaultModelSelection: modelSelection };
    const resolved = resolveProjectSettings(settings, projectId, project);
    expect(resolved.values.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("project");
  });
});

describe("resolveProjectFileBackedSetting", () => {
  it("falls through to the built-in default when no tier is set", () => {
    const resolved = resolveProjectFileBackedSetting(
      "worktreeSubmodules",
      { project: null, environment: null },
      null,
    );
    expect(resolved).toEqual({ value: "recursive", source: "environment" });
  });

  it("prefers the project tier over the file and environment", () => {
    const resolved = resolveProjectFileBackedSetting(
      "defaultThreadEnvMode",
      { project: "worktree", environment: "local" },
      { defaultThreadEnvMode: "local" } as CodeworkProjectFile,
    );
    expect(resolved).toEqual({ value: "worktree", source: "project" });
  });
});

describe("resolveProjectRuntimeMode", () => {
  it("reads the overrides map, then the environment default", () => {
    const settings = withOverrides(
      { [projectId]: { defaultRuntimeMode: "auto" } },
      { defaultRuntimeMode: "approval-required" },
    );
    expect(resolveProjectRuntimeMode(settings, projectId)).toBe("auto");
    expect(resolveProjectRuntimeMode(settings, ProjectId.make("other"))).toBe("approval-required");
    expect(resolveProjectRuntimeMode(settings, null)).toBe("approval-required");
  });
});

describe("resolveProjectModelSelection", () => {
  it("reads the overrides map, then the project record field", () => {
    const settings = withOverrides({});
    expect(resolveProjectModelSelection(settings, projectId, null)).toBeNull();
    expect(
      resolveProjectModelSelection(settings, projectId, {
        defaultModelSelection: modelSelection,
      }),
    ).toEqual(modelSelection);
  });
});

describe("hasProjectSettingsOverrides", () => {
  it("is false for an empty map and true once a key is set", () => {
    expect(hasProjectSettingsOverrides(withOverrides({}))).toBe(false);
    expect(
      hasProjectSettingsOverrides(withOverrides({ [projectId]: { worktreeSubmodules: "none" } })),
    ).toBe(true);
    // A forward-compatible decode can leave unknown values as present
    // undefined — that is not an override.
    expect(
      hasProjectSettingsOverrides(
        withOverrides({
          [projectId]: {
            worktreeSubmodules: undefined,
          } as unknown as ProjectSettingsOverrides,
        }),
      ),
    ).toBe(false);
  });
});
