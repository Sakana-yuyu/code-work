export const WORKBENCH_LAUNCH_PATH = "/console";
export const SERVICE_CONSOLE_PATH = "/console";

export function currentLocationPath() {
  if (typeof window === "undefined") return "";
  const hash = String(window.location.hash || "");
  if (hash.startsWith("#")) {
    return hash.slice(1).split("?")[0] || "/";
  }
  return String(window.location.pathname || "").split("?")[0] || "/";
}

export function settingsReturnPath() {
  return SERVICE_CONSOLE_PATH;
}
