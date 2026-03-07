import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ReactivationReplyError,
  buildReactivationRepliesFromContext,
  parseReactivationReplyJson,
  validateReactivationReplyPayload
} from "./whatsappReactivationReplyService.js";
import type { ReactivationDecision } from "./whatsappReactivationEngineService.js";
import type { AiCardsViewModel } from "./whatsappAiCardsService.js";
import type { LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";

const transcriptFixture: LeadTranscriptResult = {
  transcript:
    "[2026-03-10 10:00] CLIENT: Bonjour\n[2026-03-10 10:03] BFL: Merci beaucoup, je reste à votre disposition.",
  messageCount: 2,
  transcriptLength: 106
};

const aiCardsFixture: AiCardsViewModel = {
  leadId: "lead-1",
  summary: {
    stage: "PRICE_SENT",
    stageConfidence: 0.9,
    urgency: "medium",
    paymentIntent: true,
    dropoffRisk: "medium",
    priorityScore: 80
  },
  strategy: {
    recommendedAction: "reactivate_gently",
    commercialPriority: "high",
    tone: "warm_refined",
    pressureLevel: "low",
    primaryGoal: "Re-open the conversation with elegance.",
    secondaryGoal: "Keep momentum without pressure."
  },
  signals: [],
  facts: {
    productsOfInterest: ["Kaftan"],
    eventDate: null,
    deliveryDeadline: null,
    destinationCountry: "France",
    budget: null,
    pricePointsDetected: ["9000 MAD"],
    customizationRequests: [],
    preferredColors: [],
    preferredFabrics: [],
    paymentMethodPreference: "bank transfer"
  },
  replyCards: [],
  brandGuardian: { approved: true, issues: [] },
  meta: {
    messageCount: 2,
    transcriptLength: 106,
    provider: "openai",
    model: "gpt-4.1-mini",
    timestamp: "2026-03-10T10:00:00.000Z"
  }
};

const decisionNoReactivate: ReactivationDecision = {
  leadId: "lead-1",
  shouldReactivate: false,
  reactivationPriority: "low",
  reactivationReason: "No reactivation needed",
  stalledStage: null,
  silenceHours: 2,
  signals: [],
  recommendedAction: "wait",
  tone: null,
  timing: "monitor"
};

const decisionReactivate: ReactivationDecision = {
  leadId: "lead-1",
  shouldReactivate: true,
  reactivationPriority: "high",
  reactivationReason: "Price sent with silence",
  stalledStage: "PRICE_SENT",
  silenceHours: 72,
  signals: ["price_sent_stall"],
  recommendedAction: "reactivate_gently",
  tone: "reassuring",
  timing: "now"
};

const validGeneratedPayload = {
  shouldGenerate: true,
  replyOptions: [
    {
      label: "Option 1",
      intent: "Warm restart",
      messages: [
        "Je me permets de revenir vers vous avec attention.",
        "Si vous le souhaitez, je peux confirmer les prochains éléments en toute simplicité."
      ]
    },
    {
      label: "Option 2",
      intent: "Elegant reminder",
      messages: [
        "Merci encore pour votre intérêt.",
        "Je reste disponible pour avancer sereinement quand cela vous convient."
      ]
    },
    {
      label: "Option 3",
      intent: "Soft close-in",
      messages: [
        "Je voulais vous laisser un mot avant clôture de planning.",
        "Souhaitez-vous que je vous réserve un créneau pour cette pièce ?",
        "Je m'adapte entièrement à votre rythme."
      ]
    }
  ]
};

test("shouldGenerate false skips AI call", async () => {
  let called = false;
  const result = await buildReactivationRepliesFromContext({
    leadId: "lead-1",
    reactivationDecision: decisionNoReactivate,
    transcript: transcriptFixture,
    aiCards: aiCardsFixture,
    callModel: async () => {
      called = true;
      return { provider: "openai", model: "gpt-4.1-mini", rawOutput: JSON.stringify(validGeneratedPayload) };
    }
  });

  assert.equal(result.shouldGenerate, false);
  assert.equal(result.replyOptions.length, 0);
  assert.equal(called, false);
});

test("valid JSON parsing", () => {
  const parsed = parseReactivationReplyJson(JSON.stringify(validGeneratedPayload)) as Record<string, unknown>;
  assert.equal(parsed.shouldGenerate, true);
});

test("invalid JSON handling", () => {
  assert.throws(() => parseReactivationReplyJson("not-json"), (error: unknown) => {
    return error instanceof ReactivationReplyError && error.code === "reactivation_replies_invalid_json";
  });
});

test("invalid option count", () => {
  const invalid = { ...validGeneratedPayload, replyOptions: validGeneratedPayload.replyOptions.slice(0, 2) };
  assert.throws(() => validateReactivationReplyPayload(invalid), (error: unknown) => {
    return error instanceof ReactivationReplyError && error.code === "reactivation_replies_invalid_schema";
  });
});

test("invalid message count", () => {
  const invalid = {
    ...validGeneratedPayload,
    replyOptions: [
      {
        ...validGeneratedPayload.replyOptions[0],
        messages: ["one"]
      },
      validGeneratedPayload.replyOptions[1],
      validGeneratedPayload.replyOptions[2]
    ]
  };
  assert.throws(() => validateReactivationReplyPayload(invalid), (error: unknown) => {
    return error instanceof ReactivationReplyError && error.code === "reactivation_replies_invalid_schema";
  });
});

test("successful validated response", async () => {
  const result = await buildReactivationRepliesFromContext({
    leadId: "lead-1",
    reactivationDecision: decisionReactivate,
    transcript: transcriptFixture,
    aiCards: aiCardsFixture,
    callModel: async () => ({
      provider: "openai",
      model: "gpt-4.1-mini",
      rawOutput: JSON.stringify(validGeneratedPayload)
    })
  });

  assert.equal(result.shouldGenerate, true);
  assert.equal(result.reactivationDecision.shouldReactivate, true);
  assert.equal(result.replyOptions.length, 3);
  assert.equal(result.replyOptions[2].messages.length, 3);
  assert.equal(result.provider, "openai");
});
