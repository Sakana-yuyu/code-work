import * as NodeCrypto from "node:crypto";

import type { ByokModelAdapter, ByokSettings } from "@codework/contracts";

import type { ProviderCompositionModelDescriptor } from "../ProviderDriver.ts";

/** 摘要只覆盖实际影响模型请求的非敏感配置，禁止引入任何密钥。 */
export const byokCompositionAdapterConfigurationDigest = (adapter: ByokModelAdapter): string =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(
      `composition-byok-adapter:v1\n${JSON.stringify({
        protocol: adapter.protocol,
        baseURL: adapter.baseURL,
        modelId: adapter.modelId,
        apiKeySourceAdapterId: adapter.apiKeySourceAdapterId ?? null,
      })}`,
      "utf8",
    )
    .digest("hex")}`;

export const byokCompositionModelDescriptor = (
  adapter: ByokModelAdapter,
): ProviderCompositionModelDescriptor => ({
  adapterId: adapter.id,
  modelId: adapter.modelId,
  protocol: adapter.protocol,
  baseURL: adapter.baseURL,
  configurationDigest: byokCompositionAdapterConfigurationDigest(adapter),
});

export const listByokCompositionModelDescriptors = (
  settings: ByokSettings,
): ReadonlyArray<ProviderCompositionModelDescriptor> =>
  settings.adapters.map(byokCompositionModelDescriptor);

/** Composition 接受精确配置或旧版 Adapter/模型形式，禁止默认回退。 */
export const byokCompositionAdapterForModel = (
  settings: ByokSettings,
  model: string,
): ByokModelAdapter | undefined => {
  const exact = settings.adapters.find(
    (adapter) => adapter.id === model || adapter.modelId === model,
  );
  if (exact !== undefined) return exact;
  const separator = model.indexOf("/");
  if (separator <= 0) return undefined;
  const adapterId = model.slice(0, separator);
  const discoveredModelId = model.slice(separator + 1).trim();
  if (discoveredModelId.length === 0) return undefined;
  const adapter = settings.adapters.find((candidate) => candidate.id === adapterId);
  return adapter === undefined ? undefined : { ...adapter, modelId: discoveredModelId };
};
