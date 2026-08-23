import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGoal } from "./goalNormalize.js";
import { normalizeDelegationExecutorPolicy } from "./delegationExecutorConfig.js";

test("Goal normalization preserves explicit unlimited and repairs invalid budgets", () => {
  assert.deepEqual(normalizeGoal({ enabled: true }), {
    enabled: true,
    maxProviderPasses: 30,
    maxDurationSeconds: 0,
    maxCostUsd: 0,
    selfCheckPasses: 0,
    verifyMaxRetries: 0,
    errorMaxRetries: 0,
    progressInterval: 0,
  });
  assert.equal(normalizeGoal({ enabled: false }).maxProviderPasses, 30);
  const explicitUnlimited = normalizeGoal({ enabled: true, maxProviderPasses: 0, maxDurationSeconds: -1, maxCostUsd: -1.25 });
  assert.equal(explicitUnlimited.maxProviderPasses, 0);
  assert.equal(normalizeGoal({ enabled: true, maxProviderPasses: -1 }).maxProviderPasses, 30);
  assert.equal(explicitUnlimited.maxDurationSeconds, 0);
  assert.equal(explicitUnlimited.maxCostUsd, 0);
  assert.equal(normalizeGoal({ maxCostUsd: 1.25 }).maxCostUsd, 1.25);
});

test("delegation normalization preserves executor policy without secret values", () => {
  const source = {
    executorFailoverLimit: 2,
    executors: [{
      id: " claude-code ",
      kind: " builtin ",
      displayName: " Claude Code ",
      enabled: true,
      priority: 1,
      executable: " claude.exe ",
      probeTimeoutSeconds: 5,
      executionTimeoutSeconds: 120,
      environmentVariables: [" ANTHROPIC_API_KEY ", "ANTHROPIC_API_KEY", "TOKEN=secret-value"],
      options: { outputFormat: " stream-json ", apiKey: "secret-value", apikey: "secret-value" },
    }],
  };

  const normalized = normalizeDelegationExecutorPolicy(source);
  source.executors[0].environmentVariables[0] = "MUTATED";
  source.executors[0].options.outputFormat = "mutated";

  assert.equal(normalized.executorFailoverLimit, 2);
  assert.deepEqual(normalized.executors, [{
    id: "claude-code",
    kind: "builtin",
    displayName: "Claude Code",
    enabled: true,
    priority: 1,
    executable: "claude.exe",
    probeTimeoutSeconds: 5,
    executionTimeoutSeconds: 120,
    environmentVariables: ["ANTHROPIC_API_KEY"],
    options: { outputFormat: "stream-json" },
  }]);
});

test("legacy delegation defaults external executors to disabled empty policy", () => {
  const normalized = normalizeDelegationExecutorPolicy({ enabled: true });
  assert.equal(normalized.executorFailoverLimit, 3);
  assert.deepEqual(normalized.executors, []);
});
