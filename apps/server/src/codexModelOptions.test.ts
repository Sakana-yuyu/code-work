import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@codework/contracts";
import { createModelSelection } from "@codework/shared/model";

import {
  getCodexCollaborationModeOptionValue,
  getCodexServiceTierOptionValue,
} from "./codexModelOptions.ts";

it("原生模式只传递可执行标识，不把未知或错误类型提升为Plan", () => {
  for (const value of ["plan", "default", "future", true]) {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "fixture", [
      { id: "codexCollaborationMode", value },
    ]);
    assert.equal(
      getCodexCollaborationModeOptionValue(selection),
      value === "plan" || value === "default" ? value : undefined,
    );
  }
  assert.equal(getCodexCollaborationModeOptionValue(null), undefined);
});

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});
