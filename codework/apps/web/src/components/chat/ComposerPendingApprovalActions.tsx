import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@codework/contracts";
import { memo } from "react";
import { Button } from "../ui/button";
import { t } from "~/i18n";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-normal";
const DEFAULT_APPROVAL_OPTIONS = [
  {
    decision: "cancel",
    get label() {
      return t("cancel");
    },
  },
  {
    decision: "decline",
    get label() {
      return t("decline");
    },
  },
  {
    decision: "acceptForSession",
    get label() {
      return t("alwaysAllowThisSession");
    },
  },
  {
    decision: "accept",
    get label() {
      return t("approve");
    },
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      {options.map((option) => (
        <Button
          key={option.decision}
          size="micro"
          variant="ghost-muted"
          className={`${APPROVAL_ACTION_CLASS_NAME}${
            option.decision === "decline"
              ? " text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground"
              : option.decision === "accept"
                ? " text-foreground"
                : ""
          }`}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          <span className="max-w-40 truncate">{option.label}</span>
        </Button>
      ))}
    </>
  );
});
