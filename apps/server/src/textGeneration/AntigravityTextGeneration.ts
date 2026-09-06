import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { AntigravitySettings, TextGenerationError, type ModelSelection } from "@codework/contracts";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { extractJsonObject } from "@codework/shared/schemaJson";
import { collectStreamAsString } from "../provider/providerSnapshot.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@codework/shared/git";
import { resolveConfiguredAntigravityModel } from "../provider/Layers/AntigravityProvider.ts";

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  settings: AntigravitySettings,
  environment?: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly schema: S;
    readonly model: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError> =>
    Effect.gen(function* () {
      const selectedModel = resolveConfiguredAntigravityModel(settings, input.model.model);
      const modelArgs = selectedModel ? ["--model", selectedModel] : [];
      const resolved = yield* resolveSpawnCommand(
        settings.binaryPath,
        ["-p", input.prompt, "--output-format", "json", ...modelArgs],
        {
          ...(environment ? { env: environment } : {}),
        },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          cwd: input.cwd,
          ...(environment ? { env: environment } : { extendEnv: true }),
          shell: resolved.shell,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const stderrText = String(stderr ?? "");
      if (Number(code) !== 0)
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: stderrText.trim() || `agy exited with code ${code}.`,
        });
      const output = String(stdout ?? "").trim();
      if (!output)
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Antigravity returned empty output.",
        });
      let raw = output;
      const envelope = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(output);
      if (Option.isSome(envelope)) {
        const value = envelope.value;
        if (
          value &&
          typeof value === "object" &&
          "response" in value &&
          typeof value.response === "string"
        ) {
          raw = value.response;
        } else if (
          value &&
          typeof value === "object" &&
          "result" in value &&
          value.result &&
          typeof value.result === "object" &&
          "response" in value.result &&
          typeof value.result.response === "string"
        ) {
          raw = value.result.response;
        }
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.schema))(
        extractJsonObject(raw),
      ).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Antigravity returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        Schema.is(TextGenerationError)(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity headless request failed.",
              cause,
            }),
      ),
    ) as unknown as Effect.Effect<S["Type"], TextGenerationError>;

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const result = yield* run({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(result.subject),
        body: result.body.trim(),
        ...("branch" in result && typeof result.branch === "string"
          ? { branch: sanitizeFeatureBranchName(result.branch) }
          : {}),
      };
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AntigravityTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const result = yield* run({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection,
      });
      return { title: sanitizePrTitle(result.title), body: result.body.trim() };
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const result = yield* run({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(result.branch) };
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const result = yield* run({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(result.title) };
    });
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
