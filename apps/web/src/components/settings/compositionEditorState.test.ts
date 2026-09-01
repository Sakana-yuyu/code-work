import { describe, expect, it } from "vite-plus/test";

import {
  createCompositionEditorState,
  markCompositionEditorItemDeleted,
  selectCompositionEditorItem,
  startCompositionEditorCreate,
  syncCompositionEditorState,
} from "./compositionEditorState";

describe("composition editor state", () => {
  it("首次查询从 pending 变为非空数据时自动选择首项", () => {
    const pending = createCompositionEditorState({
      environmentId: "environment-1",
      isPending: true,
      itemIds: [],
    });

    expect(
      syncCompositionEditorState(pending, {
        environmentId: "environment-1",
        isPending: false,
        itemIds: ["automation-1", "automation-2"],
      }),
    ).toEqual({
      environmentId: "environment-1",
      mode: "selected",
      selectedItemId: "automation-1",
    });
  });

  it("用户明确新建后，数据刷新不会抢走草稿", () => {
    const creating = startCompositionEditorCreate({
      environmentId: "environment-1",
      mode: "selected",
      selectedItemId: "automation-1",
    });

    expect(
      syncCompositionEditorState(creating, {
        environmentId: "environment-1",
        isPending: false,
        itemIds: ["automation-1", "automation-2"],
      }),
    ).toEqual(creating);
  });

  it("切换环境后等待新环境首次查询，再选择它的首项", () => {
    const selected = selectCompositionEditorItem(
      createCompositionEditorState({
        environmentId: "environment-1",
        isPending: false,
        itemIds: ["automation-1"],
      }),
      "automation-1",
    );

    const waitingForEnvironment = syncCompositionEditorState(selected, {
      environmentId: "environment-2",
      isPending: true,
      itemIds: [],
    });

    expect(waitingForEnvironment).toEqual({
      environmentId: "environment-2",
      mode: "loading",
      selectedItemId: null,
    });
    expect(
      syncCompositionEditorState(waitingForEnvironment, {
        environmentId: "environment-2",
        isPending: false,
        itemIds: ["automation-2"],
      }),
    ).toEqual({
      environmentId: "environment-2",
      mode: "selected",
      selectedItemId: "automation-2",
    });
  });

  it("选中记录删除后稳定回退到剩余首项", () => {
    const deleting = markCompositionEditorItemDeleted(
      selectCompositionEditorItem(
        createCompositionEditorState({
          environmentId: "environment-1",
          isPending: false,
          itemIds: ["automation-1", "automation-2"],
        }),
        "automation-1",
      ),
      "automation-1",
    );

    expect(
      syncCompositionEditorState(deleting, {
        environmentId: "environment-1",
        isPending: false,
        itemIds: ["automation-1", "automation-2"],
      }),
    ).toEqual({
      environmentId: "environment-1",
      mode: "selected",
      selectedItemId: "automation-2",
    });
  });
});
