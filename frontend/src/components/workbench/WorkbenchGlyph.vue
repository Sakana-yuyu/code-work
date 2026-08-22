<script setup>
import { computed } from "vue";

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
});

const glyphs = {
  workbench: "✦",
  explorer: "▧",
  search: "⌕",
  "source-control": "⑂",
  extensions: "◫",
  settings: "⚙",
  menu: "☰",
  command: "⌘",
  panel: "▤",
  "panel-right": "▥",
  close: "×",
  minimize: "−",
  maximize: "□",
  restore: "▣",
  folder: "▱",
  file: "▤",
  service: "◉",
  chart: "◒",
  shield: "◇",
  arrow: "›",
  plus: "+",
  check: "✓",
  stop: "■",
  refresh: "↻",
};

const glyph = computed(() => glyphs[props.name] || "•");
</script>

<template>
  <span class="workbench-glyph" :style="{ '--glyph-size': `${size}px` }" aria-hidden="true">{{ glyph }}</span>
</template>

<style scoped>
.workbench-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  font-family: var(--cw-font-ui);
  font-size: var(--glyph-size);
  font-weight: 500;
  line-height: 1;
  user-select: none;
}
</style>
