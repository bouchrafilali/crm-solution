import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildWhatsAppOperatorEventsSummary,
  validateOperatorSummaryRange,
  WhatsAppOperatorAnalyticsError
} from "./whatsappOperatorAnalyticsService.js";
import type { WhatsAppOperatorEventRow } from "../db/whatsappOperatorEventsRepo.js";

const eventsFixture: WhatsAppOperatorEventRow[] = [
  {
    id: "e1",
    leadId: "11111111-1111-1111-1111-111111111111",
    surface: "mobile_lab",
    feedType: "active",
    actionType: "reply_card_inserted",
    stage: "DEPOSIT_PENDING",
    recommendedAction: "push_softly_to_deposit",
    cardLabel: "Option 1",
    cardIntent: "clear next step",
    mode: "active_first",
    metadata: { a: 1 },
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
    createdAt: "2026-03-07T11:00:00.000Z"
  },
  {
    id: "e3",
    leadId: "22222222-2222-2222-2222-222222222222",
    surface: "reactivation_queue",
    feedType: "reactivation",
    actionType: "reactivation_card_inserted",
    stage: "PRICE_SENT",
    recommendedAction: "reactivate_gently",
    cardLabel: "Option 3",
    cardIntent: null,
    mode: null,
    metadata: null,
    createdAt: "2026-03-08T11:00:00.000Z"
  },
  {
    id: "e4",
    leadId: "33333333-3333-3333-3333-333333333333",
    surface: "priority_desk",
    feedType: null,
    actionType: "feed_item_opened",
    stage: null,
    recommendedAction: null,
    cardLabel: null,
    cardIntent: null,
    mode: "balanced",
    metadata: null,
    createdAt: "2026-03-09T11:00:00.000Z"
  }
];

test("summary aggregation works", async () => {
  const payload = await buildWhatsAppOperatorEventsSummary(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-10T00:00:00.000Z" },
    {
      listEvents: async () => eventsFixture,
      nowIso: () => "2026-03-10T00:00:00.000Z"
    }
  );

  assert.equal(payload.summary.totalEvents, 4);
  assert.equal(payload.summary.bySurface.mobile_lab, 1);
  assert.equal(payload.summary.bySurface.reactivation_queue, 1);
  assert.equal(payload.summary.bySurface.chat, 1);
  assert.equal(payload.summary.bySurface.priority_desk, 1);
  assert.equal(payload.summary.byFeedType.active, 2);
  assert.equal(payload.summary.byFeedType.reactivation, 1);
  assert.equal(payload.summary.byActionType.reply_card_inserted, 1);
});

test("date filtering works", async () => {
  const payload = await buildWhatsAppOperatorEventsSummary(
    { from: "2026-03-08T00:00:00.000Z", to: "2026-03-08T23:59:59.000Z" },
    {
      listEvents: async ({ from, to }) => {
        const fromMs = new Date(from).getTime();
        const toMs = new Date(to).getTime();
        return eventsFixture.filter((evt) => {
          const ms = new Date(evt.createdAt).getTime();
          return ms >= fromMs && ms <= toMs;
        });
      },
      nowIso: () => "2026-03-10T00:00:00.000Z"
    }
  );

  assert.equal(payload.summary.totalEvents, 1);
  assert.equal(payload.summary.bySurface.reactivation_queue, 1);
});

test("topCards computed correctly", async () => {
  const payload = await buildWhatsAppOperatorEventsSummary(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-10T00:00:00.000Z" },
    {
      listEvents: async () => eventsFixture,
      nowIso: () => "2026-03-10T00:00:00.000Z"
    }
  );

  assert.equal(payload.topCards.length, 2);
  assert.equal(payload.topCards[0].cardLabel, "Option 1");
  assert.equal(payload.topCards[0].count, 2);
});

test("empty result works", async () => {
  const payload = await buildWhatsAppOperatorEventsSummary(
    { from: "2026-03-07T00:00:00.000Z", to: "2026-03-07T01:00:00.000Z" },
    {
      listEvents: async () => [],
      nowIso: () => "2026-03-10T00:00:00.000Z"
    }
  );

  assert.equal(payload.summary.totalEvents, 0);
  assert.equal(payload.topCards.length, 0);
  assert.equal(payload.summary.byFeedType.active, 0);
  assert.equal(payload.summary.byFeedType.reactivation, 0);
});

test("invalid date query rejected", () => {
  assert.throws(
    () => validateOperatorSummaryRange({ from: "invalid-date", to: "2026-03-07T00:00:00.000Z" }),
    (error: unknown) => error instanceof WhatsAppOperatorAnalyticsError && error.code === "operator_events_summary_invalid_date"
  );
});
