import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CODEWORK_CHAT_THEME, type ThemeDefinition } from "../../themePalette";

const mocks = vi.hoisted(() => ({ readThemeAsset: vi.fn() }));

vi.mock("../../themeMedia", () => ({ readThemeAsset: mocks.readThemeAsset }));

import { getThemeCardDefinition, ThemePreviewCircle } from "./ThemePreviewCircles";

const previewColors = {
  sidebar: "#ffffff",
  canvas: "#ffffff",
  surface: "#ffffff",
  accentSurface: "#eeeeee",
  accent: "#ff0000",
  messageSurface: "#dddddd",
  messageAction: "#000000",
} as const;

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

it("按外观选择背景图片，沿用主题回退规则且不把视频当图片", () => {
  const global = {
    media: { kind: "image", source: "url", value: "https://example.com/light.png" },
  } as const;
  const sidebar = {
    media: {
      kind: "image",
      source: "asset",
      value: "8332cfa9-7582-4104-9ab8-849f5f04582a",
    },
    x: 25,
  } as const;
  const theme: ThemeDefinition = {
    ...CODEWORK_CHAT_THEME,
    appearance: "light",
    decorations: { light: { global, sidebar }, dark: { sidebar } },
  };
  expect(getThemeCardDefinition(theme).previews.map((preview) => preview.background)).toEqual([
    global,
    sidebar,
  ]);
  expect(
    getThemeCardDefinition({ ...theme, decorations: { light: { global } } }).previews.map(
      (preview) => preview.background,
    ),
  ).toEqual([global, global]);
  expect(
    getThemeCardDefinition({
      ...theme,
      decorations: { light: { global: { media: { ...sidebar.media, kind: "video" } } } },
    }).previews.every((preview) => preview.background === undefined),
  ).toBe(true);
  expect(
    getThemeCardDefinition(CODEWORK_CHAT_THEME).previews.every(
      (preview) => preview.background === undefined,
    ),
  ).toBe(true);
});

it("不可见的主题缩略图不会提前读取 IndexedDB 资源", async () => {
  class MockIntersectionObserver {
    static instances: MockIntersectionObserver[] = [];
    readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      MockIntersectionObserver.instances.push(this);
    }

    observe() {}
    disconnect() {}
  }

  vi.stubGlobal(
    "IntersectionObserver",
    MockIntersectionObserver as unknown as typeof IntersectionObserver,
  );
  mocks.readThemeAsset.mockReturnValue(new Promise(() => {}));
  installTestDom();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(() => {
      root.render(
        createElement(ThemePreviewCircle, {
          colors: previewColors,
          mode: "light",
          background: {
            media: { kind: "image", source: "asset", value: "asset-1" },
          },
        }),
      );
    });
    expect(mocks.readThemeAsset).not.toHaveBeenCalled();

    const observer = MockIntersectionObserver.instances[0];
    expect(observer).toBeDefined();
    await act(() => {
      observer?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    });
    expect(mocks.readThemeAsset).toHaveBeenCalledWith("asset-1");
  } finally {
    await act(() => root.unmount());
    mocks.readThemeAsset.mockReset();
    vi.unstubAllGlobals();
    MockIntersectionObserver.instances = [];
  }
});

it("没有背景媒体的主题缩略图不会创建观察器", async () => {
  class MockIntersectionObserver {
    static instances: MockIntersectionObserver[] = [];

    constructor() {
      MockIntersectionObserver.instances.push(this);
    }

    observe() {}
    disconnect() {}
  }

  vi.stubGlobal(
    "IntersectionObserver",
    MockIntersectionObserver as unknown as typeof IntersectionObserver,
  );
  installTestDom();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(() => {
      root.render(createElement(ThemePreviewCircle, { colors: previewColors, mode: "light" }));
    });
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    MockIntersectionObserver.instances = [];
  }
});
