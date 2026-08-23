<script setup>
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

defineProps({
  serviceRunning: { type: Boolean, default: false },
  sidebarVisible: { type: Boolean, required: true },
  taskPanelVisible: { type: Boolean, required: true },
});

const emit = defineEmits(["toggle-sidebar", "toggle-task", "open-command"]);
</script>

<template>
  <footer class="status-bar" aria-label="工作台状态栏">
    <div class="status-group">
      <span class="service-state" :class="{ running: serviceRunning }"><WorkbenchGlyph name="service" :size="12" />{{ serviceRunning ? "本地服务运行中" : "本地服务未启动" }}</span>
      <span class="status-copy">Code Work · 独立数据目录</span>
    </div>
    <div class="status-actions">
      <button type="button" :aria-pressed="sidebarVisible" title="切换主侧栏 (Ctrl+B)" @click="emit('toggle-sidebar')"><WorkbenchGlyph name="panel" :size="14" /><span>侧栏</span></button>
      <button type="button" :aria-pressed="taskPanelVisible" title="切换 AI 栏 (Ctrl+L)" @click="emit('toggle-task')"><WorkbenchGlyph name="panel-right" :size="14" /><span>AI</span></button>
      <button type="button" title="打开命令面板 (Ctrl+Shift+P)" @click="emit('open-command')"><WorkbenchGlyph name="command" :size="14" /></button>
    </div>
  </footer>
</template>

<style scoped>
.status-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--cw-statusbar-height); padding: 0 8px 0 10px; border-top: 1px solid color-mix(in srgb, var(--cw-accent) 20%, var(--cw-border-subtle)); background: #15233a; color: #c4d8ff; font-size: 10px; }
.status-group, .status-actions, .service-state { display: flex; align-items: center; gap: 8px; min-width: 0; }
.service-state { color: var(--cw-warning); white-space: nowrap; }
.service-state.running { color: var(--cw-success); }
.status-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9eb7e4; }
.status-actions { margin-left: auto; }
.status-actions button { display: inline-flex; align-items: center; gap: 4px; min-height: 20px; padding: 0 4px; border: 0; border-radius: 3px; background: transparent; color: inherit; cursor: pointer; }
.status-actions button:hover { background: rgba(255,255,255,.12); color: #fff; }
@media (max-width: 640px) { .status-copy, .status-actions span { display: none; } }
</style>
