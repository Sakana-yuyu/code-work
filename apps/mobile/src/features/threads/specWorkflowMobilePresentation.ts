import type { EnvironmentConnectionPhase } from "@codework/client-runtime/connection";
import type { ConnectionTargetKind } from "@codework/client-runtime/connection";

export type SpecWorkflowMobileTransport = "local" | "remote" | "relay" | "ssh";

export function specWorkflowMobileTransport(
  targetKind: ConnectionTargetKind | undefined,
): SpecWorkflowMobileTransport | null {
  switch (targetKind) {
    case "PrimaryConnectionTarget":
      return "local";
    case "BearerConnectionTarget":
      return "remote";
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
    default:
      return null;
  }
}

export function specWorkflowMobileConnectionReady(phase: EnvironmentConnectionPhase): boolean {
  return phase === "connected";
}
