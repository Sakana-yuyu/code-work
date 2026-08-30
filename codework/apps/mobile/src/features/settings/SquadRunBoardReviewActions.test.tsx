import type { CompositionSquadRunBoardNode } from "@codework/client-runtime/composition/squad-run-board";
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
  t: (key: string) => key,
}));

import { SquadRunBoardReviewActions } from "./SquadRunBoardReviewActions";

const node = {
  nodeId: "leader-finalize",
  taskId: "task-review",
  snapshot: {
    task: {
      taskId: "task-review",
      projectId: "project-1",
      assigneeKind: "agent",
      assigneeId: "agent-leader",
      mode: "review",
      status: "in_review",
      promptDigest: "prompt-digest",
      dependsOnTaskIds: [],
      createdAtUnixMs: 100,
      updatedAtUnixMs: 200,
    },
    latestRun: {
      runId: "run-review",
      taskId: "task-review",
      agentId: "agent-leader",
      runtimeId: "runtime-1",
      status: "in_review",
      attempt: 1,
      capabilityGrantIds: [],
    },
  },
} satisfies CompositionSquadRunBoardNode;

describe("SquadRunBoardReviewActions", () => {
  it("只渲染通过与驳回命令，并向路由发出决策意图", () => {
    pressHandlers.clear();
    const onReview = vi.fn();
    const html = renderToStaticMarkup(
      <SquadRunBoardReviewActions node={node} disabled={false} onReview={onReview} />,
    );

    expect(html).toContain("squadExecutionHistory.approveNode");
    expect(html).toContain("squadExecutionHistory.rejectNode");

    pressHandlers.get("squadExecutionHistory.approveNode")?.();
    pressHandlers.get("squadExecutionHistory.rejectNode")?.();

    expect(onReview).toHaveBeenNthCalledWith(1, node, "approve");
    expect(onReview).toHaveBeenNthCalledWith(2, node, "reject");
  });
});
