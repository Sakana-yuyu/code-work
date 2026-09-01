import type {
  CompositionSquadDraft,
  CompositionSquadDraftIssue,
  CompositionSquadMemberDraft,
} from "@codework/client-runtime/composition/squad-builder";
import type {
  CompositionSquadApprovalStage,
  CompositionSquadCollaborationMode,
  CompositionSquadFailurePolicy,
  CompositionSquadMemberRole,
  CompositionSquadPartialSuccessPolicy,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@codework/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { SettingsSquadModelBindingFields } from "./SettingsSquadModelBindingFields";
import {
  addSquadBuilderMember,
  patchSquadBuilderMember,
  removeSquadBuilderMember,
  squadCollaborationModeLabelKey,
  squadMemberRoleLabelKey,
  toggleSquadBuilderApprovalStage,
} from "./SettingsSquadBuilderRouteScreen.logic";

const COLLABORATION_MODES: ReadonlyArray<CompositionSquadCollaborationMode> = [
  "serial",
  "parallel",
  "dependency_graph",
  "review_critic",
  "leader_workers",
];

const MEMBER_ROLES: ReadonlyArray<CompositionSquadMemberRole> = [
  "leader",
  "worker",
  "reviewer",
  "critic",
];

const FAILURE_POLICIES: ReadonlyArray<CompositionSquadFailurePolicy> = [
  "fail_fast",
  "continue_independent",
];

const PARTIAL_SUCCESS_POLICIES: ReadonlyArray<CompositionSquadPartialSuccessPolicy> = [
  "reject",
  "require_review",
];

const APPROVAL_STAGES: ReadonlyArray<CompositionSquadApprovalStage> = [
  "before_dispatch",
  "before_mutating_tool",
  "before_finalize",
];

export function SettingsSquadBuilderForm(props: {
  readonly variant: "create" | "edit";
  readonly draft: CompositionSquadDraft;
  readonly issues: ReadonlyArray<CompositionSquadDraftIssue>;
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly pending: boolean;
  readonly onDraftChange: (draft: CompositionSquadDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  const patchDraft = (patch: Partial<CompositionSquadDraft>): void => {
    props.onDraftChange({ ...draft, ...patch });
  };

  return (
    <View className="gap-5 border-b border-border-subtle pb-5">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-lg font-codework-semibold text-foreground">
          {t(props.variant === "create" ? "squadBuilder.createTitle" : "squadBuilder.editTitle")}
        </Text>
        <ActionButton
          label={t("squadBuilder.cancel")}
          disabled={props.pending}
          onPress={props.onCancel}
        />
      </View>

      <FormField label={t("squadBuilder.squadId")}>
        <TextInput
          value={draft.squadId}
          onChangeText={(squadId) => patchDraft({ squadId })}
          editable={!props.pending && props.variant === "create"}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("squadBuilder.squadIdPlaceholder")}
        />
      </FormField>
      <FormField label={t("squadBuilder.name")}>
        <TextInput
          value={draft.name}
          onChangeText={(name) => patchDraft({ name })}
          editable={!props.pending}
          placeholder={t("squadBuilder.namePlaceholder")}
        />
      </FormField>
      <FormField label={t("squadBuilder.sharedInstructions")}>
        <TextInput
          value={draft.instructions}
          onChangeText={(instructions) => patchDraft({ instructions })}
          editable={!props.pending}
          multiline
          textAlignVertical="top"
          className="min-h-24"
          placeholder={t("squadBuilder.instructionsPlaceholder")}
        />
      </FormField>

      <OptionGroup
        label={t("squadBuilder.mode")}
        options={COLLABORATION_MODES.map((mode) => {
          const labelKey = squadCollaborationModeLabelKey(mode);
          return { value: mode, label: labelKey === null ? mode : t(labelKey) };
        })}
        selected={draft.collaborationMode}
        disabled={props.pending}
        onSelect={(collaborationMode) => patchDraft({ collaborationMode })}
      />

      <View className="flex-row gap-3">
        <View className="min-w-0 flex-1">
          <FormField label={t("squadBuilder.maxConcurrency")}>
            <TextInput
              value={draft.maxConcurrencyText}
              onChangeText={(maxConcurrencyText) => patchDraft({ maxConcurrencyText })}
              editable={!props.pending}
              keyboardType="number-pad"
            />
          </FormField>
        </View>
        <View className="min-w-0 flex-1">
          <FormField label={t("squadBuilder.maxRetries")}>
            <TextInput
              value={draft.maxRetriesText}
              onChangeText={(maxRetriesText) => patchDraft({ maxRetriesText })}
              editable={!props.pending}
              keyboardType="number-pad"
            />
          </FormField>
        </View>
      </View>

      <OptionGroup
        label={t("squadBuilder.failurePolicy")}
        options={FAILURE_POLICIES.map((policy) => ({
          value: policy,
          label: t(`squadBuilder.failurePolicy.${policy}`),
        }))}
        selected={draft.failurePolicy}
        disabled={props.pending}
        onSelect={(failurePolicy) => patchDraft({ failurePolicy })}
      />
      <OptionGroup
        label={t("squadBuilder.partialSuccessPolicy")}
        options={PARTIAL_SUCCESS_POLICIES.map((policy) => ({
          value: policy,
          label: t(`squadBuilder.partialSuccessPolicy.${policy}`),
        }))}
        selected={draft.partialSuccessPolicy}
        disabled={props.pending}
        onSelect={(partialSuccessPolicy) => patchDraft({ partialSuccessPolicy })}
      />

      <View className="gap-2">
        <Text className="text-sm font-codework-medium text-foreground">
          {t("squadBuilder.approvalStages")}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {APPROVAL_STAGES.map((stage) => (
            <ChoiceButton
              key={stage}
              label={t(`squadBuilder.approvalStage.${stage}`)}
              selected={draft.approvalStages.includes(stage)}
              disabled={props.pending}
              onPress={() =>
                props.onDraftChange(
                  toggleSquadBuilderApprovalStage(
                    draft,
                    stage,
                    !draft.approvalStages.includes(stage),
                  ),
                )
              }
            />
          ))}
        </View>
      </View>

      <View className="gap-3 border-t border-border-subtle pt-4">
        <View className="gap-1">
          <Text className="text-base font-codework-medium text-foreground">
            {t("squadBuilder.modelBinding.teamTitle")}
          </Text>
          <Text className="text-sm leading-5 text-foreground-muted">
            {t("squadBuilder.modelBinding.teamDescription")}
          </Text>
        </View>
        <SettingsSquadModelBindingFields
          scope="team"
          providerInstances={props.providerInstances}
          value={draft.defaultModelBinding}
          disabled={props.pending}
          onChange={(defaultModelBinding) => patchDraft({ defaultModelBinding })}
        />
      </View>

      <View className="gap-3 border-t border-border-subtle pt-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-base font-codework-medium text-foreground">
            {t("squadBuilder.members")}
          </Text>
          <ActionButton
            label={t("squadBuilder.addMember")}
            disabled={props.pending}
            onPress={() => props.onDraftChange(addSquadBuilderMember(draft, `member-${uuidv4()}`))}
          />
        </View>
        {draft.members.map((member, index) => (
          <MemberEditor
            key={member.clientId}
            index={index}
            member={member}
            providerInstances={props.providerInstances}
            canRemove={draft.members.length > 1}
            disabled={props.pending}
            onPatch={(patch) => props.onDraftChange(patchSquadBuilderMember(draft, index, patch))}
            onRemove={() => props.onDraftChange(removeSquadBuilderMember(draft, index))}
          />
        ))}
      </View>

      <View className="gap-1 border-t border-border-subtle pt-4">
        <Text className="text-sm font-codework-medium text-foreground">
          {t("squadBuilder.validationTitle")}
        </Text>
        {props.issues.length === 0 ? (
          <Text className="text-sm text-success-foreground">
            {t("squadBuilder.validationReady")}
          </Text>
        ) : (
          props.issues.map((issue) => (
            <Text key={`${issue.code}:${issue.path}`} className="text-sm text-warning-foreground">
              {t(`squadBuilder.validation.${issue.code}`, { path: issue.path })}
            </Text>
          ))
        )}
      </View>

      <ActionButton
        label={
          props.pending
            ? t(props.variant === "create" ? "squadBuilder.saving" : "squadBuilder.updating")
            : t(props.variant === "create" ? "squadBuilder.save" : "squadBuilder.update")
        }
        disabled={props.pending || props.issues.length > 0}
        emphasized
        onPress={props.onSubmit}
      />
    </View>
  );
}

function MemberEditor(props: {
  readonly index: number;
  readonly member: CompositionSquadMemberDraft;
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly canRemove: boolean;
  readonly disabled: boolean;
  readonly onPatch: (patch: Partial<CompositionSquadMemberDraft>) => void;
  readonly onRemove: () => void;
}) {
  const { member } = props;
  return (
    <View className="gap-3 border-t border-border-subtle pt-3 first:border-t-0 first:pt-0">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm font-codework-medium text-foreground">
          {t("squadBuilder.member", { index: props.index + 1 })}
        </Text>
        {props.canRemove ? (
          <ActionButton
            label={t("squadBuilder.removeMember")}
            disabled={props.disabled}
            onPress={props.onRemove}
          />
        ) : null}
      </View>
      <FormField label={t("squadBuilder.agentId")}>
        <TextInput
          value={member.agentId}
          onChangeText={(agentId) => props.onPatch({ agentId })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </FormField>
      <OptionGroup
        label={t("squadBuilder.role")}
        options={MEMBER_ROLES.map((role) => {
          const labelKey = squadMemberRoleLabelKey(role);
          return { value: role, label: labelKey === null ? role : t(labelKey) };
        })}
        selected={member.role}
        disabled={props.disabled}
        onSelect={(role) => props.onPatch({ role })}
      />
      <SettingsSquadModelBindingFields
        scope="member"
        providerInstances={props.providerInstances}
        value={member.modelBinding}
        legacyModel={member.model}
        disabled={props.disabled}
        onChange={(modelBinding) =>
          props.onPatch({
            modelBinding,
            ...(modelBinding === null ? {} : { model: "" }),
          })
        }
        onLegacyModelChange={(model) => props.onPatch({ model })}
      />
      <FormField label={t("squadBuilder.memberConcurrency")}>
        <TextInput
          value={member.maxConcurrentTasksText}
          onChangeText={(maxConcurrentTasksText) => props.onPatch({ maxConcurrentTasksText })}
          editable={!props.disabled}
          keyboardType="number-pad"
        />
      </FormField>
      <FormField label={t("squadBuilder.workspaceRoot")}>
        <TextInput
          value={member.workspaceRoot}
          onChangeText={(workspaceRoot) => props.onPatch({ workspaceRoot })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </FormField>
      <FormField label={t("squadBuilder.capabilityIds")}>
        <TextInput
          value={member.capabilityIdsText}
          onChangeText={(capabilityIdsText) => props.onPatch({ capabilityIdsText })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("squadBuilder.capabilityIdsPlaceholder")}
        />
      </FormField>
      <ChoiceButton
        label={t("squadBuilder.requiredMember")}
        selected={member.required}
        disabled={props.disabled}
        onPress={() => props.onPatch({ required: !member.required })}
      />
    </View>
  );
}

function FormField(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}

function OptionGroup<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly selected: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {props.options.map((option) => (
          <ChoiceButton
            key={option.value}
            label={option.label}
            selected={option.value === props.selected}
            disabled={props.disabled}
            onPress={() => props.onSelect(option.value)}
          />
        ))}
      </View>
    </View>
  );
}

function ChoiceButton(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "rounded-full bg-subtle px-3 py-1.5 opacity-[0.45]"
          : props.selected
            ? "rounded-full bg-subtle-strong px-3 py-1.5"
            : "rounded-full bg-subtle px-3 py-1.5"
      }
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
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
