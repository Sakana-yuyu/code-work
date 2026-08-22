<script setup>
import { computed, nextTick, ref, watch } from "vue";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

const props = defineProps({
  visible: { type: Boolean, required: true },
  commands: { type: Array, required: true },
});

const emit = defineEmits(["close", "run"]);
const input = ref(null);
const query = ref("");
const selectedIndex = ref(0);

const results = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.commands;
  return props.commands.filter((command) => `${command.label} ${command.detail || ""}`.toLowerCase().includes(needle));
});

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    query.value = "";
    selectedIndex.value = 0;
    await nextTick();
    input.value?.focus();
  },
);

watch(results, (items) => {
  if (selectedIndex.value >= items.length) selectedIndex.value = Math.max(0, items.length - 1);
});

function execute(command) {
  if (!command) return;
  emit("run", command.id);
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectedIndex.value = results.value.length ? (selectedIndex.value + 1) % results.value.length : 0;
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectedIndex.value = results.value.length ? (selectedIndex.value - 1 + results.value.length) % results.value.length : 0;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    execute(results.value[selectedIndex.value]);
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="palette-backdrop" @mousedown.self="emit('close')">
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="命令面板" @keydown="handleKeydown">
        <label class="palette-input-wrap" for="command-palette-input">
          <WorkbenchGlyph name="command" :size="18" />
          <input id="command-palette-input" ref="input" v-model="query" type="text" autocomplete="off" placeholder="输入命令或功能名称" />
          <kbd>Esc</kbd>
        </label>
        <div class="palette-results" role="listbox" aria-label="可用命令">
          <button
            v-for="(command, index) in results"
            :key="command.id"
            type="button"
            role="option"
            :aria-selected="index === selectedIndex"
            :class="{ selected: index === selectedIndex }"
            @mouseenter="selectedIndex = index"
            @click="execute(command)"
          >
            <span><strong>{{ command.label }}</strong><small v-if="command.detail">{{ command.detail }}</small></span>
            <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
          </button>
          <p v-if="results.length === 0">没有匹配的命令。</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; justify-content: center; padding-top: min(18vh, 150px); background: rgba(4, 6, 10, .56); backdrop-filter: blur(4px); }
.command-palette { width: min(680px, calc(100vw - 32px)); max-height: min(520px, calc(100vh - 64px)); overflow: hidden; border: 1px solid var(--cw-border-strong); border-radius: 9px; background: var(--cw-surface-overlay); box-shadow: var(--cw-shadow-overlay); }
.palette-input-wrap { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 14px; border-bottom: 1px solid var(--cw-border-subtle); color: var(--cw-accent); }
.palette-input-wrap input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--cw-text-primary); font-size: 14px; }
kbd { border: 1px solid var(--cw-border-subtle); border-radius: 3px; padding: 2px 5px; color: var(--cw-text-muted); font: 10px var(--cw-font-mono); white-space: nowrap; }
.palette-results { max-height: 440px; overflow-y: auto; padding: 6px; }
.palette-results button { display: flex; align-items: center; justify-content: space-between; gap: 20px; width: 100%; min-height: 50px; padding: 8px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--cw-text-secondary); cursor: pointer; text-align: left; }
.palette-results button.selected, .palette-results button:hover { background: var(--cw-surface-active); color: var(--cw-text-primary); }
.palette-results span { display: grid; gap: 3px; min-width: 0; }
.palette-results strong { font-size: 12px; font-weight: 650; }
.palette-results small, .palette-results p { color: var(--cw-text-muted); font-size: 11px; }
.palette-results p { margin: 16px; text-align: center; }
</style>
