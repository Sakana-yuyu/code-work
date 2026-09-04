import type { CompositionCapabilityDescriptor } from "@codework/contracts";

import type { ByokAgentTool } from "./ByokAgentLoop.ts";

const descriptors = [
  {
    capabilityId: "t3.workspace.read_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.workspace.write_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: false, mutate: true },
    approval: "every_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.open",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.write",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.exec",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.snapshot",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.kill",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.terminal.close",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.git.status",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.git.diff",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_status",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_open",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_navigate",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_snapshot",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_click",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_type",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_press",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_scroll",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_evaluate",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.preview_wait_for",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.ide.invoke",
    kind: "tool",
    version: "1",
    status: "degraded",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    // Canvas 只写入 Code Work 自己管理的结构化分析文档，不直接执行模型生成的代码。
    capabilityId: "t3.canvas.create",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: false, mutate: true },
    approval: "never",
    source: "t3",
  },
  {
    // Model-invoked delegation (original cursor-byok Task-tool parity). The
    // handler only exists when the BYOK delegation service is layered in; the
    // delegated worker is an external CLI with no access to this ToolBroker,
    // so delegated tasks cannot nest further delegation.
    // Approval must stay "never": approval-required tools are hard-denied
    // inside the BYOK agent loop, which has no interactive approval path.
    capabilityId: "t3.delegate_task",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "never",
    source: "t3",
  },
] satisfies ReadonlyArray<CompositionCapabilityDescriptor>;

const agentToolSignatures: ReadonlyMap<
  string,
  { readonly description: string; readonly parameters: Record<string, unknown> }
> = new Map([
  [
    "canvas.create",
    {
      description:
        "仅当用户需要独立的分析交付物时创建可保存、信息密度高且易扫读的结构化 Canvas（架构评审、审计、代码地图、数据分析、对比、流程和风险）；定向实现、调试或其他明确交付物不要使用。优先提供简洁摘要、在有证据时提供 2-4 个关键统计、关系/流程与风险章节、带行号的文件定位，以及用于有效对比的紧凑表格。按信息层级组织区块；每个区块都必须来自已检查的项目证据，省略空内容和推测内容；没有真实内容时不要调用工具。表格必须使用具体且自描述的列名，并在适用时标明单位、来源或时间范围；只接受非空 section、stat、file、table，不要自行创建文件或生成可执行 UI 代码。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          canvasId: { type: "string", description: "可选的稳定 ID；相同 ID 会更新同一个 Canvas。" },
          title: { type: "string", description: "Canvas 标题。" },
          summary: { type: "string", description: "可选的分析摘要。" },
          blocks: {
            type: "array",
            description:
              "按信息层级组织的非空内容块：优先关键 stat，再放关系/流程/风险 section，使用带行号的 file 定位和必要的 table 对比；表格列名要具体、自描述，并在适用时标明单位、来源或时间范围；不要填充空区块或未经证实的内容。支持 section、stat、file、table。",
            items: { type: "object" },
          },
        },
        required: ["cwd", "title", "blocks"],
      },
    },
  ],
  [
    "workspace.read_file",
    {
      description: "读取当前工作区中的 UTF-8 文本文件。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          relativePath: { type: "string", description: "相对工作区根目录的文件路径。" },
        },
        required: ["cwd", "relativePath"],
      },
    },
  ],
  [
    "git.status",
    {
      description: "读取当前工作区的 Git 分支、跟踪关系和工作树状态。",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string", description: "当前工作区根目录的绝对路径。" } },
        required: ["cwd"],
      },
    },
  ],
  [
    "git.diff",
    {
      description: "读取当前工作区的 Git 审查差异。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          baseRef: { type: "string", description: "可选的对比基准引用。" },
          ignoreWhitespace: { type: "boolean", description: "是否忽略空白差异。" },
        },
        required: ["cwd"],
      },
    },
  ],
  [
    "delegate_task",
    {
      description:
        "将独立子任务委派给此实例配置的执行器，并等待任务进入终态。task 必须包含执行所需的完整上下文。",
      parameters: {
        type: "object",
        properties: { task: { type: "string" }, subagentType: { type: "string" } },
        required: ["task"],
      },
    },
  ],
]);

export const listCompositionToolDescriptors = (): CompositionCapabilityDescriptor[] =>
  descriptors.map((descriptor) => ({
    ...descriptor,
    grants: { ...descriptor.grants },
  }));

export const listCompositionAgentTools = (): ReadonlyArray<ByokAgentTool> =>
  listCompositionToolDescriptors().map((descriptor) => {
    const canonicalToolName = descriptor.capabilityId.slice("t3.".length);
    const signature = agentToolSignatures.get(canonicalToolName);
    return {
      canonicalToolName,
      description: signature?.description ?? `${descriptor.capabilityId} (${descriptor.status})`,
      parameters: signature?.parameters ?? { type: "object" },
    };
  });

export const compositionToolCapabilityId = (canonicalToolName: string): string =>
  `t3.${canonicalToolName}`;
