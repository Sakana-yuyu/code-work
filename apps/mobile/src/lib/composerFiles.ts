import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@codework/contracts";
import { resolveAssetUrl } from "@codework/client-runtime/state/assets";
import {
  clampFileAttachmentUploadBytes,
  deletePendingAttachmentUpload,
  formatAttachmentSize,
  runAttachmentUploadCycle,
} from "@codework/client-runtime/state/attachments";

import type { PickMultipleFilesResult } from "expo-file-system";

import { t } from "../i18n/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { attachmentEnvironment } from "../state/attachments";
import { environmentServerConfigsAtom } from "../state/server";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import type { DraftComposerAttachment, DraftComposerFileAttachment } from "./composerImages";
import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";

/** App-owned copies live in the document directory so the OS never purges a queued file. */
const OWNED_FILE_DIRECTORY = "codework-composer-files";

/**
 * The per-file byte limit an environment advertises for generic files, or
 * null when it accepts none. Unknown environments (no config yet) stage up to
 * the contract cap; delivery re-checks against the live advertisement.
 */
export function composerFileUploadLimit(environmentId: EnvironmentId): number | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  if (config === undefined) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  const advertised = config.environment.capabilities.fileAttachments?.maxUploadBytes;
  return advertised === undefined ? null : clampFileAttachmentUploadBytes(advertised);
}

function safeFileNameSegment(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
}

export function isOwnedComposerFileUri(uri: string): boolean {
  return uri.startsWith("file:") && uri.includes(`/${OWNED_FILE_DIRECTORY}/`);
}

/**
 * Opens the system file picker and stages each pick as an app-owned copy.
 * Images picked here travel as files too: the photo library path is the one
 * that inlines them.
 */
export async function pickComposerFiles(input: {
  readonly existingCount: number;
  readonly maxBytes: number | null;
}): Promise<{
  readonly files: ReadonlyArray<DraftComposerFileAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      files: [],
      error: t("composer.attachmentLimit", { count: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }),
    };
  }
  if (input.maxBytes === null) {
    return { files: [], error: t("composer.serverRejectsFiles") };
  }

  let fileSystem: typeof import("expo-file-system");
  try {
    fileSystem = await import("expo-file-system");
  } catch {
    return { files: [], error: t("composer.filesUnavailable") };
  }
  const { Directory, File, Paths } = fileSystem;

  // The picker covers the Android activity, which reports the app as
  // backgrounded; the guard keeps background-triggered restarts away mid-pick.
  const endHandoff = beginForegroundHandoff();
  let picked: PickMultipleFilesResult;
  try {
    picked = await File.pickFileAsync({ multipleFiles: true });
  } catch {
    return { files: [], error: t("composer.filesUnavailable") };
  } finally {
    endHandoff();
  }
  if (picked.canceled) {
    return { files: [], error: null };
  }

  const files: DraftComposerFileAttachment[] = [];
  let error: string | null = null;
  const directory = new Directory(Paths.document, OWNED_FILE_DIRECTORY);
  for (const [index, source] of picked.result.entries()) {
    const name = (source.name.trim() || "file").slice(0, 255);
    if (index >= remainingSlots) {
      error = t("composer.attachmentLimit", { count: PROVIDER_SEND_TURN_MAX_ATTACHMENTS });
      break;
    }
    const sizeBytes = source.size ?? 0;
    if (sizeBytes <= 0) {
      error = t("composer.fileIsEmpty", { name });
      continue;
    }
    if (sizeBytes > input.maxBytes) {
      error = t("composer.fileTooLarge", { name, limit: formatAttachmentSize(input.maxBytes) });
      continue;
    }
    try {
      if (!directory.exists) {
        directory.create({ intermediates: true, idempotent: true });
      }
      const id = uuidv4();
      const owned = new File(directory, `${id}-${safeFileNameSegment(name)}`);
      source.copy(owned);
      const mimeType = source.type.trim().toLowerCase();
      files.push({
        id,
        type: "file",
        name,
        mimeType:
          mimeType.length > 0 && mimeType.length <= 100 ? mimeType : "application/octet-stream",
        sizeBytes,
        fileUri: owned.uri,
      });
    } catch {
      error = t("composer.failedToReadFile", { name });
    }
  }
  return { files, error };
}

/** Deletes the app-owned copies of files a draft or delivered message no longer needs. */
export async function deleteOwnedComposerFiles(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): Promise<void> {
  const owned = attachments.filter(
    (attachment): attachment is DraftComposerFileAttachment =>
      attachment.type === "file" && isOwnedComposerFileUri(attachment.fileUri),
  );
  if (owned.length === 0) return;
  const { File } = await import("expo-file-system");
  for (const attachment of owned) {
    try {
      const file = new File(attachment.fileUri);
      if (file.exists) file.delete();
    } catch (error) {
      console.warn("[composer-files] failed to delete owned copy", attachment.name, error);
    }
  }
}

/**
 * Uploads every file not yet uploaded to `environmentId` and returns the
 * attachments with their upload ids, ready for `toTurnAttachments`. Throws a
 * user-facing error when the connection or server cannot take the files;
 * callers keep the returned ids on the queued message so a retry reuses them.
 */
export async function prepareComposerFileUploads(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}): Promise<ReadonlyArray<DraftComposerAttachment>> {
  const needsUpload = (attachment: DraftComposerAttachment) =>
    attachment.type === "file" &&
    (attachment.uploadedAttachmentId === undefined ||
      attachment.uploadEnvironmentId !== input.environmentId);
  if (!input.attachments.some(needsUpload)) {
    return input.attachments;
  }
  if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
    throw new Error(t("upload.connectionCannotUpload"));
  }
  const limit = composerFileUploadLimit(input.environmentId);
  if (limit === null) {
    throw new Error(t("composer.serverRejectsFiles"));
  }

  const { File, UploadType } = await import("expo-file-system");
  const prepared: DraftComposerAttachment[] = [];
  for (const attachment of input.attachments) {
    if (attachment.type !== "file" || !needsUpload(attachment)) {
      prepared.push(attachment);
      continue;
    }
    if (attachment.sizeBytes > limit) {
      throw new Error(
        t("composer.fileTooLarge", { name: attachment.name, limit: formatAttachmentSize(limit) }),
      );
    }
    const source = new File(attachment.fileUri);
    if (!source.exists) {
      throw new Error(t("composer.fileNoLongerAvailable", { name: attachment.name }));
    }
    const result = await runAttachmentUploadCycle({
      registry: appAtomRegistry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId: input.environmentId,
      upload: {
        type: "file",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
      resolveUploadUrl: (relativeUrl) => {
        const connection = readPreparedConnection(input.environmentId);
        return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
      },
      transport: (url) => {
        const controller = new AbortController();
        return {
          done: source
            .upload(url, {
              httpMethod: "POST",
              uploadType: UploadType.BINARY_CONTENT,
              headers: { "Content-Type": attachment.mimeType },
              signal: controller.signal,
            })
            .then((response) => {
              if (response.status < 200 || response.status >= 300) {
                throw new Error(t("upload.rejectedStatus", { status: response.status }));
              }
            }),
          abort: () => controller.abort(),
        };
      },
    });
    if (result.status !== "uploaded") {
      if (result.attachmentId !== null) {
        deletePendingAttachmentUpload({
          registry: appAtomRegistry,
          remove: attachmentEnvironment.remove,
          environmentId: input.environmentId,
          attachmentId: result.attachmentId,
        });
      }
      throw new Error(t("composer.fileUploadFailed", { name: attachment.name }));
    }
    prepared.push({
      ...attachment,
      uploadedAttachmentId: result.attachmentId,
      uploadEnvironmentId: input.environmentId,
    });
  }
  return prepared;
}
