"use client";

import { PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";
import type {
  ByokDiscoveredModel,
  ByokModelAdapter,
  ByokModelDiscoveryResult,
  ByokSupplierCatalogEntry,
} from "@codework/contracts";

import { cn, randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { t } from "~/i18n";
import { byokEnvironment } from "../../state/server";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * A single model adapter routed through the built-in Cursor BYOK engine.
 * Re-exported for convenience so card-level callers can import it from here.
 */
export type { ByokModelAdapter };

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export type ByokSupplierTemplateId = "custom" | string;

type ByokSupplierTemplate = {
  readonly id: ByokSupplierTemplateId;
  readonly labelKey?: string;
  readonly label: string;
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly supplierID?: string;
  readonly modelCatalogURL?: string;
  readonly modelCatalogURLs?: ReadonlyArray<string>;
  readonly modelCatalogStatus?: ByokModelAdapter["modelCatalogStatus"];
  readonly appendModelCatalogCandidates?: boolean;
};

const CUSTOM_SUPPLIER_TEMPLATE: ByokSupplierTemplate = {
  id: "custom",
  labelKey: "byokAdapters.supplierCustom",
  label: "Custom",
  protocol: "openai",
  baseURL: "",
  modelId: "",
  displayName: "",
};

export const BYOK_SUPPLIER_TEMPLATES: ReadonlyArray<ByokSupplierTemplate> = [
  CUSTOM_SUPPLIER_TEMPLATE,
];

const PROTOCOL_BASE_URL_PLACEHOLDERS: Readonly<Record<ByokModelAdapter["protocol"], string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

const PROTOCOL_LABEL_KEYS: Readonly<Record<ByokModelAdapter["protocol"], string>> = {
  openai: "byokAdapters.protocolOpenai",
  anthropic: "byokAdapters.protocolAnthropic",
  gemini: "byokAdapters.protocolGemini",
};

type BalanceProfile = NonNullable<ByokModelAdapter["balanceProfile"]>;

const BALANCE_PROFILE_LABEL_KEYS: Readonly<Record<BalanceProfile, string>> = {
  auto: "byokAdapters.balanceProfileAuto",
  general: "byokAdapters.balanceProfileGeneral",
  newapi: "byokAdapters.balanceProfileNewapi",
  none: "byokAdapters.balanceProfileNone",
};

/**
 * Read the `adapters` array off the opaque byok config blob, tolerating
 * malformed entries (same spirit as `readConfigStringArray` in
 * `ProviderInstanceCard`).
 */
export function readByokModelAdapters(config: unknown): ReadonlyArray<ByokModelAdapter> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)["adapters"];
  if (!Array.isArray(value)) return [];
  const adapters: ByokModelAdapter[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record["id"] !== "string" ||
      (record["protocol"] !== "openai" &&
        record["protocol"] !== "anthropic" &&
        record["protocol"] !== "gemini")
    ) {
      continue;
    }
    adapters.push({
      id: record["id"],
      displayName: typeof record["displayName"] === "string" ? record["displayName"] : "",
      protocol: record["protocol"],
      baseURL: typeof record["baseURL"] === "string" ? record["baseURL"] : "",
      apiKey: typeof record["apiKey"] === "string" ? record["apiKey"] : "",
      ...(record["apiKeyRedacted"] === true ? { apiKeyRedacted: true } : {}),
      ...(typeof record["apiKeySourceAdapterId"] === "string" &&
      record["apiKeySourceAdapterId"].trim().length > 0
        ? { apiKeySourceAdapterId: record["apiKeySourceAdapterId"].trim() }
        : {}),
      ...(record["balanceProfile"] === "auto" ||
      record["balanceProfile"] === "general" ||
      record["balanceProfile"] === "newapi" ||
      record["balanceProfile"] === "none"
        ? { balanceProfile: record["balanceProfile"] }
        : {}),
      balanceAccessToken:
        typeof record["balanceAccessToken"] === "string" ? record["balanceAccessToken"] : "",
      ...(record["balanceAccessTokenRedacted"] === true
        ? { balanceAccessTokenRedacted: true }
        : {}),
      ...(typeof record["balanceUserID"] === "string"
        ? { balanceUserID: record["balanceUserID"] }
        : {}),
      modelId: typeof record["modelId"] === "string" ? record["modelId"] : "",
      contextWindowTokens:
        typeof record["contextWindowTokens"] === "number" &&
        Number.isFinite(record["contextWindowTokens"])
          ? record["contextWindowTokens"]
          : DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
  }
  return adapters;
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return "—";
  return `${trimmed.slice(0, 3)}***`;
}

type AdapterFormState = {
  readonly supplier: ByokSupplierTemplateId;
  readonly displayName: string;
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly contextWindowTokens: string;
  readonly balanceProfile: BalanceProfile;
  readonly balanceAccessToken: string;
  readonly balanceUserID: string;
};

const emptyFormState = (): AdapterFormState => ({
  supplier: "custom",
  displayName: "",
  protocol: "openai",
  baseURL: "",
  apiKey: "",
  modelId: "",
  contextWindowTokens: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
  balanceProfile: "auto",
  balanceAccessToken: "",
  balanceUserID: "",
});

const formStateFromAdapter = (adapter: ByokModelAdapter): AdapterFormState => ({
  supplier: "custom",
  displayName: adapter.displayName,
  protocol: adapter.protocol,
  baseURL: adapter.baseURL,
  apiKey: adapter.apiKey,
  modelId: adapter.modelId,
  contextWindowTokens: String(adapter.contextWindowTokens),
  balanceProfile: adapter.balanceProfile ?? "auto",
  balanceAccessToken: "",
  balanceUserID: adapter.balanceUserID ?? "",
});

interface ByokModelAdaptersSectionProps {
  /** Environment hosting this provider instance. */
  readonly environmentId: string;
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: string;
  /** Current `config.adapters` list for the byok provider instance. */
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
  /**
   * Commit the next adapter list. The caller routes the write into
   * `providerInstances[id].config.adapters` via the same instance-update
   * path used by the custom-models editor.
   */
  readonly onChange: (next: ReadonlyArray<ByokModelAdapter>) => void;
}

/**
 * t3code-style "Model adapters" editor for the built-in Cursor BYOK driver.
 * Renders one card per adapter (protocol badge, model id, base URL, masked
 * API key, context window) plus an inline add/edit form. Deletes go through
 * the shared `AlertDialog` confirmation pattern.
 */
export function ByokModelAdaptersSection({
  environmentId,
  instanceId,
  adapters,
  onChange,
}: ByokModelAdaptersSectionProps) {
  // `null` = no form open. Otherwise the adapter id being edited, or
  // "new" for the add form.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<AdapterFormState>(emptyFormState);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ByokModelAdapter | null>(null);
  const catalogResult = useAtomValue(
    byokEnvironment.supplierCatalog({ environmentId: environmentId as never, input: {} }),
  );
  const supplierTemplates = useMemo<ReadonlyArray<ByokSupplierTemplate>>(() => {
    const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
    return [
      CUSTOM_SUPPLIER_TEMPLATE,
      ...catalog.map((entry: ByokSupplierCatalogEntry) => ({
        id: entry.id,
        label: entry.label,
        protocol: entry.protocol,
        baseURL: entry.defaultBaseURL,
        modelId: entry.models[0]?.modelId ?? "",
        displayName: entry.models[0]?.displayName ?? entry.models[0]?.modelId ?? "",
        supplierID: entry.id,
        ...(entry.modelCatalogURLs.length > 0 ? { modelCatalogURLs: entry.modelCatalogURLs } : {}),
        modelCatalogStatus: entry.modelCatalogStatus,
        appendModelCatalogCandidates: entry.appendGeneratedCandidates,
      })),
    ];
  }, [catalogResult]);
  const [discovery, setDiscovery] = useState<Record<string, ByokModelDiscoveryResult>>({});
  const [selectedModels, setSelectedModels] = useState<Record<string, ReadonlyArray<string>>>({});
  const discoverCommand = useAtomCommand(byokEnvironment.discoverModels, { reportFailure: false });
  const [discoveringAdapterId, setDiscoveringAdapterId] = useState<string | null>(null);

  const openAdd = () => {
    setForm(emptyFormState());
    setError(null);
    setEditing("new");
  };

  const openEdit = (adapter: ByokModelAdapter) => {
    setForm(formStateFromAdapter(adapter));
    setError(null);
    setEditing(adapter.id);
  };

  const closeForm = () => {
    setEditing(null);
    setError(null);
  };

  const patchForm = (patch: Partial<AdapterFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (error) setError(null);
  };

  const applySupplierTemplate = (supplier: ByokSupplierTemplateId) => {
    const template = supplierTemplates.find((entry) => entry.id === supplier);
    if (!template) return;
    patchForm({
      supplier,
      protocol: template.protocol,
      baseURL: template.baseURL,
      modelId: template.modelId,
      displayName: template.displayName,
    });
  };

  const handleSave = () => {
    const displayName = form.displayName.trim();
    if (!displayName) {
      setError(t("byokAdapters.displayNameRequired"));
      return;
    }
    const baseURL = form.baseURL.trim();
    if (!baseURL) {
      setError(t("byokAdapters.baseURLRequired"));
      return;
    }
    const apiKey = form.apiKey.trim();
    const existingAdapter =
      editing === "new" || editing === null
        ? undefined
        : adapters.find((adapter) => adapter.id === editing);
    const retainsStoredApiKey = apiKey.length === 0 && existingAdapter?.apiKeyRedacted === true;
    if (!apiKey && !retainsStoredApiKey) {
      setError(t("byokAdapters.apiKeyRequired"));
      return;
    }
    const balanceAccessToken = form.balanceAccessToken.trim();
    const retainsStoredBalanceToken =
      balanceAccessToken.length === 0 && existingAdapter?.balanceAccessTokenRedacted === true;
    const balanceUserID = form.balanceUserID.trim();
    const modelId = form.modelId.trim();
    if (!modelId) {
      setError(t("byokAdapters.modelIdRequired"));
      return;
    }
    const contextWindowTokens = Number(form.contextWindowTokens.trim());
    if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      setError(t("byokAdapters.contextWindowRequired"));
      return;
    }

    const next: ByokModelAdapter = {
      id: editing === "new" || editing === null ? randomUUID() : editing,
      displayName,
      protocol: form.protocol,
      baseURL,
      apiKey,
      ...(retainsStoredApiKey ? { apiKeyRedacted: true } : {}),
      ...(form.balanceProfile !== "auto" ? { balanceProfile: form.balanceProfile } : {}),
      balanceAccessToken,
      ...(retainsStoredBalanceToken ? { balanceAccessTokenRedacted: true } : {}),
      ...(balanceUserID ? { balanceUserID } : {}),
      modelId,
      contextWindowTokens,
      ...(form.supplier !== "custom" ? { supplierID: form.supplier } : {}),
      ...(supplierTemplates.find((entry) => entry.id === form.supplier)?.modelCatalogURLs
        ? {
            modelCatalogURLs: supplierTemplates.find((entry) => entry.id === form.supplier)
              ?.modelCatalogURLs,
          }
        : {}),
      ...(supplierTemplates.find((entry) => entry.id === form.supplier)?.modelCatalogStatus
        ? {
            modelCatalogStatus: supplierTemplates.find((entry) => entry.id === form.supplier)
              ?.modelCatalogStatus,
          }
        : {}),
      ...(supplierTemplates.find((entry) => entry.id === form.supplier)
        ?.appendModelCatalogCandidates !== undefined
        ? {
            appendModelCatalogCandidates: supplierTemplates.find(
              (entry) => entry.id === form.supplier,
            )?.appendModelCatalogCandidates,
          }
        : {}),
    };
    if (editing === "new" || editing === null) {
      onChange([...adapters, next]);
    } else {
      onChange(adapters.map((adapter) => (adapter.id === editing ? next : adapter)));
    }
    closeForm();
  };

  const discoverModels = async (adapter: ByokModelAdapter) => {
    setDiscoveringAdapterId(adapter.id);
    try {
      const result = await discoverCommand({
        environmentId: environmentId as never,
        input: { instanceId, adapterId: adapter.id, forceRefresh: true },
      });
      if (!AsyncResult.isSuccess(result)) return;
      setDiscovery((current) => ({ ...current, [adapter.id]: result.value }));
      setSelectedModels((current) => ({ ...current, [adapter.id]: [] }));
    } finally {
      setDiscoveringAdapterId(null);
    }
  };

  const addDiscoveredModels = (adapter: ByokModelAdapter) => {
    const selected = new Set(selectedModels[adapter.id] ?? []);
    const models = discovery[adapter.id]?.models ?? [];
    const additions = models.filter(
      (model) => selected.has(model.id) && model.id !== adapter.modelId,
    );
    const existingIds = new Set(adapters.map((entry) => `${entry.baseURL}\u0000${entry.modelId}`));
    const next = additions.reduce<ByokModelAdapter[]>((all, model) => {
      const key = `${adapter.baseURL}\u0000${model.id}`;
      if (existingIds.has(key)) return all;
      existingIds.add(key);
      all.push({
        ...adapter,
        id: randomUUID(),
        displayName: model.id,
        modelId: model.id,
        ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
        apiKey: "",
        ...(adapter.apiKeyRedacted ? { apiKeyRedacted: true } : {}),
        ...(adapter.apiKeyRedacted ? { apiKeySourceAdapterId: adapter.id } : {}),
        // Balance credentials are per-adapter secrets and never copied.
        balanceAccessToken: "",
        ...(adapter.balanceAccessTokenRedacted ? { balanceAccessTokenRedacted: true } : {}),
      });
      return all;
    }, []);
    if (next.length > 0) onChange([...adapters, ...next]);
    setSelectedModels((current) => ({ ...current, [adapter.id]: [] }));
  };

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    onChange(adapters.filter((adapter) => adapter.id !== pendingDelete.id));
    if (editing === pendingDelete.id) closeForm();
    setPendingDelete(null);
  };

  const renderForm = (formId: string, isEdit: boolean) => (
    <div className="mt-2 grid gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {!isEdit ? (
          <label htmlFor={`${formId}-supplier`} className="block sm:col-span-2">
            <span className="text-xs font-medium text-foreground">
              {t("byokAdapters.supplierTemplate")}
            </span>
            <Select
              value={form.supplier}
              onValueChange={(value) => applySupplierTemplate(value as ByokSupplierTemplateId)}
            >
              <SelectTrigger id={`${formId}-supplier`} className="mt-1 w-full" size="sm">
                <SelectValue>
                  {(() => {
                    const selected = supplierTemplates.find((entry) => entry.id === form.supplier);
                    return selected?.labelKey
                      ? t(selected.labelKey)
                      : (selected?.label ?? form.supplier);
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {supplierTemplates.map((template) => (
                  <SelectItem key={template.id} hideIndicator value={template.id}>
                    {template.labelKey ? t(template.labelKey) : template.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="mt-1 block text-xs text-muted-foreground">
              {t("byokAdapters.supplierTemplateDescription")}
            </span>
          </label>
        ) : null}
        <label htmlFor={`${formId}-display-name`} className="block">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.displayName")}
          </span>
          <Input
            id={`${formId}-display-name`}
            className="mt-1"
            value={form.displayName}
            onChange={(event) => patchForm({ displayName: event.target.value })}
            placeholder="DeepSeek Chat"
            spellCheck={false}
          />
        </label>
        <label htmlFor={`${formId}-protocol`} className="block">
          <span className="text-xs font-medium text-foreground">{t("byokAdapters.protocol")}</span>
          <Select
            value={form.protocol}
            onValueChange={(value) => {
              if (value === "openai" || value === "anthropic" || value === "gemini") {
                patchForm({ protocol: value });
              }
            }}
          >
            <SelectTrigger id={`${formId}-protocol`} className="mt-1 w-full" size="sm">
              <SelectValue>{t(PROTOCOL_LABEL_KEYS[form.protocol])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="openai">
                {t("byokAdapters.protocolOpenai")}
              </SelectItem>
              <SelectItem hideIndicator value="anthropic">
                {t("byokAdapters.protocolAnthropic")}
              </SelectItem>
              <SelectItem hideIndicator value="gemini">
                {t("byokAdapters.protocolGemini")}
              </SelectItem>
            </SelectPopup>
          </Select>
        </label>
        <label htmlFor={`${formId}-base-url`} className="block sm:col-span-2">
          <span className="text-xs font-medium text-foreground">{t("byokAdapters.baseURL")}</span>
          <Input
            id={`${formId}-base-url`}
            className="mt-1"
            value={form.baseURL}
            onChange={(event) => patchForm({ baseURL: event.target.value })}
            placeholder={PROTOCOL_BASE_URL_PLACEHOLDERS[form.protocol]}
            spellCheck={false}
          />
        </label>
        <label htmlFor={`${formId}-api-key`} className="block">
          <span className="text-xs font-medium text-foreground">{t("byokAdapters.apiKey")}</span>
          <Input
            id={`${formId}-api-key`}
            className="mt-1"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(event) => patchForm({ apiKey: event.target.value })}
            placeholder={
              isEdit && adapters.find((adapter) => adapter.id === editing)?.apiKeyRedacted
                ? t("byokAdapters.apiKeyReplacementPlaceholder")
                : undefined
            }
            spellCheck={false}
          />
          {isEdit && adapters.find((adapter) => adapter.id === editing)?.apiKeyRedacted ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {t("byokAdapters.apiKeyStored")}
            </span>
          ) : null}
        </label>
        <label htmlFor={`${formId}-model-id`} className="block">
          <span className="text-xs font-medium text-foreground">{t("byokAdapters.modelId")}</span>
          <Input
            id={`${formId}-model-id`}
            className="mt-1"
            value={form.modelId}
            onChange={(event) => patchForm({ modelId: event.target.value })}
            placeholder="deepseek-chat"
            spellCheck={false}
          />
        </label>
        <label htmlFor={`${formId}-context-window`} className="block">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.contextWindow")}
          </span>
          <Input
            id={`${formId}-context-window`}
            className="mt-1"
            type="number"
            min={1}
            step={1000}
            value={form.contextWindowTokens}
            onChange={(event) => patchForm({ contextWindowTokens: event.target.value })}
          />
        </label>
        <label htmlFor={`${formId}-balance-profile`} className="block">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.balanceProfile")}
          </span>
          <Select
            value={form.balanceProfile}
            onValueChange={(value) => {
              if (
                value === "auto" ||
                value === "general" ||
                value === "newapi" ||
                value === "none"
              ) {
                patchForm({ balanceProfile: value });
              }
            }}
          >
            <SelectTrigger id={`${formId}-balance-profile`} className="mt-1 w-full" size="sm">
              <SelectValue>{t(BALANCE_PROFILE_LABEL_KEYS[form.balanceProfile])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {(["auto", "general", "newapi", "none"] as const).map((profile) => (
                <SelectItem key={profile} hideIndicator value={profile}>
                  {t(BALANCE_PROFILE_LABEL_KEYS[profile])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("byokAdapters.balanceProfileDescription")}
          </span>
        </label>
        <label htmlFor={`${formId}-balance-token`} className="block">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.balanceAccessToken")}
          </span>
          <Input
            id={`${formId}-balance-token`}
            className="mt-1"
            type="password"
            autoComplete="off"
            value={form.balanceAccessToken}
            onChange={(event) => patchForm({ balanceAccessToken: event.target.value })}
            placeholder={
              isEdit &&
              adapters.find((adapter) => adapter.id === editing)?.balanceAccessTokenRedacted
                ? t("byokAdapters.apiKeyReplacementPlaceholder")
                : undefined
            }
            spellCheck={false}
          />
          {isEdit &&
          adapters.find((adapter) => adapter.id === editing)?.balanceAccessTokenRedacted ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {t("byokAdapters.balanceTokenStored")}
            </span>
          ) : null}
        </label>
        <label htmlFor={`${formId}-balance-user-id`} className="block">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.balanceUserID")}
          </span>
          <Input
            id={`${formId}-balance-user-id`}
            className="mt-1"
            value={form.balanceUserID}
            onChange={(event) => patchForm({ balanceUserID: event.target.value })}
            placeholder="1"
            spellCheck={false}
          />
        </label>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost-muted" onClick={closeForm}>
          {t("cancel")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={handleSave}>
          {isEdit ? t("save") : t("byokAdapters.addAdapter")}
        </Button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{t("byokAdapters.title")}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={openAdd}
          disabled={editing !== null}
        >
          <PlusIcon className="size-3" />
          {t("byokAdapters.addAdapter")}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("byokAdapters.description")}</p>

      <div className="mt-2 space-y-2">
        {adapters.length === 0 && editing === null ? (
          <p className="text-xs text-muted-foreground">{t("byokAdapters.empty")}</p>
        ) : null}
        {adapters.map((adapter) => (
          <div key={adapter.id}>
            <div className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border/70 px-2.5 py-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 truncate text-xs text-foreground/90">
                  {adapter.displayName || adapter.modelId}
                </span>
                <Badge variant="outline" size="sm" className="shrink-0">
                  {t(PROTOCOL_LABEL_KEYS[adapter.protocol])}
                </Badge>
                <code className="min-w-0 truncate text-[10px] text-muted-foreground">
                  {adapter.modelId}
                </code>
                <span className="min-w-0 truncate text-[10px] text-muted-foreground/80">
                  {adapter.baseURL}
                </span>
                <span className="text-[10px] text-muted-foreground/80">
                  {adapter.apiKeyRedacted
                    ? t("byokAdapters.apiKeyStoredShort")
                    : maskApiKey(adapter.apiKey)}
                </span>
                <span className="text-[10px] text-muted-foreground/80">
                  {t("byokAdapters.contextWindowShort", {
                    count: adapter.contextWindowTokens,
                  })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => void discoverModels(adapter)}
                  disabled={discoveringAdapterId !== null}
                >
                  {discoveringAdapterId === adapter.id
                    ? t("byokAdapters.discovering")
                    : t("byokAdapters.discoverModels")}
                </Button>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  onClick={() => (editing === adapter.id ? closeForm() : openEdit(adapter))}
                  aria-label={`${t("byokAdapters.editAdapter")}: ${adapter.displayName}`}
                >
                  <PencilIcon
                    className={cn("size-3", editing === adapter.id && "text-foreground")}
                  />
                </Button>
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setPendingDelete(adapter)}
                  aria-label={`${t("byokAdapters.deleteAdapter")}: ${adapter.displayName}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
            </div>
            {editing === adapter.id
              ? renderForm(`byok-adapter-${instanceId}-${adapter.id}`, true)
              : null}
            {discovery[adapter.id] ? (
              <div className="mt-1 rounded-md border border-border/60 bg-muted/10 p-2">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{t("byokAdapters.discoveredModels")}</span>
                  {discovery[adapter.id]?.models.length ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => addDiscoveredModels(adapter)}
                    >
                      {t("byokAdapters.addSelectedModels")}
                    </Button>
                  ) : null}
                </div>
                {discovery[adapter.id]?.stale ? (
                  <p className="mb-1 text-[10px] text-warning">
                    {t("byokAdapters.discoveryStale")}
                  </p>
                ) : null}
                {discovery[adapter.id]?.error && discovery[adapter.id]?.models.length === 0 ? (
                  <p className="text-[10px] text-destructive">
                    {t("byokAdapters.discoveryFailed", {
                      message: discovery[adapter.id]?.error?.message ?? "",
                    })}
                  </p>
                ) : null}
                {!discovery[adapter.id]?.error && discovery[adapter.id]?.models.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">
                    {t("byokAdapters.discoveryEmpty")}
                  </p>
                ) : null}
                {discovery[adapter.id]?.models.length ? (
                  <div className="grid gap-1 sm:grid-cols-2">
                    {(discovery[adapter.id]?.models ?? []).map((model) => {
                      const checked = (selectedModels[adapter.id] ?? []).includes(model.id);
                      return (
                        <label key={model.id} className="flex items-center gap-1.5 text-[10px]">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedModels((current) => {
                                const selected = new Set(current[adapter.id] ?? []);
                                if (selected.has(model.id)) selected.delete(model.id);
                                else selected.add(model.id);
                                return { ...current, [adapter.id]: [...selected] };
                              })
                            }
                          />
                          <code className="truncate">{model.id}</code>
                          {model.ownedBy ? (
                            <span className="truncate text-muted-foreground">
                              ({model.ownedBy})
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                ) : null}
                {discovery[adapter.id]?.fetchedAt ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {t("byokAdapters.discoverySource", {
                      source: discovery[adapter.id]?.source ?? "",
                      fetchedAt: discovery[adapter.id]?.fetchedAt ?? "",
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {editing === "new" ? renderForm(`byok-adapter-${instanceId}-new`, false) : null}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("byokAdapters.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("byokAdapters.deleteConfirm", {
                name: pendingDelete?.displayName || pendingDelete?.modelId || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("cancel")}</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDelete}>
              <XIcon className="size-3.5" />
              {t("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
