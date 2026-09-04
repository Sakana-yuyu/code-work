"use client";

import {
  CheckIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";
import type {
  ByokContextWindowMatchResult,
  ByokDiscoveredModel,
  ByokDraftModelDiscoveryResult,
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

export type ByokSupplierTemplate = {
  readonly id: ByokSupplierTemplateId;
  readonly labelKey?: string;
  readonly label: string;
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly iconURL?: string;
  readonly iconLight?: boolean;
  readonly supplierID?: string;
  readonly modelCatalogURL?: string;
  readonly modelCatalogURLs?: ReadonlyArray<string>;
  readonly modelCatalogStatus?: ByokModelAdapter["modelCatalogStatus"];
  readonly appendModelCatalogCandidates?: boolean;
};

const CUSTOM_SUPPLIER_TEMPLATE: ByokSupplierTemplate = {
  id: "custom",
  labelKey: "byokAdapters.supplierCustom",
  get label() {
    return t("custom2");
  },
  iconLight: true,
  protocol: "openai",
  baseURL: "",
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
      ...(typeof record["groupName"] === "string" && record["groupName"].trim().length > 0
        ? { groupName: record["groupName"].trim() }
        : {}),
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
  readonly groupName: string;
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
  groupName: "",
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
  groupName: adapter.groupName ?? "",
  protocol: adapter.protocol,
  baseURL: adapter.baseURL,
  apiKey: adapter.apiKey,
  modelId: adapter.modelId,
  contextWindowTokens: String(adapter.contextWindowTokens),
  balanceProfile: adapter.balanceProfile ?? "auto",
  balanceAccessToken: "",
  balanceUserID: adapter.balanceUserID ?? "",
});

export function draftModelSelectionPatch(model: ByokDiscoveredModel) {
  return {
    modelId: model.id,
    displayName: model.id,
    ...(model.contextWindowTokens
      ? { contextWindowTokens: String(model.contextWindowTokens) }
      : {}),
  };
}

export function filterDiscoveredModels(
  models: ReadonlyArray<ByokDiscoveredModel>,
  query: string,
): ReadonlyArray<ByokDiscoveredModel> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return models;
  return models.filter((model) =>
    [model.id, model.ownedBy]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
}

function supplierTemplateLabel(template: ByokSupplierTemplate): string {
  return template.labelKey ? t(template.labelKey) : template.label;
}

export function filterSupplierTemplates(
  templates: ReadonlyArray<ByokSupplierTemplate>,
  query: string,
): ReadonlyArray<ByokSupplierTemplate> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return templates;
  return templates.filter((template) =>
    [template.id, supplierTemplateLabel(template), template.protocol, template.baseURL].some(
      (value) => value.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}

function supplierTemplateInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}

function SupplierTemplateIcon({
  template,
  label,
}: {
  readonly template: ByokSupplierTemplate;
  readonly label: string;
}) {
  const [failed, setFailed] = useState(false);
  if (template.iconURL && !failed) {
    return (
      <span
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-md border",
          // iconLight marks monochrome currentColor marks, which render black
          // inside <img>. They need a fixed light chip — bg-foreground flips to
          // near-black in light mode and hides them.
          template.iconLight ? "border-border bg-white" : "border-border/70 bg-background",
        )}
      >
        <img
          alt=""
          className="max-h-5 max-w-5 object-contain"
          loading="lazy"
          src={template.iconURL}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-xs font-semibold text-primary">
      {supplierTemplateInitial(label)}
    </span>
  );
}

export interface ByokModelAdapterRelayGroup {
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
}

export interface ByokModelAdapterGroup {
  readonly groupName: string;
  readonly relays: ReadonlyArray<ByokModelAdapterRelayGroup>;
}

interface ByokRelayDetailsTarget {
  readonly groupName: string;
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
}

export function groupByokModelAdapters(
  adapters: ReadonlyArray<ByokModelAdapter>,
): ReadonlyArray<ByokModelAdapterGroup> {
  const groups = new Map<string, { groupName: string; relays: Map<string, ByokModelAdapter[]> }>();

  for (const adapter of adapters) {
    const groupName = adapter.groupName?.trim() ?? "";
    const groupKey = groupName || "__default__";
    let group = groups.get(groupKey);
    if (!group) {
      group = { groupName, relays: new Map() };
      groups.set(groupKey, group);
    }

    const baseURL = adapter.baseURL.trim();
    const relayKey = `${adapter.protocol}\u0000${baseURL}`;
    const relayAdapters = group.relays.get(relayKey);
    if (relayAdapters) {
      relayAdapters.push(adapter);
    } else {
      group.relays.set(relayKey, [adapter]);
    }
  }

  return [...groups.values()].map((group) => ({
    groupName: group.groupName,
    relays: [...group.relays.values()].map((relayAdapters) => ({
      protocol: relayAdapters[0]?.protocol ?? "openai",
      baseURL: relayAdapters[0]?.baseURL.trim() ?? "",
      adapters: relayAdapters,
    })),
  }));
}

interface ByokModelAdaptersSectionProps {
  /** Environment hosting this provider instance. */
  readonly environmentId: string;
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: string;
  /** Current `config.adapters` list for the byok provider instance. */
  readonly adapters: ReadonlyArray<ByokModelAdapter>;
  /** Provider 实例内使用更清晰的模型通道卡片。 */
  readonly presentation?: "compact" | "provider";
  /**
   * Commit the next adapter list. The caller routes the write into
   * `providerInstances[id].config.adapters` via the same instance-update
   * path used by the custom-models editor.
   */
  readonly onChange: (next: ReadonlyArray<ByokModelAdapter>) => boolean | PromiseLike<boolean>;
}

/**
 * codework-style "Model adapters" editor for the built-in Cursor BYOK driver.
 * Renders one card per adapter (protocol badge, model id, base URL, masked
 * API key, context window) plus an inline add/edit form. Deletes go through
 * the shared `AlertDialog` confirmation pattern.
 */
export function ByokModelAdaptersSection({
  environmentId,
  instanceId,
  adapters,
  onChange,
  presentation = "compact",
}: ByokModelAdaptersSectionProps) {
  // `null` = no form open. Otherwise the adapter id being edited, or
  // "new" for the add form.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<AdapterFormState>(emptyFormState);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ByokModelAdapter | null>(null);
  const [relayDetailsTarget, setRelayDetailsTarget] = useState<ByokRelayDetailsTarget | null>(null);
  const catalogResult = useAtomValue(
    byokEnvironment.supplierCatalog({ environmentId: environmentId as never, input: {} }),
  );
  const supplierTemplates = useMemo<ReadonlyArray<ByokSupplierTemplate>>(() => {
    const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
    // The server catalog ships its own synthetic `custom` placeholder; the
    // web-local entry above is the canonical one (i18n label). Dedupe by id
    // so the picker shows one custom card and selection stays single-choice.
    return [
      CUSTOM_SUPPLIER_TEMPLATE,
      ...catalog
        .filter((entry: ByokSupplierCatalogEntry) => entry.id !== CUSTOM_SUPPLIER_TEMPLATE.id)
        .map((entry: ByokSupplierCatalogEntry) => {
          return {
            id: entry.id,
            label: entry.label,
            protocol: entry.protocol,
            baseURL: entry.defaultBaseURL,
            ...(entry.iconURL ? { iconURL: entry.iconURL } : {}),
            iconLight: entry.iconLight,
            supplierID: entry.id,
            ...(entry.modelCatalogURLs.length > 0
              ? { modelCatalogURLs: entry.modelCatalogURLs }
              : {}),
            modelCatalogStatus: entry.modelCatalogStatus,
            appendModelCatalogCandidates: entry.appendGeneratedCandidates,
          };
        }),
    ];
  }, [catalogResult]);
  const [supplierTemplateSearch, setSupplierTemplateSearch] = useState("");
  const filteredSupplierTemplates = useMemo(
    () => filterSupplierTemplates(supplierTemplates, supplierTemplateSearch),
    [supplierTemplates, supplierTemplateSearch],
  );
  const [discovery, setDiscovery] = useState<Record<string, ByokModelDiscoveryResult>>({});
  const [discoveryErrors, setDiscoveryErrors] = useState<Record<string, string>>({});
  const [selectedModels, setSelectedModels] = useState<Record<string, ReadonlyArray<string>>>({});
  const [contextMatches, setContextMatches] = useState<
    Record<string, ByokContextWindowMatchResult>
  >({});
  const discoverCommand = useAtomCommand(byokEnvironment.discoverModels, { reportFailure: false });
  const matchContextWindowsCommand = useAtomCommand(byokEnvironment.matchContextWindows, {
    reportFailure: false,
  });
  const discoverDraftCommand = useAtomCommand(byokEnvironment.discoverDraftModels, {
    reportFailure: false,
  });
  const [discoveringAdapterId, setDiscoveringAdapterId] = useState<string | null>(null);
  const [matchingContextAdapterId, setMatchingContextAdapterId] = useState<string | null>(null);
  const [draftDiscovery, setDraftDiscovery] = useState<ByokDraftModelDiscoveryResult | null>(null);
  const [selectedDraftModelIds, setSelectedDraftModelIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [discoveringDraft, setDiscoveringDraft] = useState(false);
  const [draftModelPickerOpen, setDraftModelPickerOpen] = useState(false);
  const [draftModelPickerSearch, setDraftModelPickerSearch] = useState("");
  const [manualModelDialogOpen, setManualModelDialogOpen] = useState(false);
  const [manualModelInput, setManualModelInput] = useState("");
  const filteredDraftModels = useMemo(
    () => filterDiscoveredModels(draftDiscovery?.models ?? [], draftModelPickerSearch),
    [draftDiscovery?.models, draftModelPickerSearch],
  );
  const adapterGroups = useMemo(() => groupByokModelAdapters(adapters), [adapters]);
  const selectedRelay = useMemo(() => {
    if (relayDetailsTarget === null) return null;
    return (
      adapterGroups
        .find((group) => group.groupName === relayDetailsTarget.groupName)
        ?.relays.find(
          (relay) =>
            relay.protocol === relayDetailsTarget.protocol &&
            relay.baseURL === relayDetailsTarget.baseURL,
        ) ?? null
    );
  }, [adapterGroups, relayDetailsTarget]);
  const selectedRelayAdapter = selectedRelay?.adapters[0] ?? null;

  const openAdd = () => {
    setForm(emptyFormState());
    setError(null);
    setDraftDiscovery(null);
    setSelectedDraftModelIds(new Set());
    setDraftModelPickerOpen(false);
    setDraftModelPickerSearch("");
    setManualModelDialogOpen(false);
    setManualModelInput("");
    setSupplierTemplateSearch("");
    setEditing("new");
  };

  const openEdit = (adapter: ByokModelAdapter) => {
    setForm(formStateFromAdapter(adapter));
    setError(null);
    setDraftDiscovery(null);
    setSelectedDraftModelIds(new Set());
    setDraftModelPickerOpen(false);
    setDraftModelPickerSearch("");
    setManualModelDialogOpen(false);
    setManualModelInput("");
    setEditing(adapter.id);
  };

  const closeForm = () => {
    setEditing(null);
    setError(null);
    setDraftDiscovery(null);
    setSelectedDraftModelIds(new Set());
    setDraftModelPickerOpen(false);
    setDraftModelPickerSearch("");
    setManualModelDialogOpen(false);
    setManualModelInput("");
    setSupplierTemplateSearch("");
  };

  const patchForm = (patch: Partial<AdapterFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (
      patch.supplier !== undefined ||
      patch.protocol !== undefined ||
      patch.baseURL !== undefined ||
      patch.apiKey !== undefined
    ) {
      setDraftDiscovery(null);
      setSelectedDraftModelIds(new Set());
      setDraftModelPickerOpen(false);
      setDraftModelPickerSearch("");
    }
    if (error) setError(null);
  };

  const applySupplierTemplate = (supplier: ByokSupplierTemplateId) => {
    const template = supplierTemplates.find((entry) => entry.id === supplier);
    if (!template) return;
    patchForm({
      supplier,
      protocol: template.protocol,
      baseURL: template.baseURL,
      modelId: "",
      displayName: "",
      contextWindowTokens: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
    });
  };

  const openManualModelDialog = () => {
    setManualModelInput(form.modelId);
    setManualModelDialogOpen(true);
  };

  const applyManualModel = () => {
    const modelId = manualModelInput.trim();
    if (!modelId) {
      setError(t("byokAdapters.modelIdRequired"));
      return;
    }
    patchForm({ modelId, displayName: modelId });
    setManualModelDialogOpen(false);
  };

  const handleSave = async () => {
    const baseURL = form.baseURL.trim();
    if (!baseURL) {
      setError(t("byokAdapters.baseURLRequired"));
      return;
    }
    const groupName = form.groupName.trim();
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
      displayName: form.displayName.trim() || modelId,
      ...(groupName ? { groupName } : {}),
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
    const nextAdapters =
      editing === "new" || editing === null
        ? [...adapters, next]
        : adapters.map((adapter) => (adapter.id === editing ? next : adapter));

    setIsSaving(true);
    try {
      const saved = await onChange(nextAdapters);
      if (!saved) {
        setError(t("settingsSaveTryAgain"));
        return;
      }
      closeForm();
    } catch {
      setError(t("settingsSaveTryAgain"));
    } finally {
      setIsSaving(false);
    }
  };

  const discoverModels = async (adapter: ByokModelAdapter) => {
    setDiscoveringAdapterId(adapter.id);
    setDiscovery((current) => {
      const next = { ...current };
      delete next[adapter.id];
      return next;
    });
    setDiscoveryErrors((current) => {
      const next = { ...current };
      delete next[adapter.id];
      return next;
    });
    try {
      const result = await discoverCommand({
        environmentId: environmentId as never,
        input: { instanceId, adapterId: adapter.id, forceRefresh: true },
      });
      if (!AsyncResult.isSuccess(result)) {
        setDiscoveryErrors((current) => ({
          ...current,
          [adapter.id]: t("byokAdapters.discoveryRequestFailed"),
        }));
        return;
      }
      setDiscovery((current) => ({ ...current, [adapter.id]: result.value }));
      setSelectedModels((current) => ({ ...current, [adapter.id]: [] }));
    } finally {
      setDiscoveringAdapterId(null);
    }
  };

  const diagnoseContextWindows = async (adapter: ByokModelAdapter) => {
    setMatchingContextAdapterId(adapter.id);
    try {
      const result = await matchContextWindowsCommand({
        environmentId: environmentId as never,
        input: { instanceId, adapterId: adapter.id },
      });
      if (!AsyncResult.isSuccess(result)) return;

      setContextMatches((current) => ({ ...current, [adapter.id]: result.value }));
      const nextWindowByAdapterId = new Map(
        result.value.details
          .filter((detail) => detail.before !== detail.after)
          .map((detail) => [detail.adapterId, detail.after]),
      );
      if (nextWindowByAdapterId.size === 0) return;
      onChange(
        adapters.map((current) => {
          const contextWindowTokens = nextWindowByAdapterId.get(current.id);
          return contextWindowTokens === undefined ? current : { ...current, contextWindowTokens };
        }),
      );
    } finally {
      setMatchingContextAdapterId(null);
    }
  };

  const discoverDraftModels = async () => {
    const baseURL = form.baseURL.trim();
    if (!baseURL) {
      setError(t("byokAdapters.baseURLRequired"));
      return;
    }
    const apiKey = form.apiKey.trim();
    if (!apiKey) {
      setError(t("byokAdapters.apiKeyRequired"));
      return;
    }

    setDiscoveringDraft(true);
    try {
      const result = await discoverDraftCommand({
        environmentId: environmentId as never,
        input: {
          protocol: form.protocol,
          baseURL,
          apiKey,
          ...(form.supplier !== "custom" ? { supplierID: form.supplier } : {}),
        },
      });
      if (!AsyncResult.isSuccess(result)) {
        setError(t("byokAdapters.discoveryRequestFailed"));
        return;
      }
      setDraftDiscovery(result.value);
      setSelectedDraftModelIds(new Set());
      // Surface the picker immediately — discovery is only useful once a model
      // is chosen, so don't make the user find the second button below.
      setDraftModelPickerOpen(true);
      setDraftModelPickerSearch("");
    } finally {
      setDiscoveringDraft(false);
    }
  };

  const applySelectedDraftModel = () => {
    if (selectedDraftModelIds.size !== 1) return;
    const [onlyId] = selectedDraftModelIds;
    const model = draftDiscovery?.models.find((entry) => entry.id === onlyId);
    if (!model) return;
    patchForm(draftModelSelectionPatch(model));
    setDraftModelPickerOpen(false);
    setDraftModelPickerSearch("");
  };

  // Batch path for the draft discovery picker: one adapter per checked model,
  // mirroring handleSave's field mapping so batch-added channels are identical
  // to single-saved ones. Per-adapter balance secrets are never copied.
  const addSelectedDraftModels = async () => {
    const models = (draftDiscovery?.models ?? []).filter((model) =>
      selectedDraftModelIds.has(model.id),
    );
    if (models.length === 0) return;
    const baseURL = form.baseURL.trim();
    if (!baseURL) {
      setError(t("byokAdapters.baseURLRequired"));
      return;
    }
    const apiKey = form.apiKey.trim();
    if (!apiKey) {
      setError(t("byokAdapters.apiKeyRequired"));
      return;
    }
    const groupName = form.groupName.trim();
    const template = supplierTemplates.find((entry) => entry.id === form.supplier);
    const existingKeys = new Set(adapters.map((entry) => `${entry.baseURL}\u0000${entry.modelId}`));
    const additions: ByokModelAdapter[] = [];
    for (const model of models) {
      const key = `${baseURL}\u0000${model.id}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      additions.push({
        id: randomUUID(),
        displayName: model.id,
        ...(groupName ? { groupName } : {}),
        protocol: form.protocol,
        baseURL,
        apiKey,
        ...(form.balanceProfile !== "auto" ? { balanceProfile: form.balanceProfile } : {}),
        balanceAccessToken: "",
        ...(form.balanceUserID ? { balanceUserID: form.balanceUserID } : {}),
        modelId: model.id,
        contextWindowTokens: model.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        ...(form.supplier !== "custom" ? { supplierID: form.supplier } : {}),
        ...(template?.modelCatalogURLs ? { modelCatalogURLs: template.modelCatalogURLs } : {}),
        ...(template?.modelCatalogStatus
          ? { modelCatalogStatus: template.modelCatalogStatus }
          : {}),
        ...(template?.appendModelCatalogCandidates !== undefined
          ? { appendModelCatalogCandidates: template.appendModelCatalogCandidates }
          : {}),
      });
    }
    if (additions.length === 0) {
      setDraftModelPickerOpen(false);
      return;
    }
    setIsSaving(true);
    try {
      const saved = await onChange([...adapters, ...additions]);
      if (!saved) {
        setError(t("settingsSaveTryAgain"));
        return;
      }
      setSelectedDraftModelIds(new Set());
      setDraftModelPickerOpen(false);
      setDraftModelPickerSearch("");
      closeForm();
    } catch {
      setError(t("settingsSaveTryAgain"));
    } finally {
      setIsSaving(false);
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
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {!isEdit ? (
          <div className="block sm:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">
                  {t("byokAdapters.supplierTemplate")}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t("byokAdapters.supplierTemplateDescription")}
                </span>
              </span>
              {(() => {
                const selected = supplierTemplates.find((entry) => entry.id === form.supplier);
                if (!selected) return null;
                return (
                  <Badge variant="outline" size="sm" className="max-w-48 truncate">
                    {t("byokAdapters.supplierTemplateSelected", {
                      name: supplierTemplateLabel(selected),
                    })}
                  </Badge>
                );
              })()}
            </div>
            <div className="relative mt-2">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id={`${formId}-supplier-search`}
                aria-label={t("byokAdapters.supplierTemplateSearch")}
                className="h-8 pl-8 text-xs"
                value={supplierTemplateSearch}
                onChange={(event) => setSupplierTemplateSearch(event.target.value)}
                placeholder={t("byokAdapters.supplierTemplateSearch")}
                spellCheck={false}
              />
            </div>
            {filteredSupplierTemplates.length ? (
              <div className="mt-2 grid max-h-[min(34vh,20rem)] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
                {filteredSupplierTemplates.map((template) => {
                  const label = supplierTemplateLabel(template);
                  const selected = form.supplier === template.id;
                  const baseURL = template.baseURL.trim();
                  return (
                    <button
                      key={template.id}
                      type="button"
                      aria-pressed={selected}
                      className={cn(
                        "group/template grid min-h-24 w-full grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "border-primary/60 bg-primary/8"
                          : "border-border/70 bg-background hover:border-primary/35 hover:bg-muted/45",
                      )}
                      onClick={() => applySupplierTemplate(template.id)}
                    >
                      <SupplierTemplateIcon template={template} label={label} />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 truncate text-xs font-medium text-foreground">
                            {label}
                          </span>
                          {selected ? (
                            <CheckIcon className="size-3.5 shrink-0 text-primary" />
                          ) : null}
                        </span>
                        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                          <Badge variant="outline" size="sm">
                            {t(PROTOCOL_LABEL_KEYS[template.protocol])}
                          </Badge>
                          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                            {t("byokAdapters.supplierTemplateModelDiscovery")}
                          </span>
                        </span>
                        <code className="mt-1.5 block min-w-0 truncate text-[10px] text-muted-foreground">
                          {baseURL || t("byokAdapters.supplierTemplateManualBaseURL")}
                        </code>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {t("byokAdapters.supplierTemplateNoMatches")}
              </p>
            )}
          </div>
        ) : null}
        <label htmlFor={`${formId}-group-name`} className="block">
          <span className="text-xs font-medium text-foreground">{t("byokAdapters.groupName")}</span>
          <Input
            id={`${formId}-group-name`}
            className="mt-1"
            value={form.groupName}
            onChange={(event) => patchForm({ groupName: event.target.value })}
            placeholder={t("byokAdapters.defaultGroup")}
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
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("byokAdapters.protocolDescription")}
          </span>
        </label>
        <label htmlFor={`${formId}-base-url`} className="block sm:col-span-2">
          <span className="text-xs font-medium text-foreground">{t("byokAdapters.baseURL")}</span>
          <Input
            id={`${formId}-base-url`}
            data-facilities-guide-target="providers-base-url"
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
            data-facilities-guide-target="providers-api-key"
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
        <div className="block sm:col-span-2" data-facilities-guide-target="providers-request-model">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.requestModel")}
          </span>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/15 px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-xs text-foreground">
              {form.modelId || t("byokAdapters.modelNotSelected")}
            </code>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {!isEdit ? (
                <Button
                  type="button"
                  data-facilities-guide-target="providers-discover-models"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 px-2 text-xs"
                  onClick={() => void discoverDraftModels()}
                  disabled={discoveringDraft}
                >
                  <SearchIcon className="size-3" />
                  {discoveringDraft
                    ? t("byokAdapters.discovering")
                    : t("byokAdapters.discoverModels")}
                </Button>
              ) : null}
              <Button
                type="button"
                data-facilities-guide-target="providers-manual-model"
                size="sm"
                variant="ghost-muted"
                className="h-7 px-2 text-xs"
                onClick={openManualModelDialog}
              >
                {t("byokAdapters.supplierTemplateManualModel")}
              </Button>
            </div>
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("byokAdapters.requestModelDescription")}
          </span>
        </div>
        <details className="sm:col-span-2 rounded-md border border-border/60 bg-muted/10 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-foreground outline-none">
            {t("byokAdapters.balanceAdvancedSummary")}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
        </details>
        {!isEdit && draftDiscovery ? (
          <div className="sm:col-span-2">
            <span className="text-xs font-medium text-foreground">
              {t("byokAdapters.discoveredModels")}
            </span>
            {draftDiscovery.error && draftDiscovery.models.length === 0 ? (
              <p className="mt-1 text-xs text-destructive">
                {t("byokAdapters.discoveryFailed", { message: draftDiscovery.error.message })}
              </p>
            ) : null}
            {!draftDiscovery.error && draftDiscovery.models.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("byokAdapters.discoveryEmpty")}
              </p>
            ) : null}
            {draftDiscovery.models.length ? (
              <>
                <Button
                  type="button"
                  data-facilities-guide-target="providers-select-model"
                  size="sm"
                  variant="outline"
                  className="mt-1 h-8 w-full justify-start px-2 text-xs"
                  onClick={() => {
                    setDraftModelPickerSearch("");
                    setDraftModelPickerOpen(true);
                  }}
                >
                  {selectedDraftModelIds.size > 0
                    ? t("byokAdapters.changeDiscoveredModel")
                    : t("byokAdapters.chooseDiscoveredModel")}
                </Button>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedDraftModelIds.size > 1
                    ? t("byokAdapters.selectedModelsCount", {
                        count: selectedDraftModelIds.size,
                      })
                    : selectedDraftModelIds.size === 1
                      ? t("byokAdapters.selectedDiscoveredModel", {
                          modelId: [...selectedDraftModelIds][0] ?? "",
                        })
                      : t("byokAdapters.selectOneModelHint")}
                </p>
                <Dialog
                  open={draftModelPickerOpen}
                  onOpenChange={(open) => {
                    setDraftModelPickerOpen(open);
                    if (!open) setDraftModelPickerSearch("");
                  }}
                >
                  <DialogPopup className="w-full max-w-2xl p-0">
                    <DialogHeader>
                      <DialogTitle>{t("byokAdapters.modelPickerTitle")}</DialogTitle>
                      <DialogDescription>
                        {t("byokAdapters.modelPickerDescription")}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="px-6 pb-4">
                      <Input
                        aria-label={t("byokAdapters.modelPickerSearch")}
                        value={draftModelPickerSearch}
                        onChange={(event) => setDraftModelPickerSearch(event.target.value)}
                        placeholder={t("byokAdapters.modelPickerSearch")}
                        spellCheck={false}
                      />
                      {filteredDraftModels.length ? (
                        <div className="mt-3 max-h-[min(50vh,26rem)] space-y-1 overflow-y-auto pr-1">
                          {filteredDraftModels.map((model) => {
                            const selected = selectedDraftModelIds.has(model.id);
                            const checkboxId = `${formId}-discovered-model-${model.id}`;
                            return (
                              <label
                                key={model.id}
                                htmlFor={checkboxId}
                                className={cn(
                                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                                  selected
                                    ? "border-primary/50 bg-primary/8"
                                    : "border-border/70 hover:bg-muted/60",
                                )}
                              >
                                <Checkbox
                                  id={checkboxId}
                                  checked={selected}
                                  onCheckedChange={(checked) => {
                                    setSelectedDraftModelIds((current) => {
                                      const next = new Set(current);
                                      if (checked) {
                                        next.add(model.id);
                                      } else {
                                        next.delete(model.id);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                                <span className="min-w-0">
                                  <span className="block break-all text-foreground">
                                    {model.id}
                                  </span>
                                  {model.ownedBy || model.contextWindowTokens ? (
                                    <span className="mt-0.5 block text-xs text-muted-foreground">
                                      {[
                                        model.ownedBy,
                                        model.contextWindowTokens
                                          ? t("byokAdapters.contextWindowShort", {
                                              count: model.contextWindowTokens,
                                            })
                                          : undefined,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                  ) : null}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">
                          {t("byokAdapters.modelPickerNoMatches")}
                        </p>
                      )}
                    </div>
                    <DialogFooter>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost-muted"
                        onClick={() => setDraftModelPickerOpen(false)}
                      >
                        {t("cancel")}
                      </Button>
                      {selectedDraftModelIds.size > 1 ? (
                        <Button
                          type="button"
                          size="sm"
                          onClick={addSelectedDraftModels}
                          disabled={isSaving}
                        >
                          {t("byokAdapters.addSelectedModels", {
                            count: selectedDraftModelIds.size,
                          })}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          onClick={applySelectedDraftModel}
                          disabled={selectedDraftModelIds.size !== 1}
                        >
                          {t("byokAdapters.useSelectedModel")}
                        </Button>
                      )}
                    </DialogFooter>
                  </DialogPopup>
                </Dialog>
              </>
            ) : null}
            {draftDiscovery.fetchedAt ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t("byokAdapters.discoverySource", {
                  source: draftDiscovery.source,
                  fetchedAt: draftDiscovery.fetchedAt,
                })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </>
  );

  const renderDiscoveredModels = (adapter: ByokModelAdapter) => {
    const result = discovery[adapter.id];
    const requestError = discoveryErrors[adapter.id];
    if (!result) {
      return requestError ? (
        <div className="rounded-md border border-border/60 bg-muted/10 p-2.5">
          <p className="text-[10px] text-destructive">{requestError}</p>
        </div>
      ) : null;
    }
    const selected = selectedModels[adapter.id] ?? [];

    return (
      <div className="rounded-md border border-border/60 bg-muted/10 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">
            {t("byokAdapters.discoveredModels")}
          </span>
          {result.models.length ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => addDiscoveredModels(adapter)}
            >
              {t("byokAdapters.addSelectedModels", { count: selected.length })}
            </Button>
          ) : null}
        </div>
        {result.stale ? (
          <p className="mb-1 text-[10px] text-warning">{t("byokAdapters.discoveryStale")}</p>
        ) : null}
        {result.error && result.models.length === 0 ? (
          <p className="text-[10px] text-destructive">
            {t("byokAdapters.discoveryFailed", { message: result.error.message })}
          </p>
        ) : null}
        {!result.error && result.models.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">{t("byokAdapters.discoveryEmpty")}</p>
        ) : null}
        {result.models.length ? (
          <div className="grid max-h-48 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
            {result.models.map((model) => {
              const checked = selected.includes(model.id);
              return (
                <label key={model.id} className="flex min-w-0 items-center gap-1.5 text-[10px]">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelectedModels((current) => {
                        const selectedIds = new Set(current[adapter.id] ?? []);
                        if (selectedIds.has(model.id)) selectedIds.delete(model.id);
                        else selectedIds.add(model.id);
                        return { ...current, [adapter.id]: [...selectedIds] };
                      })
                    }
                  />
                  <code className="min-w-0 truncate">{model.id}</code>
                  {model.ownedBy ? (
                    <span className="truncate text-muted-foreground">({model.ownedBy})</span>
                  ) : null}
                </label>
              );
            })}
          </div>
        ) : null}
        {result.fetchedAt ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t("byokAdapters.discoverySource", {
              source: result.source,
              fetchedAt: result.fetchedAt,
            })}
          </p>
        ) : null}
      </div>
    );
  };

  const renderContextMatch = (adapter: ByokModelAdapter) => {
    const result = contextMatches[adapter.id];
    if (!result) return null;
    const changes = result.details.filter((detail) => detail.before !== detail.after);

    return (
      <div className="rounded-md border border-border/60 bg-muted/10 p-2.5 text-[10px]">
        <p className="text-muted-foreground">
          {t("byokAdapters.contextMatchSummary", {
            catalog: result.fromCatalog,
            probe: result.fromProbe,
            unchanged: result.unchanged,
          })}
        </p>
        {changes.length ? (
          <ul className="mt-1.5 space-y-1">
            {changes.slice(0, 6).map((detail) => (
              <li key={detail.adapterId} className="flex min-w-0 gap-1.5 text-foreground">
                <code className="min-w-0 truncate">{detail.modelId}</code>
                <span className="shrink-0 text-muted-foreground">
                  {t("byokAdapters.contextMatchChange", {
                    before: detail.before,
                    after: detail.after,
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-muted-foreground">{t("byokAdapters.contextMatchNoChanges")}</p>
        )}
      </div>
    );
  };

  return (
    <div
      data-byok-adapters-presentation={presentation}
      className={cn(presentation === "provider" && "border-t border-border/70 pt-5")}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{t("byokAdapters.title")}</span>
        <Button
          type="button"
          data-facilities-guide-target={
            presentation === "provider" ? "providers-add-channel" : undefined
          }
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

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {adapters.length === 0 && editing === null ? (
          <p className="text-xs text-muted-foreground">{t("byokAdapters.empty")}</p>
        ) : null}
        {adapterGroups.flatMap((group) =>
          group.relays.map((relay) => {
            const connectionAdapter = relay.adapters[0];
            if (!connectionAdapter) return null;
            return (
              <button
                type="button"
                key={`${group.groupName || "__default__"}\u0000${relay.protocol}\u0000${relay.baseURL}`}
                className="group/relay w-full rounded-lg border border-border/70 px-3 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setRelayDetailsTarget({
                    groupName: group.groupName,
                    protocol: relay.protocol,
                    baseURL: relay.baseURL,
                  })
                }
              >
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="shrink-0 font-medium text-foreground">
                    {group.groupName || t("byokAdapters.defaultGroup")}
                  </span>
                  <code className="min-w-0 truncate text-foreground/80">{relay.baseURL}</code>
                  <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/relay:translate-x-0.5" />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                  <Badge variant="outline" size="sm" className="shrink-0">
                    {t(PROTOCOL_LABEL_KEYS[relay.protocol])}
                  </Badge>
                  <span>
                    {connectionAdapter.apiKeyRedacted
                      ? t("byokAdapters.apiKeyStoredShort")
                      : maskApiKey(connectionAdapter.apiKey)}
                  </span>
                  <span>
                    {t("byokAdapters.connectionModelCount", {
                      count: relay.adapters.length,
                    })}
                  </span>
                </div>
                <div className="mt-3 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                  {relay.adapters.slice(0, 2).map((adapter) => (
                    <span key={adapter.id} className="max-w-32 truncate">
                      {adapter.displayName || adapter.modelId}
                    </span>
                  ))}
                  {relay.adapters.length > 2 ? <span>+{relay.adapters.length - 2}</span> : null}
                </div>
              </button>
            );
          }),
        )}
      </div>

      <Dialog
        open={relayDetailsTarget !== null && selectedRelay !== null}
        onOpenChange={(open) => {
          if (!open) setRelayDetailsTarget(null);
        }}
      >
        {selectedRelay && selectedRelayAdapter ? (
          <DialogPopup className="w-full max-w-3xl p-0">
            <DialogHeader>
              <DialogTitle>{t("byokAdapters.relay")}</DialogTitle>
              <DialogDescription>
                <code className="block truncate">{selectedRelay.baseURL}</code>
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[min(68dvh,42rem)] space-y-4 overflow-y-auto px-6 pb-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Badge variant="outline" size="sm">
                  {t(PROTOCOL_LABEL_KEYS[selectedRelay.protocol])}
                </Badge>
                <span>
                  {selectedRelayAdapter.apiKeyRedacted
                    ? t("byokAdapters.apiKeyStoredShort")
                    : maskApiKey(selectedRelayAdapter.apiKey)}
                </span>
                <span>
                  {t("byokAdapters.connectionModelCount", {
                    count: selectedRelay.adapters.length,
                  })}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 px-2 text-[10px]"
                  onClick={() => void discoverModels(selectedRelayAdapter)}
                  disabled={discoveringAdapterId !== null}
                >
                  <SearchIcon className="size-3" />
                  {discoveringAdapterId === selectedRelayAdapter.id
                    ? t("byokAdapters.discovering")
                    : t("byokAdapters.discoverModels")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  className="h-7 gap-1.5 px-2 text-[10px]"
                  onClick={() => void diagnoseContextWindows(selectedRelayAdapter)}
                  disabled={matchingContextAdapterId !== null}
                >
                  <SparklesIcon className="size-3" />
                  {matchingContextAdapterId === selectedRelayAdapter.id
                    ? t("byokAdapters.matchingContextWindows")
                    : t("byokAdapters.matchContextWindows")}
                </Button>
              </div>

              <div className="divide-y divide-border/60 border-y border-border/60">
                {selectedRelay.adapters.map((adapter) => (
                  <div
                    key={adapter.id}
                    className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-2"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 truncate text-xs text-foreground/90">
                        {adapter.displayName || adapter.modelId}
                      </span>
                      <code className="min-w-0 truncate text-[10px] text-muted-foreground">
                        {adapter.modelId}
                      </code>
                      <span className="text-[10px] text-muted-foreground/80">
                        {t("byokAdapters.contextWindowShort", {
                          count: adapter.contextWindowTokens,
                        })}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-micro"
                              variant="ghost-muted"
                              onClick={() => {
                                setRelayDetailsTarget(null);
                                editing === adapter.id ? closeForm() : openEdit(adapter);
                              }}
                              aria-label={`${t("byokAdapters.editAdapter")}: ${adapter.displayName}`}
                            >
                              <PencilIcon className="size-3" />
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">{t("byokAdapters.editAdapter")}</TooltipPopup>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-micro"
                              variant="ghost-muted"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => {
                                setRelayDetailsTarget(null);
                                setPendingDelete(adapter);
                              }}
                              aria-label={`${t("byokAdapters.deleteAdapter")}: ${adapter.displayName}`}
                            >
                              <Trash2Icon className="size-3" />
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">{t("byokAdapters.deleteAdapter")}</TooltipPopup>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                {renderDiscoveredModels(selectedRelayAdapter)}
                {renderContextMatch(selectedRelayAdapter)}
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                onClick={() => setRelayDetailsTarget(null)}
              >
                {t("cancel")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogPopup className="w-full max-w-3xl p-0">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? t("byokAdapters.addAdapter") : t("byokAdapters.editAdapter")}
            </DialogTitle>
            <DialogDescription>{t("byokAdapters.formDescription")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(68dvh,42rem)] overflow-y-auto px-6 pb-4">
            {editing === "new"
              ? renderForm(`byok-adapter-${instanceId}-new`, false)
              : editing
                ? renderForm(`byok-adapter-${instanceId}-${editing}`, true)
                : null}
          </div>
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost-muted" onClick={closeForm}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-facilities-guide-target="providers-save-channel"
              disabled={isSaving}
              onClick={handleSave}
            >
              {isSaving
                ? t("saving")
                : editing === "new"
                  ? t("byokAdapters.addAdapter")
                  : t("save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={manualModelDialogOpen}
        onOpenChange={(open) => {
          setManualModelDialogOpen(open);
          if (!open) setManualModelInput("");
        }}
      >
        <DialogPopup className="w-full max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("byokAdapters.manualModelDialogTitle")}</DialogTitle>
            <DialogDescription>{t("byokAdapters.manualModelDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-4">
            <label htmlFor={`byok-adapter-${instanceId}-manual-model`} className="block">
              <span className="text-xs font-medium text-foreground">
                {t("byokAdapters.modelId")}
              </span>
              <Input
                id={`byok-adapter-${instanceId}-manual-model`}
                data-facilities-guide-target="providers-manual-model-input"
                className="mt-1"
                value={manualModelInput}
                onChange={(event) => setManualModelInput(event.target.value)}
                placeholder={t("byokAdapters.manualModelPlaceholder")}
                spellCheck={false}
                autoFocus
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost-muted"
              onClick={() => setManualModelDialogOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button type="button" size="sm" onClick={applyManualModel}>
              {t("byokAdapters.useManualModel")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

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
