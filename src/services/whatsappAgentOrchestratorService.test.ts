import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  getLatestWhatsAppAgentRunSnapshot,
  runWhatsAppAgentOrchestrator,
  triggerWhatsAppAgentOrchestratorForInbound
} from "./whatsappAgentOrchestratorService.js";
import type { StageDetectionAnalysis } from "./whatsappStageDetectionService.js";
import type { StrategicAdvisorStrategy } from "./whatsappStrategicAdvisorService.js";

function makeStageAnalysis(): StageDetectionAnalysis {
  return {
    stage: "QUALIFICATION_PENDING",
    stage_confidence: 0.82,
    priority_score: 58,
    urgency: "medium",
    payment_intent: false,
    dropoff_risk: "medium",
    signals: [],
    facts: {
      products_of_interest: ["Jade Noctis"],
      event_date: null,
      delivery_deadline: null,
      destination_country: "FR",
      budget: null,
      price_points_detected: [],
      customization_requests: [],
      preferred_colors: [],
      preferred_fabrics: [],
      payment_method_preference: null
    },
    objections: [],
    recommended_next_action: "qualify",
    reasoning_summary: []
  };
}

function makeStrategy(): StrategicAdvisorStrategy {
  return {
    recommended_action: "answer_precisely",
    action_confidence: 0.9,
    commercial_priority: "high",
    tone: "warm_refined",
    pressure_level: "low",
    primary_goal: "Clarify product fit",
    secondary_goal: "Move client toward confirmation",
    missed_opportunities: [],
    strategy_rationale: [],
    do_now: [],
    avoid: []
  };
}

test("successful full orchestrator run", async () => {
  const steps: Array<{ stepName: string; status: string }> = [];
  let finalRunStatus = "";
  let persistedTopCard: string | null = null;

  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222" },
    {
      createRun: async () => ({
        id: "run-1",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      updateRun: async (input) => {
        finalRunStatus = input.status;
      },
      updateStep: async (input) => {
        steps.push({ stepName: input.stepName, status: input.status });
        return {
          id: `${input.stepName}-id`,
          runId: input.runId,
          stepName: input.stepName,
          stepOrder: input.stepOrder,
          status: input.status,
          provider: input.provider ?? null,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          outputJson: input.outputJson ?? null,
          error: input.error ?? null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      upsertLeadState: async (input) => {
        persistedTopCard = input.topReplyCard ? String(input.topReplyCard.label || "") : null;
        return {
          leadId: input.leadId,
          latestRunId: input.latestRunId ?? null,
          latestMessageId: input.latestMessageId ?? null,
          stageAnalysis: input.stageAnalysis ?? null,
          facts: input.facts ?? null,
          priorityItem: input.priorityItem ?? null,
          strategy: input.strategy ?? null,
          replyOptions: input.replyOptions ?? null,
          brandReview: input.brandReview ?? null,
          topReplyCard: input.topReplyCard ?? null,
          providers: input.providers ?? null,
          createdAt: "2026-03-07T10:00:00.000Z",
          updatedAt: "2026-03-07T10:00:00.000Z"
        };
      },
      getTranscript: async () => ({
        transcript: "[2026-03-07 10:00] CLIENT: hi",
        messageCount: 1,
        transcriptLength: 40
      }),
      detectStage: async () => ({
        analysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-1",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getMessages: async () => [{ direction: "IN", createdAt: "2026-03-07T09:50:00.000Z" }],
      getStrategicAdvisor: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-1",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getReplyGenerator: async () => ({
        replyOptions: {
          reply_options: [
            { label: "Option 1", intent: "clarify", messages: ["A", "B"] },
            { label: "Option 2", intent: "guide", messages: ["A", "B"] },
            { label: "Option 3", intent: "close", messages: ["A", "B"] }
          ]
        },
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getBrandGuardian: async () => ({
        review: {
          approved: true,
          issues: [],
          reply_options: [
            { label: "Option 1", intent: "clarify", messages: ["A", "B"] },
            { label: "Option 2", intent: "guide", messages: ["A", "B"] },
            { label: "Option 3", intent: "close", messages: ["A", "B"] }
          ]
        },
        replyOptions: {
          reply_options: [
            { label: "Option 1", intent: "clarify", messages: ["A", "B"] },
            { label: "Option 2", intent: "guide", messages: ["A", "B"] },
            { label: "Option 3", intent: "close", messages: ["A", "B"] }
          ]
        },
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        timestamp: "2026-03-07T10:00:00.000Z"
      })
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(finalRunStatus, "completed");
  assert.equal(persistedTopCard, "Option 1");
  assert.equal(result.topReplyCard && String(result.topReplyCard.label || ""), "Option 1");
  assert.ok(steps.some((step) => step.stepName === "brand_guardian" && step.status === "completed"));
});

test("partial failure preserves run log", async () => {
  let finalRunStatus = "";
  const steps: Array<{ stepName: string; status: string }> = [];
  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222" },
    {
      createRun: async () => ({
        id: "run-2",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      updateRun: async (input) => {
        finalRunStatus = input.status;
      },
      updateStep: async (input) => {
        steps.push({ stepName: input.stepName, status: input.status });
        return {
          id: `${input.stepName}-id`,
          runId: input.runId,
          stepName: input.stepName,
          stepOrder: input.stepOrder,
          status: input.status,
          provider: null,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          outputJson: null,
          error: input.error ?? null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      upsertLeadState: async (input) => ({
        leadId: input.leadId,
        latestRunId: input.latestRunId ?? null,
        latestMessageId: input.latestMessageId ?? null,
        stageAnalysis: input.stageAnalysis ?? null,
        facts: input.facts ?? null,
        priorityItem: input.priorityItem ?? null,
        strategy: input.strategy ?? null,
        replyOptions: input.replyOptions ?? null,
        brandReview: input.brandReview ?? null,
        topReplyCard: input.topReplyCard ?? null,
        providers: input.providers ?? null,
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z"
      }),
      getTranscript: async () => ({
        transcript: "[2026-03-07 10:00] CLIENT: hi",
        messageCount: 1,
        transcriptLength: 40
      }),
      detectStage: async () => ({
        analysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-1",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getMessages: async () => [{ direction: "IN", createdAt: "2026-03-07T09:50:00.000Z" }],
      getStrategicAdvisor: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-1",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getReplyGenerator: async () => {
        throw new Error("reply_failed");
      }
    }
  );

  assert.equal(result.status, "partial");
  assert.equal(finalRunStatus, "partial");
  assert.ok(steps.some((step) => step.stepName === "reply_generator" && step.status === "failed"));
  assert.ok(steps.some((step) => step.stepName === "brand_guardian" && step.status === "skipped"));
});

test("webhook trigger starts orchestrator asynchronously", async () => {
  let called = 0;
  triggerWhatsAppAgentOrchestratorForInbound(
    {
      leadId: "11111111-1111-4111-8111-111111111111",
      messageId: "22222222-2222-4222-8222-222222222222"
    },
    {
      createRun: async () => {
        called += 1;
        return {
          id: "run-3",
          leadId: "11111111-1111-4111-8111-111111111111",
          messageId: "22222222-2222-4222-8222-222222222222",
          status: "running",
          startedAt: "2026-03-07T10:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      updateRun: async () => {},
      updateStep: async (input) => ({
        id: `${input.stepName}-id`,
        runId: input.runId,
        stepName: input.stepName,
        stepOrder: input.stepOrder,
        status: input.status,
        provider: null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        outputJson: null,
        error: input.error ?? null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      upsertLeadState: async (input) => ({
        leadId: input.leadId,
        latestRunId: input.latestRunId ?? null,
        latestMessageId: input.latestMessageId ?? null,
        stageAnalysis: input.stageAnalysis ?? null,
        facts: input.facts ?? null,
        priorityItem: input.priorityItem ?? null,
        strategy: input.strategy ?? null,
        replyOptions: input.replyOptions ?? null,
        brandReview: input.brandReview ?? null,
        topReplyCard: input.topReplyCard ?? null,
        providers: input.providers ?? null,
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z"
      }),
      getTranscript: async () => ({
        transcript: "[2026-03-07 10:00] CLIENT: hi",
        messageCount: 1,
        transcriptLength: 40
      }),
      detectStage: async () => ({
        analysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-1",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getMessages: async () => [],
      getStrategicAdvisor: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-1",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getReplyGenerator: async () => ({
        replyOptions: {
          reply_options: [
            { label: "Option 1", intent: "clarify", messages: ["A", "B"] },
            { label: "Option 2", intent: "guide", messages: ["A", "B"] },
            { label: "Option 3", intent: "close", messages: ["A", "B"] }
          ]
        },
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getBrandGuardian: async () => ({
        review: {
          approved: true,
          issues: [],
          reply_options: [
            { label: "Option 1", intent: "clarify", messages: ["A", "B"] },
            { label: "Option 2", intent: "guide", messages: ["A", "B"] },
            { label: "Option 3", intent: "close", messages: ["A", "B"] }
          ]
        },
        replyOptions: {
          reply_options: [
            { label: "Option 1", intent: "clarify", messages: ["A", "B"] },
            { label: "Option 2", intent: "guide", messages: ["A", "B"] },
            { label: "Option 3", intent: "close", messages: ["A", "B"] }
          ]
        },
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        timestamp: "2026-03-07T10:00:00.000Z"
      })
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(called, 1);
});

test("latest run retrieval maps response", async () => {
  const payload = await getLatestWhatsAppAgentRunSnapshot("11111111-1111-4111-8111-111111111111", {
    getLatestRun: async () => ({
      run: {
        id: "run-latest",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: "2026-03-07T10:00:10.000Z",
        createdAt: "2026-03-07T10:00:00.000Z"
      },
      steps: [
        {
          id: "s1",
          runId: "run-latest",
          stepName: "stage_detection",
          stepOrder: 1,
          status: "completed",
          provider: "claude",
          startedAt: "2026-03-07T10:00:00.000Z",
          finishedAt: "2026-03-07T10:00:01.000Z",
          outputJson: null,
          error: null,
          createdAt: "2026-03-07T10:00:00.000Z"
        }
      ]
    })
  });

  assert.equal(payload.run?.id, "run-latest");
  assert.equal(payload.steps.length, 1);
  assert.equal(payload.steps[0].provider, "claude");
});
