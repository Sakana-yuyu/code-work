import type { LanguagePreference } from "@codework/contracts/settings";

import { en as enCatalog, zhCN as zhCNCatalog } from "./messages";

export type AppLanguage = Exclude<LanguagePreference, "system">;

// 日文词表约 500KB 源码，静态进入口会让三种语言的用户都下载它。
// 这里保留一个可填充的注册表：词表未到达时 `t()` 回落到英文，
// 到达后 `registerLanguageCatalog` 递增版本号并通知 React 重挂载。
//
// 本模块只依赖纯数据词表，不触碰 localStorage / React：单测的 setup
// 文件可以安全地提前导入它登记日文，而不会改变其它模块的初始化时序。
const jaCatalog: Record<string, string> = {};

export const CATALOGS: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": zhCNCatalog,
  en: enCatalog,
  ja: jaCatalog,
};

const loadedCatalogs = new Set<AppLanguage>(["zh-CN", "en"]);
const catalogListeners = new Set<() => void>();
const catalogLoads = new Map<AppLanguage, Promise<void>>();
let catalogVersion = 0;

export function subscribeCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

export function getCatalogVersion(): number {
  return catalogVersion;
}

/** 同步登记一份词表（单测用；生产走 {@link loadLanguageCatalog}）。 */
export function registerLanguageCatalog(
  language: AppLanguage,
  catalog: Record<string, string>,
): void {
  Object.assign(CATALOGS[language], catalog);
  loadedCatalogs.add(language);
  catalogVersion += 1;
  for (const listener of catalogListeners) listener();
}

/**
 * 按需加载一种语言的词表。幂等；加载失败允许下次重试，
 * 界面继续用英文兜底，不阻塞渲染。
 */
export function loadLanguageCatalog(language: AppLanguage): Promise<void> {
  if (loadedCatalogs.has(language)) return Promise.resolve();
  const inFlight = catalogLoads.get(language);
  if (inFlight) return inFlight;
  const load: Promise<void> =
    language === "ja"
      ? import("./ja")
          .then((module) => {
            registerLanguageCatalog("ja", module.ja);
          })
          .catch(() => {
            catalogLoads.delete(language);
          })
      : Promise.resolve();
  catalogLoads.set(language, load);
  return load;
}
