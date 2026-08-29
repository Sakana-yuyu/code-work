import type { CompositionAutomationCadence } from "@codework/contracts";
import { CronExpressionParser } from "cron-parser";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_DATE_UNIX_MS = 8_640_000_000_000_000;

export const CompositionAutomationCadenceErrorCode = Schema.Literals([
  "automation_timezone_invalid",
  "automation_cron_invalid",
  "automation_timestamp_out_of_range",
]);
export type CompositionAutomationCadenceErrorCode =
  typeof CompositionAutomationCadenceErrorCode.Type;

export class CompositionAutomationCadenceError extends Schema.TaggedErrorClass<CompositionAutomationCadenceError>()(
  "CompositionAutomationCadenceError",
  {
    code: CompositionAutomationCadenceErrorCode,
    automationId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Automation cadence 计算失败：${this.code}: ${this.detail}`;
  }
}

export interface CalculateNextCompositionAutomationRunInput {
  readonly automationId: string;
  readonly cadence: CompositionAutomationCadence;
  readonly afterUnixMs: number;
  readonly expiresAtUnixMs: number | null;
}

const cadenceError = (
  code: CompositionAutomationCadenceErrorCode,
  automationId: string,
  detail: string,
): CompositionAutomationCadenceError =>
  new CompositionAutomationCadenceError({ code, automationId, detail });

const isValidDateUnixMs = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_UNIX_MS;

const validateTimestampBounds = (input: CalculateNextCompositionAutomationRunInput) => {
  if (
    !isValidDateUnixMs(input.afterUnixMs) ||
    (input.expiresAtUnixMs !== null && !isValidDateUnixMs(input.expiresAtUnixMs))
  ) {
    return Effect.fail(
      cadenceError(
        "automation_timestamp_out_of_range",
        input.automationId,
        "计划时间必须是 ECMAScript Date 可表示的非负安全整数毫秒。",
      ),
    );
  }
  return Effect.void;
};

const validateTimezone = (automationId: string, timezone: string) =>
  Effect.try({
    try: () => {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    },
    catch: () =>
      cadenceError("automation_timezone_invalid", automationId, `无效的 IANA 时区：${timezone}`),
  });

/** 兼容常见 5 字段 cron，同时让第三方解析器执行完整 strict 校验。 */
const normalizeCronExpression = (expression: string): string => {
  if (expression.startsWith("@")) return expression;
  const fields = expression.trim().split(/\s+/u);
  return fields.length === 5 ? `0 ${fields.join(" ")}` : expression;
};

const applyExpiry = (candidateUnixMs: number, expiresAtUnixMs: number | null): number | null =>
  expiresAtUnixMs !== null && candidateUnixMs > expiresAtUnixMs ? null : candidateUnixMs;

export const calculateNextCompositionAutomationRun = Effect.fn(
  "CompositionAutomationCadence.calculateNextRun",
)(function* (input: CalculateNextCompositionAutomationRunInput) {
  yield* validateTimestampBounds(input);
  if (input.expiresAtUnixMs !== null && input.expiresAtUnixMs <= input.afterUnixMs) {
    return null;
  }

  if (input.cadence.type === "every") {
    const candidate = input.afterUnixMs + input.cadence.intervalMs;
    if (!isValidDateUnixMs(candidate) || candidate <= input.afterUnixMs) {
      return yield* cadenceError(
        "automation_timestamp_out_of_range",
        input.automationId,
        "every cadence 的下一个计划点超出可表示范围。",
      );
    }
    return applyExpiry(candidate, input.expiresAtUnixMs);
  }

  const cronCadence = input.cadence;
  yield* validateTimezone(input.automationId, cronCadence.timezone);
  const candidate = yield* Effect.try({
    try: () =>
      CronExpressionParser.parse(normalizeCronExpression(cronCadence.expression), {
        currentDate: input.afterUnixMs,
        tz: cronCadence.timezone,
        hashSeed: input.automationId,
        strict: true,
      })
        .next()
        .getTime(),
    catch: () =>
      cadenceError(
        "automation_cron_invalid",
        input.automationId,
        `无法计算 cron 表达式：${cronCadence.expression}`,
      ),
  });
  if (!isValidDateUnixMs(candidate) || candidate <= input.afterUnixMs) {
    return yield* cadenceError(
      "automation_timestamp_out_of_range",
      input.automationId,
      "cron cadence 未产生严格递增且可表示的计划点。",
    );
  }
  return applyExpiry(candidate, input.expiresAtUnixMs);
});
