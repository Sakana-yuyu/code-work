import { RefreshCwIcon } from "lucide-react";

import type { CompositionSupplierRegistryEntry } from "@codework/contracts";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { t } from "~/i18n";

/** Supplier 条目显示名：displayName 缺省时回退实例 ID。 */
const supplierDisplayName = (entry: CompositionSupplierRegistryEntry): string =>
  entry.displayName ?? entry.instanceId;

/** 默认模型优先显示名称（如 BYOK 适配器名），旧数据没有名称时回退原始 id。 */
const supplierDefaultModelLabel = (entry: CompositionSupplierRegistryEntry): string | undefined =>
  entry.defaultModelName ?? entry.defaultModelId;

const SUPPLIER_BADGE_CLASS = "rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground";

/**
 * Supplier/Profile/Account 只读投影（与移动端 Supplier 注册表页同源）：
 * 每个 Provider 实例条目展示账号延续身份与派生档案，孤儿档案单独警示。
 * 只读，无任何写路径。
 */
export function SupplierRegistrySettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.supplierRegistry({ environmentId, input: {} }),
  );
  const registry = data ?? null;
  const suppliers = registry?.suppliers ?? [];

  return (
    <SettingsSection
      {...searchableSetting("supplier-registry")}
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("refresh")}
          disabled={environmentId === null || isPending}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon />
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs text-muted-foreground">
        <p>{t("supplierRegistry.description")}</p>
        {environmentId === null ? (
          <EmptyRow>{t("supplierRegistry.noEnvironment")}</EmptyRow>
        ) : registry === null && isPending ? (
          <EmptyRow>{t("supplierRegistry.pending")}</EmptyRow>
        ) : registry === null && error !== null ? (
          <EmptyRow tone="danger">{t("supplierRegistry.error")}</EmptyRow>
        ) : suppliers.length === 0 ? (
          <EmptyRow>{t("supplierRegistry.noData")}</EmptyRow>
        ) : (
          <ul className="flex flex-col gap-2">
            {suppliers.map((supplier) => (
              <li
                key={supplier.instanceId}
                className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">
                    {supplierDisplayName(supplier)}
                  </span>
                  <span className={SUPPLIER_BADGE_CLASS}>{supplier.driverKind}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      supplier.enabled
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {t(supplier.enabled ? "supplierRegistry.enabled" : "supplierRegistry.disabled")}
                  </span>
                </div>
                <span className="truncate font-mono text-[11px] text-muted-foreground/80">
                  {supplier.continuationKey}
                </span>
                {supplierDefaultModelLabel(supplier) === undefined ? null : (
                  <span>
                    {t("supplierRegistry.defaultModel")}: {supplierDefaultModelLabel(supplier)}
                  </span>
                )}
                {supplier.profile === undefined ? null : (
                  <span>
                    {t("supplierRegistry.profile")}: {supplier.profile.agentId} ·{" "}
                    {supplier.profile.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {registry !== null && registry.orphanProfileAgentIds.length > 0 ? (
          <p className="text-destructive">
            {t("supplierRegistry.orphanProfiles")}: {registry.orphanProfileAgentIds.join(", ")}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function EmptyRow(props: { readonly children: string; readonly tone?: "danger" }) {
  return (
    <p
      className={`rounded-xl border border-dashed border-border/70 px-3 py-6 text-center ${
        props.tone === "danger" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {props.children}
    </p>
  );
}
