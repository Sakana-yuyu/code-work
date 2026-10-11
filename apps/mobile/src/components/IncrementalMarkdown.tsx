import { useMemo, type ComponentProps } from "react";
import { Markdown } from "react-native-nitro-markdown";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";
import { createNativeMarkdownPrefixCache } from "@codework/mobile-markdown-text/markdown";

type Props = Pick<
  ComponentProps<typeof Markdown>,
  "children" | "options" | "renderers" | "styles" | "theme"
>;

/** Android 等非原生选区表面也复用闭合前缀；主题与渲染器仍由调用方提供。 */
export function IncrementalMarkdown({ children, options, ...props }: Props) {
  const gfm = options?.gfm ?? true;
  const html = options?.html ?? false;
  const math = options?.math ?? true;
  const parse = useMemo(
    () =>
      createNativeMarkdownPrefixCache((text) =>
        parseMarkdownWithOptions(text, { gfm, html, math }),
      ),
    [gfm, html, math],
  );
  const sourceAst = useMemo(() => parse(children), [children, parse]);
  return (
    <Markdown {...props} options={options} sourceAst={sourceAst}>
      {children}
    </Markdown>
  );
}
