import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

import { beginForegroundHandoff } from "./foreground-handoff";

/**
 * Hands bytes an MCP App generated to the OS share sheet: write a cache file,
 * share it, and clean up once the sheet is done. The share sheet covers the
 * app, which Android reports as a background handoff. Returns false when the
 * device cannot share; a write or share failure rejects.
 */
export async function shareGeneratedAttachment(input: {
  readonly bytes: Uint8Array;
  readonly attachment: { readonly name: string; readonly mimeType: string };
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (input.signal.aborted) return false;
  if (!(await Sharing.isAvailableAsync())) return false;
  const endHandoff = beginForegroundHandoff();
  try {
    const file = new FileSystem.File(
      FileSystem.Paths.cache,
      `codework-app-${Date.now()}-${input.attachment.name.replace(/[\\/:*?"<>|]+/g, "-")}`,
    );
    try {
      file.write(input.bytes);
      await Sharing.shareAsync(file.uri, {
        mimeType: input.attachment.mimeType,
        dialogTitle: input.attachment.name,
      });
    } finally {
      if (file.exists) file.delete();
    }
    return true;
  } finally {
    endHandoff();
  }
}
