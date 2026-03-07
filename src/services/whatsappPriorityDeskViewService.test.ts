import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPriorityDeskView } from "./whatsappPriorityDeskViewService.js";
import type { PriorityDeskItem } from "./whatsappPriorityDeskService.js";
import type { AiCardsViewModel } from "./whatsappAiCardsService.js";

function queueItem(input: {
  leadId: string;
  score: number;
  band: "low" | "medium" | "high" | "critical";
  heat: "cold" | "warm" | "hot";
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: string;
  recommendedAction: string;
  commercialPriority: string;
  waiting: number;
  needsReply: boolean;
}): PriorityDeskItem {
  return {
    leadId: input.leadId,
    priorityScore: input.score,
    priorityBand: input.band,
    estimatedHeat: input.heat,
    stage: input.stage,
    urgency: input.urgency,
    paymentIntent: input.paymentIntent,
    dropoffRisk: input.dropoffRisk,
    recommendedAction: input.recommendedAction,
    commercialPriority: input.commercialPriority,
    waitingSinceMinutes: input.waiting,
    needsReply: input.needsReply,
    reasons: ["r1"]
  };
}

function aiCards(input: { leadId: string; tone?: string; topLabel?: string }): AiCardsViewModel {
  const tone = input.tone === undefined ? "decisive_elegant" : input.tone;
  return {
    leadId: input.leadId,
    summary: {
      stage: "QUALIFIED",
      stageConfidence: 0.9,
      urgency: "medium",
      paymentIntent: true,
      dropoffRisk: "low",
      priorityScore: 80
    },
    strategy: {
      recommendedAction: "reduce_friction_to_payment",
      commercialPriority: "high",
      tone,
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
    replyCards: [
      {
        label: input.topLabel ?? "Option 1",
        intent: "Fast close",
        messages: ["Message 1", "Message 2"]
      },
      {
        label: "Option 2",
        intent: "Reassure",
        messages: ["Alt 1", "Alt 2"]
      }
    ],
    brandGuardian: {
      approved: true,
      issues: []
    },
    meta: {
      messageCount: 2,
      transcriptLength: 100,
      provider: "openai",
      model: "gpt-4.1-mini",
      timestamp: "2026-03-07T10:00:00.000Z"
    }
  };
}

test("successful response shape", async () => {
  const queue: PriorityDeskItem[] = [
    queueItem({
      leadId: "lead-1",
      score: 88,
      band: "critical",
      heat: "hot",
      stage: "DEPOSIT_PENDING",
      urgency: "high",
      paymentIntent: true,
      dropoffRisk: "high",
      recommendedAction: "reduce_friction_to_payment",
      commercialPriority: "critical",
      waiting: 90,
      needsReply: true
    })
  ];

  const payload = await buildPriorityDeskView(
    { limit: 20, days: 30 },
    {
      getPriorityQueue: async () => queue,
      getLeadsMeta: async () => [{ id: "lead-1", clientName: "Amina" }],
      getLatestMessagesByLead: async () => new Map([["lead-1", { direction: "IN", text: "  Bonjour, je peux payer aujourd'hui  ", createdAt: "2026-03-07T11:00:00.000Z" }]]),
      getAiCards: async () => aiCards({ leadId: "lead-1" })
    }
  );

  assert.ok(Array.isArray(payload.items));
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].leadId, "lead-1");
  assert.equal(typeof payload.meta.count, "number");
  assert.equal(typeof payload.meta.generatedAt, "string");
});

test("topReplyCard mapping", async () => {
  const payload = await buildPriorityDeskView(
    { limit: 5, days: 7 },
    {
      getPriorityQueue: async () => [
        queueItem({
          leadId: "lead-1",
          score: 70,
          band: "high",
          heat: "hot",
          stage: "QUALIFIED",
          urgency: "medium",
          paymentIntent: true,
          dropoffRisk: "low",
          recommendedAction: "reduce_friction_to_payment",
          commercialPriority: "high",
          waiting: 20,
          needsReply: true
        })
      ],
      getLeadsMeta: async () => [{ id: "lead-1", clientName: "Sara" }],
      getLatestMessagesByLead: async () => new Map([["lead-1", { direction: "OUT", text: "Dernier message", createdAt: "2026-03-07T10:00:00.000Z" }]]),
      getAiCards: async () => aiCards({ leadId: "lead-1", topLabel: "Top Option" })
    }
  );

  assert.equal(payload.items[0].topReplyCard?.label, "Top Option");
  assert.equal(payload.items[0].topReplyCard?.messages.length, 2);
});

test("ranking order preserved", async () => {
  const payload = await buildPriorityDeskView(
    { limit: 3, days: 30 },
    {
      getPriorityQueue: async () => [
        queueItem({
          leadId: "lead-b",
          score: 90,
          band: "critical",
          heat: "hot",
          stage: "DEPOSIT_PENDING",
          urgency: "high",
          paymentIntent: true,
          dropoffRisk: "high",
          recommendedAction: "reduce_friction_to_payment",
          commercialPriority: "critical",
          waiting: 60,
          needsReply: true
        }),
        queueItem({
          leadId: "lead-a",
          score: 50,
          band: "medium",
          heat: "warm",
          stage: "PRODUCT_INTEREST",
          urgency: "low",
          paymentIntent: false,
          dropoffRisk: "low",
          recommendedAction: "qualify",
          commercialPriority: "medium",
          waiting: 5,
          needsReply: false
        })
      ],
      getLeadsMeta: async () => [
        { id: "lead-a", clientName: "A" },
        { id: "lead-b", clientName: "B" }
      ],
      getLatestMessagesByLead: async () =>
        new Map([
          ["lead-a", { direction: "OUT", text: "out", createdAt: "2026-03-07T10:05:00.000Z" }],
          ["lead-b", { direction: "IN", text: "in", createdAt: "2026-03-07T10:10:00.000Z" }]
        ]),
      getAiCards: async (leadId: string) => aiCards({ leadId })
    }
  );

  assert.equal(payload.items[0].leadId, "lead-b");
  assert.equal(payload.items[1].leadId, "lead-a");
});

test("null-safe handling when client name or last message missing", async () => {
  const payload = await buildPriorityDeskView(
    { limit: 2, days: 30 },
    {
      getPriorityQueue: async () => [
        queueItem({
          leadId: "lead-x",
          score: 40,
          band: "medium",
          heat: "warm",
          stage: "QUALIFIED",
          urgency: "medium",
          paymentIntent: false,
          dropoffRisk: "medium",
          recommendedAction: "clarify_deadline",
          commercialPriority: "high",
          waiting: 10,
          needsReply: false
        })
      ],
      getLeadsMeta: async () => [{ id: "lead-x", clientName: null }],
      getLatestMessagesByLead: async () => new Map([["lead-x", null]]),
      getAiCards: async () => ({ ...aiCards({ leadId: "lead-x", tone: "" }), replyCards: [] })
    }
  );

  assert.equal(payload.items[0].clientName, null);
  assert.equal(payload.items[0].lastMessagePreview, null);
  assert.equal(payload.items[0].lastMessageAt, null);
  assert.equal(payload.items[0].latestMessageDirection, null);
  assert.equal(payload.items[0].topReplyCard, null);
  assert.equal(payload.items[0].tone, null);
});

test("meta shape correctness", async () => {
  const payload = await buildPriorityDeskView(
    { limit: 11, days: 19 },
    {
      getPriorityQueue: async () => [],
      getLeadsMeta: async () => [],
      getLatestMessagesByLead: async () => new Map(),
      getAiCards: async () => aiCards({ leadId: "unused" })
    }
  );

  assert.equal(payload.meta.count, 0);
  assert.equal(payload.meta.limit, 11);
  assert.equal(payload.meta.days, 19);
  assert.ok(/T/.test(payload.meta.generatedAt));
});
