import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildPriorityDeskQueue,
  computePriorityScoreDeterministic,
  mapPriorityBand,
  type PriorityDeskItem
} from "./whatsappPriorityDeskService.js";
import type { AiCardsViewModel } from "./whatsappAiCardsService.js";

function aiCardsFixture(input: {
  leadId: string;
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: string;
  priorityScore?: number;
  recommendedAction: string;
  commercialPriority: string;
}): AiCardsViewModel {
  return {
    leadId: input.leadId,
    summary: {
      stage: input.stage,
      stageConfidence: 0.9,
      urgency: input.urgency,
      paymentIntent: input.paymentIntent,
      dropoffRisk: input.dropoffRisk,
      priorityScore: input.priorityScore ?? 70
    },
    strategy: {
      recommendedAction: input.recommendedAction,
      commercialPriority: input.commercialPriority,
      tone: "decisive_elegant",
      pressureLevel: "low",
      primaryGoal: "Goal",
      secondaryGoal: "Second"
    },
    signals: [],
    facts: {
      productsOfInterest: [],
      eventDate: null,
      deliveryDeadline: null,
      destinationCountry: null,
      budget: null,
      pricePointsDetected: [],
      customizationRequests: [],
      preferredColors: [],
      preferredFabrics: [],
      paymentMethodPreference: null
    },
    replyCards: [],
    brandGuardian: { approved: true, issues: [] },
    meta: {
      messageCount: 2,
      transcriptLength: 120,
      provider: "openai",
      model: "gpt-4.1-mini",
      timestamp: "2026-03-07T10:00:00.000Z"
    }
  };
}

test("unanswered inbound gets higher score", () => {
  const inboundAwaiting = computePriorityScoreDeterministic({
    stage: "QUALIFIED",
    urgency: "medium",
    paymentIntent: false,
    dropoffRisk: "low",
    recommendedAction: "answer_precisely",
    commercialPriority: "medium",
    needsReply: true,
    waitingSinceMinutes: 45
  });
  const noReplyNeeded = computePriorityScoreDeterministic({
    stage: "QUALIFIED",
    urgency: "medium",
    paymentIntent: false,
    dropoffRisk: "low",
    recommendedAction: "answer_precisely",
    commercialPriority: "medium",
    needsReply: false,
    waitingSinceMinutes: 0
  });

  assert.ok(inboundAwaiting.priorityScore > noReplyNeeded.priorityScore);
});

test("payment intent increases score", () => {
  const withIntent = computePriorityScoreDeterministic({
    stage: "PRICE_SENT",
    urgency: "low",
    paymentIntent: true,
    dropoffRisk: "low",
    recommendedAction: "push_softly_to_deposit",
    commercialPriority: "medium",
    needsReply: true,
    waitingSinceMinutes: 20
  });
  const withoutIntent = computePriorityScoreDeterministic({
    stage: "PRICE_SENT",
    urgency: "low",
    paymentIntent: false,
    dropoffRisk: "low",
    recommendedAction: "push_softly_to_deposit",
    commercialPriority: "medium",
    needsReply: true,
    waitingSinceMinutes: 20
  });

  assert.ok(withIntent.priorityScore > withoutIntent.priorityScore);
});

test("high urgency increases score", () => {
  const high = computePriorityScoreDeterministic({
    stage: "QUALIFICATION_PENDING",
    urgency: "high",
    paymentIntent: false,
    dropoffRisk: "medium",
    recommendedAction: "clarify_deadline",
    commercialPriority: "medium",
    needsReply: true,
    waitingSinceMinutes: 30
  });
  const low = computePriorityScoreDeterministic({
    stage: "QUALIFICATION_PENDING",
    urgency: "low",
    paymentIntent: false,
    dropoffRisk: "medium",
    recommendedAction: "clarify_deadline",
    commercialPriority: "medium",
    needsReply: true,
    waitingSinceMinutes: 30
  });

  assert.ok(high.priorityScore > low.priorityScore);
});

test("deposit_pending outranks product_interest", () => {
  const depositPending = computePriorityScoreDeterministic({
    stage: "DEPOSIT_PENDING",
    urgency: "medium",
    paymentIntent: true,
    dropoffRisk: "medium",
    recommendedAction: "reduce_friction_to_payment",
    commercialPriority: "high",
    needsReply: true,
    waitingSinceMinutes: 45
  });
  const productInterest = computePriorityScoreDeterministic({
    stage: "PRODUCT_INTEREST",
    urgency: "medium",
    paymentIntent: true,
    dropoffRisk: "medium",
    recommendedAction: "answer_precisely",
    commercialPriority: "high",
    needsReply: true,
    waitingSinceMinutes: 45
  });

  assert.ok(depositPending.priorityScore > productInterest.priorityScore);
});

test("priority band mapping works", () => {
  assert.equal(mapPriorityBand(10), "low");
  assert.equal(mapPriorityBand(35), "medium");
  assert.equal(mapPriorityBand(60), "high");
  assert.equal(mapPriorityBand(80), "critical");
});

test("ranked list sorts correctly", async () => {
  const nowMs = new Date("2026-03-07T12:00:00.000Z").getTime();
  const leadIds = ["lead-a", "lead-b", "lead-c"];
  const aiCardsByLead = new Map<string, AiCardsViewModel>([
    [
      "lead-a",
      aiCardsFixture({
        leadId: "lead-a",
        stage: "PRODUCT_INTEREST",
        urgency: "low",
        paymentIntent: false,
        dropoffRisk: "low",
        recommendedAction: "qualify",
        commercialPriority: "medium"
      })
    ],
    [
      "lead-b",
      aiCardsFixture({
        leadId: "lead-b",
        stage: "DEPOSIT_PENDING",
        urgency: "high",
        paymentIntent: true,
        dropoffRisk: "high",
        recommendedAction: "reduce_friction_to_payment",
        commercialPriority: "critical"
      })
    ],
    [
      "lead-c",
      aiCardsFixture({
        leadId: "lead-c",
        stage: "QUALIFIED",
        urgency: "medium",
        paymentIntent: false,
        dropoffRisk: "medium",
        recommendedAction: "clarify_deadline",
        commercialPriority: "high"
      })
    ]
  ]);

  const messagesByLead = new Map<string, Array<{ direction: "IN" | "OUT"; createdAt: string }>>([
    ["lead-a", [{ direction: "OUT", createdAt: "2026-03-07T11:55:00.000Z" }]],
    ["lead-b", [{ direction: "IN", createdAt: "2026-03-07T11:00:00.000Z" }]],
    ["lead-c", [{ direction: "IN", createdAt: "2026-03-07T11:40:00.000Z" }]]
  ]);

  const ranked: PriorityDeskItem[] = await buildPriorityDeskQueue(
    { limit: 3, days: 30 },
    {
      listLeadIds: async () => leadIds,
      getAiCards: async (leadId: string) => {
        const row = aiCardsByLead.get(leadId);
        if (!row) throw new Error("not_found");
        return row;
      },
      getMessagesByLeadIds: async () => messagesByLead,
      nowMs: () => nowMs
    }
  );

  assert.equal(ranked[0].leadId, "lead-b");
  assert.equal(ranked[1].leadId, "lead-c");
  assert.equal(ranked[2].leadId, "lead-a");
  assert.ok(ranked[0].priorityScore >= ranked[1].priorityScore);
  assert.ok(ranked[1].priorityScore >= ranked[2].priorityScore);
});
