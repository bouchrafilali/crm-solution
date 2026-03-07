import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMobileLabLeadCards } from "./whatsappMobileLabLeadCardsService.js";
import { buildMobileLabFeed } from "./whatsappMobileLabFeedService.js";

test("selected lead cards success", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 5000,
    getActiveReplyContext: async () => ({
      replyOptions: {
        reply_options: [
          { label: "Option 1", intent: "Clarify", messages: ["Message 1", "Message 2"] },
          { label: "Option 2", intent: "Guide", messages: ["Message 1", "Message 2"] },
          { label: "Option 3", intent: "Close", messages: ["Message 1", "Message 2"] }
        ]
      },
      strategy: {
        recommended_action: "answer_precisely",
        action_confidence: 0.9,
        commercial_priority: "high",
        tone: "warm_refined",
        pressure_level: "low",
        primary_goal: "Clarify options",
        secondary_goal: "Move to next step",
        missed_opportunities: [],
        strategy_rationale: [],
        do_now: [],
        avoid: []
      },
      stageAnalysis: {
        stage: "QUALIFIED",
        stage_confidence: 0.91,
        priority_score: 71,
        urgency: "medium",
        payment_intent: false,
        dropoff_risk: "low",
        signals: [],
        facts: {
          products_of_interest: [],
          event_date: null,
          delivery_deadline: null,
          destination_country: null,
          budget: null,
          price_points_detected: [],
          customization_requests: [],
          preferred_colors: [],
          preferred_fabrics: [],
          payment_method_preference: null
        },
        objections: [],
        recommended_next_action: "answer_precisely",
        reasoning_summary: []
      },
      transcriptLength: 120,
      messageCount: 3,
      provider: "openai",
      model: "gpt-4.1-mini",
      timestamp: "2026-03-07T00:00:00.000Z"
    })
  });

  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
  assert.equal(payload.status, "enriched");
  assert.equal(payload.source, "active_ai_cards");
  assert.equal(payload.error, null);
  assert.equal(payload.replyCards.length, 0);
  assert.equal(payload.topReplyCard?.label, "Option 1");
  assert.equal(payload.enrichmentError, null);
});

test("selected lead cards timeout", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 50,
    getActiveReplyContext: async () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            replyOptions: {
              reply_options: [
                { label: "Option 1", intent: "X", messages: ["A", "B"] },
                { label: "Option 2", intent: "Y", messages: ["A", "B"] },
                { label: "Option 3", intent: "Z", messages: ["A", "B"] }
              ]
            },
            strategy: {
              recommended_action: "answer_precisely",
              action_confidence: 0.8,
              commercial_priority: "medium",
              tone: "soft_luxury",
              pressure_level: "none",
              primary_goal: "Goal",
              secondary_goal: "Goal2",
              missed_opportunities: [],
              strategy_rationale: [],
              do_now: [],
              avoid: []
            },
            stageAnalysis: {
              stage: "QUALIFIED",
              stage_confidence: 0.8,
              priority_score: 40,
              urgency: "low",
              payment_intent: false,
              dropoff_risk: "low",
              signals: [],
              facts: {
                products_of_interest: [],
                event_date: null,
                delivery_deadline: null,
                destination_country: null,
                budget: null,
                price_points_detected: [],
                customization_requests: [],
                preferred_colors: [],
                preferred_fabrics: [],
                payment_method_preference: null
              },
              objections: [],
              recommended_next_action: "answer_precisely",
              reasoning_summary: []
            },
            transcriptLength: 100,
            messageCount: 2,
            provider: "openai",
            model: "gpt-4.1-mini",
            timestamp: "2026-03-07T00:00:00.000Z"
          });
        }, 150);
      })
  });

  assert.equal(payload.enrichmentStatus, "timeout");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
  assert.equal(payload.status, "timeout");
  assert.equal(payload.source, "active_ai_cards");
  assert.equal(payload.topReplyCard, null);
  assert.equal(payload.replyCards.length, 0);
  assert.equal(typeof payload.enrichmentError, "string");
});

test("selected lead cards error", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 2000,
    getActiveReplyContext: async () => {
      throw new Error("provider_failed");
    }
  });

  assert.equal(payload.enrichmentStatus, "error");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
  assert.equal(payload.status, "error");
  assert.equal(payload.source, "active_ai_cards");
  assert.equal(payload.topReplyCard, null);
  assert.equal(payload.replyCards.length, 0);
  assert.equal(payload.enrichmentError, "provider_failed");
  assert.equal(payload.error, "provider_failed");
});

test("selected reactivation lead cards success", async () => {
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { feedType: "reactivation" },
    {
      timeoutMs: () => 2000,
      getReactivationReplies: async () => ({
        shouldGenerate: true,
        reactivationDecision: {
          leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
          shouldReactivate: true,
          reactivationPriority: "high",
          reactivationReason: "stalled",
          stalledStage: "PRICE_SENT",
          silenceHours: 48,
          signals: [],
          recommendedAction: "reactivate_gently",
          tone: "reassuring",
          timing: "now"
        },
        replyOptions: [{ label: "Option 1", intent: "Reopen", messages: ["Message 1", "Message 2"] }],
        provider: "openai",
        model: "gpt-4.1-mini",
        timestamp: "2026-03-07T00:00:00.000Z"
      }),
      getActiveReplyContext: async () => {
        throw new Error("should_not_call_ai_cards");
      }
    }
  );

  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentSource, "reactivation_replies");
  assert.equal(payload.status, "enriched");
  assert.equal(payload.source, "reactivation_replies");
  assert.equal(payload.topReplyCard?.label, "Option 1");
  assert.equal(payload.replyCards.length, 0);
});

test("feed remains unaffected by selected lead cards path", async () => {
  const payload = await buildMobileLabFeed(
    { limit: 1, days: 30 },
    {
      getPriorityView: async () => ({
        items: [
          {
            leadId: "lead-1",
            clientName: "A",
            lastMessagePreview: "Hi",
            lastMessageAt: "2026-03-07T09:00:00.000Z",
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
            tone: null,
            reasons: [],
            topReplyCard: null
          }
        ],
        meta: { count: 1, limit: 1, days: 30, generatedAt: "2026-03-07T00:00:00.000Z" }
      }),
      getReactivationView: async () => ({ items: [], meta: { count: 0, limit: 1, days: 30, generatedAt: "2026-03-07T00:00:00.000Z" } }),
      getActiveSkips: async () => [],
      nowIso: () => "2026-03-07T10:00:00.000Z",
      enrichmentLeadLimit: () => 0,
      enrichmentTimeoutMs: () => 1000
    }
  );

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].leadId, "lead-1");
});
