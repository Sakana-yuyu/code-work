import type { EnvironmentId } from "@codework/contracts";
import { useEffect, useMemo } from "react";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: (contents) => writeFile({ environmentId, input: { cwd, relativePath, contents } }),
        onConfirmed: (contents) => {
          confirmProjectFileQueryData(environmentId, cwd, relativePath, contents);
        },
      }),
    [cwd, environmentId, onPendingChange, relativePath, writeFile],
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}
