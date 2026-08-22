<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { appState } from "@/state/appState";
import {
  removeWorkbenchTab,
  resetWorkbenchLayout,
  selectWorkbenchActivity,
  syncWorkbenchTab,
  toggleWorkbenchSidebar,
  toggleWorkbenchTaskPanel,
  workbenchActivities,
  workbenchState,
} from "@/state/workbenchState";
import ActivityRail from "@/components/workbench/ActivityRail.vue";
import CommandPalette from "@/components/workbench/CommandPalette.vue";
import PrimarySidebar from "@/components/workbench/PrimarySidebar.vue";
import StatusBar from "@/components/workbench/StatusBar.vue";
import TabStrip from "@/components/workbench/TabStrip.vue";
import TaskPanel from "@/components/workbench/TaskPanel.vue";
import TitleBar from "@/components/workbench/TitleBar.vue";

const route = useRoute();
const router = useRouter();
const commandPaletteVisible = ref(false);
const compactLayout = ref(false);
let paletteOpener = null;

const workbenchStyle = computed(() => ({
  "--cw-sidebar-current": workbenchState.sidebarVisible ? "var(--cw-sidebar-width)" : "0px",
  "--cw-task-current": workbenchState.taskPanelVisible ? "var(--cw-task-width)" : "0px",
}));
const currentTitle = computed(() => String(route.meta?.workbenchLabel || route.meta?.title || "Code Work").split(/[｜|]/)[0].trim() || "Code Work");
const serviceRunning = computed(() => Boolean(appState.serviceRunning));

const commands = computed(() => [
  { id: "open-service", label: "打开服务控制台", detail: "管理本地服务与运行状态", shortcut: "" },
  { id: "open-model-config", label: "打开模型配置", detail: "管理模型与供应商", shortcut: "" },
  { id: "open-control-center", label: "打开控制中心", detail: "路由、实验与 Agent 运行台", shortcut: "" },
  { id: "open-settings", label: "打开设置", detail: "调整应用与集成偏好", shortcut: "" },
  { id: "toggle-sidebar", label: "切换主侧栏", detail: "显示或隐藏左侧功能入口", shortcut: "Ctrl+B" },
  { id: "toggle-task", label: "切换任务面板", detail: "显示或隐藏 Shell 演示任务", shortcut: "Ctrl+J" },
  { id: "focus-explorer", label: "聚焦资源管理器", detail: "选择工作区导航", shortcut: "" },
  { id: "open-welcome", label: "打开开始页面", detail: "返回 Workbench 欢迎页", shortcut: "" },
  { id: "reset-layout", label: "重置 Workbench 布局", detail: "恢复默认侧栏和任务面板", shortcut: "" },
]);

function isWelcomeRoute() {
  if (route.path === "/workbench") return true;
  if (typeof window === "undefined") return false;
  return window.location.pathname.endsWith("/workbench") || window.location.hash === "#/workbench";
}

watch(
  () => route.fullPath,
  () => {
    syncWorkbenchTab(route);
    if (!isWelcomeRoute()) {
      workbenchState.sidebarVisible = false;
      workbenchState.taskPanelVisible = false;
    }
  },
  { immediate: true },
);

function navigate(path) {
  if (compactLayout.value) {
    workbenchState.sidebarVisible = false;
    workbenchState.taskPanelVisible = false;
  }
  void router.push(path);
}

function updateCompactLayout() {
  const nextCompact = window.innerWidth <= 800;
  if (nextCompact && !compactLayout.value) {
    workbenchState.sidebarVisible = false;
    workbenchState.taskPanelVisible = false;
  }
  compactLayout.value = nextCompact;
}

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
      navigate("/");
      break;
    case "open-model-config":
      navigate("/model-config");
      break;
    case "open-control-center":
      navigate("/control-center");
      break;
    case "open-settings":
      navigate("/settings");
      break;
    case "toggle-sidebar":
      toggleWorkbenchSidebar();
      break;
    case "toggle-task":
      toggleWorkbenchTaskPanel();
      break;
    case "focus-explorer":
      selectWorkbenchActivity("explorer");
      break;
    case "open-welcome":
      navigate("/workbench");
      break;
    case "reset-layout":
      resetWorkbenchLayout();
      break;
    default:
      break;
  }
  closeCommandPalette();
}

function closeTab(id) {
  const fallback = removeWorkbenchTab(id);
  if (route.path === id) navigate(fallback);
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
  const key = event.key.toLowerCase();
  if (key === "b") {
    event.preventDefault();
    toggleWorkbenchSidebar();
  } else if (key === "j") {
    event.preventDefault();
    toggleWorkbenchTaskPanel();
  } else if (key === "p" && event.shiftKey) {
    event.preventDefault();
    openCommandPalette();
  }
}

onMounted(() => {
  updateCompactLayout();
  window.addEventListener("resize", updateCompactLayout);
  window.addEventListener("keydown", handleGlobalKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", updateCompactLayout);
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>

<template>
  <div class="workbench-shell" :style="workbenchStyle" :class="{ 'sidebar-hidden': !workbenchState.sidebarVisible, 'task-hidden': !workbenchState.taskPanelVisible }">
    <TitleBar :title="currentTitle" @command="runCommand" />
    <div class="workbench-body">
      <ActivityRail :activities="workbenchActivities" :active-activity="workbenchState.activeActivity" @select="selectWorkbenchActivity" />
      <div class="workbench-main-row">
        <PrimarySidebar
          v-if="workbenchState.sidebarVisible"
          :active-activity="workbenchState.activeActivity"
          :current-path="route.path"
          @navigate="navigate"
          @close="toggleWorkbenchSidebar"
        />
        <main class="workbench-content" aria-label="Code Work 主工作区">
          <TabStrip :tabs="workbenchState.tabs" :active-id="route.path" @select="navigate" @close="closeTab" />
          <div class="workbench-page" role="tabpanel" :aria-label="currentTitle">
            <router-view />
          </div>
        </main>
        <TaskPanel v-if="workbenchState.taskPanelVisible" @close="toggleWorkbenchTaskPanel" />
      </div>
    </div>
    <StatusBar
      :service-running="serviceRunning"
      :sidebar-visible="workbenchState.sidebarVisible"
      :task-panel-visible="workbenchState.taskPanelVisible"
      @toggle-sidebar="toggleWorkbenchSidebar"
      @toggle-task="toggleWorkbenchTaskPanel"
      @open-command="openCommandPalette"
    />
    <CommandPalette :visible="commandPaletteVisible" :commands="commands" @close="closeCommandPalette" @run="runCommand" />
  </div>
</template>

<style scoped>
.workbench-shell { display: grid; width: 100vw; height: 100vh; overflow: hidden; grid-template-rows: var(--cw-titlebar-height) minmax(0, 1fr) var(--cw-statusbar-height); background: var(--cw-surface-workbench); color: var(--cw-text-primary); font-family: var(--cw-font-ui); }
.workbench-body { display: flex; min-width: 0; min-height: 0; flex: 1; overflow: hidden; }
.workbench-main-row { position: relative; display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; flex: 1; grid-template-columns: var(--cw-sidebar-current) minmax(0, 1fr) var(--cw-task-current); overflow: hidden; transition: grid-template-columns 150ms ease; }
.workbench-main-row :deep(.primary-sidebar) { grid-column: 1; }
.workbench-content { display: grid; grid-column: 2; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--cw-surface-workbench); }
.workbench-main-row :deep(.task-panel) { grid-column: 3; }
.workbench-page { display: flex; min-width: 0; min-height: 0; overflow: auto; }
.workbench-page :deep(> *) { min-width: 0; min-height: 0; flex: 1; }
.workbench-page :deep(.w-screen) { width: 100% !important; }
.workbench-page :deep(.h-screen) { height: 100% !important; }

@media (max-width: 1199px) {
  .workbench-main-row { grid-template-columns: var(--cw-sidebar-current) minmax(0, 1fr); }
  .workbench-main-row :deep(.task-panel) { position: absolute; z-index: 8; top: 0; right: 0; bottom: 0; width: min(var(--cw-task-width), calc(100vw - var(--cw-activity-width) - 28px)); box-shadow: -14px 0 36px rgba(0,0,0,.32); }
}

@media (max-width: 800px) {
  .workbench-shell { grid-template-rows: var(--cw-titlebar-height) minmax(0, 1fr) var(--cw-statusbar-height); }
  .workbench-body { flex-direction: column; }
  .workbench-main-row { width: 100%; flex: 1; grid-template-columns: minmax(0, 1fr); }
  .workbench-content { grid-column: 1; }
  .workbench-main-row :deep(.primary-sidebar) { position: absolute; z-index: 9; top: 0; bottom: 0; left: 0; width: min(310px, calc(100vw - 32px)); box-shadow: 14px 0 36px rgba(0,0,0,.34); }
  .workbench-main-row :deep(.task-panel) { width: min(352px, calc(100vw - 22px)); }
}
</style>
