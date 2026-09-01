import type { LocalPluginAttachmentContribution, LocalPluginPermission } from "@codework/contracts";

import type { IsolatedLocalPluginResult } from "../localPluginIsolation";
import { runIsolatedLocalPluginContribution } from "../localPluginIsolation";
import type { LocalPluginRuntime } from "../localPluginRuntime";

export interface LocalPluginAttachmentPickRequest {
  readonly accept: ReadonlyArray<LocalPluginAttachmentContribution["accept"][number]>;
  readonly multiple: true;
}

export interface LocalPluginAttachmentCommitRequest {
  readonly files: ReadonlyArray<File>;
  readonly promptPrefix?: string;
}

export type LocalPluginAttachmentPromptFailure = "prompt-rejected" | "prompt-error";

export type LocalPluginAttachmentCommitResult =
  | { readonly status: "complete" }
  | {
      readonly status: "attachment-only";
      readonly reason: "prompt-rejected";
    }
  | {
      readonly status: "attachment-only";
      readonly reason: "prompt-error";
      readonly error: unknown;
    }
  | { readonly status: "rejected" }
  | { readonly status: "rejected"; readonly error: unknown };

export interface LocalPluginAttachmentPorts {
  readonly pickFiles?: (
    input: LocalPluginAttachmentPickRequest,
  ) => Promise<ReadonlyArray<File> | null>;
  readonly commitAttachment?: (
    input: LocalPluginAttachmentCommitRequest,
  ) => Promise<LocalPluginAttachmentCommitResult>;
}

export type LocalPluginAttachmentRejectionReason = "mime-not-accepted" | "too-large";

interface LocalPluginAttachmentInvocationBase {
  readonly acceptedFiles: ReadonlyArray<string>;
  readonly rejectedFiles: ReadonlyArray<{
    readonly fileName: string;
    readonly reason: LocalPluginAttachmentRejectionReason;
  }>;
}

export type LocalPluginAttachmentInvocation =
  | (LocalPluginAttachmentInvocationBase & { readonly status: "complete" })
  | (LocalPluginAttachmentInvocationBase & {
      readonly status: "attachment-only";
      readonly promptFailure: LocalPluginAttachmentPromptFailure;
    });

export interface EnabledLocalPluginAttachment {
  readonly id: `local-plugin-attachment:${string}:${string}`;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contributionId: string;
  readonly title: string;
  readonly description?: string;
  readonly invoke: () => Promise<IsolatedLocalPluginResult<LocalPluginAttachmentInvocation>>;
}

function assertPermission(
  runtime: LocalPluginRuntime,
  pluginId: string,
  permission: LocalPluginPermission,
): void {
  if (!runtime.registry.hasPermission(pluginId, permission)) {
    throw new Error(`插件缺少 ${permission} 权限。`);
  }
}

function attachmentCanCloseLoop(input: { readonly ports: LocalPluginAttachmentPorts }): boolean {
  return input.ports.pickFiles !== undefined && input.ports.commitAttachment !== undefined;
}

function partitionAttachmentFiles(
  files: ReadonlyArray<File>,
  attachment: LocalPluginAttachmentContribution,
): {
  readonly accepted: ReadonlyArray<File>;
  readonly rejected: LocalPluginAttachmentInvocation["rejectedFiles"];
} {
  const acceptedMimeTypes = new Set<string>(attachment.accept);
  const accepted: File[] = [];
  const rejected: Array<LocalPluginAttachmentInvocation["rejectedFiles"][number]> = [];
  for (const file of files) {
    if (!acceptedMimeTypes.has(file.type.toLowerCase())) {
      rejected.push({ fileName: file.name, reason: "mime-not-accepted" });
      continue;
    }
    if (file.size > attachment.maxBytes) {
      rejected.push({ fileName: file.name, reason: "too-large" });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}

async function invokeCurrentAttachment(input: {
  readonly runtime: LocalPluginRuntime;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly ports: LocalPluginAttachmentPorts;
}): Promise<LocalPluginAttachmentInvocation> {
  const plugin = input.runtime.registry.get(input.pluginId);
  if (plugin === null) throw new Error("插件不存在。");
  if (!plugin.enabled) throw new Error("插件已禁用。");
  const attachment = plugin.manifest.contributions.attachments?.find(
    (candidate) => candidate.id === input.contributionId,
  );
  if (attachment === undefined) throw new Error("附件贡献不存在。");

  assertPermission(input.runtime, input.pluginId, "composer.attachment.add");
  if (attachment.promptPrefix !== undefined) {
    assertPermission(input.runtime, input.pluginId, "composer.prompt.write");
  }

  const pickFiles = input.ports.pickFiles;
  const commitAttachment = input.ports.commitAttachment;
  if (pickFiles === undefined) throw new Error("当前没有可用的文件选择宿主。");
  if (commitAttachment === undefined) throw new Error("当前没有可用的附件输入框宿主。");

  const selectedFiles = await pickFiles({ accept: attachment.accept, multiple: true });
  if (selectedFiles === null || selectedFiles.length === 0) {
    throw new Error("未选择附件。");
  }
  const { accepted, rejected } = partitionAttachmentFiles(selectedFiles, attachment);
  if (accepted.length === 0) {
    throw new Error("所选文件均不符合此附件贡献的类型或大小限制。");
  }
  const commitResult = await commitAttachment({
    files: accepted,
    ...(attachment.promptPrefix === undefined ? {} : { promptPrefix: attachment.promptPrefix }),
  });
  if (commitResult.status === "rejected") {
    if ("error" in commitResult) throw commitResult.error;
    throw new Error("当前输入框暂时不能接受插件附件。");
  }

  const invocation = {
    acceptedFiles: accepted.map((file) => file.name),
    rejectedFiles: rejected,
  };
  return commitResult.status === "complete"
    ? { ...invocation, status: "complete" }
    : {
        ...invocation,
        status: "attachment-only",
        promptFailure: commitResult.reason,
      };
}

export function listEnabledLocalPluginAttachments(input: {
  readonly runtime: LocalPluginRuntime;
  readonly ports: LocalPluginAttachmentPorts;
}): ReadonlyArray<EnabledLocalPluginAttachment> {
  return input.runtime.registry
    .listEnabled("attachments")
    .filter(() => attachmentCanCloseLoop({ ports: input.ports }))
    .map(({ pluginId, pluginName, contribution }) => ({
      id: `local-plugin-attachment:${pluginId}:${contribution.id}`,
      pluginId,
      pluginName,
      contributionId: contribution.id,
      title: contribution.title,
      ...(contribution.description === undefined ? {} : { description: contribution.description }),
      invoke: () =>
        runIsolatedLocalPluginContribution({
          failures: input.runtime.failures,
          pluginId,
          contributionKind: "attachments",
          contributionId: contribution.id,
          run: () =>
            invokeCurrentAttachment({
              runtime: input.runtime,
              pluginId,
              contributionId: contribution.id,
              ports: input.ports,
            }),
        }),
    }));
}
