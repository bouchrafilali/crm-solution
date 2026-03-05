import test from "node:test";
import assert from "node:assert/strict";
import { extractEventDateFromMessages } from "./eventDateExtractor.js";

test("extracts relative French date 'dans 30 jours'", () => {
  const now = new Date("2026-02-26T00:00:00Z");
  const result = extractEventDateFromMessages(
    [{ id: "in1", text: "dans 30 jours, casablanca", createdAt: "2026-02-26T03:07:00Z" }],
    now,
    "UTC"
  );

  assert.equal(result.date, "2026-03-28");
  assert.equal(result.raw, "dans 30 jours");
  assert.equal(result.sourceMessageId, "in1");
});
