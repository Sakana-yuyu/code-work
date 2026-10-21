import {
  SelectableMarkdownText as CodeworkSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@codework/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import { withoutChatEmojiInTree } from "@codework/shared/chatPresentation";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@codework/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return (
    <CodeworkSelectableMarkdownText
      {...props}
      transformDocument={withoutChatEmojiInTree}
      highlightCode={highlightCodeSnippet}
    />
  );
}
