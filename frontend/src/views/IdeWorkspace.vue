<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import TabStrip from "@/components/workbench/TabStrip.vue";
import ReadonlyCodeEditor from "@/components/ide/ReadonlyCodeEditor.vue";
import {
  approveIDEApproval,
  commitIDEKnownHost,
  commitIDEWorkspaceWrite,
  generateIDESSHKey,
  getIDEGitSnapshot,
  getIDEWorkspaceTree,
  importIDESSHKey,
  listIDEKnownHosts,
  listIDESSHKeys,
  listIDEWorkspaces,
  previewIDEKnownHost,
  previewIDEWorkspaceWrite,
  probeIDEHostKey,
  readIDEWorkspaceText,
  rejectIDEApproval,
  removeIDESSHKey,
  searchIDEWorkspace,
  selectAndRegisterIDEWorkspace,
} from "@/services/clientApi";
import {
  activateDocumentTab,
  activeDocumentTab,
  applySavedDocument,
  closeDocumentTab,
  createDocumentTabStore,
  documentCanSave,
  documentStatusLabel,
  documentStatusMeta,
  openDocumentTab,
  updateDocumentDraft,
} from "@/utils/ideDocumentTabs";
import {
  applyChildTree,
  applyRootTree,
  createExplorerTree,
  toggleDirectory,
  visibleExplorerRows,
} from "@/utils/ideExplorerTree";
import {
  EMPTY_IDE_GIT_SNAPSHOT,
  gitChangeStatusLabel,
  normalizeGitSnapshot,
} from "@/utils/ideGitSnapshot";

const workspaces = ref([]);
const activeWorkspaceID = ref("");
const searchQuery = ref("");
const searchResult = ref(null);
const loading = ref(false);
const errorMessage = ref("");
const explorer = reactive(createExplorerTree());
const documents = reactive(createDocumentTabStore());
const writePreview = ref(null);
const gitSnapshot = ref(normalizeGitSnapshot(EMPTY_IDE_GIT_SNAPSHOT));
const gitError = ref("");
const sshKeys = ref([]);
const sshError = ref("");
const sshName = ref("");
const sshPrivateKey = ref("");
const sshPassphrase = ref("");
const knownHosts = ref([]);
const knownHostError = ref("");
const knownHostName = ref("");
const knownHostPort = ref("22");
const knownHostPublicKey = ref("");
const knownHostPreview = ref(null);

const activeWorkspace = computed(() => workspaces.value.find((item) => item.id === activeWorkspaceID.value) || null);
const explorerRows = computed(() => {
  void explorer.revision;
  return visibleExplorerRows(explorer);
});
const activeDocument = computed(() => activeDocumentTab(documents));
const editorReadOnly = computed(() => {
  const tab = activeDocument.value;
  return !tab || tab.restricted || tab.binary || tab.truncated;
});
const editorKey = computed(() => {
  const tab = activeDocument.value;
  if (!tab) return "";
  return `${tab.id}:${tab.version}:${tab.truncated}:${tab.restricted}`;
});

function statusForEntry(entry) {
  if (entry.restricted || entry.kind === "symlink") return "受限";
  if (entry.kind === "directory") return "目录";
  return "文件";
}

async function run(action) {
  loading.value = true;
  errorMessage.value = "";
  try {
    await action();
  } catch (error) {
    errorMessage.value = error?.userMessage || error?.message || String(error || "工作区操作失败");
  } finally {
    loading.value = false;
  }
}

async function refreshWorkspaces(preferredID) {
  const items = await listIDEWorkspaces();
  workspaces.value = Array.isArray(items) ? items : [];
  const nextID = preferredID && workspaces.value.some((item) => item.id === preferredID)
    ? preferredID
    : (workspaces.value[0]?.id || "");
  activeWorkspaceID.value = nextID;
  gitError.value = "";
  if (nextID) {
    await loadRootTree();
    await loadGitSnapshot(nextID);
  } else {
    applyRootTree(explorer, { entries: [], truncated: false });
    gitSnapshot.value = normalizeGitSnapshot(EMPTY_IDE_GIT_SNAPSHOT);
  }
}

async function loadGitSnapshot(workspaceID) {
  try {
    gitSnapshot.value = normalizeGitSnapshot(await getIDEGitSnapshot(workspaceID));
    gitError.value = "";
  } catch (error) {
    gitSnapshot.value = normalizeGitSnapshot(EMPTY_IDE_GIT_SNAPSHOT);
    gitError.value = error?.userMessage || error?.message || "Git 状态不可用";
  }
}

async function loadSSHKeys() {
  try {
    sshKeys.value = await listIDESSHKeys();
    sshError.value = "";
  } catch (error) {
    sshKeys.value = [];
    sshError.value = error?.userMessage || error?.message || "SSH 保险库不可用";
  }
}

async function importSSHKey() {
  const name = sshName.value.trim();
  const privateKey = sshPrivateKey.value;
  const passphrase = sshPassphrase.value;
  sshPrivateKey.value = "";
  sshPassphrase.value = "";
  if (!name) return;
  await run(async () => {
    await importIDESSHKey(name, privateKey, passphrase);
    sshName.value = "";
    await loadSSHKeys();
  });
}

async function generateSSHKey() {
  const name = sshName.value.trim();
  sshPrivateKey.value = "";
  sshPassphrase.value = "";
  if (!name) return;
  await run(async () => {
    await generateIDESSHKey(name);
    sshName.value = "";
    await loadSSHKeys();
  });
}

async function removeSSHKey(keyID) {
  await run(async () => {
    await removeIDESSHKey(keyID);
    await loadSSHKeys();
  });
}

async function loadKnownHosts() {
  try {
    knownHosts.value = await listIDEKnownHosts();
    knownHostError.value = "";
  } catch (error) {
    knownHosts.value = [];
    knownHostError.value = error?.userMessage || error?.message || "SSH 已知主机不可用";
  }
}

async function probeKnownHost() {
  const host = knownHostName.value.trim();
  const port = Number(knownHostPort.value) || 22;
  knownHostPreview.value = null;
  if (!host) return;
  await run(async () => {
    const presented = await probeIDEHostKey(host, port);
    knownHostName.value = presented.host || host;
    knownHostPort.value = String(presented.port || port);
    knownHostPublicKey.value = presented.publicKey || "";
  });
}

async function previewKnownHost() {
  const host = knownHostName.value.trim();
  const port = Number(knownHostPort.value) || 22;
  const publicKey = knownHostPublicKey.value;
  if (!host || !publicKey.trim() || !activeWorkspaceID.value) return;
  await run(async () => {
    knownHostPreview.value = await previewIDEKnownHost(activeWorkspaceID.value, host, port, publicKey);
  });
}

async function rejectKnownHost() {
  const preview = knownHostPreview.value;
  if (!preview?.approval?.id) {
    knownHostPreview.value = null;
    return;
  }
  await run(async () => {
    await rejectIDEApproval(activeWorkspaceID.value, preview.approval.id);
    knownHostPreview.value = null;
  });
}

async function approveKnownHost() {
  const preview = knownHostPreview.value;
  if (!preview?.approval?.id) return;
  await run(async () => {
    await approveIDEApproval(activeWorkspaceID.value, preview.approval.id);
    await commitIDEKnownHost(
      activeWorkspaceID.value,
      preview.approval.id,
      preview.host,
      preview.port,
      preview.publicKey,
    );
    knownHostPreview.value = null;
    knownHostPublicKey.value = "";
    await loadKnownHosts();
  });
}

function knownHostStatusLabel(status) {
  if (status === "matched") return "已信任";
  if (status === "mismatch") return "主机密钥已变更";
  return "尚未信任";
}

async function loadRootTree() {
  if (!activeWorkspaceID.value) return;
  const result = await getIDEWorkspaceTree(activeWorkspaceID.value, "");
  applyRootTree(explorer, result);
}

async function openExplorerRow(entry) {
  if (!entry) return;
  if (entry.kind === "directory") {
    const needFetch = toggleDirectory(explorer, entry.path);
    if (!needFetch) return;
    await run(async () => {
      try {
        const result = await getIDEWorkspaceTree(activeWorkspaceID.value, entry.path);
        applyChildTree(explorer, entry.path, result);
      } catch (error) {
        if (explorer.expanded.has(entry.path)) toggleDirectory(explorer, entry.path);
        throw error;
      }
    });
    return;
  }
  if (entry.kind === "symlink" || entry.restricted) {
    errorMessage.value = "符号链接不可访问";
    openDocumentTab(documents, {
      workspaceID: activeWorkspaceID.value,
      path: entry.path,
      text: "",
      version: "",
      binary: false,
      truncated: false,
      restricted: true,
    });
    return;
  }
  await run(async () => {
    const file = await readIDEWorkspaceText(activeWorkspaceID.value, entry.path);
    openDocumentTab(documents, {
      workspaceID: activeWorkspaceID.value,
      path: file.path,
      text: file.text,
      version: file.version,
      binary: file.binary,
      truncated: file.truncated,
      restricted: false,
    });
  });
}

async function registerWorkspace() {
  await run(async () => {
    const summary = await selectAndRegisterIDEWorkspace();
    await refreshWorkspaces(summary?.id);
  });
}

async function runSearch() {
  const query = searchQuery.value.trim();
  if (!query || !activeWorkspaceID.value) return;
  await run(async () => {
    searchResult.value = await searchIDEWorkspace(activeWorkspaceID.value, "", query);
  });
}

function onEditorText(text) {
  if (!documents.activeId) return;
  updateDocumentDraft(documents, documents.activeId, text);
}

async function prepareSave() {
  const tab = activeDocument.value;
  if (!documentCanSave(tab)) return;
  await run(async () => {
    writePreview.value = await previewIDEWorkspaceWrite(tab.workspaceID, tab.path, tab.draft, tab.version);
  });
}

async function rejectSave() {
  const preview = writePreview.value;
  if (!preview?.approval?.id) {
    writePreview.value = null;
    return;
  }
  await run(async () => {
    await rejectIDEApproval(preview.approval.workspaceId || preview.approval.workspaceID || activeWorkspaceID.value, preview.approval.id);
    writePreview.value = null;
  });
}

async function approveSave() {
  const preview = writePreview.value;
  const tab = activeDocument.value;
  if (!preview?.approval?.id || !tab) return;
  const workspaceID = preview.approval.workspaceId || preview.approval.workspaceID || tab.workspaceID;
  await run(async () => {
    await approveIDEApproval(workspaceID, preview.approval.id);
    const saved = await commitIDEWorkspaceWrite(workspaceID, preview.approval.id, preview.path, preview.after, preview.expectedVersion);
    applySavedDocument(documents, tab.id, saved);
    writePreview.value = null;
  });
}

onMounted(() => {
  void run(async () => {
    await refreshWorkspaces();
    await loadSSHKeys();
    await loadKnownHosts();
  });
});
</script>

<template>
  <section class="ide-page" aria-labelledby="ide-heading">
    <header class="ide-header">
      <div>
        <p class="eyebrow">CODE WORK · WORKSPACE</p>
        <h1 id="ide-heading">工作区</h1>
        <p>选择并注册根目录后，只能用工作区 ID 和相对路径浏览、读取和搜索。只读 Git 状态使用系统 Git 的固定参数，远程地址会去掉凭据。SSH 私钥保存在应用保险库中，界面只显示名称和指纹。主机密钥不会自动接受，只有审批后才会写入应用管理的已知主机。</p>
      </div>
      <button type="button" class="primary-action" :disabled="loading" @click="registerWorkspace">选择并注册工作区</button>
    </header>

    <p v-if="errorMessage" class="status-error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="loading" class="status-muted">正在加载工作区…</p>
    <p v-else-if="workspaces.length === 0" class="status-muted">还没有已授权的工作区。请先选择一个根目录。</p>

    <div v-if="workspaces.length > 0" class="ide-grid">
      <aside class="panel" aria-label="已授权工作区">
        <h2>已授权工作区</h2>
        <button
          v-for="item in workspaces"
          :key="item.id"
          type="button"
          class="workspace-item"
          :class="{ current: item.id === activeWorkspaceID }"
          :aria-label="item.name"
          @click="run(() => refreshWorkspaces(item.id))"
        >
          <strong>{{ item.name }}</strong>
          <small>{{ item.id }}</small>
        </button>
      </aside>

      <section class="panel explorer-panel" aria-label="资源管理器">
        <div class="panel-toolbar">
          <h2>{{ activeWorkspace?.name || "文件树" }}</h2>
        </div>
        <p class="path-meta">/</p>
        <p v-if="explorer.truncated" class="status-warning">目录条目已截断</p>
        <button
          v-for="entry in explorerRows"
          :key="entry.path"
          type="button"
          class="tree-item"
          :class="{ expanded: entry.expanded }"
          :style="{ paddingLeft: `${8 + entry.depth * 14}px` }"
          :aria-label="entry.path"
          :aria-expanded="entry.kind === 'directory' ? String(entry.expanded) : undefined"
          @click="openExplorerRow(entry)"
        >
          <span class="tree-label">
            <span v-if="entry.kind === 'directory'" class="tree-twist" aria-hidden="true">{{ entry.expanded ? "▼" : "▶" }}</span>
            <span>{{ entry.label }}</span>
          </span>
          <small>{{ statusForEntry(entry) }}</small>
        </button>
        <p v-if="explorerRows.length === 0" class="status-muted">这个目录没有可显示的条目。</p>
      </section>

      <section class="panel git-panel" aria-label="源代码">
        <div class="panel-toolbar">
          <h2>源代码</h2>
          <button
            type="button"
            class="secondary-action"
            :disabled="loading || !activeWorkspaceID"
            @click="run(() => loadGitSnapshot(activeWorkspaceID))"
          >刷新</button>
        </div>
        <p v-if="gitError" class="status-error" role="alert">{{ gitError }}</p>
        <template v-else-if="gitSnapshot.available">
          <p class="path-meta">分支 {{ gitSnapshot.branch || "未知" }} · 领先 {{ gitSnapshot.ahead }} · 落后 {{ gitSnapshot.behind }}</p>
          <h3>远程</h3>
          <p v-if="gitSnapshot.remotes.length === 0" class="status-muted">没有远程仓库。</p>
          <p v-for="remote in gitSnapshot.remotes" :key="`${remote.name}:${remote.url}`" class="path-meta">{{ remote.name }} · {{ remote.url }}</p>
          <h3>变更</h3>
          <button
            v-for="change in gitSnapshot.changes"
            :key="change.path"
            type="button"
            class="tree-item"
            :aria-label="`${change.path} ${gitChangeStatusLabel(change.status)}`"
            @click="openExplorerRow({ path: change.path, kind: 'file' })"
          >
            <span>{{ change.path }}</span>
            <small>{{ gitChangeStatusLabel(change.status) }}</small>
          </button>
          <p v-if="gitSnapshot.changes.length === 0" class="status-muted">没有工作区变更。</p>
          <h3>差异</h3>
          <p v-if="gitSnapshot.diffTruncated" class="status-warning">差异已截断</p>
          <pre class="preview-body git-diff">{{ gitSnapshot.diff || "没有可显示的差异。" }}</pre>
        </template>
        <p v-else class="status-muted">当前工作区不是 Git 仓库，或系统 Git 不可用。</p>

        <section aria-label="SSH 密钥">
          <h3>SSH 密钥</h3>
          <p class="path-meta">私钥用系统 DPAPI 加密保存。导入或生成后，界面不会回显私钥或口令。</p>
          <p v-if="sshError" class="status-error" role="alert">{{ sshError }}</p>
          <form class="ssh-form" @submit.prevent="importSSHKey">
            <label class="sr-only" for="ssh-name">密钥名称</label>
            <input id="ssh-name" v-model="sshName" type="text" placeholder="密钥名称" autocomplete="off" />
            <label class="sr-only" for="ssh-private">私钥</label>
            <textarea id="ssh-private" v-model="sshPrivateKey" rows="3" placeholder="粘贴私钥" autocomplete="off" spellcheck="false"></textarea>
            <label class="sr-only" for="ssh-pass">口令</label>
            <input id="ssh-pass" v-model="sshPassphrase" type="password" placeholder="口令（可选）" autocomplete="new-password" />
            <div class="search-row">
              <button type="submit" class="primary-action" :disabled="loading || !sshName.trim()">导入密钥</button>
              <button type="button" class="secondary-action" :disabled="loading || !sshName.trim()" @click="generateSSHKey">生成密钥</button>
            </div>
          </form>
          <div
            v-for="key in sshKeys"
            :key="key.id"
            class="tree-item ssh-key"
          >
            <span>
              <strong>{{ key.name }}</strong>
              <small>{{ key.algorithm }} · {{ key.fingerprint }}</small>
            </span>
            <button type="button" class="text-action" :aria-label="`删除 ${key.name}`" @click="removeSSHKey(key.id)">删除</button>
          </div>
          <p v-if="sshKeys.length === 0" class="status-muted">还没有 SSH 密钥。</p>
        </section>

        <section aria-label="已知主机">
          <h3>已知主机</h3>
          <p class="path-meta">探测只读取指纹，不会写入。只有审批通过后才会保存到应用管理的已知主机。</p>
          <p v-if="knownHostError" class="status-error" role="alert">{{ knownHostError }}</p>
          <form class="ssh-form" @submit.prevent="previewKnownHost">
            <label class="sr-only" for="known-host-name">主机</label>
            <input id="known-host-name" v-model="knownHostName" type="text" placeholder="主机" autocomplete="off" />
            <label class="sr-only" for="known-host-port">端口</label>
            <input id="known-host-port" v-model="knownHostPort" type="number" min="1" max="65535" placeholder="端口" />
            <label class="sr-only" for="known-host-key">主机公钥</label>
            <textarea id="known-host-key" v-model="knownHostPublicKey" rows="3" placeholder="粘贴主机公钥" autocomplete="off" spellcheck="false"></textarea>
            <div class="search-row">
              <button type="button" class="secondary-action" :disabled="loading || !knownHostName.trim()" @click="probeKnownHost">探测主机</button>
              <button type="submit" class="primary-action" :disabled="loading || !knownHostName.trim() || !knownHostPublicKey.trim()">预览信任</button>
            </div>
          </form>
          <section v-if="knownHostPreview" class="write-preview" aria-label="主机密钥预览">
            <p class="path-meta">{{ knownHostPreview.host }}:{{ knownHostPreview.port }} · {{ knownHostStatusLabel(knownHostPreview.status) }} · {{ knownHostPreview.fingerprint }}</p>
            <p v-if="knownHostPreview.status === 'mismatch'" class="status-warning">已记录的指纹是 {{ knownHostPreview.knownFingerprint }}。批准后会替换旧密钥。</p>
            <p v-else-if="knownHostPreview.approval?.id" class="path-meta">{{ knownHostPreview.approval.summary?.title || "信任 SSH 主机" }} 需要审批。</p>
            <div v-if="knownHostPreview.approval?.id" class="search-row">
              <button type="button" class="primary-action" :disabled="loading" @click="approveKnownHost">批准写入</button>
              <button type="button" class="secondary-action" :disabled="loading" @click="rejectKnownHost">拒绝</button>
            </div>
          </section>
          <div
            v-for="item in knownHosts"
            :key="`${item.host}:${item.port}`"
            class="tree-item ssh-key"
          >
            <span>
              <strong>{{ item.host }}:{{ item.port }}</strong>
              <small>{{ item.algorithm }} · {{ item.fingerprint }}</small>
            </span>
          </div>
          <p v-if="knownHosts.length === 0" class="status-muted">还没有已知主机。</p>
        </section>
      </section>

      <section class="panel preview-panel" aria-label="文档编辑器">
        <TabStrip
          :tabs="documents.tabs"
          :active-id="documents.activeId"
          ariaLabel="打开的文档"
          @select="activateDocumentTab(documents, $event)"
          @close="closeDocumentTab(documents, $event)"
        />

        <form class="search-row" @submit.prevent="runSearch">
          <label class="sr-only" for="ide-search">搜索工作区</label>
          <input id="ide-search" v-model="searchQuery" type="search" placeholder="搜索文本" autocomplete="off" />
          <button type="submit" class="secondary-action" :disabled="!searchQuery.trim() || loading">搜索</button>
        </form>

        <div v-if="activeDocument" class="preview">
          <div class="panel-toolbar">
            <p class="path-meta">{{ activeDocument.path }} · {{ documentStatusLabel(activeDocument) }} · {{ documentStatusMeta(activeDocument) }}<span v-if="activeDocument.dirty"> · 未保存</span></p>
            <button
              v-if="documentCanSave(activeDocument)"
              type="button"
              class="secondary-action"
              :disabled="loading"
              @click="prepareSave"
            >保存</button>
          </div>
          <section v-if="writePreview" class="write-preview" aria-label="保存预览">
            <p class="path-meta">保存 {{ writePreview.path }} 需要审批。当前版本 {{ writePreview.currentVersion }}。</p>
            <div class="diff-grid">
              <pre class="preview-body">{{ writePreview.before }}</pre>
              <pre class="preview-body">{{ writePreview.after }}</pre>
            </div>
            <div class="search-row">
              <button type="button" class="primary-action" :disabled="loading" @click="approveSave">批准保存</button>
              <button type="button" class="secondary-action" :disabled="loading" @click="rejectSave">拒绝</button>
            </div>
          </section>
          <pre v-if="activeDocument.restricted" class="preview-body">此路径不可访问。</pre>
          <pre v-else-if="activeDocument.binary" class="preview-body">二进制文件不可预览。</pre>
          <ReadonlyCodeEditor
            v-else
            :text="activeDocument.draft"
            :read-only="editorReadOnly"
            :file-key="editorKey"
            @update:text="onEditorText"
          />
        </div>
        <p v-else class="status-muted">选择一个文件查看内容。二进制、截断和受限路径会保留状态，而不是静默打开。</p>

        <ul v-if="searchResult" class="search-hits">
          <li v-for="match in searchResult.matches" :key="`${match.path}:${match.line}`">
            <button type="button" class="text-action" @click="openExplorerRow({ path: match.path, kind: 'file' })">{{ match.path }}:{{ match.line }}</button>
            <code>{{ match.text }}</code>
          </li>
          <li v-if="searchResult.matches.length === 0" class="status-muted">没有匹配的文本。</li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.ide-page { display: flex; min-height: 100%; flex-direction: column; gap: 18px; padding: 22px 24px 28px; }
.ide-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.eyebrow { margin: 0 0 6px; color: var(--cw-accent-hover); font-size: 11px; font-weight: 700; letter-spacing: .11em; }
h1 { margin: 0; color: var(--cw-text-primary); font-size: 28px; letter-spacing: -.04em; }
.ide-header p { max-width: 720px; margin: 8px 0 0; color: var(--cw-text-secondary); font-size: 13px; line-height: 1.6; }
h2 { margin: 0; color: var(--cw-text-primary); font-size: 13px; }
h3 { margin: 8px 0 0; color: var(--cw-text-secondary); font-size: 11px; font-weight: 650; }
.primary-action, .secondary-action, .text-action { min-height: 32px; border-radius: var(--cw-radius-sm); cursor: pointer; font-size: 12px; font-weight: 650; }
.primary-action { padding: 0 12px; border: 0; background: var(--cw-accent); color: var(--cw-accent-ink); }
.primary-action:disabled, .secondary-action:disabled { opacity: .55; cursor: not-allowed; }
.secondary-action { padding: 0 10px; border: 1px solid var(--cw-border-strong); background: var(--cw-surface-raised); color: var(--cw-text-primary); }
.text-action { border: 0; background: transparent; color: var(--cw-accent-hover); }
.status-error, .status-warning, .status-muted { margin: 0; font-size: 12px; }
.status-error { color: #f0a8a8; }
.status-warning { color: #e6c07b; }
.status-muted { color: var(--cw-text-muted); }
.ide-grid { display: grid; grid-template-columns: minmax(160px, 200px) minmax(200px, 1fr) minmax(220px, 280px) minmax(280px, 1.3fr); min-height: 0; flex: 1; gap: 10px; }
.panel { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: 8px; overflow: auto; padding: 12px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-md); background: color-mix(in srgb, var(--cw-surface-raised) 78%, transparent); }
.preview-panel { padding-top: 0; }
.panel-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.path-meta { margin: 0; color: var(--cw-text-muted); font-size: 11px; }
.workspace-item, .tree-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; width: 100%; min-height: 36px; padding: 7px 8px; border: 0; border-radius: var(--cw-radius-sm); background: transparent; color: var(--cw-text-secondary); text-align: left; cursor: pointer; }
.workspace-item { display: grid; gap: 2px; }
.workspace-item.current, .workspace-item:hover, .tree-item:hover, .tree-item.expanded { background: var(--cw-surface-hover); color: var(--cw-text-primary); }
.workspace-item small, .tree-item small { color: var(--cw-text-muted); font-size: 11px; }
.tree-label { display: inline-flex; min-width: 0; align-items: center; gap: 6px; }
.tree-twist { width: 10px; color: var(--cw-text-muted); font-size: 9px; }
.search-row { display: flex; gap: 8px; }
.search-row input { min-width: 0; flex: 1; height: 32px; padding: 0 8px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-primary); }
.preview { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 8px; overflow: auto; }
.preview-body { min-height: 180px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-secondary); font-size: 12px; white-space: pre-wrap; }
.diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.write-preview { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--cw-border-subtle); }
.search-hits { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.search-hits code { display: block; color: var(--cw-text-muted); font-size: 11px; }
.git-diff { min-height: 120px; max-height: 220px; }
.ssh-form { display: grid; gap: 8px; }
.ssh-form input, .ssh-form textarea { width: 100%; padding: 8px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-primary); font-size: 12px; }
.ssh-form textarea { min-height: 64px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-key { cursor: default; }
.ssh-key small { display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 1100px) { .ide-grid { grid-template-columns: 1fr; } .ide-header { flex-direction: column; } .diff-grid { grid-template-columns: 1fr; } }
</style>
