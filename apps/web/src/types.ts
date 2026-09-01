import type {
  ChatImageAttachment as ContractChatImageAttachment,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectScript as ContractProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
} from "@codework/contracts";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@codework/client-runtime/state/shell";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "term-1";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection?: "horizontal" | "vertical";
}

export interface ChatImageAttachment extends ContractChatImageAttachment {
  readonly previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

/** 仅用于本地时间线展示，不会写入服务端消息协议。 */
export type ChatMessagePresentation =
  | { readonly kind: "goal"; readonly summary: string }
  | { readonly kind: "queue"; readonly summary: string };

export interface ChatMessage extends Omit<OrchestrationMessage, "attachments"> {
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly localPresentation?: ChatMessagePresentation | undefined;
}

export type ProposedPlan = OrchestrationProposedPlan;
export type TurnDiffFileChange = OrchestrationCheckpointFile;
export type TurnDiffSummary = OrchestrationCheckpointSummary;

export type Project = EnvironmentProject;
export type Thread = EnvironmentThread;
export type ThreadShell = EnvironmentThreadShell;

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
}

export type SidebarThreadSummary = EnvironmentThreadShell;
export type ThreadSession = OrchestrationSession;
