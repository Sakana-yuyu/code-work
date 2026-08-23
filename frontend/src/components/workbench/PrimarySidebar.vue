<script setup>
import { computed, ref } from "vue";
import WorkbenchGlyph from "./WorkbenchGlyph.vue";

const props = defineProps({
  activeActivity: { type: String, required: true },
  currentPath: { type: String, required: true },
});

const emit = defineEmits(["navigate", "close"]);
const query = ref("");

const panels = {
  explorer: {
    title: "资源管理器",
    subtitle: "CODE WORK",
    items: [
      { label: "工作区", path: "/ide", icon: "folder" },
      { label: "开始使用", path: "/workbench", icon: "workbench" },
      { label: "设置", path: "/settings", icon: "settings" },
    ],
  },
  search: {
    title: "搜索",
    subtitle: "快速定位功能",
    items: [
      { label: "模型与供应商", path: "/model-config", icon: "search" },
      { label: "请求明细", path: "/request-metrics", icon: "search" },
      { label: "运行诊断", path: "/diagnostics", icon: "search" },
      { label: "系统设置", path: "/settings", icon: "search" },
    ],
  },
  "source-control": {
    title: "源代码管理",
    subtitle: "只读 Git 状态",
    items: [
      { label: "工作区 Git", path: "/ide", icon: "source-control" },
    ],
  },
  extensions: {
    title: "能力与集成",
    subtitle: "逐步接入 Workbench",
    items: [
      { label: "模型分组", path: "/model-groups", icon: "extensions" },
      { label: "技能与 MCP", path: "/settings?category=skills-mcp", icon: "extensions" },
      { label: "代理与路由", path: "/control-center?tab=routing", icon: "extensions" },
      { label: "Agent 运行台", path: "/control-center?tab=agents", icon: "extensions" },
    ],
  },
  settings: {
    title: "管理",
    subtitle: "偏好与诊断",
    items: [
      { label: "设置", path: "/settings", icon: "settings" },
      { label: "运行诊断", path: "/diagnostics", icon: "shield" },
      { label: "关于 Code Work", path: "/settings?category=about", icon: "workbench" },
    ],
  },
};

const panel = computed(() => panels[props.activeActivity] || panels.explorer);
const visibleItems = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword || props.activeActivity !== "search") return panel.value.items;
  return panel.value.items.filter((item) => item.label.toLowerCase().includes(keyword));
});

function navigate(path) {
  emit("navigate", path);
}
</script>

<template>
  <aside class="primary-sidebar" aria-label="工作台侧栏">
    <header class="sidebar-header">
      <div>
        <p class="sidebar-title">{{ panel.title }}</p>
        <p class="sidebar-subtitle">{{ panel.subtitle }}</p>
      </div>
      <button type="button" class="sidebar-close" aria-label="隐藏侧栏" title="隐藏侧栏" @click="emit('close')"><WorkbenchGlyph name="panel" :size="16" /></button>
    </header>

    <label v-if="activeActivity === 'search'" class="search-input">
      <span class="sr-only">搜索工作台功能</span>
      <WorkbenchGlyph name="search" :size="15" />
      <input v-model="query" type="search" autocomplete="off" placeholder="筛选功能" />
    </label>

    <div class="sidebar-section" role="navigation" :aria-label="panel.title">
      <button
        v-for="item in visibleItems"
        :key="item.path"
        type="button"
        class="sidebar-item"
        :class="{ current: currentPath === item.path.split('?')[0] }"
        @click="navigate(item.path)"
      >
        <WorkbenchGlyph :name="item.icon" :size="15" />
        <span>{{ item.label }}</span>
        <WorkbenchGlyph name="arrow" :size="15" />
      </button>
      <p v-if="visibleItems.length === 0" class="empty-result">没有匹配的工作台入口。</p>
    </div>

    <footer class="sidebar-footer">
      <span><WorkbenchGlyph name="shield" :size="14" /> 独立配置目录</span>
      <span>完整内核 · 壳层改造中</span>
    </footer>
  </aside>
</template>

<style scoped>
.primary-sidebar {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--cw-border-subtle);
  background: var(--cw-surface-sidebar);
}

.sidebar-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 16px 13px 12px; }
.sidebar-title { margin: 0; color: var(--cw-text-primary); font-size: 13px; font-weight: 650; }
.sidebar-subtitle { margin: 4px 0 0; color: var(--cw-text-muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.sidebar-close { display: inline-flex; align-items: center; justify-content: center; width: 27px; height: 27px; border: 0; border-radius: var(--cw-radius-sm); background: transparent; color: var(--cw-text-muted); cursor: pointer; }
.sidebar-close:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }

.search-input { display: flex; align-items: center; gap: 7px; margin: 0 12px 10px; padding: 0 8px; height: 30px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-sm); background: var(--cw-surface-workbench); color: var(--cw-text-muted); }
.search-input input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--cw-text-primary); font-size: 12px; }
.search-input input::placeholder { color: var(--cw-text-muted); }

.sidebar-section { display: flex; flex: 1; flex-direction: column; gap: 2px; overflow-y: auto; padding: 4px 8px; }
.sidebar-item { display: grid; grid-template-columns: 18px minmax(0, 1fr) 14px; align-items: center; gap: 7px; min-height: 32px; padding: 0 7px; border: 0; border-radius: var(--cw-radius-sm); background: transparent; color: var(--cw-text-secondary); cursor: pointer; text-align: left; }
.sidebar-item > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-item > :last-child { color: transparent; }
.sidebar-item:hover { background: var(--cw-surface-hover); color: var(--cw-text-primary); }
.sidebar-item:hover > :last-child, .sidebar-item.current > :last-child { color: var(--cw-text-muted); }
.sidebar-item.current { background: var(--cw-surface-active); color: var(--cw-text-primary); }
.empty-result { margin: 12px 7px; color: var(--cw-text-muted); font-size: 12px; }

.sidebar-footer { display: grid; gap: 5px; padding: 12px; border-top: 1px solid var(--cw-border-subtle); color: var(--cw-text-muted); font-size: 10px; }
.sidebar-footer span:first-child { display: inline-flex; align-items: center; gap: 5px; color: var(--cw-text-secondary); }
</style>
