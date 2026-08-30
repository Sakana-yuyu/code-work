import type { ComposerHandleRef } from "~/composerHandleContext";
import type {
  LocalPluginAttachmentCommitRequest,
  LocalPluginAttachmentCommitResult,
} from "./localPluginAttachmentAdapter";

export async function commitLocalPluginAttachmentToComposer(
  composerHandleRef: ComposerHandleRef,
  input: LocalPluginAttachmentCommitRequest,
): Promise<LocalPluginAttachmentCommitResult> {
  const composer = composerHandleRef.current;
  if (composer === null) return { status: "rejected" };

  try {
    if (!(await composer.addDroppedFiles([...input.files]))) {
      return { status: "rejected" };
    }
  } catch (error) {
    return { status: "rejected", error };
  }

  if (input.promptPrefix === undefined) return { status: "complete" };
  try {
    return composer.insertTextAtEnd(input.promptPrefix, { ensureLeadingBoundary: true })
      ? { status: "complete" }
      : { status: "attachment-only", reason: "prompt-rejected" };
  } catch (error) {
    return { status: "attachment-only", reason: "prompt-error", error };
  }
}
