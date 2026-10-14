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
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import { toAcpConfigOptions } from "./AcpRuntimeModel.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpInputStreamEndedError = Schema.is(EffectAcpErrors.AcpInputStreamEndedError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export interface AcpModeSelectionResult {
  /** 显式模式请求是否已按当前目录写入。 */
  readonly applied: boolean;
  /** 请求的模式不在当前会话模式目录中时携带被撤回的原始值。 */
  readonly withdrawnModeId: string | undefined;
}

/** 显式模式优先于兼容的 default/plan 推断；恢复后已撤回的模式不派发，交回调用方按当前目录回退。 */
export function applyAcpModeSelection(
  runtime: AcpSessionRuntime["Service"],
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): Effect.Effect<AcpModeSelectionResult, EffectAcpErrors.AcpError> {
  return Effect.gen(function* () {
    const selection = selections?.find((option) => option.id === ACP_MODE_OPTION_ID);
    if (!selection) return { applied: false, withdrawnModeId: undefined };
    if (typeof selection.value !== "string") {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "ACP 模式必须为当前会话提供的字符串 ID。",
      });
    }
    const modeState = yield* runtime.getModeState;
    if (!modeState || !modeState.availableModes.some((mode) => mode.id === selection.value)) {
      return { applied: false, withdrawnModeId: selection.value };
    }
    yield* runtime.setMode(selection.value);
    return { applied: true, withdrawnModeId: undefined };
  });
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
  if (
    isAcpProcessExitedError(error) ||
    isAcpInputStreamEndedError(error) ||
    isAcpTransportError(error)
  ) {
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

export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const preferred = request.options.find((option) => option.kind === kind);
  if (preferred?.optionId.trim()) return preferred.optionId;
  // 未广告会话授权时只批准本次，绝不制造 ID 或扩大权限。
  if (decision === "acceptForSession") {
    const once = request.options.find((option) => option.kind === "allow_once");
    if (once?.optionId.trim()) return once.optionId;
  }
  return undefined;
}
