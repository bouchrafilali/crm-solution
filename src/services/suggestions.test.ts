import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestions } from "./suggestions.js";

test("case 1: how much + missing fields => qualification_pending ask date/destination", () => {
  const out = buildSuggestions({
    facts: {
      stage: "NEW",
      lang: "EN",
      event_date: null,
      destination: null,
      intents: {}
    },
    messages: [
      { direction: "in", text: "How much is this?", ts: "2026-02-27T10:00:00Z" }
    ]
  });

  assert.ok(out.length >= 1);
  assert.match(out[0].text.toLowerCase(), /event date/);
  assert.doesNotMatch(out[0].text.toLowerCase(), /destination/);
});

test("case 2: date+destination present => qualified suggestion is price contextualized", () => {
  const out = buildSuggestions({
    facts: {
      stage: "QUALIFIED",
      lang: "EN",
      event_date: "2026-06-09",
      destination: "Paris, FR",
      intents: {}
    },
    messages: [
      { direction: "in", text: "Great, thanks", ts: "2026-02-27T10:00:00Z" }
    ]
  });

  assert.ok(out.length >= 1);
  assert.equal(out[0].id, "qualified_price_context");
  assert.match(out[0].text.toLowerCase(), /price/);
});

test("case 3: PRICE_SENT + how can I pay => deposit_pending suggestion with deposit link", () => {
  const out = buildSuggestions({
    facts: {
      stage: "PRICE_SENT",
      lang: "EN",
      event_date: "2026-06-09",
      destination: "Paris, FR",
      intents: {}
    },
    messages: [
      { direction: "out", text: "The price is 4000 USD.", ts: "2026-02-27T09:58:00Z" },
      { direction: "in", text: "How can I pay?", ts: "2026-02-27T10:00:00Z" }
    ]
  });

  assert.ok(out.length >= 1);
  assert.equal(out[0].id, "deposit_pending_send_link");
  assert.match(out[0].text.toLowerCase(), /deposit link/);
});

test("case 4: no date at all => qualification pending suggestion asks for date", () => {
  const out = buildSuggestions({
    facts: {
      stage: "NEW",
      lang: "EN",
      event_date: null,
      event_date_precision: "UNKNOWN",
      destination: "Ohio, US",
      intents: {}
    },
    messages: [{ direction: "in", text: "I am interested", ts: "2026-02-27T10:00:00Z" }]
  });

  assert.ok(out.length >= 1);
  assert.equal(out[0].id, "qual_missing_fields");
  assert.match(out[0].text.toLowerCase(), /event date/);
});

test("case 5: month precision + destination + PRICE_SENT => prioritize deposit/slot suggestion", () => {
  const out = buildSuggestions({
    facts: {
      stage: "PRICE_SENT",
      lang: "EN",
      event_date: null,
      event_date_text: "April",
      event_date_precision: "MONTH",
      event_month: 4,
      destination: "Ohio, US",
      intents: { price_intent: true }
    },
    messages: [
      { direction: "out", text: "The price is 4500 USD with production timeline.", ts: "2026-02-27T09:58:00Z" },
      { direction: "in", text: "How much is this?", ts: "2026-02-27T10:00:00Z" }
    ]
  });

  assert.ok(out.length >= 1);
  assert.equal(out[0].id, "price_sent_next_payment");
  assert.notEqual(out[0].id, "qual_missing_fields");
});
