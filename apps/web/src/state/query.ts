import { createEnvironmentQueryState } from "@codework/client-runtime/state/environment-query";

import { t } from "~/i18n/runtime";

const state = createEnvironmentQueryState({
  labelPrefix: "web",
  requestFailedKey: "environment.requestFailed",
  t,
});

export const formatEnvironmentQueryError = state.formatEnvironmentQueryError;
export const useEnvironmentQuery = state.useEnvironmentQuery;
export type { EnvironmentQueryView } from "@codework/client-runtime/state/environment-query";
