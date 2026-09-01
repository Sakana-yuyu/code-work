import { expect, it } from "@effect/vitest";
import { ByokModelAdapter, ByokSettings } from "@codework/contracts";
import * as Schema from "effect/Schema";

import {
  byokCompositionAdapterConfigurationDigest,
  byokCompositionAdapterForModel,
  byokCompositionModelDescriptor,
} from "./ByokCompositionModel.ts";

const decodeAdapter = Schema.decodeSync(ByokModelAdapter);
const decodeSettings = Schema.decodeSync(ByokSettings);

const adapter = decodeAdapter({
  id: "adapter-coder",
  displayName: "Coder",
  protocol: "openai",
  baseURL: "https://api.example.test/v1",
  apiKey: "secret-api-key",
  modelId: "deepseek-coder-v3",
  balanceAccessToken: "secret-balance-token",
});

it("生成不包含密钥的 Composition 模型描述", () => {
  const descriptor = byokCompositionModelDescriptor(adapter);

  expect(descriptor).toMatchObject({
    adapterId: adapter.id,
    modelId: adapter.modelId,
    protocol: adapter.protocol,
    baseURL: adapter.baseURL,
  });
  expect(Object.keys(descriptor).sort()).toEqual([
    "adapterId",
    "baseURL",
    "configurationDigest",
    "modelId",
    "protocol",
  ]);
  expect(descriptor).not.toHaveProperty("apiKey");
  expect(descriptor).not.toHaveProperty("balanceAccessToken");
});

it("密钥轮换不改变非敏感配置摘要", () => {
  const rotated = { ...adapter, apiKey: "rotated-secret", balanceAccessToken: "rotated-token" };

  expect(byokCompositionAdapterConfigurationDigest(rotated)).toBe(
    byokCompositionAdapterConfigurationDigest(adapter),
  );
});

it("影响模型请求的非敏感配置变化会改变摘要", () => {
  expect(
    byokCompositionAdapterConfigurationDigest({
      ...adapter,
      baseURL: "https://api.changed.test/v1",
    }),
  ).not.toBe(byokCompositionAdapterConfigurationDigest(adapter));
  expect(
    byokCompositionAdapterConfigurationDigest({ ...adapter, modelId: "different-model" }),
  ).not.toBe(byokCompositionAdapterConfigurationDigest(adapter));
});

it("Composition 精确选择 Adapter，未知模型不回退默认项", () => {
  const settings = decodeSettings({ enabled: true, adapters: [adapter] });

  expect(byokCompositionAdapterForModel(settings, adapter.id)?.id).toBe(adapter.id);
  expect(byokCompositionAdapterForModel(settings, adapter.modelId)?.id).toBe(adapter.id);
  expect(byokCompositionAdapterForModel(settings, `${adapter.id}/dynamic-model`)).toMatchObject({
    id: adapter.id,
    modelId: "dynamic-model",
  });
  expect(byokCompositionAdapterForModel(settings, "missing-model")).toBeUndefined();
});
