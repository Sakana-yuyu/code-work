export type FileViewMode = "preview" | "source";

export function canEditWorkspaceFile(input: {
  readonly relativePath: string | null;
  readonly fileLoaded: boolean;
  readonly truncated: boolean;
  readonly isCanvas: boolean;
  readonly viewMode: FileViewMode;
}): boolean {
  return (
    input.relativePath !== null &&
    input.fileLoaded &&
    !input.truncated &&
    !input.isCanvas &&
    input.viewMode === "source"
  );
}
