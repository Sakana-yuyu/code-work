import { memo, useDeferredValue, useEffect, useRef, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { useTextReveal } from "@codework/client-runtime/text-reveal";
import ChatMarkdown from "../ChatMarkdown";

type Props = ComponentProps<typeof ChatMarkdown> & { readonly pacing: boolean };

/** 同一个显示挂载持续追加；积压期间以不可交互的全文层保留滚动尺寸。 */
export const StreamingChatMarkdown = memo(function StreamingChatMarkdown({
  pacing,
  ...props
}: Props) {
  const reveal = useTextReveal(props.text, {
    enabled: pacing,
    streaming: props.isStreaming === true,
  });
  const visibleRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.isStreaming && !reveal.pending) return;
    const selectionChanged = () => {
      const selection = window.getSelection();
      const root = visibleRoot.current;
      if (
        root &&
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        selection.getRangeAt(0).intersectsNode(root)
      )
        reveal.hold();
      else reveal.release();
    };
    document.addEventListener("selectionchange", selectionChanged);
    return () => document.removeEventListener("selectionchange", selectionChanged);
  }, [props.isStreaming, reveal.pending, reveal.hold, reveal.release]);

  const catchUp = () => flushSync(reveal.catchUp);
  // 几何层只负责在积压期间撑住滚动高度，不参与显示。积压时它和可见层会各解析
  // 一次完整 Markdown，而它的结果在下一帧几乎必然过期。用 deferred 值让这一层
  // 跟随可中断的低优先级渲染：连续到达的增量只会合并渲染最新一版，不再逐 token
  // 重跑整棵不可见树。
  const geometryText = useDeferredValue(reveal.fullText);
  return (
    <div className="relative min-w-0" data-streaming-markdown="true">
      {reveal.pending ? (
        <div
          key="geometry"
          aria-hidden="true"
          inert
          className="invisible pointer-events-none"
          data-full-text-geometry="true"
        >
          <ChatMarkdown {...props} text={geometryText} />
        </div>
      ) : null}
      <div
        key="visible"
        ref={visibleRoot}
        style={reveal.pending ? { position: "absolute", inset: "0 0 auto" } : undefined}
        data-revealed-text="true"
        onPointerDownCapture={(event) => {
          if (event.button === 0) {
            flushSync(() => {
              reveal.release();
              reveal.catchUp();
            });
          } else catchUp();
        }}
        onKeyDownCapture={catchUp}
        onCopyCapture={catchUp}
        onClickCapture={() => {
          flushSync(() => {
            reveal.release();
            reveal.catchUp();
          });
        }}
      >
        <ChatMarkdown {...props} text={reveal.visibleText} />
      </div>
    </div>
  );
});
