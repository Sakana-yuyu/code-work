"use client";

import type {
  CompositionSquad,
  CompositionSquadApprovalStage,
  CompositionSquadCollaborationMode,
  CompositionSquadFailurePolicy,
  CompositionSquadMemberRole,
  CompositionSquadPartialSuccessPolicy,
  CompositionSquadResult,
} from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { t } from "~/i18n";
import { cn, randomUUID } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  buildCompositionSquadCreateRequest,
  createEmptyCompositionSquadDraft,
  draftFromCompositionSquad,
  type CompositionSquadDraftIssue,
  type CompositionSquadMemberDraft,
} from "./CompositionSquadPanel.logic";
import { useCompositionEditorState } from "./compositionEditorState";
import { SettingsSection } from "./settingsLayout";
import { readByokModelAdapters } from "./ByokModelAdaptersSection";

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
const EMPTY_SQUADS: ReadonlyArray<CompositionSquad> = [];
const getSquadId = (squad: CompositionSquad): string => squad.squadId;

const modeLabel = (mode: CompositionSquadCollaborationMode): string =>
  t(`squadBuilder.mode.${mode}`);
const roleLabel = (role: CompositionSquadMemberRole): string => t(`squadBuilder.role.${role}`);
const failurePolicyLabel = (policy: CompositionSquadFailurePolicy): string =>
  t(`squadBuilder.failurePolicy.${policy}`);
const partialSuccessPolicyLabel = (policy: CompositionSquadPartialSuccessPolicy): string =>
  t(`squadBuilder.partialSuccessPolicy.${policy}`);
const approvalStageLabel = (stage: CompositionSquadApprovalStage): string =>
  t(`squadBuilder.approvalStage.${stage}`);

const issueLabel = (issue: CompositionSquadDraftIssue): string =>
  t(`squadBuilder.validation.${issue.code}`, { path: issue.path });

function FormField({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-foreground">
      <span>{label}</span>
      {children}
      {description ? (
        <span className="font-normal leading-snug text-muted-foreground">{description}</span>
      ) : null}
    </label>
  );
}

type SquadModelOption = {
  readonly value: string;
  readonly label: string;
};

function byokModelOptionsFromSettings(
  providerInstances: Readonly<Record<string, { readonly driver: string; readonly config?: unknown }>>,
): ReadonlyArray<SquadModelOption> {
  const options: SquadModelOption[] = [];
  const seen = new Set<string>();
  for (const instance of Object.values(providerInstances)) {
    if (instance.driver !== "byok") continue;
    for (const adapter of readByokModelAdapters(instance.config)) {
      const value = adapter.id.trim();
      if (value.length === 0 || seen.has(value)) continue;
      seen.add(value);
      const displayName = adapter.displayName.trim() || adapter.modelId.trim() || value;
      options.push({ value, label: `${displayName} · ${adapter.modelId}` });
    }
  }
  return options;
}

function EnumSelect<T extends string>({
  value,
  values,
  label,
  disabled,
  renderLabel,
  onChange,
}: {
  readonly value: T;
  readonly values: ReadonlyArray<T>;
  readonly label: string;
  readonly disabled?: boolean;
  readonly renderLabel: (value: T) => string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => next && onChange(next as T)}>
      <SelectTrigger size="compact" aria-label={label}>
        <SelectValue>{renderLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {values.map((option) => (
          <SelectItem key={option} value={option}>
            {renderLabel(option)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SquadMemberEditor({
  member,
  index,
  modelOptions,
  disabled,
  canRemove,
  onChange,
  onRemove,
}: {
  readonly member: CompositionSquadMemberDraft;
  readonly index: number;
  readonly modelOptions: ReadonlyArray<SquadModelOption>;
  readonly disabled: boolean;
  readonly canRemove: boolean;
  readonly onChange: (patch: Partial<CompositionSquadMemberDraft>) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border/70 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">
            {t("squadBuilder.member", { index: index + 1 })}
          </span>
          {member.role === "leader" ? (
            <Badge variant="info" size="sm">
              {t("squadBuilder.leader")}
            </Badge>
          ) : null}
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          disabled={disabled || !canRemove}
          aria-label={t("squadBuilder.removeMember", { index: index + 1 })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t("squadBuilder.agentId")}>
          <Input
            size="compact"
            value={member.agentId}
            disabled={disabled}
            onChange={(event) => onChange({ agentId: event.currentTarget.value })}
          />
        </FormField>
        <FormField label={t("squadBuilder.role")}>
          <EnumSelect
            value={member.role}
            values={MEMBER_ROLES}
            label={t("squadBuilder.role")}
            disabled={disabled}
            renderLabel={roleLabel}
            onChange={(role) => onChange({ role })}
          />
        </FormField>
        <FormField label={t("squadBuilder.model")}>
          <Input
            size="compact"
            list={`squad-model-options-${member.clientId}`}
            value={member.model}
            disabled={disabled}
            placeholder={t("squadBuilder.optional")}
            onChange={(event) => onChange({ model: event.currentTarget.value })}
          />
          <datalist id={`squad-model-options-${member.clientId}`}>
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value} label={option.label} />
            ))}
          </datalist>
        </FormField>
        <FormField label={t("squadBuilder.workspaceRoot")}>
          <Input
            size="compact"
            value={member.workspaceRoot}
            disabled={disabled}
            placeholder={t("squadBuilder.optional")}
            onChange={(event) => onChange({ workspaceRoot: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label={t("squadBuilder.capabilityIds")}
          description={t("squadBuilder.capabilityIdsDescription")}
        >
          <Input
            size="compact"
            value={member.capabilityIdsText}
            disabled={disabled}
            placeholder={t("squadBuilder.capabilityIdsPlaceholder")}
            onChange={(event) => onChange({ capabilityIdsText: event.currentTarget.value })}
          />
        </FormField>
        <FormField label={t("squadBuilder.memberConcurrency")}>
          <Input
            nativeInput
            size="compact"
            type="number"
            min={1}
            step={1}
            value={member.maxConcurrentTasksText}
            disabled={disabled}
            onChange={(event) => onChange({ maxConcurrentTasksText: event.currentTarget.value })}
          />
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={member.required}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ required: checked === true })}
        />
        {t("squadBuilder.requiredMember")}
      </label>
    </div>
  );
}

export function CompositionSquadPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const modelOptions = useMemo(
    () => byokModelOptionsFromSettings(settings.providerInstances),
    [settings.providerInstances],
  );
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

  const squads = squadsQuery.data?.squads ?? EMPTY_SQUADS;
  const preferredSquads = useMemo(
    () =>
      squads.toSorted(
        (left, right) =>
          Number(left.archivedAtUnixMs !== undefined) -
          Number(right.archivedAtUnixMs !== undefined),
      ),
    [squads],
  );
  const editor = useCompositionEditorState({
    environmentId,
    isPending: squadsQuery.isPending,
    items: preferredSquads,
    getItemId: getSquadId,
    createDraft: createEmptyCompositionSquadDraft,
    draftFromItem: draftFromCompositionSquad,
  });
  const {
    draft,
    isCreating,
    isLoading: isEditorLoading,
    selectedItem: selectedSquad,
    selectedItemId: selectedSquadId,
    setDraft,
  } = editor;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const buildResult = useMemo(() => buildCompositionSquadCreateRequest(draft), [draft]);
  const isArchived = selectedSquad?.archivedAtUnixMs !== undefined;
  const isBusy = pendingAction !== null;

  const selectSquad = (squad: CompositionSquad): void => {
    editor.selectItem(squad);
    setActionError(null);
  };

  const startCreate = (): void => {
    editor.startCreate();
    setActionError(null);
  };

  const settleLifecycle = async (
    action: string,
    execute: () => Promise<AtomCommandResult<CompositionSquadResult, unknown>>,
  ): Promise<void> => {
    setPendingAction(action);
    setActionError(null);
    const result = await execute();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("squadBuilder.actionFailed"));
    } else {
      editor.selectItem(result.value.squad);
      squadsQuery.refresh();
    }
    setPendingAction(null);
  };

  const save = async (): Promise<void> => {
    if (environmentId === null || buildResult.request === null || isArchived) return;
    if (isCreating || selectedSquad === null) {
      await settleLifecycle("save", () =>
        createSquad({ environmentId, input: buildResult.request! }),
      );
      return;
    }
    await settleLifecycle("save", () =>
      updateSquad({
        environmentId,
        input: {
          ...buildResult.request!,
          expectedRevision: selectedSquad.revision ?? 1,
        },
      }),
    );
  };

  const duplicate = async (): Promise<void> => {
    if (environmentId === null || selectedSquad === null) return;
    const suffix = randomUUID().slice(0, 8);
    await settleLifecycle("duplicate", () =>
      duplicateSquad({
        environmentId,
        input: {
          sourceSquadId: selectedSquad.squadId,
          squadId: `${selectedSquad.squadId}-copy-${suffix}`,
          name: t("squadBuilder.copyName", { name: selectedSquad.name }),
        },
      }),
    );
  };

  const changeArchiveState = async (archive: boolean): Promise<void> => {
    if (environmentId === null || selectedSquad === null) return;
    const command = archive ? archiveSquad : restoreSquad;
    await settleLifecycle(archive ? "archive" : "restore", () =>
      command({
        environmentId,
        input: {
          squadId: selectedSquad.squadId,
          expectedRevision: selectedSquad.revision ?? 1,
        },
      }),
    );
  };

  const patchMember = (index: number, patch: Partial<CompositionSquadMemberDraft>): void => {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member, memberIndex) =>
        memberIndex === index ? { ...member, ...patch } : member,
      ),
    }));
  };

  const removeMember = (index: number): void => {
    setDraft((current) => ({
      ...current,
      members: current.members.filter((_, memberIndex) => memberIndex !== index),
    }));
  };

  const addMember = (): void => {
    setDraft((current) => ({
      ...current,
      members: [
        ...current.members,
        {
          clientId: `member-${randomUUID()}`,
          agentId: "",
          role: "worker",
          required: true,
          model: "",
          workspaceRoot: "",
          capabilityIdsText: "",
          maxConcurrentTasksText: "1",
        },
      ],
    }));
  };

  const toggleApprovalStage = (stage: CompositionSquadApprovalStage, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      approvalStages: checked
        ? current.approvalStages.includes(stage)
          ? current.approvalStages
          : [...current.approvalStages, stage]
        : current.approvalStages.filter((candidate) => candidate !== stage),
    }));
  };

  return (
    <SettingsSection
      id="composition-squads"
      title={t("squadBuilder.title")}
      icon={<UsersIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <div className="flex items-center gap-1.5">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={t("squadBuilder.refresh")}
            onClick={() => squadsQuery.refresh()}
          >
            <RefreshCwIcon />
          </Button>
          <Button size="sm" variant="outline" onClick={startCreate} disabled={isBusy}>
            <PlusIcon />
            {t("squadBuilder.new")}
          </Button>
        </div>
      }
    >
      {environmentId === null ? (
        <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
          {t("squadBuilder.noEnvironment")}
        </p>
      ) : squadsQuery.isPending || isEditorLoading ? (
        <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
          {t("squadBuilder.loading")}
        </p>
      ) : squadsQuery.error ? (
        <p className="px-3 py-6 text-sm text-destructive-foreground sm:px-4">
          {t("squadBuilder.loadFailed", { message: squadsQuery.error })}
        </p>
      ) : (
        <div className="grid border-y border-border/60 lg:grid-cols-[minmax(13rem,0.32fr)_minmax(0,1fr)]">
          <aside className="border-b border-border/60 lg:border-r lg:border-b-0">
            <div className="max-h-72 overflow-y-auto p-2 lg:max-h-none">
              {squads.length === 0 ? (
                <p className="px-2 py-5 text-xs text-muted-foreground">{t("squadBuilder.empty")}</p>
              ) : (
                <div className="space-y-1">
                  {squads.map((squad) => {
                    const archived = squad.archivedAtUnixMs !== undefined;
                    return (
                      <button
                        key={squad.squadId}
                        type="button"
                        data-squad-id={squad.squadId}
                        className={cn(
                          "flex w-full min-w-0 items-start justify-between gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted/60",
                          !isCreating && squad.squadId === selectedSquadId && "bg-muted",
                        )}
                        onClick={() => selectSquad(squad)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {squad.name}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                            {squad.squadId}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <Badge variant="outline" size="sm">
                            {t("squadBuilder.revision", { revision: squad.revision ?? 1 })}
                          </Badge>
                          {archived ? (
                            <Badge variant="warning" size="sm">
                              {t("squadBuilder.archived")}
                            </Badge>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <div className="min-w-0 space-y-5 p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {isCreating ? t("squadBuilder.createTitle") : t("squadBuilder.editTitle")}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {isArchived ? t("squadBuilder.archivedReadonly") : t("squadBuilder.description")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {!isCreating && selectedSquad !== null ? (
                  <>
                    <Button
                      data-testid="squad-duplicate"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => void duplicate()}
                    >
                      <CopyIcon />
                      {t("squadBuilder.duplicate")}
                    </Button>
                    <Button
                      data-testid={isArchived ? "squad-restore" : "squad-archive"}
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => void changeArchiveState(!isArchived)}
                    >
                      {isArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                      {isArchived ? t("squadBuilder.restore") : t("squadBuilder.archive")}
                    </Button>
                  </>
                ) : null}
                <Button
                  data-testid="squad-save"
                  size="sm"
                  disabled={isBusy || isArchived || buildResult.request === null}
                  onClick={() => void save()}
                >
                  <SaveIcon />
                  {pendingAction === "save" ? t("squadBuilder.saving") : t("squadBuilder.save")}
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t("squadBuilder.squadId")}>
                <Input
                  size="compact"
                  value={draft.squadId}
                  disabled={isArchived || !isCreating}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({ ...current, squadId: value }));
                  }}
                />
              </FormField>
              <FormField label={t("squadBuilder.name")}>
                <Input
                  size="compact"
                  value={draft.name}
                  disabled={isArchived}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({ ...current, name: value }));
                  }}
                />
              </FormField>
              <FormField label={t("squadBuilder.mode")}>
                <EnumSelect
                  value={draft.collaborationMode}
                  values={COLLABORATION_MODES}
                  label={t("squadBuilder.mode")}
                  disabled={isArchived}
                  renderLabel={modeLabel}
                  onChange={(collaborationMode) =>
                    setDraft((current) => ({ ...current, collaborationMode }))
                  }
                />
              </FormField>
              <FormField label={t("squadBuilder.maxConcurrency")}>
                <Input
                  nativeInput
                  size="compact"
                  type="number"
                  min={1}
                  step={1}
                  value={draft.maxConcurrencyText}
                  disabled={isArchived}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({
                      ...current,
                      maxConcurrencyText: value,
                    }));
                  }}
                />
              </FormField>
              <FormField label={t("squadBuilder.maxRetries")}>
                <Input
                  nativeInput
                  size="compact"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.maxRetriesText}
                  disabled={isArchived}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({
                      ...current,
                      maxRetriesText: value,
                    }));
                  }}
                />
              </FormField>
              <FormField label={t("squadBuilder.failurePolicy")}>
                <EnumSelect
                  value={draft.failurePolicy}
                  values={FAILURE_POLICIES}
                  label={t("squadBuilder.failurePolicy")}
                  disabled={isArchived}
                  renderLabel={failurePolicyLabel}
                  onChange={(failurePolicy) =>
                    setDraft((current) => ({ ...current, failurePolicy }))
                  }
                />
              </FormField>
              <FormField label={t("squadBuilder.partialSuccessPolicy")}>
                <EnumSelect
                  value={draft.partialSuccessPolicy}
                  values={PARTIAL_SUCCESS_POLICIES}
                  label={t("squadBuilder.partialSuccessPolicy")}
                  disabled={isArchived}
                  renderLabel={partialSuccessPolicyLabel}
                  onChange={(partialSuccessPolicy) =>
                    setDraft((current) => ({ ...current, partialSuccessPolicy }))
                  }
                />
              </FormField>
            </div>

            <FormField label={t("squadBuilder.instructions")}>
              <Textarea
                size="sm"
                value={draft.instructions}
                disabled={isArchived}
                placeholder={t("squadBuilder.instructionsPlaceholder")}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, instructions: value }));
                }}
              />
            </FormField>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold text-foreground">
                    {t("squadBuilder.members")}
                  </h4>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("squadBuilder.membersDescription")}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={isArchived} onClick={addMember}>
                  <PlusIcon />
                  {t("squadBuilder.addMember")}
                </Button>
              </div>
              <div className="space-y-2">
                {draft.members.map((member, index) => (
                  <SquadMemberEditor
                    key={member.clientId}
                    member={member}
                    index={index}
                    modelOptions={modelOptions}
                    disabled={isArchived}
                    canRemove={draft.members.length > 1}
                    onChange={(patch) => patchMember(index, patch)}
                    onRemove={() => removeMember(index)}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-foreground">
                {t("squadBuilder.approvalStages")}
              </h4>
              <div className="grid gap-2 sm:grid-cols-3">
                {APPROVAL_STAGES.map((stage) => (
                  <label
                    key={stage}
                    className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs text-muted-foreground"
                  >
                    <Checkbox
                      checked={draft.approvalStages.includes(stage)}
                      disabled={isArchived}
                      onCheckedChange={(checked) => toggleApprovalStage(stage, checked === true)}
                    />
                    {approvalStageLabel(stage)}
                  </label>
                ))}
              </div>
            </div>

            {buildResult.issues.length > 0 ? (
              <div className="space-y-1 rounded-md border border-warning/35 bg-warning/5 px-3 py-2">
                <p className="text-xs font-medium text-warning-foreground">
                  {t("squadBuilder.validationTitle")}
                </p>
                <ul className="space-y-0.5 text-xs text-warning-foreground/90">
                  {buildResult.issues.map((issue) => (
                    <li key={`${issue.code}-${issue.path}`}>{issueLabel(issue)}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-success-foreground">{t("squadBuilder.validationReady")}</p>
            )}
            {actionError ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {actionError}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
