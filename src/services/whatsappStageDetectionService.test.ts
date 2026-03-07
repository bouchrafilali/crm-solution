import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  StageDetectionError,
  detectStageFromTranscript,
  parseStageDetectionJson,
  validateStageDetectionAnalysis
} from "./whatsappStageDetectionService.js";

const validAnalysisJson = {
  stage: "QUALIFIED",
  stage_confidence: 0.88,
  priority_score: 82,
  urgency: "medium",
  payment_intent: true,
  dropoff_risk: "low",
  signals: [
    {
      type: "price_request",
      evidence: "Client asked for exact final price"
    }
  ],
  facts: {
    products_of_interest: ["Kaftan couture"],
    event_date: "2026-04-18",
    delivery_deadline: "2026-04-10",
    destination_country: "France",
    budget: null,
    price_points_detected: ["6500 MAD"],
    customization_requests: ["more closed neckline"],
    preferred_colors: ["emerald"],
    preferred_fabrics: ["silk"],
    payment_method_preference: "bank transfer"
  },
  objections: [
    {
      type: "timing",
      evidence: "Client asked if delivery before event is guaranteed"
    }
  ],
  recommended_next_action: "clarify_timing",
  reasoning_summary: ["Lead shared event context and asks operational questions after pricing."]
};

test("empty transcript rejection", async () => {
  let called = false;
  await assert.rejects(
    async () =>
      detectStageFromTranscript({
        leadId: "lead-1",
        transcript: { transcript: "", messageCount: 0, transcriptLength: 0 },
        callModel: async () => {
          called = true;
          return {
            provider: "openai",
            model: "gpt-4.1-mini",
            rawOutput: JSON.stringify(validAnalysisJson)
          };
        }
      }),
    (error: unknown) => error instanceof StageDetectionError && error.code === "stage_detection_empty_transcript"
  );
  assert.equal(called, false);
});

test("valid JSON parsing", () => {
  const raw = JSON.stringify(validAnalysisJson);
  const parsed = parseStageDetectionJson(raw) as Record<string, unknown>;
  assert.equal(parsed.stage, "QUALIFIED");
});

test("invalid JSON handling", () => {
  assert.throws(() => parseStageDetectionJson("not-json"), (error: unknown) => {
    return error instanceof StageDetectionError && error.code === "stage_detection_invalid_json";
  });
});

test("invalid enum handling", () => {
  const invalid = {
    ...validAnalysisJson,
    stage: "NOT_A_STAGE"
  };

  assert.throws(() => validateStageDetectionAnalysis(invalid), (error: unknown) => {
    return error instanceof StageDetectionError && error.code === "stage_detection_invalid_schema";
  });
});

test("successful validated response", async () => {
  const result = await detectStageFromTranscript({
    leadId: "lead-1",
    transcript: {
      transcript:
        "[2026-03-01 10:00] CLIENT: Bonjour je veux ce kaftan\n[2026-03-01 10:02] BFL: Merci beaucoup, pour quelle date est votre evenement ?",
      messageCount: 2,
      transcriptLength: 132
    },
    callModel: async () => ({
      provider: "openai",
      model: "gpt-4.1-mini",
      rawOutput: JSON.stringify(validAnalysisJson)
    })
  });

  assert.equal(result.analysis.stage, "QUALIFIED");
  assert.equal(result.analysis.recommended_next_action, "clarify_timing");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4.1-mini");
  assert.equal(result.messageCount, 2);
  assert.equal(result.transcriptLength, 132);
});
