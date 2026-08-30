import type { CompositionSquadRunBoardNode } from "@codework/client-runtime/composition/squad-run-board";
import type { CompositionTaskEvent } from "@codework/contracts";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: ({ children }: { readonly children: ReactNode }) => <button>{children}</button>,
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

import { SquadRunBoardNodeCard } from "./SquadRunBoardNodeCard";

const node: CompositionSquadRunBoardNode = {
  nodeId: "implement",
  taskId: "task-worker",
  runId: "run-worker",
  agentId: "agent-worker",
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
      attempt: 2,
      capabilityGrantIds: [],
      resultSummary: "已完成核心实现。",
    },
  },
};

const events: ReadonlyArray<CompositionTaskEvent> = [
  {
    taskId: "task-worker",
    runId: "run-worker",
    agentId: "agent-worker",
    status: "running",
    sequence: 3,
    eventType: "progress",
    summary: "正在运行聚焦测试。",
    progress: 70,
  },
];

describe("SquadRunBoardNodeCard", () => {
  it("展示节点最新 Run 身份、结果摘要和已加载的持久化事件", () => {
    const html = renderToStaticMarkup(
      <SquadRunBoardNodeCard
        node={node}
        eventsExpanded
        events={events}
        eventsPending={false}
        eventsError={null}
        onToggleEvents={vi.fn()}
      />,
    );

    expect(html).toContain("implement");
    expect(html).toContain("task-worker");
    expect(html).toContain("run-worker");
    expect(html).toContain("agent-worker");
    expect(html).toContain("running");
    expect(html).toContain("已完成核心实现。");
    expect(html).toContain("正在运行聚焦测试。");
    expect(html).toContain("#3");
    expect(html).toContain("controlCenter.taskEventProgress");
  });
});
