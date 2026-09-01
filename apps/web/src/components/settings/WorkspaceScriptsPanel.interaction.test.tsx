import { EnvironmentId, type WorkspaceScriptRun } from "@codework/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const findStopButton = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findStopButton(child);
        if (found !== null) return found;
      }
      return null;
    }
    if (node === null || typeof node !== "object" || !("props" in node)) return null;

    const props = (
      node as {
        readonly props?: { readonly children?: unknown; readonly "data-testid"?: unknown };
      }
    ).props;
    if (
      typeof props?.["data-testid"] === "string" &&
      props["data-testid"].startsWith("workspace-script-stop-")
    ) {
      return node;
    }
    return findStopButton(props?.children);
  };

  return {
    environment: null as { readonly environmentId: EnvironmentId } | null,
    projects: [] as ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly environmentId: EnvironmentId;
      readonly scripts: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly command: string;
        readonly icon: "play";
        readonly runOnWorktreeCreate: boolean;
      }>;
    }>,
    threads: [] as ReadonlyArray<{
      readonly id: string;
      readonly projectId: string;
      readonly title: string;
      readonly worktreePath: string | null;
      readonly archivedAt: string | null;
      readonly environmentId: EnvironmentId;
    }>,
    runsAtom: Symbol("workspace-script-runs"),
    runsQuery: {
      data: null as { readonly runs: ReadonlyArray<WorkspaceScriptRun> } | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    startCommand: Symbol("start-workspace-script"),
    stopCommand: Symbol("stop-workspace-script"),
    startWorkspaceScript: vi.fn(),
    stopWorkspaceScript: vi.fn(),
    stopClick: null as (() => void) | null,
    findStopButton,
  };
});

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => mocks.projects,
  useThreadShells: () => mocks.threads,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => mocks.runsQuery,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    workspaceScriptRuns: () => mocks.runsAtom,
    startWorkspaceScript: mocks.startCommand,
    stopWorkspaceScript: mocks.stopCommand,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.stopCommand ? mocks.stopWorkspaceScript : mocks.startWorkspaceScript,
}));

vi.mock("../ui/button", () => ({
  Button: (props: { readonly onClick?: () => void; readonly "data-testid"?: string }) => {
    if (props["data-testid"]?.startsWith("workspace-script-stop-")) {
      mocks.stopClick = props.onClick ?? null;
    }
    return null;
  },
}));

vi.mock("./settingsLayout", () => ({
  SettingsSection: (props: { readonly children?: ReactNode }) =>
    mocks.findStopButton(props.children) as ReactNode,
}));

import { WorkspaceScriptsPanel } from "./WorkspaceScriptsPanel";

const RUN: WorkspaceScriptRun = {
  workspaceScriptRunId: "workspace-script-run:operation-1",
  idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
  scriptName: "启动开发服务",
  terminalId: "workspace-script-operation-1",
  cwd: "E:/workspace/project-1",
  worktreePath: null,
  status: "running",
  healthStatus: "unknown",
  healthCheckedAtUnixMs: null,
  healthDetail: null,
  ports: [],
  revision: 2,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 1_100,
  finishedAtUnixMs: null,
  exitCode: null,
  exitSignal: null,
  errorCode: null,
  errorDetail: null,
  compositionTaskId: null,
  compositionRunId: null,
  updatedAtUnixMs: 1_100,
};

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

const installTestDom = () => {
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
  return document;
};

const clickStop = async () => {
  const click = mocks.stopClick;
  expect(click).not.toBeNull();
  await act(async () => {
    click?.();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("WorkspaceScriptsPanel stop interaction", () => {
  beforeEach(() => {
    const environmentId = EnvironmentId.make("environment-1");
    mocks.environment = { environmentId };
    mocks.projects = [
      {
        id: "project-1",
        title: "Code Work",
        workspaceRoot: "E:/workspace/project-1",
        environmentId,
        scripts: [
          {
            id: "serve",
            name: "启动开发服务",
            command: "pnpm dev",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      },
    ];
    mocks.threads = [
      {
        id: "thread-1",
        projectId: "project-1",
        title: "Workspace Script UI",
        worktreePath: null,
        archivedAt: null,
        environmentId,
      },
    ];
    mocks.runsQuery.data = { runs: [RUN] };
    mocks.runsQuery.error = null;
    mocks.runsQuery.isPending = false;
    mocks.runsQuery.refresh.mockReset();
    mocks.startWorkspaceScript.mockReset();
    mocks.stopWorkspaceScript.mockReset();
    mocks.stopWorkspaceScript.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("stop failed"))),
    );
    mocks.stopClick = null;
  });

  it("revision 更新和组件重挂载都复用 Run 绑定的 stop operation", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    let root = createRoot(document.createElement("div") as unknown as Element);

    try {
      await act(() => root.render(<WorkspaceScriptsPanel />));
      await clickStop();

      mocks.runsQuery.data = {
        runs: [{ ...RUN, revision: 4, updatedAtUnixMs: 1_200 }],
      };
      await act(() => root.render(<WorkspaceScriptsPanel />));
      await clickStop();

      await act(() => root.unmount());
      mocks.stopClick = null;
      root = createRoot(document.createElement("div") as unknown as Element);
      await act(() => root.render(<WorkspaceScriptsPanel />));
      await clickStop();

      expect(mocks.stopWorkspaceScript).toHaveBeenCalledTimes(3);
      expect(
        mocks.stopWorkspaceScript.mock.calls.map(([request]) => request.input.operationId),
      ).toEqual([
        "workspace-script-stop:workspace-script-run:operation-1",
        "workspace-script-stop:workspace-script-run:operation-1",
        "workspace-script-stop:workspace-script-run:operation-1",
      ]);
      expect(
        mocks.stopWorkspaceScript.mock.calls.map(([request]) => request.input.expectedRevision),
      ).toEqual([2, 4, 4]);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
