import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";
import { t } from "~/i18n";
import { APP_VERSION } from "../../branding";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  detectHostPlatform,
  fetchDesktopReleases,
  formatInstallerSize,
  invalidateDesktopReleasesCache,
  isInstallerForHost,
  type DesktopInstallerKind,
  type DesktopRelease,
  type DesktopReleaseChannel,
  type HostPlatform,
} from "./versionDownloads.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const CHANNEL_LABEL_KEY: Readonly<Record<DesktopReleaseChannel, string>> = {
  stable: "versionDownloads.stableChannel",
  battle: "versionDownloads.battleChannel",
};

const INSTALLER_LABEL_KEY: Readonly<Record<DesktopInstallerKind, string>> = {
  windows: "versionDownloads.platform.windows",
  "mac-arm64": "versionDownloads.platform.macArm64",
  "mac-x64": "versionDownloads.platform.macX64",
  linux: "versionDownloads.platform.linux",
};

const RELEASE_CHANNELS: ReadonlyArray<DesktopReleaseChannel> = ["stable", "battle"];

/** 更新日志正文按最小集合渲染：标题、列表、链接与行内代码足够覆盖发布说明。 */
const RELEASE_NOTES_COMPONENTS: Components = {
  h2: (props) => <h2 className="text-[13px] font-semibold text-foreground" {...props} />,
  h3: (props) => <h3 className="text-[13px] font-semibold text-foreground" {...props} />,
  p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: (props) => <ul className="my-1.5 list-disc space-y-0.5 ps-5" {...props} />,
  ol: (props) => <ol className="my-1.5 list-decimal space-y-0.5 ps-5" {...props} />,
  li: (props) => <li className="marker:text-muted-foreground/60" {...props} />,
  a: (props) => (
    <a
      className="text-foreground underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  code: (props) => (
    <code className="rounded-sm bg-muted px-1 py-px font-mono text-[11.5px]" {...props} />
  ),
  pre: (props) => (
    <pre className="my-1.5 overflow-x-auto rounded-md bg-muted p-2 text-xs" {...props} />
  ),
};

function ReleaseNotes({ notes }: { readonly notes: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-muted-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={RELEASE_NOTES_COMPONENTS}
      >
        {notes}
      </ReactMarkdown>
    </div>
  );
}

function formatReleaseDate(iso: string): string {
  if (iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function ReleaseCard({
  release,
  hostPlatform,
  hostArch,
}: {
  readonly release: DesktopRelease;
  readonly hostPlatform: HostPlatform | null;
  readonly hostArch: string | null;
}) {
  const isCurrentInstall = APP_VERSION !== "0.0.0" && APP_VERSION === release.version;
  const publishedLabel = formatReleaseDate(release.publishedAt);

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 px-3 py-3.5 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold tracking-[-0.005em] text-foreground">
          v{release.version}
        </h3>
        <Badge variant={release.channel === "battle" ? "warning" : "success"}>
          {t(CHANNEL_LABEL_KEY[release.channel])}
        </Badge>
        {isCurrentInstall ? (
          <Badge variant="outline">{t("versionDownloads.currentInstall")}</Badge>
        ) : null}
        {publishedLabel === "" ? null : (
          <span className="text-xs text-muted-foreground">{publishedLabel}</span>
        )}
        {release.releaseUrl === "" ? null : (
          <a
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href={release.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("versionDownloads.viewOnGithub")}
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
      {release.notes === "" ? null : <ReleaseNotes notes={release.notes} />}
      <div className="flex flex-wrap items-center gap-2">
        {release.installers.map((installer) => {
          const preferred = isInstallerForHost(installer, hostPlatform, hostArch);
          const sizeLabel = formatInstallerSize(installer.sizeBytes);
          return (
            <Button
              key={installer.url}
              size="xs"
              variant={preferred ? "default" : "outline"}
              render={<a href={installer.url} />}
            >
              <DownloadIcon className="size-3.5" />
              {t(INSTALLER_LABEL_KEY[installer.kind])}
              {sizeLabel === "" ? null : (
                <span className={cn("text-[10px]", preferred ? "opacity-80" : "opacity-60")}>
                  {sizeLabel}
                </span>
              )}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

type ReleasesLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly releases: ReadonlyArray<DesktopRelease> }
  | { readonly status: "error"; readonly message: string };

export function VersionDownloadsPanel() {
  const [loadState, setLoadState] = useState<ReleasesLoadState>({ status: "loading" });
  const [channel, setChannel] = useState<DesktopReleaseChannel>("stable");
  const [reloadKey, setReloadKey] = useState(0);

  const updateState = useDesktopUpdateState();
  const hostArch = updateState?.hostArch ?? null;
  const hostPlatform = useMemo(
    () =>
      typeof navigator === "undefined"
        ? null
        : detectHostPlatform({ platform: navigator.platform, userAgent: navigator.userAgent }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadState((current) => (current.status === "ready" ? current : { status: "loading" }));
    fetchDesktopReleases().then(
      (releases) => {
        if (!cancelled) setLoadState({ status: "ready", releases });
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const handleRefresh = useCallback(() => {
    invalidateDesktopReleasesCache();
    setLoadState({ status: "loading" });
    setReloadKey((key) => key + 1);
  }, []);

  const channelReleases = useMemo(
    () =>
      loadState.status === "ready"
        ? loadState.releases.filter((release) => release.channel === channel)
        : [],
    [loadState, channel],
  );

  const currentInstallLabel = useMemo(() => {
    if (APP_VERSION === "0.0.0") return null;
    const installChannel: DesktopReleaseChannel = APP_VERSION.endsWith("-battle")
      ? "battle"
      : "stable";
    return t("versionDownloads.currentInstallLine", {
      version: APP_VERSION,
      channel: t(CHANNEL_LABEL_KEY[installChannel]),
    });
  }, []);

  const isLoading = loadState.status === "loading";

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("downloads").id}
        title={t("settings.downloads")}
        headerAction={
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {RELEASE_CHANNELS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => {
                    setChannel(candidate);
                  }}
                  className={cn(
                    "h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium transition-colors",
                    channel === candidate
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(CHANNEL_LABEL_KEY[candidate])}
                </button>
              ))}
            </div>
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={t("versionDownloads.refresh")}
              disabled={isLoading}
              onClick={handleRefresh}
            >
              <RefreshCwIcon className={cn("size-3.5", isLoading && "animate-spin")} />
            </Button>
          </div>
        }
      >
        <SettingsRow
          title={t("versionDownloads.overviewTitle")}
          description={t("versionDownloads.description")}
          status={currentInstallLabel}
        />
        {loadState.status === "loading" ? (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                {t("versionDownloads.loading")}
              </span>
            }
          />
        ) : loadState.status === "error" ? (
          <SettingsRow
            title={t("versionDownloads.loadFailed")}
            description={loadState.message}
            control={
              <Button size="xs" variant="outline" onClick={handleRefresh}>
                {t("versionDownloads.retry")}
              </Button>
            }
          />
        ) : channelReleases.length === 0 ? (
          <SettingsRow
            title={t("versionDownloads.noReleases")}
            description={t("versionDownloads.noReleasesDescription")}
          />
        ) : (
          <div className="space-y-3">
            {channelReleases.map((release) => (
              <ReleaseCard
                key={release.version}
                release={release}
                hostPlatform={hostPlatform}
                hostArch={hostArch}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
