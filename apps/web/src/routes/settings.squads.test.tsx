import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock("../components/settings/CompositionSquadPanel", () => ({
  CompositionSquadPanel: () => <div data-testid="squad-builder" />,
}));

vi.mock("../components/settings/CompositionSquadRunPanel", () => ({
  CompositionSquadRunPanel: () => <div data-testid="squad-run-board" />,
}));

vi.mock("../components/settings/CompositionControlCenterPanel", () => ({
  CompositionControlCenterPanel: () => <div data-testid="squad-human-inbox" />,
}));

vi.mock("../components/settings/TeamRuntimeSettingsPanel", () => ({
  TeamRuntimeSettingsPanel: () => <div data-testid="team-runtime" />,
}));

vi.mock("../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { readonly children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

import { SettingsSquadsPage } from "./settings.squads";

describe("SettingsSquadsPage", () => {
  it("按团队运行时、编队配置、协同运行、人工待办顺序挂载完整控制面", () => {
    const html = renderToStaticMarkup(<SettingsSquadsPage />);

    const runtimeIndex = html.indexOf('data-testid="team-runtime"');
    const builderIndex = html.indexOf('data-testid="squad-builder"');
    const runBoardIndex = html.indexOf('data-testid="squad-run-board"');
    const inboxIndex = html.indexOf('data-testid="squad-human-inbox"');

    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(builderIndex).toBeGreaterThan(runtimeIndex);
    expect(runBoardIndex).toBeGreaterThan(builderIndex);
    expect(inboxIndex).toBeGreaterThan(runBoardIndex);
  });
});
