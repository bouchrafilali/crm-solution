import test from "node:test";
import assert from "node:assert/strict";
import { extractLatestPrice, extractPrice } from "./priceExtraction.js";

test("extractPrice supports USD formats", () => {
  assert.deepEqual(extractLatestPrice("Price is $5,800")?.amount, 5800);
  assert.equal(extractLatestPrice("5800$")?.currency, "USD");
  assert.equal(extractLatestPrice("5,800 $")?.formatted, "$5,800");
});

test("extractPrice supports EUR formats", () => {
  assert.equal(extractLatestPrice("5.800 €")?.amount, 5800);
  assert.equal(extractLatestPrice("5800€")?.currency, "EUR");
  assert.match(String(extractLatestPrice("5 800 €")?.formatted || ""), /€$/);
});

test("extractPrice supports MAD and k notation", () => {
  assert.equal(extractLatestPrice("25 000 dhs")?.amount, 25000);
  assert.equal(extractLatestPrice("25k dhs")?.amount, 25000);
  assert.equal(extractLatestPrice("MAD 25,000")?.currency, "MAD");
  assert.equal(extractLatestPrice("25.000 MAD")?.amount, 25000);
});

test("extractPrice returns multiple matches", () => {
  const out = extractPrice("Option A: 2 800€ or Option B: $5,800");
  assert.equal(out.length, 2);
  assert.equal(out[0]?.currency, "EUR");
  assert.equal(out[1]?.currency, "USD");
});
