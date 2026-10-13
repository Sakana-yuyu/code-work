import {
  CODEX_COLLABORATION_MODE_OPTION_ID,
  type SelectProviderOptionDescriptor,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";

const decodeModes = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        mode: Schema.NullOr(Schema.String),
        model: Schema.optionalKey(Schema.NullOr(Schema.String)),
        reasoning_effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);

/** 仅在统一目录内调用；复用已有无会话 client 和外层刷新预算。 */
export const requestCodexCollaborationModes = Effect.fn("requestCodexCollaborationModes")(
  function* (client: {
    readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
  }) {
    const response = yield* client.raw
      .request("collaborationMode/list", {})
      .pipe(Effect.flatMap(decodeModes), Effect.result);
    if (response._tag === "Failure") {
      const error = response.failure;
      return {
        descriptor: undefined,
        message:
          "code" in error && error.code === -32601
            ? "Codex CLI 不支持原生模式目录，请更新 CLI 后刷新。"
            : "Codex 原生模式目录读取失败，请刷新重试；本轮不提供模式控制。",
      };
    }
    const seen = new Set<string>();
    const options: SelectProviderOptionDescriptor["options"][number][] = [];
    for (const preset of response.success.data) {
      if (
        (preset.mode !== "default" && preset.mode !== "plan") ||
        !preset.name.trim() ||
        seen.has(preset.mode)
      )
        continue;
      seen.add(preset.mode);
      const details = [
        ...(preset.model ? [`原生预设模型：${preset.model}`] : []),
        ...(preset.reasoning_effort ? [`原生预设推理：${preset.reasoning_effort}`] : []),
      ];
      options.push({
        id: preset.mode,
        label: preset.name,
        ...(details.length ? { description: details.join("；") } : {}),
      });
    }
    if (!options.length) return { descriptor: undefined };
    const currentValue = options.find((option) => option.id === "default")?.id ?? options[0]!.id;
    return {
      descriptor: {
        id: CODEX_COLLABORATION_MODE_OPTION_ID,
        label: "模式",
        type: "select" as const,
        options: options.map((option) => ({
          ...option,
          ...(option.id === currentValue ? { isDefault: true } : {}),
        })),
        currentValue,
      } satisfies SelectProviderOptionDescriptor,
    };
  },
);
