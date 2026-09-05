import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  scrollToSettingsTarget,
  SettingsRow,
  SettingsSection,
  SettingsSearchTargetProvider,
} from "./settingsLayout";
import { FacilitiesPageHeader } from "./FacilitiesPageHeader";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("设置页标题层级", () => {
  it("只显示一个主标题，同时保留说明、引导、操作按钮及分组标题", () => {
    const markup = renderToStaticMarkup(
      <>
        <FacilitiesPageHeader icon={null} title="供应商" description="连接模型服务">
          <button>查看引导</button>
        </FacilitiesPageHeader>
        <SettingsSection
          id="providers"
          title="供应商"
          hideTitle
          headerAction={<button>添加供应商</button>}
        >
          <p>供应商列表</p>
        </SettingsSection>
        <SettingsSection title="执行历史">
          <p>历史记录</p>
        </SettingsSection>
      </>,
    );

    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup.match(/<h2\b/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="供应商" id="providers" tabindex="-1"');
    expect(markup).toContain("连接模型服务");
    expect(markup).toContain("查看引导");
    expect(markup).toContain("添加供应商");
    expect(markup).toContain("执行历史");
    expect(markup).toContain("justify-end");
  });

  it("只读或空状态没有操作按钮时不留下空标题栏", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection id="providers" title="供应商" hideTitle>
        <p>请连接设备</p>
      </SettingsSection>,
    );
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("min-h-8");
    expect(markup).toContain('aria-label="供应商"');
    expect(markup).toContain("请连接设备");
  });
});

describe("settings search targets", () => {
  it("does not persist destination styling in the rendered row", () => {
    const markup = renderToStaticMarkup(
      <SettingsSearchTargetProvider targetId="word-wrap">
        <SettingsRow id="word-wrap" title="Word wrap" description="Wrap long lines." />
        <SettingsRow id="time-format" title="Time format" description="Choose a clock." />
      </SettingsSearchTargetProvider>,
    );

    expect(markup).toContain('id="word-wrap" tabindex="-1"');
    expect(markup).not.toContain("data-settings-search-target");
    expect(markup).not.toContain("settings-search-target-pulse");
  });

  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
