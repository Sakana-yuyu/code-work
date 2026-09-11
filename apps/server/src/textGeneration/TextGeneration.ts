import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection } from "@codework/contracts";
import { TextGenerationError } from "@codework/contracts";
import { createModelSelection, resolveSelectableModel } from "@codework/shared/model";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "grok"
  | "kimi"
  | "antigravity"
  | "opencode"
  | "piAgent"
  | "ompAgent"
  | "acpAgent";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("codework/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  selection: ModelSelection,
): Effect.Effect<
  {
    textGeneration: ProviderInstance["textGeneration"];
    modelSelection: ModelSelection;
  },
  TextGenerationError
> =>
  Effect.gen(function* () {
    const instance = yield* registry.getInstance(selection.instanceId);
    if (!instance) {
      return yield* new TextGenerationError({
        operation,
        detail: `No provider instance registered for id '${selection.instanceId}'.`,
      });
    }
    const snapshot = yield* instance.snapshot.getSnapshot;
    let modelSelection = selection;
    // 后台任务同样受共享渠道目录约束，不能把原生默认模型继续发给 BYOK 网关。
    if (snapshot.auth.type === "byok") {
      const model =
        resolveSelectableModel(instance.driverKind, selection.model, snapshot.models) ??
        snapshot.models[0]?.slug;
      if (!model) {
        return yield* new TextGenerationError({
          operation,
          detail: `No models are available in the BYOK channel for '${selection.instanceId}'.`,
        });
      }
      if (model !== selection.model) {
        modelSelection = createModelSelection(selection.instanceId, model);
      }
    }
    return { textGeneration: instance.textGeneration, modelSelection };
  });

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
        ),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generatePrContent({ ...input, modelSelection }),
        ),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
        ),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateThreadTitle({ ...input, modelSelection }),
        ),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
