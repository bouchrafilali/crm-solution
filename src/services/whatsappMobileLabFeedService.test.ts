import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMobileLabFeed } from "./whatsappMobileLabFeedService.js";
import type { PriorityDeskViewResponse } from "./whatsappPriorityDeskViewService.js";
import type { ReactivationQueueViewResponse } from "./whatsappReactivationQueueViewService.js";

function priorityViewFixture(items: PriorityDeskViewResponse["items"]): PriorityDeskViewResponse {
  return {
    items,
    meta: {
      count: items.length,
      limit: 20,
      days: 30,
      generatedAt: "2026-03-07T10:00:00.000Z"
    }
  };
}

function reactivationViewFixture(items: ReactivationQueueViewResponse["items"]): ReactivationQueueViewResponse {
  return {
    items,
    meta: {
      count: items.length,
      limit: 20,
      days: 30,
      generatedAt: "2026-03-07T10:00:00.000Z"
    }
  };
}

const noSkipDeps = {
  getActiveSkips: async () => [],
  getPrioritySignalsByLeadIds: async () => new Map(),
  nowIso: () => "2026-03-07T12:00:00.000Z",
  enrichmentLeadLimit: () => 0,
  enrichmentTimeoutMs: () => 200
};

test("successful merged response shape", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-a",
            clientName: "A",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T10:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 45,
            priorityScore: 85,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "DEPOSIT_PENDING",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "medium",
            recommendedAction: "reduce_friction_to_payment",
            commercialPriority: "critical",
            tone: "decisive_elegant",
            reasons: [],
            topReplyCard: { label: "Option 1", intent: "Close", messages: ["Message 1", "Message 2"] }
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "lead-r",
            clientName: "R",
            lastMessagePreview: "Merci",
            lastMessageAt: "2026-03-06T09:00:00.000Z",
            latestMessageDirection: "outbound",
            silenceHours: 72,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "Stalled after price",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: { label: "Option 1", intent: "Restart", messages: ["M1", "M2"] }
          }
        ])
    }
  );

  assert.ok(Array.isArray(payload.items));
  assert.equal(payload.items.length, 2);
  assert.equal(typeof payload.meta.generatedAt, "string");
});

test("active and reactivation counts correct", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-a",
            clientName: "A",
            lastMessagePreview: "In",
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 80,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: "warm_refined",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "lead-r",
            clientName: "R",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: null,
            silenceHours: 90,
            stalledStage: "VIDEO_PROPOSED",
            shouldReactivate: true,
            reactivationPriority: "medium",
            reactivationReason: "No follow-up",
            recommendedAction: "reactivate_gently",
            tone: "warm_refined",
            timing: "later_today",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );

  assert.equal(payload.meta.activeCount, 1);
  assert.equal(payload.meta.reactivationCount, 1);
});

test("priority intelligence signals are exposed and used for active ordering", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30, mode: "active_only" },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-a",
            clientName: "A",
            lastMessagePreview: "A",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 30,
            priorityBand: "low",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          },
          {
            leadId: "lead-b",
            clientName: "B",
            lastMessagePreview: "B",
            lastMessageAt: "2026-03-07T08:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 20,
            priorityScore: 40,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      getPrioritySignalsByLeadIds: async () =>
        new Map([
          [
            "lead-a",
            {
              priorityScore: 92,
              priorityBand: "high",
              conversionProbability: 0.71,
              dropoffRisk: 0.22,
              recommendedAttention: "reply_now",
              reasonCodes: ["awaiting_reply"],
              lastInboundAt: "2026-03-07T10:00:00.000Z"
            }
          ],
          [
            "lead-b",
            {
              priorityScore: 66,
              priorityBand: "medium",
              conversionProbability: 0.42,
              dropoffRisk: 0.31,
              recommendedAttention: "wait",
              reasonCodes: ["product_interest_detected"],
              lastInboundAt: "2026-03-07T09:30:00.000Z"
            }
          ]
        ])
    }
  );

  assert.equal(payload.items[0].leadId, "lead-a");
  assert.equal(payload.items[0].priorityBand, "high");
  assert.equal(payload.items[0].priorityScore, 92);
  assert.equal(payload.items[0].recommendedAttention, "reply_now");
  assert.deepEqual(payload.items[0].reasonCodes, ["awaiting_reply"]);
  assert.equal(payload.items[0].conversionProbability, 0.71);
  assert.equal(payload.items[0].dropoffRisk, 0.22);
});

test("ranking order correct", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-active-low",
            clientName: "L",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 15,
            priorityScore: 60,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "low",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "qualify",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          },
          {
            leadId: "lead-active-high",
            clientName: "H",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 30,
            priorityScore: 95,
            priorityBand: "critical",
            estimatedHeat: "hot",
            stage: "DEPOSIT_PENDING",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "high",
            recommendedAction: "reduce_friction_to_payment",
            commercialPriority: "critical",
            tone: "decisive_elegant",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "lead-react-high",
            clientName: "RH",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 100,
            stalledStage: "DEPOSIT_PENDING",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "Pending",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );

  assert.equal(payload.items[0].leadId, "lead-active-high");
  assert.equal(payload.items[1].leadId, "lead-active-low");
  assert.equal(payload.items[2].leadId, "lead-react-high");
});

test("queueRank assigned correctly", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 3, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () => priorityViewFixture([]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "lead-r1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: null,
            silenceHours: 50,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "medium",
            reactivationReason: "Stalled",
            recommendedAction: "reactivate_gently",
            tone: null,
            timing: "tomorrow",
            signals: [],
            topReplyCard: null
          },
          {
            leadId: "lead-r2",
            clientName: "R2",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: null,
            silenceHours: 20,
            stalledStage: "QUALIFIED",
            shouldReactivate: true,
            reactivationPriority: "low",
            reactivationReason: "Stalled",
            recommendedAction: "wait",
            tone: null,
            timing: "monitor",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );

  assert.equal(payload.items[0].queueRank, 1);
  assert.equal(payload.items[1].queueRank, 2);
});

test("null-safe mapping", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-null",
            clientName: null,
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: null,
            needsReply: true,
            waitingSinceMinutes: 0,
            priorityScore: 1,
            priorityBand: "low",
            estimatedHeat: "cold",
            stage: "NEW",
            urgency: "low",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "qualify",
            commercialPriority: "low",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([])
    }
  );

  assert.equal(payload.items[0].clientName, null);
  assert.equal(payload.items[0].lastMessagePreview, null);
  assert.equal(payload.items[0].topReplyCard, null);
  assert.equal(payload.items[0].skipAllowed, true);
  assert.equal(payload.items[0].skipReason, null);
});

test("meta shape correctness", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 11, days: 19 },
    {
      ...noSkipDeps,
      getPriorityView: async () => priorityViewFixture([]),
      getReactivationView: async () => reactivationViewFixture([])
    }
  );

  assert.equal(payload.meta.count, 0);
  assert.equal(payload.meta.activeCount, 0);
  assert.equal(payload.meta.reactivationCount, 0);
  assert.equal(payload.meta.limit, 11);
  assert.ok(/T/.test(payload.meta.generatedAt));
});

test("skipped item excluded from feed", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30 },
    {
      getActiveSkips: async () => [{ leadId: "lead-skip", feedType: "active", skippedUntil: "2026-03-07T15:00:00.000Z" }],
      nowIso: () => "2026-03-07T12:00:00.000Z",
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-skip",
            clientName: "Skip",
            lastMessagePreview: "A",
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 20,
            priorityScore: 90,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "medium",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: "warm_refined",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([])
    }
  );

  assert.equal(payload.items.length, 0);
});

test("expired skip reappears in feed", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 10, days: 30 },
    {
      getActiveSkips: async () => [{ leadId: "lead-old", feedType: "active", skippedUntil: "2026-03-07T10:00:00.000Z" }],
      nowIso: () => "2026-03-07T12:00:00.000Z",
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-old",
            clientName: "Old",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 5,
            priorityScore: 20,
            priorityBand: "low",
            estimatedHeat: "cold",
            stage: "NEW",
            urgency: "low",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "qualify",
            commercialPriority: "low",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([])
    }
  );

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].leadId, "lead-old");
});

test("limit behavior remains correct after filtering", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 2, days: 30 },
    {
      getActiveSkips: async () => [{ leadId: "lead-1", feedType: "active", skippedUntil: "2026-03-07T23:00:00.000Z" }],
      nowIso: () => "2026-03-07T12:00:00.000Z",
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-1",
            clientName: "One",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 50,
            priorityScore: 99,
            priorityBand: "critical",
            estimatedHeat: "hot",
            stage: "DEPOSIT_PENDING",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "high",
            recommendedAction: "reduce_friction_to_payment",
            commercialPriority: "critical",
            tone: "decisive_elegant",
            reasons: [],
            topReplyCard: null
          },
          {
            leadId: "lead-2",
            clientName: "Two",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 40,
            priorityScore: 80,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "medium",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: "warm_refined",
            reasons: [],
            topReplyCard: null
          },
          {
            leadId: "lead-3",
            clientName: "Three",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 30,
            priorityScore: 70,
            priorityBand: "high",
            estimatedHeat: "warm",
            stage: "PRODUCT_INTEREST",
            urgency: "low",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "qualify",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([])
    }
  );

  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].leadId, "lead-2");
  assert.equal(payload.items[1].leadId, "lead-3");
});

test("balanced mode", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "balanced", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 25,
            priorityScore: 50,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 80,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.items[0].feedType, "active");
  assert.equal(payload.items[1].feedType, "reactivation");
});

test("active_first mode", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 5,
            priorityScore: 10,
            priorityBand: "low",
            estimatedHeat: "cold",
            stage: "NEW",
            urgency: "low",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "qualify",
            commercialPriority: "low",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 200,
            stalledStage: "DEPOSIT_PENDING",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.items[0].feedType, "active");
});

test("reactivation_first mode", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "reactivation_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 30,
            priorityScore: 90,
            priorityBand: "critical",
            estimatedHeat: "hot",
            stage: "DEPOSIT_PENDING",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "high",
            recommendedAction: "reduce_friction_to_payment",
            commercialPriority: "critical",
            tone: "decisive_elegant",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 100,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.items[0].feedType, "reactivation");
});

test("active_only mode", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_only", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 40,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "medium",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: "warm_refined",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 120,
            stalledStage: "QUALIFIED",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "warm_refined",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].feedType, "active");
  assert.equal(payload.meta.activeCount, 1);
  assert.equal(payload.meta.reactivationCount, 0);
});

test("reactivation_only mode", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "reactivation_only", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 40,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "medium",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: "warm_refined",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 120,
            stalledStage: "QUALIFIED",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "warm_refined",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].feedType, "reactivation");
  assert.equal(payload.meta.activeCount, 0);
  assert.equal(payload.meta.reactivationCount, 1);
});

test("maxReactivation cap works", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", maxReactivation: 1, limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 50,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 200,
            stalledStage: "DEPOSIT_PENDING",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          },
          {
            leadId: "react-2",
            clientName: "R2",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 120,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "medium",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "warm_refined",
            timing: "later_today",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.meta.reactivationCount, 1);
});

test("queueRank still assigned correctly", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "reactivation_first", limit: 3, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 40,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 100,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.items[0].queueRank, 1);
  assert.equal(payload.items[1].queueRank, 2);
});

test("meta counts remain correct", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "reactivation_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "active-1",
            clientName: "A1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 10,
            priorityScore: 50,
            priorityBand: "medium",
            estimatedHeat: "warm",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "medium",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "react-1",
            clientName: "R1",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 100,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "high",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "now",
            signals: [],
            topReplyCard: null
          },
          {
            leadId: "react-2",
            clientName: "R2",
            lastMessagePreview: null,
            lastMessageAt: null,
            latestMessageDirection: "outbound",
            silenceHours: 80,
            stalledStage: "VIDEO_PROPOSED",
            shouldReactivate: true,
            reactivationPriority: "medium",
            reactivationReason: "stalled",
            recommendedAction: "reactivate_gently",
            tone: "warm_refined",
            timing: "later_today",
            signals: [],
            topReplyCard: null
          }
        ])
    }
  );
  assert.equal(payload.meta.activeCount, 1);
  assert.equal(payload.meta.reactivationCount, 2);
  assert.equal(payload.meta.count, 3);
});

test("feed returns items when AI enrichment fails", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-active-err",
            clientName: "A",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 25,
            priorityScore: 90,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "PRICE_SENT",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "medium",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: "warm_refined",
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "lead-react-ok",
            clientName: "R",
            lastMessagePreview: "Merci",
            lastMessageAt: "2026-03-06T09:00:00.000Z",
            latestMessageDirection: "outbound",
            silenceHours: 48,
            stalledStage: "VIDEO_PROPOSED",
            shouldReactivate: true,
            reactivationPriority: "medium",
            reactivationReason: "No follow-up",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "later_today",
            signals: [],
            topReplyCard: null
          }
        ]),
      enrichActiveLead: async () => {
        throw new Error("ai failed");
      },
      enrichReactivationLead: async () => ({
        topReplyCard: { label: "Option 1", intent: "Restart", messages: ["Message 1", "Message 2"] },
        status: "enriched"
      }),
      enrichmentLeadLimit: () => 10,
      enrichmentTimeoutMs: () => 200
    }
  );

  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].leadId, "lead-active-err");
  assert.equal(payload.items[1].leadId, "lead-react-ok");
  assert.equal(payload.items[0].topReplyCard, null);
});

test("feed returns items when AI enrichment times out", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-timeout",
            clientName: "Timeout",
            lastMessagePreview: "Ping",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 30,
            priorityScore: 88,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      enrichActiveLead: async () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                topReplyCard: { label: "Option 1", intent: "Late", messages: ["M1", "M2"] },
                tone: "warm_refined",
                status: "enriched"
              }),
            250
          );
        }),
      enrichmentLeadLimit: () => 10,
      enrichmentTimeoutMs: () => 60
    }
  );

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].leadId, "lead-timeout");
  assert.equal(payload.items[0].topReplyCard, null);
});

test("enriched item diagnostics", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-enriched",
            clientName: "Enriched",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 20,
            priorityScore: 92,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "DEPOSIT_PENDING",
            urgency: "high",
            paymentIntent: true,
            dropoffRisk: "medium",
            recommendedAction: "reduce_friction_to_payment",
            commercialPriority: "critical",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      enrichmentLeadLimit: () => 10,
      enrichActiveLead: async () => ({
        topReplyCard: { label: "Option 1", intent: "Close", messages: ["Message 1", "Message 2"] },
        tone: "decisive_elegant",
        status: "enriched"
      })
    }
  );

  assert.equal(payload.items[0].topReplyCard?.label, "Option 1");
  assert.equal(payload.items[0].enrichmentStatus, "enriched");
  assert.equal(payload.items[0].enrichmentSource, "active_ai_cards");
  assert.equal(payload.items[0].enrichmentError, null);
});

test("timeout item diagnostics", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-timeout-diagnostics",
            clientName: "Timeout",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 20,
            priorityScore: 92,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      enrichmentLeadLimit: () => 10,
      enrichmentTimeoutMs: () => 50,
      enrichActiveLead: async () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              topReplyCard: { label: "Late", intent: "Late", messages: ["A", "B"] },
              tone: "warm_refined",
              status: "enriched"
            });
          }, 180);
        })
    }
  );

  assert.equal(payload.items[0].topReplyCard, null);
  assert.equal(payload.items[0].enrichmentStatus, "timeout");
  assert.equal(payload.items[0].enrichmentSource, "active_ai_cards");
  assert.equal(typeof payload.items[0].enrichmentError, "string");
});

test("active_ai_cards succeeds with longer timeout", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-slow-success",
            clientName: "Slow Success",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 15,
            priorityScore: 91,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      enrichmentLeadLimit: () => 10,
      enrichmentTimeoutMs: () => 1200,
      enrichActiveLead: async () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              topReplyCard: { label: "Option Slow", intent: "Follow up", messages: ["Message 1", "Message 2"] },
              tone: "warm_refined",
              status: "enriched"
            });
          }, 700);
        })
    }
  );

  assert.equal(payload.items[0].topReplyCard?.label, "Option Slow");
  assert.equal(payload.items[0].enrichmentStatus, "enriched");
  assert.equal(payload.items[0].enrichmentSource, "active_ai_cards");
  assert.equal(payload.items[0].enrichmentError, null);
});

test("skipped_by_limit diagnostics", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-skipped",
            clientName: "Skipped",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 20,
            priorityScore: 92,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      enrichmentLeadLimit: () => 0
    }
  );

  assert.equal(payload.items[0].enrichmentStatus, "skipped_by_limit");
  assert.equal(payload.items[0].enrichmentSource, "active_ai_cards");
  assert.equal(payload.items[0].enrichmentError, null);
});

test("no_generation_needed diagnostics", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "reactivation_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () => priorityViewFixture([]),
      getReactivationView: async () =>
        reactivationViewFixture([
          {
            leadId: "lead-no-generate",
            clientName: "No Generate",
            lastMessagePreview: "Merci",
            lastMessageAt: "2026-03-05T09:00:00.000Z",
            latestMessageDirection: "outbound",
            silenceHours: 48,
            stalledStage: "PRICE_SENT",
            shouldReactivate: true,
            reactivationPriority: "medium",
            reactivationReason: "Stalled",
            recommendedAction: "reactivate_gently",
            tone: "reassuring",
            timing: "later_today",
            signals: [],
            topReplyCard: null
          }
        ]),
      enrichmentLeadLimit: () => 10,
      enrichReactivationLead: async () => ({ topReplyCard: null, status: "no_generation_needed" })
    }
  );

  assert.equal(payload.items[0].topReplyCard, null);
  assert.equal(payload.items[0].enrichmentStatus, "no_generation_needed");
  assert.equal(payload.items[0].enrichmentSource, "reactivation_replies");
  assert.equal(payload.items[0].enrichmentError, null);
});

test("error item diagnostics", async () => {
  const payload = await buildMobileLabFeed(
    { mode: "active_first", limit: 10, days: 30 },
    {
      ...noSkipDeps,
      getPriorityView: async () =>
        priorityViewFixture([
          {
            leadId: "lead-error",
            clientName: "Error",
            lastMessagePreview: "Bonjour",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
            latestMessageDirection: "inbound",
            needsReply: true,
            waitingSinceMinutes: 20,
            priorityScore: 92,
            priorityBand: "high",
            estimatedHeat: "hot",
            stage: "QUALIFIED",
            urgency: "medium",
            paymentIntent: false,
            dropoffRisk: "low",
            recommendedAction: "answer_precisely",
            commercialPriority: "high",
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ]),
      getReactivationView: async () => reactivationViewFixture([]),
      enrichmentLeadLimit: () => 10,
      enrichActiveLead: async () => {
        throw new Error("provider_failed");
      }
    }
  );

  assert.equal(payload.items[0].topReplyCard, null);
  assert.equal(payload.items[0].enrichmentStatus, "error");
  assert.equal(payload.items[0].enrichmentSource, "active_ai_cards");
  assert.equal(payload.items[0].enrichmentError, "provider_failed");
});
