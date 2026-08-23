export function pickDefaultAgentModelID(config) {
  const adapters = Array.isArray(config?.modelAdapters) ? config.modelAdapters : [];
  const ready = adapters.find((item) => item && item.enabled !== false && String(item.id || "").trim());
  return ready ? String(ready.id).trim() : "";
}
