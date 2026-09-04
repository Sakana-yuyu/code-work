import * as Schema from "effect/Schema";
import { canonicalStorageKey } from "../persistenceStorage";

/**
 * Accounts that opted out of the post-sign-in Code Work Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const LEGACY_CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY =
  "codework:connect-onboarding-opt-out:v1";
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = canonicalStorageKey(
  LEGACY_CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
);

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};
