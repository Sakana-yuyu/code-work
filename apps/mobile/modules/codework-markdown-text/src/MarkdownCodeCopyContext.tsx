import { createContext, useMemo, type ReactNode } from "react";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";
import { createNativeMarkdownPrefixCache } from "./nativeMarkdownText";
import { markdownCodeCopySources } from "./markdownCodeCopy";

export const MarkdownCodeCopyContext = createContext<ReadonlyMap<number, string> | null>(null);

/** 有揭示积压时才建立全文复制索引；无积压的现有代码块仍直接复制自己的全文。 */
export function MarkdownCodeCopyProvider(props: {
  readonly markdown: string | null;
  readonly options: { readonly gfm: boolean; readonly html: boolean; readonly math: boolean };
  readonly children: ReactNode;
}) {
  const parse = useMemo(
    () => createNativeMarkdownPrefixCache((text) => parseMarkdownWithOptions(text, props.options)),
    [props.options.gfm, props.options.html, props.options.math],
  );
  const sources = useMemo(
    () => (props.markdown === null ? null : markdownCodeCopySources(parse(props.markdown))),
    [parse, props.markdown],
  );
  return (
    <MarkdownCodeCopyContext.Provider value={sources}>
      {props.children}
    </MarkdownCodeCopyContext.Provider>
  );
}
