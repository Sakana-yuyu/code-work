import {
  resolveCompositionSquadNodeCancellable,
  type CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";

import { t } from "../../i18n";
import { SquadRunBoardActionButton } from "./SquadRunBoardActionButton";

export function SquadRunBoardCancelAction(props: {
  readonly node: CompositionSquadRunBoardNode;
  readonly disabled: boolean;
  readonly onCancel: (node: CompositionSquadRunBoardNode) => void;
}) {
  if (!resolveCompositionSquadNodeCancellable(props.node)) return null;
  return (
    <SquadRunBoardActionButton
      label={t("squadExecutionHistory.cancelNode")}
      disabled={props.disabled}
      onPress={() => props.onCancel(props.node)}
    />
  );
}
