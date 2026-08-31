<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { appState } from "@/state/appState";
import CommandPalette from "@/components/workbench/CommandPalette.vue";
import StatusBar from "@/components/workbench/StatusBar.vue";
import TitleBar from "@/components/workbench/TitleBar.vue";

const route = useRoute();
const router = useRouter();
const commandPaletteVisible = ref(false);
let paletteOpener = null;

const currentTitle = computed(() => String(route.meta?.workbenchLabel || route.meta?.title || "Code Work").split(/[｜|]/)[0].trim() || "Code Work");
const serviceRunning = computed(() => Boolean(appState.serviceRunning));

const commands = computed(() => [
  { id: "open-service", label: "打开服务设置", detail: "管理本地服务与运行状态", shortcut: "" },
  { id: "open-model-config", label: "打开模型配置", detail: "管理模型与供应商", shortcut: "" },
  { id: "open-control-center", label: "打开控制中心", detail: "路由、实验与 Agent 运行台", shortcut: "" },
  { id: "open-settings", label: "打开设置", detail: "调整应用与集成偏好", shortcut: "" },
]);

function openCommandPalette() {
  if (typeof document !== "undefined") paletteOpener = document.activeElement;
  commandPaletteVisible.value = true;
}

function closeCommandPalette() {
  commandPaletteVisible.value = false;
  void nextTick(() => paletteOpener?.focus?.());
}

function runCommand(command) {
  switch (command) {
    case "open-command":
      openCommandPalette();
      return;
    case "open-service":
      void router.push("/settings?category=cursor-service");
      break;
    case "open-model-config":
      void router.push("/model-config");
      break;
    case "open-control-center":
      void router.push("/control-center");
      break;
    case "open-settings":
      void router.push("/settings");
      break;
    default:
      break;
  }
  closeCommandPalette();
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && commandPaletteVisible.value) {
    event.preventDefault();
    closeCommandPalette();
    return;
  }
  if (isEditableTarget(event.target)) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (event.key.toLowerCase() === "p" && event.shiftKey) {
    event.preventDefault();
    openCommandPalette();
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleGlobalKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>

<template>
  <div class="workbench-shell">
    <TitleBar :title="currentTitle" @command="runCommand" />
    <div class="workbench-body">
      <main class="workbench-content" aria-label="Code Work 主工作区">
        <div class="workbench-page" role="tabpanel" :aria-label="currentTitle">
          <router-view />
        </div>
      </main>
    </div>
    <StatusBar
      :service-running="serviceRunning"
      :sidebar-visible="false"
      :task-panel-visible="false"
      @open-command="openCommandPalette"
    />
    <CommandPalette :visible="commandPaletteVisible" :commands="commands" @close="closeCommandPalette" @run="runCommand" />
  </div>
</template>

<style scoped>
.workbench-shell { display: grid; width: 100vw; height: 100vh; overflow: hidden; grid-template-rows: var(--cw-titlebar-height) minmax(0, 1fr) var(--cw-statusbar-height); background: var(--cw-surface-workbench); color: var(--cw-text-primary); font-family: var(--cw-font-ui); }
.workbench-body { display: flex; min-width: 0; min-height: 0; flex: 1; overflow: hidden; }
.workbench-content { display: grid; min-width: 0; min-height: 0; flex: 1; overflow: hidden; background: var(--cw-surface-workbench); }
.workbench-page { display: flex; min-width: 0; min-height: 0; overflow: auto; }
.workbench-page :deep(> *) { min-width: 0; min-height: 0; flex: 1; }
.workbench-page :deep(.w-screen) { width: 100% !important; }
.workbench-page :deep(.h-screen) { height: 100% !important; }
</style>
