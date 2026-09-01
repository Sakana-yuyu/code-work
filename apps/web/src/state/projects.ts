import { createEnvironmentProjectAtoms } from "@codework/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@codework/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@codework/client-runtime/state/runtime";
import { WS_METHODS } from "@codework/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { t } from "~/i18n/runtime";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
/**
 * Web-only: project content search backs the ⇧⌘F dialog, which has no mobile
 * surface, so the atom family lives here instead of the shared client-runtime
 * project atoms consumed by the mobile app.
 */
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  get label() {
    return t("environmentDataProjectsSearchContents");
  },
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
