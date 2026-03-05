import test from "node:test";
import assert from "node:assert/strict";
import { computeTimingPressure } from "./timingPressure.js";

const NOW = new Date("2026-02-27T12:00:00Z").getTime();

test("1) last inbound -> WAITING_FOR_US can be CRITICAL", () => {
  const out = computeTimingPressure({
    stage: "DEPOSIT_PENDING",
    messages: [
      { direction: "out", ts: "2026-02-27T09:00:00Z" },
      { direction: "in", ts: "2026-02-27T10:00:00Z" }
    ],
    local_phase: "BUSINESS",
    nowMs: NOW
  });

  assert.equal(out.waiting_for, "WAITING_FOR_US");
  assert.equal(out.reference, "last_inbound");
  assert.equal(out.since_inbound_minutes, 120);
  assert.equal(out.urgency, "CRITICAL");
});

test("2) last outbound QUALIFICATION_PENDING silence 600m -> capped MEDIUM + waiting label", () => {
  const out = computeTimingPressure({
    stage: "QUALIFICATION_PENDING",
    messages: [
      { direction: "in", ts: "2026-02-27T01:30:00Z" },
      { direction: "out", ts: "2026-02-27T02:00:00Z" }
    ],
    local_phase: "BUSINESS",
    nowMs: NOW
  });

  assert.equal(out.waiting_for, "WAITING_FOR_CLIENT");
  assert.equal(out.reference, "last_outbound");
  assert.equal(out.since_outbound_minutes, 600);
  assert.equal(out.urgency, "MEDIUM");
  assert.match(out.label, /En attente client/);
});

test("3) last outbound DEPOSIT_PENDING silence 120m -> CRITICAL remains allowed", () => {
  const out = computeTimingPressure({
    stage: "DEPOSIT_PENDING",
    messages: [
      { direction: "in", ts: "2026-02-27T09:30:00Z" },
      { direction: "out", ts: "2026-02-27T10:00:00Z" }
    ],
    local_phase: "BUSINESS",
    nowMs: NOW
  });

  assert.equal(out.waiting_for, "WAITING_FOR_CLIENT");
  assert.equal(out.since_outbound_minutes, 120);
  assert.equal(out.urgency, "CRITICAL");
});

