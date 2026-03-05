import test from "node:test";
import assert from "node:assert/strict";
import { inferTicketValueFromConversation } from "./ticketValueInference.js";

test("quoted amount uses last mention and multiplier when explicit", () => {
  const out = inferTicketValueFromConversation({
    messages: [
      { id: "m1", text: "Le prix est 5,800 EUR", createdAt: "2026-03-01T10:00:00Z" },
      { id: "m2", direction: "OUT", text: "For 4 dresses: 2 000 usd each", createdAt: "2026-03-01T10:05:00Z" }
    ]
  });

  assert.equal(out.strategy, "quoted_amount");
  assert.equal(out.multiplier, 4);
  assert.equal(out.inferredValue, 8000);
  assert.equal(out.currency, "USD");
  assert.equal(out.formatted, "$8,000");
  assert.equal(out.messageId, "m2");
});

test("quoted amount supports suffix currency like 5800€", () => {
  const out = inferTicketValueFromConversation({
    messages: [{ id: "m1", text: "Le prix final est 5800€", createdAt: "2026-03-01T10:00:00Z" }]
  });

  assert.equal(out.strategy, "quoted_amount");
  assert.equal(out.inferredValue, 5800);
  assert.equal(out.currency, "EUR");
  assert.equal(out.formatted, "5 800€");
});

test("fallback value is used when no quoted amount", () => {
  const out = inferTicketValueFromConversation({
    productReference: "Luxury kaftan collection",
    messages: [{ id: "m1", text: "I like this design", createdAt: "2026-03-01T10:00:00Z" }]
  });

  assert.equal(out.strategy, "fallback_product_interest");
  assert.equal(out.inferredValue, 2800);
  assert.equal(out.currency, "EUR");
});

test("most recent outbound price is preferred over inbound", () => {
  const out = inferTicketValueFromConversation({
    messages: [
      { id: "m1", direction: "IN", text: "I saw 25k dhs", createdAt: "2026-03-01T10:09:00Z" },
      { id: "m2", direction: "OUT", text: "We can do $5,800", createdAt: "2026-03-01T10:10:00Z" }
    ]
  });

  assert.equal(out.strategy, "quoted_amount");
  assert.equal(out.inferredValue, 5800);
  assert.equal(out.currency, "USD");
  assert.equal(out.messageId, "m2");
});
