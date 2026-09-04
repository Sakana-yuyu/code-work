import type { LocalPluginManifest } from "@codework/contracts";

import { decodeAllowedLocalPluginManifest } from "~/localPlugins/localPluginPolicy";

import curatedCatalog from "./catalog/curated.json";

/**
 * 内置插件商店目录。
 *
 * 每一项都是完整合法的 manifest（数据在 `catalog/curated.json`），直接走与
 * 「导入 manifest」相同的 `lifecycle.install` 管线。清单内容是插件作者写成
 * 的数据（与用户导入的 JSON 同性质），不随界面语言切换。模块加载时就逐项
 * 过一遍完整策略校验：目录内容若被自己的安装管线拒绝，会在加载时直接报错。
 * 纯声明式、随应用内置：离线可用，也没有远程目录的信任问题。
 */
export interface LocalPluginCatalogEntry {
  readonly entry: LocalPluginManifest;
  /** 商店卡片上的一句话介绍，i18n key（`localPlugins.store.summary.*`）。 */
  readonly summaryKey: string;
}

export const LOCAL_PLUGIN_CATALOG: ReadonlyArray<LocalPluginCatalogEntry> = curatedCatalog.map(
  (item) => ({
    summaryKey: item.summaryKey,
    entry: decodeAllowedLocalPluginManifest(item.entry),
  }),
);
