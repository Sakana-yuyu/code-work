<script setup>
import { ref } from "vue";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

const props = defineProps({
  activities: { type: Array, required: true },
  activeActivity: { type: String, required: true },
});

const emit = defineEmits(["select"]);
const buttons = ref([]);

function select(activityID) {
  emit("select", activityID);
}

function moveFocus(event, index) {
  const key = event.key;
  const last = props.activities.length - 1;
  let target = index;
  if (key === "ArrowDown" || key === "ArrowRight") target = index === last ? 0 : index + 1;
  else if (key === "ArrowUp" || key === "ArrowLeft") target = index === 0 ? last : index - 1;
  else if (key === "Home") target = 0;
  else if (key === "End") target = last;
  else return;

  event.preventDefault();
  select(props.activities[target].id);
  buttons.value[target]?.focus();
}
</script>

<template>
  <nav class="activity-rail" aria-label="工作台主导航">
    <button
      v-for="(activity, index) in activities"
      :key="activity.id"
      :ref="(element) => { buttons[index] = element }"
      type="button"
      class="activity-button"
      :class="{ active: activeActivity === activity.id }"
      :aria-label="activity.label"
      :aria-current="activeActivity === activity.id ? 'page' : undefined"
      :title="activity.shortcut ? `${activity.label} (${activity.shortcut})` : activity.label"
      @click="select(activity.id)"
      @keydown="moveFocus($event, index)"
    >
      <WorkbenchGlyph :name="activity.id" :size="20" />
    </button>
  </nav>
</template>

<style scoped>
.activity-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: var(--cw-activity-width);
  padding: 8px 0;
  border-right: 1px solid var(--cw-border-subtle);
  background: var(--cw-surface-titlebar);
}

.activity-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: var(--cw-radius-sm);
  background: transparent;
  color: var(--cw-text-muted);
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease;
}

.activity-button:hover {
  background: var(--cw-surface-hover);
  color: var(--cw-text-primary);
}

.activity-button.active {
  color: var(--cw-text-primary);
}

.activity-button.active::before {
  position: absolute;
  left: -6px;
  width: 2px;
  height: 22px;
  border-radius: 2px;
  background: var(--cw-accent);
  content: "";
}

@media (max-width: 800px) {
  .activity-rail {
    z-index: 2;
    flex-direction: row;
    width: 100%;
    min-height: 44px;
    padding: 4px 8px;
    border-right: 0;
    border-bottom: 1px solid var(--cw-border-subtle);
  }

  .activity-button.active::before {
    bottom: -5px;
    left: 7px;
    width: 22px;
    height: 2px;
  }
}
</style>
