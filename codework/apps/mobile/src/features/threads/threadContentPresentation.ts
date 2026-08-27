import { type EnvironmentConnectionPhase } from "@codework/client-runtime/connection";
import { t } from "../../i18n/runtime";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
    };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: t("threadUnavailable"),
      detail: t("thisThreadWasDeletedOrIsNoLongerAvailable"),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: t("couldNotLoadConversation"),
      detail: input.detailError,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    // Messages will arrive once the (re)connection completes — present as
    // loading; the composer's connection pill reports the connection phase.
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: t("messagesNotCached"),
    detail: t("reconnectThisEnvironmentToLoadTheConversation"),
  };
}
