import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMobileLabLeadCards } from "./whatsappMobileLabLeadCardsService.js";
import { buildMobileLabFeed } from "./whatsappMobileLabFeedService.js";

test("selected lead cards success", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 5000,
    getLatestLeadMessage: async () => ({ id: "msg-1", createdAt: "2026-03-07T00:00:00.000Z" }),
    persistCachedLeadState: async () => {
      throw new Error("ignore_persist_for_test");
    },
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
  assert.equal(payload.source, "fresh_generation");
  assert.equal(payload.cacheStatus, "miss");
  assert.equal(payload.pipelineSource, "active_ai_cards");
  assert.equal(payload.basedOnMessageId, "msg-1");
  assert.equal(payload.error, null);
  assert.equal(payload.replyCards.length, 0);
  assert.equal(payload.topReplyCard?.label, "Option 1");
  assert.equal(payload.generationMode, "fresh");
  assert.equal(payload.enrichmentError, null);
  assert.equal(payload.agentRunMeta.runId, null);
  assert.equal(payload.agentRunMeta.source, "fresh_generation");
  assert.equal(payload.agentRunMeta.reasoningSource, null);
});

test("persisted results are reused before regeneration", async () => {
  let activeCallCount = 0;
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 5000,
    getLatestLeadMessage: async () => ({ id: "message-1", createdAt: "2026-03-06T23:59:00.000Z" }),
    getCachedLeadState: async () => ({
      leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
      latestRunId: "run-1",
      latestMessageId: "message-1",
      stageAnalysis: {
        stage: "QUALIFIED",
        stage_confidence: 0.92,
        urgency: "medium",
        payment_intent: false,
        dropoff_risk: "low",
        priority_score: 70
      },
      facts: null,
      priorityItem: null,
      strategy: {
        recommended_action: "answer_precisely",
        commercial_priority: "high",
        tone: "warm_refined",
        pressure_level: "low",
        primary_goal: "Clarify",
        secondary_goal: "Advance"
      },
      replyOptions: null,
      brandReview: null,
      topReplyCard: {
        label: "Option cached",
        intent: "Clarify",
        messages: ["Message 1", "Message 2"]
      },
      providers: { reply_generator: "openai" },
      reasoningSource: "state_delta",
      createdAt: "2026-03-07T00:00:00.000Z",
      updatedAt: "2026-03-07T00:00:00.000Z"
    }),
    getActiveReplyContext: async () => {
      activeCallCount += 1;
      throw new Error("should_not_regenerate_when_cached");
    }
  });

  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.topReplyCard?.label, "Option cached");
  assert.equal(payload.generationMode, "cached");
  assert.equal(payload.source, "cache");
  assert.equal(payload.cacheStatus, "hit");
  assert.equal(payload.agentRunMeta.runId, "run-1");
  assert.equal(payload.agentRunMeta.source, "cache");
  assert.equal(payload.agentRunMeta.reasoningSource, "state_delta");
  assert.equal(activeCallCount, 0);
  assert.equal(payload.replyCards.length, 0);
});

test("stale cache triggers regeneration", async () => {
  let activeCallCount = 0;
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 5000,
    getLatestLeadMessage: async () => ({ id: "msg-new", createdAt: "2026-03-07T01:00:00.000Z" }),
    getCachedLeadState: async () => ({
      leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
      latestRunId: "run-1",
      latestMessageId: "msg-old",
      stageAnalysis: null,
      facts: null,
      priorityItem: null,
      strategy: null,
      replyOptions: null,
      brandReview: null,
      topReplyCard: { label: "Old", intent: "Old", messages: ["A", "B"] },
      providers: null,
      createdAt: "2026-03-06T00:00:00.000Z",
      updatedAt: "2026-03-06T00:00:00.000Z"
    }),
    persistCachedLeadState: async () => {
      throw new Error("ignore_persist_for_test");
    },
    getActiveReplyContext: async () => {
      activeCallCount += 1;
      return {
        replyOptions: {
          reply_options: [
            { label: "Fresh 1", intent: "Clarify", messages: ["Message 1", "Message 2"] },
            { label: "Fresh 2", intent: "Guide", messages: ["Message 1", "Message 2"] },
            { label: "Fresh 3", intent: "Close", messages: ["Message 1", "Message 2"] }
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
      };
    }
  });

  assert.equal(activeCallCount, 1);
  assert.equal(payload.source, "fresh_generation");
  assert.equal(payload.cacheStatus, "stale");
  assert.equal(payload.topReplyCard?.label, "Fresh 1");
});

test("force refresh bypasses cache and stores a new orchestrator run", async () => {
  let cachedReadCount = 0;
  let orchestratorCalls = 0;
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { forceRefresh: true },
    {
      timeoutMs: () => 2000,
      getLatestLeadMessage: async () => ({ id: "msg-force", createdAt: "2026-03-07T10:00:00.000Z" }),
      getCachedLeadState: async () => {
        cachedReadCount += 1;
        if (cachedReadCount === 1) {
          return {
            leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
            latestRunId: "run-old",
            latestMessageId: "msg-old",
            stageAnalysis: null,
            facts: null,
            priorityItem: null,
            strategy: null,
            replyOptions: null,
            brandReview: null,
            topReplyCard: { label: "Old", intent: "Old", messages: ["A", "B"] },
            providers: null,
            createdAt: "2026-03-06T00:00:00.000Z",
            updatedAt: "2026-03-06T00:00:00.000Z"
          };
        }
        return {
          leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
          latestRunId: "run-force-new",
          latestMessageId: "msg-force",
          stageAnalysis: null,
          facts: null,
          priorityItem: null,
          strategy: null,
          replyOptions: null,
          brandReview: null,
          topReplyCard: { label: "New", intent: "Fresh", messages: ["N1", "N2"] },
          providers: { reply_generator: "openai" },
          reasoningSource: "state_delta",
          createdAt: "2026-03-07T10:00:00.000Z",
          updatedAt: "2026-03-07T10:00:01.000Z"
        };
      },
      runAgentOrchestrator: async () => {
        orchestratorCalls += 1;
        return {
          runId: "run-force-new",
          leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
          messageId: "msg-force",
          status: "completed",
          stageAnalysis: null,
          strategy: null,
          priority: null,
          topReplyCard: { label: "From orchestrator", intent: "Fresh run", messages: ["R1", "R2"] },
          reasoningSource: "state_delta"
        };
      },
      getActiveReplyContext: async () => {
        throw new Error("should_not_use_direct_generation_when_force_refresh");
      }
    }
  );

  assert.equal(orchestratorCalls, 1);
  assert.equal(payload.generationMode, "fresh");
  assert.equal(payload.source, "fresh_generation");
  assert.equal(payload.cacheStatus, "stale");
  assert.equal(payload.topReplyCard?.label, "From orchestrator");
  assert.equal(payload.agentRunMeta.runId, "run-force-new");
  assert.equal(payload.agentRunMeta.reasoningSource, "state_delta");
  assert.equal(payload.enrichmentStatus, "enriched");
});

test("force refresh surfaces partial failure safely", async () => {
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { forceRefresh: true },
    {
      timeoutMs: () => 2000,
      getLatestLeadMessage: async () => ({ id: "msg-force-partial", createdAt: "2026-03-07T10:00:00.000Z" }),
      getCachedLeadState: async () => ({
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        latestRunId: "run-force-partial",
        latestMessageId: "msg-force-partial",
        stageAnalysis: null,
        facts: null,
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: { label: "Partial card", intent: "Keep going", messages: ["P1", "P2"] },
        providers: { reply_generator: "openai" },
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:01.000Z"
      }),
      runAgentOrchestrator: async () => ({
        runId: "run-force-partial",
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        messageId: "msg-force-partial",
        status: "partial",
        stageAnalysis: null,
        strategy: null,
        priority: null,
        topReplyCard: null
      })
    }
  );

  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentError, "partial_failure_some_steps_failed");
  assert.equal(payload.agentRunMeta.runId, "run-force-partial");
});

test("force refresh failure preserves previous cached cards", async () => {
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { forceRefresh: true },
    {
      timeoutMs: () => 2000,
      getLatestLeadMessage: async () => ({ id: "msg-force-failed", createdAt: "2026-03-07T10:00:00.000Z" }),
      getCachedLeadState: async () => ({
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        latestRunId: "run-old",
        latestMessageId: "msg-old",
        stageAnalysis: null,
        facts: null,
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: { label: "Keep old", intent: "Fallback", messages: ["O1", "O2"] },
        providers: null,
        createdAt: "2026-03-07T09:00:00.000Z",
        updatedAt: "2026-03-07T09:00:00.000Z"
      }),
      runAgentOrchestrator: async () => ({
        runId: "run-failed",
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        messageId: "msg-force-failed",
        status: "failed",
        stageAnalysis: null,
        strategy: null,
        priority: null,
        topReplyCard: null
      })
    }
  );

  assert.equal(payload.topReplyCard?.label, "Keep old");
  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentError, "Regeneration failed. Kept previous suggestions.");
});

test("force refresh no_generation_needed preserves previous cached cards", async () => {
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { forceRefresh: true },
    {
      timeoutMs: () => 2000,
      getLatestLeadMessage: async () => ({ id: "msg-force-empty", createdAt: "2026-03-07T10:00:00.000Z" }),
      getCachedLeadState: async () => ({
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        latestRunId: "run-old",
        latestMessageId: "msg-old",
        stageAnalysis: null,
        facts: null,
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: { label: "Keep old", intent: "Fallback", messages: ["O1", "O2"] },
        providers: null,
        createdAt: "2026-03-07T09:00:00.000Z",
        updatedAt: "2026-03-07T09:00:00.000Z"
      }),
      runAgentOrchestrator: async () => ({
        runId: "run-empty",
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        messageId: "msg-force-empty",
        status: "completed",
        stageAnalysis: null,
        strategy: null,
        priority: null,
        topReplyCard: null
      })
    }
  );

  assert.equal(payload.topReplyCard?.label, "Keep old");
  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentError, "No new usable suggestions. Kept previous suggestions.");
});

test("force refresh timeout preserves previous cached cards", async () => {
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { forceRefresh: true },
    {
      timeoutMs: () => 25,
      getLatestLeadMessage: async () => ({ id: "msg-force-timeout", createdAt: "2026-03-07T10:00:00.000Z" }),
      getCachedLeadState: async () => ({
        leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
        latestRunId: "run-old",
        latestMessageId: "msg-old",
        stageAnalysis: null,
        facts: null,
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: { label: "Keep old", intent: "Fallback", messages: ["O1", "O2"] },
        providers: null,
        createdAt: "2026-03-07T09:00:00.000Z",
        updatedAt: "2026-03-07T09:00:00.000Z"
      }),
      runAgentOrchestrator: async () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              runId: "run-timeout",
              leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
              messageId: "msg-force-timeout",
              status: "completed" as const,
              stageAnalysis: null,
              strategy: null,
              priority: null,
              topReplyCard: { label: "Late", intent: "Late", messages: ["L1", "L2"] }
            });
          }, 120);
        })
    }
  );

  assert.equal(payload.topReplyCard?.label, "Keep old");
  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentError, "Regeneration timed out. Kept previous suggestions.");
});

test("force refresh on reactivation still uses orchestrator run", async () => {
  let orchestratorCalls = 0;
  let reactivationCalls = 0;
  const payload = await buildMobileLabLeadCards(
    "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
    { feedType: "reactivation", forceRefresh: true },
    {
      timeoutMs: () => 2000,
      getLatestLeadMessage: async () => ({ id: "msg-react-force", createdAt: "2026-03-07T10:00:00.000Z" }),
      runAgentOrchestrator: async () => {
        orchestratorCalls += 1;
        return {
          runId: "run-react-force",
          leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
          messageId: "msg-react-force",
          status: "completed",
          stageAnalysis: null,
          strategy: null,
          priority: null,
          topReplyCard: { label: "Run card", intent: "Manual regenerate", messages: ["A", "B"] }
        };
      },
      getReactivationReplies: async () => {
        reactivationCalls += 1;
        return {
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
        };
      }
    }
  );

  assert.equal(orchestratorCalls, 1);
  assert.equal(reactivationCalls, 0);
  assert.equal(payload.topReplyCard?.label, "Run card");
  assert.equal(payload.agentRunMeta.runId, "run-react-force");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
});

test("unchanged lead does not regenerate repeatedly", async () => {
  let activeCallCount = 0;
  const deps = {
    timeoutMs: () => 5000,
    getLatestLeadMessage: async () => ({ id: "msg-same", createdAt: "2026-03-07T00:00:00.000Z" }),
    getCachedLeadState: async () => ({
      leadId: "8a4b1542-0c56-4c49-8ffd-bf5bd32164ab",
      latestRunId: "run-1",
      latestMessageId: "msg-same",
      stageAnalysis: null,
      facts: null,
      priorityItem: null,
      strategy: null,
      replyOptions: null,
      brandReview: null,
      topReplyCard: { label: "Stable", intent: "Stable", messages: ["A", "B"] },
      providers: null,
      createdAt: "2026-03-06T00:00:00.000Z",
      updatedAt: "2026-03-07T00:00:01.000Z"
    }),
    getActiveReplyContext: async () => {
      activeCallCount += 1;
      throw new Error("should_not_call_on_unchanged");
    }
  };

  const first = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, deps);
  const second = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, deps);

  assert.equal(first.source, "cache");
  assert.equal(second.source, "cache");
  assert.equal(first.cacheStatus, "hit");
  assert.equal(second.cacheStatus, "hit");
  assert.equal(activeCallCount, 0);
});

test("selected lead cards timeout", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 50,
    getLatestLeadMessage: async () => ({ id: "msg-timeout", createdAt: "2026-03-07T00:00:00.000Z" }),
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
  assert.equal(payload.source, "fresh_generation");
  assert.equal(payload.pipelineSource, "active_ai_cards");
  assert.equal(payload.topReplyCard, null);
  assert.equal(payload.replyCards.length, 0);
  assert.equal(typeof payload.enrichmentError, "string");
});

test("selected lead cards error", async () => {
  const payload = await buildMobileLabLeadCards("8a4b1542-0c56-4c49-8ffd-bf5bd32164ab", undefined, {
    timeoutMs: () => 2000,
    getLatestLeadMessage: async () => ({ id: "msg-error", createdAt: "2026-03-07T00:00:00.000Z" }),
    getActiveReplyContext: async () => {
      throw new Error("provider_failed");
    }
  });

  assert.equal(payload.enrichmentStatus, "error");
  assert.equal(payload.enrichmentSource, "active_ai_cards");
  assert.equal(payload.status, "error");
  assert.equal(payload.source, "fresh_generation");
  assert.equal(payload.pipelineSource, "active_ai_cards");
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
      getLatestLeadMessage: async () => ({ id: "msg-reactivation", createdAt: "2026-03-07T00:00:00.000Z" }),
      getActiveReplyContext: async () => {
        throw new Error("should_not_call_ai_cards");
      }
    }
  );

  assert.equal(payload.enrichmentStatus, "enriched");
  assert.equal(payload.enrichmentSource, "reactivation_replies");
  assert.equal(payload.status, "enriched");
  assert.equal(payload.source, "fresh_generation");
  assert.equal(payload.pipelineSource, "reactivation_replies");
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
