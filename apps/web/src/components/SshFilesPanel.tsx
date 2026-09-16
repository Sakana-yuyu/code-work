import {
  ChevronRight,
  File as FileIcon,
  Folder,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { EnvironmentId, SshServerFileEntry, SshServerId } from "@codework/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { t } from "~/i18n";
import { sshServerEnvironment } from "../state/ssh";
import { useAtomCommand } from "../state/use-atom-command";

function formatSshFailure(failure: unknown): string {
  if (failure && typeof failure === "object" && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(failure);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModifiedAt(value: string | undefined): string {
  if (value === undefined) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString();
}

/** 目录条目的 path 带尾斜杠（契约约定），点击导航直接可用。 */
const parentPath = (path: string): string | null => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return null;
  return index === 0 ? "/" : trimmed.slice(0, index);
};

interface OpenFileState {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface SshFilesPanelProps {
  environmentId: EnvironmentId;
  serverId: string;
  serverLabel: string;
}

export function SshFilesPanel(props: SshFilesPanelProps) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<readonly SshServerFileEntry[] | null>(null);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null);
  const [draft, setDraft] = useState("");
  const [newFileName, setNewFileName] = useState<string | null>(null);

  const runListFiles = useAtomCommand(sshServerEnvironment.listFiles, { reportFailure: false });
  const runReadFile = useAtomCommand(sshServerEnvironment.readFile, { reportFailure: false });
  const runWriteFile = useAtomCommand(sshServerEnvironment.writeFile, { reportFailure: false });
  const runDeleteFile = useAtomCommand(sshServerEnvironment.deleteFile, {
    reportFailure: false,
  });

  const list = useMemo(
    () =>
      async (targetPath: string): Promise<void> => {
        setListing(true);
        setError(null);
        const result = await runListFiles({
          environmentId: props.environmentId,
          input: { serverId: props.serverId as SshServerId, path: targetPath },
        });
        if (AsyncResult.isSuccess(result)) {
          setPath(result.value.path);
          setEntries(result.value.entries);
        } else {
          setError(formatSshFailure(Cause.squash(result.cause)));
        }
        setListing(false);
      },
    [props.environmentId, props.serverId, runListFiles],
  );
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    // 挂载时列一次根目录；后续导航都由用户交互驱动。
    void listRef.current("/");
  }, []);

  const openFileForEdit = async (target: SshServerFileEntry) => {
    if (target.isDirectory) {
      void list(target.path);
      return;
    }
    setError(null);
    const result = await runReadFile({
      environmentId: props.environmentId,
      input: { serverId: props.serverId as SshServerId, path: target.path },
    });
    if (AsyncResult.isSuccess(result)) {
      setOpenFile({
        path: result.value.path,
        content: result.value.content,
        truncated: result.value.truncated,
      });
      setDraft(result.value.content);
    } else {
      setError(formatSshFailure(Cause.squash(result.cause)));
    }
  };

  const saveOpenFile = async () => {
    if (openFile === null) return;
    setError(null);
    const result = await runWriteFile({
      environmentId: props.environmentId,
      input: { serverId: props.serverId as SshServerId, path: openFile.path, content: draft },
    });
    if (AsyncResult.isSuccess(result)) {
      setOpenFile({ ...openFile, content: draft });
    } else {
      setError(formatSshFailure(Cause.squash(result.cause)));
    }
  };

  const deleteEntry = async (target: SshServerFileEntry) => {
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(t("ssh.deleteConfirm", { path: target.path }), {
          variant: "destructive",
        })
      : false;
    if (!confirmed) return;
    setError(null);
    const result = await runDeleteFile({
      environmentId: props.environmentId,
      input: {
        serverId: props.serverId as SshServerId,
        path: target.path,
        recursive: target.isDirectory,
      },
    });
    if (AsyncResult.isSuccess(result)) {
      if (openFile?.path === target.path.replace(/\/+$/, "")) setOpenFile(null);
      void list(path);
    } else {
      setError(formatSshFailure(Cause.squash(result.cause)));
    }
  };

  const createFile = async () => {
    const name = (newFileName ?? "").trim();
    if (name.length === 0 || name.includes("/")) return;
    const target = `${path === "/" ? "" : path.replace(/\/+$/, "")}/${name}`;
    setError(null);
    const result = await runWriteFile({
      environmentId: props.environmentId,
      input: { serverId: props.serverId as SshServerId, path: target, content: "" },
    });
    if (AsyncResult.isSuccess(result)) {
      setNewFileName(null);
      void list(path);
    } else {
      setError(formatSshFailure(Cause.squash(result.cause)));
    }
  };

  const crumbs = useMemo(() => {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const result = [{ label: "/", value: "/" }];
    let accumulated = "";
    for (const segment of segments) {
      accumulated += `/${segment}`;
      result.push({ label: segment, value: accumulated });
    }
    return result;
  }, [path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 truncate text-muted-foreground text-xs">
                {props.serverLabel}
              </span>
            }
          />
          <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
            {props.serverLabel}
          </TooltipPopup>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {crumbs.map((crumb, index) => (
            <span key={crumb.value} className="flex shrink-0 items-center">
              {index > 0 ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
              <button
                type="button"
                className={cn(
                  "cursor-pointer rounded px-1 py-0.5 text-xs hover:bg-accent",
                  index === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground",
                )}
                onClick={() => void list(crumb.value)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("ssh.newFile")}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => setNewFileName((current) => (current === null ? "" : null))}
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("ssh.refresh")}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => void list(path)}
        >
          <RefreshCw className={cn("size-3.5", listing && "animate-spin")} />
        </button>
      </div>
      {newFileName !== null ? (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Input
            autoFocus
            value={newFileName}
            placeholder={t("ssh.fileName")}
            className="h-6 text-xs"
            onChange={(event) => setNewFileName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createFile();
              if (event.key === "Escape") setNewFileName(null);
            }}
          />
          <Button size="xs" variant="outline" onClick={() => void createFile()}>
            {t("confirm")}
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <div className="shrink-0 px-2 py-1 text-destructive text-xs">{error}</div>
      ) : null}
      {openFile !== null ? (
        <div className="flex h-full min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
            <Tooltip>
              <TooltipTrigger
                render={<span className="min-w-0 flex-1 truncate text-xs">{openFile.path}</span>}
              />
              <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
                {openFile.path}
              </TooltipPopup>
            </Tooltip>
            {openFile.truncated ? (
              <span className="shrink-0 text-amber-600 text-xs dark:text-amber-400">
                {t("ssh.truncated")}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={t("ssh.save")}
              className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => void saveOpenFile()}
            >
              <Save className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("ssh.closeEditor")}
              className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setOpenFile(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent p-2 font-mono text-xs outline-none"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {parentPath(path) !== null ? (
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
              onClick={() => {
                const target = parentPath(path);
                if (target !== null) void list(target);
              }}
            >
              <Folder className="size-3.5 shrink-0" />
              ..
            </button>
          ) : null}
          {(entries ?? [])
            .filter((entry) => entry.name !== "." && entry.name !== "..")
            .sort((left, right) => {
              if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
              return left.name.localeCompare(right.name);
            })
            .map((entry) => (
              <div
                key={entry.path}
                className="group flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                  onClick={() => void openFileForEdit(entry)}
                >
                  {entry.isDirectory ? (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
                <span className="shrink-0 text-muted-foreground text-[10px] tabular-nums">
                  {entry.sizeBytes === undefined ? "" : formatBytes(entry.sizeBytes)}
                </span>
                <span className="hidden shrink-0 text-muted-foreground text-[10px] tabular-nums sm:inline">
                  {formatModifiedAt(entry.modifiedAt)}
                </span>
                <button
                  type="button"
                  aria-label={t("ssh.delete")}
                  className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  onClick={() => void deleteEntry(entry)}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          {listing && entries === null ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : null}
          {!listing && entries !== null && entries.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-xs">
              {t("ssh.emptyDirectory")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
