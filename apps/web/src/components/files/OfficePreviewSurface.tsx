import type { EnvironmentId, ScopedThreadRef } from "@codework/contracts";
import { LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { t } from "~/i18n";
import { Button } from "~/components/ui/button";

import {
  MAX_OFFICE_PREVIEW_BYTES,
  parseOfficePreview,
  type OfficePreviewSection,
} from "./officePreview";

const REFRESH_INTERVAL_MS = 8_000;

async function readResponse(response: Response): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_OFFICE_PREVIEW_BYTES) {
    throw new Error(t("officePreview.tooLarge"));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t("officePreview.unavailable"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OFFICE_PREVIEW_BYTES) throw new Error(t("officePreview.tooLarge"));
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function OfficePreviewSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly relativePath: string;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [sections, setSections] = useState<ReadonlyArray<OfficePreviewSection> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const url = asset._tag === "Success" ? asset.url : null;

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let running = false;
    let etag: string | null = null;
    let hasLoaded = sections !== null;
    const check = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const head = await fetch(url, {
          method: "HEAD",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!head.ok) throw new Error(t("officePreview.unavailable"));
        const currentTag = head.headers.get("etag");
        if (hasLoaded && currentTag && currentTag === etag) return;
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(t("officePreview.unavailable"));
        const bytes = await readResponse(response);
        const parsed = await parseOfficePreview(props.relativePath, bytes);
        if (!controller.signal.aborted) {
          etag = currentTag;
          hasLoaded = true;
          setSections(parsed);
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error &&
              (cause.message.includes("preview limit") ||
                cause.message === t("officePreview.tooLarge"))
              ? t("officePreview.tooLarge")
              : t("officePreview.unavailable"),
          );
        }
      } finally {
        running = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [url, props.relativePath, revision]);

  if (asset._tag === "Loading" && sections === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  if (asset._tag === "Failure" || (sections === null && error !== null)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-destructive">
        <span>{error ?? t("officePreview.unavailable")}</span>
        <Button size="sm" variant="outline" onClick={refresh}>
          {t("officePreview.retry")}
        </Button>
      </div>
    );
  }
  if (sections === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 text-sm" data-office-preview>
      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t("officePreview.readOnly")}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("officePreview.refresh")}
          onClick={refresh}
        >
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
      {sections.map((section) => (
        <section key={section.title} className="mb-6">
          <h3 className="mb-2 border-b border-border/60 pb-1 font-medium">{section.title}</h3>
          {section.table && section.table.columns.length > 0 ? (
            <div className="overflow-auto rounded-md border border-border/60">
              <table className="w-max min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="border-b border-r border-border/60 px-2 py-1.5">#</th>
                    {section.table.columns.map((column) => (
                      <th key={column} className="border-b border-r border-border/60 px-2 py-1.5">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.table.rows.map((row) => (
                    <tr key={row.index}>
                      <th className="border-b border-r border-border/60 bg-muted/40 px-2 py-1 font-normal tabular-nums">
                        {row.index}
                      </th>
                      {row.values.map((value, index) => (
                        <td
                          key={section.table?.columns[index]}
                          className="max-w-72 min-w-20 border-b border-r border-border/40 px-2 py-1 align-top break-words whitespace-pre-wrap"
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {section.table.truncated ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("officePreview.truncated")}
                </p>
              ) : null}
            </div>
          ) : section.lines.length > 0 ? (
            <p className="break-words whitespace-pre-wrap">{section.lines.join("\n")}</p>
          ) : (
            <p className="text-muted-foreground">{t("officePreview.noText")}</p>
          )}
        </section>
      ))}
    </div>
  );
}
