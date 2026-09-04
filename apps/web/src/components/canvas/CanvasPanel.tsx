import type { EnvironmentId } from "@codework/contracts";
import { FileCode2, LayoutDashboard, LoaderCircle, Plus, RefreshCw, Table2 } from "lucide-react";
import type { ReactNode } from "react";

import { parseCanvasDocument } from "~/canvas";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";

type CanvasSurface = Extract<RightPanelSurface, { kind: "canvas" }>;

interface CanvasPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  surface: CanvasSurface;
  recentCanvases: ReadonlyArray<CanvasSurface>;
  canCreateCanvas: boolean;
  onCreateCanvas: () => void;
  onSelectCanvas: (canvasId: string) => void;
  onOpenFile: (relativePath: string, line?: number) => void;
}

export function CanvasPanel(props: CanvasPanelProps) {
  // 引导态和生成态都没有文件路径，避免在同一个挂载点里提前调用文件查询。
  if (props.surface.pending) {
    return <CanvasGenerating {...props} />;
  }
  if (props.surface.empty) {
    return <CanvasEmpty {...props} />;
  }
  return <CanvasDocumentPanel {...props} />;
}

function CanvasEmpty({
  surface,
  recentCanvases,
  canCreateCanvas,
  onCreateCanvas,
  onSelectCanvas,
}: Pick<
  CanvasPanelProps,
  "surface" | "recentCanvases" | "canCreateCanvas" | "onCreateCanvas" | "onSelectCanvas"
>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-canvas-empty="true" data-canvas-panel="true">
      <CanvasToolbar title={t("surface.canvas")} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-md flex-col items-center text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
              <LayoutDashboard className="size-5" aria-hidden="true" />
            </div>
            <h2 className="mt-4 text-base font-semibold">{t("canvas.emptyTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t("canvas.emptyDescription")}
            </p>
            <Button
              className="mt-4"
              disabled={!canCreateCanvas}
              onClick={onCreateCanvas}
              size="sm"
              variant="secondary"
            >
              {t("canvas.newCanvas")}
            </Button>
          </div>
        </div>
        <CanvasRecentSidebar
          activeCanvasId={surface.canvasId}
          canvases={recentCanvases}
          canCreateCanvas={canCreateCanvas}
          onCreateCanvas={onCreateCanvas}
          onSelectCanvas={onSelectCanvas}
        />
      </div>
    </div>
  );
}

function CanvasGenerating({
  surface,
  recentCanvases,
}: Pick<CanvasPanelProps, "surface" | "recentCanvases">) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-canvas-panel="true"
      data-canvas-generating="true"
    >
      <CanvasToolbar
        title={t("surface.canvas")}
        subtitle={surface.title}
        leading={<LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center p-6">
          <div className="w-full max-w-2xl rounded-xl border border-border/70 bg-card/30 p-6 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
            </div>
            <h2 className="mt-4 text-base font-semibold">{t("canvas.generatingTitle")}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {t("canvas.generatingHint")}
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3" aria-hidden="true">
              <div className="h-20 animate-pulse rounded-lg border border-border/70 bg-background/60" />
              <div className="h-20 animate-pulse rounded-lg border border-border/70 bg-background/60 [animation-delay:150ms]" />
              <div className="h-20 animate-pulse rounded-lg border border-border/70 bg-background/60 [animation-delay:300ms]" />
            </div>
          </div>
        </div>
        <CanvasRecentSidebar
          activeCanvasId={surface.canvasId}
          canvases={recentCanvases}
          canCreateCanvas={false}
          onCreateCanvas={() => undefined}
          onSelectCanvas={() => undefined}
        />
      </div>
    </div>
  );
}

function CanvasDocumentPanel({
  environmentId,
  cwd,
  surface,
  recentCanvases,
  canCreateCanvas,
  onCreateCanvas,
  onSelectCanvas,
  onOpenFile,
}: CanvasPanelProps) {
  const file = useProjectFileQuery(environmentId, cwd, surface.relativePath);
  const document = file.data ? parseCanvasDocument(file.data.contents) : null;
  const body =
    file.isPending && !file.data ? (
      <CanvasMessage>{t("canvas.loading")}</CanvasMessage>
    ) : file.error ? (
      <CanvasMessage>{file.error || t("canvas.failed")}</CanvasMessage>
    ) : !document ? (
      <CanvasMessage>{t("canvas.invalid")}</CanvasMessage>
    ) : (
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
          <div className="space-y-3 border-b border-border/60 pb-5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("canvas.agentGenerated")}
            </div>
            <h1 className="text-xl font-semibold tracking-tight">{document.title}</h1>
            {document.summary ? (
              <p className="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-foreground/75">
                {document.summary}
              </p>
            ) : null}
          </div>
          {document.blocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("canvas.noContent")}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {document.blocks.map((block, index) => {
                switch (block.type) {
                  case "stat":
                    return (
                      <div
                        key={`stat-${index}`}
                        className="rounded-xl border border-border/70 bg-card px-4 py-3"
                      >
                        <div className="text-[11px] text-muted-foreground">{block.label}</div>
                        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                          {block.value}
                        </div>
                      </div>
                    );
                  case "section":
                    return (
                      <section
                        key={`section-${index}`}
                        className="space-y-1.5 rounded-xl border border-border/70 bg-card/50 p-4 sm:col-span-2"
                      >
                        <h2 className="text-sm font-medium">{block.heading}</h2>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
                          {block.body}
                        </p>
                      </section>
                    );
                  case "file":
                    return (
                      <div
                        key={`file-${index}`}
                        className="flex items-start gap-2 rounded-xl border border-border/70 bg-card/50 p-4 sm:col-span-2"
                      >
                        <FileCode2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            className="max-w-full truncate text-left text-sm font-medium text-info-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                            onClick={() => onOpenFile(block.path, block.line)}
                          >
                            {block.path}
                            {block.line ? `:${block.line}` : ""}
                          </button>
                          {block.note ? (
                            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                              {block.note}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );
                  case "table":
                    return (
                      <div
                        key={`table-${index}`}
                        className="overflow-x-auto rounded-xl border border-border/70 bg-card/50 sm:col-span-2"
                      >
                        <div className="flex items-center gap-1.5 border-b border-border/60 px-4 py-2.5 text-xs font-medium">
                          <Table2 className="size-3.5 text-muted-foreground" />
                          {t("surface.canvas")}
                        </div>
                        <table className="w-full min-w-max text-xs">
                          <thead>
                            <tr className="border-b border-border/50 text-left text-muted-foreground">
                              {block.columns.map((column) => (
                                <th key={column} className="px-4 py-2.5 font-medium">
                                  {column}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {block.rows.map((row, rowIndex) => (
                              <tr
                                key={rowIndex}
                                className="border-b border-border/40 last:border-0"
                              >
                                {block.columns.map((_, columnIndex) => (
                                  <td key={columnIndex} className="px-4 py-2.5 align-top">
                                    {row[columnIndex] ?? ""}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                }
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-canvas-panel="true">
      <CanvasToolbar
        title={t("surface.canvas")}
        subtitle={document?.title ?? surface.title}
        action={
          <Button
            aria-label={t("canvas.refresh")}
            className="size-7 shrink-0"
            disabled={file.isPending && !file.data}
            onClick={file.refresh}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCw className={cn("size-3.5", file.isPending && "animate-spin")} />
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        {body}
        <CanvasRecentSidebar
          activeCanvasId={surface.canvasId}
          canvases={recentCanvases}
          canCreateCanvas={canCreateCanvas}
          onCreateCanvas={onCreateCanvas}
          onSelectCanvas={onSelectCanvas}
        />
      </div>
    </div>
  );
}

function CanvasToolbar({
  title,
  subtitle,
  leading = (
    <LayoutDashboard className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  ),
  action,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 border-b border-border/60 px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent">
      {leading}
      <span className="shrink-0 text-sm font-medium">{title}</span>
      {subtitle && subtitle !== title ? (
        <>
          <span className="text-muted-foreground/60" aria-hidden="true">
            /
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{subtitle}</span>
        </>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {action}
    </div>
  );
}

function CanvasRecentSidebar({
  activeCanvasId,
  canvases,
  canCreateCanvas,
  onCreateCanvas,
  onSelectCanvas,
}: {
  activeCanvasId: string;
  canvases: ReadonlyArray<CanvasSurface>;
  canCreateCanvas: boolean;
  onCreateCanvas: () => void;
  onSelectCanvas: (canvasId: string) => void;
}) {
  return (
    <aside
      className="hidden w-48 shrink-0 flex-col border-l border-border/60 bg-muted/10 sm:flex"
      aria-label={t("canvas.recent")}
      data-canvas-recent
    >
      <div className="px-3 pb-2 pt-4 text-xs font-medium text-muted-foreground">
        {t("canvas.recent")}
      </div>
      <div className="space-y-1 px-2">
        {canvases.map((canvas) => (
          <button
            key={canvas.id}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              canvas.canvasId === activeCanvasId
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            aria-current={canvas.canvasId === activeCanvasId ? "page" : undefined}
            onClick={() => onSelectCanvas(canvas.canvasId)}
          >
            <LayoutDashboard className="size-3.5 shrink-0" aria-hidden="true" />
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate">{canvas.title}</span>} />
              <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
                {canvas.title}
              </TooltipPopup>
            </Tooltip>
          </button>
        ))}
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            canCreateCanvas ? "hover:bg-accent/60 hover:text-foreground" : "cursor-wait opacity-50",
          )}
          disabled={!canCreateCanvas}
          onClick={onCreateCanvas}
        >
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          {t("canvas.createNew")}
        </button>
      </div>
    </aside>
  );
}

function CanvasMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
