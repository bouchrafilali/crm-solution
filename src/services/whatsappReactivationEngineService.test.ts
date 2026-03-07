import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assessReactivationDeterministic, mapReactivationTiming } from "./whatsappReactivationEngineService.js";

const baseNow = new Date("2026-03-10T12:00:00.000Z").getTime();

test("price sent then silence => reactivation true", () => {
  const result = assessReactivationDeterministic(
    {
      leadId: "lead-1",
      stage: "PRICE_SENT",
      urgency: "low",
      paymentIntent: false,
      recommendedAction: "reactivate_gently",
      eventDate: null,
      latestDirection: "OUT",
      silenceHours: 72,
      needsReply: false
    },
    baseNow
  );

  assert.equal(result.shouldReactivate, true);
  assert.equal(result.stalledStage, "PRICE_SENT");
  assert.equal(result.recommendedAction, "reactivate_gently");
});

test("deposit pending then silence => high priority", () => {
  const result = assessReactivationDeterministic(
    {
      leadId: "lead-2",
      stage: "DEPOSIT_PENDING",
      urgency: "medium",
      paymentIntent: true,
      recommendedAction: "reduce_friction_to_payment",
      eventDate: null,
      latestDirection: "OUT",
      silenceHours: 36,
      needsReply: false
    },
    baseNow
  );

  assert.equal(result.shouldReactivate, true);
  assert.equal(result.reactivationPriority, "high");
});

test("active recent conversation => no reactivation", () => {
  const result = assessReactivationDeterministic(
    {
      leadId: "lead-3",
      stage: "QUALIFIED",
      urgency: "low",
      paymentIntent: false,
      recommendedAction: "answer_precisely",
      eventDate: null,
      latestDirection: "IN",
      silenceHours: 1,
      needsReply: true
    },
    baseNow
  );

  assert.equal(result.shouldReactivate, false);
  assert.equal(result.recommendedAction, "wait");
  assert.equal(result.timing, "monitor");
});

test("event date near increases urgency", () => {
  const result = assessReactivationDeterministic(
    {
      leadId: "lead-4",
      stage: "QUALIFIED",
      urgency: "medium",
      paymentIntent: false,
      recommendedAction: "reactivate_gently",
      eventDate: "2026-03-15",
      latestDirection: "OUT",
      silenceHours: 96,
      needsReply: false
    },
    baseNow
  );

  assert.equal(result.shouldReactivate, true);
  assert.equal(result.reactivationPriority, "high");
  assert.equal(result.tone, "calm_urgent");
});

test("timing mapping works", () => {
  assert.equal(mapReactivationTiming({ shouldReactivate: false, priority: "low", eventNear: false }), "monitor");
  assert.equal(mapReactivationTiming({ shouldReactivate: true, priority: "high", eventNear: false }), "now");
  assert.equal(mapReactivationTiming({ shouldReactivate: true, priority: "medium", eventNear: false }), "later_today");
  assert.equal(mapReactivationTiming({ shouldReactivate: true, priority: "low", eventNear: false }), "tomorrow");
  assert.equal(mapReactivationTiming({ shouldReactivate: true, priority: "low", eventNear: true }), "now");
});
