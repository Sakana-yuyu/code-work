import { useAtomValue } from "@effect/atom-react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { highlightCodeSnippet, type ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import {
  createMarkdownCodeDisplaySelector,
  type MarkdownHighlightedCode,
} from "./markdownCodeDisplay";

export type { MarkdownHighlightedCode } from "./markdownCodeDisplay";

const MARKDOWN_CODE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;

export interface MarkdownCodeHighlightInput {
  readonly code: string;
  readonly enabled: boolean;
  readonly language: string;
  readonly theme: ReviewDiffTheme;
}

type MarkdownCodeHighlighter = (
  input: MarkdownCodeHighlightInput,
) => Promise<MarkdownHighlightedCode | null>;

class MarkdownCodeHighlightCacheKey extends Data.Class<MarkdownCodeHighlightInput> {}

class MarkdownCodeHighlightError extends Data.TaggedError("MarkdownCodeHighlightError")<{
  readonly cause: unknown;
}> {}

export function createMarkdownCodeHighlightAtomFamily(options?: {
  readonly highlight?: MarkdownCodeHighlighter;
  readonly idleTtlMs?: number;
}) {
  const highlight =
    options?.highlight ??
    ((input: MarkdownCodeHighlightInput) =>
      input.enabled
        ? highlightCodeSnippet({
            code: input.code,
            language: input.language,
            theme: input.theme,
          })
        : Promise.resolve(null));
  const idleTtlMs = options?.idleTtlMs ?? MARKDOWN_CODE_HIGHLIGHT_IDLE_TTL_MS;
  const family = Atom.family((request: MarkdownCodeHighlightCacheKey) =>
    Atom.make(
      Effect.tryPromise({
        try: () => highlight(request),
        catch: (cause) => new MarkdownCodeHighlightError({ cause }),
      }),
    ).pipe(
      Atom.setIdleTTL(idleTtlMs),
      Atom.withLabel(`mobile:thread-markdown-code-highlight:${request.theme}:${request.language}`),
    ),
  );

  return (input: MarkdownCodeHighlightInput) => family(new MarkdownCodeHighlightCacheKey(input));
}

export const markdownCodeHighlightAtom = createMarkdownCodeHighlightAtomFamily();

export function useMarkdownCodeHighlight(input: {
  readonly code: string;
  readonly enabled: boolean;
  readonly language: string | null | undefined;
  readonly theme: ReviewDiffTheme;
}): MarkdownHighlightedCode {
  const normalizedLanguage = input.language?.trim() || "text";
  const enabled = input.enabled && Boolean(input.language?.trim());
  const atomLanguage = enabled ? normalizedLanguage : "text";
  const highlightAtom = useMemo(
    () =>
      markdownCodeHighlightAtom({
        code: enabled ? input.code : "",
        enabled,
        language: atomLanguage,
        theme: input.theme,
      }),
    [atomLanguage, enabled, input.code, input.theme],
  );
  const result = useAtomValue(highlightAtom);
  const display = useMemo(createMarkdownCodeDisplaySelector, []);
  return display({
    code: input.code,
    enabled,
    language: atomLanguage,
    theme: input.theme,
    highlighted: AsyncResult.isSuccess(result) ? result.value : null,
  });
}
