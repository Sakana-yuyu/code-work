import type {
  CodeworkProjectFile,
  ModelSelection,
  ProjectId,
  ProjectScopedServerSettingKey,
  ProjectSettingsOverrides,
  RuntimeMode,
  ServerSettings,
  ThreadEnvMode,
  WorktreeSubmodules,
} from "@codework/contracts";

/**
 * Where a project-scoped value came from. The order is the priority order:
 * a project override (`projectSettingsOverrides`, or the project record's own
 * `defaultModelSelection`/`defaultThreadEnvMode` fields which predate the
 * map), then the repository's `t3.json` for keys in
 * `PROJECT_FILE_BACKED_SETTINGS`, then the environment value, then the
 * built-in default (reported as "environment", since that is what the
 * environment value is when nothing set it).
 */
export type ProjectSettingSource = "project" | "t3.json" | "environment";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

/** Concrete values after the project, file, environment, and built-in tiers fold. */
export interface ResolvedProjectSettings {
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly defaultThreadEnvMode: ThreadEnvMode;
  readonly worktreeSubmodules: WorktreeSubmodules;
}

export interface ResolvedProjectSettingsResult {
  readonly values: ResolvedProjectSettings;
  readonly sources: ProjectSettingSources;
  /** The project's merged override entry; `{}` when it has none. */
  readonly overrides: ProjectSettingsOverrides;
}

/**
 * Settings a repository can also declare in `t3.json`. Listing a key here is
 * the whole change for a new file-backed setting: the file fills keys whose
 * project tier is unset, ahead of the environment value and the built-in
 * default.
 */
export const PROJECT_FILE_BACKED_SETTINGS = {
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "local" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  readonly [K in ProjectScopedServerSettingKey]?: {
    readonly field: keyof CodeworkProjectFile;
    readonly builtIn: ResolvedProjectSettings[K];
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

/**
 * The project record's own fields, kept as project-tier inputs at a lower
 * priority than `projectSettingsOverrides` — the map entry wins when both
 * are present.
 */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

/** Cheap check so hot paths skip the projectId lookup when nothing is overridden. */
export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    // A forward-compatible decode can leave an unknown value as a present
    // undefined; that is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
  }
  return false;
}

/** The two settings-backed tiers a file-backed key resolves against. */
export interface ProjectFileSettingTiers<K extends ProjectFileBackedSettingKey> {
  readonly project: ResolvedProjectSettings[K] | null;
  readonly environment: ResolvedProjectSettings[K] | null;
}

/**
 * The file and built-in tiers for one key, given the project and environment
 * values (`null` when unset). For callers that hold the settings tiers but
 * only see the file later — the git driver reads the `t3.json` of the
 * worktree it just created. Same chain as `resolveProjectSettings`:
 * project, then `t3.json`, then environment, then the built-in default.
 */
export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  tiers: ProjectFileSettingTiers<K>,
  projectFile: CodeworkProjectFile | null,
): { value: ResolvedProjectSettings[K]; source: ProjectSettingSource } {
  if (tiers.project !== null) {
    return { value: tiers.project, source: "project" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedProjectSettings[K] | undefined;
  if (fromFile !== undefined) {
    return { value: fromFile, source: "t3.json" };
  }
  return tiers.environment !== null
    ? { value: tiers.environment, source: "environment" }
    : { value: builtIn as ResolvedProjectSettings[K], source: "environment" };
}

/**
 * Resolved `defaultModelSelection` for one project. An overrides-map entry
 * wins over the project record field, and a stored `null` is a real value —
 * it means "no project default model", not "fall back to the record".
 */
export function resolveProjectModelSelection(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId | null,
  project?: Pick<LegacyProjectSettingsFields, "defaultModelSelection"> | null,
): ModelSelection | null {
  const entry = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  if (entry?.defaultModelSelection !== undefined) return entry.defaultModelSelection;
  return project?.defaultModelSelection ?? null;
}

/**
 * Resolved `defaultRuntimeMode` for one project: overrides map, then the
 * environment value (non-null, decoding-defaulted).
 */
export function resolveProjectRuntimeMode(
  settings: Pick<ServerSettings, "projectSettingsOverrides" | "defaultRuntimeMode">,
  projectId: ProjectId | null,
): RuntimeMode {
  const entry = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  return entry?.defaultRuntimeMode ?? settings.defaultRuntimeMode;
}

/**
 * Set or remove one key on a project overrides entry. `null` removes the key;
 * the caller decides whether an all-empty entry becomes a `null` patch value
 * (delete) via `hasAnyOverrideValue`.
 */
export function withProjectSettingsOverride(
  entry: ProjectSettingsOverrides,
  key: "defaultRuntimeMode" | "worktreeSubmodules",
  value: RuntimeMode | WorktreeSubmodules | null,
): ProjectSettingsOverrides {
  const next = { ...entry };
  if (value === null) {
    delete next[key];
    return next;
  }
  return key === "defaultRuntimeMode"
    ? { ...next, defaultRuntimeMode: value as RuntimeMode }
    : { ...next, worktreeSubmodules: value as WorktreeSubmodules };
}

/** Whether an overrides entry carries at least one set key. */
export function hasAnyProjectSettingsOverride(entry: ProjectSettingsOverrides): boolean {
  return Object.values(entry).some((value) => value !== undefined);
}

/**
 * Resolve the project-scoped settings for one project. `project` carries the
 * record's legacy fields; `projectFile` is the decoded `t3.json` (or null for
 * a missing or invalid one).
 */
export function resolveProjectSettings(
  settings: Pick<
    ServerSettings,
    | "defaultRuntimeMode"
    | "defaultThreadEnvMode"
    | "worktreeSubmodules"
    | "projectSettingsOverrides"
  >,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: CodeworkProjectFile | null,
): ResolvedProjectSettingsResult {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides = {
    // Record fields fold in only when set: a null there is "no override",
    // while a null inside `projectSettingsOverrides` is a real value.
    ...(project?.defaultModelSelection != null
      ? { defaultModelSelection: project.defaultModelSelection }
      : {}),
    ...(project?.defaultThreadEnvMode != null
      ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
      : {}),
    ...(stored ?? EMPTY_OVERRIDES),
  };

  const threadEnvMode = resolveProjectFileBackedSetting(
    "defaultThreadEnvMode",
    {
      project: overrides.defaultThreadEnvMode ?? null,
      environment: settings.defaultThreadEnvMode,
    },
    projectFile ?? null,
  );
  const submodules = resolveProjectFileBackedSetting(
    "worktreeSubmodules",
    {
      project: overrides.worktreeSubmodules ?? null,
      environment: settings.worktreeSubmodules,
    },
    projectFile ?? null,
  );

  return {
    values: {
      defaultModelSelection: overrides.defaultModelSelection ?? null,
      defaultRuntimeMode: overrides.defaultRuntimeMode ?? settings.defaultRuntimeMode,
      defaultThreadEnvMode: threadEnvMode.value,
      worktreeSubmodules: submodules.value,
    },
    sources: {
      defaultModelSelection:
        overrides.defaultModelSelection !== undefined ? "project" : "environment",
      defaultRuntimeMode: overrides.defaultRuntimeMode !== undefined ? "project" : "environment",
      defaultThreadEnvMode: threadEnvMode.source,
      worktreeSubmodules: submodules.source,
    },
    overrides,
  };
}
