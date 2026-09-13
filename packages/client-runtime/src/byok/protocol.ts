import type { ByokModelAdapter } from "@codework/contracts";

export type ByokProtocol = ByokModelAdapter["protocol"];

/**
 * 按模型名推断最合适的请求协议（自动请求格式匹配）。
 *
 * 移植自 cursor-byok 的 InferProviderType：把本应走原生协议的模型
 * （claude、gemini）错误地套用渠道级 openai 协议，是 Claude 前缀缓存
 * 失效的根源。规则：claude* → anthropic，gemini* → gemini，其余沿用
 * fallback（通常是渠道当前协议）。
 */
export function inferByokProtocol(modelId: string, fallback: ByokProtocol): ByokProtocol {
  const model = modelId.trim().toLowerCase();
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gemini")) return "gemini";
  return fallback;
}

export interface ByokProtocolMismatchIssue {
  readonly adapterId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly current: ByokProtocol;
  readonly suggested: ByokProtocol;
}

/**
 * 扫描适配器列表中的协议不匹配问题（如 Claude 模型被配成 OpenAI 协议，
 * 导致前缀缓存失效）。只读不改；修正由调用方在用户确认后落盘。
 */
export function diagnoseByokProtocolMismatches(
  adapters: ReadonlyArray<ByokModelAdapter>,
): ReadonlyArray<ByokProtocolMismatchIssue> {
  const issues: ByokProtocolMismatchIssue[] = [];
  for (const adapter of adapters) {
    const modelId = adapter.modelId.trim();
    if (!modelId) continue;
    const suggested = inferByokProtocol(modelId, adapter.protocol);
    if (suggested !== adapter.protocol) {
      issues.push({
        adapterId: adapter.id,
        modelId,
        displayName: adapter.displayName.trim() || modelId,
        current: adapter.protocol,
        suggested,
      });
    }
  }
  return issues;
}
