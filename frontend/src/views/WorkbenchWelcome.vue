<script setup>
import { useRouter } from "vue-router";
import WorkbenchGlyph from "@/components/workbench/WorkbenchGlyph.vue";

const router = useRouter();

const quickActions = [
  { label: "打开工作区", detail: "注册根目录并安全浏览文件", icon: "folder", path: "/ide" },
  { label: "调整设置", detail: "配置代理、历史、技能与系统选项", icon: "settings", path: "/settings" },
  { label: "配置模型", detail: "保留现有模型与供应商能力", icon: "folder", path: "/model-config" },
  { label: "进入控制中心", detail: "查看路由、请求实验与 Agent 运行台", icon: "panel", path: "/control-center" },
];

function open(path) {
  void router.push(path);
}
</script>

<template>
  <section class="welcome-page" aria-labelledby="welcome-heading">
    <div class="welcome-hero">
      <span class="hero-mark"><WorkbenchGlyph name="workbench" :size="34" /></span>
      <p class="eyebrow">CODE WORK · WORKBENCH PREVIEW</p>
      <h1 id="welcome-heading">把完整能力放进更清晰的工作台。</h1>
      <p>Code Work 以独立配置目录运行，保留本地服务、模型、路由和诊断能力；当前正在将这些能力逐步迁入新的工作台外壳。</p>
      <div class="hero-actions">
        <button type="button" class="primary-action" @click="open('/ide')"><WorkbenchGlyph name="folder" :size="16" />打开工作区</button>
        <button type="button" class="secondary-action" @click="open('/settings')">调整设置</button>
      </div>
    </div>

    <div class="quick-grid" aria-label="常用工作台入口">
      <button v-for="action in quickActions" :key="action.path" type="button" class="quick-card" @click="open(action.path)">
        <span class="quick-icon"><WorkbenchGlyph :name="action.icon" :size="20" /></span>
        <span><strong>{{ action.label }}</strong><small>{{ action.detail }}</small></span>
        <WorkbenchGlyph name="arrow" :size="18" />
      </button>
    </div>

    <aside class="welcome-note">
      <WorkbenchGlyph name="shield" :size="17" />
      <div><strong>独立运行边界</strong><p>Code Work 不会自动读取、迁移或删除现有 cursor-byok 的配置、账号、证书和历史记录。需要接管 Cursor 集成时，将在后续功能中明确提示。</p></div>
    </aside>
  </section>
</template>

<style scoped>
.welcome-page { display: flex; min-height: 100%; flex-direction: column; justify-content: center; gap: 30px; overflow: auto; padding: clamp(28px, 7vw, 86px) clamp(24px, 8vw, 108px); background: radial-gradient(circle at 75% 8%, rgba(73, 126, 216, .16), transparent 34%), var(--cw-surface-workbench); }
.welcome-hero { max-width: 720px; }
.hero-mark { display: inline-flex; align-items: center; justify-content: center; width: 58px; height: 58px; border: 1px solid color-mix(in srgb, var(--cw-accent) 48%, var(--cw-border-subtle)); border-radius: 15px; background: linear-gradient(145deg, rgba(120,169,255,.19), rgba(120,169,255,.04)); color: var(--cw-accent); }
.eyebrow { margin: 18px 0 7px; color: var(--cw-accent-hover); font-size: 11px; font-weight: 700; letter-spacing: .11em; }
h1 { max-width: 620px; margin: 0; color: var(--cw-text-primary); font-size: clamp(29px, 4vw, 46px); letter-spacing: -.045em; line-height: 1.1; }
.welcome-hero > p:not(.eyebrow) { max-width: 680px; margin: 17px 0 0; color: var(--cw-text-secondary); font-size: 14px; line-height: 1.7; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 24px; }
.hero-actions button { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 12px; border-radius: var(--cw-radius-sm); cursor: pointer; font-size: 12px; font-weight: 650; }
.primary-action { border: 1px solid transparent; background: var(--cw-accent); color: var(--cw-accent-ink); }
.primary-action:hover { background: var(--cw-accent-hover); }
.secondary-action { border: 1px solid var(--cw-border-strong); background: var(--cw-surface-raised); color: var(--cw-text-primary); }
.secondary-action:hover { background: var(--cw-surface-hover); }
.quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 900px; gap: 10px; }
.quick-card { display: grid; grid-template-columns: 34px minmax(0, 1fr) 18px; align-items: center; gap: 10px; min-height: 78px; padding: 12px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-md); background: color-mix(in srgb, var(--cw-surface-raised) 80%, transparent); color: var(--cw-text-secondary); cursor: pointer; text-align: left; transition: transform 120ms ease, border-color 120ms ease, background-color 120ms ease; }
.quick-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--cw-accent) 55%, var(--cw-border-strong)); background: var(--cw-surface-hover); color: var(--cw-text-primary); }
.quick-card > span:nth-child(2) { display: grid; gap: 4px; min-width: 0; }.quick-card strong { color: var(--cw-text-primary); font-size: 12px; }.quick-card small { color: var(--cw-text-muted); font-size: 11px; line-height: 1.35; }.quick-icon { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 7px; background: rgba(120,169,255,.13); color: var(--cw-accent); }.quick-card > :last-child { color: var(--cw-text-muted); }
.welcome-note { display: flex; max-width: 900px; gap: 9px; padding: 12px; border: 1px solid var(--cw-border-subtle); border-radius: var(--cw-radius-md); background: rgba(255,255,255,.018); color: var(--cw-text-muted); }.welcome-note > span { flex: 0 0 auto; color: var(--cw-success); }.welcome-note strong { color: var(--cw-text-secondary); font-size: 11px; }.welcome-note p { margin: 3px 0 0; font-size: 11px; line-height: 1.55; }
@media (max-width: 650px) { .quick-grid { grid-template-columns: 1fr; }.welcome-page { justify-content: flex-start; } }
</style>
