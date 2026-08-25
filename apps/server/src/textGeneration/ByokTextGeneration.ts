/**
 * ByokTextGeneration — unified text generation through the built-in BYOK
 * engine.
 *
 * Each operation makes one streaming chat request through
 * {@link ../provider/Layers/byokChatClient.ts} against the model adapter
 * selected by the `ModelSelection` (adapter id or upstream modelId, falling
 * back to the first configured adapter) and concatenates the text events
 * into the response.
 *
 * @module textGeneration/ByokTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import {
  TextGenerationError,
  type ByokSettings,
  type ChatAttachment,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  byokAdapterForModel,
  collectChatText,
  streamChat,
} from "../provider/Layers/byokChatClient.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

type ByokTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeByokTextGeneration = Effect.fn("makeByokTextGeneration")(function* (
  byokSettings: ByokSettings,
) {
  const httpClient = yield* HttpClient.HttpClient;

  const fail = (operation: ByokTextGenerationOperation, detail: string, cause?: unknown) =>
    new TextGenerationError({
      operation,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  const runByokJson = Effect.fn("runByokJson")(function* <S extends Schema.Top>(input: {
    readonly operation: ByokTextGenerationOperation;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    if (input.attachments && input.attachments.length > 0) {
      return yield* fail(input.operation, "BYOK text generation does not support attachments.");
    }

    const adapter = byokAdapterForModel(byokSettings, input.modelSelection.model);
    if (adapter === undefined) {
      return yield* fail(
        input.operation,
        "No BYOK model adapters are configured. Add one in Settings.",
      );
    }

    const text = yield* collectChatText(
      streamChat(httpClient, {
        protocol: adapter.protocol,
        baseURL: adapter.baseURL,
        apiKey: adapter.apiKey,
        modelId: adapter.modelId,
        messages: [{ role: "user", content: input.prompt }],
      }),
    ).pipe(Effect.mapError((cause) => fail(input.operation, "BYOK engine request failed.", cause)));

    const rawOutput = text.trim();
    if (rawOutput.length === 0) {
      return yield* fail(input.operation, "BYOK engine returned empty output.");
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.mapError((cause) =>
        fail(input.operation, "BYOK engine returned invalid structured output.", cause),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ByokTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runByokJson({
        operation: "generateCommitMessage",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("ByokTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runByokJson({
        operation: "generatePrContent",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("ByokTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runByokJson({
        operation: "generateBranchName",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("ByokTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runByokJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
