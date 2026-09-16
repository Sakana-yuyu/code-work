import { type CompositionCapabilityDescriptor, CanvasCreateInput } from "@codework/contracts";
import { Tool } from "effect/unstable/ai";

import type { ByokAgentTool } from "./ByokAgentLoop.ts";

type JsonSchemaish = Record<string, unknown>;

/**
 * The schema generator renders optionals as `anyOf: [T, null]`, but the
 * decoders reject explicit nulls. Advertise just T (the field stays optional
 * via `required`) so models omit the field instead of sending null.
 */
const withoutNullSchemaAlternatives = (schema: JsonSchemaish): JsonSchemaish => {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const kept = anyOf.filter(
      (member) =>
        !(
          member !== null &&
          typeof member === "object" &&
          (member as JsonSchemaish).type === "null"
        ),
    );
    const [first] = kept;
    if (kept.length === 1 && first !== null && typeof first === "object") {
      return withoutNullSchemaAlternatives(first as JsonSchemaish);
    }
    return {
      ...schema,
      anyOf: kept.map((member) => withoutNullSchemaAlternatives(member as JsonSchemaish)),
    };
  }
  const next: JsonSchemaish = { ...schema };
  for (const key of ["items", "additionalProperties"] as const) {
    const value = next[key];
    if (value !== null && typeof value === "object") {
      next[key] = withoutNullSchemaAlternatives(value as JsonSchemaish);
    }
  }
  const properties = next.properties;
  if (properties !== null && typeof properties === "object") {
    next.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>).map(([name, member]) => [
        name,
        member !== null && typeof member === "object"
          ? withoutNullSchemaAlternatives(member as JsonSchemaish)
          : member,
      ]),
    );
  }
  return next;
};

// 从契约 schema 生成，保证宣传给模型的字段名与 ToolBroker 的真实解码永远一致；
// 手写一份曾在缺字段定义时让模型整轮猜错字段、反复校验失败。
const canvasCreateParameters = withoutNullSchemaAlternatives(
  Tool.getJsonSchemaFromSchema(CanvasCreateInput) as unknown as JsonSchemaish,
);

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
    capabilityId: "t3.workspace.list_files",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.workspace.search_files",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.workspace.search_contents",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
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
    capabilityId: "t3.ssh.status",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.ssh.exec",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.ssh.list_files",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.ssh.read_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.ssh.write_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: false, mutate: true },
    approval: "every_use",
    source: "t3",
  },
  {
    capabilityId: "t3.ssh.delete_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: false, mutate: true },
    approval: "every_use",
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
        "创建可保存、信息密度高且易扫读的结构化 Canvas（用户可随时在右侧面板打开的独立分析视图）。当任务产出独立的分析型交付物时必须用它承载：架构评审、审计、代码地图、量化分析、数据密集结论、对比、流程、时间线和风险；数据本身就是交付物时优先用它，而不是把结论堆进 markdown 表格或长代码块。量化数据优先用 chart_bar/chart_line/chart_pie 或 table 呈现，风险用 callout 突出，行动项用 todo。允许多次调用：先基于已有证据创建，随任务推进用相同 canvasId 更新同一个 Canvas，也可为不同主题创建多个 Canvas。必须通过工具调用提交画布：把画布 JSON 写进回复正文不会生成画布面板。区块字段名和长度上限必须严格按参数 schema：section=heading/body，stat=label/value，file=path/line/note，table=columns/rows，callout=tone/title/body，todo=title/items(text/status)，code=language/code，divider 无字段，badges=items(label/tone)，usage=label/segments(label/value/tone)，chart_bar=title/unit/points(label/value)，chart_line=title/labels/series(label/points)，chart_pie=title/slices(label/value)，diff=path/lines(type/text)，disclose=summary/body；title ≤160 字符，正文类字段 ≤12000 字符，blocks 1-32 个；可选字段请省略而不要传 null。按信息层级组织区块，所有结论来自已检查的证据，省略空内容和推测内容，没有真实内容时不要调用。",
      parameters: canvasCreateParameters,
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
    "workspace.write_file",
    {
      description: "在当前工作区创建或更新文件，contents 为完整文件内容。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          relativePath: { type: "string", description: "相对工作区根目录的文件路径。" },
          contents: { type: "string", description: "要写入的完整文本内容。" },
        },
        required: ["cwd", "relativePath", "contents"],
      },
    },
  ],
  [
    "workspace.list_files",
    {
      description:
        "列出当前工作区的文件与目录（相对路径，按路径排序，有数量上限）。先了解项目结构时使用；找具体文件改用 workspace.search_files。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
        },
        required: ["cwd"],
      },
    },
  ],
  [
    "workspace.search_files",
    {
      description:
        "按名称模糊匹配当前工作区的文件或目录，返回相对路径列表。已知部分文件名或扩展名时使用，不要凭记忆猜测路径。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          query: { type: "string", description: "名称模糊匹配关键词。" },
          limit: { type: "number", description: "返回上限，默认 50，最大 200。" },
          kind: { type: "string", description: "可选：file 或 directory。" },
        },
        required: ["cwd", "query"],
      },
    },
  ],
  [
    "workspace.search_contents",
    {
      description:
        "在当前工作区文件内容中搜索文本，返回文件路径、行号和所在行。定位代码实现时优先使用，避免逐个读取文件。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          query: { type: "string", description: "搜索文本；useRegex 为 true 时是正则表达式。" },
          limit: { type: "number", description: "返回上限，默认 100，最大 500。" },
          caseSensitive: { type: "boolean", description: "是否区分大小写，默认 false。" },
          wholeWord: { type: "boolean", description: "是否全词匹配，默认 false。" },
          useRegex: { type: "boolean", description: "是否按正则表达式搜索，默认 false。" },
        },
        required: ["cwd", "query"],
      },
    },
  ],
  [
    "terminal.exec",
    {
      description:
        "在工作区终端启动程序，返回当前快照；后续用 terminal.snapshot 读取输出和退出状态。command 是程序名或绝对路径，参数单独传 args。PowerShell 脚本使用 command=powershell.exe、args=[-NoProfile,-Command,脚本内容]。",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "当前工作区根目录的绝对路径。" },
          terminalId: {
            type: "string",
            description: "本轮使用的终端标识，后续查看和停止时使用同一标识。",
          },
          command: {
            type: "string",
            description: "可执行程序名或绝对路径，不是包含参数的整行命令。",
          },
          args: { type: "array", items: { type: "string" }, description: "程序参数列表。" },
        },
        required: ["cwd", "terminalId", "command"],
      },
    },
  ],
  [
    "terminal.snapshot",
    {
      description: "读取本轮终端的最新输出和退出状态。",
      parameters: {
        type: "object",
        properties: { terminalId: { type: "string" } },
        required: ["terminalId"],
      },
    },
  ],
  [
    "terminal.kill",
    {
      description: "停止本轮指定终端中运行的进程。",
      parameters: {
        type: "object",
        properties: { terminalId: { type: "string" } },
        required: ["terminalId"],
      },
    },
  ],
  [
    "terminal.close",
    {
      description: "关闭本轮指定终端并保留已有输出记录。",
      parameters: {
        type: "object",
        properties: { terminalId: { type: "string" } },
        required: ["terminalId"],
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
    "ssh.status",
    {
      description:
        "读取已登记远程服务器的在线状态与资源占用（操作系统、运行时长、负载、CPU、内存、磁盘）。server 填服务器名称或 id；填错时返回的错误会携带可用服务器列表。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "远程服务器名称（label）或 id。" },
        },
        required: ["server"],
      },
    },
  ],
  [
    "ssh.exec",
    {
      description:
        "在已登记的远程服务器上执行一条 shell 命令并等待结束，返回退出码、stdout 和 stderr。适合运行维护命令、查日志、装软件等服务器管理操作。默认 30 秒超时，最长 120 秒。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "远程服务器名称（label）或 id。" },
          command: { type: "string", description: "要执行的 shell 命令。" },
          timeoutMs: { type: "number", description: "超时毫秒数，默认 30000，最大 120000。" },
        },
        required: ["server", "command"],
      },
    },
  ],
  [
    "ssh.list_files",
    {
      description:
        "列出远程服务器上某个目录的内容，返回名称、路径、类型、大小和修改时间。path 必须是绝对路径。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "远程服务器名称（label）或 id。" },
          path: { type: "string", description: "远程绝对路径，如 /var/log。" },
        },
        required: ["server", "path"],
      },
    },
  ],
  [
    "ssh.read_file",
    {
      description:
        "读取远程服务器上的 UTF-8 文本文件，上限 1MB（超出会截断并标记）；二进制文件会被拒绝。path 必须是绝对路径。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "远程服务器名称（label）或 id。" },
          path: { type: "string", description: "远程文件绝对路径。" },
        },
        required: ["server", "path"],
      },
    },
  ],
  [
    "ssh.write_file",
    {
      description:
        "在远程服务器上创建或覆盖文本文件，content 为完整文件内容（上限 4MB）。父目录不存在时自动逐级创建。path 必须是绝对路径。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "远程服务器名称（label）或 id。" },
          path: { type: "string", description: "远程文件绝对路径。" },
          content: { type: "string", description: "要写入的完整文本内容。" },
        },
        required: ["server", "path", "content"],
      },
    },
  ],
  [
    "ssh.delete_file",
    {
      description:
        "删除远程服务器上的文件或目录，不可恢复。删除目录必须显式 recursive=true（有条目数上限保护），拒绝删除根目录。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "远程服务器名称（label）或 id。" },
          path: { type: "string", description: "要删除的远程绝对路径。" },
          recursive: { type: "boolean", description: "删除目录时必须为 true。" },
        },
        required: ["server", "path", "recursive"],
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
  [
    "ide.invoke",
    {
      description:
        "在已连接的 IDE 会话上执行一次经过握手验证的远程操作（如 editor.read/editor.write）。仅当当前任务来自已注册的 IDE 会话时可用；其他情况会返回 tool_scope_missing。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "IDE 会话 id。" },
          handshakeId: { type: "string", description: "本任务握手获得的调用凭证。" },
          operation: { type: "string", description: "握手期验证过的操作名。" },
          arguments: { type: "object", description: "操作参数。" },
        },
        required: ["sessionId", "handshakeId", "operation", "arguments"],
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
