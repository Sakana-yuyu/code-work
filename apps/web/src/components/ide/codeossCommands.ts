export type CodeossCommand =
  | "sidebar"
  | "files"
  | "quickOpen"
  | "terminal"
  | "extensions"
  | "git"
  | "search";
export function sendCodeossCommand(command: CodeossCommand) {
  window.dispatchEvent(new CustomEvent(CODEWORK_IDE_COMMAND_EVENT, { detail: command }));
}

/**
 * Workspace intent → live workbench command id. The in-document workbench
 * (see `ide/vscode/VscodeWorkbench.tsx`) listens for `codework-ide-command`
 * events and executes these through its command service; the old iframe
 * host used to forward the same events over postMessage.
 */
export const codeossWorkbenchCommands: Record<CodeossCommand, string> = {
  sidebar: "workbench.action.toggleSidebarVisibility",
  files: "workbench.view.explorer",
  quickOpen: "workbench.action.quickOpen",
  terminal: "workbench.action.terminal.toggleTerminal",
  extensions: "workbench.view.extensions",
  git: "workbench.view.scm",
  search: "workbench.view.search",
};

export const CODEWORK_IDE_COMMAND_EVENT = "codework-ide-command";

export function codeossFilePath(cwd: string, relativePath: string) {
  const path = `${cwd.replaceAll("\\", "/").replace(/\/$/, "")}/${relativePath.replaceAll("\\", "/")}`;
  return path.startsWith("/") ? path : `/${path}`;
}
