import { reactive } from "vue";

export const IDE_ACTIVE_WORKSPACE_STORAGE_KEY = "code-work.ide.active-workspace-id";

export const ideWorkspaceSession = reactive({
  workspaceID: "",
  document: null,
  documentEpoch: 0,
});

export function readStoredWorkspaceID() {
  try {
    return String(sessionStorage.getItem(IDE_ACTIVE_WORKSPACE_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function writeActiveWorkspaceID(id) {
  const value = String(id || "").trim();
  ideWorkspaceSession.workspaceID = value;
  try {
    if (value) sessionStorage.setItem(IDE_ACTIVE_WORKSPACE_STORAGE_KEY, value);
    else sessionStorage.removeItem(IDE_ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    // sessionStorage may be unavailable in some test environments
  }
}

export function writeActiveDocument(tab) {
  if (!tab?.path) {
    ideWorkspaceSession.document = null;
    return;
  }
  ideWorkspaceSession.document = {
    path: tab.path,
    draft: tab.draft,
    text: tab.text,
    version: tab.version,
  };
}

export function bumpDocumentEpoch() {
  ideWorkspaceSession.documentEpoch += 1;
}

export function hydrateWorkspaceSession() {
  if (!ideWorkspaceSession.workspaceID) {
    ideWorkspaceSession.workspaceID = readStoredWorkspaceID();
  }
}

hydrateWorkspaceSession();
