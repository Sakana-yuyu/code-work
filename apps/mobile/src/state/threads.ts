import { createEnvironmentThreadView } from "@codework/client-runtime/state/environment-thread-view";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const view = createEnvironmentThreadView({
  runtime: connectionAtomRuntime,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  labelPrefix: "mobile",
});

export const threadEnvironment = view.threadEnvironment;
export const environmentThreads = view.environmentThreads;
export const environmentThreadDetails = view.environmentThreadDetails;
export const environmentThreadShells = view.environmentThreadShells;
export const useEnvironmentThread = view.useEnvironmentThread;
