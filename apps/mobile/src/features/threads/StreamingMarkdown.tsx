import { memo, type ComponentProps } from "react";
import { View } from "react-native";
import { useTextReveal } from "@codework/client-runtime/text-reveal";
import { MarkdownCodeCopyProvider } from "@codework/mobile-markdown-text/copy-source";
import { IncrementalMarkdown } from "../../components/IncrementalMarkdown";
import {
  SelectableMarkdownText,
  hasNativeSelectableMarkdownText,
} from "../../native/SelectableMarkdownText";

type Props = {
  readonly text: string;
  readonly streaming: boolean;
  readonly pacing: boolean;
  readonly native: Omit<ComponentProps<typeof SelectableMarkdownText>, "markdown">;
  readonly fallback: Omit<ComponentProps<typeof IncrementalMarkdown>, "children">;
};

const MarkdownContent = memo(function MarkdownContent(props: Omit<Props, "streaming" | "pacing">) {
  return hasNativeSelectableMarkdownText() ? (
    <SelectableMarkdownText {...props.native} markdown={props.text} />
  ) : (
    <IncrementalMarkdown {...props.fallback}>{props.text}</IncrementalMarkdown>
  );
});

/** 测量完整正文，不把显示节奏写回消息；触摸选择前先追上全文。 */
export const StreamingMarkdown = memo(function StreamingMarkdown(props: Props) {
  const reveal = useTextReveal(props.text, { enabled: props.pacing, streaming: props.streaming });
  return (
    <MarkdownCodeCopyProvider
      markdown={reveal.pending ? reveal.fullText : null}
      options={
        hasNativeSelectableMarkdownText()
          ? { gfm: true, html: true, math: false }
          : {
              gfm: props.fallback.options?.gfm ?? true,
              html: props.fallback.options?.html ?? false,
              math: props.fallback.options?.math ?? true,
            }
      }
    >
      <View onTouchStart={reveal.catchUp}>
        {reveal.pending ? (
          <View
            key="geometry"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={{ opacity: 0 }}
          >
            <MarkdownContent
              native={props.native}
              fallback={props.fallback}
              text={reveal.fullText}
            />
          </View>
        ) : null}
        <View
          key="visible"
          style={reveal.pending ? { position: "absolute", top: 0, left: 0, right: 0 } : undefined}
        >
          <MarkdownContent
            native={props.native}
            fallback={props.fallback}
            text={reveal.visibleText}
          />
        </View>
      </View>
    </MarkdownCodeCopyProvider>
  );
});
