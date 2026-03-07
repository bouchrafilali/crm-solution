import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildLeadPriorityIntelligence,
  type PriorityIntelligenceDecision
} from "./whatsappPriorityIntelligenceService.js";

function baseDeps(overrides?: Partial<Parameters<typeof buildLeadPriorityIntelligence>[1] extends never ? never : Record<string, unknown>>) {
  const deps = {
    getLeadById: async () =>
      ({
        id: "lead-1",
        stage: "QUALIFIED",
        conversionScore: 55,
        paymentIntent: false
      }) as any,
    getAiCards: async () =>
      ({
        summary: {
          stage: "QUALIFIED",
          urgency: "medium",
          paymentIntent: false,
          dropoffRisk: "medium"
        }
      }) as any,
    getPriorityScore: async () =>
      ({
        leadId: "lead-1",
        priorityScore: 50,
        priorityBand: "medium",
        needsReply: true,
        waitingSinceMinutes: 20,
        stage: "QUALIFIED",
        urgency: "medium",
        paymentIntent: false,
        dropoffRisk: "medium",
        recommendedAction: "answer_precisely",
        commercialPriority: "medium",
        estimatedHeat: "warm",
        reasons: []
      }) as any,
    getReactivation: async () =>
      ({
        leadId: "lead-1",
        shouldReactivate: false,
        reactivationPriority: "low",
        reactivationReason: "active",
        stalledStage: null,
        silenceHours: 4,
        signals: [],
        recommendedAction: "wait",
        tone: null,
        timing: "monitor"
      }) as any,
    getLeadOutcome: async () => null,
    getLeadMessages: async () => [],
    listOperatorEventsByRange: async () => [],
    listLeads: async () => [],
    nowIso: () => "2026-03-07T10:00:00.000Z",
    nowMs: () => new Date("2026-03-07T10:00:00.000Z").getTime()
  } as any;
  return { ...deps, ...(overrides || {}) } as any;
}

test("high-intent active lead => reply_now on mobile_lab", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "11111111-1111-4111-8111-111111111111",
    baseDeps({
      getLeadById: async () => ({ id: "lead-a", stage: "DEPOSIT_PENDING", conversionScore: 82, paymentIntent: true }) as any,
      getAiCards: async () =>
        ({
          summary: {
            stage: "DEPOSIT_PENDING",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "medium"
          }
        }) as any,
      getPriorityScore: async () =>
        ({
          leadId: "lead-a",
          priorityScore: 78,
          priorityBand: "high",
          needsReply: true,
          waitingSinceMinutes: 35,
          stage: "DEPOSIT_PENDING",
          urgency: "high",
          paymentIntent: true,
          dropoffRisk: "medium",
          recommendedAction: "push_softly_to_deposit",
          commercialPriority: "high",
          estimatedHeat: "hot",
          reasons: []
        }) as any
    })
  );

  assert.equal(decision.recommendedAttention, "reply_now");
  assert.equal(decision.recommendedSurface, "mobile_lab");
  assert.ok(decision.priorityScore >= 70);
});

test("stalled reactivation lead => reactivate_now on reactivation_queue", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "22222222-2222-4222-8222-222222222222",
    baseDeps({
      getLeadById: async () => ({ id: "lead-b", stage: "PRICE_SENT", conversionScore: 48, paymentIntent: false }) as any,
      getAiCards: async () =>
        ({
          summary: {
            stage: "PRICE_SENT",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "high"
          }
        }) as any,
      getPriorityScore: async () =>
        ({
          leadId: "lead-b",
          priorityScore: 62,
          priorityBand: "high",
          needsReply: false,
          waitingSinceMinutes: 0,
          stage: "PRICE_SENT",
          urgency: "medium",
          paymentIntent: false,
          dropoffRisk: "high",
          recommendedAction: "reactivate_gently",
          commercialPriority: "medium",
          estimatedHeat: "warm",
          reasons: []
        }) as any,
      getReactivation: async () =>
        ({
          leadId: "lead-b",
          shouldReactivate: true,
          reactivationPriority: "high",
          reactivationReason: "stalled after outbound",
          stalledStage: "PRICE_SENT",
          silenceHours: 72,
          signals: ["stalled_after_outbound"],
          recommendedAction: "reactivate_gently",
          tone: "reassuring",
          timing: "now"
        }) as any
    })
  );

  assert.equal(decision.recommendedAttention, "reactivate_now");
  assert.equal(decision.recommendedSurface, "reactivation_queue");
  assert.ok(decision.dropoffRisk >= 70);
});

test("low-value low-urgency lead => wait on priority_desk", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "33333333-3333-4333-8333-333333333333",
    baseDeps({
      getLeadById: async () => ({ id: "lead-c", stage: "QUALIFIED", conversionScore: 18, paymentIntent: false }) as any,
      getAiCards: async () =>
        ({
          summary: {
            stage: "QUALIFIED",
            urgency: "low",
            paymentIntent: false,
            dropoffRisk: "low"
          }
        }) as any,
      getPriorityScore: async () =>
        ({
          leadId: "lead-c",
          priorityScore: 22,
          priorityBand: "low",
          needsReply: false,
          waitingSinceMinutes: 0,
          stage: "QUALIFIED",
          urgency: "low",
          paymentIntent: false,
          dropoffRisk: "low",
          recommendedAction: "wait",
          commercialPriority: "low",
          estimatedHeat: "cold",
          reasons: []
        }) as any,
      getReactivation: async () =>
        ({
          leadId: "lead-c",
          shouldReactivate: false,
          reactivationPriority: "low",
          reactivationReason: "not stale",
          stalledStage: null,
          silenceHours: 6,
          signals: [],
          recommendedAction: "wait",
          tone: null,
          timing: "monitor"
        }) as any
    })
  );

  assert.equal(decision.recommendedAttention, "wait");
  assert.equal(decision.recommendedSurface, "priority_desk");
  assert.ok(decision.priorityScore < 40);
});

test("recommendedSurface mapping for close_out", async () => {
  const decision: PriorityIntelligenceDecision = await buildLeadPriorityIntelligence(
    "44444444-4444-4444-8444-444444444444",
    baseDeps({
      getLeadOutcome: async () =>
        ({
          leadId: "lead-d",
          outcome: "converted"
        }) as any
    })
  );
  assert.equal(decision.recommendedAttention, "close_out");
  assert.equal(decision.recommendedSurface, "priority_desk");
});

test("reasonCodes are populated for key signals", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "lead-e",
    baseDeps({
      getLeadById: async () => ({ id: "lead-e", stage: "PRICE_SENT", conversionScore: 52, paymentIntent: true }) as any,
      getAiCards: async () =>
        ({
          summary: {
            stage: "PRICE_SENT",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "high"
          }
        }) as any,
      getPriorityScore: async () =>
        ({
          leadId: "lead-e",
          priorityScore: 70,
          priorityBand: "high",
          needsReply: true,
          waitingSinceMinutes: 90,
          stage: "PRICE_SENT",
          urgency: "high",
          paymentIntent: true,
          dropoffRisk: "high",
          recommendedAction: "push_softly_to_deposit",
          commercialPriority: "high",
          estimatedHeat: "hot",
          reasons: []
        }) as any,
      getReactivation: async () =>
        ({
          leadId: "lead-e",
          shouldReactivate: true,
          reactivationPriority: "high",
          reactivationReason: "stalled",
          stalledStage: "PRICE_SENT",
          silenceHours: 56,
          signals: ["stalled_after_outbound"],
          recommendedAction: "reactivate_gently",
          tone: "reassuring",
          timing: "now"
        }) as any,
      listOperatorEventsByRange: async () =>
        [
          { leadId: "lead-e", actionType: "reply_card_dismissed" },
          { leadId: "lead-e", actionType: "reply_card_dismissed" },
          { leadId: "lead-e", actionType: "feed_item_skipped" }
        ] as any
    })
  );

  assert.ok(decision.reasonCodes.includes("PAYMENT_INTENT"));
  assert.ok(decision.reasonCodes.includes("HIGH_URGENCY"));
  assert.ok(decision.reasonCodes.includes("WAITING_OVER_60_MIN"));
  assert.ok(decision.reasonCodes.includes("OPERATOR_DISMISSALS"));
});
