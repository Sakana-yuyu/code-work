import type { ResponseStreamingMode } from "@codework/contracts";

/** 只扫描新增的完整行；段落模式保留未闭合块，避免反复解析已完成前缀。 */
export class AssistantTextBuffer {
  private text = "";
  private lineStart = 0;
  private searchOffset = 0;
  private fence: { readonly marker: string; readonly length: number } | undefined;
  private indentedCode = false;
  private listIndent: number | undefined;
  private waitingForHeadingBody = false;
  private mayBeSetextHeading = false;

  append(delta: string, mode: ResponseStreamingMode): string {
    this.text += delta;
    if (mode === "token") {
      return this.take();
    }
    if (mode === "turn") return "";

    let boundary = 0;
    for (;;) {
      const newline = this.text.indexOf("\n", this.searchOffset);
      if (newline < 0) {
        this.searchOffset = this.text.length;
        break;
      }
      const start = this.lineStart;
      const end = newline + 1;
      const line = this.text.slice(start, newline).replace(/\r$/, "");
      this.lineStart = end;
      this.searchOffset = end;
      // 引用内的围栏也需要闭合后才显示。
      const blockLine = line.replace(/^\s*(?:>\s*)+/, "");
      const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(blockLine);
      if (this.fence !== undefined) {
        if (
          fenceMatch?.[1]?.[0] === this.fence.marker &&
          fenceMatch[1].length >= this.fence.length &&
          fenceMatch[2]?.trim() === ""
        ) {
          this.fence = undefined;
          boundary = end;
          this.listIndent = undefined;
        }
        continue;
      }
      const isIndented = /^(?: {4}|\t)/.test(blockLine) && blockLine.trim().length > 0;
      if (this.indentedCode) {
        if (blockLine.trim() === "" || isIndented) continue;
        this.indentedCode = false;
        boundary = start;
      }
      if (isIndented && this.listIndent === undefined) {
        this.indentedCode = true;
        this.waitingForHeadingBody = false;
        this.mayBeSetextHeading = false;
        continue;
      }
      if (
        fenceMatch !== null &&
        !(fenceMatch[1]!.startsWith("`") && fenceMatch[2]!.includes("`"))
      ) {
        this.fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
        this.waitingForHeadingBody = false;
        this.mayBeSetextHeading = false;
        continue;
      }
      if (blockLine.trim() === "") {
        if (!this.waitingForHeadingBody) boundary = end;
        this.listIndent = undefined;
        this.mayBeSetextHeading = false;
        continue;
      }
      if (
        /^ {0,3}#{1,6}(?:\s|$)/.test(blockLine) ||
        (this.mayBeSetextHeading && /^ {0,3}(?:=+|-+)\s*$/.test(blockLine))
      ) {
        this.waitingForHeadingBody = true;
        this.listIndent = undefined;
        this.mayBeSetextHeading = false;
        continue;
      }
      this.waitingForHeadingBody = false;
      const listMatch = /^( *)(?:[-+*]|\d{1,9}[.)])\s+\S/.exec(blockLine);
      if (listMatch !== null) {
        const indent = listMatch[1]!.length;
        if (this.listIndent !== undefined && indent <= this.listIndent) boundary = start;
        this.listIndent =
          this.listIndent === undefined ? indent : Math.min(this.listIndent, indent);
      }
      this.mayBeSetextHeading = listMatch === null;
    }
    // 下一项的正文一出现就能确认上一项闭合，无需等下一项整行到齐。
    if (this.fence === undefined && !this.indentedCode && this.listIndent !== undefined) {
      const nextItem = /^( *)(?:[-+*]|\d{1,9}[.)])\s+\S/.exec(this.text.slice(this.lineStart));
      if (nextItem !== null && nextItem[1]!.length <= this.listIndent) boundary = this.lineStart;
    }
    if (boundary === 0) return "";
    const completed = this.text.slice(0, boundary);
    this.text = this.text.slice(boundary);
    this.lineStart -= boundary;
    this.searchOffset -= boundary;
    return completed;
  }

  /** 回合结束、工具或审批边界取走尾段，同时清除扫描状态。 */
  take(): string {
    const text = this.text;
    this.text = "";
    this.lineStart = 0;
    this.searchOffset = 0;
    this.fence = undefined;
    this.indentedCode = false;
    this.listIndent = undefined;
    this.waitingForHeadingBody = false;
    this.mayBeSetextHeading = false;
    return text;
  }
}
