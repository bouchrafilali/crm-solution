import test from "node:test";
import assert from "node:assert/strict";
import { runWhatsAppLabSimulation } from "./whatsappLabSimulation.js";

test("simulate: PRICE_SENT + chat confirmed moves to CONFIRMED with explicit rule log", () => {
  const out = runWhatsAppLabSimulation({
    mode: "basic",
    language: "FR",
    messages: [
      { direction: "IN", text: "9 juin, Paris", created_at: "2026-02-26T10:00:00Z" },
      { direction: "OUT", text: "Le prix est de 40 000 DHS.", created_at: "2026-02-26T10:01:00Z" },
      { direction: "IN", text: "C’est confirmé.", created_at: "2026-02-26T10:02:00Z" }
    ]
  });

  assert.equal(out.stage.main, "CONFIRMED");
  assert.match(String(out.stage.reasoning || ""), /Applied rule: PRICE_SENT->CONFIRMED \(chat_confirmed\)/);
});

test("simulate: PRICE_SENT + payment question moves to DEPOSIT_PENDING with explicit rule log", () => {
  const out = runWhatsAppLabSimulation({
    mode: "basic",
    language: "FR",
    messages: [
      { direction: "IN", text: "9 juin, Paris", created_at: "2026-02-26T10:00:00Z" },
      { direction: "OUT", text: "Le prix est de 40 000 DHS.", created_at: "2026-02-26T10:01:00Z" },
      { direction: "IN", text: "Comment je peux payer ?", created_at: "2026-02-26T10:02:00Z" }
    ]
  });

  assert.equal(out.stage.main, "DEPOSIT_PENDING");
  assert.match(String(out.stage.reasoning || ""), /Applied rule: PRICE_SENT->DEPOSIT_PENDING \(payment_question\)/);
});

