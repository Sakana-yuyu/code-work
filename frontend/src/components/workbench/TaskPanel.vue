<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

const emit = defineEmits(["close"]);
const draft = ref("");
const tasks = ref([]);
const timers = new Map();
const taskCounter = ref(0);

const hasTasks = computed(() => tasks.value.length > 0);

function clearTaskTimers(id) {
  for (const timer of timers.get(id) || []) window.clearTimeout(timer);
  timers.delete(id);
}

function submitTask() {
  const prompt = draft.value.trim();
  if (!prompt) return;
  const id = ++taskCounter.value;
  tasks.value.unshift({ id, prompt, status: "queued" });
  draft.value = "";
  const running = window.setTimeout(() => {
    const task = tasks.value.find((item) => item.id === id);
    if (task) task.status = "working";
  }, 260);
  const completed = window.setTimeout(() => {
    const task = tasks.value.find((item) => item.id === id);
    if (task && task.status !== "cancelled") task.status = "completed";
    clearTaskTimers(id);
  }, 920);
  timers.set(id, [running, completed]);
}

function cancelTask(id) {
  const task = tasks.value.find((item) => item.id === id);
  if (!task || task.status === "completed") return;
  task.status = "cancelled";
  clearTaskTimers(id);
}

function statusLabel(status) {
  return { queued: "排队中", working: "演示中", completed: "已完成", cancelled: "已取消" }[status] || status;
}

onBeforeUnmount(() => {
  for (const id of timers.keys()) clearTaskTimers(id);
});
</script>

<template>
  <aside class="task-panel" aria-label="任务面板">
    <header class="task-header">
      <div>
        <p>任务</p>
        <span>Shell 演示</span>
      </div>
      <button type="button" aria-label="隐藏任务面板" title="隐藏任务面板" @click="emit('close')"><WorkbenchGlyph name="panel-right" :size="17" /></button>
    </header>

    <div class="task-notice">
      <WorkbenchGlyph name="shield" :size="15" />
      <p>此面板仅演示 Workbench 交互，不读取工作区、不运行 Agent，也不会调用远程模型。</p>
    </div>

    <form class="task-form" @submit.prevent="submitTask">
      <label for="shell-task-input">新建演示任务</label>
      <textarea id="shell-task-input" v-model="draft" rows="3" placeholder="例如：整理下一步工作" />
      <button type="submit" :disabled="!draft.trim()"><WorkbenchGlyph name="plus" :size="16" /> 添加演示任务</button>
    </form>

    <div class="task-list" aria-live="polite" aria-label="演示任务列表">
      <p v-if="!hasTasks" class="empty-task">尚无演示任务。</p>
      <article v-for="task in tasks" :key="task.id" class="task-item" :data-status="task.status">
        <div class="task-item-top">
          <span class="task-status"><WorkbenchGlyph :name="task.status === 'completed' ? 'check' : task.status === 'cancelled' ? 'stop' : 'refresh'" :size="14" /> {{ statusLabel(task.status) }}</span>
          <button v-if="task.status === 'queued' || task.status === 'working'" type="button" @click="cancelTask(task.id)">取消</button>
        </div>
        <p>{{ task.prompt }}</p>
        <small v-if="task.status === 'completed'">已完成演示流程；未执行外部操作。</small>
      </article>
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
.task-notice { display: flex; gap: 8px; margin: 12px; padding: 9px; border: 1px solid color-mix(in srgb, var(--cw-accent) 28%, var(--cw-border-subtle)); border-radius: var(--cw-radius-md); background: color-mix(in srgb, var(--cw-accent) 8%, transparent); color: var(--cw-text-secondary); }
.task-notice p { margin: 0; font-size: 11px; line-height: 1.45; }
.task-notice > span { flex: 0 0 auto; color: var(--cw-accent); }
.task-form { display: grid; gap: 7px; padding: 0 12px 12px; border-bottom: 1px solid var(--cw-border-subtle); }
.task-form label { color: var(--cw-text-secondary); font-size: 11px; font-weight: 600; }
.task-form textarea { resize: vertical; min-height: 58px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-primary); padding: 7px; font-size: 12px; outline: 0; }
.task-form textarea:focus { border-color: var(--cw-accent); }
.task-form button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 29px; border: 0; border-radius: var(--cw-radius-sm); background: var(--cw-accent); color: var(--cw-accent-ink); cursor: pointer; font-size: 11px; font-weight: 700; }
.task-form button:disabled { cursor: not-allowed; opacity: .45; }
.task-list { display: grid; gap: 8px; overflow-y: auto; padding: 12px; }
.empty-task { margin: 8px 0; color: var(--cw-text-muted); font-size: 12px; text-align: center; }
.task-item { padding: 9px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-md); background: var(--cw-surface-raised); }
.task-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-status { display: inline-flex; align-items: center; gap: 5px; color: var(--cw-text-secondary); font-size: 10px; }
.task-item[data-status="completed"] .task-status { color: var(--cw-success); }
.task-item[data-status="cancelled"] .task-status { color: var(--cw-danger); }
.task-item button { border: 0; border-radius: 3px; background: transparent; color: var(--cw-text-muted); cursor: pointer; font-size: 10px; }
.task-item button:hover { color: var(--cw-danger); }
.task-item p { margin: 7px 0 0; color: var(--cw-text-primary); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.task-item small { display: block; margin-top: 6px; color: var(--cw-text-muted); font-size: 10px; line-height: 1.4; }
</style>
