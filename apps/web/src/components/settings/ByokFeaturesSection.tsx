"use client";

import { useState } from "react";
import type {
  ByokAdaptersImportResult,
  ByokBalanceResult,
  ByokDelegationConfig,
  ByokDelegationSnapshot,
  ByokModelAdapter,
  ByokPromptTemplateConfig,
} from "@t3tools/contracts";

import { byokEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "~/i18n";
import { AsyncResult } from "effect/unstable/reactivity";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface ByokFeaturesSectionProps {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
  readonly promptTemplate: ByokPromptTemplateConfig;
  readonly delegation: ByokDelegationConfig;
  readonly onPromptTemplateChange: (next: ByokPromptTemplateConfig) => void;
  readonly onDelegationChange: (next: ByokDelegationConfig) => void;
}

const DEFAULT_PROMPT_TEMPLATE: ByokPromptTemplateConfig = {
  enabled: false,
  softwareChineseEnabled: false,
  mode: "append",
  selectedTemplate: "",
  customEnabled: false,
  customContent: "",
  sourceUrl: "",
};

const DEFAULT_DELEGATION: ByokDelegationConfig = {
  enabled: false,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
};

const formatMoney = (value: number | undefined, currency: string): string =>
  value === undefined ? "—" : `${currency === "USD" ? "$" : `${currency} `}${value.toFixed(2)}`;

function balanceSummary(result: ByokBalanceResult | undefined): string {
  if (result === undefined) return "";
  if (!result.supported) return result.error?.message ?? result.message;
  if (result.unlimited) return t("byokFeatures.balanceUnlimited");
  const parts: string[] = [];
  if (result.remaining !== undefined) {
    parts.push(
      `${t("byokFeatures.balanceRemaining")} ${formatMoney(result.remaining, result.currency)}`,
    );
  }
  if (result.used !== undefined && result.total !== undefined) {
    parts.push(`${t("byokFeatures.balanceUsed")} ${formatMoney(result.used, result.currency)}`);
  }
  return parts.join(" · ") || result.message;
}

/**
 * BYOK auxiliary features: per-adapter balance query, prompt-template
 * injection, and delegation configuration. Balance queries resolve
 * server-side credentials; this component only ever sees normalized numbers.
 */
export function ByokFeaturesSection(props: ByokFeaturesSectionProps) {
  const balanceCommand = useAtomCommand(byokEnvironment.balance, { reportFailure: false });
  const [balance, setBalance] = useState<Record<string, ByokBalanceResult | undefined>>({});
  const [queryingAdapterId, setQueryingAdapterId] = useState<string | null>(null);
  const [executorEnvInput, setExecutorEnvInput] = useState("");

  const submitDelegationCommand = useAtomCommand(byokEnvironment.submitDelegation, {
    reportFailure: false,
  });
  const listDelegationsCommand = useAtomCommand(byokEnvironment.listDelegations, {
    reportFailure: false,
  });
  const importCommand = useAtomCommand(byokEnvironment.importAdapters, { reportFailure: false });
  const [delegationTask, setDelegationTask] = useState("");
  const [submittingDelegation, setSubmittingDelegation] = useState(false);
  const [delegations, setDelegations] = useState<ReadonlyArray<ByokDelegationSnapshot>>([]);
  const [importYaml, setImportYaml] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ByokAdaptersImportResult | null>(null);

  const submitDelegation = async () => {
    const task = delegationTask.trim();
    if (!task) return;
    setSubmittingDelegation(true);
    try {
      await submitDelegationCommand({
        environmentId: props.environmentId as never,
        input: { instanceId: props.instanceId, task },
      });
      setDelegationTask("");
      const listed = await listDelegationsCommand({
        environmentId: props.environmentId as never,
        input: { instanceId: props.instanceId },
      });
      setDelegations(AsyncResult.isSuccess(listed) ? listed.value.delegations : []);
    } finally {
      setSubmittingDelegation(false);
    }
  };

  const runImport = async () => {
    const yamlText = importYaml.trim();
    if (!yamlText) return;
    setImporting(true);
    try {
      const result = await importCommand({
        environmentId: props.environmentId as never,
        input: { instanceId: props.instanceId, yaml: yamlText },
      });
      setImportResult(AsyncResult.isSuccess(result) ? result.value : null);
      if (AsyncResult.isSuccess(result) && result.value.imported > 0) {
        setImportYaml("");
      }
    } finally {
      setImporting(false);
    }
  };

  const queryBalance = async (adapter: ByokModelAdapter) => {
    setQueryingAdapterId(adapter.id);
    try {
      const result = await balanceCommand({
        environmentId: props.environmentId as never,
        input: { instanceId: props.instanceId, adapterId: adapter.id, forceRefresh: true },
      });
      setBalance((current) => ({
        ...current,
        [adapter.id]: AsyncResult.isSuccess(result) ? result.value : undefined,
      }));
    } finally {
      setQueryingAdapterId(null);
    }
  };

  const patchPromptTemplate = (patch: Partial<ByokPromptTemplateConfig>) =>
    props.onPromptTemplateChange({ ...DEFAULT_PROMPT_TEMPLATE, ...props.promptTemplate, ...patch });

  const patchDelegation = (patch: Partial<ByokDelegationConfig>) =>
    props.onDelegationChange({ ...DEFAULT_DELEGATION, ...props.delegation, ...patch });

  const addExecutorEnvVar = () => {
    const name = executorEnvInput.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    if (props.delegation.executorEnvironmentVariables.includes(name)) {
      setExecutorEnvInput("");
      return;
    }
    patchDelegation({
      executorEnvironmentVariables: [...props.delegation.executorEnvironmentVariables, name],
    });
    setExecutorEnvInput("");
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="text-sm font-medium">{t("byokFeatures.balanceTitle")}</h4>
        {props.adapters.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("byokFeatures.balanceNoAdapters")}</p>
        ) : (
          <ul className="space-y-2">
            {props.adapters.map((adapter) => {
              const result = balance[adapter.id];
              return (
                <li
                  key={adapter.id}
                  className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className="font-medium">{adapter.displayName}</span>
                    {result !== undefined ? (
                      <span className="text-muted-foreground"> — {balanceSummary(result)}</span>
                    ) : null}
                  </span>
                  {result !== undefined && result.planName ? (
                    <Badge variant="outline">{result.planName}</Badge>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={queryingAdapterId !== null || adapter.apiKeyRedacted !== true}
                    onClick={() => void queryBalance(adapter)}
                  >
                    {queryingAdapterId === adapter.id
                      ? t("byokFeatures.balanceQuerying")
                      : t("byokFeatures.balanceQuery")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-medium">{t("byokFeatures.promptTemplateTitle")}</h4>
        <p className="text-muted-foreground text-xs">
          {t("byokFeatures.promptTemplateDescription")}
        </p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={props.promptTemplate.softwareChineseEnabled}
              onChange={(event) =>
                patchPromptTemplate({ softwareChineseEnabled: event.target.checked })
              }
            />
            {t("byokFeatures.promptTemplateChinese")}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={props.promptTemplate.customEnabled}
              onChange={(event) => patchPromptTemplate({ customEnabled: event.target.checked })}
            />
            {t("byokFeatures.promptTemplateCustom")}
          </label>
          {props.promptTemplate.customEnabled ? (
            <textarea
              className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-xs"
              placeholder={t("byokFeatures.promptTemplateCustomPlaceholder")}
              value={props.promptTemplate.customContent}
              onChange={(event) => patchPromptTemplate({ customContent: event.target.value })}
            />
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-medium">{t("byokFeatures.delegationTitle")}</h4>
        <p className="text-muted-foreground text-xs">{t("byokFeatures.delegationDescription")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted-foreground mb-1 block">
              {t("byokFeatures.delegationConcurrency")}
            </span>
            <Input
              type="number"
              min={1}
              max={16}
              value={props.delegation.maxConcurrency}
              onChange={(event) =>
                patchDelegation({
                  maxConcurrency: Math.max(1, Math.min(16, Number(event.target.value) || 4)),
                })
              }
            />
          </label>
          <label className="text-xs">
            <span className="text-muted-foreground mb-1 block">
              {t("byokFeatures.delegationExecutorCommand")}
            </span>
            <Input
              value={props.delegation.executorCommand}
              placeholder="claude"
              onChange={(event) => patchDelegation({ executorCommand: event.target.value })}
            />
          </label>
        </div>
        <div className="space-y-2">
          <span className="text-muted-foreground text-xs">
            {t("byokFeatures.delegationEnvVars")}
          </span>
          <div className="flex gap-2">
            <Input
              value={executorEnvInput}
              placeholder="ANTHROPIC_API_KEY"
              onChange={(event) => setExecutorEnvInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addExecutorEnvVar();
                }
              }}
            />
            <Button size="sm" variant="outline" onClick={addExecutorEnvVar}>
              {t("byokFeatures.delegationAddEnvVar")}
            </Button>
          </div>
          {props.delegation.executorEnvironmentVariables.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {props.delegation.executorEnvironmentVariables.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="bg-muted hover:bg-accent rounded px-2 py-0.5 font-mono text-[11px]"
                  title={t("byokFeatures.delegationRemoveEnvVar")}
                  onClick={() =>
                    patchDelegation({
                      executorEnvironmentVariables:
                        props.delegation.executorEnvironmentVariables.filter(
                          (candidate) => candidate !== name,
                        ),
                    })
                  }
                >
                  {name} ×
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {props.delegation.enabled && props.delegation.executorCommand.trim().length > 0 ? (
          <div className="space-y-2 border-t border-border/60 pt-3">
            <span className="text-muted-foreground text-xs">
              {t("byokFeatures.delegationRunTask")}
            </span>
            <div className="flex gap-2">
              <Input
                value={delegationTask}
                placeholder={t("byokFeatures.delegationTaskPlaceholder")}
                onChange={(event) => setDelegationTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitDelegation();
                  }
                }}
              />
              <Button
                size="sm"
                disabled={submittingDelegation || delegationTask.trim().length === 0}
                onClick={() => void submitDelegation()}
              >
                {submittingDelegation
                  ? t("byokFeatures.delegationRunning")
                  : t("byokFeatures.delegationSubmit")}
              </Button>
            </div>
            {delegations.length > 0 ? (
              <ul className="space-y-1">
                {delegations.slice(0, 5).map((delegation) => (
                  <li
                    key={`${delegation.id}-${delegation.submittedAt}`}
                    className="rounded border border-border/60 px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{delegation.status}</Badge>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate">
                        {delegation.taskPreview}
                      </span>
                    </div>
                    {delegation.resultPreview ? (
                      <p className="text-muted-foreground mt-1 line-clamp-3 whitespace-pre-wrap">
                        {delegation.resultPreview}
                      </p>
                    ) : null}
                    {delegation.errorMessage ? (
                      <p className="mt-1 text-red-600 dark:text-red-400">
                        {delegation.errorMessage}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-medium">{t("byokFeatures.importTitle")}</h4>
        <p className="text-muted-foreground text-xs">{t("byokFeatures.importDescription")}</p>
        <textarea
          className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs"
          placeholder={
            "modelAdapters:\n  - displayName: Example\n    type: openai\n    baseURL: https://api.example.com/v1\n    apiKey: sk-...\n    modelID: example-model"
          }
          value={importYaml}
          onChange={(event) => setImportYaml(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={importing || importYaml.trim().length === 0}
            onClick={() => void runImport()}
          >
            {importing ? t("byokFeatures.importing") : t("byokFeatures.importButton")}
          </Button>
          {importResult !== null ? (
            <span className="text-muted-foreground text-xs">
              {t("byokFeatures.importSummary", {
                imported: importResult.imported,
                skipped: importResult.skipped,
              })}
            </span>
          ) : null}
        </div>
        {importResult !== null && importResult.skippedReasons.length > 0 ? (
          <ul className="text-muted-foreground list-inside list-disc text-xs">
            {importResult.skippedReasons.slice(0, 8).map((reason) => (
              <li key={reason} className="font-mono">
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
