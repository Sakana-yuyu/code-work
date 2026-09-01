/**
 * Asking someone to review, from the row that says who is already reviewing.
 *
 * The people who may be asked are read only once this menu opens: on a large repository that is
 * a list of everyone with access, which is worth a request when somebody wants it and worth
 * nothing on every pull request they merely open.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
} from "@codework/contracts";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { PullRequestPeopleGhost } from "./PullRequestGhosts";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";
import { t } from "~/i18n";

/** Long lists are common — an organisation repository lists everyone — so what arrived can be
 * narrowed here. It narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: PullRequestReviewerCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}

export function PullRequestReviewerPicker({
  environmentId,
  reference,
  allowed,
  onRequested,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** False where the host would refuse this account's request, which is worth saying rather than
   * hiding: the control disabled with a reason answers the question its absence would raise. */
  allowed: boolean;
  /** The detail carries who is requested, so it is re-read once the host has taken the change. */
  onRequested: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });

  const candidates = useMemo(
    () => (candidatesQuery.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidatesQuery.data, query],
  );

  const toggle = async (candidate: PullRequestReviewerCandidate) => {
    if (pending !== null) return;
    setPending(candidate.id);
    const result = await requestReviewers({
      environmentId,
      input: {
        ...reference,
        reviewers: [{ id: candidate.id, kind: candidate.kind }],
        requested: !candidate.isRequested,
      },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isRequested
          ? t("couldNotTakeBackTheReviewRequestTo", { login: candidate.login })
          : t("couldNotAskForAReview", { login: candidate.login }),
        description: readableFailure(
          squashAtomCommandFailure(result),
          t("pullRequests.hintReviewerAccessRefused"),
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: candidate.isRequested
        ? t("reviewRequestToTakenBack", { login: candidate.login })
        : t("reviewRequestedFrom", { login: candidate.login }),
    });
    onRequested();
    candidatesQuery.refresh();
  };

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label={t("requestAReview")}>
              <UserPlusIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {t("askingSomeoneToReviewNeedsWriteAccessOnThisRepository")}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={t("requestAReview")}>
            <UserPlusIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="start" side="bottom" className="w-72 p-0">
        <div className="border-b border-border/60 p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("searchPeopleWithAccess")}
            aria-label={t("searchPeopleWithAccess")}
            size="compact"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {candidatesQuery.isPending ? (
            <PullRequestPeopleGhost rows={4} />
          ) : candidatesQuery.error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              {t("thePeopleWithAccessCouldNotBeRead")} {candidatesQuery.error}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0
                ? t("nobodyWithAccessMatchesThat")
                : t("nobodyElseHasAccessToThisRepository")}
            </p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={`${candidate.kind}:${candidate.id}`}
                type="button"
                disabled={pending !== null}
                onClick={() => void toggle(candidate)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-60"
              >
                <PullRequestActorLabel actor={candidate} className="min-w-0 flex-1 truncate" />
                {candidate.kind === "team" ? (
                  <span className="shrink-0 text-muted-foreground">{t("team")}</span>
                ) : null}
                {candidate.isRequested ? (
                  <CheckIcon aria-label={t("alreadyAsked")} className="size-3.5 shrink-0" />
                ) : null}
              </button>
            ))
          )}
          {candidatesQuery.data?.truncated ? (
            // Typing filters what arrived; it does not ask the host again, so this says what the
            // list is rather than offering a search that would find nothing further.
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("thisRepositoryHasMorePeopleWithAccessThanAreListedHereAskForTheRestOnThe")}
            </p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
