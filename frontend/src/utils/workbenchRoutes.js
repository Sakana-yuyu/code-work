export const WORKBENCH_LAUNCH_PATH = "/ide";
export const SERVICE_CONSOLE_PATH = "/console";

export function isWorkbenchSurfacePath(path) {
  return path === "/ide" || path === "/workbench";
}

export function settingsReturnPath() {
  return WORKBENCH_LAUNCH_PATH;
}
