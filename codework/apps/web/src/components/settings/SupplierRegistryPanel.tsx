import type { CompositionSupplierRegistryResult } from "@codework/contracts";
import { RefreshCwIcon } from "lucide-react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { t } from "~/i18n";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function SupplierRegistryPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const registryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.supplierRegistry({ environmentId, input: {} }),
  );

  const registry: CompositionSupplierRegistryResult | null = registryQuery.data ?? null;

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
          {registry.suppliers.map((supplier) => (
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
            </li>
          ))}
        </ul>
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
