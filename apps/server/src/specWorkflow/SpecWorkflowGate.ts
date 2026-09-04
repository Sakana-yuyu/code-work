import type { SpecWorkflowCapability } from "@codework/contracts";

export type SpecWorkflowAccessDecision =
  | { readonly kind: "enabled" }
  | { readonly kind: "disabled"; readonly reason: "not-enabled" };

/** 所有后续 Spec Workflow 路由必须先经过此闭闸；普通对话不应绕过它。 */
export const evaluateSpecWorkflowAccess = (
  capability: SpecWorkflowCapability,
): SpecWorkflowAccessDecision =>
  capability.enabled ? { kind: "enabled" } : { kind: "disabled", reason: "not-enabled" };
