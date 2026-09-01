import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ClientOrchestrationCommand,
  type CommandId,
  type MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@codework/contracts";
import { truncate } from "@codework/shared/String";

export interface AgentRunIdentity {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}

export interface AgentRunInput {
  readonly projectId: string;
  readonly prompt: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly model?: string;
}

export interface AgentRunResult {
  readonly agentId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly createdAt: string;
}

export type AgentRunRejectionReason =
  | "invalid-prompt"
  | "provider-model-pair"
  | "invalid-model"
  | "project-not-found"
  | "model-unavailable";

export type AgentRunPlan =
  | {
      readonly ok: true;
      readonly command: Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }>;
      readonly modelSelection: ModelSelection;
      readonly projectId: ProjectId;
    }
  | {
      readonly ok: false;
      readonly reason: AgentRunRejectionReason;
      readonly message: string;
    };

export type AgentRunInputValidation =
  | {
      readonly ok: true;
      readonly prompt: string;
      readonly explicitModel?: string;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-prompt" | "provider-model-pair" | "invalid-model";
      readonly message: string;
    };

export function validateAgentRunInput(input: AgentRunInput): AgentRunInputValidation {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return {
      ok: false,
      reason: "invalid-prompt",
      message: "Prompt must contain non-whitespace text.",
    };
  }

  const hasProvider = input.providerInstanceId !== undefined;
  const hasModel = input.model !== undefined;
  if (hasProvider !== hasModel) {
    return {
      ok: false,
      reason: "provider-model-pair",
      message: "--provider and --model must be provided together.",
    };
  }

  const explicitModel = input.model?.trim();
  if (explicitModel !== undefined && explicitModel.length === 0) {
    return {
      ok: false,
      reason: "invalid-model",
      message: "Model must contain non-whitespace text.",
    };
  }

  return {
    ok: true,
    prompt,
    ...(explicitModel === undefined ? {} : { explicitModel }),
  };
}

export function planAgentRunCommand(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  input: AgentRunInput,
  identity: AgentRunIdentity,
): AgentRunPlan {
  const validation = validateAgentRunInput(input);
  if (!validation.ok) {
    return validation;
  }

  const project = projects.find((candidate) => candidate.id === input.projectId);
  if (project === undefined) {
    return {
      ok: false,
      reason: "project-not-found",
      message: `Project '${input.projectId}' was not found.`,
    };
  }

  const modelSelection: ModelSelection | null =
    input.providerInstanceId !== undefined && validation.explicitModel !== undefined
      ? {
          instanceId: input.providerInstanceId,
          model: validation.explicitModel,
        }
      : project.defaultModelSelection;
  if (modelSelection === null) {
    return {
      ok: false,
      reason: "model-unavailable",
      message: `Project '${project.id}' has no default model selection; provide both --provider and --model.`,
    };
  }

  const title = truncate(validation.prompt);
  return {
    ok: true,
    modelSelection,
    projectId: project.id,
    command: {
      type: "thread.turn.start",
      commandId: identity.commandId,
      threadId: identity.threadId,
      message: {
        messageId: identity.messageId,
        role: "user",
        text: validation.prompt,
        attachments: [],
      },
      modelSelection,
      titleSeed: title,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      bootstrap: {
        createThread: {
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: identity.createdAt,
        },
      },
      createdAt: identity.createdAt,
    },
  };
}
