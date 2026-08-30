import type { CompositionSquadRunBoardNode } from "@codework/client-runtime/composition/squad-run-board";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const pressHandlers: Array<() => void> = [];

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress,
  }: {
    readonly children: ReactNode;
    readonly onPress: () => void;
  }) => {
    pressHandlers.push(onPress);
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

import { SquadRunBoardCancelAction } from "./SquadRunBoardCancelAction";

const node = {
  nodeId: "implement",
  taskId: "task-worker",
  snapshot: {
    task: {
      taskId: "task-worker",
      projectId: "project-1",
      assigneeKind: "agent",
      assigneeId: "agent-worker",
      mode: "parallel",
      status: "running",
      promptDigest: "prompt-digest",
      dependsOnTaskIds: [],
      createdAtUnixMs: 100,
      updatedAtUnixMs: 200,
    },
    latestRun: {
      runId: "run-worker",
      taskId: "task-worker",
      agentId: "agent-worker",
      runtimeId: "runtime-1",
      status: "running",
      attempt: 1,
      capabilityGrantIds: [],
    },
  },
} satisfies CompositionSquadRunBoardNode;

describe("SquadRunBoardCancelAction", () => {
  it("仅渲染取消命令并向命令层发出节点意图", () => {
    pressHandlers.length = 0;
    const onCancel = vi.fn();
    const html = renderToStaticMarkup(
      <SquadRunBoardCancelAction node={node} disabled={false} onCancel={onCancel} />,
    );

    expect(html).toContain("squadExecutionHistory.cancelNode");
    pressHandlers[0]?.();
    expect(onCancel).toHaveBeenCalledWith(node);
  });
});
