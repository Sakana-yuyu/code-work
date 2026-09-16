import { modelPickerProviderGroupKey } from "./modelPickerKeys";

/**
 * 把扁平的模型行 keys 组装成树形结构：外层是供应商组头，内层是该供应商的
 * 模型行。输入数组须已按目标顺序排好（相关度/收藏/实例序），组头按首次
 * 出现顺序生成。开启 groupFavorites 时收藏行集中到最上方的收藏组头下，
 * 不再在各供应商组里重复。
 */
export function buildGroupedModelPickerItemKeys(input: {
  readonly models: ReadonlyArray<{
    readonly key: string;
    readonly providerLabel: string;
    readonly isFavorite: boolean;
  }>;
  readonly favoritesHeaderLabel: string;
  readonly groupFavorites: boolean;
}): string[] {
  const keys: string[] = [];
  const groups = new Map<string, string[]>();
  const favoriteKeys: string[] = [];
  for (const model of input.models) {
    if (input.groupFavorites && model.isFavorite) {
      favoriteKeys.push(model.key);
      continue;
    }
    let modelKeys = groups.get(model.providerLabel);
    if (modelKeys === undefined) {
      modelKeys = [];
      groups.set(model.providerLabel, modelKeys);
    }
    modelKeys.push(model.key);
  }
  if (favoriteKeys.length > 0) {
    keys.push(modelPickerProviderGroupKey(input.favoritesHeaderLabel), ...favoriteKeys);
  }
  for (const [label, modelKeys] of groups) {
    keys.push(modelPickerProviderGroupKey(label), ...modelKeys);
  }
  return keys;
}
