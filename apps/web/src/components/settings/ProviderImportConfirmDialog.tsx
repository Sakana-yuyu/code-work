"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ProviderInstanceId,
  type ByokModelAdapter,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import {
  findProviderImportDuplicate,
  maskProviderImportKey,
  type ProviderImportParseError,
  type ProviderImportPayload,
} from "@codework/shared/providerImport";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { t } from "~/i18n";
import type { ProviderImportRequest } from "../../lib/providerImportLink";
import { readByokModelAdapters } from "./ByokModelAdaptersSection";

type DuplicateChoice = "update-key" | "save-another";

const errorMessageKey = (error: ProviderImportParseError): string => {
  switch (error) {
    case "unsupported-version":
      return "providerImportErrorUnsupportedVersion";
    case "unsupported-protocol":
      return "providerImportErrorUnsupportedProtocol";
    case "invalid-url":
      return "providerImportErrorInvalidUrl";
    default:
      return "providerImportErrorInvalidLink";
  }
};

export function ProviderImportConfirmDialog({
  request,
  onClose,
}: {
  readonly request: ProviderImportRequest | null;
  readonly onClose: () => void;
}) {
  const payload = request?.payload ?? null;
  const primaryEnvironment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [duplicateChoice, setDuplicateChoice] = useState<DuplicateChoice>("update-key");
  const [isSaving, setIsSaving] = useState(false);
  const [modelIdError, setModelIdError] = useState(false);

  // Reset the form each time a new request arrives.
  useEffect(() => {
    setName(payload?.name ?? "");
    setApiKey(payload?.apiKey ?? "");
    setModelId("");
    setDuplicateChoice("update-key");
    setModelIdError(false);
  }, [payload]);

  const instances = (settings.providerInstances ?? {}) as Readonly<
    Record<string, ProviderInstanceConfig>
  >;

  const byokEntries = useMemo(
    () => Object.entries(instances).filter(([, instance]) => String(instance.driver) === "byok"),
    [instances],
  );

  // The duplicate the link would overwrite: same protocol at the same
  // request base, inside whichever byok instance already has it.
  const duplicate = useMemo(() => {
    if (payload === null) return null;
    for (const [instanceId, instance] of byokEntries) {
      const match = findProviderImportDuplicate(readByokModelAdapters(instance.config), payload);
      if (match !== undefined) return { instanceId, instance, adapter: match };
    }
    return null;
  }, [byokEntries, payload]);

  const protocolLabel = (protocol: ProviderImportPayload["protocol"]) => {
    switch (protocol) {
      case "anthropic":
        return "Anthropic";
      case "gemini":
        return "Gemini";
      default:
        return "OpenAI";
    }
  };

  const reportFailure = (error: unknown) => {
    toastManager.add({
      type: "error",
      title: t("settingsSaveFailed"),
      description: error instanceof Error ? error.message : t("settingsSaveTryAgain"),
    });
  };

  const handleSave = async () => {
    if (payload === null || primaryEnvironment === null || isSaving) return;

    if (duplicate !== null && duplicateChoice === "update-key") {
      setIsSaving(true);
      try {
        const { instanceId, instance, adapter } = duplicate;
        const nextAdapters = readByokModelAdapters(instance.config).map((current) =>
          current.id === adapter.id ? { ...current, apiKey: apiKey.trim() } : current,
        );
        const { config: _omitConfig, ...rest } = instance;
        const result = await updateSettings({
          providerInstances: {
            ...instances,
            [instanceId]: {
              ...rest,
              config: { ...(instance.config as Record<string, unknown>), adapters: nextAdapters },
            } as ProviderInstanceConfig,
          },
        });
        if (result?._tag === "Failure") return;
        toastManager.add({
          type: "success",
          title: t("providerImportKeyUpdated"),
          description: adapter.displayName,
        });
        onClose();
      } catch (error) {
        reportFailure(error);
      } finally {
        setIsSaving(false);
      }
      return;
    }

    if (modelId.trim().length === 0) {
      setModelIdError(true);
      return;
    }

    const nextAdapter: ByokModelAdapter = {
      id: randomUUID(),
      displayName: name.trim() || payload.name,
      protocol: payload.protocol,
      baseURL: payload.baseURL,
      apiKey: apiKey.trim(),
      modelId: modelId.trim(),
      contextWindowTokens: 128000,
      balanceAccessToken: "",
      customHeaders: "",
    };

    setIsSaving(true);
    try {
      const targetId = duplicate !== null ? duplicate.instanceId : (byokEntries[0]?.[0] ?? null);
      const instance = targetId === null ? undefined : instances[targetId];
      if (targetId !== null && instance !== undefined) {
        const nextAdapters = [...readByokModelAdapters(instance.config), nextAdapter];
        const { config: _omitConfig, ...rest } = instance;
        const result = await updateSettings({
          providerInstances: {
            ...instances,
            [targetId]: {
              ...rest,
              config: { ...(instance.config as Record<string, unknown>), adapters: nextAdapters },
            } as ProviderInstanceConfig,
          },
        });
        if (result?._tag === "Failure") return;
      } else {
        // No BYOK instance yet: the import creates one so the adapter has a home.
        const instanceId = "byok";
        const branded = ProviderInstanceId.make(instanceId);
        const result = await updateSettings({
          providerInstances: {
            ...instances,
            [branded]: {
              driver: "byok",
              enabled: true,
              displayName: t("settings.byok"),
              config: { adapters: [nextAdapter] },
            } as ProviderInstanceConfig,
          },
        });
        if (result?._tag === "Failure") return;
      }
      toastManager.add({
        type: "success",
        title: t("providerImportSaved"),
        description: nextAdapter.displayName,
      });
      onClose();
    } catch (error) {
      reportFailure(error);
    } finally {
      setIsSaving(false);
    }
  };

  const renderError = (error: ProviderImportParseError) => (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("providerImportErrorTitle")}</DialogTitle>
          <DialogDescription>{t(errorMessageKey(error))}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>{t("done")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  if (request === null) return null;
  if (request.error !== undefined) return renderError(request.error);
  if (payload === null) return null;

  const maskedKey = maskProviderImportKey(apiKey);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("providerImportTitle")}</DialogTitle>
          <DialogDescription>
            {primaryEnvironment !== null
              ? t("providerImportDescription", { environment: primaryEnvironment.label })
              : t("providerImportDescriptionNoEnvironment")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 px-6 py-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">{t("providerImportName")}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("providerImportProtocol")}</span>
              <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm">
                {protocolLabel(payload.protocol)}
              </p>
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("providerImportBaseUrl")}</span>
              <p className="truncate rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm">
                {payload.baseURL}
              </p>
            </div>
          </div>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">{t("providerImportApiKey")}</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("providerImportApiKeyEmpty")}
            />
            {maskedKey ? (
              <span className="text-xs text-muted-foreground">
                {t("providerImportApiKeyMasked", { key: maskedKey })}
              </span>
            ) : null}
          </label>

          {duplicate !== null ? (
            <div className="grid gap-2 rounded-md border border-border/60 p-3">
              <p className="text-sm">{t("providerImportDuplicateDescription")}</p>
              <RadioGroup
                value={duplicateChoice}
                onValueChange={(value) => setDuplicateChoice(value as DuplicateChoice)}
              >
                <label className="flex items-center gap-2 text-sm">
                  <Radio value="update-key" />
                  {t("providerImportUpdateKey")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Radio value="save-another" />
                  {t("providerImportSaveAnother")}
                </label>
              </RadioGroup>
            </div>
          ) : null}

          {duplicate === null || duplicateChoice === "save-another" ? (
            <label className="grid gap-1.5">
              <span className="text-sm font-medium">{t("providerImportModelId")}</span>
              <Input
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setModelIdError(false);
                }}
                placeholder={t("providerImportModelIdPlaceholder")}
                aria-invalid={modelIdError || undefined}
              />
              {modelIdError ? (
                <span className="text-xs text-destructive">
                  {t("providerImportModelIdRequired")}
                </span>
              ) : null}
            </label>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={isSaving || primaryEnvironment === null}
          >
            {duplicate !== null && duplicateChoice === "update-key"
              ? t("providerImportUpdateKey")
              : t("providerImportConfirm")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
