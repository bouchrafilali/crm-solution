import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMobileLabLeadCards } from "./whatsappMobileLabLeadCardsService.js";
import { buildMobileLabFeed } from "./whatsappMobileLabFeedService.js";

test("selected lead cards success", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", {
    timeoutMs: () => 5000,
    getAiCards: async () => ({
      leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
      summary: {
        stage: "QUALIFIED",
        stageConfidence: 0.91,
        urgency: "medium",
        paymentIntent: false,
        dropoffRisk: "low",
        priorityScore: 71
      },
      strategy: {
        recommendedAction: "answer_precisely",
        commercialPriority: "high",
        tone: "warm_refined",
        pressureLevel: "low",
        primaryGoal: "Clarify options",
        secondaryGoal: "Move to next step"
      },
      signals: [],
      facts: {
        productsOfInterest: [],
        eventDate: null,
        deliveryDeadline: null,
        destinationCountry: null,
        budget: null,
        pricePointsDetected: [],
        customizationRequests: [],
        preferredColors: [],
        preferredFabrics: [],
        paymentMethodPreference: null
      },
      replyCards: [
        { label: "Option 1", intent: "Clarify", messages: ["Message 1", "Message 2"] },
        { label: "Option 2", intent: "Guide", messages: ["Message 1", "Message 2"] }
      ],
      brandGuardian: { approved: true, issues: [] },
      meta: {
        messageCount: 3,
        transcriptLength: 120,
        provider: "openai",
        model: "gpt-4.1-mini",
        timestamp: "2026-03-07T00:00:00.000Z"
      }
    })
  });

  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
  assert.equal(payload.replyCards.length, 2);
  assert.equal(payload.topReplyCard?.label, "Option 1");
  assert.equal(payload.enrichmentError, null);
});

test("selected lead cards timeout", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", {
    timeoutMs: () => 50,
    getAiCards: async () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
            summary: {
              stage: "QUALIFIED",
              stageConfidence: 0.8,
              urgency: "low",
              paymentIntent: false,
              dropoffRisk: "low",
              priorityScore: 40
            },
            strategy: {
              recommendedAction: "answer_precisely",
              commercialPriority: "medium",
              tone: "soft_luxury",
              pressureLevel: "none",
              primaryGoal: "Goal",
              secondaryGoal: "Goal2"
            },
            signals: [],
            facts: {
              productsOfInterest: [],
              eventDate: null,
              deliveryDeadline: null,
              destinationCountry: null,
              budget: null,
              pricePointsDetected: [],
              customizationRequests: [],
              preferredColors: [],
              preferredFabrics: [],
              paymentMethodPreference: null
            },
            replyCards: [{ label: "Option 1", intent: "X", messages: ["A", "B"] }],
            brandGuardian: { approved: true, issues: [] },
            meta: {
              messageCount: 2,
              transcriptLength: 100,
              provider: "openai",
              model: "gpt-4.1-mini",
              timestamp: "2026-03-07T00:00:00.000Z"
            }
          });
        }, 150);
      })
  });

  assert.equal(payload.enrichmentStatus, "timeout");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
  assert.equal(payload.topReplyCard, null);
  assert.equal(payload.replyCards.length, 0);
  assert.equal(typeof payload.enrichmentError, "string");
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
