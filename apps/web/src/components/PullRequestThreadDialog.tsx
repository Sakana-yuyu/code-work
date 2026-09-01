import type { EnvironmentId, ThreadId } from "@codework/contracts";
import { isAtomCommandInterrupted } from "@codework/client-runtime/state/runtime";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  readCachedPullRequestResolution,
  usePreparePullRequestThreadAction,
  usePullRequestResolution,
} from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { localizedPrLong } from "./GitActionsControl.logic";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { t } from "~/i18n";

interface PullRequestThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

export function PullRequestThreadDialog({
  open,
  environmentId,
  threadId,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const { data: gitStatus } = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const terminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const sourceControlScope = useMemo(
    () => ({
      environmentId,
      cwd,
    }),
    [cwd, environmentId],
  );
  const pullRequestResolution = usePullRequestResolution({
    ...sourceControlScope,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedPullRequest = useMemo(() => {
    return (
      readCachedPullRequestResolution({
        ...sourceControlScope,
        reference: parsedReference,
      })?.pullRequest ?? null
    );
  }, [parsedReference, sourceControlScope]);
  const preparePullRequestThreadAction = usePreparePullRequestThreadAction(sourceControlScope);

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (pullRequestResolution.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      pullRequestResolution.isPending ||
      pullRequestResolution.isFetching);
  const statusTone = useMemo(() => {
    switch (resolvedPullRequest?.state) {
      case "merged":
        return "text-violet-600 dark:text-violet-300/90";
      case "closed":
        return "text-zinc-500 dark:text-zinc-400/80";
      case "open":
        return "text-emerald-600 dark:text-emerald-300/90";
      default:
        return "text-muted-foreground";
    }
  }, [resolvedPullRequest?.state]);

  const handleConfirm = useCallback(
    async (mode: "local" | "worktree") => {
      if (!parsedReference) {
        setReferenceDirty(true);
        return;
      }
      if (!parsedReference || !resolvedPullRequest || !cwd) {
        return;
      }
      setPreparingMode(mode);
      const result = await preparePullRequestThreadAction.run({
        reference: parsedReference,
        mode,
        ...(mode === "worktree" ? { threadId } : {}),
      });
      setPreparingMode(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          preparePullRequestThreadAction.resetError();
        }
        return;
      }
      await onPrepared({
        branch: result.value.branch,
        worktreePath: result.value.worktreePath,
      });
      onOpenChange(false);
    },
    [
      cwd,
      onOpenChange,
      onPrepared,
      parsedReference,
      preparePullRequestThreadAction,
      resolvedPullRequest,
      threadId,
    ],
  );

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? t("interface.paste-a-value-url-checkout-command-or-enter-123-123", {
          value1: terminology.singular,
        })
      : parsedReference === null
        ? t("interface.use-a-value-url-checkout-command-123-or-123", {
            value1: terminology.singular,
          })
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && pullRequestResolution.error
      ? pullRequestResolution.error
      : preparePullRequestThreadAction.error instanceof Error
        ? preparePullRequestThreadAction.error.message
        : preparePullRequestThreadAction.error
          ? t("pullRequests.failedToPrepareThread", { pr: localizedPrLong(terminology) })
          : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!preparePullRequestThreadAction.isPending) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SourceControlIcon className="size-4" />
            {t("checkout")} {terminology.singular}
          </DialogTitle>
          <DialogDescription>
            {t("resolveA")} {sourceControlPresentation.providerName} {terminology.singular}
            {t("thenCreateTheDraftThreadInTheMainRepoOrInADedicatedWorktree")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground capitalize">
              {terminology.singular}
            </span>
            <Input
              ref={referenceInputRef}
              placeholder={t("urlCheckoutCommandOr42", { shortLabel: terminology.shortLabel })}
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !preparePullRequestThreadAction.isPending) {
                  void handleConfirm("local");
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{resolvedPullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} {t("to")}{" "}
                    {resolvedPullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {resolvedPullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              {t("resolving")} {terminology.singular}...
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={preparePullRequestThreadAction.isPending}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void handleConfirm("local");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending
            }
          >
            {preparingMode === "local"
              ? t("preparingLocal")
              : t("commandPalette.environmentLabelLocal")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm("worktree");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending
            }
          >
            {preparingMode === "worktree" ? t("preparingWorktree2") : t("workspace.worktree")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
