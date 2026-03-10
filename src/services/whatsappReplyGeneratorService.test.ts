import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ReplyGeneratorError,
  buildReplyGeneratorFromContext,
  parseReplyGeneratorJson,
  validateReplyGenerator
} from "./whatsappReplyGeneratorService.js";
import type { StageDetectionAnalysis } from "./whatsappStageDetectionService.js";
import type { StrategicAdvisorStrategy } from "./whatsappStrategicAdvisorService.js";

const stageAnalysisFixture: StageDetectionAnalysis = {
  stage: "QUALIFIED",
  stage_confidence: 0.9,
  priority_score: 81,
  urgency: "medium",
  payment_intent: true,
  dropoff_risk: "low",
  signals: [{ type: "payment_intent", evidence: "Client asks how to proceed with transfer" }],
  facts: {
    products_of_interest: ["Kaftan couture"],
    event_date: "2026-06-01",
    delivery_deadline: "2026-05-20",
    destination_country: "France",
    budget: null,
    price_points_detected: ["8500 MAD"],
    customization_requests: ["higher neckline"],
    preferred_colors: ["navy"],
    preferred_fabrics: ["silk"],
    payment_method_preference: "bank transfer"
  },
  objections: [],
  recommended_next_action: "push_softly_to_deposit",
  reasoning_summary: ["Intent is strong and transaction questions are explicit."]
};

const strategyFixture: StrategicAdvisorStrategy = {
  recommended_action: "reduce_friction_to_payment",
  action_confidence: 0.88,
  commercial_priority: "high",
  tone: "decisive_elegant",
  pressure_level: "low",
  primary_goal: "Secure commitment with clear payment and timeline clarity.",
  secondary_goal: "Preserve premium confidence while keeping momentum.",
  missed_opportunities: [],
  strategy_rationale: ["Client is ready to transact if process is simple."],
  do_now: ["Offer one clear payment path and immediate confirmation sequence."],
  avoid: ["Avoid long explanations and multiple parallel options."]
};

const validReplyOptions = {
  reply_options: [
    {
      label: "Option 1",
      intent: "Move directly toward payment confirmation",
      messages: [
        "Parfait, nous pouvons confirmer votre pièce aujourd'hui.",
        "Je vous partage immédiatement les détails du virement pour réserver votre réalisation.",
        "Dès réception, je valide le planning atelier avec votre date."
      ]
    },
    {
      label: "Option 2",
      intent: "Reassure on timing then close the next step",
      messages: [
        "Merci pour votre confiance.",
        "Votre délai reste parfaitement tenable sur notre planning actuel.",
        "Si cela vous convient, je vous envoie maintenant les coordonnées de règlement."
      ]
    },
    {
      label: "Option 3",
      intent: "Concise premium close",
      messages: [
        "Très bien, nous pouvons finaliser cela simplement.",
        "Je vous envoie les informations de paiement dans ce fil.",
        "Je confirme ensuite votre créneau de production sans délai."
      ]
    }
  ]
};

test("empty transcript rejection", async () => {
  let called = false;
  await assert.rejects(
    async () =>
      buildReplyGeneratorFromContext({
        leadId: "lead-1",
        transcript: { transcript: "", messageCount: 0, transcriptLength: 0 },
        stageAnalysis: stageAnalysisFixture,
        strategy: strategyFixture,
        callModel: async () => {
          called = true;
          return {
            provider: "openai",
            model: "gpt-4.1-mini",
            rawOutput: JSON.stringify(validReplyOptions),
            usage: null
          };
        }
      }),
    (error: unknown) => error instanceof ReplyGeneratorError && error.code === "reply_generator_empty_transcript"
  );
  assert.equal(called, false);
});

test("valid JSON parsing", () => {
  const parsed = parseReplyGeneratorJson(JSON.stringify(validReplyOptions)) as Record<string, unknown>;
  assert.ok(Array.isArray(parsed.reply_options));
});

test("invalid JSON handling", () => {
  assert.throws(() => parseReplyGeneratorJson("not-json"), (error: unknown) => {
    return error instanceof ReplyGeneratorError && error.code === "reply_generator_invalid_json";
  });
});

test("invalid shape handling", () => {
  const invalid = {
    reply_options: [
      {
        label: "Option 1",
        intent: "Missing messages"
      }
    ]
  };

  assert.throws(() => validateReplyGenerator(invalid), (error: unknown) => {
    return error instanceof ReplyGeneratorError && error.code === "reply_generator_invalid_schema";
  });
});

test("too many/few reply options", () => {
  const tooFew = { reply_options: validReplyOptions.reply_options.slice(0, 2) };
  const tooMany = { reply_options: [...validReplyOptions.reply_options, validReplyOptions.reply_options[0]] };

  assert.throws(() => validateReplyGenerator(tooFew), (error: unknown) => {
    return error instanceof ReplyGeneratorError && error.code === "reply_generator_invalid_schema";
  });
  assert.throws(() => validateReplyGenerator(tooMany), (error: unknown) => {
    return error instanceof ReplyGeneratorError && error.code === "reply_generator_invalid_schema";
  });
});

test("too many/few messages in an option", () => {
  const tooFewMessages = {
    reply_options: [
      {
        ...validReplyOptions.reply_options[0],
        messages: ["one"]
      },
      validReplyOptions.reply_options[1],
      validReplyOptions.reply_options[2]
    ]
  };

  const tooManyMessages = {
    reply_options: [
      {
        ...validReplyOptions.reply_options[0],
        messages: ["a", "b", "c", "d", "e"]
      },
      validReplyOptions.reply_options[1],
      validReplyOptions.reply_options[2]
    ]
  };

  assert.throws(() => validateReplyGenerator(tooFewMessages), (error: unknown) => {
    return error instanceof ReplyGeneratorError && error.code === "reply_generator_invalid_schema";
  });
  assert.throws(() => validateReplyGenerator(tooManyMessages), (error: unknown) => {
    return error instanceof ReplyGeneratorError && error.code === "reply_generator_invalid_schema";
  });
});

test("successful validated response", async () => {
  const result = await buildReplyGeneratorFromContext({
    leadId: "lead-1",
    transcript: {
      transcript:
        "[2026-03-05 09:00] CLIENT: How can I pay today?\n[2026-03-05 09:02] BFL: We can confirm immediately with transfer details.",
      messageCount: 2,
      transcriptLength: 124
    },
    stageAnalysis: stageAnalysisFixture,
    strategy: strategyFixture,
    callModel: async () => ({
      provider: "openai",
      model: "gpt-4.1-mini",
      rawOutput: JSON.stringify(validReplyOptions),
      usage: null
    })
  });

  assert.equal(result.replyOptions.reply_options.length, 3);
  assert.equal(result.replyOptions.reply_options[0].messages.length, 3);
  assert.ok(String(result.replyOptions.reply_options[0].reason_short || "").length > 12);
  assert.equal(String(result.replyOptions.reply_options[0].reason_short || "").includes(". "), false);
  assert.equal(result.strategy.recommended_action, "reduce_friction_to_payment");
  assert.equal(result.stageAnalysis.stage, "QUALIFIED");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4.1-mini");
  assert.equal(result.messageCount, 2);
  assert.equal(result.transcriptLength, 124);
});
