export const WORKBENCH_LAUNCH_PATH = "/ide";
export const SERVICE_CONSOLE_PATH = "/console";

export function isWorkbenchSurfacePath(path) {
  return path === "/ide" || path === "/workbench";
}

export function currentLocationPath() {
  if (typeof window === "undefined") return "";
  const hash = String(window.location.hash || "");
  if (hash.startsWith("#")) {
    return hash.slice(1).split("?")[0] || "/";
  }
  return String(window.location.pathname || "").split("?")[0] || "/";
}

export function isCurrentWorkbenchSurface() {
  return isWorkbenchSurfacePath(currentLocationPath());
}

export function settingsReturnPath() {
  return WORKBENCH_LAUNCH_PATH;
}
