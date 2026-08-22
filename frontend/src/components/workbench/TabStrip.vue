<script setup>
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

defineProps({
  tabs: { type: Array, required: true },
  activeId: { type: String, required: true },
});

const emit = defineEmits(["select", "close"]);
</script>

<template>
  <div class="tab-strip" role="tablist" aria-label="打开的工作区页面">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab-shell"
      :class="{ active: activeId === tab.id }"
    >
      <button
        type="button"
        role="tab"
        class="workbench-tab"
        :aria-selected="activeId === tab.id"
        :tabindex="activeId === tab.id ? 0 : -1"
        @click="emit('select', tab.id)"
      >
        <WorkbenchGlyph :name="tab.icon" :size="14" />
        <span class="tab-label">{{ tab.label }}</span>
      </button>
      <button
        v-if="tab.closable"
        type="button"
        class="tab-close"
        :aria-label="`关闭 ${tab.label}`"
        @click="emit('close', tab.id)"
      >
        <WorkbenchGlyph name="close" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tab-strip { display: flex; min-width: 0; min-height: 35px; overflow-x: auto; border-bottom: 1px solid var(--cw-border-subtle); background: var(--cw-surface-titlebar); }
.tab-shell { display: flex; align-items: center; min-width: 132px; max-width: 220px; height: 35px; border-right: 1px solid var(--cw-border-subtle); border-top: 1px solid transparent; background: transparent; color: var(--cw-text-secondary); }
.tab-shell:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }
.tab-shell.active { border-top-color: var(--cw-accent); background: var(--cw-surface-workbench); color: var(--cw-text-primary); }
.workbench-tab { display: inline-flex; align-items: center; gap: 7px; min-width: 0; flex: 1; height: 100%; padding: 0 5px 0 12px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.tab-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin-right: 4px; border: 0; border-radius: 3px; background: transparent; color: var(--cw-text-muted); cursor: pointer; }
.tab-close:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }
</style>
