import { afterEach, describe, expect, it } from "vite-plus/test";

import { isEditableFocused } from "./editableFocus";

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

class MockElement {
  readonly shadowRoot: { activeElement: MockElement | null } | null = null;

  constructor(readonly editable: boolean) {}

  closest(selector: string): MockElement | null {
    return selector === EDITABLE_SELECTOR && this.editable ? this : null;
  }
}

const originalDocument = globalThis.document;
const originalElement = globalThis.Element;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalElement === undefined) {
    delete (globalThis as { Element?: typeof Element }).Element;
  } else {
    globalThis.Element = originalElement;
  }
});

describe("isEditableFocused", () => {
  it("follows the event target into an open shadow root", () => {
    // A key event from a shadow input is retargeted to its host, so the host is
    // what page-level shortcut handlers receive as the event target.
    const inner = new MockElement(true);
    const host = new MockElement(false);
    Object.defineProperty(host, "shadowRoot", { value: { activeElement: inner } });
    globalThis.Element = MockElement as unknown as typeof Element;
    globalThis.document = { activeElement: host } as unknown as Document;

    expect(isEditableFocused(host as unknown as EventTarget)).toBe(true);
    expect(isEditableFocused()).toBe(true);
  });

  it("returns false for non-editable and absent targets", () => {
    globalThis.Element = MockElement as unknown as typeof Element;
    const plain = new MockElement(false);
    globalThis.document = { activeElement: plain } as unknown as Document;

    expect(isEditableFocused(plain as unknown as EventTarget)).toBe(false);
    expect(isEditableFocused(null)).toBe(false);
    expect(isEditableFocused({} as unknown as EventTarget)).toBe(false);
  });
});
