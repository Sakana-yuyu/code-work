import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";

type Tag =
  | "p"
  | "blockquote"
  | "ol"
  | "li"
  | "input"
  | "a"
  | "code"
  | "img"
  | "table"
  | "details"
  | "pre";
type Props<T extends Tag> = ComponentProps<T> & ExtraProps;
export type MarkdownRenderers = { [T in Tag]: (props: Props<T>) => ReactNode };

export const MarkdownRendererContext = createContext<MarkdownRenderers | null>(null);

function renderer<T extends Tag>(tag: T) {
  return function MarkdownElement(props: Props<T>) {
    const renderers = useContext(MarkdownRendererContext);
    // 渲染回调只构造元素；组件身份固定，流式尾部更新不会重新挂载旧节点。
    return renderers?.[tag](props);
  };
}

export const STABLE_MARKDOWN_COMPONENTS = {
  p: renderer("p"),
  blockquote: renderer("blockquote"),
  ol: renderer("ol"),
  li: renderer("li"),
  input: renderer("input"),
  a: renderer("a"),
  code: renderer("code"),
  img: renderer("img"),
  table: renderer("table"),
  details: renderer("details"),
  pre: renderer("pre"),
};
