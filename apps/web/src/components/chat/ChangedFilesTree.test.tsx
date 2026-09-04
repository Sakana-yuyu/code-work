import { setCurrentLanguage } from "~/i18n/runtime";

setCurrentLanguage("en");

import { TurnId } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChangedFilesCard, ChangedFilesTree } from "./ChangedFilesTree";
import { t } from "~/i18n";

describe("ChangedFilesCard", () => {
  it("keeps its compact header sticky while preserving singular labels", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }]}
        expanded
        showCompactPreview={false}
        allDirectoriesExpanded
        resolvedTheme="light"
        onExpandedChange={() => {}}
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain('data-changed-files-state="expanded"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain('class="group flex min-w-0 flex-1 items-center rounded-xl');
    expect(markup).not.toMatch(/class="group flex min-w-0 flex-1 items-center[^"]*overflow-hidden/);
    expect(markup).toContain('class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"');
    expect(markup).toContain('class="flex shrink-0 items-center gap-1 whitespace-nowrap');
    expect(markup).toContain('class="ml-1 hidden min-w-0 flex-1 truncate');
    expect(markup).toContain("@[24rem]/changed-files:inline");
    expect(markup).not.toContain("sm:inline");
    expect(markup).toContain('class="flex shrink-0 items-center gap-1.5 pr-1"');
    expect(markup).toContain("!size-[22px]");
    expect(markup).toContain("size-3");
    expect(markup).toContain(`aria-label="${t("collapseAllFolders")}"`);
    expect(markup).toContain(`aria-label="${t("openDiff")}"`);
    expect(markup).toContain('role="group" aria-label="2 additions, 1 deletions"');
    expect(markup).toContain(`1 ${t("changedFile")}`);
    expect(markup).not.toContain("1 changed files");
  });

  it("renders a scope and representative-file preview for a large latest change", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[
          { path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 },
          { path: "apps/web/src/App.test.tsx", kind: "modified", additions: 30, deletions: 2 },
          {
            path: "packages/shared/src/git.ts",
            kind: "modified",
            additions: 15,
            deletions: 4,
          },
          { path: "README.md", kind: "modified", additions: 3, deletions: 0 },
        ]}
        expanded={false}
        showCompactPreview
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onExpandedChange={() => {}}
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain('data-changed-files-state="preview"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("apps");
    expect(markup).toContain("2 files");
    expect(markup).toContain("packages");
    expect(markup).toContain("root");
    expect(markup).toContain("App.tsx");
    expect(markup).toContain("git.ts");
    expect(markup).toContain("README.md");
    expect(markup).toContain("Show all 4 files");
    expect(markup).not.toContain("App.test.tsx");
  });

  it("keeps older collapsed changes to a one-line receipt", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[{ path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 }]}
        expanded={false}
        showCompactPreview={false}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onExpandedChange={() => {}}
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain('data-changed-files-state="collapsed"');
    expect(markup).toContain(`1 ${t("changedFile")}`);
    expect(markup).not.toContain("Show all");
    expect(markup).not.toContain("App.tsx");
  });

  it("opens a generated Canvas from the changed-file card", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[
          {
            path: ".codework/canvases/thread-one/Project-analysis.canvas.json",
            kind: "added",
            additions: 1,
            deletions: 0,
          },
        ]}
        expanded={false}
        showCompactPreview
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onExpandedChange={() => {}}
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
        onOpenCanvas={() => {}}
      />,
    );

    expect(markup).toContain(`aria-label="${t("canvas.open")}"`);
    expect(markup).toContain(t("canvas.open"));
    expect(markup).toContain("Project analysis");
    expect(markup).not.toContain(`aria-label="${t("openDiff")}"`);
  });

  it("opens a known Canvas even when its ignored artifact is absent from the file list", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        turnId={TurnId.make("turn-with-known-canvas")}
        files={[{ path: "src/server.ts", kind: "modified", additions: 2, deletions: 0 }]}
        expanded={false}
        showCompactPreview={false}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onExpandedChange={() => {}}
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
        canvas={{
          canvasId: "project-analysis",
          title: "Project analysis",
          relativePath: ".codework/canvases/turn-one/Project-analysis.canvas.json",
        }}
        onOpenCanvas={() => {}}
      />,
    );

    expect(markup).toContain(`aria-label="${t("canvas.open")}"`);
    expect(markup).not.toContain(`aria-label="${t("openDiff")}"`);
  });
});

describe("ChangedFilesTree", () => {
  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src"],
      hiddenLabels: ["index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: ["apps/server/src"],
      hiddenLabels: ["git", "provider", "GitCore.ts", "CodexAdapter.ts"],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: ["README.md", "packages"],
      hiddenLabels: ["shared/src", "contracts/src", "git.ts", "orchestration.ts"],
    },
  ])(
    "renders $name collapsed on the first render when collapse-all is active",
    ({ files, visibleLabels, hiddenLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          turnId={TurnId.make("turn-1")}
          files={files}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
      for (const label of hiddenLabels) {
        expect(markup).not.toContain(label);
      }
    },
  );

  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src", "index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: [
        "apps/server/src",
        "git/Layers",
        "provider/Layers",
        "GitCore.ts",
        "CodexAdapter.ts",
      ],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: [
        "README.md",
        "packages",
        "shared/src",
        "contracts/src",
        "git.ts",
        "orchestration.ts",
      ],
    },
  ])(
    "renders $name expanded on the first render when expand-all is active",
    ({ files, visibleLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          turnId={TurnId.make("turn-1")}
          files={files}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
    },
  );
});
