import type { LocalPluginAttachmentContribution, LocalPluginPermission } from "@codework/contracts";

import type { IsolatedLocalPluginResult } from "../localPluginIsolation";
import { runIsolatedLocalPluginContribution } from "../localPluginIsolation";
import type { LocalPluginRuntime } from "../localPluginRuntime";

export interface LocalPluginAttachmentPickRequest {
  readonly accept: ReadonlyArray<LocalPluginAttachmentContribution["accept"][number]>;
  readonly multiple: true;
}

export interface LocalPluginAttachmentPorts {
  readonly pickFiles?: (
    input: LocalPluginAttachmentPickRequest,
  ) => Promise<ReadonlyArray<File> | null>;
  readonly addFiles?: (files: ReadonlyArray<File>) => boolean | Promise<boolean>;
  readonly insertPrompt?: (text: string) => boolean;
}

export type LocalPluginAttachmentRejectionReason = "mime-not-accepted" | "too-large";

export interface LocalPluginAttachmentInvocation {
  readonly acceptedFiles: ReadonlyArray<string>;
  readonly rejectedFiles: ReadonlyArray<{
    readonly fileName: string;
    readonly reason: LocalPluginAttachmentRejectionReason;
  }>;
}

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

function attachmentCanCloseLoop(input: {
  readonly attachment: LocalPluginAttachmentContribution;
  readonly ports: LocalPluginAttachmentPorts;
}): boolean {
  return (
    input.ports.pickFiles !== undefined &&
    input.ports.addFiles !== undefined &&
    (input.attachment.promptPrefix === undefined || input.ports.insertPrompt !== undefined)
  );
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
  const addFiles = input.ports.addFiles;
  if (pickFiles === undefined) throw new Error("当前没有可用的文件选择宿主。");
  if (addFiles === undefined) throw new Error("当前没有可用的附件输入框宿主。");
  const insertPrompt = input.ports.insertPrompt;
  if (attachment.promptPrefix !== undefined && insertPrompt === undefined) {
    throw new Error("当前没有可用的提示词输入框宿主。");
  }

  const selectedFiles = await pickFiles({ accept: attachment.accept, multiple: true });
  if (selectedFiles === null || selectedFiles.length === 0) {
    throw new Error("未选择附件。");
  }
  const { accepted, rejected } = partitionAttachmentFiles(selectedFiles, attachment);
  if (accepted.length === 0) {
    throw new Error("所选文件均不符合此附件贡献的类型或大小限制。");
  }
  if (!(await addFiles(accepted))) {
    throw new Error("当前输入框暂时不能接受插件附件。");
  }
  if (attachment.promptPrefix !== undefined && !insertPrompt?.(attachment.promptPrefix)) {
    throw new Error("当前输入框暂时不能接受插件提示词。");
  }

  return {
    acceptedFiles: accepted.map((file) => file.name),
    rejectedFiles: rejected,
  };
}

export function listEnabledLocalPluginAttachments(input: {
  readonly runtime: LocalPluginRuntime;
  readonly ports: LocalPluginAttachmentPorts;
}): ReadonlyArray<EnabledLocalPluginAttachment> {
  return input.runtime.registry
    .listEnabled("attachments")
    .filter(({ contribution }) =>
      attachmentCanCloseLoop({ attachment: contribution, ports: input.ports }),
    )
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
