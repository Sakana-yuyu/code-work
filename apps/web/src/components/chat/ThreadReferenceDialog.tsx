import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@codework/contracts";
import { useMemo, useRef, useState } from "react";

import { t } from "~/i18n";
import { useProjects, useThreadShells } from "~/state/entities";
import { threadReferenceEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

interface Reference {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly excerpt: string;
  readonly truncated: boolean;
}

export function formatThreadReference(reference: Reference): string {
  return [
    `\n\n${t("threadReference.contextHeading")}: ${reference.title}`,
    `${t("threadReference.source")}: ${reference.environmentId} / ${reference.projectId} / ${reference.threadId}`,
    t("threadReference.untrustedNotice"),
    reference.excerpt,
    ...(reference.truncated ? [t("threadReference.truncated")] : []),
    "\n",
  ].join("\n");
}

export function ThreadReferenceDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly currentThreadRef: ScopedThreadRef | null;
  readonly onInsert: (text: string) => void;
}) {
  const threads = useThreadShells();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const [reference, setReference] = useState<Reference | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const getReference = useAtomCommand(threadReferenceEnvironment.getReference, {
    reportFailure: false,
  });
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return threads
      .filter(
        (thread) =>
          (props.currentThreadRef === null ||
            thread.environmentId !== props.currentThreadRef.environmentId ||
            thread.id !== props.currentThreadRef.threadId) &&
          (needle === "" || thread.title.toLowerCase().includes(needle)),
      )
      .slice(0, 80);
  }, [props.currentThreadRef, query, threads]);

  const choose = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError(null);
    setReference(null);
    const result = await getReference({ environmentId, input: { threadId } });
    if (currentRequestId !== requestId.current) return;
    setLoading(false);
    if (
      result._tag === "Failure" ||
      result.value.error !== null ||
      result.value.projectId === null ||
      result.value.title === null
    ) {
      setError(t("threadReference.unavailable"));
      return;
    }
    setReference({
      environmentId,
      projectId: result.value.projectId,
      threadId,
      title: result.value.title,
      excerpt: result.value.excerpt,
      truncated: result.value.truncated,
    });
  };

  const onOpenChange = (open: boolean) => {
    if (!open) {
      requestId.current += 1;
      setReference(null);
      setQuery("");
      setError(null);
      setLoading(false);
    }
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("threadReference.title")}</DialogTitle>
          <DialogDescription>{t("threadReference.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6 pb-6">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("threadReference.search")}
            placeholder={t("threadReference.search")}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {reference ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{reference.title}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/20 p-3 text-xs">
                {reference.excerpt}
              </pre>
              {reference.truncated ? (
                <p className="text-xs text-muted-foreground">{t("threadReference.truncated")}</p>
              ) : null}
              <Button
                type="button"
                onClick={() => {
                  props.onInsert(formatThreadReference(reference));
                  onOpenChange(false);
                }}
              >
                {t("threadReference.insert")}
              </Button>
            </div>
          ) : (
            <div className="max-h-72 overflow-auto rounded border border-border/60">
              {visible.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">{t("threadReference.empty")}</p>
              ) : null}
              {visible.map((thread) => {
                const project = projects.find(
                  (entry) =>
                    entry.environmentId === thread.environmentId && entry.id === thread.projectId,
                );
                return (
                  <button
                    key={`${thread.environmentId}:${thread.id}`}
                    type="button"
                    className="block w-full border-b border-border/40 p-3 text-left hover:bg-accent/40 disabled:opacity-50"
                    disabled={loading}
                    onClick={() => void choose(thread.environmentId, thread.id)}
                  >
                    <span className="block truncate text-sm">{thread.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project?.title ?? thread.projectId} · {thread.environmentId}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {loading ? (
            <p className="text-xs text-muted-foreground">{t("threadReference.loading")}</p>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
