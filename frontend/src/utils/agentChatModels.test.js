import assert from "node:assert/strict";
import test from "node:test";
import { pickDefaultAgentModelID } from "./agentChatModels.js";

test("picks the first enabled adapter id", () => {
  const id = pickDefaultAgentModelID({
    modelAdapters: [
      { id: "preview-demo-openai", enabled: true, displayName: "Demo OpenAI" },
      { id: "preview-demo-claude", enabled: true, displayName: "Demo Claude" },
    ],
  });
  assert.equal(id, "preview-demo-openai");
});

test("skips disabled adapters and empty config", () => {
  assert.equal(pickDefaultAgentModelID({
    modelAdapters: [{ id: "off", enabled: false }],
  }), "");
  assert.equal(pickDefaultAgentModelID(null), "");
  assert.equal(pickDefaultAgentModelID({}), "");
});
