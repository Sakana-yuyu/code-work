<script setup>
import { computed, onMounted, ref } from "vue";
import { runtimeIsMacOS, runtimeWindow } from "@/services/runtimeAdapter";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

defineProps({
  title: { type: String, default: "Code Work" },
});

const emit = defineEmits(["command"]);
const isMaximised = ref(false);
const showWindowControls = computed(() => !runtimeIsMacOS);

async function refreshMaximisedState() {
  try {
    isMaximised.value = Boolean(await runtimeWindow.IsMaximised());
  } catch {
    isMaximised.value = false;
  }
}

async function minimize() {
  await runtimeWindow.Minimise();
}

async function toggleMaximise() {
  await runtimeWindow.ToggleMaximise();
  await refreshMaximisedState();
}

async function close() {
  await runtimeWindow.Close();
}

onMounted(() => {
  void refreshMaximisedState();
});
</script>

<template>
  <header class="title-bar" style="--wails-draggable: drag">
    <div class="title-bar-start">
      <span class="product-mark" aria-hidden="true"><WorkbenchGlyph name="workbench" :size="17" /></span>
      <span class="product-name">Code Work</span>
      <span class="title-context">{{ title }}</span>
      <button
        type="button"
        class="menu-trigger"
        style="--wails-draggable: no-drag"
        aria-label="打开设置"
        title="设置"
        @click="emit('command', 'open-settings')"
      >
        <WorkbenchGlyph name="settings" :size="16" />
      </button>
      <button type="button" class="menu-trigger" style="--wails-draggable: no-drag" aria-label="打开工作台菜单" @click="emit('command', 'open-command')">
        <WorkbenchGlyph name="menu" :size="17" />
      </button>
    </div>

    <button type="button" class="command-trigger" style="--wails-draggable: no-drag" aria-label="打开命令面板" @click="emit('command', 'open-command')">
      <WorkbenchGlyph name="command" :size="15" />
      <span>搜索命令、页面与功能</span>
      <kbd>Ctrl Shift P</kbd>
    </button>

    <div v-if="showWindowControls" class="window-controls" style="--wails-draggable: no-drag">
      <button type="button" aria-label="最小化窗口" title="最小化" @click="minimize"><WorkbenchGlyph name="minimize" :size="18" /></button>
      <button type="button" :aria-label="isMaximised ? '还原窗口' : '最大化窗口'" :title="isMaximised ? '还原' : '最大化'" @click="toggleMaximise">
        <WorkbenchGlyph :name="isMaximised ? 'restore' : 'maximize'" :size="15" />
      </button>
      <button type="button" class="close-window" aria-label="关闭窗口" title="关闭" @click="close"><WorkbenchGlyph name="close" :size="19" /></button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  position: relative;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(240px, 430px) minmax(180px, 1fr);
  align-items: center;
  min-height: var(--cw-titlebar-height);
  padding-left: 12px;
  border-bottom: 1px solid var(--cw-border-subtle);
  background: var(--cw-surface-titlebar);
  color: var(--cw-text-secondary);
}

.title-bar-start,
.window-controls {
  display: flex;
  align-items: center;
}

.title-bar-start { gap: 8px; min-width: 0; }
.product-mark { color: var(--cw-accent); }
.product-name { color: var(--cw-text-primary); font-size: 12px; font-weight: 650; letter-spacing: 0.02em; white-space: nowrap; }
.title-context { max-width: 130px; overflow: hidden; color: var(--cw-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.menu-trigger,
.window-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--cw-text-muted);
  cursor: pointer;
}

.menu-trigger { width: 28px; height: 26px; border-radius: var(--cw-radius-sm); }
.menu-trigger:hover,
.window-controls button:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }

.command-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--cw-border-subtle);
  border-radius: var(--cw-radius-sm);
  background: color-mix(in srgb, var(--cw-surface-workbench) 78%, transparent);
  color: var(--cw-text-muted);
  cursor: pointer;
  text-align: left;
}

.command-trigger:hover { border-color: var(--cw-border-strong); color: var(--cw-text-secondary); }
.command-trigger span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
kbd { border: 1px solid var(--cw-border-subtle); border-radius: 3px; padding: 1px 4px; color: var(--cw-text-muted); font: 10px var(--cw-font-mono); white-space: nowrap; }

.window-controls { justify-content: flex-end; align-self: stretch; }
.window-controls button { width: 42px; height: 100%; }
.window-controls .close-window:hover { background: #bb4254; color: #fff; }

@media (max-width: 800px) {
  .title-bar { grid-template-columns: 1fr auto; }
  .command-trigger { display: none; }
}
</style>
