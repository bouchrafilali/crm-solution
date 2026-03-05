import test from "node:test";
import assert from "node:assert/strict";
import { extractDestinationFromMessages } from "./destinationExtractor.js";

test("extracts city from French date,city short reply (A1)", () => {
  const result = extractDestinationFromMessages(
    [
      { id: "out1", direction: "OUT", text: "Pouvez-vous confirmer date + ville/pays ?", createdAt: "2026-02-25T10:00:00Z" },
      { id: "in1", direction: "IN", text: "9 juin, Paris", createdAt: "2026-02-25T10:01:00Z" }
    ],
    { country: "FR" },
    new Date("2026-02-25T10:02:00Z")
  );

  assert.equal(result.ship_city, "Paris");
  assert.equal(result.ship_country, "FR");
  assert.equal(result.sourceMessageId, "in1");
  assert.equal(result.confidence, 90);
});

test("extracts short city-only answer after destination question (A2)", () => {
  const result = extractDestinationFromMessages(
    [
      { id: "out1", direction: "OUT", text: "Ville/pays de livraison ?", createdAt: "2026-02-25T10:00:00Z" },
      { id: "in1", direction: "IN", text: "Paris", createdAt: "2026-02-25T10:00:20Z" }
    ],
    { country: "FR" },
    new Date("2026-02-25T10:01:00Z")
  );

  assert.equal(result.ship_city, "Paris");
  assert.equal(result.ship_country, "FR");
  assert.equal(result.confidence, 85);
});

test("extracts country-only reply (A3)", () => {
  const result = extractDestinationFromMessages(
    [{ id: "in1", direction: "IN", text: "France", createdAt: "2026-02-25T10:00:00Z" }],
    null,
    new Date("2026-02-25T10:00:10Z")
  );

  assert.equal(result.ship_country, "FR");
  assert.equal(result.confidence, 70);
});

test("does not treat month-only short answer as city", () => {
  const result = extractDestinationFromMessages(
    [
      { id: "out1", direction: "OUT", text: "Destination ?", createdAt: "2026-02-25T10:00:00Z" },
      { id: "in1", direction: "IN", text: "juin", createdAt: "2026-02-25T10:00:20Z" }
    ],
    { country: "FR" },
    new Date("2026-02-25T10:01:00Z")
  );

  assert.equal(result.ship_city, null);
  assert.equal(result.ship_country, null);
  assert.equal(result.confidence, 0);
});

test("extracts city when inbound contains weekday date + city (lundi prochaine, Barcelone)", () => {
  const result = extractDestinationFromMessages(
    [
      { id: "out1", direction: "OUT", text: "Date + ville/pays ?", createdAt: "2026-02-25T10:00:00Z" },
      { id: "in1", direction: "IN", text: "Lundi prochaine, Barcelone", createdAt: "2026-02-25T10:01:00Z" }
    ],
    { country: "FR" },
    new Date("2026-02-25T10:02:00Z")
  );

  assert.equal(result.ship_city, "Barcelone");
  assert.equal(result.ship_country, "FR");
  assert.equal(result.sourceMessageId, "in1");
  assert.equal(result.confidence, 90);
});

test("extracts city when inbound contains relative date + city (dans 30 jours, casablanca)", () => {
  const result = extractDestinationFromMessages(
    [
      { id: "out1", direction: "OUT", text: "Date + ville/pays ?", createdAt: "2026-02-25T10:00:00Z" },
      { id: "in1", direction: "IN", text: "dans 30 jours, casablanca", createdAt: "2026-02-25T10:01:00Z" }
    ],
    { country: "MA" },
    new Date("2026-02-25T10:02:00Z")
  );

  assert.equal(result.ship_city, "Casablanca");
  assert.equal(result.ship_country, "MA");
  assert.equal(result.sourceMessageId, "in1");
  assert.equal(result.confidence, 90);
});

test("city-country fallback overrides lead country when city implies another country", () => {
  const result = extractDestinationFromMessages(
    [
      { id: "out1", direction: "OUT", text: "Date + ville/pays ?", createdAt: "2026-02-25T10:00:00Z" },
      { id: "in1", direction: "IN", text: "Lundi prochain, Paris", createdAt: "2026-02-25T10:01:00Z" }
    ],
    { country: "MA" },
    new Date("2026-02-25T10:02:00Z")
  );

  assert.equal(result.ship_city, "Paris");
  assert.equal(result.ship_country, "FR");
});

test("does not extract fake destination from 'this article' phrasing", () => {
  const result = extractDestinationFromMessages(
    [
      {
        id: "in1",
        direction: "IN",
        text: "Hi, I am interested in this article: Luxury Moroccan Kaftan. Here is the link.",
        createdAt: "2026-02-26T18:42:00Z"
      }
    ],
    { country: "US" },
    new Date("2026-02-26T18:43:00Z")
  );

  assert.equal(result.ship_city, null);
  assert.equal(result.ship_country, null);
  assert.equal(result.confidence, 0);
});
