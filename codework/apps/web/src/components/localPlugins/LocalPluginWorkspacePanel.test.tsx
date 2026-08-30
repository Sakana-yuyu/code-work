import type { LocalPluginManifest } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LocalPluginFailureJournal } from "~/localPlugins/localPluginFailureJournal";
import { LocalPluginLifecycle } from "~/localPlugins/localPluginLifecycle";
import { LocalPluginRegistry } from "~/localPlugins/localPluginRegistry";
import type { LocalPluginRuntime } from "~/localPlugins/localPluginRuntime";
import type { LocalPluginStorage } from "~/localPlugins/localPluginStorage";
import { localPluginWorkspacePanelSurface } from "~/localPlugins/adapters/localPluginWorkspacePanelSurface";
import { LocalPluginWorkspacePanel } from "./LocalPluginWorkspacePanel";

class MemoryStorage implements LocalPluginStorage {
  value: string | null = null;
  read(): string | null {
    return this.value;
  }
  write(value: string): void {
    this.value = value;
  }
}

const manifest: LocalPluginManifest = {
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id: "acme.workspace",
  name: "工作区助手",
  version: "1.0.0",
  permissions: ["workspace.read"],
  contributions: {
    workspacePanels: [
      {
        id: "overview",
        title: "工作区概览",
        description: "{{workspace.name}}",
        sections: [{ heading: "根目录", body: "{{workspace.root}}" }],
        context: ["workspace.name", "workspace.root"],
      },
    ],
  },
};

function createRuntime(): LocalPluginRuntime {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage: new MemoryStorage(),
    now: () => 1,
  });
  return { failures, lifecycle, registry };
}

describe("LocalPluginWorkspacePanel", () => {
  it("只以文本渲染声明式面板，不解释插件提供的 HTML", () => {
    const runtime = createRuntime();
    runtime.lifecycle.install({
      ...manifest,
      contributions: {
        workspacePanels: [
          {
            ...manifest.contributions.workspacePanels![0]!,
            sections: [{ heading: "根目录", body: "<script>alert(1)</script> {{workspace.root}}" }],
          },
        ],
      },
    });

    const html = renderToStaticMarkup(
      <LocalPluginWorkspacePanel
        runtime={runtime}
        surface={localPluginWorkspacePanelSurface("acme.workspace", "overview")}
        workspace={{ name: "Code Work", root: "C:\\workspace\\code-work" }}
      />,
    );

    expect(html).toContain("工作区概览");
    expect(html).toContain("Code Work");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("为失效 surface 渲染局部不可用状态", () => {
    const html = renderToStaticMarkup(
      <LocalPluginWorkspacePanel
        runtime={createRuntime()}
        surface={localPluginWorkspacePanelSurface("acme.workspace", "overview")}
        workspace={null}
      />,
    );

    expect(html).toContain('data-local-plugin-panel-state="unavailable"');
  });
});
