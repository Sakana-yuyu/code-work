import { ConnectionOnboarding } from "@codework/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@codework/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@codework/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";
import { t } from "~/i18n/runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  get label() {
    return t("webConnectionConnectPairing");
  },
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { pairingUrl?: string; host?: string; pairingCode?: string }) =>
      JSON.stringify(input),
  },
  execute: (input: {
    readonly pairingUrl?: string;
    readonly host?: string;
    readonly pairingCode?: string;
  }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerPairing(input))),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  get label() {
    return t("webConnectionConnectSsh");
  },
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: { readonly target: DesktopSshEnvironmentTarget; readonly label?: string }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerSsh(input))),
});
