import { createEnvironmentQueryState } from "@codework/client-runtime/state/environment-query";

import { t } from "../i18n/runtime";

const state = createEnvironmentQueryState({
  labelPrefix: "mobile",
  requestFailedKey: "errors.environmentRequestFailed",
  t,
});

export const useEnvironmentQuery = state.useEnvironmentQuery;
export type { EnvironmentQueryView } from "@codework/client-runtime/state/environment-query";
