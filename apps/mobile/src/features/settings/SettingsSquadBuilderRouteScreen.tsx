import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import {
  buildCompositionSquadCreateRequest,
  createEmptyCompositionSquadDraft,
  draftFromCompositionSquad,
  type CompositionSquadDraft,
} from "@codework/client-runtime/composition/squad-builder";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import type {
  CompositionSquad,
  CompositionSquadMember,
  CompositionSquadResult,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
} from "@codework/contracts";
import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Atom } from "effect/unstable/reactivity";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSquadBuilderForm } from "./SettingsSquadBuilderForm";
import { SettingsSquadModelBindingSummary } from "./SettingsSquadModelBindingSummary";
import {
  buildSquadBuilderDuplicateRequest,
  buildSquadBuilderRevisionMutationRequest,
  buildSquadBuilderUpdateRequest,
  resolveSquadBuilderMembers,
  squadCollaborationModeLabelKey,
  squadMemberRoleLabelKey,
  sortSquadBuilderSquads,
  summarizeSquadBuilderConfiguration,
} from "./SettingsSquadBuilderRouteScreen.logic";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-squad-builder:settings:empty"),
);
const EMPTY_PROVIDER_INSTANCES: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>> = {};

/** Mobile Squad Builder 管理入口，直接读写服务端持久化配置。 */
export function SettingsSquadBuilderRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const settings = useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_SETTINGS_ATOM
      : serverEnvironment.settingsValueAtom(environmentId),
  );
  const providerInstances = settings?.providerInstances ?? EMPTY_PROVIDER_INSTANCES;
  const squadsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquads({
          environmentId,
          input: { includeArchived: true },
        }),
  );
  const createSquad = useAtomCommand(serverEnvironment.createCompositionSquad, {
    reportFailure: false,
  });
  const updateSquad = useAtomCommand(serverEnvironment.updateCompositionSquad, {
    reportFailure: false,
  });
  const duplicateSquad = useAtomCommand(serverEnvironment.duplicateCompositionSquad, {
    reportFailure: false,
  });
  const archiveSquad = useAtomCommand(serverEnvironment.archiveCompositionSquad, {
    reportFailure: false,
  });
  const restoreSquad = useAtomCommand(serverEnvironment.restoreCompositionSquad, {
    reportFailure: false,
  });
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [editingSquadId, setEditingSquadId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CompositionSquadDraft>(createEmptyCompositionSquadDraft);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<{
    readonly kind: "created" | "updated" | "duplicated" | "archivedSuccess" | "restored";
    readonly name: string;
  } | null>(null);
  const actionInFlightRef = useRef(false);
  const squads = sortSquadBuilderSquads(squadsQuery.data?.squads ?? []);
  const editingSquad = squads.find((squad) => squad.squadId === editingSquadId) ?? null;
  const createBuildResult = useMemo(() => buildCompositionSquadCreateRequest(draft), [draft]);
  const updateBuildResult = useMemo(
    () => buildSquadBuilderUpdateRequest(draft, editingSquad?.revision ?? 1),
    [draft, editingSquad?.revision],
  );
  const activeBuildResult = editorMode === "edit" ? updateBuildResult : createBuildResult;

  const startCreate = (): void => {
    setDraft(createEmptyCompositionSquadDraft());
    setEditingSquadId(null);
    setActionError(null);
    setActionSuccess(null);
    setEditorMode("create");
  };

  const startEdit = (squad: CompositionSquad): void => {
    if (squad.archivedAtUnixMs !== undefined) return;
    setDraft(draftFromCompositionSquad(squad));
    setEditingSquadId(squad.squadId);
    setActionError(null);
    setActionSuccess(null);
    setEditorMode("edit");
  };

  const cancelEditor = (): void => {
    if (actionPending) return;
    setEditorMode(null);
    setEditingSquadId(null);
    setActionError(null);
  };

  const submitEditor = async (): Promise<void> => {
    if (environmentId === null || editorMode === null || actionInFlightRef.current) return;
    if (editorMode === "create" && createBuildResult.request === null) return;
    if (editorMode === "edit" && (updateBuildResult.request === null || editingSquad === null)) {
      return;
    }
    actionInFlightRef.current = true;
    setActionPending(true);
    setActionError(null);
    setActionSuccess(null);
    const result =
      editorMode === "create"
        ? await createSquad({ environmentId, input: createBuildResult.request! })
        : await updateSquad({ environmentId, input: updateBuildResult.request! });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("squadBuilder.actionFailed"));
    } else {
      setActionSuccess({
        kind: editorMode === "create" ? "created" : "updated",
        name: result.value.squad.name,
      });
      setDraft(createEmptyCompositionSquadDraft());
      setEditorMode(null);
      setEditingSquadId(null);
      squadsQuery.refresh();
    }
    actionInFlightRef.current = false;
    setActionPending(false);
  };

  const settleLifecycle = async (
    kind: "duplicated" | "archivedSuccess" | "restored",
    execute: () => Promise<AtomCommandResult<CompositionSquadResult, unknown>>,
  ): Promise<void> => {
    if (editorMode !== null || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionPending(true);
    setActionError(null);
    setActionSuccess(null);
    const result = await execute();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("squadBuilder.actionFailed"));
    } else {
      setActionSuccess({ kind, name: result.value.squad.name });
      squadsQuery.refresh();
    }
    actionInFlightRef.current = false;
    setActionPending(false);
  };

  const duplicateSelectedSquad = async (squad: CompositionSquad): Promise<void> => {
    if (environmentId === null) return;
    const suffix = `copy-${uuidv4().slice(0, 8)}`;
    await settleLifecycle("duplicated", () =>
      duplicateSquad({
        environmentId,
        input: buildSquadBuilderDuplicateRequest(
          squad,
          suffix,
          t("squadBuilder.copyName", { name: squad.name }),
        ),
      }),
    );
  };

  const changeArchiveState = async (squad: CompositionSquad, archive: boolean): Promise<void> => {
    if (environmentId === null) return;
    const command = archive ? archiveSquad : restoreSquad;
    await settleLifecycle(archive ? "archivedSuccess" : "restored", () =>
      command({
        environmentId,
        input: buildSquadBuilderRevisionMutationRequest(squad),
      }),
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={t("squadBuilder.title")} onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={squadsQuery.isPending && squadsQuery.data !== null}
            onRefresh={squadsQuery.refresh}
          />
        }
      >
        {environmentId === null ? null : (
          <View className="flex-row justify-end">
            <ActionButton
              label={t("squadBuilder.new")}
              disabled={actionPending || editorMode !== null}
              emphasized
              onPress={startCreate}
            />
          </View>
        )}
        {editorMode === null ? null : (
          <SettingsSquadBuilderForm
            variant={editorMode}
            draft={draft}
            issues={activeBuildResult.issues}
            providerInstances={providerInstances}
            pending={actionPending}
            onDraftChange={setDraft}
            onSubmit={() => void submitEditor()}
            onCancel={cancelEditor}
          />
        )}
        {actionError === null ? null : (
          <Text className="text-sm text-danger-foreground">{actionError}</Text>
        )}
        {actionSuccess === null ? null : (
          <Text className="text-sm text-success-foreground">
            {t(`squadBuilder.${actionSuccess.kind}`, { name: actionSuccess.name })}
          </Text>
        )}
        {environmentId === null ? (
          <StatusMessage text={t("squadBuilder.noEnvironment")} />
        ) : squadsQuery.data === null && squadsQuery.isPending ? (
          <StatusMessage text={t("squadBuilder.pending")} />
        ) : squadsQuery.data === null && squadsQuery.error !== null ? (
          <StatusMessage text={t("squadBuilder.error")} tone="danger" />
        ) : squads.length === 0 ? (
          <StatusMessage text={t("squadBuilder.empty")} />
        ) : (
          squads.map((squad) => (
            <SquadConfigurationCard
              key={squad.squadId}
              squad={squad}
              providerInstances={providerInstances}
              actionsDisabled={actionPending || editorMode !== null}
              onEdit={() => startEdit(squad)}
              onDuplicate={() => void duplicateSelectedSquad(squad)}
              onArchiveStateChange={(archive) => void changeArchiveState(squad, archive)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function SquadConfigurationCard(props: {
  readonly squad: CompositionSquad;
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly actionsDisabled: boolean;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
  readonly onArchiveStateChange: (archive: boolean) => void;
}) {
  const { squad } = props;
  const summary = summarizeSquadBuilderConfiguration(squad);
  const members = resolveSquadBuilderMembers(squad);
  const collaborationModeLabelKey = squadCollaborationModeLabelKey(summary.collaborationMode);

  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
      <View className="gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="min-w-0 flex-1 text-base font-codework-medium text-foreground">
            {squad.name}
          </Text>
          <BadgePill
            label={t(summary.archived ? "squadBuilder.archived" : "squadBuilder.active")}
            emphasized={!summary.archived}
          />
        </View>
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {squad.squadId}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <BadgePill
          label={
            collaborationModeLabelKey === null
              ? summary.collaborationMode
              : t(collaborationModeLabelKey)
          }
        />
        <BadgePill label={t("squadBuilder.revision", { revision: summary.revision })} />
        <BadgePill label={t("squadBuilder.memberCount", { count: summary.memberCount })} />
      </View>

      <View className="gap-1 rounded-[16px] bg-subtle px-3 py-2.5">
        <Text className="text-sm text-foreground">
          {t("squadBuilder.leader", { agentId: squad.leaderAgentId })}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {t("squadBuilder.limits", {
            concurrency: summary.maxConcurrency,
            retries: summary.maxRetries,
          })}
        </Text>
      </View>

      <SettingsSquadModelBindingSummary
        scope="team"
        providerInstances={props.providerInstances}
        binding={squad.defaultModelBinding ?? null}
      />

      {squad.instructions === undefined ? null : (
        <View className="gap-1">
          <Text className="text-xs font-codework-medium text-foreground-muted">
            {t("squadBuilder.instructions")}
          </Text>
          <Text className="text-sm text-foreground">{squad.instructions}</Text>
        </View>
      )}

      <View className="gap-2 border-t border-border-subtle pt-3">
        <Text className="text-sm font-codework-medium text-foreground">
          {t("squadBuilder.members")}
        </Text>
        {members.map((member) => (
          <SquadMemberRow
            key={`${member.order}:${member.agentId}`}
            member={member}
            providerInstances={props.providerInstances}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap justify-end gap-2 border-t border-border-subtle pt-3">
        {summary.archived ? null : (
          <ActionButton
            label={t("squadBuilder.edit")}
            disabled={props.actionsDisabled}
            onPress={props.onEdit}
          />
        )}
        <ActionButton
          label={t("squadBuilder.duplicate")}
          disabled={props.actionsDisabled}
          onPress={props.onDuplicate}
        />
        <ActionButton
          label={t(summary.archived ? "squadBuilder.restore" : "squadBuilder.archive")}
          disabled={props.actionsDisabled}
          onPress={() => props.onArchiveStateChange(!summary.archived)}
        />
      </View>
    </View>
  );
}

function SquadMemberRow(props: {
  readonly member: CompositionSquadMember;
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
}) {
  const { member } = props;
  const roleLabelKey = squadMemberRoleLabelKey(member.role);
  return (
    <View className="gap-1 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="min-w-0 flex-1 font-mono text-sm text-foreground" numberOfLines={1}>
          {member.agentId}
        </Text>
        <BadgePill
          label={roleLabelKey === null ? member.role : t(roleLabelKey)}
          emphasized={member.role === "leader"}
        />
        <BadgePill label={t(member.required ? "squadBuilder.required" : "squadBuilder.optional")} />
      </View>
      <SettingsSquadModelBindingSummary
        scope="member"
        providerInstances={props.providerInstances}
        binding={member.modelBinding ?? null}
        legacyModel={member.model}
      />
      {member.workspaceRoot === undefined ? null : (
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {t("squadBuilder.workspace", { workspace: member.workspaceRoot })}
        </Text>
      )}
      <Text className="text-xs text-foreground-muted">
        {t("squadBuilder.memberLimits", {
          capabilities:
            member.capabilityIds.length === 0
              ? t("squadBuilder.noCapabilities")
              : member.capabilityIds.join(", "),
          concurrency: member.maxConcurrentTasks,
        })}
      </Text>
    </View>
  );
}

function StatusMessage(props: { readonly text: string; readonly tone?: "danger" }) {
  return (
    <View className="rounded-[24px] border-continuous bg-card px-4 py-6">
      <Text
        className={
          props.tone === "danger"
            ? "text-center text-sm text-danger-foreground"
            : "text-center text-sm text-foreground-muted"
        }
      >
        {props.text}
      </Text>
    </View>
  );
}

function BadgePill(props: { readonly label: string; readonly emphasized?: boolean }) {
  return (
    <View
      className={
        props.emphasized
          ? "rounded-full bg-subtle-strong px-2.5 py-0.5"
          : "rounded-full bg-subtle px-2.5 py-0.5"
      }
    >
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly emphasized?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "rounded-full bg-subtle px-3 py-1.5 opacity-[0.45]"
          : props.emphasized
            ? "rounded-full bg-subtle-strong px-3 py-1.5"
            : "rounded-full bg-subtle px-3 py-1.5"
      }
    >
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
