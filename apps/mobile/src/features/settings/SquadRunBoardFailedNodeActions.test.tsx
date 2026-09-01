import type {
  CompositionSquadNodeActionContext,
  CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const pressHandlers = new Map<string, () => void>();

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    readonly accessibilityLabel: string;
    readonly children: ReactNode;
    readonly onPress: () => void;
  }) => {
    pressHandlers.set(accessibilityLabel, onPress);
    return <button>{children}</button>;
  },
  View: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../../i18n", () => ({
  t: (key: string, params?: Readonly<Record<string, string | number>>) => {
    if (params === undefined) return key;
    return Object.entries(params).reduce(
      (message, [name, value]) => message.replace(`{{${name}}}`, String(value)),
      key,
    );
  },
}));

import { SquadRunBoardFailedNodeActions } from "./SquadRunBoardFailedNodeActions";

const node = {
  nodeId: "implement",
  taskId: "task-worker",
  runId: "run-worker",
  snapshot: {
    task: {
      taskId: "task-worker",
      projectId: "project-1",
      assigneeKind: "agent",
      assigneeId: "agent-worker",
      mode: "parallel",
      status: "failed",
      promptDigest: "prompt-digest",
      dependsOnTaskIds: [],
      createdAtUnixMs: 100,
      updatedAtUnixMs: 200,
      finishedAtUnixMs: 200,
    },
    latestRun: {
      runId: "run-worker",
      taskId: "task-worker",
      agentId: "agent-worker",
      runtimeId: "runtime-1",
      status: "failed",
      attempt: 1,
      capabilityGrantIds: [],
      finishedAtUnixMs: 200,
      failureCode: "worker_failed",
    },
  },
} satisfies CompositionSquadRunBoardNode;

const context = {
  retryCapabilityIds: ["shell", "git"],
  reassignTargets: [{ agentId: "agent-backup", capabilityIds: ["shell"] }],
} satisfies CompositionSquadNodeActionContext;

describe("SquadRunBoardFailedNodeActions", () => {
  it("渲染真实重试与成员重派入口，并向路由发出明确意图", () => {
    pressHandlers.clear();
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      <SquadRunBoardFailedNodeActions
        node={node}
        context={context}
        disabled={false}
        onRetry={onRetry}
      />,
    );

    expect(html).toContain("squadExecutionHistory.retryNode");
    expect(html).toContain("agent-backup");

    pressHandlers.get("squadExecutionHistory.retryNode")?.();
    pressHandlers.get("squadExecutionHistory.reassignNode")?.();

    expect(onRetry).toHaveBeenNthCalledWith(1, node, ["shell", "git"]);
    expect(onRetry).toHaveBeenNthCalledWith(2, node, ["shell"], "agent-backup");
  });
});
