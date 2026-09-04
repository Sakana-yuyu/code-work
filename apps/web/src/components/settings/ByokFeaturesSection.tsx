"use client";

import { useState } from "react";
import { ArrowRightIcon, FileInputIcon, MessageSquareTextIcon, WorkflowIcon } from "lucide-react";
import type {
  ByokAdaptersImportResult,
  ByokDelegationConfig,
  ByokPromptTemplateConfig,
} from "@codework/contracts";

import { byokEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "~/i18n";
import { AsyncResult } from "effect/unstable/reactivity";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

interface ByokFeaturesSectionProps {
  readonly environmentId: string;
  readonly instanceId: string;
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

function ByokFeatureSection({
  icon,
  title,
  description,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/25 text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * BYOK auxiliary features: per-adapter balance query, prompt-template
 * injection, and delegation configuration. Balance queries resolve
 * server-side credentials; this component only ever sees normalized numbers.
 */
export function ByokFeaturesSection(props: ByokFeaturesSectionProps) {
  // Stored byok configs may predate a feature (or arrive as a bare `{}` from
  // `readByokFeatureConfig`), so normalize against the contract defaults
  // before any field access.
  const promptTemplate = { ...DEFAULT_PROMPT_TEMPLATE, ...props.promptTemplate };
  const delegation = { ...DEFAULT_DELEGATION, ...props.delegation };

  const importCommand = useAtomCommand(byokEnvironment.importAdapters, { reportFailure: false });
  const [importYaml, setImportYaml] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ByokAdaptersImportResult | null>(null);

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

  const patchPromptTemplate = (patch: Partial<ByokPromptTemplateConfig>) =>
    props.onPromptTemplateChange({ ...promptTemplate, ...patch });

  return (
    <div className="space-y-7">
      <ByokFeatureSection
        icon={<MessageSquareTextIcon className="size-3.5" />}
        title={t("byokFeatures.promptTemplateTitle")}
        description={t("byokFeatures.promptTemplateDescription")}
      >
        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
          <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
            <span className="min-w-0 font-medium text-foreground">
              {t("byokFeatures.promptTemplateChinese")}
            </span>
            <Switch
              checked={promptTemplate.softwareChineseEnabled}
              onCheckedChange={(checked) =>
                patchPromptTemplate({ softwareChineseEnabled: Boolean(checked) })
              }
              aria-label={t("byokFeatures.promptTemplateChinese")}
            />
          </label>
          <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
            <span className="min-w-0 font-medium text-foreground">
              {t("byokFeatures.promptTemplateCustom")}
            </span>
            <Switch
              checked={promptTemplate.customEnabled}
              onCheckedChange={(checked) =>
                patchPromptTemplate({ customEnabled: Boolean(checked) })
              }
              aria-label={t("byokFeatures.promptTemplateCustom")}
            />
          </label>
        </div>
        {promptTemplate.customEnabled ? (
          <div className="mt-3">
            <textarea
              className="border-input bg-background min-h-28 w-full rounded-lg border px-3 py-2 text-xs leading-relaxed"
              placeholder={t("byokFeatures.promptTemplateCustomPlaceholder")}
              value={promptTemplate.customContent}
              onChange={(event) => patchPromptTemplate({ customContent: event.target.value })}
            />
          </div>
        ) : null}
      </ByokFeatureSection>

      <ByokFeatureSection
        icon={<WorkflowIcon className="size-3.5" />}
        title={t("byokFeatures.delegationTitle")}
        description={t("byokFeatures.delegationDescription")}
      >
        <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={delegation.enabled ? "secondary" : "outline"} size="sm">
              {delegation.enabled
                ? t("byokFeatures.delegationEnabledStatus")
                : t("byokFeatures.delegationDisabledStatus")}
            </Badge>
            <Badge variant="outline" size="sm">
              {t("byokFeatures.delegationConcurrencyStatus", {
                count: delegation.maxConcurrency,
              })}
            </Badge>
            <Badge variant="outline" size="sm">
              {t("byokFeatures.delegationModelGroupsStatus", {
                count: delegation.modelGroups.length,
              })}
            </Badge>
            {delegation.visionDelegation.enabled ? (
              <Badge variant="secondary" size="sm">
                {t("byokFeatures.delegationVisionEnabledStatus")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t("byokFeatures.delegationCanonicalDescription")}
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            render={<a href="/settings/delegation" />}
          >
            <ArrowRightIcon />
            {t("byokFeatures.delegationOpenSettings")}
          </Button>
        </div>
      </ByokFeatureSection>

      <ByokFeatureSection
        icon={<FileInputIcon className="size-3.5" />}
        title={t("byokFeatures.importTitle")}
        description={t("byokFeatures.importDescription")}
      >
        <textarea
          className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs"
          placeholder={t(
            "modeladaptersDisplaynameExampleTypeOpenaiBaseurlHttpsApiExampleComV1Apik",
          )}
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
      </ByokFeatureSection>
    </div>
  );
}
