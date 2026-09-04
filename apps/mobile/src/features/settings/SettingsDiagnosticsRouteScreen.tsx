import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  ResourceTelemetrySnapshot,
  ResourceTelemetrySourceStatus,
  ServerProcessDiagnosticsEntry,
  ServerProcessSignal,
} from "@codework/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";

const RESOURCE_WINDOW_MS = 15 * 60_000;
const RESOURCE_BUCKET_MS = 60_000;
const TELEMETRY_HISTORY_WINDOW_MS = 15 * 60_000;
const TELEMETRY_HISTORY_BUCKET_MS = 30_000;

export function SettingsDiagnosticsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const processQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  );
  const resourceQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processResourceHistory({
          environmentId,
          input: { windowMs: RESOURCE_WINDOW_MS, bucketMs: RESOURCE_BUCKET_MS },
        }),
  );
  const telemetryHistoryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.resourceTelemetryHistory({
          environmentId,
          input: {
            windowMs: TELEMETRY_HISTORY_WINDOW_MS,
            bucketMs: TELEMETRY_HISTORY_BUCKET_MS,
          },
        }),
  );
  const telemetryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.resourceTelemetry({ environmentId, input: {} }),
  );
  const traceQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
  );
  const signalProcess = useAtomCommand(serverEnvironment.signalProcess, { reportFailure: false });
  const retryResourceTelemetry = useAtomCommand(serverEnvironment.retryResourceTelemetry, {
    reportFailure: false,
  });
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const [retryingTelemetry, setRetryingTelemetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const processError = processQuery.data ? Option.getOrNull(processQuery.data.error) : null;
  const resourceError = resourceQuery.data ? Option.getOrNull(resourceQuery.data.error) : null;
  const traceError = traceQuery.data ? Option.getOrNull(traceQuery.data.error) : null;
  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);
  const refresh = (): void => {
    processQuery.refresh();
    resourceQuery.refresh();
    telemetryHistoryQuery.refresh();
    telemetryQuery.refresh();
    traceQuery.refresh();
  };

  const retryTelemetry = async (): Promise<void> => {
    if (environmentId === null || retryingTelemetry) return;
    setRetryingTelemetry(true);
    setError(null);
    try {
      const result = await retryResourceTelemetry({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : t("diagnosticsMobile.retryFailed"));
        }
      } else {
        telemetryQuery.refresh();
      }
    } finally {
      setRetryingTelemetry(false);
    }
  };

  const sendSignal = async (
    process: ServerProcessDiagnosticsEntry,
    signal: ServerProcessSignal,
  ) => {
    if (environmentId === null || signalingPid !== null) return;
    if (signal === "SIGKILL") {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          t("diagnosticsMobile.killTitle", { pid: process.pid }),
          t("diagnosticsMobile.killDescription"),
          [
            { text: t("cancel"), style: "cancel", onPress: () => resolve(false) },
            {
              text: t("diagnosticsMobile.kill"),
              style: "destructive",
              onPress: () => resolve(true),
            },
          ],
        );
      });
      if (!confirmed) return;
    }
    setSignalingPid(process.pid);
    setError(null);
    const result = await signalProcess({
      environmentId,
      input: { pid: process.pid, startTimeMs: process.startTimeMs, signal },
    });
    if (result._tag === "Failure") {
      setError(t("diagnosticsMobile.signalFailed"));
    } else if (!result.value.signaled) {
      setError(Option.getOrNull(result.value.message) ?? t("diagnosticsMobile.processUnavailable"));
    } else {
      processQuery.refresh();
    }
    setSignalingPid(null);
  };

  const isLoading =
    processQuery.data === null &&
    processQuery.isPending &&
    resourceQuery.data === null &&
    telemetryQuery.data === null;
  const processData = processQuery.data;
  const resourceData = resourceQuery.data;
  const telemetryData = telemetryQuery.data;
  const telemetryHistoryData = telemetryHistoryQuery.data;
  const traceData = traceQuery.data;
  const telemetryBuckets = telemetryHistoryData?.buckets ?? [];
  const peakCpu = Math.max(0, ...telemetryBuckets.map((bucket) => bucket.maxCpuPercent));
  const peakMemory = Math.max(0, ...telemetryBuckets.map((bucket) => bucket.maxRssBytes));

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("diagnosticsMobile.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refresh} />}
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("diagnosticsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={signalingPid !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("diagnosticsMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        <SettingsSection title={t("diagnosticsMobile.liveProcesses")} card>
          {processQuery.data === null && processQuery.isPending ? (
            <StatusMessage text={t("diagnosticsMobile.loading")} />
          ) : processQuery.error !== null ? (
            <StatusMessage text={t("diagnosticsMobile.loadFailed")} tone="danger" />
          ) : (
            <>
              <StatsRow
                values={[
                  [t("diagnosticsMobile.processes"), String(processData?.processCount ?? 0)],
                  [
                    t("diagnosticsMobile.cpu"),
                    `${(processData?.totalCpuPercent ?? 0).toFixed(1)}%`,
                  ],
                  [t("diagnosticsMobile.memory"), formatBytes(processData?.totalRssBytes ?? 0)],
                  [t("diagnosticsMobile.serverPid"), String(processData?.serverPid ?? "-")],
                ]}
              />
              {processError === null ? null : (
                <StatusMessage text={processError.message} tone="danger" />
              )}
              {(processData?.processes ?? []).length === 0 ? (
                <StatusMessage text={t("diagnosticsMobile.noProcesses")} />
              ) : (
                processData?.processes.map((process) => (
                  <ProcessCard
                    key={`${process.pid}:${process.startTimeMs}`}
                    process={process}
                    disabled={signalingPid !== null}
                    pending={signalingPid === process.pid}
                    onSignal={(signal) => void sendSignal(process, signal)}
                  />
                ))
              )}
            </>
          )}
        </SettingsSection>
        <SettingsSection title={t("diagnosticsMobile.liveTelemetry")} card>
          {telemetryData === null && telemetryQuery.isPending ? (
            <StatusMessage text={t("diagnosticsMobile.loading")} />
          ) : telemetryQuery.error !== null ? (
            <>
              <StatusMessage text={t("diagnosticsMobile.loadFailed")} tone="danger" />
              <View className="p-4">
                <ActionButton
                  label={
                    retryingTelemetry
                      ? t("diagnosticsMobile.retrying")
                      : t("diagnosticsMobile.retryMonitor")
                  }
                  disabled={retryingTelemetry || signalingPid !== null}
                  onPress={() => void retryTelemetry()}
                />
              </View>
            </>
          ) : telemetryData === null ? (
            <StatusMessage text={t("diagnosticsMobile.waitingForTelemetry")} />
          ) : (
            <TelemetrySnapshotCard
              snapshot={telemetryData}
              retrying={retryingTelemetry}
              onRetry={() => void retryTelemetry()}
            />
          )}
        </SettingsSection>
        <SettingsSection title={t("diagnosticsMobile.resourceHistory")} card>
          {resourceQuery.data === null && resourceQuery.isPending ? (
            <StatusMessage text={t("diagnosticsMobile.loading")} />
          ) : resourceQuery.error !== null ? (
            <StatusMessage text={t("diagnosticsMobile.loadFailed")} tone="danger" />
          ) : (
            <>
              <StatsRow
                values={[
                  [
                    t("diagnosticsMobile.cpuTime"),
                    formatCpuTime(resourceData?.totalCpuSecondsApprox ?? 0),
                  ],
                  [t("diagnosticsMobile.samples"), String(resourceData?.retainedSampleCount ?? 0)],
                  [
                    t("diagnosticsMobile.interval"),
                    formatDuration(resourceData?.sampleIntervalMs ?? 0),
                  ],
                  [
                    t("diagnosticsMobile.processes"),
                    String(resourceData?.topProcesses.length ?? 0),
                  ],
                ]}
              />
              {resourceError === null ? null : (
                <StatusMessage text={resourceError.message} tone="danger" />
              )}
              {(resourceData?.topProcesses ?? []).map((process) => (
                <View
                  key={process.processKey}
                  className="gap-1 border-b border-border-subtle p-4 last:border-b-0"
                >
                  <Text className="text-sm font-codework-medium text-foreground" numberOfLines={2}>
                    {process.command}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {`${t("diagnosticsMobile.cpuTime")}: ${process.cpuSecondsApprox.toFixed(1)}s · ${t("diagnosticsMobile.memory")}: ${formatBytes(process.currentRssBytes)}`}
                  </Text>
                </View>
              ))}
            </>
          )}
        </SettingsSection>
        <SettingsSection title={t("diagnosticsMobile.resourceTimeline")} card>
          {telemetryHistoryData === null && telemetryHistoryQuery.isPending ? (
            <StatusMessage text={t("diagnosticsMobile.loading")} />
          ) : telemetryHistoryQuery.error !== null ? (
            <StatusMessage text={t("diagnosticsMobile.loadFailed")} tone="danger" />
          ) : (
            <>
              <StatsRow
                values={[
                  [
                    t("diagnosticsMobile.samples"),
                    String(telemetryHistoryData?.retainedSampleCount ?? 0),
                  ],
                  [
                    t("diagnosticsMobile.interval"),
                    formatDuration(telemetryHistoryData?.sampleIntervalMs ?? 0),
                  ],
                  [t("diagnosticsMobile.peakCpu"), `${peakCpu.toFixed(1)}%`],
                  [t("diagnosticsMobile.peakMemory"), formatBytes(peakMemory)],
                ]}
              />
              {telemetryBuckets.length === 0 ? (
                <StatusMessage text={t("diagnosticsMobile.noTimelineData")} />
              ) : (
                telemetryBuckets.slice(-12).map((bucket) => (
                  <View
                    key={bucket.startedAt.toString()}
                    className="gap-1 border-b border-border-subtle p-4 last:border-b-0"
                  >
                    <Text className="text-sm font-codework-medium text-foreground">
                      {`${bucket.avgCpuPercent.toFixed(1)}% CPU · ${formatBytes(bucket.maxRssBytes)}`}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {`${t("diagnosticsMobile.readRate")}: ${formatBytes(bucket.ioReadBytes)} · ${t("diagnosticsMobile.writeRate")}: ${formatBytes(bucket.ioWriteBytes)} · ${t("diagnosticsMobile.processes")}: ${bucket.maxProcessCount}`}
                    </Text>
                  </View>
                ))
              )}
            </>
          )}
        </SettingsSection>
        <SettingsSection title={t("diagnosticsMobile.traceDiagnostics")} card>
          {traceQuery.data === null && traceQuery.isPending ? (
            <StatusMessage text={t("diagnosticsMobile.loading")} />
          ) : traceQuery.error !== null ? (
            <StatusMessage text={t("diagnosticsMobile.loadFailed")} tone="danger" />
          ) : (
            <>
              <StatsRow
                values={[
                  [t("diagnosticsMobile.spans"), String(traceData?.recordCount ?? 0)],
                  [t("diagnosticsMobile.failures"), String(traceData?.failureCount ?? 0)],
                  [t("diagnosticsMobile.slowSpans"), String(traceData?.slowSpanCount ?? 0)],
                  [t("diagnosticsMobile.parseErrors"), String(traceData?.parseErrorCount ?? 0)],
                ]}
              />
              {traceError === null ? null : (
                <StatusMessage text={traceError.message} tone="danger" />
              )}
              {(traceData?.latestFailures ?? []).slice(0, 10).map((failure) => (
                <View
                  key={`${failure.traceId}:${failure.spanId}`}
                  className="gap-1 border-b border-border-subtle p-4 last:border-b-0"
                >
                  <Text className="text-sm font-codework-medium text-foreground" numberOfLines={2}>
                    {failure.name}
                  </Text>
                  <Text className="text-xs text-danger-foreground" numberOfLines={3}>
                    {failure.cause}
                  </Text>
                </View>
              ))}
            </>
          )}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function ProcessCard(props: {
  readonly process: ServerProcessDiagnosticsEntry;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSignal: (signal: ServerProcessSignal) => void;
}) {
  return (
    <View className="gap-2 border-b border-border-subtle p-4 last:border-b-0">
      <Text className="text-sm font-codework-medium text-foreground" numberOfLines={3}>
        {props.process.command}
      </Text>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {t("diagnosticsMobile.processMeta", {
          pid: props.process.pid,
          status: props.process.status,
          elapsed: props.process.elapsed,
        })}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label={
            props.pending ? t("diagnosticsMobile.signaling") : t("diagnosticsMobile.interrupt")
          }
          disabled={props.disabled}
          onPress={() => props.onSignal("SIGINT")}
        />
        <ActionButton
          label={t("diagnosticsMobile.kill")}
          disabled={props.disabled}
          danger
          onPress={() => props.onSignal("SIGKILL")}
        />
      </View>
    </View>
  );
}

function TelemetrySnapshotCard(props: {
  readonly snapshot: ResourceTelemetrySnapshot;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const nativeStatus = props.snapshot.health.native.status;
  const speedLimit = Option.getOrNull(props.snapshot.speedLimitPercent);
  const canRetry = nativeStatus !== "healthy" && nativeStatus !== "starting";
  return (
    <>
      <StatsRow
        values={[
          [
            t("diagnosticsMobile.cpu"),
            `${props.snapshot.groups.allCodework.currentCpuPercent.toFixed(1)}%`,
          ],
          [
            t("diagnosticsMobile.memory"),
            formatBytes(props.snapshot.groups.allCodework.currentRssBytes),
          ],
          [
            t("diagnosticsMobile.processes"),
            String(props.snapshot.groups.allCodework.processCount),
          ],
          [
            t("diagnosticsMobile.readRate"),
            formatRate(props.snapshot.groups.allCodework.ioReadBytesPerSecond),
          ],
          [
            t("diagnosticsMobile.writeRate"),
            formatRate(props.snapshot.groups.allCodework.ioWriteBytesPerSecond),
          ],
          [
            t("diagnosticsMobile.speedLimit"),
            speedLimit === null ? t("diagnosticsMobile.unknown") : `${speedLimit.toFixed(0)}%`,
          ],
        ]}
      />
      <View className="gap-1 p-4">
        <Text className="text-sm text-foreground-muted">
          {`${t("diagnosticsMobile.power")}: ${powerStateLabel(props.snapshot.power.onBattery)}`}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {`${t("diagnosticsMobile.thermal")}: ${props.snapshot.power.thermalState}`}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {`${t("diagnosticsMobile.collectionHealth")}: ${telemetrySourceStatusLabel(nativeStatus)}`}
        </Text>
        {Option.getOrNull(props.snapshot.health.sidecarVersion) ? (
          <Text className="text-sm text-foreground-muted">
            {`${t("diagnosticsMobile.sidecar")}: ${Option.getOrNull(props.snapshot.health.sidecarVersion)}`}
          </Text>
        ) : null}
        {canRetry ? (
          <View className="pt-2">
            <ActionButton
              label={
                props.retrying
                  ? t("diagnosticsMobile.retrying")
                  : t("diagnosticsMobile.retryMonitor")
              }
              disabled={props.retrying}
              onPress={props.onRetry}
            />
          </View>
        ) : null}
      </View>
    </>
  );
}

function StatsRow(props: { readonly values: ReadonlyArray<readonly [string, string]> }) {
  return (
    <View className="flex-row flex-wrap border-b border-border-subtle">
      {props.values.map(([label, value]) => (
        <View key={label} className="w-1/2 gap-1 p-4">
          <Text className="text-xs text-foreground-muted">{label}</Text>
          <Text className="text-base font-codework-medium text-foreground" numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.danger
          ? "self-start rounded-full bg-danger px-3 py-2 opacity-100 disabled:opacity-40"
          : "self-start rounded-full bg-subtle-strong px-3 py-2 opacity-100 disabled:opacity-40"
      }
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function StatusMessage(props: { readonly text: string; readonly tone?: "danger" }) {
  return (
    <View className="rounded-[20px] bg-card px-4 py-4">
      <Text
        className={
          props.tone === "danger"
            ? "text-sm text-danger-foreground"
            : "text-sm text-foreground-muted"
        }
      >
        {props.text}
      </Text>
    </View>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatCpuTime(value: number): string {
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function formatDuration(value: number): string {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatRate(value: number): string {
  return `${formatBytes(Math.max(0, value))}/s`;
}

function powerStateLabel(state: "true" | "false" | "unknown"): string {
  switch (state) {
    case "true":
      return t("diagnosticsMobile.battery");
    case "false":
      return t("diagnosticsMobile.externalPower");
    default:
      return t("diagnosticsMobile.unknown");
  }
}

function telemetrySourceStatusLabel(status: ResourceTelemetrySourceStatus): string {
  switch (status) {
    case "healthy":
      return t("diagnosticsMobile.healthy");
    case "starting":
      return t("diagnosticsMobile.starting");
    case "degraded":
      return t("diagnosticsMobile.degraded");
    case "unavailable":
      return t("diagnosticsMobile.unavailable");
    case "stopped":
      return t("diagnosticsMobile.stopped");
  }
}
