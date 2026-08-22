import { reactive } from "vue";

const STORAGE_KEY = "code-work.workbench.layout.v1";
const DEFAULT_LAYOUT = Object.freeze({
  activeActivity: "explorer",
  sidebarVisible: true,
  taskPanelVisible: true,
});

export const workbenchActivities = Object.freeze([
  { id: "explorer", label: "工作区", shortcut: "Ctrl+B" },
  { id: "search", label: "搜索", shortcut: "Ctrl+Shift+F" },
  { id: "source-control", label: "源代码管理", shortcut: "Ctrl+Shift+G" },
  { id: "extensions", label: "扩展与能力", shortcut: "Ctrl+Shift+X" },
  { id: "settings", label: "设置", shortcut: "" },
]);

function readLayout() {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT };
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    const activityKnown = workbenchActivities.some((item) => item.id === stored.activeActivity);
    return {
      activeActivity: activityKnown ? stored.activeActivity : DEFAULT_LAYOUT.activeActivity,
      sidebarVisible: stored.sidebarVisible !== false,
      taskPanelVisible: stored.taskPanelVisible !== false,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

const initialLayout = readLayout();

export const workbenchState = reactive({
  activeActivity: initialLayout.activeActivity,
  sidebarVisible: initialLayout.sidebarVisible,
  taskPanelVisible: initialLayout.taskPanelVisible,
  tabs: [],
});

function persistLayout() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeActivity: workbenchState.activeActivity,
        sidebarVisible: workbenchState.sidebarVisible,
        taskPanelVisible: workbenchState.taskPanelVisible,
      }),
    );
  } catch {
    // Layout persistence is an enhancement; the in-memory workbench remains usable.
  }
}

export function selectWorkbenchActivity(activityID) {
  if (!workbenchActivities.some((item) => item.id === activityID)) return;
  workbenchState.activeActivity = activityID;
  workbenchState.sidebarVisible = true;
  persistLayout();
}

export function toggleWorkbenchSidebar() {
  workbenchState.sidebarVisible = !workbenchState.sidebarVisible;
  persistLayout();
}

export function toggleWorkbenchTaskPanel() {
  workbenchState.taskPanelVisible = !workbenchState.taskPanelVisible;
  persistLayout();
}

export function resetWorkbenchLayout() {
  Object.assign(workbenchState, {
    ...DEFAULT_LAYOUT,
    tabs: workbenchState.tabs,
  });
  persistLayout();
}

export function syncWorkbenchTab(route) {
  const id = String(route.path || "/");
  const label = String(route.meta?.workbenchLabel || route.meta?.title || "工作台").split(/[｜|]/)[0].trim() || "工作台";
  const icon = String(route.meta?.workbenchIcon || "workbench");
  const existing = workbenchState.tabs.find((tab) => tab.id === id);
  if (existing) {
    existing.label = label;
    existing.icon = icon;
    return;
  }
  workbenchState.tabs.push({ id, label, icon, closable: id !== "/" });
}

export function removeWorkbenchTab(id) {
  const index = workbenchState.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return "/";
  const [removed] = workbenchState.tabs.splice(index, 1);
  if (!removed.closable || workbenchState.tabs.length === 0) {
    if (!workbenchState.tabs.some((tab) => tab.id === "/")) {
      workbenchState.tabs.unshift({ id: "/", label: "开始", icon: "workbench", closable: false });
    }
    return "/";
  }
  return workbenchState.tabs[Math.max(0, index - 1)]?.id || "/";
}
