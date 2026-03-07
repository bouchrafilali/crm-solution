import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildReactivationQueueView } from "./whatsappReactivationQueueViewService.js";
import type { ReactivationDecision } from "./whatsappReactivationEngineService.js";
import type { ReactivationReplyResult } from "./whatsappReactivationReplyService.js";

function decision(input: {
  leadId: string;
  priority: "low" | "medium" | "high";
  stage: string | null;
  silenceHours: number;
  reason?: string;
}): ReactivationDecision {
  return {
    leadId: input.leadId,
    shouldReactivate: true,
    reactivationPriority: input.priority,
    reactivationReason: input.reason ?? "Stalled lead",
    stalledStage: input.stage,
    silenceHours: input.silenceHours,
    signals: ["stalled_after_outbound"],
    recommendedAction: "reactivate_gently",
    tone: "warm_refined",
    timing: "now"
  };
}

function replies(input: { leadId: string; shouldGenerate: boolean; topLabel?: string }): ReactivationReplyResult {
  return {
    shouldGenerate: input.shouldGenerate,
    reactivationDecision: decision({
      leadId: input.leadId,
      priority: "medium",
      stage: "PRICE_SENT",
      silenceHours: 72
    }),
    replyOptions: input.shouldGenerate
      ? [
          {
            label: input.topLabel ?? "Option 1",
            intent: "Warm restart",
            messages: ["Bonjour, je me permets de revenir vers vous.", "Je reste disponible selon votre rythme."]
          },
          {
            label: "Option 2",
            intent: "Gentle check-in",
            messages: ["Je voulais simplement vérifier si vous souhaitez avancer.", "Je peux m'adapter à votre timing."]
          },
          {
            label: "Option 3",
            intent: "Polite nudge",
            messages: ["Je reste à votre disposition.", "Souhaitez-vous que je vous réserve un créneau ?"]
          }
        ]
      : [],
    provider: input.shouldGenerate ? "openai" : "none",
    model: input.shouldGenerate ? "gpt-4.1-mini" : "none",
    timestamp: "2026-03-07T10:00:00.000Z"
  };
}

test("successful response shape", async () => {
  const payload = await buildReactivationQueueView(
    { limit: 20, days: 30 },
    {
      getReactivationQueue: async () => [decision({ leadId: "lead-1", priority: "high", stage: "DEPOSIT_PENDING", silenceHours: 96 })],
      getLeadsMeta: async () => [{ id: "lead-1", clientName: "Amina" }],
      getLatestMessagesByLead: async () =>
        new Map([["lead-1", { direction: "OUT", text: "  Je reste disponible  ", createdAt: "2026-03-07T11:00:00.000Z" }]]),
      getReactivationReplies: async () => replies({ leadId: "lead-1", shouldGenerate: true })
    }
  );

  assert.ok(Array.isArray(payload.items));
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].leadId, "lead-1");
  assert.equal(payload.items[0].reactivationPriority, "high");
  assert.equal(typeof payload.meta.generatedAt, "string");
});

test("topReplyCard mapping", async () => {
  const payload = await buildReactivationQueueView(
    { limit: 5, days: 7 },
    {
      getReactivationQueue: async () => [decision({ leadId: "lead-1", priority: "medium", stage: "PRICE_SENT", silenceHours: 72 })],
      getLeadsMeta: async () => [{ id: "lead-1", clientName: "Sara" }],
      getLatestMessagesByLead: async () => new Map([["lead-1", { direction: "OUT", text: "Dernier message", createdAt: "2026-03-07T10:00:00.000Z" }]]),
      getReactivationReplies: async () => replies({ leadId: "lead-1", shouldGenerate: true, topLabel: "Top Reactivation" })
    }
  );

  assert.equal(payload.items[0].topReplyCard?.label, "Top Reactivation");
  assert.equal(payload.items[0].topReplyCard?.messages.length, 2);
});

test("null-safe handling for missing lead name and message", async () => {
  const payload = await buildReactivationQueueView(
    { limit: 2, days: 30 },
    {
      getReactivationQueue: async () => [decision({ leadId: "lead-x", priority: "low", stage: "QUALIFIED", silenceHours: 80 })],
      getLeadsMeta: async () => [{ id: "lead-x", clientName: null }],
      getLatestMessagesByLead: async () => new Map([["lead-x", null]]),
      getReactivationReplies: async () => replies({ leadId: "lead-x", shouldGenerate: true })
    }
  );

  assert.equal(payload.items[0].clientName, null);
  assert.equal(payload.items[0].lastMessagePreview, null);
  assert.equal(payload.items[0].lastMessageAt, null);
  assert.equal(payload.items[0].latestMessageDirection, null);
});

test("shouldGenerate false maps topReplyCard to null", async () => {
  const payload = await buildReactivationQueueView(
    { limit: 3, days: 30 },
    {
      getReactivationQueue: async () => [decision({ leadId: "lead-2", priority: "medium", stage: "VIDEO_PROPOSED", silenceHours: 50 })],
      getLeadsMeta: async () => [{ id: "lead-2", clientName: "Client 2" }],
      getLatestMessagesByLead: async () => new Map([["lead-2", { direction: "OUT", text: "Follow-up", createdAt: "2026-03-07T09:00:00.000Z" }]]),
      getReactivationReplies: async () => replies({ leadId: "lead-2", shouldGenerate: false })
    }
  );

  assert.equal(payload.items[0].topReplyCard, null);
});

test("ordering preserved", async () => {
  const payload = await buildReactivationQueueView(
    { limit: 3, days: 30 },
    {
      getReactivationQueue: async () => [
        decision({ leadId: "lead-b", priority: "high", stage: "DEPOSIT_PENDING", silenceHours: 120 }),
        decision({ leadId: "lead-a", priority: "medium", stage: "PRICE_SENT", silenceHours: 72 })
      ],
      getLeadsMeta: async () => [
        { id: "lead-a", clientName: "A" },
        { id: "lead-b", clientName: "B" }
      ],
      getLatestMessagesByLead: async () =>
        new Map([
          ["lead-a", { direction: "OUT", text: "A", createdAt: "2026-03-07T09:00:00.000Z" }],
          ["lead-b", { direction: "OUT", text: "B", createdAt: "2026-03-07T08:00:00.000Z" }]
        ]),
      getReactivationReplies: async (leadId) => replies({ leadId, shouldGenerate: true })
    }
  );

  assert.equal(payload.items[0].leadId, "lead-b");
  assert.equal(payload.items[1].leadId, "lead-a");
});

test("meta shape correctness", async () => {
  const payload = await buildReactivationQueueView(
    { limit: 11, days: 19 },
    {
      getReactivationQueue: async () => [],
      getLeadsMeta: async () => [],
      getLatestMessagesByLead: async () => new Map(),
      getReactivationReplies: async () => replies({ leadId: "unused", shouldGenerate: false })
    }
  );

  assert.equal(payload.meta.count, 0);
  assert.equal(payload.meta.limit, 11);
  assert.equal(payload.meta.days, 19);
  assert.ok(/T/.test(payload.meta.generatedAt));
});
