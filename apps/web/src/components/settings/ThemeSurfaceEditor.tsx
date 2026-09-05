import { useEffect, useRef, useState } from "react";
import { ImageIcon, RotateCcwIcon, UploadIcon } from "lucide-react";
import {
  THEME_REGIONS,
  normalizeThemeImageUrl,
  type ThemeDecoration,
  type ThemeMedia,
  type ThemeRegion,
  type ThemeSurface,
} from "../../themeDecoration";
import {
  backgroundFileKind,
  prepareThemeAsset,
  removeThemeAsset,
  THEME_MEDIA_ACCEPT,
  writeThemeAsset,
} from "../../themeMedia";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ThemeVideoControls } from "./ThemeBackground";
import { ThemeColorPicker } from "./ThemeColorPicker";
import { t } from "~/i18n";
import { useClientSettings } from "../../hooks/useSettings";
import { themeSurfaceContrastRatio } from "../../themePalette";

export function ThemeSurfaceEditor({
  value,
  onChange,
  onBusyChange,
  onAssetCreated,
}: {
  value: ThemeDecoration;
  onChange: (update: (current: ThemeDecoration) => ThemeDecoration) => void;
  onBusyChange: (busy: boolean) => void;
  onAssetCreated: (id: string) => void;
}) {
  const [region, setRegion] = useState<ThemeRegion>("global");
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const surface = value[region];
  const colorProbe = useRef<HTMLSpanElement>(null);
  const [contrast, setContrast] = useState<number | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const refreshContrast = () => {
      const probe = colorProbe.current;
      if (!probe) return;
      // 让浏览器先解析 color-mix/var，颜色库只处理最终计算值。
      const resolveColor = (color: string) => {
        probe.style.color = color;
        return getComputedStyle(probe).color;
      };
      const style = getComputedStyle(root);
      const foreground = style
        .getPropertyValue(
          region === "userMessage"
            ? "--contrast-message-foreground"
            : region === "sidebar"
              ? "--sidebar-foreground"
              : region === "code"
                ? "--code-foreground"
                : region === "overlay"
                  ? "--popover-foreground"
                  : "--foreground",
        )
        .trim();
      const base = style.getPropertyValue("--background").trim();
      const regionBackground = style
        .getPropertyValue(
          region === "userMessage"
            ? "--message-surface"
            : region === "sidebar"
              ? "--sidebar"
              : region === "overlay"
                ? "--popover"
                : region === "code"
                  ? "--code-background"
                  : "--background",
        )
        .trim();
      setContrast(
        surface?.color || surface?.gradient
          ? themeSurfaceContrastRatio(
              resolveColor(foreground),
              surface.color ?? resolveColor(regionBackground),
              resolveColor(base),
              surface.opacity ?? value.global?.opacity ?? glassOpacity,
              surface.gradient,
            )
          : null,
      );
    };
    refreshContrast();
    // 主题预览只改变根节点变量，监听该节点即可，无需观察整个页面。
    const observer = new MutationObserver(refreshContrast);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => observer.disconnect();
  }, [surface, region, value.global?.opacity, glassOpacity]);
  const canUseMedia = region === "global" || region === "sidebar" || region === "content";
  const patch = (change: Partial<ThemeSurface>) =>
    onChange((current) => ({ ...current, [region]: { ...current[region], ...change } }));
  const reset = () =>
    onChange((current) => {
      const next = { ...current };
      delete next[region];
      return next;
    });
  const setMedia = (media: ThemeMedia) => patch({ media, dim: surface?.dim ?? 45 });
  const upload = async (file: File) => {
    const id = ++request.current;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      if (backgroundFileKind(file) === "video" && region !== "global")
        throw new Error(t("themeMedia.videoGlobalOnly"));
      const asset = await prepareThemeAsset(file);
      if (request.current !== id) return;
      const media = await writeThemeAsset(asset);
      if (request.current !== id) {
        await removeThemeAsset(media.value);
        return;
      }
      onAssetCreated(media.value);
      setMedia(media);
    } catch (cause) {
      if (request.current === id)
        setError(cause instanceof Error ? cause.message : t("themeMedia.storageFailed"));
    } finally {
      onBusyChange(false);
      if (request.current === id) setBusy(false);
    }
  };
  const field = (
    key: "opacity" | "blur" | "radius" | "x" | "y" | "dim",
    max: number,
    fallback: number,
    unit = "%",
  ) => (
    <label className="grid grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-3 gap-y-1 text-xs">
      <span>{t(`themeMedia.${key}`)}</span>
      <output className="text-right tabular-nums text-muted-foreground">
        {surface?.[key] ?? fallback}
        {unit}
      </output>
      <input
        aria-label={t(`themeMedia.${key}`)}
        className="col-span-2 w-full accent-primary"
        type="range"
        min={0}
        max={max}
        value={surface?.[key] ?? fallback}
        onChange={(event) => patch({ [key]: Number(event.currentTarget.value) })}
      />
    </label>
  );
  const colorField = (key: "color" | "gradient" | "border") => (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span>{t(`themeMedia.${key}`)}</span>
      <div className="flex items-center gap-1">
        <ThemeColorPicker
          label={t(`themeMedia.${key}`)}
          value={surface?.[key] ?? "#ffffff"}
          onChange={(color) => patch({ [key]: color.slice(0, 7) })}
        />
        {surface?.[key] ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("themeMedia.resetField", { field: t(`themeMedia.${key}`) })}
            onClick={() => {
              onChange((current) => {
                const next = { ...current[region] };
                delete next[key];
                return { ...current, [region]: next };
              });
            }}
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
  return (
    <section className="space-y-3 rounded-xl border p-3" aria-label={t("themeMedia.title")}>
      <span ref={colorProbe} hidden aria-hidden="true" />
      <div>
        <h3 className="text-sm font-medium">{t("themeMedia.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("themeMedia.previewHint")}</p>
      </div>
      <fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-60">
        <label className="grid gap-1 text-xs">
          {t("themeMedia.region")}
          <select
            value={region}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm"
            onChange={(event) => {
              setRegion(event.currentTarget.value as ThemeRegion);
              setUrl("");
              setError(null);
            }}
          >
            {THEME_REGIONS.map((item) => (
              <option key={item} value={item}>
                {t(`themeMedia.region.${item}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t(surface ? "themeMedia.customized" : "themeMedia.inherited")}
          </span>
          <Button size="xs" variant="outline" disabled={!surface} onClick={reset}>
            <RotateCcwIcon />
            {t("themeMedia.resetRegion")}
          </Button>
        </div>
        {canUseMedia ? (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-2.5">
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={() => input.current?.click()}>
                <UploadIcon />
                {t(region === "global" ? "themeMedia.upload" : "themeMedia.uploadImage")}
              </Button>
              {surface?.media ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    onChange((current) => {
                      const next = { ...current[region] };
                      delete next.media;
                      return { ...current, [region]: next };
                    })
                  }
                >
                  {t("themeMedia.remove")}
                </Button>
              ) : null}
            </div>
            <input
              ref={input}
              type="file"
              accept={region === "global" ? THEME_MEDIA_ACCEPT : "image/*,.heic,.heif,.tif,.tiff"}
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void upload(file);
              }}
            />
            <p className="break-all text-xs text-muted-foreground">
              {surface?.media?.name ??
                (surface?.media?.source === "url" ? surface.media.value : t("themeMedia.noMedia"))}
            </p>
            <div className="flex min-w-0 gap-1.5">
              <Input
                aria-label={t("themeMedia.url")}
                placeholder="https://…"
                className="min-w-0 flex-1"
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
              />
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!url.trim()}
                aria-label={t("themeMedia.useUrl")}
                onClick={() => {
                  try {
                    setMedia({ kind: "image", source: "url", value: normalizeThemeImageUrl(url) });
                    setError(null);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : t("themeMedia.invalidUrl"));
                  }
                }}
              >
                <ImageIcon />
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("themeMedia.urlWarning")}
            </p>
            {region === "global" ? (
              <p className="text-[11px] leading-relaxed text-warning-foreground">
                {t("themeMedia.videoBrief")}
              </p>
            ) : null}
            <details className="text-[11px] leading-relaxed text-muted-foreground">
              <summary className="cursor-pointer">{t("themeMedia.formatDetails")}</summary>
              <p>{t("themeMedia.formats")}</p>
              {region === "global" ? <p>{t("themeMedia.videoWarning")}</p> : null}
            </details>
          </div>
        ) : null}
        {surface?.media ? (
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-2 text-xs">
              {t("themeMedia.fit")}
              <select
                className="rounded border bg-background p-1"
                value={surface.fit ?? "cover"}
                onChange={(event) =>
                  patch({ fit: event.currentTarget.value as "cover" | "contain" })
                }
              >
                <option value="cover">{t("themeMedia.cover")}</option>
                <option value="contain">{t("themeMedia.contain")}</option>
              </select>
            </label>
            {field("x", 100, 50)}
            {field("y", 100, 50)}
            {field("dim", 100, 45)}
          </div>
        ) : null}
        {colorField("color")}
        {colorField("gradient")}
        {field("opacity", 100, value.global?.opacity ?? glassOpacity)}
        {field("blur", 20, value.global?.blur ?? 0, "px")}
        {contrast !== null && contrast < 4.5 ? (
          <div className="space-y-2">
            <p role="status" className="text-xs text-warning-foreground">
              {t("themeMedia.lowContrast", { ratio: contrast.toFixed(2) })}
            </p>
            <Button size="xs" variant="outline" onClick={reset}>
              {t("themeMedia.resetRegion")}
            </Button>
          </div>
        ) : null}
        {(surface?.opacity ?? 80) < 65 || (surface?.media && (surface.dim ?? 45) < 25) ? (
          <p role="status" className="text-xs text-warning-foreground">
            {t("themeMedia.readability")}
          </p>
        ) : null}
        <details className="space-y-3 text-xs">
          <summary className="cursor-pointer select-none">{t("themeMedia.more")}</summary>
          {field("radius", 32, value.global?.radius ?? 12, "px")}
          {colorField("border")}
          <label className="flex items-center justify-between gap-2">
            {t("themeMedia.shadow")}
            <select
              className="rounded border bg-background p-1"
              value={surface?.shadow ?? "none"}
              onChange={(event) =>
                patch({ shadow: event.currentTarget.value as "none" | "soft" | "medium" })
              }
            >
              {["none", "soft", "medium"].map((item) => (
                <option key={item} value={item}>
                  {t(`themeMedia.shadow.${item}`)}
                </option>
              ))}
            </select>
          </label>
        </details>
      </fieldset>
      {busy ? (
        <p role="status" className="text-xs">
          {t("themeMedia.preparing")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ThemeVideoControls />
    </section>
  );
}
