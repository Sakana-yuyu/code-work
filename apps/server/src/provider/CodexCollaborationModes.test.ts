import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import { requestCodexCollaborationModes } from "./CodexCollaborationModes.ts";

describe("Codex原生模式目录", () => {
  const read = (response: unknown) =>
    requestCodexCollaborationModes({
      raw: {
        request: (method, payload) => {
          expect(method).toBe("collaborationMode/list");
          expect(payload).toEqual({});
          return Effect.succeed(response);
        },
      },
    });
  it.effect("保留广告名称和标识、去重并忽略不可执行模式，默认优先default", () =>
    Effect.gen(function* () {
      const result = yield* read({
        data: [
          { name: "原生计划", mode: "plan", model: "fixture", reasoning_effort: "high" },
          { name: "原生默认", mode: "default", model: null, reasoning_effort: null },
          { name: "重复", mode: "plan" },
          { name: "未知", mode: "future" },
          { name: "无模式", mode: null },
        ],
        futureField: true,
      });
      expect(result.descriptor).toEqual({
        id: "codexCollaborationMode",
        label: "模式",
        type: "select",
        currentValue: "default",
        options: [
          {
            id: "plan",
            label: "原生计划",
            description: "原生预设模型：fixture；原生预设推理：high",
          },
          { id: "default", label: "原生默认", isDefault: true },
        ],
      });
    }),
  );
  it.effect("只有一个广告时只提供该选项，不补造另一模式", () =>
    Effect.gen(function* () {
      const result = yield* read({ data: [{ name: "仅计划", mode: "plan" }] });
      expect(result.descriptor?.options).toEqual([
        { id: "plan", label: "仅计划", isDefault: true },
      ]);
      expect(result.descriptor?.currentValue).toBe("plan");
    }),
  );
  it.effect("空目录或不可执行广告不会生成模式控件", () =>
    Effect.gen(function* () {
      for (const data of [[], [{ name: " ", mode: "plan" }], [{ name: "未知", mode: "future" }]]) {
        expect(yield* read({ data })).toEqual({ descriptor: undefined });
      }
    }),
  );
  it.effect("畸形目录明确提示，不补造模式或隐藏为正常发现", () =>
    Effect.gen(function* () {
      const result = yield* read({ data: [{ name: "坏数据", mode: 7 }] });
      expect(result.descriptor).toBeUndefined();
      expect("message" in result && result.message).toContain("读取失败");
    }),
  );
  it.effect("未知方法保留明确升级提示，其他RPC错误提示刷新", () =>
    Effect.gen(function* () {
      for (const code of [-32601, -32603]) {
        const result = yield* requestCodexCollaborationModes({
          raw: {
            request: () =>
              Effect.fail(
                new CodexErrors.CodexAppServerRequestError({
                  code,
                  errorMessage: "fixture",
                  method: "collaborationMode/list",
                }),
              ),
          },
        });
        expect(result.descriptor).toBeUndefined();
        expect("message" in result && result.message).toContain(
          code === -32601 ? "更新 CLI" : "刷新重试",
        );
      }
    }),
  );
});
