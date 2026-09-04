import type { EnvironmentConnectionPhase } from "@codework/client-runtime/connection";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SpecWorkflowStage,
  SpecWorkflowStatus,
  ThreadId,
} from "@codework/contracts";
import { View } from "react-native";

import { ControlPill } from "../../components/ControlPill";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useSpecWorkflowController } from "../../state/specWorkflow";
import {
  specWorkflowMobileConnectionReady,
  specWorkflowMobileTransport,
} from "./specWorkflowMobilePresentation";

function stageLabel(stage: SpecWorkflowStage): string {
  return t(`specWorkflowMobile.stage.${stage}`);
}

function statusLabel(status: SpecWorkflowStatus): string {
  return t(`specWorkflowMobile.status.${status}`);
}

export function SpecWorkflowMobileControls(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly connectionState: EnvironmentConnectionPhase;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const threadRef: ScopedThreadRef = {
    environmentId: props.environmentId,
    threadId: props.threadId,
  };
  const controller = useSpecWorkflowController(threadRef);
  const state = controller.workflowState;
  const canMutate =
    specWorkflowMobileConnectionReady(props.connectionState) && !controller.isPending;
  const transportKind = specWorkflowMobileTransport(presentation?.entry.target._tag);
  const transport = transportKind ? t(`specWorkflowMobile.transport.${transportKind}`) : null;

  return (
    <View className="border-b border-subtle bg-subtle px-4 py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-codework-bold">{t("specWorkflowMobile.title")}</Text>
          <Text className="mt-1 text-xs text-foreground-muted">
            {controller.capability === null
              ? controller.hasError
                ? t("specWorkflowMobile.loadFailed")
                : t("specWorkflowMobile.loading")
              : controller.enabled
                ? state !== null
                  ? `${stageLabel(state.stage)} · ${statusLabel(state.status)}`
                  : controller.workflowStateHasError
                    ? t("specWorkflowMobile.loadFailed")
                    : t("specWorkflowMobile.loading")
                : t("specWorkflowMobile.disabled")}
          </Text>
          {transport ? (
            <Text className="mt-1 text-xs text-foreground-muted">
              {t("specWorkflowMobile.transport", { transport })}
            </Text>
          ) : null}
          {!specWorkflowMobileConnectionReady(props.connectionState) ? (
            <Text className="mt-1 text-xs text-warning">
              {t("specWorkflowMobile.connectionUnavailable", {
                state: t(`specWorkflowMobile.connection.${props.connectionState}`),
              })}
            </Text>
          ) : null}
          {state?.lastError ? (
            <Text className="mt-1 text-xs text-danger">{state.lastError}</Text>
          ) : null}
        </View>
        <ControlPill
          label={
            controller.enabled ? t("specWorkflowMobile.disable") : t("specWorkflowMobile.enable")
          }
          accessibilityLabel={
            controller.enabled ? t("specWorkflowMobile.disable") : t("specWorkflowMobile.enable")
          }
          variant={controller.enabled ? "pill" : "primary"}
          disabled={controller.capability === null || controller.hasError || !canMutate}
          onPress={() => void controller.toggle()}
        />
      </View>

      {controller.enabled && state !== null ? (
        <View className="mt-3 flex-row flex-wrap gap-2">
          {state.stage === "awaitingApproval" && state.proposalStatus === "pending" ? (
            <>
              <ControlPill
                label={t("specWorkflowMobile.approve")}
                accessibilityLabel={t("specWorkflowMobile.approve")}
                variant="primary"
                disabled={!canMutate}
                onPress={() => void controller.approveProposal()}
              />
              <ControlPill
                label={t("specWorkflowMobile.reject")}
                accessibilityLabel={t("specWorkflowMobile.reject")}
                variant="danger"
                disabled={!canMutate}
                onPress={() => void controller.rejectProposal()}
              />
            </>
          ) : null}
          {state.stage === "acceptance" && state.acceptanceStatus === "pending" ? (
            <ControlPill
              label={t("specWorkflowMobile.completeAcceptance")}
              accessibilityLabel={t("specWorkflowMobile.completeAcceptance")}
              variant="primary"
              disabled={!canMutate || state.status !== "active"}
              onPress={() => void controller.completeAcceptance()}
            />
          ) : null}
          {state.status === "active" ? (
            <ControlPill
              label={t("specWorkflowMobile.pause")}
              accessibilityLabel={t("specWorkflowMobile.pause")}
              disabled={!canMutate}
              onPress={() => void controller.pause()}
            />
          ) : null}
          {state.status === "paused" ? (
            <ControlPill
              label={t("specWorkflowMobile.resume")}
              accessibilityLabel={t("specWorkflowMobile.resume")}
              variant="primary"
              disabled={!canMutate}
              onPress={() => void controller.resume()}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
