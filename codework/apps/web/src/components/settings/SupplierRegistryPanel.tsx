import type {
  CompositionSupplierRegistryResult,
  EnvironmentId,
  SupplierCredentialUpdate,
} from "@codework/contracts";
import { ProviderInstanceId } from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { t } from "~/i18n";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

/**
 * Credential rotation input per driver kind: BYOK instances rotate an
 * adapter's API key; every other driver rotates a sensitive environment
 * variable. The secret only travels inside the request payload — callers must
 * never place it in notices, errors, or test ids.
 */
export const buildSupplierCredentialInput = (input: {
  readonly driverKind: string;
  readonly target: string;
  readonly secret: string;
}): SupplierCredentialUpdate =>
  input.driverKind === "byok"
    ? { kind: "byok_adapter", adapterId: input.target.trim(), apiKey: input.secret }
    : { kind: "environment_variable", name: input.target.trim(), value: input.secret };

export function SupplierRegistryPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const registryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.supplierRegistry({ environmentId, input: {} }),
  );
  const setInstanceEnabled = useAtomCommand(serverEnvironment.supplierSetInstanceEnabled, {
    reportFailure: false,
  });
  const updateCredential = useAtomCommand(serverEnvironment.supplierUpdateCredential, {
    reportFailure: false,
  });
  const [credentialOpenFor, setCredentialOpenFor] = useState<string | null>(null);
  const [credentialTarget, setCredentialTarget] = useState("");
  const [credentialSecret, setCredentialSecret] = useState("");
  const [pendingInstanceId, setPendingInstanceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const registry: CompositionSupplierRegistryResult | null = registryQuery.data ?? null;

  const runSupplierCommand = async (
    instanceId: string,
    fallbackErrorKey: string,
    execute: (envId: EnvironmentId) => Promise<AtomCommandResult<unknown, unknown>>,
    onSuccess?: () => void,
  ): Promise<void> => {
    if (environmentId === null) return;
    setPendingInstanceId(instanceId);
    setActionError(null);
    setActionNotice(null);
    const result = await execute(environmentId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t(fallbackErrorKey));
    } else {
      onSuccess?.();
      registryQuery.refresh();
    }
    setPendingInstanceId(null);
  };

  const toggleEnabled = (input: {
    readonly instanceId: string;
    readonly enabled: boolean;
  }): Promise<void> =>
    runSupplierCommand(input.instanceId, "supplierRegistry.toggleFailed", (envId) =>
      setInstanceEnabled({
        environmentId: envId,
        input: {
          instanceId: ProviderInstanceId.make(input.instanceId),
          enabled: !input.enabled,
        },
      }),
    );

  const submitCredential = (input: {
    readonly instanceId: string;
    readonly driverKind: string;
  }): Promise<void> =>
    runSupplierCommand(
      input.instanceId,
      "supplierRegistry.credentialFailed",
      (envId) =>
        updateCredential({
          environmentId: envId,
          input: {
            instanceId: ProviderInstanceId.make(input.instanceId),
            credential: buildSupplierCredentialInput({
              driverKind: input.driverKind,
              target: credentialTarget,
              secret: credentialSecret,
            }),
          },
        }),
      () => {
        // 提示只携带目标标识，绝不携带凭据值。
        setActionNotice(`${t("supplierRegistry.credentialUpdated")}: ${credentialTarget.trim()}`);
        setCredentialOpenFor(null);
        setCredentialTarget("");
        setCredentialSecret("");
      },
    );

  return (
    <SettingsSection id="supplier-registry" title={t("supplierRegistry.title")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t("supplierRegistry.suppliers")}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => registryQuery.refresh()}
          aria-label={t("supplierRegistry.refresh")}
        >
          <RefreshCwIcon className="size-3.5" />
          {t("supplierRegistry.refresh")}
        </Button>
      </div>
      {environmentId === null ? (
        <p className="text-xs text-muted-foreground">{t("supplierRegistry.noEnvironment")}</p>
      ) : registryQuery.isPending ? (
        <p className="text-xs text-muted-foreground">{t("supplierRegistry.pending")}</p>
      ) : registryQuery.error !== null ? (
        <p className="text-xs text-destructive">{t("supplierRegistry.error")}</p>
      ) : registry === null || registry.suppliers.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("supplierRegistry.noData")}</p>
      ) : (
        <ul className="space-y-2">
          {registry.suppliers.map((supplier) => {
            const credentialOpen = credentialOpenFor === supplier.instanceId;
            return (
              <li
                key={supplier.instanceId}
                className="rounded-md border border-border/60 px-3 py-2 text-xs"
                data-supplier-id={supplier.instanceId}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">
                    {supplier.displayName ?? supplier.instanceId}
                  </span>
                  <Badge variant="outline">{supplier.driverKind}</Badge>
                  {supplier.enabled ? (
                    <Badge variant="secondary">{t("supplierRegistry.enabled")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("supplierRegistry.disabled")}</Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pendingInstanceId !== null}
                    data-testid={`supplier-toggle-${supplier.instanceId}`}
                    onClick={() => {
                      void toggleEnabled({
                        instanceId: supplier.instanceId,
                        enabled: supplier.enabled,
                      });
                    }}
                  >
                    {t(supplier.enabled ? "supplierRegistry.disable" : "supplierRegistry.enable")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pendingInstanceId !== null}
                    data-testid={`supplier-credential-toggle-${supplier.instanceId}`}
                    onClick={() => {
                      setActionError(null);
                      setActionNotice(null);
                      setCredentialTarget("");
                      setCredentialSecret("");
                      setCredentialOpenFor(credentialOpen ? null : supplier.instanceId);
                    }}
                  >
                    {t("supplierRegistry.updateCredential")}
                  </Button>
                </div>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {supplier.continuationKey}
                </p>
                {supplier.defaultModelId === undefined ? null : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {`${t("supplierRegistry.defaultModel")}: ${supplier.defaultModelId}`}
                  </p>
                )}
                {supplier.profile === undefined ? null : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {`${t("supplierRegistry.profile")}: ${supplier.profile.agentId} · ${supplier.profile.status}`}
                  </p>
                )}
                {credentialOpen ? (
                  <div
                    className="mt-2 space-y-1"
                    data-testid={`supplier-credential-form-${supplier.instanceId}`}
                  >
                    <Input
                      value={credentialTarget}
                      onChange={(event) => setCredentialTarget(event.target.value)}
                      placeholder={t(
                        supplier.driverKind === "byok"
                          ? "supplierRegistry.credentialAdapterId"
                          : "supplierRegistry.credentialEnvName",
                      )}
                      aria-label={t(
                        supplier.driverKind === "byok"
                          ? "supplierRegistry.credentialAdapterId"
                          : "supplierRegistry.credentialEnvName",
                      )}
                      className="h-7 text-xs"
                    />
                    <Input
                      type="password"
                      value={credentialSecret}
                      onChange={(event) => setCredentialSecret(event.target.value)}
                      placeholder={t("supplierRegistry.credentialValue")}
                      aria-label={t("supplierRegistry.credentialValue")}
                      className="h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      disabled={pendingInstanceId !== null || credentialTarget.trim() === ""}
                      data-testid={`supplier-credential-submit-${supplier.instanceId}`}
                      onClick={() => {
                        void submitCredential({
                          instanceId: supplier.instanceId,
                          driverKind: supplier.driverKind,
                        });
                      }}
                    >
                      {t("supplierRegistry.credentialSubmit")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {actionError === null ? null : (
        <p className="text-xs text-destructive" data-testid="supplier-registry-action-error">
          {actionError}
        </p>
      )}
      {actionNotice === null ? null : (
        <p className="text-xs text-muted-foreground" data-testid="supplier-registry-action-notice">
          {actionNotice}
        </p>
      )}
      {registry === null || registry.orphanProfileAgentIds.length === 0 ? null : (
        <p
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="supplier-registry-orphans"
        >
          {`${t("supplierRegistry.orphanProfiles")}: ${registry.orphanProfileAgentIds.join(", ")}`}
        </p>
      )}
    </SettingsSection>
  );
}
