import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  StrategicAdvisorError,
  buildStrategicAdvisorFromContext,
  parseStrategicAdvisorJson,
  validateStrategicAdvisor
} from "./whatsappStrategicAdvisorService.js";
import type { StageDetectionAnalysis } from "./whatsappStageDetectionService.js";

const stageAnalysisFixture: StageDetectionAnalysis = {
  stage: "QUALIFIED",
  stage_confidence: 0.91,
  priority_score: 79,
  urgency: "medium",
  payment_intent: true,
  dropoff_risk: "low",
  signals: [{ type: "payment_intent", evidence: "Client asked how to transfer deposit" }],
  facts: {
    products_of_interest: ["Takchita couture"],
    event_date: "2026-05-22",
    delivery_deadline: "2026-05-15",
    destination_country: "France",
    budget: null,
    price_points_detected: ["9000 MAD"],
    customization_requests: ["more coverage at bust"],
    preferred_colors: ["ivory"],
    preferred_fabrics: ["crepe"],
    payment_method_preference: "bank transfer"
  },
  objections: [{ type: "timing", evidence: "Client asked if delivery can be guaranteed before travel" }],
  recommended_next_action: "clarify_timing",
  reasoning_summary: ["Strong intent, but timeline certainty is required for conversion."]
};

const validStrategyJson = {
  recommended_action: "reduce_friction_to_payment",
  action_confidence: 0.89,
  commercial_priority: "high",
  tone: "decisive_elegant",
  pressure_level: "low",
  primary_goal: "Remove payment friction and secure commitment this week.",
  secondary_goal: "Protect confidence on delivery timing and customization feasibility.",
  missed_opportunities: ["No explicit payment sequence was summarized earlier."],
  strategy_rationale: ["Client is purchase-ready and asking transaction details."],
  do_now: ["Provide one clear payment path and timeline confirmation."],
  avoid: ["Avoid introducing new options that delay decision."]
};

test("empty transcript rejection", async () => {
  let called = false;
  await assert.rejects(
    async () =>
      buildStrategicAdvisorFromContext({
        leadId: "lead-1",
        transcript: { transcript: "", messageCount: 0, transcriptLength: 0 },
        stageAnalysis: stageAnalysisFixture,
        callModel: async () => {
          called = true;
          return {
            provider: "openai",
            model: "gpt-4.1-mini",
            rawOutput: JSON.stringify(validStrategyJson),
            usage: null
          };
        }
      }),
    (error: unknown) => error instanceof StrategicAdvisorError && error.code === "strategic_advisor_empty_transcript"
  );
  assert.equal(called, false);
});

test("valid JSON parsing", () => {
  const parsed = parseStrategicAdvisorJson(JSON.stringify(validStrategyJson)) as Record<string, unknown>;
  assert.equal(parsed.recommended_action, "reduce_friction_to_payment");
});

test("invalid JSON handling", () => {
  assert.throws(() => parseStrategicAdvisorJson("not-json"), (error: unknown) => {
    return error instanceof StrategicAdvisorError && error.code === "strategic_advisor_invalid_json";
  });
});

test("invalid enum handling", () => {
  const invalid = {
    ...validStrategyJson,
    tone: "invalid_tone"
  };

  assert.throws(() => validateStrategicAdvisor(invalid), (error: unknown) => {
    return error instanceof StrategicAdvisorError && error.code === "strategic_advisor_invalid_schema";
  });
});

test("successful validated response", async () => {
  const result = await buildStrategicAdvisorFromContext({
    leadId: "lead-1",
    transcript: {
      transcript:
        "[2026-03-04 11:00] CLIENT: Can I pay by transfer today?\n[2026-03-04 11:03] BFL: Absolutely, we can confirm details now.",
      messageCount: 2,
      transcriptLength: 122
    },
    stageAnalysis: stageAnalysisFixture,
    callModel: async () => ({
      provider: "openai",
      model: "gpt-4.1-mini",
      rawOutput: JSON.stringify(validStrategyJson),
      usage: null
    })
  });

  assert.equal(result.strategy.recommended_action, "reduce_friction_to_payment");
  assert.equal(result.strategy.commercial_priority, "high");
  assert.equal(result.stageAnalysis.stage, "QUALIFIED");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4.1-mini");
  assert.equal(result.messageCount, 2);
  assert.equal(result.transcriptLength, 122);
});
