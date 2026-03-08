import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  getWhatsAppAgentRunSnapshotByRunId,
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
      getLeadState: async () => null,
      getRecentMessages: async () => [],
      createRun: async () => ({
        id: "run-1",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalEstimatedCostUsd: null,
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
          model: input.model ?? null,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          cachedInputTokens: input.cachedInputTokens ?? null,
          unitInputPricePerMillion: input.unitInputPricePerMillion ?? null,
          unitOutputPricePerMillion: input.unitOutputPricePerMillion ?? null,
          estimatedCostUsd: input.estimatedCostUsd ?? null,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          outputJson: input.outputJson ?? null,
          error: input.error ?? null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      upsertLeadState: async (input: any) => {
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
        totalInputTokens: null,
        totalOutputTokens: null,
        totalEstimatedCostUsd: null,
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
          model: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          unitInputPricePerMillion: null,
          unitOutputPricePerMillion: null,
          estimatedCostUsd: null,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          outputJson: null,
          error: input.error ?? null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      upsertLeadState: async (input: any) => ({
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

test("reply_generator quota failure finalizes run with partial costs", async () => {
  const steps: Array<{ stepName: string; status: string; error: string | null }> = [];
  let finalRunPayload: { status?: string; finishedAt?: string | null; totalInputTokens?: number | null; totalOutputTokens?: number | null; totalEstimatedCostUsd?: number | null } = {};

  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "99999999-9999-4999-8999-999999999999" },
    {
      createRun: async () => ({
        id: "run-quota",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "99999999-9999-4999-8999-999999999999",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalEstimatedCostUsd: null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      updateRun: async (input) => {
        finalRunPayload = {
          status: input.status,
          finishedAt: input.finishedAt ?? null,
          totalInputTokens: input.totalInputTokens,
          totalOutputTokens: input.totalOutputTokens,
          totalEstimatedCostUsd: input.totalEstimatedCostUsd
        };
      },
      updateStep: async (input) => {
        steps.push({
          stepName: input.stepName,
          status: input.status,
          error: input.error ?? null
        });
        return {
          id: `${input.stepName}-id`,
          runId: input.runId,
          stepName: input.stepName,
          stepOrder: input.stepOrder,
          status: input.status,
          provider: input.provider ?? null,
          model: input.model ?? null,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          cachedInputTokens: input.cachedInputTokens ?? null,
          unitInputPricePerMillion: input.unitInputPricePerMillion ?? null,
          unitOutputPricePerMillion: input.unitOutputPricePerMillion ?? null,
          estimatedCostUsd: input.estimatedCostUsd ?? null,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          outputJson: input.outputJson ?? null,
          error: input.error ?? null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      upsertLeadState: async (input: any) => ({
        leadId: input.leadId,
        latestRunId: input.latestRunId ?? null,
        latestMessageId: input.latestMessageId ?? null,
        stageAnalysis: input.stageAnalysis ?? null,
        facts: input.facts ?? null,
        structuredState: input.structuredState ?? null,
        priorityItem: input.priorityItem ?? null,
        strategy: input.strategy ?? null,
        replyOptions: input.replyOptions ?? null,
        brandReview: input.brandReview ?? null,
        topReplyCard: input.topReplyCard ?? null,
        providers: input.providers ?? null,
        reasoningSource: input.reasoningSource ?? null,
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
        model: "claude-haiku-4-5-20251001",
        usage: { inputTokens: 800, outputTokens: 80, cachedInputTokens: 0 },
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getMessages: async () => [{ direction: "IN", createdAt: "2026-03-07T09:50:00.000Z" }],
      getStrategicAdvisor: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        usage: { inputTokens: 300, outputTokens: 120, cachedInputTokens: 0 },
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getReplyGenerator: async () => {
        throw new Error("OpenAI 429 insufficient_quota for this request");
      }
    }
  );

  assert.equal(result.status, "partial");
  assert.equal(finalRunPayload.status, "partial");
  assert.ok(finalRunPayload.finishedAt && String(finalRunPayload.finishedAt).includes("T"));
  assert.equal(finalRunPayload.totalInputTokens, 1100);
  assert.equal(finalRunPayload.totalOutputTokens, 200);
  assert.ok(typeof finalRunPayload.totalEstimatedCostUsd === "number" && (finalRunPayload.totalEstimatedCostUsd as number) > 0);
  const failedReplyStep = steps.find((step) => step.stepName === "reply_generator" && step.status === "failed");
  assert.ok(failedReplyStep);
  assert.ok(String(failedReplyStep?.error || "").includes("provider_quota_exceeded"));
});

test("lead state write failure does not leave run running", async () => {
  let finalRunStatus = "";
  let finalFinishedAt = "";
  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    {
      getLeadState: async () => ({
        leadId: "11111111-1111-4111-8111-111111111111",
        latestRunId: "previous-successful-run",
        latestMessageId: "previous-message",
        stageAnalysis: makeStageAnalysis(),
        facts: null,
        structuredState: { stage: "QUALIFIED", lastStateUpdatedAt: "2026-03-07T09:00:00.000Z" },
        priorityItem: null,
        strategy: makeStrategy(),
        replyOptions: null,
        brandReview: null,
        topReplyCard: { label: "Previous Option" },
        providers: { strategic_advisor: "claude" },
        reasoningSource: "state_delta",
        createdAt: "2026-03-07T09:00:00.000Z",
        updatedAt: "2026-03-07T09:00:00.000Z"
      }),
      createRun: async () => ({
        id: "run-upsert-fail",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalEstimatedCostUsd: null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      updateRun: async (input) => {
        finalRunStatus = input.status;
        finalFinishedAt = String(input.finishedAt || "");
      },
      updateStep: async (input) => ({
        id: `${input.stepName}-id`,
        runId: input.runId,
        stepName: input.stepName,
        stepOrder: input.stepOrder,
        status: input.status,
        provider: input.provider ?? null,
        model: input.model ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        unitInputPricePerMillion: input.unitInputPricePerMillion ?? null,
        unitOutputPricePerMillion: input.unitOutputPricePerMillion ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        outputJson: input.outputJson ?? null,
        error: input.error ?? null,
        createdAt: "2026-03-07T10:00:00.000Z"
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
        throw new Error("OpenAI 429 insufficient_quota");
      },
      upsertLeadState: async () => {
        throw new Error("lead_state_write_failed");
      }
    }
  );

  assert.equal(result.status, "partial");
  assert.equal(finalRunStatus, "partial");
  assert.ok(finalFinishedAt.includes("T"));
});

test("mixed-provider run aggregates per-step and total costs safely", async () => {
  const completedSteps: Array<{
    stepName: string;
    estimatedCostUsd: number | null | undefined;
    inputTokens: number | null | undefined;
    outputTokens: number | null | undefined;
  }> = [];
  let finalRunPayload: { totalInputTokens?: number | null; totalOutputTokens?: number | null; totalEstimatedCostUsd?: number | null } = {};

  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "33333333-3333-4333-8333-333333333333" },
    {
      createRun: async () => ({
        id: "run-costs",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "33333333-3333-4333-8333-333333333333",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalEstimatedCostUsd: null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      updateRun: async (input) => {
        finalRunPayload = {
          totalInputTokens: input.totalInputTokens,
          totalOutputTokens: input.totalOutputTokens,
          totalEstimatedCostUsd: input.totalEstimatedCostUsd
        };
      },
      updateStep: async (input) => {
        if (input.status === "completed") {
          completedSteps.push({
            stepName: input.stepName,
            estimatedCostUsd: input.estimatedCostUsd,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens
          });
        }
        return {
          id: `${input.stepName}-id`,
          runId: input.runId,
          stepName: input.stepName,
          stepOrder: input.stepOrder,
          status: input.status,
          provider: input.provider ?? null,
          model: input.model ?? null,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          cachedInputTokens: input.cachedInputTokens ?? null,
          unitInputPricePerMillion: input.unitInputPricePerMillion ?? null,
          unitOutputPricePerMillion: input.unitOutputPricePerMillion ?? null,
          estimatedCostUsd: input.estimatedCostUsd ?? null,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          outputJson: input.outputJson ?? null,
          error: input.error ?? null,
          createdAt: "2026-03-07T10:00:00.000Z"
        };
      },
      upsertLeadState: async (input: any) => ({
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
        model: "claude-haiku-4-5-20251001",
        usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 },
        timestamp: "2026-03-07T10:00:00.000Z"
      }),
      getMessages: async () => [{ direction: "IN", createdAt: "2026-03-07T09:50:00.000Z" }],
      getStrategicAdvisor: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 40,
        messageCount: 1,
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        usage: null,
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
        usage: { inputTokens: 500, outputTokens: 200, cachedInputTokens: 0 },
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
        usage: { inputTokens: 250, outputTokens: 120, cachedInputTokens: 0 },
        timestamp: "2026-03-07T10:00:00.000Z"
      })
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(finalRunPayload.totalInputTokens, 1750);
  assert.equal(finalRunPayload.totalOutputTokens, 420);
  assert.equal(finalRunPayload.totalEstimatedCostUsd, 0.002312);

  const strategic = completedSteps.find((step) => step.stepName === "strategic_advisor");
  assert.ok(strategic);
  assert.equal(strategic?.estimatedCostUsd ?? null, null);

  const stage = completedSteps.find((step) => step.stepName === "stage_detection");
  assert.equal(stage?.inputTokens, 1000);
  assert.equal(stage?.outputTokens, 100);
  assert.equal(stage?.estimatedCostUsd, 0.0015);
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
          totalInputTokens: null,
          totalOutputTokens: null,
          totalEstimatedCostUsd: null,
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
        model: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        unitInputPricePerMillion: null,
        unitOutputPricePerMillion: null,
        estimatedCostUsd: null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        outputJson: null,
        error: input.error ?? null,
        createdAt: "2026-03-07T10:00:00.000Z"
      }),
      upsertLeadState: async (input: any) => ({
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
    getLeadState: async () => ({
      leadId: "11111111-1111-4111-8111-111111111111",
      latestRunId: "run-latest",
      latestMessageId: "22222222-2222-4222-8222-222222222222",
      stageAnalysis: null,
      facts: null,
      structuredState: null,
      priorityItem: null,
      strategy: null,
      replyOptions: null,
      brandReview: null,
      topReplyCard: null,
      providers: null,
      reasoningSource: "state_delta",
      createdAt: "2026-03-07T10:00:00.000Z",
      updatedAt: "2026-03-07T10:00:00.000Z"
    }),
    getLatestRun: async () => ({
      run: {
        id: "run-latest",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: "2026-03-07T10:00:10.000Z",
        totalInputTokens: 1200,
        totalOutputTokens: 320,
        totalEstimatedCostUsd: 0.0031,
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
          model: "claude-haiku-4-5-20251001",
          inputTokens: 900,
          outputTokens: 120,
          cachedInputTokens: 0,
          unitInputPricePerMillion: 1,
          unitOutputPricePerMillion: 5,
          estimatedCostUsd: 0.0015,
          startedAt: "2026-03-07T10:00:00.000Z",
          finishedAt: "2026-03-07T10:00:01.000Z",
          outputJson: { source: "state_delta" },
          error: null,
          createdAt: "2026-03-07T10:00:00.000Z"
        }
      ]
    })
  });

  assert.equal(payload.run?.id, "run-latest");
  assert.equal(payload.run?.totalInputTokens, 1200);
  assert.equal(payload.run?.totalEstimatedCostUsd, 0.0031);
  assert.equal(payload.run?.reasoningSource, "state_delta");
  assert.equal(payload.steps.length, 1);
  assert.equal(payload.steps[0].source, "state_delta");
  assert.equal(payload.steps[0].provider, "claude");
  assert.equal(payload.steps[0].model, "claude-haiku-4-5-20251001");
  assert.equal(payload.steps[0].estimatedCostUsd, 0.0015);
});

test("latest run retrieval keeps null cost/token metrics", async () => {
  const payload = await getLatestWhatsAppAgentRunSnapshot("11111111-1111-4111-8111-111111111111", {
    getLeadState: async () => null,
    getLatestRun: async () => ({
      run: {
        id: "run-null",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "running",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalEstimatedCostUsd: null,
        createdAt: "2026-03-07T10:00:00.000Z"
      },
      steps: [
        {
          id: "s-null",
          runId: "run-null",
          stepName: "reply_generator",
          stepOrder: 1,
          status: "running",
          provider: "claude",
          model: "claude-sonnet",
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          unitInputPricePerMillion: null,
          unitOutputPricePerMillion: null,
          estimatedCostUsd: null,
          startedAt: "2026-03-07T10:00:01.000Z",
          finishedAt: null,
          outputJson: null,
          error: null,
          createdAt: "2026-03-07T10:00:01.000Z"
        }
      ]
    })
  });

  assert.equal(payload.run?.totalInputTokens, null);
  assert.equal(payload.run?.totalOutputTokens, null);
  assert.equal(payload.run?.totalEstimatedCostUsd, null);
  assert.equal(payload.run?.reasoningSource, null);
  assert.equal(payload.steps[0].inputTokens, null);
  assert.equal(payload.steps[0].outputTokens, null);
  assert.equal(payload.steps[0].estimatedCostUsd, null);
});

test("run snapshot by runId maps response", async () => {
  const payload = await getWhatsAppAgentRunSnapshotByRunId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
    getRunById: async () => ({
      run: {
        id: "run-by-id",
        leadId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        startedAt: "2026-03-07T10:00:00.000Z",
        finishedAt: "2026-03-07T10:00:10.000Z",
        totalInputTokens: 1200,
        totalOutputTokens: 320,
        totalEstimatedCostUsd: 0.0031,
        createdAt: "2026-03-07T10:00:00.000Z"
      },
      steps: [
        {
          id: "s1",
          runId: "run-by-id",
          stepName: "stage_detection",
          stepOrder: 1,
          status: "completed",
          provider: "claude",
          model: "claude-haiku-4-5-20251001",
          inputTokens: 900,
          outputTokens: 120,
          cachedInputTokens: 0,
          unitInputPricePerMillion: 1,
          unitOutputPricePerMillion: 5,
          estimatedCostUsd: 0.0015,
          startedAt: "2026-03-07T10:00:00.000Z",
          finishedAt: "2026-03-07T10:00:01.000Z",
          outputJson: null,
          error: null,
          createdAt: "2026-03-07T10:00:00.000Z"
        }
      ]
    })
  });

  assert.equal(payload.run?.id, "run-by-id");
  assert.equal(payload.run?.totalEstimatedCostUsd, 0.0031);
  assert.equal(payload.steps[0].stepName, "stage_detection");
  assert.equal(payload.steps[0].estimatedCostUsd, 0.0015);
});

function stateDeltaBaseDeps(overrides?: Record<string, unknown>) {
  return {
    createRun: async () => ({
      id: "run-state",
      leadId: "11111111-1111-4111-8111-111111111111",
      messageId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      startedAt: "2026-03-07T10:00:00.000Z",
      finishedAt: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalEstimatedCostUsd: null,
      createdAt: "2026-03-07T10:00:00.000Z"
    }),
    updateRun: async () => {},
    updateStep: async (input: any) => ({
      id: `${input.stepName}-id`,
      runId: input.runId,
      stepName: input.stepName,
      stepOrder: input.stepOrder,
      status: input.status,
      provider: input.provider ?? null,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cachedInputTokens: input.cachedInputTokens ?? null,
      unitInputPricePerMillion: input.unitInputPricePerMillion ?? null,
      unitOutputPricePerMillion: input.unitOutputPricePerMillion ?? null,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      outputJson: input.outputJson ?? null,
      error: input.error ?? null,
      createdAt: "2026-03-07T10:00:00.000Z"
    }),
    getMessages: async () => [{ direction: "IN", createdAt: "2026-03-07T09:50:00.000Z" }],
    getReplyGenerator: async () => ({
      replyOptions: { reply_options: [{ label: "Option 1", intent: "clarify", messages: ["A", "B"] }, { label: "Option 2", intent: "guide", messages: ["A", "B"] }, { label: "Option 3", intent: "close", messages: ["A", "B"] }] },
      strategy: makeStrategy(),
      stageAnalysis: makeStageAnalysis(),
      transcriptLength: 40,
      messageCount: 1,
      provider: "openai",
      model: "gpt-4.1-mini",
      timestamp: "2026-03-07T10:00:00.000Z"
    }),
    getBrandGuardian: async () => ({
      review: { approved: true, issues: [], reply_options: [{ label: "Option 1", intent: "clarify", messages: ["A", "B"] }, { label: "Option 2", intent: "guide", messages: ["A", "B"] }, { label: "Option 3", intent: "close", messages: ["A", "B"] }] },
      replyOptions: { reply_options: [{ label: "Option 1", intent: "clarify", messages: ["A", "B"] }, { label: "Option 2", intent: "guide", messages: ["A", "B"] }, { label: "Option 3", intent: "close", messages: ["A", "B"] }] },
      strategy: makeStrategy(),
      stageAnalysis: makeStageAnalysis(),
      transcriptLength: 40,
      messageCount: 1,
      provider: "openai",
      model: "gpt-4.1-mini",
      timestamp: "2026-03-07T10:00:00.000Z"
    }),
    upsertLeadState: async (input: any) => ({
      leadId: input.leadId,
      latestRunId: input.latestRunId ?? null,
      latestMessageId: input.latestMessageId ?? null,
      stageAnalysis: input.stageAnalysis ?? null,
      facts: input.facts ?? null,
      structuredState: input.structuredState ?? null,
      priorityItem: input.priorityItem ?? null,
      strategy: input.strategy ?? null,
      replyOptions: input.replyOptions ?? null,
      brandReview: input.brandReview ?? null,
      topReplyCard: input.topReplyCard ?? null,
      providers: input.providers ?? null,
      reasoningSource: input.reasoningSource ?? null,
      createdAt: "2026-03-07T10:00:00.000Z",
      updatedAt: "2026-03-07T10:00:00.000Z"
    }),
    ...(overrides || {})
  } as any;
}

test("first run uses transcript fallback", async () => {
  let transcriptCalls = 0;
  let deltaCalls = 0;
  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222" },
    stateDeltaBaseDeps({
      getLeadState: async () => null,
      getRecentMessages: async () => [{ id: "m-1", direction: "IN", createdAt: "2026-03-07T10:00:00.000Z", text: "hi", metadata: null }],
      getTranscript: async () => {
        transcriptCalls += 1;
        return { transcript: "[2026-03-07 10:00] CLIENT: hi", messageCount: 1, transcriptLength: 40 };
      },
      detectStage: async () => {
        return { analysis: makeStageAnalysis(), transcriptLength: 40, messageCount: 1, source: "transcript_fallback", provider: "claude", model: "claude", timestamp: "2026-03-07T10:00:00.000Z" };
      },
      detectStageFromDelta: async () => {
        deltaCalls += 1;
        return { analysis: makeStageAnalysis(), transcriptLength: 20, messageCount: 1, source: "state_delta", provider: "claude", model: "claude", timestamp: "2026-03-07T10:00:00.000Z" };
      }
    })
  );
  assert.equal(result.reasoningSource, "transcript_fallback");
  assert.equal(transcriptCalls, 1);
  assert.equal(deltaCalls, 0);
});

test("missing state safely falls back", async () => {
  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222" },
    stateDeltaBaseDeps({
      getLeadState: async () => null,
      getRecentMessages: async () => [{ id: "m-1", direction: "IN", createdAt: "2026-03-07T10:00:00.000Z", text: "hello", metadata: null }],
      getTranscript: async () => ({ transcript: "[2026-03-07 10:00] CLIENT: hello", messageCount: 1, transcriptLength: 45 }),
      detectStage: async () => ({ analysis: makeStageAnalysis(), transcriptLength: 45, messageCount: 1, source: "transcript_fallback", provider: "claude", model: "claude", timestamp: "2026-03-07T10:00:00.000Z" })
    })
  );

  assert.equal(result.reasoningSource, "transcript_fallback");
});

test("repeated unchanged conversation reuses state and avoids full transcript", async () => {
  let transcriptCalls = 0;
  let deltaCalls = 0;
  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222" },
    stateDeltaBaseDeps({
      getLeadState: async () => ({
        leadId: "lead-1",
        latestRunId: "run-prev",
        latestMessageId: "m-1",
        stageAnalysis: null,
        facts: null,
        structuredState: { stage: "QUALIFIED", lastMeaningfulInboundMessageId: "m-1", lastMeaningfulOutboundMessageId: null, lastStateUpdatedAt: "2026-03-07T10:00:00.000Z" },
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: null,
        providers: null,
        reasoningSource: "state_delta",
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z"
      }),
      getRecentMessages: async () => [{ id: "m-1", direction: "IN", createdAt: "2026-03-07T10:00:00.000Z", text: "hi", metadata: null }],
      getTranscript: async () => {
        transcriptCalls += 1;
        return { transcript: "[2026-03-07 10:00] CLIENT: hi", messageCount: 1, transcriptLength: 40 };
      },
      detectStageFromDelta: async () => {
        deltaCalls += 1;
        return { analysis: makeStageAnalysis(), transcriptLength: 20, messageCount: 1, source: "state_delta", provider: "claude", model: "claude", timestamp: "2026-03-07T10:00:00.000Z" };
      },
      getStrategicAdvisorFromDelta: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 20,
        messageCount: 1,
        source: "state_delta",
        provider: "claude",
        model: "claude",
        timestamp: "2026-03-07T10:00:00.000Z"
      })
    })
  );
  assert.equal(result.reasoningSource, "state_delta");
  assert.equal(transcriptCalls, 0);
  assert.equal(deltaCalls, 1);
});

test("new inbound message uses delta update path", async () => {
  let deltaCalls = 0;
  const result = await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "33333333-3333-4333-8333-333333333333" },
    stateDeltaBaseDeps({
      getLeadState: async () => ({
        leadId: "lead-1",
        latestRunId: "run-prev",
        latestMessageId: "m-old",
        stageAnalysis: null,
        facts: null,
        structuredState: { stage: "QUALIFIED", lastMeaningfulInboundMessageId: "m-old", lastMeaningfulOutboundMessageId: null, lastStateUpdatedAt: "2026-03-07T10:00:00.000Z" },
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: null,
        providers: null,
        reasoningSource: "state_delta",
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z"
      }),
      getRecentMessages: async () => [{ id: "m-new", direction: "IN", createdAt: "2026-03-07T10:30:00.000Z", text: "can I get this in blue?", metadata: null }],
      detectStageFromDelta: async () => {
        deltaCalls += 1;
        return { analysis: makeStageAnalysis(), transcriptLength: 80, messageCount: 1, source: "state_delta", provider: "claude", model: "claude", timestamp: "2026-03-07T10:30:00.000Z" };
      },
      getStrategicAdvisorFromDelta: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 80,
        messageCount: 1,
        source: "state_delta",
        provider: "claude",
        model: "claude",
        timestamp: "2026-03-07T10:30:00.000Z"
      })
    })
  );
  assert.equal(result.reasoningSource, "state_delta");
  assert.equal(deltaCalls, 1);
});

test("state persistence updates include structured state and source metadata", async () => {
  let persisted: Record<string, unknown> | null = null;
  await runWhatsAppAgentOrchestrator(
    { leadId: "11111111-1111-4111-8111-111111111111", messageId: "44444444-4444-4444-8444-444444444444" },
    stateDeltaBaseDeps({
      getLeadState: async () => ({
        leadId: "lead-1",
        latestRunId: "run-prev",
        latestMessageId: "m-prev",
        stageAnalysis: null,
        facts: null,
        structuredState: { stage: "QUALIFIED", lastMeaningfulInboundMessageId: "m-prev", lastMeaningfulOutboundMessageId: null, lastStateUpdatedAt: "2026-03-07T10:00:00.000Z" },
        priorityItem: null,
        strategy: null,
        replyOptions: null,
        brandReview: null,
        topReplyCard: null,
        providers: null,
        reasoningSource: "state_delta",
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z"
      }),
      getRecentMessages: async () => [{ id: "m-new", direction: "IN", createdAt: "2026-03-07T10:40:00.000Z", text: "need it this week", metadata: null }],
      upsertLeadState: async (input: any) => {
        persisted = input as unknown as Record<string, unknown>;
        return {
          leadId: input.leadId,
          latestRunId: input.latestRunId ?? null,
          latestMessageId: input.latestMessageId ?? null,
          stageAnalysis: input.stageAnalysis ?? null,
          facts: input.facts ?? null,
          structuredState: input.structuredState ?? null,
          priorityItem: input.priorityItem ?? null,
          strategy: input.strategy ?? null,
          replyOptions: input.replyOptions ?? null,
          brandReview: input.brandReview ?? null,
          topReplyCard: input.topReplyCard ?? null,
          providers: input.providers ?? null,
          reasoningSource: input.reasoningSource ?? null,
          createdAt: "2026-03-07T10:40:00.000Z",
          updatedAt: "2026-03-07T10:40:00.000Z"
        };
      },
      detectStageFromDelta: async () => {
        return { analysis: makeStageAnalysis(), transcriptLength: 80, messageCount: 1, source: "state_delta", provider: "claude", model: "claude", timestamp: "2026-03-07T10:40:00.000Z" };
      },
      getStrategicAdvisorFromDelta: async () => ({
        strategy: makeStrategy(),
        stageAnalysis: makeStageAnalysis(),
        transcriptLength: 80,
        messageCount: 1,
        source: "state_delta",
        provider: "claude",
        model: "claude",
        timestamp: "2026-03-07T10:40:00.000Z"
      })
    })
  );

  const persistedRow = persisted as Record<string, unknown> | null;
  assert.ok(persistedRow && typeof persistedRow.structuredState === "object");
  assert.equal(String((persistedRow as Record<string, unknown>).reasoningSource || ""), "state_delta");
});
