import type { ByokSupplierCatalogEntry, ByokSupplierModelPreset } from "@codework/contracts";

import { CONTEXT_WINDOW_RULES } from "./ContextWindowCatalog.ts";
import { matchModelContext } from "./ModelCatalog.ts";
import { SUPPLIER_TEMPLATES, type SupplierTemplate } from "./SupplierCatalog.ts";

function publicModelPreset(modelId: string): ByokSupplierModelPreset {
  const contextWindowTokens = matchModelContext(modelId, CONTEXT_WINDOW_RULES).value;
  return {
    modelId,
    displayName: modelId,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

export function toPublicSupplierCatalogEntry(template: SupplierTemplate): ByokSupplierCatalogEntry {
  return {
    id: template.id,
    label: template.label,
    protocol: template.type,
    defaultBaseURL: template.baseURL,
    allowCustomURL: template.allowCustomURL,
    modelCatalogStatus: template.modelCatalog.status,
    modelCatalogURLs: [...template.modelCatalog.urls],
    appendGeneratedCandidates: template.modelCatalog.appendCandidates,
    ...(template.websiteURL ? { websiteURL: template.websiteURL } : {}),
    ...(template.apiKeyURL ? { apiKeyURL: template.apiKeyURL } : {}),
    ...(template.iconURL ? { iconURL: template.iconURL } : {}),
    iconLight: template.iconLight,
    models: template.models.map(publicModelPreset),
  };
}

export function publicSupplierCatalog(): ByokSupplierCatalogEntry[] {
  const entries = new Map<string, ByokSupplierCatalogEntry>();
  for (const template of SUPPLIER_TEMPLATES) {
    if (!entries.has(template.id)) {
      entries.set(template.id, toPublicSupplierCatalogEntry(template));
    }
  }
  return [...entries.values()].sort((left, right) =>
    left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" }),
  );
}
