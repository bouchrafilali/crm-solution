import { strict as assert } from "node:assert";
import { test } from "node:test";
import { estimateAiCostUsd } from "./aiPricing.js";

test("per-step cost calculation", () => {
  const row = estimateAiCostUsd({
    provider: "openai",
    model: "gpt-4.1-mini",
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0
    }
  });

  assert.equal(row.unitInputPricePerMillion, 0.4);
  assert.equal(row.unitOutputPricePerMillion, 1.6);
  assert.equal(row.estimatedCostUsd, 0.0012);
});

test("missing token usage handled safely", () => {
  const row = estimateAiCostUsd({
    provider: "claude",
    model: "claude-haiku-4-5-20251001",
    usage: null
  });

  assert.equal(row.unitInputPricePerMillion, 1);
  assert.equal(row.unitOutputPricePerMillion, 5);
  assert.equal(row.estimatedCostUsd, null);
});
