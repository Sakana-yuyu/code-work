import type { AcpRegistryCatalogEntry, EnvironmentId } from "@codework/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { byokEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  MOBILE_ACP_CATALOG_VISIBLE_LIMIT,
  filterAcpCatalogEntries,
} from "./SettingsProvidersRouteScreen.logic";

const CONFIGURED_STATUS_KEYS: Readonly<
  Record<
    Exclude<NonNullable<AcpRegistryCatalogEntry["configuredStatus"]>, "not-configured">,
    string
  >
> = {
  checking: "providersMobile.acpCatalogStatusChecking",
  ready: "providersMobile.acpCatalogStatusReady",
  missing: "providersMobile.acpCatalogStatusMissing",
  error: "providersMobile.acpCatalogStatusError",
  disabled: "providersMobile.acpCatalogStatusDisabled",
};

/** ACP 目录来自所选环境的服务端；选择后仍可在实例卡片中修改命令。 */
export function AcpRegistryCatalogSection(props: {
  readonly environmentId: EnvironmentId;
  readonly selectedEntry: AcpRegistryCatalogEntry | null;
  readonly disabled: boolean;
  readonly onSelect: (entry: AcpRegistryCatalogEntry | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const activeInstall = useRef<symbol | null>(null);
  const selection = useRef<symbol | null>(null);
  const selected = props.selectedEntry;
  useEffect(() => {
    selection.current = Symbol();
    setInstallError(null);
    return () => {
      selection.current = null;
    };
  }, [props.environmentId, selected?.id, selected?.command, props.disabled]);
  const catalogQuery = useEnvironmentQuery(
    byokEnvironment.acpRegistryCatalog({ environmentId: props.environmentId, input: {} }),
  );
  const installBinary = useAtomCommand(byokEnvironment.installAcpRegistryBinary, {
    reportFailure: false,
  });
  const catalog = catalogQuery.data;
  const matches = useMemo(
    () => filterAcpCatalogEntries(catalog?.entries ?? [], query),
    [catalog, query],
  );
  const visible = matches.slice(0, MOBILE_ACP_CATALOG_VISIBLE_LIMIT);
  const hidden = matches.length - visible.length;
  const downloadEntry = async (entry: AcpRegistryCatalogEntry) => {
    if (!entry.binaryDistribution || props.disabled || activeInstall.current !== null) return;
    const request = Symbol();
    const selectedAtStart = selection.current;
    activeInstall.current = request;
    setInstallingId(entry.id);
    setInstallError(null);
    try {
      const outcome = await installBinary({
        environmentId: props.environmentId,
        input: { entryId: entry.id },
      });
      if (selection.current !== selectedAtStart || isAtomCommandInterrupted(outcome)) return;
      if (outcome._tag !== "Success") {
        const failure = squashAtomCommandFailure(outcome);
        setInstallError(
          failure instanceof Error
            ? failure.message
            : typeof failure === "object" &&
                failure !== null &&
                "detail" in failure &&
                typeof failure.detail === "string"
              ? failure.detail
              : String(failure),
        );
        return;
      }
      props.onSelect({
        ...entry,
        command: outcome.value.command,
        availability: "installable",
      });
    } catch (error) {
      if (selection.current === selectedAtStart)
        setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeInstall.current === request) {
        activeInstall.current = null;
        if (selection.current !== null) setInstallingId(null);
      }
    }
  };

  return (
    <View className="gap-2 rounded-2xl border border-input-border p-3">
      <Text className="text-sm font-codework-medium text-foreground">
        {t("providersMobile.acpCatalogTitle")}
      </Text>
      <Text className="text-xs leading-5 text-foreground-muted">
        {t("providersMobile.acpCatalogDescription")}
      </Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t("providersMobile.acpCatalogSearch")}
        accessibilityLabel={t("providersMobile.acpCatalogSearch")}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
      />
      {catalogQuery.error !== null ? (
        <Text className="text-xs text-danger-foreground">
          {t("providersMobile.acpCatalogUnavailable")}
        </Text>
      ) : catalog?.source === "bundled" ? (
        <Text className="text-xs text-foreground-muted">
          {t("providersMobile.acpCatalogOffline", { date: catalog.snapshotDate ?? "" })}
        </Text>
      ) : catalog?.error ? (
        <Text className="text-xs text-danger-foreground">
          {t("providersMobile.acpCatalogUnavailable")}
        </Text>
      ) : null}
      {installError ? (
        <Text className="text-xs text-danger-foreground">
          {t("providersMobile.acpCatalogDownloadFailed", { detail: installError })}
        </Text>
      ) : null}
      {catalog === null ? (
        catalogQuery.error === null ? (
          <Text className="text-xs text-foreground-muted">
            {t("providersMobile.acpCatalogLoading")}
          </Text>
        ) : null
      ) : visible.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          {t("providersMobile.acpCatalogEmpty")}
        </Text>
      ) : (
        <View className="overflow-hidden rounded-xl border border-border-subtle">
          {visible.map((entry) => {
            const installedCommand =
              entry.id === selected?.id &&
              selected?.command &&
              entry.command === null &&
              entry.binaryDistribution
                ? selected.command
                : null;
            const rowEntry =
              installedCommand === null
                ? entry
                : { ...entry, command: installedCommand, availability: "installable" as const };
            return (
              <CatalogRow
                key={entry.id}
                entry={rowEntry}
                selected={entry.id === selected?.id && rowEntry.command !== null}
                disabled={props.disabled || installingId !== null}
                downloading={installingId === entry.id}
                onSelect={() => props.onSelect(entry.id === selected?.id ? null : rowEntry)}
                onDownload={() => void downloadEntry(entry)}
              />
            );
          })}
        </View>
      )}
      {hidden > 0 ? (
        <Text className="text-xs text-foreground-muted">
          {t("providersMobile.acpCatalogMore", { countValue: hidden })}
        </Text>
      ) : null}
      {selected ? <SelectedEntryDetails entry={selected} /> : null}
      <Text className="text-xs leading-5 text-foreground-muted">
        {t("providersMobile.acpCatalogInstallHint")}
      </Text>
    </View>
  );
}

function CatalogRow(props: {
  readonly entry: AcpRegistryCatalogEntry;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly downloading: boolean;
  readonly onSelect: () => void;
  readonly onDownload: () => void;
}) {
  const { entry } = props;
  const status =
    entry.configuredStatus && entry.configuredStatus !== "not-configured"
      ? t(CONFIGURED_STATUS_KEYS[entry.configuredStatus])
      : null;
  return (
    <View className="flex-row flex-wrap items-start gap-2 border-b border-border-subtle p-2.5 last:border-b-0">
      <AgentIcon entry={entry} />
      <View className="min-w-0 flex-1 basis-48 gap-0.5">
        <Text className="text-sm font-codework-medium text-foreground" numberOfLines={1}>
          {entry.version ? `${entry.name} ${entry.version}` : entry.name}
        </Text>
        {status ? <Text className="text-xs text-foreground-muted">{status}</Text> : null}
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {entry.description}
        </Text>
      </View>
      {entry.command !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("providersMobile.acpCatalogUseAgent", { name: entry.name })}
          accessibilityState={{ selected: props.selected, disabled: props.disabled }}
          disabled={props.disabled}
          onPress={props.onSelect}
          className={
            props.selected
              ? "shrink-0 rounded-full bg-accent px-3 py-1.5"
              : "shrink-0 rounded-full border border-input-border px-3 py-1.5"
          }
        >
          <Text
            className={
              props.selected
                ? "text-xs font-codework-medium text-accent-foreground"
                : "text-xs text-foreground"
            }
          >
            {props.selected
              ? t("providersMobile.acpCatalogSelected")
              : t("providersMobile.acpCatalogUse")}
          </Text>
        </Pressable>
      ) : entry.binaryDistribution ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("providersMobile.acpCatalogDownloadAgent", { name: entry.name })}
          accessibilityState={{ disabled: props.disabled }}
          disabled={props.disabled}
          onPress={props.onDownload}
          className="shrink-0 rounded-full border border-input-border px-3 py-1.5"
        >
          <Text className="text-xs text-foreground">
            {props.downloading
              ? t("providersMobile.acpCatalogDownloading")
              : t("providersMobile.acpCatalogDownload")}
          </Text>
        </Pressable>
      ) : (
        <Text className="shrink-0 text-xs text-foreground-muted">
          {t(
            entry.availability === "unsupported-platform"
              ? "providersMobile.acpCatalogUnsupported"
              : "providersMobile.acpCatalogManual",
          )}
        </Text>
      )}
    </View>
  );
}

function AgentIcon(props: { readonly entry: AcpRegistryCatalogEntry }) {
  const [failed, setFailed] = useState(false);
  const uri = props.entry.iconUrl;
  if (!uri || failed) {
    return (
      <View className="mt-0.5 size-7 items-center justify-center rounded-md border border-border-subtle bg-input">
        <Text className="text-[10px] text-foreground-muted">
          {props.entry.name.trim().charAt(0).toUpperCase() || "?"}
        </Text>
      </View>
    );
  }
  return (
    <View className="mt-0.5 size-7 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-input">
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri }}
        style={{ width: 20, height: 20 }}
        contentFit="contain"
        onError={() => setFailed(true)}
      />
    </View>
  );
}

function SelectedEntryDetails(props: { readonly entry: AcpRegistryCatalogEntry }) {
  const { entry } = props;
  return (
    <View className="gap-1.5 rounded-xl bg-input p-3">
      {entry.command ? (
        <Text className="font-mono text-xs text-foreground" selectable>
          {entry.command}
        </Text>
      ) : null}
      {entry.binaryDistribution ? (
        <>
          <Text className="text-xs text-foreground-muted">
            {t("providersMobile.acpCatalogDownloadDetail", {
              hash: entry.binaryDistribution.sha256.slice(0, 12),
            })}
          </Text>
          <LinkText
            label={t("providersMobile.acpCatalogArchive")}
            url={entry.binaryDistribution.archiveUrl}
          />
        </>
      ) : null}
      {entry.setup ? (
        <>
          <Text className="text-xs text-foreground-muted">
            {t("providersMobile.acpCatalogManualPreset", { date: entry.setup.verifiedAt })}
          </Text>
          <View className="flex-row flex-wrap gap-x-3 gap-y-1">
            <LinkText
              label={t("providersMobile.acpCatalogInstallation")}
              url={entry.setup.installationUrl}
            />
            <LinkText
              label={t("providersMobile.acpCatalogDocumentation")}
              url={entry.setup.documentationUrl}
            />
          </View>
        </>
      ) : null}
      {entry.environment && entry.environment.length > 0 ? (
        <>
          <Text className="text-xs text-foreground-muted">
            {t("providersMobile.acpCatalogEnvironment")}
          </Text>
          {entry.environment.map((variable) => (
            <Text key={variable.name} className="font-mono text-xs text-foreground" selectable>
              {`${variable.name}=${variable.sensitive ? "••••" : variable.value}`}
            </Text>
          ))}
        </>
      ) : null}
      {entry.supportsMcpServers === false ? (
        <Text className="text-xs text-foreground-muted">
          {t("providersMobile.acpCatalogMcpDisabled")}
        </Text>
      ) : null}
    </View>
  );
}

function LinkText(props: { readonly label: string; readonly url: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(props.url)}>
      <Text className="text-xs text-accent underline">{props.label}</Text>
    </Pressable>
  );
}
