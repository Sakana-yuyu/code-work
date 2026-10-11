import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createTextReveal, type TextRevealInput } from "./textReveal.ts";

export { isTextRevealEnabled } from "./textReveal.ts";

/** 仅限显示；调用方的复制、选区与尺寸测量继续使用返回的 fullText。 */
export function useTextReveal(text: string, options: Omit<TextRevealInput, "text">) {
  const [reveal] = useState(() => createTextReveal({ text, ...options }));
  useLayoutEffect(() => {
    reveal.activate();
    return () => reveal.dispose();
  }, [reveal]);
  useLayoutEffect(() => {
    reveal.update({ text, ...options });
  }, [reveal, text, options.enabled, options.streaming]);
  const snapshot = useSyncExternalStore(reveal.subscribe, reveal.getSnapshot, reveal.getSnapshot);
  const showFull = !options.streaming || !options.enabled;
  return {
    fullText: text,
    visibleText: showFull && !snapshot.pending ? text : snapshot.visibleText,
    pending: snapshot.pending,
    catchUp: reveal.catchUp,
    hold: reveal.hold,
    release: reveal.release,
  };
}
