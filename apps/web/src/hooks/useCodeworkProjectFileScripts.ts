import {
  CODEWORK_PROJECT_FILE_NAME,
  type EnvironmentId,
  type CodeworkProjectFile,
  type CodeworkProjectFileScript,
} from "@codework/contracts";
import { parseCodeworkProjectFile } from "@codework/shared/codeworkProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<CodeworkProjectFileScript> = [];

export interface CodeworkProjectFileState {
  /**
   * - `valid`: t3.json exists and decoded.
   * - `invalid`: t3.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t3.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: CodeworkProjectFile | null;
  scripts: ReadonlyArray<CodeworkProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `t3.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useCodeworkProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): CodeworkProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    CODEWORK_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseCodeworkProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useCodeworkProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<CodeworkProjectFileScript> {
  return useCodeworkProjectFileState(environmentId, cwd).scripts;
}
