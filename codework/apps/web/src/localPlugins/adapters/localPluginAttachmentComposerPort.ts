import type { ComposerHandleRef } from "~/composerHandleContext";

export async function addFilesToLocalPluginComposer(
  composerHandleRef: ComposerHandleRef,
  files: ReadonlyArray<File>,
): Promise<boolean> {
  const composer = composerHandleRef.current;
  if (composer === null) return false;
  return composer.addDroppedFiles([...files]);
}
