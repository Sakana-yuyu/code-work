import emojiRegex from "emoji-regex";

const EMOJI = emojiRegex();
const TEXT_SYMBOL = /^[©®™↔↕↖↗↘↙↩↪⤴⤵]$/u;

/** 仅用于会话显示，保留原始消息、协议载荷和复制来源。 */
export function withoutChatEmoji(text: string): string {
  return text.replace(EMOJI, (match) => (TEXT_SYMBOL.test(match) ? match : ""));
}

interface ChatTextNode {
  type?: string;
  tagName?: string;
  value?: string;
  content?: string;
  children?: ChatTextNode[];
}

const displayNodes = new WeakMap<ChatTextNode, ChatTextNode>();

/** 兼容 Web 与原生 Markdown AST；不修改缓存节点、链接地址和代码。 */
export function withoutChatEmojiInTree<T extends ChatTextNode>(node: T): T {
  if (
    node.tagName === "code" ||
    node.tagName === "pre" ||
    node.type === "code" ||
    node.type === "inlineCode" ||
    node.type === "code_block" ||
    node.type === "code_inline"
  ) {
    return node;
  }
  const cached = displayNodes.get(node);
  if (cached) return cached as T;
  const value = node.type === "text" && node.value ? withoutChatEmoji(node.value) : node.value;
  const content =
    node.type === "text" && node.content ? withoutChatEmoji(node.content) : node.content;
  const children = node.children?.map(withoutChatEmojiInTree);
  const changed =
    value !== node.value ||
    content !== node.content ||
    children?.some((child, index) => child !== node.children?.[index]);
  const result = changed
    ? {
        ...node,
        ...(value !== undefined ? { value } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(children ? { children } : {}),
      }
    : node;
  displayNodes.set(node, result);
  return result;
}
