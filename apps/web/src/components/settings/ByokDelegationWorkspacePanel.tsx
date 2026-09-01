"use client";

import { AsyncResult } from "effect/unstable/reactivity";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  ListRestartIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundCogIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ByokDelegationConfig,
  ByokDelegationExecutor,
  ByokDelegationExecutorProbe,
  ByokDelegationSnapshot,
  ByokModelAdapter,
  ProviderInstanceConfig,
  ServerSettings,
} from "@codework/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";
import { usePrimaryEnvironment } from "~/state/environments";
import { byokEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { readByokModelAdapters } from "./ByokModelAdaptersSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type DelegationModelGroup = ByokDelegationConfig["modelGroups"][number];

const DEFAULT_DELEGATION: ByokDelegationConfig = {
  enabled: false,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
};

const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DelegationInstance {
  readonly instanceId: string;
  readonly displayName: string;
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
  readonly delegation: ByokDelegationConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
    : [];

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
};

export const millisecondsToSecondsText = (value: number): string =>
  String(boundedInteger(value / 1_000, 1, 1, 24 * 60 * 60));

export const secondsTextToMilliseconds = (value: unknown, fallbackMs: number): number => {
  const fallbackSeconds = Number(millisecondsToSecondsText(fallbackMs));
  const normalizedValue =
    typeof value === "string" && value.trim() === "" ? fallbackSeconds : value;
  return boundedInteger(normalizedValue, fallbackSeconds, 1, 24 * 60 * 60) * 1_000;
};

const normalizeModelGroup = (value: unknown, index: number): DelegationModelGroup | null => {
  if (!isRecord(value)) return null;
  const id = String(value["id"] ?? "").trim() || `delegation-group-${index + 1}`;
  const name =
    String(value["name"] ?? "").trim() ||
    t("delegationSettings.defaultGroupName", { index: index + 1 });
  const modelIds = stringArray(value["modelIds"]);
  const defaultModelId = String(value["defaultModelId"] ?? "").trim();

  return {
    id,
    name,
    enabled: value["enabled"] !== false,
    modelIds,
    ...(defaultModelId.length > 0 && modelIds.includes(defaultModelId) ? { defaultModelId } : {}),
  };
};

const normalizeVisionDelegation = (value: unknown): ByokDelegationConfig["visionDelegation"] => {
  if (!isRecord(value)) return DEFAULT_DELEGATION.visionDelegation;
  const mode = value["mode"];
  const visionModelId = String(value["visionModelId"] ?? "").trim();
  return {
    enabled: value["enabled"] === true && visionModelId.length > 0,
    visionModelId,
    mode: mode === "describe" || mode === "ocr" ? mode : "auto",
  };
};

const normalizeSupervision = (value: unknown): ByokDelegationConfig["supervision"] => {
  const fallback = DEFAULT_DELEGATION.supervision;
  if (!isRecord(value)) return fallback;
  return {
    enabled: value["enabled"] === true,
    supervisorModelId: String(value["supervisorModelId"] ?? "").trim(),
    reviewerModelId: String(value["reviewerModelId"] ?? "").trim(),
    maxCorrections: boundedInteger(value["maxCorrections"], fallback.maxCorrections, 0, 20),
    maxRetries: boundedInteger(value["maxRetries"], fallback.maxRetries, 0, 20),
    maxRounds: boundedInteger(value["maxRounds"], fallback.maxRounds, 1, 50),
    allowReassign: value["allowReassign"] !== false,
    allowEscalate: value["allowEscalate"] !== false,
    strictUnavailable: value["strictUnavailable"] === true,
  };
};

const normalizeSubagentProfiles = (value: unknown): ByokDelegationConfig["subagentProfiles"] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((profile) => {
      if (!isRecord(profile)) return null;
      const subagentType = String(profile["subagentType"] ?? "").trim();
      if (subagentType.length === 0) return null;
      return {
        subagentType,
        promptFragment: String(profile["promptFragment"] ?? ""),
      };
    })
    .filter((profile): profile is ByokDelegationConfig["subagentProfiles"][number] =>
      Boolean(profile),
    );
};

const EXECUTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/;
/** The legacy single command participates as this synthetic executor. */
const RESERVED_EXECUTOR_ID = "default";

const normalizeExecutors = (value: unknown): ByokDelegationConfig["executors"] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>([RESERVED_EXECUTOR_ID]);
  const rows: ByokDelegationExecutor[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = String(item["id"] ?? "").trim().toLowerCase();
    if (!EXECUTOR_ID_PATTERN.test(id) || seen.has(id)) continue;
    const command = String(item["command"] ?? "").trim();
    if (command.length === 0) continue;
    seen.add(id);
    rows.push({
      id,
      name: String(item["name"] ?? "").trim(),
      enabled: item["enabled"] !== false,
      priority: boundedInteger(item["priority"], 100, 0, 10_000),
      command,
      environmentVariables: stringArray(item["environmentVariables"]).filter((name) =>
        ENV_VAR_PATTERN.test(name),
      ),
      probeArguments: String(item["probeArguments"] ?? "").trim(),
    });
  }
  return rows;
};

export const readDelegationConfig = (config: unknown): ByokDelegationConfig => {
  if (!isRecord(config)) {
    return DEFAULT_DELEGATION;
  }
  const value = config["delegation"];
  if (!isRecord(value)) {
    return DEFAULT_DELEGATION;
  }

  return {
    ...DEFAULT_DELEGATION,
    enabled: value["enabled"] === true,
    maxConcurrency: boundedInteger(
      value["maxConcurrency"],
      DEFAULT_DELEGATION.maxConcurrency,
      1,
      16,
    ),
    queueTimeoutMs: boundedInteger(
      value["queueTimeoutMs"],
      DEFAULT_DELEGATION.queueTimeoutMs,
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    executionTimeoutMs: boundedInteger(
      value["executionTimeoutMs"],
      DEFAULT_DELEGATION.executionTimeoutMs,
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    modelGroups: Array.isArray(value["modelGroups"])
      ? value["modelGroups"]
          .map((group, index) => normalizeModelGroup(group, index))
          .filter((group): group is DelegationModelGroup => group !== null)
      : [],
    executorCommand: String(value["executorCommand"] ?? "").trim(),
    executorEnvironmentVariables: stringArray(value["executorEnvironmentVariables"]).filter(
      (name) => ENV_VAR_PATTERN.test(name),
    ),
    executors: normalizeExecutors(value["executors"]),
    executorFailoverLimit: boundedInteger(
      value["executorFailoverLimit"],
      DEFAULT_DELEGATION.executorFailoverLimit,
      1,
      5,
    ),
    visionDelegation: normalizeVisionDelegation(value["visionDelegation"]),
    supervision: normalizeSupervision(value["supervision"]),
    subagentProfiles: normalizeSubagentProfiles(value["subagentProfiles"]),
  };
};

export const delegationInstancesFrom = (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): ReadonlyArray<DelegationInstance> =>
  Object.entries(instances)
    .filter(([, instance]) => String(instance.driver) === "byok")
    .map(([instanceId, instance]) => ({
      instanceId,
      displayName: instance.displayName ?? instanceId,
      adapters: readByokModelAdapters(instance.config),
      delegation: readDelegationConfig(instance.config),
    }));

const statusLabel = (status: ByokDelegationSnapshot["status"]): string => {
  switch (status) {
    case "queued":
      return t("delegationWorkspace.statusQueued");
    case "running":
      return t("delegationWorkspace.statusRunning");
    case "succeeded":
      return t("delegationWorkspace.statusSucceeded");
    case "cancelled":
      return t("delegationWorkspace.statusCancelled");
    case "queue_timed_out":
      return t("delegationWorkspace.statusQueueTimedOut");
    case "execution_timed_out":
      return t("delegationWorkspace.statusExecutionTimedOut");
    case "failed":
      return t("delegationWorkspace.statusFailed");
  }
};

const isActive = (snapshot: ByokDelegationSnapshot): boolean =>
  snapshot.status === "queued" || snapshot.status === "running";

const adapterLabel = (adapter: ByokModelAdapter): string =>
  adapter.displayName || adapter.modelId || adapter.id;

const uniqueGroupId = (groups: ReadonlyArray<DelegationModelGroup>): string => {
  const existing = new Set(groups.map((group) => group.id));
  let index = groups.length + 1;
  while (existing.has(`delegation-group-${index}`)) index += 1;
  return `delegation-group-${index}`;
};

export const createModelGroup = (
  groups: ReadonlyArray<DelegationModelGroup>,
  adapters: ReadonlyArray<ByokModelAdapter>,
): DelegationModelGroup => {
  const modelIds = adapters.map((adapter) => adapter.id);
  const index = groups.length + 1;
  return {
    id: uniqueGroupId(groups),
    name: t("delegationSettings.defaultGroupName", { index }),
    enabled: true,
    modelIds,
    ...(modelIds[0] === undefined ? {} : { defaultModelId: modelIds[0] }),
  };
};

const groupWithDefaultModel = (
  group: Omit<DelegationModelGroup, "defaultModelId"> & {
    readonly defaultModelId?: string | undefined;
  },
  defaultModelId: string | undefined,
): DelegationModelGroup => {
  if (defaultModelId === undefined) {
    const { defaultModelId: _removed, ...rest } = group;
    return rest;
  }
  return { ...group, defaultModelId };
};

const updateGroup = (
  delegation: ByokDelegationConfig,
  groupId: string,
  patch: (group: DelegationModelGroup) => DelegationModelGroup,
): ByokDelegationConfig => ({
  ...delegation,
  modelGroups: delegation.modelGroups.map((group) => (group.id === groupId ? patch(group) : group)),
});

export const toggleModelInGroup = (
  group: DelegationModelGroup,
  modelId: string,
  enabled: boolean,
): DelegationModelGroup => {
  const modelIds = enabled
    ? [...new Set([...group.modelIds, modelId])]
    : group.modelIds.filter((candidate) => candidate !== modelId);
  const defaultModelId =
    group.defaultModelId !== undefined && modelIds.includes(group.defaultModelId)
      ? group.defaultModelId
      : modelIds[0];

  return groupWithDefaultModel({ ...group, modelIds }, defaultModelId);
};

function CollapsibleSettingsBlock({
  title,
  description,
  icon,
  defaultOpen = false,
  action,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly defaultOpen?: boolean;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4 px-3 sm:px-4">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-2 text-left">
            <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/25 text-muted-foreground">
              {icon}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
                {title}
                {open ? (
                  <ChevronUpIcon className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronDownIcon className="size-4 text-muted-foreground" />
                )}
              </span>
              <span className="mt-1 block max-w-2xl text-[13px] leading-[1.45] text-muted-foreground/80">
                {description}
              </span>
            </span>
          </CollapsibleTrigger>
          {action === undefined ? null : <div className="shrink-0">{action}</div>}
        </div>
        <CollapsiblePanel>
          <div className="space-y-4 px-3 pb-1 sm:px-4">{children}</div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

function CapabilityStatusCard({
  icon,
  title,
  description,
  status,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly status: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <Badge variant="outline" size="sm">
              {status}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  );
}

function ExecutorConfigurationDialog({
  open,
  delegation,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  readonly delegation: ByokDelegationConfig;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (next: ByokDelegationConfig) => void;
}) {
  const [command, setCommand] = useState("");
  const [queueTimeoutSeconds, setQueueTimeoutSeconds] = useState("30");
  const [executionTimeoutSeconds, setExecutionTimeoutSeconds] = useState("120");
  const [envVars, setEnvVars] = useState<ReadonlyArray<string>>([]);
  const [envInput, setEnvInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setCommand(delegation.executorCommand);
    setQueueTimeoutSeconds(millisecondsToSecondsText(delegation.queueTimeoutMs));
    setExecutionTimeoutSeconds(millisecondsToSecondsText(delegation.executionTimeoutMs));
    setEnvVars(delegation.executorEnvironmentVariables);
    setEnvInput("");
  }, [
    delegation.executionTimeoutMs,
    delegation.executorCommand,
    delegation.executorEnvironmentVariables,
    delegation.queueTimeoutMs,
    open,
  ]);

  const addEnvVar = () => {
    const name = envInput.trim();
    if (!ENV_VAR_PATTERN.test(name)) return;
    setEnvVars((current) => (current.includes(name) ? current : [...current, name]));
    setEnvInput("");
  };

  const saveExecutor = () => {
    onSave({
      ...delegation,
      executorCommand: command.trim(),
      queueTimeoutMs: secondsTextToMilliseconds(queueTimeoutSeconds, delegation.queueTimeoutMs),
      executionTimeoutMs: secondsTextToMilliseconds(
        executionTimeoutSeconds,
        delegation.executionTimeoutMs,
      ),
      executorEnvironmentVariables: envVars.filter((name) => ENV_VAR_PATTERN.test(name)),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("delegationSettings.executorDialogTitle")}</DialogTitle>
          <DialogDescription>{t("delegationSettings.executorDialogDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block space-y-1.5 text-xs">
            <span className="text-muted-foreground">{t("delegationSettings.executorCommand")}</span>
            <Input
              value={command}
              placeholder={t("delegationSettings.executorCommandPlaceholder")}
              onValueChange={setCommand}
              aria-label={t("delegationSettings.executorCommand")}
            />
            <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
              {t("delegationSettings.executorCommandDescription")}
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-xs">
              <span className="text-muted-foreground">
                {t("delegationSettings.queueTimeoutSeconds")}
              </span>
              <Input
                type="number"
                min={1}
                max={24 * 60 * 60}
                value={queueTimeoutSeconds}
                onValueChange={setQueueTimeoutSeconds}
                aria-label={t("delegationSettings.queueTimeoutSeconds")}
              />
              <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
                {t("delegationSettings.queueTimeoutSecondsDescription")}
              </span>
            </label>
            <label className="block space-y-1.5 text-xs">
              <span className="text-muted-foreground">
                {t("delegationSettings.executionTimeoutSeconds")}
              </span>
              <Input
                type="number"
                min={1}
                max={24 * 60 * 60}
                value={executionTimeoutSeconds}
                onValueChange={setExecutionTimeoutSeconds}
                aria-label={t("delegationSettings.executionTimeoutSeconds")}
              />
              <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
                {t("delegationSettings.executionTimeoutSecondsDescription")}
              </span>
            </label>
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  {t("delegationSettings.envVars")}
                </h3>
                <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground/80">
                  {t("delegationSettings.envVarsDescription")}
                </p>
              </div>
              <Badge variant="outline" size="sm">
                {t("delegationSettings.envVarsCount", { count: envVars.length })}
              </Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={envInput}
                placeholder="ANTHROPIC_API_KEY"
                onValueChange={setEnvInput}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addEnvVar();
                  }
                }}
                aria-label={t("delegationSettings.envVarInput")}
              />
              <Button
                size="compact"
                variant="outline"
                disabled={!ENV_VAR_PATTERN.test(envInput.trim())}
                onClick={addEnvVar}
              >
                <PlusIcon />
                {t("delegationSettings.addEnvVar")}
              </Button>
            </div>
            {envVars.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("delegationSettings.noEnvVars")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {envVars.map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-1 font-mono text-[11px] text-muted-foreground"
                  >
                    {name}
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      className="size-4 rounded-sm"
                      aria-label={`${t("delegationSettings.removeEnvVar")}: ${name}`}
                      onClick={() =>
                        setEnvVars((current) => current.filter((candidate) => candidate !== name))
                      }
                    >
                      <Trash2Icon className="size-2.5" />
                    </Button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" onClick={saveExecutor}>
            {t("delegationSettings.saveExecutor")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function VisionDelegationCard({
  adapters,
  config,
  onChange,
}: {
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
  readonly config: ByokDelegationConfig["visionDelegation"];
  readonly onChange: (patch: Partial<ByokDelegationConfig["visionDelegation"]>) => void;
}) {
  const selectedDisplayName = adapters.find(
    (adapter) => adapter.id === config.visionModelId,
  )?.displayName;
  const selectedModelLabel =
    selectedDisplayName || config.visionModelId || t("delegationSettings.visionModelEmpty");

  return (
    <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <EyeIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">
              {t("delegationSettings.visionTitle")}
            </h3>
            <Badge variant="secondary" size="sm">
              {t("delegationSettings.configurableStatus")}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {t("delegationSettings.visionDescription")}
          </p>
        </div>
        <Switch
          checked={config.enabled}
          disabled={config.visionModelId.trim().length === 0}
          onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
          aria-label={t("delegationSettings.visionEnabled")}
        />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("delegationSettings.visionModel")}</span>
          <Select
            value={config.visionModelId || "__none"}
            onValueChange={(value) => {
              const visionModelId = value === "__none" ? "" : (value ?? "");
              onChange({
                visionModelId,
                enabled: visionModelId.length > 0 ? config.enabled : false,
              });
            }}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>{selectedModelLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="__none">
                {t("delegationSettings.visionModelEmpty")}
              </SelectItem>
              {adapters.map((adapter) => (
                <SelectItem hideIndicator key={adapter.id} value={adapter.id}>
                  {adapterLabel(adapter)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
            {t("delegationSettings.visionModelDescription")}
          </span>
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("delegationSettings.visionMode")}</span>
          <Select
            value={config.mode}
            onValueChange={(value) =>
              onChange({
                mode: value === "describe" || value === "ocr" ? value : "auto",
              })
            }
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>
                {config.mode === "describe"
                  ? t("delegationSettings.visionModeDescribe")
                  : config.mode === "ocr"
                    ? t("delegationSettings.visionModeOcr")
                    : t("delegationSettings.visionModeAuto")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="auto">
                {t("delegationSettings.visionModeAuto")}
              </SelectItem>
              <SelectItem hideIndicator value="describe">
                {t("delegationSettings.visionModeDescribe")}
              </SelectItem>
              <SelectItem hideIndicator value="ocr">
                {t("delegationSettings.visionModeOcr")}
              </SelectItem>
            </SelectPopup>
          </Select>
          <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
            {t("delegationSettings.visionModeDescription")}
          </span>
        </label>
      </div>
    </div>
  );
}

function SupervisionCard({
  adapters,
  config,
  onChange,
}: {
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
  readonly config: ByokDelegationConfig["supervision"];
  readonly onChange: (patch: Partial<ByokDelegationConfig["supervision"]>) => void;
}) {
  const modelOptions = (selectedId: string) => (
    <>
      <SelectItem hideIndicator value="__none">
        {t("delegationSettings.supervisionModelEmpty")}
      </SelectItem>
      {adapters.map((adapter) => (
        <SelectItem hideIndicator key={adapter.id} value={adapter.id}>
          {adapterLabel(adapter)}
        </SelectItem>
      ))}
      {selectedId.trim().length > 0 && adapters.every((adapter) => adapter.id !== selectedId) ? (
        <SelectItem hideIndicator value={selectedId}>
          {selectedId}
        </SelectItem>
      ) : null}
    </>
  );
  const modelValueChange = (
    value: string | null | undefined,
    field: "supervisorModelId" | "reviewerModelId",
  ) => {
    onChange({ [field]: value === "__none" ? "" : (value ?? "") } as Partial<
      ByokDelegationConfig["supervision"]
    >);
  };
  const supervisorLabel =
    adapters.find((adapter) => adapter.id === config.supervisorModelId)?.displayName ||
    config.supervisorModelId ||
    t("delegationSettings.supervisionModelEmpty");
  const reviewerLabel =
    adapters.find((adapter) => adapter.id === config.reviewerModelId)?.displayName ||
    config.reviewerModelId ||
    t("delegationSettings.supervisionReviewerFollow");

  return (
    <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">
              {t("delegationSettings.supervisionTitle")}
            </h3>
            <Badge variant="secondary" size="sm">
              {t("delegationSettings.configurableStatus")}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {t("delegationSettings.supervisionDescription")}
          </p>
        </div>
        <Switch
          checked={config.enabled}
          disabled={config.supervisorModelId.trim().length === 0}
          onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
          aria-label={t("delegationSettings.supervisionEnabled")}
        />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">
            {t("delegationSettings.supervisionSupervisorModel")}
          </span>
          <Select
            value={config.supervisorModelId || "__none"}
            onValueChange={(value) => modelValueChange(value, "supervisorModelId")}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>{supervisorLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {modelOptions(config.supervisorModelId)}
            </SelectPopup>
          </Select>
          <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
            {t("delegationSettings.supervisionSupervisorModelDescription")}
          </span>
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">
            {t("delegationSettings.supervisionReviewerModel")}
          </span>
          <Select
            value={config.reviewerModelId || "__none"}
            onValueChange={(value) => modelValueChange(value, "reviewerModelId")}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>{reviewerLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {modelOptions(config.reviewerModelId)}
            </SelectPopup>
          </Select>
          <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
            {t("delegationSettings.supervisionReviewerModelDescription")}
          </span>
        </label>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {(
          [
            [
              "maxCorrections",
              "delegationSettings.supervisionMaxCorrections",
              "delegationSettings.supervisionMaxCorrectionsDescription",
            ],
            [
              "maxRetries",
              "delegationSettings.supervisionMaxRetries",
              "delegationSettings.supervisionMaxRetriesDescription",
            ],
            [
              "maxRounds",
              "delegationSettings.supervisionMaxRounds",
              "delegationSettings.supervisionMaxRoundsDescription",
            ],
          ] as const
        ).map(([field, labelKey, descriptionKey]) => (
          <label key={field} className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t(labelKey)}</span>
            <Input
              type="number"
              min={0}
              max={50}
              value={String(config[field])}
              disabled={!config.enabled}
              onValueChange={(value) =>
                onChange({
                  [field]: boundedInteger(value, config[field], field === "maxRounds" ? 1 : 0, 50),
                } as Partial<ByokDelegationConfig["supervision"]>)
              }
              aria-label={t(labelKey)}
            />
            <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
              {t(descriptionKey)}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 divide-y divide-border/60 rounded-lg border border-border/60">
        {(
          [
            [
              "allowReassign",
              "delegationSettings.supervisionAllowReassign",
              "delegationSettings.supervisionAllowReassignDescription",
            ],
            [
              "allowEscalate",
              "delegationSettings.supervisionAllowEscalate",
              "delegationSettings.supervisionAllowEscalateDescription",
            ],
            [
              "strictUnavailable",
              "delegationSettings.supervisionStrictUnavailable",
              "delegationSettings.supervisionStrictUnavailableDescription",
            ],
          ] as const
        ).map(([field, labelKey, descriptionKey]) => (
          <label key={field} className="flex items-start justify-between gap-3 px-3 py-2.5 text-xs">
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{t(labelKey)}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground/80">
                {t(descriptionKey)}
              </span>
            </span>
            <Switch
              checked={config[field]}
              disabled={!config.enabled}
              onCheckedChange={(checked) =>
                onChange({ [field]: Boolean(checked) } as Partial<
                  ByokDelegationConfig["supervision"]
                >)
              }
              aria-label={t(labelKey)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

const BUILTIN_SUBAGENT_TYPES = ["explore", "generalPurpose", "browserUse"] as const;

function SubagentProfilesEditor({
  profiles,
  onChange,
}: {
  readonly profiles: ByokDelegationConfig["subagentProfiles"];
  readonly onChange: (next: ByokDelegationConfig["subagentProfiles"]) => void;
}) {
  const updateProfile = (
    index: number,
    patch: Partial<ByokDelegationConfig["subagentProfiles"][number]>,
  ) =>
    onChange(
      profiles.map((profile, current) => (current === index ? { ...profile, ...patch } : profile)),
    );

  return (
    <div className="space-y-3">
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("delegationSettings.subagentsEmpty")}</p>
      ) : (
        profiles.map((profile, index) => (
          <div
            key={`${profile.subagentType}-${index}`}
            className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3"
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="block w-48 space-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("delegationSettings.subagentType")}
                </span>
                <Input
                  value={profile.subagentType}
                  placeholder={t("delegationSettings.subagentTypePlaceholder")}
                  list="byok-delegation-subagent-types"
                  onChange={(event) => updateProfile(index, { subagentType: event.target.value })}
                  aria-label={t("delegationSettings.subagentType")}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                aria-label={`${t("delegationSettings.subagentRemove")}: ${profile.subagentType}`}
                onClick={() => onChange(profiles.filter((_, current) => current !== index))}
              >
                <Trash2Icon />
                {t("delegationSettings.subagentRemove")}
              </Button>
            </div>
            <label className="mt-2 block space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("delegationSettings.subagentFragment")}
              </span>
              <Textarea
                className="min-h-20"
                value={profile.promptFragment}
                placeholder={t("delegationSettings.subagentFragmentPlaceholder")}
                onChange={(event) => updateProfile(index, { promptFragment: event.target.value })}
                aria-label={t("delegationSettings.subagentFragment")}
              />
              <span className="block text-[11px] leading-relaxed text-muted-foreground/80">
                {t("delegationSettings.subagentFragmentDescription")}
              </span>
            </label>
          </div>
        ))
      )}
      <datalist id="byok-delegation-subagent-types">
        {BUILTIN_SUBAGENT_TYPES.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange([...profiles, { subagentType: "", promptFragment: "" }])}
      >
        <PlusIcon />
        {t("delegationSettings.subagentAdd")}
      </Button>
    </div>
  );
}

/** Probe-state badge for one executor row (read-only view of the RPC result). */
const probeStateBadge = (probe: ByokDelegationExecutorProbe | undefined): ReactNode => {
  if (probe === undefined) {
    return (
      <Badge variant="outline" size="sm">
        {t("delegationSettings.probeStateUnknown")}
      </Badge>
    );
  }
  const label =
    probe.state === "ready"
      ? t("delegationSettings.probeStateReady")
      : probe.state === "not_installed"
        ? t("delegationSettings.probeStateNotInstalled")
        : probe.state === "unhealthy"
          ? t("delegationSettings.probeStateUnhealthy")
          : t("delegationSettings.probeStateUnknown");
  return (
    <Badge variant={probe.state === "ready" ? "secondary" : "outline"} size="sm">
      {label}
    </Badge>
  );
};

function ExecutorsEditor({
  executors,
  failoverLimit,
  probeResults,
  probingIds,
  onExecutorsChange,
  onFailoverLimitChange,
  onProbe,
}: {
  readonly executors: ByokDelegationConfig["executors"];
  readonly failoverLimit: number;
  readonly probeResults: ReadonlyMap<string, ByokDelegationExecutorProbe>;
  readonly probingIds: ReadonlySet<string>;
  readonly onExecutorsChange: (next: ByokDelegationConfig["executors"]) => void;
  readonly onFailoverLimitChange: (next: number) => void;
  readonly onProbe: (executorId: string) => void;
}) {
  const updateExecutor = (
    index: number,
    patch: Partial<ByokDelegationConfig["executors"][number]>,
  ) =>
    onExecutorsChange(
      executors.map((executor, current) =>
        current === index ? { ...executor, ...patch } : executor,
      ),
    );

  return (
    <div className="space-y-3">
      <SettingsRow
        title={t("delegationSettings.executorsListTitle")}
        description={t("delegationSettings.executorsListDescription")}
      />
      {executors.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("delegationSettings.executorsEmpty")}</p>
      ) : (
        executors.map((executor, index) => (
          <div
            key={executor.id}
            className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3"
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="block w-40 space-y-1 text-xs">
                <span className="text-muted-foreground">{t("delegationSettings.executorId")}</span>
                <Input
                  value={executor.id}
                  placeholder={t("delegationSettings.executorIdPlaceholder")}
                  aria-label={t("delegationSettings.executorId")}
                  onChange={(event) => updateExecutor(index, { id: event.target.value })}
                />
              </label>
              <label className="block w-40 space-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("delegationSettings.executorName")}
                </span>
                <Input
                  value={executor.name}
                  aria-label={t("delegationSettings.executorName")}
                  onChange={(event) => updateExecutor(index, { name: event.target.value })}
                />
              </label>
              <label className="block w-24 space-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("delegationSettings.executorPriority")}
                </span>
                <Input
                  type="number"
                  min={0}
                  value={executor.priority}
                  aria-label={t("delegationSettings.executorPriority")}
                  onChange={(event) =>
                    updateExecutor(index, {
                      priority: boundedInteger(event.target.value, 100, 0, 10_000),
                    })
                  }
                />
              </label>
              <label className="flex items-center gap-2 pb-1 text-xs">
                <Switch
                  checked={executor.enabled}
                  aria-label={t("delegationSettings.executorEnabled")}
                  onCheckedChange={(checked) => updateExecutor(index, { enabled: checked })}
                />
                <span className="text-muted-foreground">
                  {t("delegationSettings.executorEnabled")}
                </span>
              </label>
              <div className="ms-auto flex items-center gap-2">
                {probeStateBadge(probeResults.get(executor.id))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={probingIds.has(executor.id)}
                  aria-label={`${t("delegationSettings.executorProbe")}: ${executor.id}`}
                  onClick={() => onProbe(executor.id)}
                >
                  <ShieldCheckIcon />
                  {probingIds.has(executor.id)
                    ? t("delegationSettings.executorProbing")
                    : t("delegationSettings.executorProbe")}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`${t("delegationSettings.executorRemove")}: ${executor.id}`}
                  onClick={() =>
                    onExecutorsChange(executors.filter((_, current) => current !== index))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
            {probeResults.get(executor.id)?.diagnosticPreview ? (
              <p className="mt-2 break-words font-mono text-[11px] text-muted-foreground">
                {probeResults.get(executor.id)?.diagnosticPreview}
              </p>
            ) : null}
            <label className="mt-2 block space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("delegationSettings.executorCommand")}
              </span>
              <Input
                className="font-mono"
                value={executor.command}
                placeholder={t("delegationSettings.executorCommandPlaceholder")}
                aria-label={t("delegationSettings.executorCommand")}
                onChange={(event) => updateExecutor(index, { command: event.target.value })}
              />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <label className="block w-64 space-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("delegationSettings.executorProbeArguments")}
                </span>
                <Input
                  className="font-mono"
                  value={executor.probeArguments}
                  placeholder="--version"
                  aria-label={t("delegationSettings.executorProbeArguments")}
                  onChange={(event) =>
                    updateExecutor(index, { probeArguments: event.target.value })
                  }
                />
              </label>
              <label className="block min-w-64 flex-1 space-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("delegationSettings.executorEnvNames")}
                </span>
                <Input
                  value={executor.environmentVariables.join(", ")}
                  placeholder={t("delegationSettings.executorEnvNamesPlaceholder")}
                  aria-label={t("delegationSettings.executorEnvNames")}
                  onChange={(event) =>
                    updateExecutor(index, {
                      environmentVariables: event.target.value
                        .split(",")
                        .map((name) => name.trim())
                        .filter((name) => name.length > 0),
                    })
                  }
                />
              </label>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
              {t("delegationSettings.executorProbeArgumentsDescription")}
            </p>
          </div>
        ))
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onExecutorsChange([
              ...executors,
              {
                id: `executor-${executors.length + 1}`,
                name: "",
                enabled: true,
                priority: 100,
                command: "",
                environmentVariables: [],
                probeArguments: "",
              },
            ])
          }
        >
          <PlusIcon />
          {t("delegationSettings.executorAdd")}
        </Button>
        <label className="block w-40 space-y-1 text-xs">
          <span className="text-muted-foreground">
            {t("delegationSettings.executorFailoverLimit")}
          </span>
          <Input
            type="number"
            min={1}
            max={5}
            value={failoverLimit}
            aria-label={t("delegationSettings.executorFailoverLimit")}
            onChange={(event) =>
              onFailoverLimitChange(boundedInteger(event.target.value, 3, 1, 5))
            }
          />
        </label>
        <span className="pb-1 text-[11px] text-muted-foreground/80">
          {t("delegationSettings.executorFailoverLimitDescription")}
        </span>
      </div>
    </div>
  );
}

function EmptyDelegationState({ message }: { readonly message: string }) {
  return (
    <SettingsSection
      id="byok-delegation-settings"
      title={t("delegationSettings.globalTitle")}
      icon={<WorkflowIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow title={message} />
    </SettingsSection>
  );
}

/**
 * TCode 的 BYOK 委派真实配置仍按 provider instance 保存；这里把操作顺序还原为
 * cursor-byok 的设置流，但只开放当前后端已经读取并执行的字段。
 */
export function ByokDelegationWorkspacePanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const instances = (settings.providerInstances ?? {}) as Readonly<
    Record<string, ProviderInstanceConfig>
  >;
  const delegationInstances = useMemo(() => delegationInstancesFrom(instances), [instances]);
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const selectedInstance =
    delegationInstances.find((instance) => instance.instanceId === selectedInstanceId) ??
    delegationInstances[0] ??
    null;
  const delegation = selectedInstance?.delegation ?? DEFAULT_DELEGATION;
  const selectedModelGroup = delegation.modelGroups.find((group) => group.enabled);
  const selectedModelId =
    selectedModelGroup?.defaultModelId ?? selectedModelGroup?.modelIds[0] ?? "";
  const selectedModelName =
    selectedInstance?.adapters.find((adapter) => adapter.id === selectedModelId)?.displayName ??
    selectedModelId;
  const executorConfigured = delegation.executorCommand.trim().length > 0;
  const isConfigured = selectedInstance !== null && delegation.enabled && executorConfigured;
  const subagentTypeOptions = [
    ...BUILTIN_SUBAGENT_TYPES,
    ...delegation.subagentProfiles.map((profile) => profile.subagentType),
  ];

  const submitDelegation = useAtomCommand(byokEnvironment.submitDelegation, {
    reportFailure: false,
  });
  const listDelegations = useAtomCommand(byokEnvironment.listDelegations, {
    reportFailure: false,
  });
  const cancelDelegationCommand = useAtomCommand(byokEnvironment.cancelDelegation, {
    reportFailure: false,
  });
  const probeDelegationExecutorCommand = useAtomCommand(
    byokEnvironment.probeDelegationExecutor,
    { reportFailure: false },
  );
  const [task, setTask] = useState("");
  const [subagentType, setSubagentType] = useState("");
  const [delegations, setDelegations] = useState<ReadonlyArray<ByokDelegationSnapshot>>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [submittingCount, setSubmittingCount] = useState(0);
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [executorDialogOpen, setExecutorDialogOpen] = useState(false);
  const [probeResults, setProbeResults] = useState<ReadonlyMap<string, ByokDelegationExecutorProbe>>(
    () => new Map(),
  );
  const [probingIds, setProbingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGroupIds, setExpandedGroupIds] = useState<ReadonlySet<string>>(() => new Set());

  const updateSelectedDelegation = useCallback(
    (next: ByokDelegationConfig) => {
      if (selectedInstance === null) return;
      const instance = instances[selectedInstance.instanceId];
      if (instance === undefined) return;
      updateSettings({
        providerInstances: {
          ...instances,
          [selectedInstance.instanceId]: {
            ...instance,
            config: {
              ...(isRecord(instance.config) ? instance.config : {}),
              delegation: next,
            },
          } as ProviderInstanceConfig,
        } as ServerSettings["providerInstances"],
      });
    },
    [instances, selectedInstance, updateSettings],
  );

  const patchDelegation = (patch: Partial<ByokDelegationConfig>) =>
    updateSelectedDelegation({ ...delegation, ...patch });

  const refreshDelegations = useCallback(async () => {
    if (environmentId === null || selectedInstance === null) {
      setDelegations([]);
      return;
    }
    setRefreshing(true);
    try {
      const result = await listDelegations({
        environmentId,
        input: { instanceId: selectedInstance.instanceId },
      });
      if (AsyncResult.isSuccess(result)) {
        setDelegations(result.value.delegations);
        setActionError(null);
      } else {
        setActionError(t("delegationWorkspace.refreshError"));
      }
    } finally {
      setRefreshing(false);
    }
  }, [environmentId, listDelegations, selectedInstance]);

  useEffect(() => {
    void refreshDelegations();
  }, [refreshDelegations]);

  const hasActiveDelegations =
    submittingCount > 0 || delegations.some((delegationSnapshot) => isActive(delegationSnapshot));
  useEffect(() => {
    if (!hasActiveDelegations) return;
    const timer = window.setInterval(() => void refreshDelegations(), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveDelegations, refreshDelegations]);

  const createDelegation = () => {
    const taskText = task.trim();
    if (environmentId === null || selectedInstance === null || !isConfigured || taskText === "") {
      return;
    }
    const selectedType = subagentType.trim();
    setTask("");
    setActionError(null);
    setSubmittingCount((count) => count + 1);
    void submitDelegation({
      environmentId,
      input: {
        instanceId: selectedInstance.instanceId,
        task: taskText,
        ...(selectedType.length > 0 ? { subagentType: selectedType } : {}),
      },
    })
      .then((result) => {
        if (AsyncResult.isSuccess(result)) {
          setDelegations((current) => {
            const withoutSameId = current.filter(
              (delegationSnapshot) => delegationSnapshot.id !== result.value.id,
            );
            return [result.value, ...withoutSameId];
          });
          return;
        }
        setActionError(t("delegationWorkspace.submitError"));
      })
      .finally(() => {
        setSubmittingCount((count) => Math.max(0, count - 1));
        void refreshDelegations();
      });
  };

  const cancelDelegationRun = async (delegationId: string) => {
    if (environmentId === null || selectedInstance === null) return;
    if (cancellingIds.has(delegationId)) return;
    setCancellingIds((current) => new Set(current).add(delegationId));
    setActionError(null);
    try {
      const result = await cancelDelegationCommand({
        environmentId,
        input: { instanceId: selectedInstance.instanceId, delegationId },
      });
      if (AsyncResult.isSuccess(result) && result.value.snapshot !== null) {
        const snapshot = result.value.snapshot;
        setDelegations((current) => [
          snapshot,
          ...current.filter((candidate) => candidate.id !== snapshot.id),
        ]);
      } else {
        setActionError(t("delegationWorkspace.cancelError"));
      }
    } finally {
      setCancellingIds((current) => {
        const next = new Set(current);
        next.delete(delegationId);
        return next;
      });
      void refreshDelegations();
    }
  };

  const probeExecutor = async (executorId: string) => {
    if (environmentId === null || selectedInstance === null) return;
    if (probingIds.has(executorId)) return;
    setProbingIds((current) => new Set(current).add(executorId));
    try {
      const result = await probeDelegationExecutorCommand({
        environmentId,
        input: { instanceId: selectedInstance.instanceId, executorId },
      });
      if (AsyncResult.isSuccess(result) && result.value.probe !== null) {
        const probe = result.value.probe;
        setProbeResults((current) => new Map(current).set(probe.executorId, probe));
      } else {
        setActionError(t("delegationWorkspace.probeError"));
      }
    } finally {
      setProbingIds((current) => {
        const next = new Set(current);
        next.delete(executorId);
        return next;
      });
    }
  };

  const addModelGroup = () => {
    const group = createModelGroup(delegation.modelGroups, selectedInstance?.adapters ?? []);
    patchDelegation({ modelGroups: [...delegation.modelGroups, group] });
    setExpandedGroupIds((current) => new Set([...current, group.id]));
  };

  const deleteModelGroup = (groupId: string) => {
    patchDelegation({
      modelGroups: delegation.modelGroups.filter((group) => group.id !== groupId),
    });
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
  };

  const moveModelGroup = (groupId: string, direction: "up" | "down") => {
    const index = delegation.modelGroups.findIndex((group) => group.id === groupId);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= delegation.modelGroups.length) return;
    const nextGroups = [...delegation.modelGroups];
    const [group] = nextGroups.splice(index, 1);
    if (group === undefined) return;
    nextGroups.splice(nextIndex, 0, group);
    patchDelegation({ modelGroups: nextGroups });
  };

  const patchModelGroup = (groupId: string, patch: Partial<DelegationModelGroup>) => {
    updateSelectedDelegation(
      updateGroup(delegation, groupId, (group) => {
        const nextModelIds = patch.modelIds ?? group.modelIds;
        const hasDefaultModelPatch = Object.prototype.hasOwnProperty.call(patch, "defaultModelId");
        const requestedDefault = hasDefaultModelPatch ? patch.defaultModelId : group.defaultModelId;
        const defaultModelId =
          requestedDefault !== undefined && nextModelIds.includes(requestedDefault)
            ? requestedDefault
            : nextModelIds[0];

        return groupWithDefaultModel(
          { ...group, ...patch, modelIds: nextModelIds },
          defaultModelId,
        );
      }),
    );
  };

  if (environmentId === null) {
    return <EmptyDelegationState message={t("delegationWorkspace.noEnvironment")} />;
  }
  if (delegationInstances.length === 0 || selectedInstance === null) {
    return <EmptyDelegationState message={t("delegationWorkspace.noByokInstance")} />;
  }

  return (
    <div className="space-y-8" aria-label={t("delegationWorkspace.title")}>
      <SettingsSection
        id="byok-delegation-settings"
        title={t("delegationSettings.globalTitle")}
        icon={<WorkflowIcon className="size-4 text-muted-foreground" />}
      >
        <SettingsRow
          title={t("delegationSettings.instanceTitle")}
          description={t("delegationSettings.instanceDescription")}
          status={
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant={isConfigured ? "secondary" : "outline"} size="sm">
                {isConfigured
                  ? t("delegationWorkspace.ready")
                  : t("delegationWorkspace.notConfigured")}
              </Badge>
              <Badge variant="outline" size="sm">
                {t("delegationWorkspace.concurrency", { count: delegation.maxConcurrency })}
              </Badge>
              {selectedModelName ? (
                <Badge variant="outline" size="sm">
                  {selectedModelName}
                </Badge>
              ) : null}
            </span>
          }
          control={
            delegationInstances.length <= 1 ? (
              <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {selectedInstance.instanceId}
              </code>
            ) : (
              <Select
                value={selectedInstance.instanceId}
                onValueChange={(value) => setSelectedInstanceId(value ?? "")}
              >
                <SelectTrigger className="w-72 max-w-full" size="sm">
                  <SelectValue>{selectedInstance.displayName}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {delegationInstances.map((instance) => (
                    <SelectItem hideIndicator key={instance.instanceId} value={instance.instanceId}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{instance.displayName}</span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {instance.instanceId}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )
          }
        />
        <SettingsRow
          title={t("delegationSettings.enabled")}
          description={t("delegationSettings.enabledDescription")}
          control={
            <Switch
              checked={delegation.enabled}
              onCheckedChange={(checked) => patchDelegation({ enabled: Boolean(checked) })}
              aria-label={t("delegationSettings.enabled")}
            />
          }
        />
        <SettingsRow
          title={t("delegationSettings.maxConcurrency")}
          description={t("delegationSettings.maxConcurrencyDescription")}
          control={
            <Input
              className="w-28"
              type="number"
              min={1}
              max={16}
              size="sm"
              value={String(delegation.maxConcurrency)}
              onValueChange={(value) =>
                patchDelegation({
                  maxConcurrency: boundedInteger(value, delegation.maxConcurrency, 1, 16),
                })
              }
              aria-label={t("delegationSettings.maxConcurrency")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="byok-delegation-executors"
        title={t("delegationSettings.executorsTitle")}
        icon={<WrenchIcon className="size-4 text-muted-foreground" />}
      >
        <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/10">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
            <div className="text-xs text-muted-foreground">
              {t("delegationSettings.executorCount", {
                count: 1 + delegation.executors.filter((executor) => executor.enabled).length,
              })}
            </div>
            <Badge variant="outline" size="sm">
              {t("delegationSettings.customExecutor")}
            </Badge>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {t("delegationSettings.customExecutor")}
                </span>
                <Badge variant={executorConfigured ? "secondary" : "outline"} size="sm">
                  {executorConfigured
                    ? t("delegationSettings.executorConfigured")
                    : t("delegationSettings.executorNotConfigured")}
                </Badge>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="max-w-full truncate font-mono">
                  {executorConfigured
                    ? delegation.executorCommand
                    : t("delegationSettings.executorCommandEmpty")}
                </span>
                <span>
                  {t("delegationSettings.queueTimeoutSummary", {
                    seconds: millisecondsToSecondsText(delegation.queueTimeoutMs),
                  })}
                </span>
                <span>
                  {t("delegationSettings.executionTimeoutSummary", {
                    seconds: millisecondsToSecondsText(delegation.executionTimeoutMs),
                  })}
                </span>
                <span>
                  {t("delegationSettings.executorEnvSummary", {
                    count: delegation.executorEnvironmentVariables.length,
                  })}
                </span>
              </div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label={t("delegationSettings.configureExecutor")}
              onClick={() => setExecutorDialogOpen(true)}
            >
              <WrenchIcon />
            </Button>
          </div>
        </div>
        <div className="px-3 pb-3 pt-1 sm:px-4">
          <ExecutorsEditor
            executors={delegation.executors}
            failoverLimit={delegation.executorFailoverLimit}
            probeResults={probeResults}
            probingIds={probingIds}
            onExecutorsChange={(next) => patchDelegation({ executors: next })}
            onFailoverLimitChange={(next) => patchDelegation({ executorFailoverLimit: next })}
            onProbe={(executorId) => void probeExecutor(executorId)}
          />
        </div>
      </SettingsSection>
      <ExecutorConfigurationDialog
        open={executorDialogOpen}
        delegation={delegation}
        onOpenChange={setExecutorDialogOpen}
        onSave={updateSelectedDelegation}
      />

      <SettingsSection
        id="byok-delegation-task"
        title={t("delegationSettings.taskTitle")}
        icon={<SendIcon className="size-4 text-muted-foreground" />}
      >
        <SettingsRow
          title={t("delegationSettings.taskEntry")}
          description={t("delegationSettings.taskDescription")}
          status={actionError === null ? undefined : actionError}
        />
        <div className="grid gap-5 px-3 pb-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-3">
            <label className="block text-xs" htmlFor="byok-delegation-task-input">
              <span className="mb-1 block text-muted-foreground">
                {t("delegationWorkspace.task")}
              </span>
              <Textarea
                id="byok-delegation-task-input"
                className="min-h-32"
                value={task}
                placeholder={t("delegationWorkspace.taskPlaceholder")}
                disabled={!isConfigured}
                onChange={(event) => setTask(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block w-56 space-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("delegationWorkspace.subagentType")}
                </span>
                <Select
                  value={subagentType || "__none"}
                  onValueChange={(value) =>
                    setSubagentType(value === "__none" ? "" : (value ?? ""))
                  }
                >
                  <SelectTrigger className="w-full" size="sm">
                    <SelectValue>
                      {subagentType || t("delegationWorkspace.subagentTypeNone")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="__none">
                      {t("delegationWorkspace.subagentTypeNone")}
                    </SelectItem>
                    {[...new Set([...subagentTypeOptions, subagentType].filter(Boolean))].map(
                      (type) => (
                        <SelectItem hideIndicator key={type} value={type}>
                          {type}
                        </SelectItem>
                      ),
                    )}
                  </SelectPopup>
                </Select>
              </label>
              <div className="flex flex-wrap items-center gap-2 pb-0.5">
                <Button
                  size="sm"
                  disabled={!isConfigured || task.trim().length === 0}
                  onClick={createDelegation}
                >
                  <SendIcon />
                  {t("delegationWorkspace.submit")}
                </Button>
                {submittingCount > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t("delegationWorkspace.submitting", { count: submittingCount })}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <aside className="min-w-0 rounded-lg border border-border/60 bg-muted/15 px-3 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BotIcon className="size-3.5" />
              <span className="truncate">{selectedInstance.displayName}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge variant={isConfigured ? "secondary" : "outline"}>
                {isConfigured
                  ? t("delegationWorkspace.ready")
                  : t("delegationWorkspace.notConfigured")}
              </Badge>
              <Badge variant="outline">
                {t("delegationWorkspace.concurrency", {
                  count: delegation.maxConcurrency,
                })}
              </Badge>
              {selectedModelName ? <Badge variant="outline">{selectedModelName}</Badge> : null}
            </div>
          </aside>
        </div>
        <div className="border-t border-border/60 px-3 pt-5 pb-3 sm:px-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ListRestartIcon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium text-foreground">
                {t("delegationWorkspace.runs")}
              </h3>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={() => void refreshDelegations()}
            >
              <ListRestartIcon />
              {t("delegationWorkspace.refresh")}
            </Button>
          </div>
          {delegations.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("delegationWorkspace.noRuns")}</p>
          ) : (
            <ul className="divide-y divide-border/60 border-y border-border/60">
              {delegations.map((delegationSnapshot) => (
                <li
                  key={`${delegationSnapshot.id}-${delegationSnapshot.submittedAt}`}
                  className="py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="outline">{statusLabel(delegationSnapshot.status)}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {delegationSnapshot.taskPreview}
                    </span>
                    <code className="text-[11px] text-muted-foreground">
                      {delegationSnapshot.id}
                    </code>
                    {delegationSnapshot.supervision !== undefined ? (
                      <Badge variant="outline" size="sm">
                        {t("delegationWorkspace.supervisionBadge", {
                          round: delegationSnapshot.supervision.round,
                          corrections: delegationSnapshot.supervision.corrections,
                          retries: delegationSnapshot.supervision.retries,
                          reassigns: delegationSnapshot.supervision.reassigns,
                          escalates: delegationSnapshot.supervision.escalates,
                        })}
                      </Badge>
                    ) : null}
                    {(delegationSnapshot.executorAttempts?.length ?? 0) > 1 ? (
                      <Badge variant="outline" size="sm">
                        {t("delegationWorkspace.attemptsBadge", {
                          chain: (delegationSnapshot.executorAttempts ?? [])
                            .map(
                              (attempt) =>
                                `${attempt.executorId}:${
                                  attempt.status === "completed"
                                    ? t("delegationWorkspace.attemptCompleted")
                                    : attempt.status === "failed"
                                      ? t("delegationWorkspace.attemptFailed")
                                      : t("delegationWorkspace.attemptSkipped")
                                }`,
                            )
                            .join(" → "),
                        })}
                      </Badge>
                    ) : null}
                    {isActive(delegationSnapshot) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancellingIds.has(delegationSnapshot.id)}
                        aria-label={`${t("delegationWorkspace.cancel")}: ${delegationSnapshot.taskPreview}`}
                        onClick={() => void cancelDelegationRun(delegationSnapshot.id)}
                      >
                        {cancellingIds.has(delegationSnapshot.id)
                          ? t("delegationWorkspace.cancelling")
                          : t("delegationWorkspace.cancel")}
                      </Button>
                    ) : null}
                  </div>
                  {delegationSnapshot.resultPreview ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                      {delegationSnapshot.resultPreview}
                    </p>
                  ) : null}
                  {delegationSnapshot.errorMessage ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">
                      {delegationSnapshot.errorMessage}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>

      <CollapsibleSettingsBlock
        title={t("delegationSettings.advancedTitle")}
        description={t("delegationSettings.advancedDescription")}
        icon={<ShieldCheckIcon className="size-3.5" />}
      >
        <SupervisionCard
          adapters={selectedInstance.adapters}
          config={delegation.supervision}
          onChange={(patch) =>
            patchDelegation({ supervision: { ...delegation.supervision, ...patch } })
          }
        />
        <VisionDelegationCard
          adapters={selectedInstance.adapters}
          config={delegation.visionDelegation}
          onChange={(patch) =>
            patchDelegation({
              visionDelegation: { ...delegation.visionDelegation, ...patch },
            })
          }
        />
      </CollapsibleSettingsBlock>

      <CollapsibleSettingsBlock
        title={t("delegationSettings.modelGroupsTitle")}
        description={t("delegationSettings.modelGroupsDescription")}
        icon={<WorkflowIcon className="size-3.5" />}
        action={
          <Button size="sm" variant="outline" onClick={addModelGroup}>
            <PlusIcon />
            {t("delegationSettings.addModelGroup")}
          </Button>
        }
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {t("delegationSettings.modelGroupCount", { count: delegation.modelGroups.length })}
          </span>
          <span>
            {t("delegationSettings.availableModelCount", {
              count: selectedInstance.adapters.length,
            })}
          </span>
        </div>
        {delegation.modelGroups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-xs text-muted-foreground">
            {t("delegationSettings.noModelGroups")}
          </div>
        ) : (
          <div className="space-y-3">
            {delegation.modelGroups.map((group, groupIndex) => {
              const expanded = expandedGroupIds.has(group.id);
              const selectedNames = selectedInstance.adapters
                .filter((adapter) => group.modelIds.includes(adapter.id))
                .map(adapterLabel);
              const defaultModelLabel =
                selectedInstance.adapters.find((adapter) => adapter.id === group.defaultModelId)
                  ?.displayName ??
                group.defaultModelId ??
                t("delegationSettings.defaultModelEmpty");
              return (
                <article
                  key={group.id}
                  className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? t("delegationSettings.collapseGroup", { name: group.name })
                          : t("delegationSettings.expandGroup", { name: group.name })
                      }
                      onClick={() =>
                        setExpandedGroupIds((current) => {
                          const next = new Set(current);
                          if (next.has(group.id)) {
                            next.delete(group.id);
                          } else {
                            next.add(group.id);
                          }
                          return next;
                        })
                      }
                    >
                      {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                    </Button>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-sm font-medium text-foreground">
                          {group.name}
                        </h3>
                        <Badge variant={group.enabled ? "secondary" : "outline"} size="sm">
                          {group.enabled
                            ? t("delegationSettings.groupEnabled")
                            : t("delegationSettings.groupDisabled")}
                        </Badge>
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>
                          {t("delegationSettings.groupModelCount", {
                            count: selectedNames.length,
                          })}
                        </span>
                        <span>
                          {t("delegationSettings.groupDefaultModel", { model: defaultModelLabel })}
                        </span>
                        <span>{t("delegationSettings.executionModeAuto")}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        disabled={groupIndex === 0}
                        aria-label={t("moveUp")}
                        onClick={() => moveModelGroup(group.id, "up")}
                      >
                        <ChevronUpIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        disabled={groupIndex >= delegation.modelGroups.length - 1}
                        aria-label={t("moveDown")}
                        onClick={() => moveModelGroup(group.id, "down")}
                      >
                        <ChevronDownIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("delete")}
                        onClick={() => deleteModelGroup(group.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <label className="flex w-full items-center justify-between gap-3 text-xs text-muted-foreground sm:w-48">
                      <span>{t("delegationSettings.enableGroup")}</span>
                      <Switch
                        checked={group.enabled}
                        onCheckedChange={(checked) =>
                          patchModelGroup(group.id, { enabled: Boolean(checked) })
                        }
                        aria-label={t("delegationSettings.enableGroup")}
                      />
                    </label>
                  </div>

                  {expanded ? (
                    <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
                      <label className="block space-y-1 text-xs">
                        <span className="text-muted-foreground">
                          {t("delegationSettings.groupName")}
                        </span>
                        <Input
                          value={group.name}
                          onValueChange={(value) =>
                            patchModelGroup(group.id, {
                              name:
                                value.trim() ||
                                t("delegationSettings.defaultGroupName", {
                                  index: groupIndex + 1,
                                }),
                            })
                          }
                          aria-label={t("delegationSettings.groupName")}
                        />
                      </label>
                      <div className="grid gap-3 lg:grid-cols-2">
                        <label className="block space-y-1 text-xs">
                          <span className="text-muted-foreground">
                            {t("delegationSettings.executionMode")}
                          </span>
                          <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                            {t("delegationSettings.executionModeDescription")}
                          </div>
                        </label>
                        <label className="block space-y-1 text-xs">
                          <span className="text-muted-foreground">
                            {t("delegationSettings.defaultModel")}
                          </span>
                          <Select
                            value={group.defaultModelId ?? "__none"}
                            onValueChange={(value) => {
                              const modelId = value === "__none" ? undefined : (value ?? undefined);
                              patchModelGroup(group.id, {
                                defaultModelId: modelId,
                                modelIds:
                                  modelId === undefined || group.modelIds.includes(modelId)
                                    ? group.modelIds
                                    : [...group.modelIds, modelId],
                              });
                            }}
                          >
                            <SelectTrigger className="w-full" size="sm">
                              <SelectValue>{defaultModelLabel}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup align="start" alignItemWithTrigger={false}>
                              <SelectItem hideIndicator value="__none">
                                {t("delegationSettings.defaultModelEmpty")}
                              </SelectItem>
                              {selectedInstance.adapters
                                .filter((adapter) => group.modelIds.includes(adapter.id))
                                .map((adapter) => (
                                  <SelectItem hideIndicator key={adapter.id} value={adapter.id}>
                                    {adapterLabel(adapter)}
                                  </SelectItem>
                                ))}
                            </SelectPopup>
                          </Select>
                        </label>
                      </div>
                      <div className="space-y-2 border-t border-border/60 pt-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-xs font-medium text-muted-foreground">
                            {t("delegationSettings.availableModels")}
                          </h4>
                          <Badge variant="outline" size="sm">
                            {selectedNames.length}
                          </Badge>
                        </div>
                        {selectedInstance.adapters.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
                            {t("delegationSettings.noAdapters")}
                          </p>
                        ) : (
                          <div className="grid max-h-80 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
                            {selectedInstance.adapters.map((adapter) => {
                              const selected = group.modelIds.includes(adapter.id);
                              return (
                                <label
                                  key={adapter.id}
                                  className="flex min-w-0 items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
                                >
                                  <Checkbox
                                    checked={selected}
                                    onCheckedChange={(checked) =>
                                      patchModelGroup(
                                        group.id,
                                        toggleModelInGroup(group, adapter.id, Boolean(checked)),
                                      )
                                    }
                                    aria-label={adapterLabel(adapter)}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium text-foreground">
                                      {adapterLabel(adapter)}
                                    </span>
                                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                                      {adapter.modelId}
                                    </span>
                                    {adapter.groupName ? (
                                      <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                        {adapter.groupName}
                                      </span>
                                    ) : null}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                        {t("delegationSettings.toolPermissionsDescription")}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </CollapsibleSettingsBlock>

      <SettingsSection
        id="byok-delegation-subagents"
        title={t("delegationSettings.subagentsTitle")}
        icon={<UserRoundCogIcon className="size-4 text-muted-foreground" />}
      >
        <SettingsRow
          title={t("delegationSettings.subagentsEditorTitle")}
          description={t("delegationSettings.subagentsDescription")}
        />
        <SubagentProfilesEditor
          profiles={delegation.subagentProfiles}
          onChange={(subagentProfiles) => patchDelegation({ subagentProfiles })}
        />
      </SettingsSection>

      <div className="flex justify-end px-3 sm:px-4">
        <Button size="sm" variant="outline" onClick={() => void refreshDelegations()}>
          <RotateCcwIcon />
          {t("delegationSettings.refreshDelegationState")}
        </Button>
      </div>
    </div>
  );
}

export const __testables = {
  createModelGroup,
  delegationInstancesFrom,
  millisecondsToSecondsText,
  readDelegationConfig,
  secondsTextToMilliseconds,
  statusLabel,
  toggleModelInGroup,
};
