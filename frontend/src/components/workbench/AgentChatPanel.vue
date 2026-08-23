<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";
import {
  approveIDEApproval,
  cancelIDEAgentRun,
  commitIDEAgentEffect,
  getIDEAgentRunEvents,
  loadUserConfig,
  previewIDEAgentEffect,
  readIDEWorkspaceText,
  rejectIDEApproval,
  startIDEAgentRun,
} from "@/services/clientApi";
import { pickDefaultAgentModelID } from "@/utils/agentChatModels.js";
import {
  bumpDocumentEpoch,
  hydrateWorkspaceSession,
  ideWorkspaceSession,
  readStoredWorkspaceID,
} from "@/utils/ideWorkspaceSession.js";

const props = defineProps({
  workspaceId: { type: String, default: "" },
});

const emit = defineEmits(["close"]);
const router = useRouter();

const loading = ref(false);
const userConfig = ref(null);
const agentPrompt = ref("总结当前工作区");
const agentModelID = ref("");
const agentRun = ref(null);
const agentEvents = ref([]);
const agentError = ref("");
const agentEffectPreview = ref(null);

const workspaceID = computed(() => String(
  props.workspaceId
  || ideWorkspaceSession.workspaceID
  || readStoredWorkspaceID()
  || "",
).trim());

const readyAdapters = computed(() => {
  const adapters = Array.isArray(userConfig.value?.modelAdapters) ? userConfig.value.modelAdapters : [];
  return adapters.filter((item) => item && item.enabled !== false && String(item.id || "").trim());
});

const hasModel = computed(() => readyAdapters.value.length > 0);
const modelsLoaded = ref(false);
const agentTranscript = computed(() => agentEvents.value.map((event) => event.text).filter(Boolean).join(""));

async function run(action) {
  loading.value = true;
  agentError.value = "";
  try {
    await action();
  } catch (error) {
    agentError.value = error?.userMessage || error?.message || String(error || "Agent 操作失败");
  } finally {
    loading.value = false;
  }
}

async function loadModels() {
  try {
    const config = await loadUserConfig();
    userConfig.value = config && typeof config === "object" ? config : {};
    const nextID = pickDefaultAgentModelID({
      modelAdapters: userConfig.value.modelAdapters,
    });
    if (!readyAdapters.value.some((item) => item.id === agentModelID.value)) {
      agentModelID.value = nextID;
    }
  } catch (error) {
    userConfig.value = { modelAdapters: [] };
    agentError.value = error?.userMessage || error?.message || "无法加载模型配置";
  } finally {
    modelsLoaded.value = true;
  }
}

function openModelConfig() {
  void router.push("/model-config");
}

async function refreshAgentEvents() {
  if (!agentRun.value?.id) return;
  agentEvents.value = await getIDEAgentRunEvents(agentRun.value.id);
}

async function startAgent() {
  if (!workspaceID.value || !agentModelID.value) return;
  await run(async () => {
    agentEffectPreview.value = null;
    agentRun.value = await startIDEAgentRun(workspaceID.value, agentModelID.value, agentPrompt.value);
    await refreshAgentEvents();
  });
}

async function cancelAgent() {
  if (!agentRun.value?.id) return;
  await run(async () => {
    agentRun.value = await cancelIDEAgentRun(agentRun.value.id);
    await refreshAgentEvents();
  });
}

async function previewAgentWrite() {
  const tab = ideWorkspaceSession.document;
  if (!agentRun.value?.id || !tab?.path) {
    agentError.value = "请先打开文本文件并启动 Agent。";
    return;
  }
  await run(async () => {
    agentEffectPreview.value = await previewIDEAgentEffect(agentRun.value.id, {
      kind: "workspace_write",
      path: tab.path,
      text: `${tab.draft || tab.text || ""}// agent\n`,
      expectedVersion: tab.version,
    });
  });
}

async function approveAgentEffect() {
  const preview = agentEffectPreview.value;
  if (!preview?.approval?.id || !workspaceID.value) return;
  await run(async () => {
    await approveIDEApproval(workspaceID.value, preview.approval.id);
    await commitIDEAgentEffect(agentRun.value.id, preview.approval.id, preview.effect);
    agentEffectPreview.value = null;
    await refreshAgentEvents();
    const tab = ideWorkspaceSession.document;
    if (tab?.path) {
      await readIDEWorkspaceText(workspaceID.value, tab.path);
      bumpDocumentEpoch();
    }
  });
}

async function rejectAgentEffect() {
  const preview = agentEffectPreview.value;
  if (!preview?.approval?.id || !workspaceID.value) return;
  await run(async () => {
    await rejectIDEApproval(workspaceID.value, preview.approval.id);
    agentEffectPreview.value = null;
  });
}

watch(workspaceID, () => {
  agentRun.value = null;
  agentEvents.value = [];
  agentEffectPreview.value = null;
});

onMounted(() => {
  hydrateWorkspaceSession();
  void loadModels();
});
</script>

<template>
  <aside class="task-panel agent-chat-panel" aria-label="AI 对话">
    <header class="task-header">
      <div>
        <p>AI</p>
        <span>对话</span>
      </div>
      <button type="button" aria-label="隐藏 AI 栏" title="隐藏 AI 栏" @click="emit('close')"><WorkbenchGlyph name="panel-right" :size="17" /></button>
    </header>

    <div class="agent-body">
      <p v-if="!workspaceID" class="empty-state">先打开文件夹</p>
      <div v-else-if="!modelsLoaded" class="empty-state" aria-busy="true"></div>
      <div v-else-if="!hasModel" class="empty-state model-guide">
        <p>去设置 → Cursor 与服务 / 模型配置</p>
        <button type="button" class="primary-action" @click="openModelConfig">打开模型配置</button>
      </div>
      <template v-else>
        <p class="path-meta">使用已配置的模型路由，不经过 Cursor exec bridge。写入、Git、终端和 MCP 副作用都要审批。</p>
        <p v-if="agentError" class="status-error" role="alert">{{ agentError }}</p>
        <form class="agent-form" @submit.prevent="startAgent">
          <label class="sr-only" for="agent-model">模型</label>
          <select id="agent-model" v-model="agentModelID" :disabled="loading">
            <option v-for="adapter in readyAdapters" :key="adapter.id" :value="adapter.id">{{ adapter.displayName || adapter.id }}</option>
          </select>
          <label class="sr-only" for="agent-prompt">Agent 提示</label>
          <textarea id="agent-prompt" v-model="agentPrompt" rows="3" placeholder="询问工作区"></textarea>
          <div class="action-row">
            <button type="submit" class="primary-action" :disabled="loading || !workspaceID || !agentModelID">开始运行</button>
            <button type="button" class="secondary-action" :disabled="loading || !agentRun" @click="cancelAgent">取消</button>
            <button type="button" class="secondary-action" :disabled="loading || !agentRun" @click="previewAgentWrite">预览写入</button>
          </div>
        </form>
        <p v-if="agentRun" class="path-meta">运行 {{ agentRun.status }}</p>
        <pre class="preview-body" aria-label="Agent 输出">{{ agentTranscript || "尚未运行 Agent。" }}</pre>
        <section v-if="agentEffectPreview" class="write-preview" aria-label="Agent 副作用预览">
          <p class="path-meta">{{ agentEffectPreview.approval?.summary?.title || "Agent 副作用" }} 需要审批。</p>
          <div class="action-row">
            <button type="button" class="primary-action" :disabled="loading" @click="approveAgentEffect">批准执行</button>
            <button type="button" class="secondary-action" :disabled="loading" @click="rejectAgentEffect">拒绝</button>
          </div>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.task-panel { display: flex; min-width: 0; flex-direction: column; overflow: hidden; border-left: 1px solid var(--cw-border-subtle); background: var(--cw-surface-sidebar); }
.task-header { display: flex; align-items: center; justify-content: space-between; min-height: 61px; padding: 12px 12px 10px 15px; border-bottom: 1px solid var(--cw-border-subtle); }
.task-header p { margin: 0; color: var(--cw-text-primary); font-size: 13px; font-weight: 650; }
.task-header span { color: var(--cw-text-muted); font-size: 10px; letter-spacing: .07em; text-transform: uppercase; }
.task-header button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: var(--cw-radius-sm); background: transparent; color: var(--cw-text-muted); cursor: pointer; }
.task-header button:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }
.agent-body { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 10px; overflow: auto; padding: 12px; }
.empty-state { margin: 18px 8px; color: var(--cw-text-muted); font-size: 12px; line-height: 1.55; text-align: center; }
.model-guide { display: grid; gap: 10px; justify-items: center; }
.path-meta { margin: 0; color: var(--cw-text-muted); font-size: 11px; line-height: 1.5; }
.status-error { margin: 0; color: #f0a8a8; font-size: 12px; }
.agent-form { display: grid; gap: 8px; }
.agent-form select,
.agent-form textarea { width: 100%; padding: 8px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-primary); font-size: 12px; }
.agent-form textarea { min-height: 72px; resize: vertical; }
.action-row { display: flex; flex-wrap: wrap; gap: 8px; }
.primary-action,
.secondary-action { min-height: 32px; border-radius: var(--cw-radius-sm); cursor: pointer; font-size: 12px; font-weight: 650; }
.primary-action { padding: 0 12px; border: 0; background: var(--cw-accent); color: var(--cw-accent-ink); }
.secondary-action { padding: 0 10px; border: 1px solid var(--cw-border-strong); background: var(--cw-surface-raised); color: var(--cw-text-primary); }
.primary-action:disabled,
.secondary-action:disabled { opacity: .55; cursor: not-allowed; }
.preview-body { min-height: 140px; max-height: 220px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-secondary); font-size: 12px; white-space: pre-wrap; }
.write-preview { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--cw-border-subtle); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
