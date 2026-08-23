import assert from "node:assert/strict";
import test from "node:test";

import { syncWorkbenchTab, workbenchState } from "../state/workbenchState.js";
import {
  closeDocumentTab,
  createDocumentTabStore,
  documentCanSave,
  documentStatusLabel,
  documentStatusMeta,
  openDocumentTab,
  updateDocumentDraft,
} from "./ideDocumentTabs.js";

test("document tabs stay independent from workbench route tabs", () => {
  workbenchState.tabs.splice(0, workbenchState.tabs.length);
  syncWorkbenchTab({ path: "/ide", meta: { workbenchLabel: "工作区", workbenchIcon: "folder" } });
  const store = createDocumentTabStore();
  openDocumentTab(store, {
    workspaceID: "ws-1",
    path: "src/main.go",
    text: "package main",
    version: "abc",
    binary: false,
    truncated: false,
    restricted: false,
  });

  assert.deepEqual(workbenchState.tabs.map((tab) => tab.id), ["/ide"]);
  assert.equal(store.tabs.length, 1);
  assert.equal(store.tabs[0].id, "ws-1:src/main.go");
  assert.equal(store.tabs[0].label, "main.go");
  assert.notEqual(store.activeId, workbenchState.tabs[0].id);

  closeDocumentTab(store, store.activeId);
  assert.equal(store.tabs.length, 0);
  assert.deepEqual(workbenchState.tabs.map((tab) => tab.id), ["/ide"]);
});

test("document chrome shows version, truncated, and restricted status", () => {
  const store = createDocumentTabStore();
  openDocumentTab(store, {
    workspaceID: "ws-1",
    path: "notes/large.txt",
    text: "truncated-preview",
    version: "v-truncated",
    binary: false,
    truncated: true,
    restricted: false,
  });
  assert.equal(documentStatusLabel(store.tabs[0]), "已截断");
  assert.equal(documentStatusMeta(store.tabs[0]), "版本 v-truncated");

  openDocumentTab(store, {
    workspaceID: "ws-1",
    path: "secret.link",
    text: "",
    version: "",
    binary: false,
    truncated: false,
    restricted: true,
  });
  const restricted = store.tabs.find((tab) => tab.restricted);
  assert.equal(documentStatusLabel(restricted), "受限");
  assert.equal(documentStatusMeta(restricted), "不可访问");
});

test("editable document drafts can save only unchanged versions of safe text", () => {
  const store = createDocumentTabStore();
  openDocumentTab(store, {
    workspaceID: "ws-1",
    path: "src/main.go",
    text: "package main",
    version: "v1",
    binary: false,
    truncated: false,
    restricted: false,
  });
  assert.equal(documentCanSave(store.tabs[0]), false);
  updateDocumentDraft(store, store.activeId, "package saved");
  assert.equal(documentCanSave(store.tabs[0]), true);
  assert.equal(store.tabs[0].dirty, true);
  assert.equal(store.tabs[0].text, "package main");
  assert.equal(store.tabs[0].draft, "package saved");

  openDocumentTab(store, {
    workspaceID: "ws-1",
    path: "notes/large.txt",
    text: "truncated-preview",
    version: "v-truncated",
    binary: false,
    truncated: true,
    restricted: false,
  });
  assert.equal(documentCanSave(store.tabs.find((tab) => tab.truncated)), false);
});
