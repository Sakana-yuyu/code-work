import { entryBasename } from "./ideExplorerTree.js";

export function createDocumentTabStore() {
  return {
    tabs: [],
    activeId: "",
  };
}

export function documentTabId(workspaceID, path) {
  return `${workspaceID}:${path}`;
}

export function openDocumentTab(store, file) {
  const id = documentTabId(file.workspaceID, file.path);
  const tab = {
    id,
    workspaceID: file.workspaceID,
    path: file.path,
    label: entryBasename(file.path),
    text: file.restricted || file.binary ? "" : String(file.text || ""),
    version: String(file.version || ""),
    binary: Boolean(file.binary),
    truncated: Boolean(file.truncated),
    restricted: Boolean(file.restricted),
    icon: "folder",
    closable: true,
  };
  const index = store.tabs.findIndex((item) => item.id === id);
  if (index >= 0) store.tabs.splice(index, 1, tab);
  else store.tabs.push(tab);
  store.activeId = id;
  return tab;
}

export function activateDocumentTab(store, id) {
  if (store.tabs.some((tab) => tab.id === id)) store.activeId = id;
}

export function closeDocumentTab(store, id) {
  const index = store.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  store.tabs.splice(index, 1);
  if (store.activeId !== id) return;
  const next = store.tabs[Math.min(index, store.tabs.length - 1)];
  store.activeId = next?.id || "";
}

export function activeDocumentTab(store) {
  return store.tabs.find((tab) => tab.id === store.activeId) || null;
}

export function documentStatusLabel(tab) {
  if (!tab) return "";
  if (tab.restricted) return "受限";
  if (tab.binary) return "二进制";
  if (tab.truncated) return "已截断";
  return "文本";
}

export function documentStatusMeta(tab) {
  if (!tab) return "";
  if (tab.restricted) return "不可访问";
  if (tab.version) return `版本 ${tab.version}`;
  return "";
}
