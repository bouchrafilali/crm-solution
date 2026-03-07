import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AiCardsOrchestrationError, buildAiCardsViewModel } from "./whatsappAiCardsService.js";
import type { LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import type { StageDetectionResult } from "./whatsappStageDetectionService.js";
import type { StrategicAdvisorResult } from "./whatsappStrategicAdvisorService.js";
import type { ReplyGeneratorResult } from "./whatsappReplyGeneratorService.js";
import type { BrandGuardianResult } from "./whatsappBrandGuardianService.js";

const transcriptFixture: LeadTranscriptResult = {
  transcript:
    "[2026-03-07 10:00] CLIENT: I can transfer today\n[2026-03-07 10:03] BFL: Perfect, I can confirm your order today.",
  messageCount: 2,
  transcriptLength: 112
};

const stageDetectionFixture: StageDetectionResult = {
  analysis: {
    stage: "QUALIFIED",
    stage_confidence: 0.9,
    priority_score: 86,
    urgency: "medium",
    payment_intent: true,
    dropoff_risk: "low",
    signals: [{ type: "payment_intent", evidence: "Client says can transfer today" }],
    facts: {
      products_of_interest: ["Kaftan couture"],
      event_date: "2026-06-20",
      delivery_deadline: "2026-06-12",
      destination_country: "France",
      budget: null,
      price_points_detected: ["9500 MAD"],
      customization_requests: ["higher neckline"],
      preferred_colors: ["ivory"],
      preferred_fabrics: ["silk"],
      payment_method_preference: "bank transfer"
    },
    objections: [],
    recommended_next_action: "push_softly_to_deposit",
    reasoning_summary: ["High intent and payment readiness."]
  },
  transcriptLength: 112,
  messageCount: 2,
  provider: "openai",
  model: "gpt-4.1-mini",
  timestamp: "2026-03-07T10:00:00.000Z"
};

const strategicFixture: StrategicAdvisorResult = {
  strategy: {
    recommended_action: "reduce_friction_to_payment",
    action_confidence: 0.88,
    commercial_priority: "high",
    tone: "decisive_elegant",
    pressure_level: "low",
    primary_goal: "Secure payment with a clear next step.",
    secondary_goal: "Maintain reassurance on timing.",
    missed_opportunities: [],
    strategy_rationale: ["Client is ready to proceed."],
    do_now: ["Share one payment path clearly."],
    avoid: ["Avoid unnecessary options."]
  },
  stageAnalysis: stageDetectionFixture.analysis,
  transcriptLength: 112,
  messageCount: 2,
  provider: "openai",
  model: "gpt-4.1-mini",
  timestamp: "2026-03-07T10:00:01.000Z"
};

const replyFixture: ReplyGeneratorResult = {
  replyOptions: {
    reply_options: [
      {
        label: "Option 1",
        intent: "Direct close",
        messages: ["Parfait.", "Je vous envoie les coordonnées de virement."]
      },
      {
        label: "Option 2",
        intent: "Reassure then close",
        messages: ["Merci pour votre confiance.", "Le délai reste maîtrisé.", "Je vous partage les détails de règlement."]
      },
      {
        label: "Option 3",
        intent: "Concise premium",
        messages: ["Très bien.", "Nous pouvons finaliser aujourd'hui."]
      }
    ]
  },
  strategy: strategicFixture.strategy,
  stageAnalysis: stageDetectionFixture.analysis,
  transcriptLength: 112,
  messageCount: 2,
  provider: "openai",
  model: "gpt-4.1-mini",
  timestamp: "2026-03-07T10:00:02.000Z"
};

const brandFixture: BrandGuardianResult = {
  review: {
    approved: true,
    issues: [],
    reply_options: [
      {
        label: "Option 1",
        intent: "Direct close",
        messages: ["Parfait, nous pouvons confirmer aujourd'hui.", "Je vous transmets les coordonnées de virement."]
      },
      {
        label: "Option 2",
        intent: "Reassure then close",
        messages: ["Merci pour votre confiance.", "Votre délai demeure parfaitement maîtrisé.", "Je vous envoie les détails de règlement."]
      },
      {
        label: "Option 3",
        intent: "Concise premium",
        messages: ["Très bien, nous avançons.", "Je confirme votre créneau dès réception."]
      }
    ]
  },
  replyOptions: replyFixture.replyOptions,
  strategy: strategicFixture.strategy,
  stageAnalysis: stageDetectionFixture.analysis,
  transcriptLength: 112,
  messageCount: 2,
  provider: "openai",
  model: "gpt-4.1-mini",
  timestamp: "2026-03-07T10:00:03.000Z"
};

function makeSuccessDeps() {
  return {
    getTranscript: async () => transcriptFixture,
    getStageDetection: async () => stageDetectionFixture,
    getStrategicAdvisor: async () => strategicFixture,
    getReplyGenerator: async () => replyFixture,
    getBrandGuardian: async () => brandFixture
  };
}

test("successful full orchestration", async () => {
  const vm = await buildAiCardsViewModel("lead-1", makeSuccessDeps());
  assert.equal(vm.leadId, "lead-1");
  assert.equal(vm.summary.stage, "QUALIFIED");
  assert.equal(vm.strategy.recommendedAction, "reduce_friction_to_payment");
  assert.equal(vm.replyCards.length, 3);
  assert.equal(vm.brandGuardian.approved, true);
  assert.equal(vm.meta.provider, "openai");
});

test("failure in stage detection", async () => {
  await assert.rejects(
    async () =>
      buildAiCardsViewModel("lead-1", {
        ...makeSuccessDeps(),
        getStageDetection: async () => {
          throw new Error("Invalid AI response shape");
        }
      }),
    (error: unknown) => error instanceof AiCardsOrchestrationError && error.step === "stage_detection"
  );
});

test("failure in strategic advisor", async () => {
  await assert.rejects(
    async () =>
      buildAiCardsViewModel("lead-1", {
        ...makeSuccessDeps(),
        getStrategicAdvisor: async () => {
          throw new Error("Invalid AI response shape");
        }
      }),
    (error: unknown) => error instanceof AiCardsOrchestrationError && error.step === "strategic_advisor"
  );
});

test("failure in reply generator", async () => {
  await assert.rejects(
    async () =>
      buildAiCardsViewModel("lead-1", {
        ...makeSuccessDeps(),
        getReplyGenerator: async () => {
          throw new Error("Invalid AI response shape");
        }
      }),
    (error: unknown) => error instanceof AiCardsOrchestrationError && error.step === "reply_generator"
  );
});

test("failure in brand guardian", async () => {
  await assert.rejects(
    async () =>
      buildAiCardsViewModel("lead-1", {
        ...makeSuccessDeps(),
        getBrandGuardian: async () => {
          throw new Error("Invalid AI response shape");
        }
      }),
    (error: unknown) => error instanceof AiCardsOrchestrationError && error.step === "brand_guardian"
  );
});

test("correct response mapping shape", async () => {
  const vm = await buildAiCardsViewModel("lead-1", makeSuccessDeps());

  assert.deepEqual(Object.keys(vm).sort(), [
    "brandGuardian",
    "facts",
    "leadId",
    "meta",
    "replyCards",
    "signals",
    "strategy",
    "summary"
  ]);

  assert.equal(vm.summary.stageConfidence, 0.9);
  assert.equal(vm.summary.paymentIntent, true);
  assert.equal(vm.facts.productsOfInterest[0], "Kaftan couture");
  assert.equal(vm.facts.paymentMethodPreference, "bank transfer");
  assert.equal(vm.strategy.primaryGoal, "Secure payment with a clear next step.");
  assert.equal(vm.replyCards[0].messages[0], "Parfait, nous pouvons confirmer aujourd'hui.");
  assert.equal(vm.brandGuardian.issues.length, 0);
  assert.equal(vm.meta.timestamp, "2026-03-07T10:00:03.000Z");
});
