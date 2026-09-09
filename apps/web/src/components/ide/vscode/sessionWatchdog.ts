/**
 * The page binds exactly one IDE session — `initialize()` runs once, so the
 * WebSocket factory, resource proxy and workspace provider all capture the
 * first capability forever. When the server rebuilds the session (REH crash,
 * backend restart, environment switch) the only honest recovery is one
 * controlled reload that rebinds everything to the new capability. These
 * helpers keep that reload bounded: a flapping server must never pin the tab
 * in a reload loop. Dirty editors survive reloads via hot exit; chat drafts
 * persist in localStorage.
 */

export const IDE_RELOAD_WINDOW_MS = 10 * 60_000;
export const IDE_RELOAD_LIMIT = 3;

const RELOAD_HISTORY_KEY = "codework.ideReloads";

export interface ReloadHistoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeCapabilityPath(path: string): string {
  return path.replace(/\/+$/, "");
}

export function capabilityChanged(
  bound: string | null | undefined,
  wanted: string | null | undefined,
): boolean {
  if (bound === null || bound === undefined || wanted === null || wanted === undefined)
    return false;
  return normalizeCapabilityPath(bound) !== normalizeCapabilityPath(wanted);
}

/**
 * The origin whose `/api/ide` proxy serves the session's environment: the
 * environment's own HTTP origin when it is remote, the page origin when the
 * environment is the page's own backend (relative base URL).
 */
export function proxyOriginFromBaseUrl(
  baseUrl: string | null,
  // Callers in the page omit this; tests pass the page origin explicitly.
  pageOrigin: string = window.location.origin,
): string {
  if (baseUrl !== null) {
    try {
      return new URL(baseUrl).origin;
    } catch {
      // Relative base: the environment lives on the page's own origin.
    }
  }
  return pageOrigin;
}

/**
 * Records this recovery attempt and decides whether the page may reload now:
 * true → proceed with the reload, false → the limit was hit inside the window
 * and automatic recovery must pause (surface the manual retry instead).
 */
export function planSessionReload(store: ReloadHistoryStore, now = Date.now()): boolean {
  let history: number[] = [];
  try {
    const raw = store.getItem(RELOAD_HISTORY_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) {
      history = parsed.filter((entry): entry is number => typeof entry === "number");
    }
  } catch {
    history = [];
  }
  const recent = history.filter((at) => now - at < IDE_RELOAD_WINDOW_MS);
  if (recent.length >= IDE_RELOAD_LIMIT) return false;
  recent.push(now);
  store.setItem(RELOAD_HISTORY_KEY, JSON.stringify(recent));
  return true;
}
