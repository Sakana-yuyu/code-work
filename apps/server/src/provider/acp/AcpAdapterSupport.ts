import {
  ACP_MODE_OPTION_ID,
  ACP_CONFIG_OPTION_PREFIX,
  type ProviderOptionSelection,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@codework/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import { toAcpConfigOptions } from "./AcpRuntimeModel.ts";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** 显式模式优先于兼容的 default/plan 推断，错误不能静默降级为另一模式。 */
export function applyAcpModeSelection(
  runtime: AcpSessionRuntime["Service"],
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): Effect.Effect<boolean, EffectAcpErrors.AcpError> {
  const selection = selections?.find((option) => option.id === ACP_MODE_OPTION_ID);
  if (!selection) return Effect.succeed(false);
  if (typeof selection.value !== "string") {
    return Effect.fail(
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "ACP 模式必须为当前会话提供的字符串 ID。",
      }),
    );
  }
  return runtime.setMode(selection.value).pipe(Effect.as(true));
}

/** 按最新广告校验再写回，缺省不改变角色或权限，撤回的配置不可继续提交。 */
export const applyAcpConfigSelections = Effect.fn("applyAcpConfigSelections")(function* (
  runtime: AcpSessionRuntime["Service"],
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
) {
  for (const selection of selections ?? []) {
    if (!selection.id.startsWith(ACP_CONFIG_OPTION_PREFIX)) continue;
    const configs = yield* runtime.getConfigOptions;
    const descriptor = toAcpConfigOptions(configs).find((option) => option.id === selection.id);
    if (!descriptor?.options.some((option) => option.id === selection.value)) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "ACP 配置或选项已不可用，请刷新会话配置。",
      });
    }
    // 仅解码经过当前广告逐项匹配的值，空字符串仍是合法的默认角色。
    yield* runtime.setConfigOption(
      decodeURIComponent(selection.id.slice(ACP_CONFIG_OPTION_PREFIX.length)),
      decodeURIComponent(String(selection.value).slice("value:".length)),
    );
  }
});

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
