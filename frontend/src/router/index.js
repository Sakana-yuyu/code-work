import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { isBrowserPreview } from "@/services/runtimeAdapter";

// Keep feature views lazy: the Workbench chrome remains fast while legacy operational
// modules load only when the user opens their corresponding tab.
const WorkbenchWelcome = () => import("@/views/WorkbenchWelcome.vue");
const LegacyHome = () => import("@/views/Home.vue");
const ModelConfig = () => import("@/views/ModelConfig.vue");
const ModelEditor = () => import("@/views/ModelEditor.vue");
const ModelCatalog = () => import("@/views/ModelCatalog.vue");
const ModelGroups = () => import("@/views/ModelGroups.vue");
const RequestMetrics = () => import("@/views/RequestMetrics.vue");
const SupplierDetail = () => import("@/views/SupplierDetail.vue");
const MetricsDetail = () => import("@/views/MetricsDetail.vue");
const StatsOverlay = () => import("@/views/StatsOverlay.vue");
const Diagnostics = () => import("@/views/Diagnostics.vue");
const Settings = () => import("@/views/Settings.vue");
const ControlCenter = () => import("@/views/ControlCenter.vue");

const router = createRouter({
  history: isBrowserPreview ? createWebHistory() : createWebHashHistory(),
  routes: [
    {
      path: "/",
      component: LegacyHome,
      meta: { showIcon: false, title: "服务控制台", workbenchLabel: "服务", workbenchIcon: "service", directlyClose: false },
    },
    {
      path: "/workbench",
      component: WorkbenchWelcome,
      meta: { showIcon: false, title: "Code Work", workbenchLabel: "开始", workbenchIcon: "workbench", directlyClose: false },
    },
    {
      path: "/service",
      redirect: "/",
    },
    {
      path: "/model-config",
      component: ModelConfig,
      meta: { showIcon: false, title: "模型配置", workbenchIcon: "folder", directlyClose: true },
    },
    {
      path: "/model-editor",
      component: ModelEditor,
      meta: { showIcon: false, title: "模型配置", workbenchIcon: "folder", directlyClose: true },
    },
    {
      path: "/model-catalog",
      component: ModelCatalog,
      meta: { showIcon: false, title: "拉取模型", workbenchIcon: "folder", directlyClose: true },
    },
    {
      path: "/model-groups",
      component: ModelGroups,
      meta: { showIcon: false, title: "模型分组", workbenchIcon: "extensions", directlyClose: true },
    },
    {
      path: "/supplier",
      component: SupplierDetail,
      meta: { showIcon: false, title: "供应商详情", workbenchIcon: "folder", directlyClose: true },
    },
    {
      path: "/metrics-detail",
      component: MetricsDetail,
      meta: { showIcon: false, title: "会话分析", workbenchIcon: "chart", directlyClose: true },
    },
    {
      path: "/request-metrics",
      component: RequestMetrics,
      meta: { showIcon: false, title: "请求明细", workbenchIcon: "chart", directlyClose: true },
    },
    {
      // The transparent overlay is intentionally the only layout-free route.
      path: "/stats-overlay",
      component: StatsOverlay,
      meta: { showIcon: false, title: "实时统计", directlyClose: true, transparentCanvas: true },
    },
    {
      path: "/diagnostics",
      component: Diagnostics,
      meta: { showIcon: false, title: "诊断", workbenchIcon: "shield", directlyClose: true },
    },
    {
      path: "/settings",
      component: Settings,
      meta: { showIcon: false, title: "设置", workbenchIcon: "settings", directlyClose: false },
    },
    {
      path: "/control-center",
      component: ControlCenter,
      meta: { showIcon: false, title: "控制中心", workbenchIcon: "panel", directlyClose: false },
    },
  ],
});

router.afterEach((to) => {
  document.documentElement.classList.toggle("stats-overlay-page", to.meta.transparentCanvas === true);
});

export default router;
