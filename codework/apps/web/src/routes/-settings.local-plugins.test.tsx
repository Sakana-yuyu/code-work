import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock("../components/settings/LocalPluginsSettings", () => ({
  LocalPluginsSettings: () => <section data-testid="local-plugins-settings" />,
}));

vi.mock("../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { readonly children: React.ReactNode }) => (
    <main data-testid="settings-page-container">{children}</main>
  ),
}));

import { SettingsLocalPluginsPage } from "./settings.local-plugins";

describe("SettingsLocalPluginsPage", () => {
  it("在独立设置页容器中挂载本地插件管理入口", () => {
    const html = renderToStaticMarkup(<SettingsLocalPluginsPage />);

    expect(html).toContain(
      '<main data-testid="settings-page-container"><section data-testid="local-plugins-settings"></section></main>',
    );
  });
});
