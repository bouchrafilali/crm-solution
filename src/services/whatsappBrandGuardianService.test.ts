import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BrandGuardianError,
  buildBrandGuardianFromContext,
  parseBrandGuardianJson,
  validateBrandGuardianReview
} from "./whatsappBrandGuardianService.js";
import type { StageDetectionAnalysis } from "./whatsappStageDetectionService.js";
import type { StrategicAdvisorStrategy } from "./whatsappStrategicAdvisorService.js";
import type { ReplyGeneratorPayload } from "./whatsappReplyGeneratorService.js";

const stageAnalysisFixture: StageDetectionAnalysis = {
  stage: "QUALIFIED",
  stage_confidence: 0.92,
  priority_score: 84,
  urgency: "medium",
  payment_intent: true,
  dropoff_risk: "low",
  signals: [{ type: "payment_intent", evidence: "Client asks for transfer process" }],
  facts: {
    products_of_interest: ["Kaftan couture"],
    event_date: "2026-06-20",
    delivery_deadline: "2026-06-12",
    destination_country: "France",
    budget: null,
    price_points_detected: ["9200 MAD"],
    customization_requests: ["more coverage"],
    preferred_colors: ["ivory"],
    preferred_fabrics: ["silk"],
    payment_method_preference: "bank transfer"
  },
  objections: [],
  recommended_next_action: "push_softly_to_deposit",
  reasoning_summary: ["High intent and transactional questions are explicit."]
};

const strategyFixture: StrategicAdvisorStrategy = {
  recommended_action: "reduce_friction_to_payment",
  action_confidence: 0.9,
  commercial_priority: "high",
  tone: "decisive_elegant",
  pressure_level: "low",
  primary_goal: "Secure payment commitment with clarity and confidence.",
  secondary_goal: "Preserve premium reassurance on timeline.",
  missed_opportunities: [],
  strategy_rationale: ["Client appears close to purchase."],
  do_now: ["Give a clean next step."],
  avoid: ["Avoid unnecessary complexity."]
};

const replyOptionsFixture: ReplyGeneratorPayload = {
  reply_options: [
    {
      label: "Option 1",
      intent: "Direct payment close",
      messages: [
        "Parfait, nous pouvons finaliser votre réservation aujourd'hui.",
        "Je vous envoie immédiatement les coordonnées de virement.",
        "Dès réception, je confirme votre planning atelier."
      ]
    },
    {
      label: "Option 2",
      intent: "Reassure then close",
      messages: [
        "Merci pour votre confiance.",
        "Votre délai reste bien sécurisé sur notre planning actuel.",
        "Souhaitez-vous que je vous partage maintenant les informations de règlement ?"
      ]
    },
    {
      label: "Option 3",
      intent: "Concise premium progression",
      messages: [
        "Très bien, nous avançons dans les meilleures conditions.",
        "Je vous envoie les détails de paiement dans ce fil.",
        "Je valide ensuite votre créneau de production."
      ]
    }
  ]
};

const validApprovalResponse = {
  approved: true,
  issues: [],
  reply_options: replyOptionsFixture.reply_options
};

const validRewriteResponse = {
  approved: false,
  issues: ["Option 2 sounded slightly generic in the closing line."],
  reply_options: [
    replyOptionsFixture.reply_options[0],
    {
      label: "Option 2",
      intent: "Reassure then close",
      messages: [
        "Merci pour votre confiance.",
        "Votre délai demeure parfaitement maîtrisé sur notre planning.",
        "Si vous le souhaitez, je vous transmets maintenant les coordonnées de règlement pour confirmer."
      ]
    },
    replyOptionsFixture.reply_options[2]
  ]
};

test("valid approval response", async () => {
  const result = await buildBrandGuardianFromContext({
    leadId: "lead-1",
    transcript: {
      transcript:
        "[2026-03-06 10:00] CLIENT: Can I transfer today?\n[2026-03-06 10:03] BFL: Yes, I can share details now.",
      messageCount: 2,
      transcriptLength: 106
    },
    stageAnalysis: stageAnalysisFixture,
    strategy: strategyFixture,
    replyOptions: replyOptionsFixture,
    callModel: async () => ({
      provider: "openai",
      model: "gpt-4.1-mini",
      rawOutput: JSON.stringify(validApprovalResponse)
    })
  });

  assert.equal(result.review.approved, true);
  assert.equal(result.review.issues.length, 0);
  assert.equal(result.review.reply_options.length, 3);
});

test("valid rewrite response", async () => {
  const result = await buildBrandGuardianFromContext({
    leadId: "lead-1",
    transcript: {
      transcript:
        "[2026-03-06 10:00] CLIENT: Can I transfer today?\n[2026-03-06 10:03] BFL: Yes, I can share details now.",
      messageCount: 2,
      transcriptLength: 106
    },
    stageAnalysis: stageAnalysisFixture,
    strategy: strategyFixture,
    replyOptions: replyOptionsFixture,
    callModel: async () => ({
      provider: "openai",
      model: "gpt-4.1-mini",
      rawOutput: JSON.stringify(validRewriteResponse)
    })
  });

  assert.equal(result.review.approved, false);
  assert.equal(result.review.issues.length, 1);
  assert.equal(result.review.reply_options[1].messages.length, 3);
});

test("invalid JSON handling", () => {
  assert.throws(() => parseBrandGuardianJson("not-json"), (error: unknown) => {
    return error instanceof BrandGuardianError && error.code === "brand_guardian_invalid_json";
  });
});

test("invalid shape handling", () => {
  const invalid = {
    approved: true,
    issues: ["x"]
  };

  assert.throws(() => validateBrandGuardianReview(invalid), (error: unknown) => {
    return error instanceof BrandGuardianError && error.code === "brand_guardian_invalid_schema";
  });
});

test("invalid reply option count", () => {
  const invalid = {
    approved: true,
    issues: [],
    reply_options: replyOptionsFixture.reply_options.slice(0, 2)
  };

  assert.throws(() => validateBrandGuardianReview(invalid), (error: unknown) => {
    return error instanceof BrandGuardianError && error.code === "brand_guardian_invalid_schema";
  });
});

test("invalid message count in options", () => {
  const invalid = {
    approved: true,
    issues: [],
    reply_options: [
      {
        ...replyOptionsFixture.reply_options[0],
        messages: ["one"]
      },
      replyOptionsFixture.reply_options[1],
      replyOptionsFixture.reply_options[2]
    ]
  };

  assert.throws(() => validateBrandGuardianReview(invalid), (error: unknown) => {
    return error instanceof BrandGuardianError && error.code === "brand_guardian_invalid_schema";
  });
});
