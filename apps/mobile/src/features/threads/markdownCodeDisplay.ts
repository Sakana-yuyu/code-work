import { nativeMarkdownCodeHighlightAppend } from "@codework/mobile-markdown-text/markdown";
import type { ReviewHighlightedToken } from "../review/shikiReviewHighlighter";

export type MarkdownHighlightedCode = ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;

interface CodeDisplayInput {
  readonly code: string;
  readonly enabled: boolean;
  readonly language: string;
  readonly theme: "light" | "dark";
  readonly highlighted: MarkdownHighlightedCode | null;
}

function sameLine(left: MarkdownHighlightedCode[number], right: MarkdownHighlightedCode[number]) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((token, index) => {
        const next = right[index]!;
        return (
          token.content === next.content &&
          token.color === next.color &&
          token.fontStyle === next.fontStyle &&
          token.diffHighlight === next.diffHighlight
        );
      }))
  );
}

/** 每个代码块独享；等待异步高亮时保留完成行，始终展示同一份完整正文。 */
export function createMarkdownCodeDisplaySelector() {
  let previous: {
    readonly input: CodeDisplayInput;
    readonly tokens: MarkdownHighlightedCode;
  } | null = null;
  return (input: CodeDisplayInput): MarkdownHighlightedCode => {
    const sameContext =
      previous !== null &&
      previous.input.enabled === input.enabled &&
      previous.input.language === input.language &&
      previous.input.theme === input.theme;
    if (
      sameContext &&
      previous !== null &&
      previous.input.code === input.code &&
      previous.input.highlighted === input.highlighted
    )
      return previous.tokens;
    const ready =
      input.enabled &&
      input.highlighted !== null &&
      input.highlighted.map((line) => line.map((token) => token.content).join("")).join("\n") ===
        input.code
        ? input.highlighted
        : null;
    let tokens: MarkdownHighlightedCode =
      ready ??
      (sameContext && previous !== null
        ? nativeMarkdownCodeHighlightAppend(previous.input.code, input.code, previous.tokens)
        : null) ??
      input.code.split("\n").map((content) => [{ content, color: null, fontStyle: null }]);
    if (ready !== null && sameContext && previous !== null) {
      const old = previous.tokens;
      tokens = ready.map((line, index) =>
        old[index] !== undefined && sameLine(old[index]!, line) ? old[index]! : line,
      );
      if (tokens.length === old.length && tokens.every((line, index) => line === old[index]))
        tokens = old;
    }
    previous = { input, tokens };
    return tokens;
  };
}
