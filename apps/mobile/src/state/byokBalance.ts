import { createByokBalanceState } from "@codework/client-runtime/state/byok-balance";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { byokEnvironment, serverEnvironment } from "./server";

const state = createByokBalanceState({
  registry: appAtomRegistry,
  environmentPresentations,
  serverEnvironment,
  byokEnvironment,
  labelPrefix: "mobile",
});

export const useByokBalanceDashboards = state.useByokBalanceDashboards;
export type {
  ByokBalanceQueryTarget,
  ByokBalanceView,
  EnvironmentByokBalanceStatus,
} from "@codework/client-runtime/state/byok-balance";
