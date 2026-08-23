<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";
import {
  cancelDelegationTask,
  getDelegationTaskSnapshots,
  getMCPRuntimeServers,
} from "@/services/runtimeControlApi";
import { toUserError } from "@/state/appState";

const emit = defineEmits(["close"]);

const taskState = reactive({ busy: false, error: "", items: [] });
const mcpState = reactive({ busy: false, error: "", items: [] });
const cancelingTasks = reactive({});
const disposed = ref(false);
let pollTimer = 0;
let taskGeneration = 0;

const taskItems = computed(() => [...taskState.items].sort((left, right) => {
  return Number(right.queuedAtUnixMs || right.queuedAtUnixMS || 0)
    - Number(left.queuedAtUnixMs || left.queuedAtUnixMS || 0);
}));
const hasTasks = computed(() => taskItems.value.length > 0);
const mcpItems = computed(() => mcpState.items || []);

const taskStatusLabels = {
  queued: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  timed_out: "超时",
};

const mcpStatusLabels = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  degraded: "已降级",
  error: "错误",
};

const executorNames = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex CLI",
  "gemini-cli": "Gemini CLI",
  "kiro-cli": "Kiro CLI",
  "cursor-agent": "Cursor Agent",
  "local-byok": "本地 BYOK",
};

const attemptStatusLabels = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  timed_out: "超时",
};

function statusGlyph(status) {
  if (status === "completed") return "check";
  if (status === "canceled" || status === "failed" || status === "timed_out") return "stop";
  return "refresh";
}

function executorLabel(id) {
  const key = String(id || "").trim();
  return executorNames[key] || key || "未知执行器";
}

function attemptLines(task) {
  return Array.isArray(task?.attempts) ? task.attempts : [];
}

async function refreshTasks() {
  if (disposed.value || taskState.busy) return;
  const generation = taskGeneration;
  taskState.busy = true;
  try {
    const items = await getDelegationTaskSnapshots();
    if (disposed.value || generation !== taskGeneration) return;
    taskState.items = Array.isArray(items) ? items : [];
    taskState.error = "";
  } catch (error) {
    if (!disposed.value && generation === taskGeneration) {
      taskState.error = toUserError(error);
    }
  } finally {
    if (!disposed.value && generation === taskGeneration) taskState.busy = false;
  }
}

async function refreshMCP() {
  if (disposed.value || mcpState.busy) return;
  mcpState.busy = true;
  try {
    const items = await getMCPRuntimeServers("");
    if (disposed.value) return;
    mcpState.items = Array.isArray(items) ? items : [];
    mcpState.error = "";
  } catch (error) {
    if (!disposed.value) mcpState.error = toUserError(error);
  } finally {
    if (!disposed.value) mcpState.busy = false;
  }
}

async function refreshAll() {
  await Promise.all([refreshTasks(), refreshMCP()]);
}

async function handleCancel(task) {
  if (!task?.id || cancelingTasks[task.id]) return;
  cancelingTasks[task.id] = true;
  taskGeneration += 1;
  try {
    const canceled = await cancelDelegationTask(task.id);
    if (!canceled) throw new Error("任务已结束或不存在");
    taskGeneration += 1;
    await refreshTasks();
  } catch (error) {
    taskState.error = toUserError(error);
  } finally {
    delete cancelingTasks[task.id];
  }
}

onMounted(() => {
  void refreshAll();
  pollTimer = window.setInterval(() => {
    void refreshAll();
  }, 2000);
});

onBeforeUnmount(() => {
  disposed.value = true;
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <aside class="task-panel" aria-label="任务面板">
    <header class="task-header">
      <div>
        <p>任务</p>
        <span>委派活动</span>
      </div>
      <button type="button" aria-label="隐藏任务面板" title="隐藏任务面板" @click="emit('close')"><WorkbenchGlyph name="panel-right" :size="17" /></button>
    </header>

    <div class="task-notice">
      <WorkbenchGlyph name="shield" :size="15" />
      <p>此面板展示真实委派快照、attempts 与 MCP 状态，不会创建演示任务。</p>
    </div>

    <p v-if="taskState.error" class="task-error" role="alert">{{ taskState.error }}</p>

    <div class="task-list" aria-live="polite" aria-label="委派任务列表">
      <p v-if="!hasTasks && !taskState.busy" class="empty-task">当前没有委派任务。</p>
      <article v-for="task in taskItems" :key="task.id" class="task-item" :data-status="task.status">
        <div class="task-item-top">
          <span class="task-status">
            <WorkbenchGlyph :name="statusGlyph(task.status)" :size="14" />
            {{ taskStatusLabels[task.status] || task.status }}
          </span>
          <button
            v-if="task.cancelable"
            type="button"
            :disabled="Boolean(cancelingTasks[task.id])"
            @click="handleCancel(task)"
          >
            {{ cancelingTasks[task.id] ? "取消中" : "取消" }}
          </button>
        </div>
        <p>{{ task.description || "无描述" }}</p>
        <small v-if="task.modelName">{{ task.modelName }} · {{ task.executionMode || "local" }}</small>
        <small v-if="task.progressSummary">{{ task.progressSummary }}</small>
        <ul v-if="attemptLines(task).length" class="attempt-list" aria-label="执行尝试">
          <li v-for="attempt in attemptLines(task)" :key="`${task.id}-${attempt.executorId}-${attempt.attempt}`">
            {{ executorLabel(attempt.executorId) }} #{{ attempt.attempt }} · {{ attemptStatusLabels[attempt.status] || attempt.status }}
          </li>
        </ul>
      </article>
    </div>

    <section class="mcp-section" aria-label="MCP 状态">
      <h2>MCP 状态</h2>
      <p v-if="mcpState.error" class="task-error" role="alert">{{ mcpState.error }}</p>
      <p v-else-if="!mcpItems.length" class="empty-task">当前没有 MCP 服务器。</p>
      <ul v-else class="mcp-list">
        <li v-for="server in mcpItems" :key="server.identifier || server.name" :data-status="server.status">
          <span>{{ server.name || server.identifier }}</span>
          <small>{{ mcpStatusLabels[server.status] || server.status || "未知" }}</small>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.task-panel { display: flex; min-width: 0; flex-direction: column; overflow: hidden; border-left: 1px solid var(--cw-border-subtle); background: var(--cw-surface-sidebar); }
.task-header { display: flex; align-items: center; justify-content: space-between; min-height: 61px; padding: 12px 12px 10px 15px; border-bottom: 1px solid var(--cw-border-subtle); }
.task-header p { margin: 0; color: var(--cw-text-primary); font-size: 13px; font-weight: 650; }
.task-header span { color: var(--cw-text-muted); font-size: 10px; letter-spacing: .07em; text-transform: uppercase; }
.task-header button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: var(--cw-radius-sm); background: transparent; color: var(--cw-text-muted); cursor: pointer; }
.task-header button:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }
.task-notice { display: flex; gap: 8px; margin: 12px; padding: 9px; border: 1px solid color-mix(in srgb, var(--cw-accent) 28%, var(--cw-border-subtle)); border-radius: var(--cw-radius-md); background: color-mix(in srgb, var(--cw-accent) 8%, transparent); color: var(--cw-text-secondary); }
.task-notice p { margin: 0; font-size: 11px; line-height: 1.45; }
.task-notice > span { flex: 0 0 auto; color: var(--cw-accent); }
.task-error { margin: 0 12px 8px; color: var(--cw-danger); font-size: 11px; }
.task-list { display: grid; gap: 8px; overflow-y: auto; padding: 12px; }
.empty-task { margin: 8px 0; color: var(--cw-text-muted); font-size: 12px; text-align: center; }
.task-item { padding: 9px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-md); background: var(--cw-surface-raised); }
.task-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-status { display: inline-flex; align-items: center; gap: 5px; color: var(--cw-text-secondary); font-size: 10px; }
.task-item[data-status="completed"] .task-status { color: var(--cw-success); }
.task-item[data-status="canceled"] .task-status,
.task-item[data-status="failed"] .task-status,
.task-item[data-status="timed_out"] .task-status { color: var(--cw-danger); }
.task-item[data-status="running"] .task-status { color: var(--cw-accent); }
.task-item button { border: 0; border-radius: 3px; background: transparent; color: var(--cw-text-muted); cursor: pointer; font-size: 10px; }
.task-item button:hover:not(:disabled) { color: var(--cw-danger); }
.task-item button:disabled { cursor: not-allowed; opacity: .55; }
.task-item p { margin: 7px 0 0; color: var(--cw-text-primary); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.task-item small { display: block; margin-top: 6px; color: var(--cw-text-muted); font-size: 10px; line-height: 1.4; }
.attempt-list { margin: 8px 0 0; padding-left: 16px; color: var(--cw-text-secondary); font-size: 10px; }
.mcp-section { padding: 0 12px 12px; border-top: 1px solid var(--cw-border-subtle); }
.mcp-section h2 { margin: 10px 0 8px; color: var(--cw-text-primary); font-size: 11px; font-weight: 650; }
.mcp-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.mcp-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 8px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-raised); color: var(--cw-text-primary); font-size: 11px; }
.mcp-list small { color: var(--cw-text-muted); font-size: 10px; }
.mcp-list li[data-status="connected"] small { color: var(--cw-success); }
.mcp-list li[data-status="error"] small { color: var(--cw-danger); }
</style>
