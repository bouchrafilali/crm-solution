import test from "node:test";
import assert from "node:assert/strict";
import { computeRiskScore, type RiskFacts, type RiskMessage } from "./riskScore.js";

const FIXED_NOW = new Date("2026-02-27T12:00:00Z").getTime();

function runRisk(facts: RiskFacts, messages: RiskMessage[]) {
  return computeRiskScore({
    facts,
    messages,
    nowMs: FIXED_NOW
  });
}

test("1) PRICE_SENT + 60h no reply => HIGH + SEND_DEPOSIT_LINK", () => {
  const out = runRisk(
    {
      stage: "PRICE_SENT",
      event_date: "2026-04-20",
      destination: "Paris, FR",
      hours_since_last_activity: 60
    },
    [{ direction: "out", text: "Le prix est 4500 EUR", ts: "2026-02-24T00:00:00Z" }]
  );

  assert.equal(out.risk_level, "HIGH");
  assert.equal(out.at_risk, true);
  assert.equal(out.recommended_action, "SEND_DEPOSIT_LINK");
});

test("2) QUALIFICATION_PENDING + price_intent + missing fields => MEDIUM/HIGH + ASK_QUALIFICATION", () => {
  const out = runRisk(
    {
      stage: "QUALIFICATION_PENDING",
      event_date: null,
      destination: "",
      intents: { price_intent: true },
      hours_since_last_activity: 30
    },
    [{ direction: "in", text: "How much is this?", ts: "2026-02-26T06:00:00Z" }]
  );

  assert.ok(out.risk_level === "MEDIUM" || out.risk_level === "HIGH");
  assert.equal(out.at_risk, true);
  assert.equal(out.recommended_action, "ASK_QUALIFICATION");
});

test("3) last message inbound + inactivity => HIGH + immediate action", () => {
  const out = runRisk(
    {
      stage: "DEPOSIT_PENDING",
      event_date: "2026-03-22",
      destination: "Lyon, FR",
      hours_since_last_activity: 72
    },
    [{ direction: "in", text: "Can you send the payment details now?", ts: "2026-02-24T12:00:00Z" }]
  );

  assert.equal(out.risk_level, "HIGH");
  assert.equal(out.at_risk, true);
  assert.notEqual(out.recommended_action, "NONE");
  assert.equal(out.recommended_action, "SEND_DEPOSIT_LINK");
});

test("4) event in 7 days not confirmed => HIGH", () => {
  const out = runRisk(
    {
      stage: "PRICE_SENT",
      event_date: "2026-03-06",
      destination: "Marseille, FR",
      hours_since_last_activity: 52
    },
    [{ direction: "out", text: "Price shared yesterday", ts: "2026-02-26T12:00:00Z" }]
  );

  assert.equal(out.risk_level, "HIGH");
  assert.equal(out.at_risk, true);
});

test("5) CONVERTED => LOW, not at risk", () => {
  const out = runRisk(
    {
      stage: "CONVERTED",
      event_date: "2026-06-30",
      destination: "Nice, FR",
      hours_since_last_activity: 200
    },
    [{ direction: "out", text: "Order confirmed", ts: "2026-02-20T12:00:00Z" }]
  );

  assert.equal(out.risk_level, "LOW");
  assert.equal(out.at_risk, false);
  assert.equal(out.recommended_action, "NONE");
});
