import { memo, type CSSProperties } from "react";
import type { DiffsHighlighter } from "@pierre/diffs";

/* oxlint-disable react/no-array-index-key -- 流式内容只在尾部增长，行号和行内序号用于保留已显示节点的身份。 */

export type HighlightedCode = ReturnType<DiffsHighlighter["codeToTokens"]>;
type Tokens = HighlightedCode["tokens"][number];

function styleFor(token: Tokens[number]): CSSProperties {
  const font = Math.max(0, token.fontStyle ?? 0);
  return {
    color: token.color,
    fontStyle: font & 1 ? "italic" : undefined,
    fontWeight: font & 2 ? "bold" : undefined,
    textDecoration: font & 4 ? "underline" : undefined,
    ...token.htmlStyle,
  };
}

export function sameHighlightedLine(previous: Tokens, next: Tokens): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((token, index) => {
        const other = next[index];
        return (
          token.content === other?.content &&
          token.color === other.color &&
          token.fontStyle === other.fontStyle &&
          JSON.stringify(token.htmlStyle) === JSON.stringify(other.htmlStyle)
        );
      }))
  );
}

const HighlightedLine = memo(
  function HighlightedLine({ tokens }: { tokens: Tokens }) {
    return (
      <span className="line">
        {tokens.map((token, index) => (
          <span key={index} style={styleFor(token)}>
            {token.content}
          </span>
        ))}
      </span>
    );
  },
  (previous, next) => sameHighlightedLine(previous.tokens, next.tokens),
);

export function HighlightedCodeLines({ highlighted }: { highlighted: HighlightedCode }) {
  return (
    <div className="chat-markdown-shiki">
      <pre
        className={`shiki ${highlighted.themeName ?? ""}`}
        style={{ color: highlighted.fg, backgroundColor: highlighted.bg }}
        tabIndex={0}
      >
        <code>
          {highlighted.tokens
            .map((tokens, index) => <HighlightedLine key={index} tokens={tokens} />)
            .flatMap((line, index) => (index === 0 ? [line] : ["\n", line]))}
        </code>
      </pre>
    </div>
  );
}
