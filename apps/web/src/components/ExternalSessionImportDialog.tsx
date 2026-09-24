"use client";

import type { EnvironmentId, ProjectId, ThreadId } from "@codework/contracts";
import type { ExternalSessionCandidate } from "@codework/contracts";
import { useEffect, useState } from "react";

import { externalSessionEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { t } from "../i18n";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

interface ImportProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
}

interface ExternalSessionImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: readonly ImportProject[];
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}

/** 在项目所属环境扫描并导入 CLI 历史；列表不传输本机日志路径。 */
export function ExternalSessionImportDialog({
  open,
  onOpenChange,
  projects,
  onOpenThread,
}: ExternalSessionImportDialogProps) {
  const [projectIndex, setProjectIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<readonly (typeof ExternalSessionCandidate.Type)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const scan = useAtomCommand(externalSessionEnvironment.scan, { reportFailure: false });
  const importSession = useAtomCommand(externalSessionEnvironment.importSession, {
    reportFailure: false,
  });
  const project = projects[projectIndex] ?? projects[0];

  useEffect(() => {
    if (!open || !project) return;
    let cancelled = false;
    setScanning(true);
    setError(null);
    setSessions([]);
    void scan({
      environmentId: project.environmentId,
      input: { projectId: project.projectId },
    }).then((result) => {
      if (cancelled) return;
      setScanning(false);
      if (result._tag === "Failure" || result.value.error !== null) {
        setError(t("externalSessionsScanFailed"));
        return;
      }
      setSessions(result.value.sessions);
    });
    return () => {
      cancelled = true;
    };
  }, [open, project, scan]);

  const visible = sessions.filter((session) =>
    `${session.title} ${session.provider}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const onImport = async (sessionId: string) => {
    if (!project) return;
    setImportingId(sessionId);
    setError(null);
    const result = await importSession({
      environmentId: project.environmentId,
      input: { projectId: project.projectId, sessionId },
    });
    setImportingId(null);
    if (result._tag === "Failure" || result.value.error !== null || !result.value.threadId) {
      setError(t("externalSessionsImportFailed"));
      return;
    }
    setSessions((current) =>
      current.map((entry) => (entry.id === sessionId ? { ...entry, imported: true } : entry)),
    );
    if (result.value.truncated) {
      toastManager.add({ type: "warning", title: t("externalSessionsTruncated") });
    }
    onOpenThread(project.environmentId, result.value.threadId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("externalSessionsTitle")}</DialogTitle>
          <DialogDescription>{t("externalSessionsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6 pb-6">
          <div className="flex flex-wrap gap-1">
            {projects.map((entry, index) => (
              <Button
                key={`${entry.environmentId}:${entry.projectId}`}
                size="sm"
                type="button"
                variant={project === entry ? "secondary" : "outline"}
                onClick={() => setProjectIndex(index)}
              >
                {entry.name}
              </Button>
            ))}
          </div>
          <Input
            aria-label={t("externalSessionsSearch")}
            placeholder={t("externalSessionsSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {scanning ? (
            <p className="text-sm text-muted-foreground">{t("externalSessionsScanning")}</p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!scanning && !error && visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("externalSessionsEmpty")}</p>
          ) : null}
          <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {visible.map((session) => (
              <div className="flex items-center gap-3 p-3" key={session.id}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{session.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {session.provider === "codex"
                      ? t("externalSessionsCodex")
                      : t("externalSessionsClaude")}{" "}
                    · {session.modifiedAt.slice(0, 10)}
                    {" · "}
                    {session.canResume
                      ? t("externalSessionsResumable")
                      : t("externalSessionsReadOnly")}
                  </div>
                </div>
                <Button
                  disabled={importingId !== null}
                  onClick={() => void onImport(session.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {session.imported ? t("externalSessionsOpen") : t("externalSessionsImport")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
