import { assert, it } from "@effect/vitest";

import {
  listCompositionAgentTools,
  listCompositionToolDescriptors,
} from "./CompositionToolRegistry.ts";

it("为统一 Runtime Tool Plane 暴露稳定且无重复的 canonical capability 描述符", () => {
  const descriptors = listCompositionToolDescriptors();

  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.capabilityId),
    [
      "t3.workspace.read_file",
      "t3.workspace.write_file",
      "t3.workspace.list_files",
      "t3.workspace.search_files",
      "t3.workspace.search_contents",
      "t3.terminal.open",
      "t3.terminal.write",
      "t3.terminal.exec",
      "t3.terminal.snapshot",
      "t3.terminal.kill",
      "t3.terminal.close",
      "t3.ssh.status",
      "t3.ssh.exec",
      "t3.ssh.list_files",
      "t3.ssh.read_file",
      "t3.ssh.write_file",
      "t3.ssh.delete_file",
      "t3.git.status",
      "t3.git.diff",
      "t3.preview_status",
      "t3.preview_open",
      "t3.preview_navigate",
      "t3.preview_snapshot",
      "t3.preview_click",
      "t3.preview_type",
      "t3.preview_press",
      "t3.preview_scroll",
      "t3.preview_evaluate",
      "t3.preview_wait_for",
      "t3.ide.invoke",
      "t3.canvas.create",
      "t3.delegate_task",
    ],
  );
  assert.equal(
    new Set(descriptors.map((descriptor) => descriptor.capabilityId)).size,
    descriptors.length,
  );
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.capabilityId === "t3.terminal.write"),
    {
      capabilityId: "t3.terminal.write",
      kind: "tool",
      version: "1",
      status: "available",
      grants: { read: false, execute: true, mutate: false },
      approval: "on_first_use",
      source: "t3",
    },
  );
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.capabilityId === "t3.terminal.snapshot"),
    {
      capabilityId: "t3.terminal.snapshot",
      kind: "tool",
      version: "1",
      status: "available",
      grants: { read: true, execute: false, mutate: false },
      approval: "never",
      source: "t3",
    },
  );
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.capabilityId === "t3.preview_snapshot"),
    {
      capabilityId: "t3.preview_snapshot",
      kind: "tool",
      version: "1",
      status: "available",
      grants: { read: true, execute: false, mutate: false },
      approval: "never",
      source: "t3",
    },
  );
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.capabilityId === "t3.preview_click"),
    {
      capabilityId: "t3.preview_click",
      kind: "tool",
      version: "1",
      status: "available",
      grants: { read: false, execute: true, mutate: false },
      approval: "on_first_use",
      source: "t3",
    },
  );
});

it("canvas.create 的参数 schema 携带四种区块的真实字段名，且与解码行为一致", () => {
  const tool = listCompositionAgentTools().find(
    (candidate) => candidate.canonicalToolName === "canvas.create",
  );
  assert.isTrue(tool !== undefined, "canvas.create 必须在 BYOK 工具清单中");
  const parameters = tool!.parameters as {
    readonly type: string;
    readonly required: readonly string[];
    readonly properties: Record<string, { readonly items?: { readonly anyOf?: unknown } }>;
  };

  // 回归：手写 stub 曾把 blocks.items 写成 { type: "object" }，模型看不到
  // 字段名只能瞎猜（title/text、detail、lines），整轮校验失败。
  const json = JSON.stringify(parameters);
  for (const field of [
    "heading",
    "body",
    "label",
    "value",
    "path",
    "line",
    "note",
    "columns",
    "rows",
    "tone",
    "items",
    "status",
    "language",
    "code",
    "summary",
    "labels",
    "points",
    "slices",
    "segments",
    "unit",
    "lines",
  ]) {
    assert.include(json, `"${field}"`);
  }
  const blockItems = parameters.properties.blocks?.items ?? {};
  assert.isArray(blockItems.anyOf);
  assert.equal((blockItems.anyOf as unknown[]).length, 15);
  assert.deepEqual(parameters.required, ["cwd", "title", "blocks"]);

  // 生成器会把 optional 渲染成 anyOf [T, null]，但解码拒绝显式 null：
  // 宣传层必须剥掉 null 分支，否则模型按 schema 传 null 会再次校验失败。
  assert.notInclude(json, '"null"');
});
