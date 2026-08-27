import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@codework/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  linkPrimaryEnvironmentToCloud,
  type CloudLinkMode,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
  updatePrimaryCloudPreferences,
} from "./linkEnvironment";
import { t } from "~/i18n/runtime";

const cloudLinkScheduler = createAtomCommandScheduler();
const cloudLinkConcurrency = {
  mode: "serial" as const,
  key: (input: { readonly target: CloudLinkTarget }) => input.target.environmentId,
};

export const linkPrimaryEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  get label() {
    return t("webCloudLinkPrimaryEnvironment");
  },
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: {
    readonly target: CloudLinkTarget;
    readonly clerkToken: string;
    readonly mode?: CloudLinkMode;
  }) => linkPrimaryEnvironmentToCloud(input),
});

export const unlinkPrimaryEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  get label() {
    return t("webCloudUnlinkPrimaryEnvironment");
  },
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly clerkToken: string | null }) =>
    unlinkPrimaryEnvironmentFromCloud(input),
});

export const updatePrimaryEnvironmentPreferences = createRuntimeCommand(connectionAtomRuntime, {
  get label() {
    return t("webCloudUpdatePrimaryEnvironmentPreferences");
  },
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly publishAgentActivity: boolean }) =>
    updatePrimaryCloudPreferences(input),
});
