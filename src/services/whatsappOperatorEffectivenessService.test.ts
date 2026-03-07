import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildWhatsAppOperatorEffectiveness,
  validateEffectivenessRange,
  WhatsAppOperatorEffectivenessError
} from "./whatsappOperatorEffectivenessService.js";
import type { WhatsAppOperatorEventRow } from "../db/whatsappOperatorEventsRepo.js";
import type { WhatsAppLeadOutcomeRecord } from "../db/whatsappLeadOutcomesRepo.js";

const eventsFixture: WhatsAppOperatorEventRow[] = [
  {
    id: "e1",
    leadId: "11111111-1111-1111-1111-111111111111",
    surface: "chat",
    feedType: "active",
    actionType: "reply_card_inserted",
    stage: null,
    recommendedAction: null,
    cardLabel: "Option 1",
    cardIntent: "clear next step",
    mode: "active_first",
    metadata: null,
    createdAt: "2026-03-07T10:00:00.000Z"
  },
  {
    id: "e2",
    leadId: "11111111-1111-1111-1111-111111111111",
    surface: "chat",
    feedType: "active",
    actionType: "reply_card_sent",
    stage: null,
    recommendedAction: null,
    cardLabel: "Option 1",
    cardIntent: "clear next step",
    mode: "active_first",
    metadata: null,
    createdAt: "2026-03-07T10:30:00.000Z"
  },
  {
    id: "e3",
    leadId: "22222222-2222-2222-2222-222222222222",
    surface: "reactivation_queue",
    feedType: "reactivation",
    actionType: "reactivation_card_sent",
    stage: "PRICE_SENT",
    recommendedAction: "reactivate_gently",
    cardLabel: "Option 3",
    cardIntent: "gentle restart",
    mode: null,
    metadata: null,
    createdAt: "2026-03-08T10:00:00.000Z"
  }
];

const outcomesFixture: WhatsAppLeadOutcomeRecord[] = [
  {
    leadId: "11111111-1111-1111-1111-111111111111",
    outcome: "converted",
    finalStage: "CONVERTED",
    outcomeAt: "2026-03-07T11:00:00.000Z",
    orderValue: 4800,
    currency: "EUR",
    source: "manual",
    notes: null,
    createdAt: "2026-03-07T11:00:00.000Z",
    updatedAt: "2026-03-07T11:00:00.000Z"
  },
  {
    leadId: "22222222-2222-2222-2222-222222222222",
    outcome: "stalled",
    finalStage: "PRICE_SENT",
    outcomeAt: "2026-03-08T12:00:00.000Z",
    orderValue: null,
    currency: null,
    source: null,
    notes: null,
    createdAt: "2026-03-08T12:00:00.000Z",
    updatedAt: "2026-03-08T12:00:00.000Z"
  },
  {
    leadId: "33333333-3333-3333-3333-333333333333",
    outcome: "lost",
    finalStage: "LOST",
    outcomeAt: "2026-03-08T14:00:00.000Z",
    orderValue: null,
    currency: null,
    source: null,
    notes: null,
    createdAt: "2026-03-08T14:00:00.000Z",
    updatedAt: "2026-03-08T14:00:00.000Z"
  }
];

test("aggregation correctness", async () => {
  const payload = await buildWhatsAppOperatorEffectiveness(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" },
    {
      listEvents: async () => eventsFixture,
      listOutcomes: async () => outcomesFixture,
      nowIso: () => "2026-03-09T00:00:00.000Z"
    }
  );

  assert.equal(payload.conversionMetrics.totalLeads, 3);
  assert.equal(payload.conversionMetrics.converted, 1);
  assert.equal(payload.conversionMetrics.lost, 1);
  assert.equal(payload.conversionMetrics.stalled, 1);
  assert.equal(payload.reactivationPerformance.reactivationAttempts, 1);
  assert.equal(payload.stageConversion.CONVERTED, 1);
  assert.equal(payload.stageConversion.PRICE_SENT, 1);
});

test("empty dataset", async () => {
  const payload = await buildWhatsAppOperatorEffectiveness(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-08T00:00:00.000Z" },
    {
      listEvents: async () => [],
      listOutcomes: async () => [],
      nowIso: () => "2026-03-08T00:00:00.000Z"
    }
  );

  assert.equal(payload.conversionMetrics.totalLeads, 0);
  assert.equal(payload.conversionMetrics.conversionRate, 0);
  assert.equal(payload.cardPerformance.length, 0);
  assert.equal(payload.reactivationPerformance.recoveryRate, 0);
});

test("conversion rate computation", async () => {
  const payload = await buildWhatsAppOperatorEffectiveness(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" },
    {
      listEvents: async () => [],
      listOutcomes: async () => outcomesFixture,
      nowIso: () => "2026-03-09T00:00:00.000Z"
    }
  );
  assert.equal(payload.conversionMetrics.conversionRate, 33.33);
});

test("cardPerformance grouping", async () => {
  const payload = await buildWhatsAppOperatorEffectiveness(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" },
    {
      listEvents: async () => eventsFixture,
      listOutcomes: async () => outcomesFixture,
      nowIso: () => "2026-03-09T00:00:00.000Z"
    }
  );

  const clearNextStep = payload.cardPerformance.find((item) => item.cardIntent === "clear next step");
  assert.ok(clearNextStep);
  assert.equal(clearNextStep?.inserted, 1);
  assert.equal(clearNextStep?.sent, 1);
  assert.equal(clearNextStep?.conversionsAfterSend, 1);
});

test("invalid date query rejected", () => {
  assert.throws(
    () => validateEffectivenessRange({ from: "bad-date", to: "2026-03-07T00:00:00.000Z" }),
    (error: unknown) => error instanceof WhatsAppOperatorEffectivenessError && error.code === "effectiveness_invalid_date"
  );
});
