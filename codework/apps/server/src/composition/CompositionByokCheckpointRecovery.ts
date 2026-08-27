import * as NodeCrypto from "node:crypto";

import type { CompositionTaskEvent } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class ByokCheckpointRecoveryError extends Data.TaggedError("ByokCheckpointRecoveryError")<{
  readonly code:
    | "byok_checkpoint_recovery_empty"
    | "byok_checkpoint_recovery_digest_mismatch"
    | "byok_checkpoint_recovery_offset_gap";
  readonly detail: string;
}> {}

export type RecoveredCompositionByokOutput = {
  readonly text: string;
  readonly utf8Bytes: number;
  readonly chunkCount: number;
};

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/**
 * 判断一条持久化事件是否为 BYOK 文本 checkpoint；runtime 归属由调用方先行过滤。
 */
export const isByokPersistedCheckpointEvent = (event: CompositionTaskEvent): boolean =>
  event.sourceEventId?.startsWith("byok:") === true &&
  event.eventType === "message" &&
  event.outputDelta !== undefined &&
  event.outputOffsetBytes !== undefined &&
  event.outputDigest !== undefined;

/**
 * 进程重启后的部分输出恢复：按 UTF-8 累计偏移排序校验摘要链，重构已持久化正文。
 *
 * 只承诺恢复"已经落盘的输出"，不承诺续跑中断的模型流；调用方据此展示或决定重派。
 */
export const recoverPersistedCheckpointText = (
  events: Iterable<CompositionTaskEvent>,
): Effect.Effect<RecoveredCompositionByokOutput, ByokCheckpointRecoveryError> => {
  const rows = [...events]
    .filter(isByokPersistedCheckpointEvent)
    .sort((a, b) => a.outputOffsetBytes! - b.outputOffsetBytes!);
  if (rows.length === 0) {
    return Effect.fail(
      new ByokCheckpointRecoveryError({
        code: "byok_checkpoint_recovery_empty",
        detail: "没有可恢复的 BYOK 持久化 checkpoint。",
      }),
    );
  }
  let text = "";
  let expectedOffset = 0;
  for (const row of rows) {
    const delta = row.outputDelta!;
    if (row.outputDigest !== sha256(delta)) {
      return Effect.fail(
        new ByokCheckpointRecoveryError({
          code: "byok_checkpoint_recovery_digest_mismatch",
          detail: `checkpoint offset=${row.outputOffsetBytes} 的内容摘要与 outputDigest 不一致。`,
        }),
      );
    }
    const endOffset = expectedOffset + utf8ByteLength(delta);
    if (row.outputOffsetBytes !== endOffset) {
      return Effect.fail(
        new ByokCheckpointRecoveryError({
          code: "byok_checkpoint_recovery_offset_gap",
          detail: `checkpoint offset=${row.outputOffsetBytes}，预期为 ${endOffset}，输出链存在缺口或重复。`,
        }),
      );
    }
    text += delta;
    expectedOffset = endOffset;
  }
  return Effect.succeed({ text, utf8Bytes: expectedOffset, chunkCount: rows.length });
};
