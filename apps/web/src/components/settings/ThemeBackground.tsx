import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { PauseIcon, PlayIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { create } from "zustand";
import {
  getThemeDecoration,
  getEmptyThemeDecoration,
  subscribeToThemeDecoration,
  THEME_REGIONS,
  type ThemeMedia,
  type ThemeRegion,
  type ThemeSurface,
} from "../../themeDecoration";
import { readThemeAsset } from "../../themeMedia";
import { Button } from "../ui/button";
import { t } from "~/i18n";
import "./themeDecoration.css";

export function useThemeDecoration() {
  return useSyncExternalStore(
    subscribeToThemeDecoration,
    getThemeDecoration,
    getEmptyThemeDecoration,
  );
}

const usePlayback = create<{
  source: string;
  paused: boolean;
  muted: boolean;
  volume: number;
  error: string | null;
  reduced: boolean;
  motionAllowed: boolean;
}>(() => ({
  source: "",
  paused: false,
  muted: true,
  volume: 0.3,
  error: null,
  reduced: false,
  motionAllowed: false,
}));
let backgroundVideo: HTMLVideoElement | null = null;

const REGION_COLORS: Record<ThemeRegion, string> = {
  global: "var(--background)",
  sidebar: "var(--sidebar)",
  content: "var(--background)",
  userMessage: "var(--app-theme-message-surface,var(--secondary))",
  assistantMessage: "var(--background)",
  composer: "var(--card)",
  overlay: "var(--popover)",
  code: "var(--app-theme-code-background,var(--muted))",
};

export function themeSurfaceVariables(
  region: ThemeRegion,
  surface: ThemeSurface,
  global?: ThemeSurface,
): Record<string, string> {
  const prefix = `--theme-${region}-`;
  const base = surface.color ?? REGION_COLORS[region];
  const opacity = surface.opacity ?? global?.opacity;
  const opacityValue = opacity === undefined ? "var(--glass-opacity)" : `${opacity}%`;
  const fill = `color-mix(in srgb, ${base} ${opacityValue}, transparent)`;
  return {
    [prefix + "background"]: surface.gradient
      ? `linear-gradient(135deg, ${fill}, color-mix(in srgb, ${surface.gradient} ${opacityValue}, transparent))`
      : fill,
    [prefix + "blur"]: `${surface.blur ?? global?.blur ?? 0}px`,
    [prefix + "radius"]: `${surface.radius ?? global?.radius ?? 12}px`,
    [prefix + "border"]: surface.border ?? global?.border ?? "var(--border)",
    [prefix + "shadow"]: {
      none: "none",
      soft: "0 2px 8px #0000000d",
      medium: "0 6px 20px #0000001a",
    }[surface.shadow ?? global?.shadow ?? "none"],
  };
}

/** 只在主题草稿/选择变化时更新 CSS，不订阅消息流。 */
export function ThemeDecorationSync() {
  const decoration = useThemeDecoration();
  useEffect(() => {
    const root = document.documentElement;
    const variables: string[] = [];
    root.dataset.themeRegions = Object.keys(decoration).join(" ");
    if (decoration.global) root.dataset.themeBackdrop = "true";
    if (decoration.global || decoration.sidebar) root.dataset.themeCustomSidebar = "true";
    for (const region of THEME_REGIONS) {
      if (!decoration[region] && !decoration.global) continue;
      for (const [key, value] of Object.entries(
        themeSurfaceVariables(region, decoration[region] ?? {}, decoration.global),
      )) {
        root.style.setProperty(key, value);
        variables.push(key);
      }
    }
    return () => {
      delete root.dataset.themeRegions;
      delete root.dataset.themeBackdrop;
      delete root.dataset.themeCustomSidebar;
      for (const key of variables) root.style.removeProperty(key);
    };
  }, [decoration]);
  return null;
}

function useMediaSource(media?: ThemeMedia) {
  const [result, setResult] = useState<{ key: string; url?: string; error?: string } | null>(null);
  const key = media ? `${media.source}:${media.value}` : "";
  useEffect(() => {
    if (!media) return;
    let disposed = false;
    let objectUrl: string | undefined;
    if (media.source === "url") {
      setResult({ key, url: media.value });
      return;
    }
    void readThemeAsset(media.value).then(
      (asset) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(asset.blob);
        setResult({ key, url: objectUrl });
      },
      () => {
        if (!disposed) setResult({ key, error: t("themeMedia.missing") });
      },
    );
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, media?.source, media?.value]);
  return result?.key === key ? result : null;
}

export function ThemeBackdrop({ region }: { region: "global" | "sidebar" | "content" }) {
  const decoration = useThemeDecoration();
  const surface = decoration[region];
  const source = useMediaSource(surface?.media);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!surface) return null;
  const mediaStyle: CSSProperties = {
    objectFit: surface.fit ?? "cover",
    objectPosition: `${surface.x ?? 50}% ${surface.y ?? 50}%`,
    filter: `blur(${surface.blur ?? 0}px)`,
  };
  const error =
    source?.error ??
    (source?.url && failedSource === source.url ? t("themeMedia.loadFailed") : null);
  return (
    <div className={`theme-backdrop theme-backdrop-${region}`} data-theme-media-region={region}>
      <div
        className="absolute inset-0"
        style={{
          background: surface.gradient
            ? `linear-gradient(135deg, ${surface.color ?? REGION_COLORS[region]}, ${surface.gradient})`
            : (surface.color ?? REGION_COLORS[region]),
          opacity: surface.media ? 1 : (surface.opacity ?? 100) / 100,
        }}
      />
      {source?.url && !error ? (
        surface.media?.kind === "video" ? (
          <BackgroundVideo key={source.url} src={source.url} style={mediaStyle} />
        ) : (
          <img
            alt=""
            aria-hidden
            draggable={false}
            decoding="async"
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full"
            style={mediaStyle}
            src={source.url}
            onError={() => setFailedSource(source.url!)}
          />
        )
      ) : null}
      {surface.media ? (
        <div
          className="absolute inset-0 bg-background"
          style={{ opacity: (surface.dim ?? 45) / 100 }}
        />
      ) : null}
      {error ? (
        <p role="status" className="theme-media-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BackgroundVideo({ src, style }: { src: string; style: CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { source, paused, muted, volume, motionAllowed } = usePlayback();
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const video = ref.current;
    backgroundVideo = video;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    usePlayback.setState({
      source: src,
      muted: true,
      paused: query.matches,
      error: null,
      reduced: query.matches,
      motionAllowed: false,
    });
    const visibility = () => {
      setHidden(document.hidden);
      if (document.hidden) video?.pause();
    };
    const motion = () => {
      setReduced(query.matches);
      usePlayback.setState({
        reduced: query.matches,
        motionAllowed: false,
        ...(query.matches ? { paused: true } : {}),
      });
    };
    document.addEventListener("visibilitychange", visibility);
    query.addEventListener("change", motion);
    return () => {
      video?.pause();
      if (backgroundVideo === video) backgroundVideo = null;
      document.removeEventListener("visibilitychange", visibility);
      query.removeEventListener("change", motion);
    };
  }, [src]);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // 新视频不能在首次 effect 中继承上一段视频的出声状态。
    if (source !== src) {
      video.muted = true;
      video.pause();
      return;
    }
    video.muted = muted;
    video.volume = volume;
    let disposed = false;
    if (paused || hidden || (reduced && !motionAllowed)) video.pause();
    else
      void video.play().catch(() => {
        if (!disposed && !document.hidden)
          usePlayback.setState({ paused: true, error: t("themeMedia.playBlocked") });
      });
    return () => {
      disposed = true;
    };
  }, [src, source, paused, hidden, reduced, motionAllowed, muted, volume]);
  return (
    <video
      ref={ref}
      src={src}
      style={style}
      className="absolute inset-0 size-full"
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden
      onError={() =>
        usePlayback.setState({ paused: true, error: t("themeMedia.unsupportedVideo") })
      }
    />
  );
}

export function ThemeVideoControls() {
  const decoration = useThemeDecoration();
  const state = usePlayback();
  if (decoration.global?.media?.kind !== "video") return null;
  const togglePlay = () => {
    const paused = !state.paused;
    if (paused) backgroundVideo?.pause();
    else if (backgroundVideo)
      void backgroundVideo
        .play()
        .catch(() => usePlayback.setState({ paused: true, error: t("themeMedia.playBlocked") }));
    usePlayback.setState({ paused, motionAllowed: !paused, error: null });
  };
  const toggleSound = () => {
    const muted = !state.muted;
    if (backgroundVideo) backgroundVideo.muted = muted;
    usePlayback.setState({ muted });
  };
  return (
    <div
      className="theme-video-controls space-y-1 rounded-lg border bg-background/95 p-2 text-foreground"
      aria-label={t("themeMedia.videoControls")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t(state.paused ? "themeMedia.play" : "themeMedia.pause")}
          onClick={togglePlay}
        >
          {state.paused ? <PlayIcon /> : <PauseIcon />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t(state.muted ? "themeMedia.unmute" : "themeMedia.mute")}
          aria-pressed={!state.muted}
          onClick={toggleSound}
        >
          {state.muted ? <VolumeXIcon /> : <Volume2Icon />}
        </Button>
        <span className="shrink-0 text-xs">
          {t(state.muted ? "themeMedia.muted" : "themeMedia.soundOn")}
        </span>
        <input
          type="range"
          aria-label={t("themeMedia.volume")}
          min={0}
          max={100}
          value={Math.round(state.volume * 100)}
          className="min-w-10 w-full accent-primary"
          onChange={(event) => {
            const volume = Number(event.currentTarget.value) / 100;
            if (backgroundVideo) backgroundVideo.volume = volume;
            usePlayback.setState({ volume });
          }}
        />
      </div>
      {state.error ? (
        <p role="status" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.reduced && !state.motionAllowed ? (
        <p className="text-xs text-muted-foreground">{t("themeMedia.reduceHint")}</p>
      ) : null}
    </div>
  );
}
