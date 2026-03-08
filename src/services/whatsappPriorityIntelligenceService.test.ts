import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildLeadPriorityIntelligence,
  computePriorityIntelligence,
  mapPriorityBandFromScore,
  PRIORITY_INTELLIGENCE_REASON_CODES_V1
} from "./whatsappPriorityIntelligenceService.js";

function baseDeps(overrides?: Record<string, unknown>) {
  const deps = {
    getLeadById: async () =>
      ({
        id: "lead-1",
        stage: "QUALIFIED",
        conversionScore: 55,
        paymentIntent: false,
        ticketValue: 600,
        hasProductInterest: false,
        hasPriceSent: false,
        priceIntent: false,
        videoIntent: false,
        depositIntent: false,
        detectedSignals: { tags: [] },
        eventDate: null,
        shipCountry: null,
        shipCity: null
      }) as any,
    getLeadState: async () =>
      ({
        stageAnalysis: {
          signals: [],
          objections: [],
          facts: {
            products_of_interest: [],
            event_date: null,
            delivery_deadline: null,
            destination_country: null,
            price_points_detected: [],
            customization_requests: []
          }
        },
        facts: null
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
    listLeads: async () => [],
    nowIso: () => "2026-03-07T10:00:00.000Z",
    nowMs: () => new Date("2026-03-07T10:00:00.000Z").getTime()
  } as any;
  return { ...deps, ...(overrides || {}) } as any;
}

test("high-intent active lead", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "11111111-1111-4111-8111-111111111111",
    baseDeps({
      getLeadById: async () =>
        ({
          id: "lead-a",
          stage: "DEPOSIT_PENDING",
          paymentIntent: true,
          depositIntent: true,
          ticketValue: 4200,
          hasProductInterest: true,
          hasPriceSent: true,
          priceIntent: true,
          videoIntent: false,
          detectedSignals: { tags: ["repeat_customer"] },
          eventDate: "2026-03-11",
          shipCountry: "FR",
          shipCity: "Paris"
        }) as any,
      getLeadState: async () =>
        ({
          stageAnalysis: {
            signals: [
              { type: "product_interest" },
              { type: "price_request" },
              { type: "payment_intent" },
              { type: "shipping_question" },
              { type: "deadline_risk" }
            ],
            objections: [],
            facts: {
              event_date: "2026-03-11",
              delivery_deadline: "2026-03-12",
              destination_country: "FR",
              price_points_detected: [1200],
              customization_requests: ["sleeve change"]
            }
          }
        }) as any,
      getAiCards: async () => ({ summary: { stage: "DEPOSIT_PENDING", paymentIntent: true, urgency: "high", dropoffRisk: "low" } }) as any,
      getPriorityScore: async () => ({ needsReply: true, waitingSinceMinutes: 22 }) as any,
      getReactivation: async () => ({ shouldReactivate: false, reactivationPriority: "low", stalledStage: null, silenceHours: 2 }) as any
    })
  );

  assert.equal(decision.recommendedAttention, "reply_now");
  assert.equal(decision.recommendedSurface, "mobile_lab");
  assert.ok(decision.conversionProbability > 0.65);
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.awaiting_reply));
  assert.equal(decision.primaryReasonCode, PRIORITY_INTELLIGENCE_REASON_CODES_V1.awaiting_reply);
});

test("stalled reactivation lead", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "22222222-2222-4222-8222-222222222222",
    baseDeps({
      getLeadById: async () =>
        ({
          id: "lead-b",
          stage: "PRICE_SENT",
          paymentIntent: false,
          depositIntent: false,
          ticketValue: 900,
          hasProductInterest: true,
          hasPriceSent: true,
          priceIntent: true,
          videoIntent: false,
          detectedSignals: { tags: [] },
          eventDate: null,
          shipCountry: null,
          shipCity: null
        }) as any,
      getAiCards: async () => ({ summary: { stage: "PRICE_SENT", paymentIntent: false, urgency: "medium", dropoffRisk: "high" } }) as any,
      getPriorityScore: async () => ({ needsReply: false, waitingSinceMinutes: 0 }) as any,
      getReactivation: async () =>
        ({
          shouldReactivate: true,
          reactivationPriority: "high",
          stalledStage: "PRICE_SENT",
          silenceHours: 72
        }) as any
    })
  );

  assert.equal(decision.recommendedAttention, "reactivate_now");
  assert.equal(decision.recommendedSurface, "reactivation_queue");
  assert.ok(decision.dropoffRisk > 0.55);
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.price_sent_then_silence));
});

test("low-urgency lead", async () => {
  const decision = await buildLeadPriorityIntelligence(
    "33333333-3333-4333-8333-333333333333",
    baseDeps({
      getLeadById: async () =>
        ({
          id: "lead-c",
          stage: "NEW",
          paymentIntent: false,
          depositIntent: false,
          ticketValue: 200,
          hasProductInterest: false,
          hasPriceSent: false,
          priceIntent: false,
          videoIntent: false,
          detectedSignals: { tags: [] },
          eventDate: null,
          shipCountry: null,
          shipCity: null
        }) as any,
      getAiCards: async () => ({ summary: { stage: "NEW", paymentIntent: false, urgency: "low", dropoffRisk: "low" } }) as any,
      getPriorityScore: async () => ({ needsReply: false, waitingSinceMinutes: 0 }) as any,
      getReactivation: async () => ({ shouldReactivate: false, reactivationPriority: "low", stalledStage: null, silenceHours: 0.5 }) as any
    })
  );

  assert.ok(decision.conversionProbability < 0.25);
  assert.ok(decision.dropoffRisk < 0.25);
  assert.equal(decision.recommendedAttention, "monitor");
});

test("priority band mapping", () => {
  assert.equal(mapPriorityBandFromScore(0), "low");
  assert.equal(mapPriorityBandFromScore(25), "low");
  assert.equal(mapPriorityBandFromScore(26), "medium");
  assert.equal(mapPriorityBandFromScore(50), "medium");
  assert.equal(mapPriorityBandFromScore(51), "high");
  assert.equal(mapPriorityBandFromScore(75), "high");
  assert.equal(mapPriorityBandFromScore(76), "critical");
  assert.equal(mapPriorityBandFromScore(100), "critical");
});

test("reasonCodes population", () => {
  const decision = computePriorityIntelligence({
    leadId: "lead-r",
    stage: "DEPOSIT_PENDING",
    awaitingReply: false,
    waitingMinutes: 0,
    silenceMinutes: 180,
    reactivationState: {
      shouldReactivate: true,
      reactivationPriority: "high",
      stalledStage: "DEPOSIT_PENDING"
    },
    signals: {
      product_interest_detected: true,
      price_request_detected: true,
      payment_intent_detected: true,
      deposit_intent_detected: true,
      shipping_question_detected: true,
      delivery_timing_detected: false,
      customization_request_detected: false,
      video_interest_detected: false,
      event_date_detected: true,
      event_date_near: true,
      high_ticket_context: true,
      repeat_customer_detected: true,
      price_objection_detected: false,
      timing_objection_detected: false,
      trust_friction_detected: false,
      fit_uncertainty_detected: false,
      fabric_uncertainty_detected: false,
      external_approval_delay_detected: false,
      recent_inbound_message: false
    }
  });

  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.product_interest_detected));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.price_request_detected));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.payment_intent_detected));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.shipping_question_detected));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.event_date_detected));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.event_date_near));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.deposit_pending_then_silence));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.high_ticket_context));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.repeat_customer_detected));
  assert.ok(decision.reasonCodes.includes(PRIORITY_INTELLIGENCE_REASON_CODES_V1.stage_deposit_pending));
});

test("primaryReasonCode selection", () => {
  const decision = computePriorityIntelligence({
    leadId: "lead-p",
    stage: "DEPOSIT_PENDING",
    awaitingReply: true,
    waitingMinutes: 30,
    silenceMinutes: 240,
    reactivationState: {
      shouldReactivate: true,
      reactivationPriority: "high",
      stalledStage: "DEPOSIT_PENDING"
    },
    signals: {
      product_interest_detected: true,
      price_request_detected: true,
      payment_intent_detected: true,
      deposit_intent_detected: true,
      shipping_question_detected: true,
      delivery_timing_detected: true,
      customization_request_detected: true,
      video_interest_detected: true,
      event_date_detected: true,
      event_date_near: true,
      high_ticket_context: true,
      repeat_customer_detected: true,
      price_objection_detected: false,
      timing_objection_detected: false,
      trust_friction_detected: false,
      fit_uncertainty_detected: false,
      fabric_uncertainty_detected: false,
      external_approval_delay_detected: false,
      recent_inbound_message: true
    }
  });

  assert.equal(decision.primaryReasonCode, PRIORITY_INTELLIGENCE_REASON_CODES_V1.awaiting_reply);
});
