import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  computeLearningLoopStats,
  createCanonicalSuggestionRecord,
  deriveOutcomeStatus,
  trackOperatorReplyDecision
} from "./operatorLearningLoopService.js";

function makeDeps() {
  const calls: {
    drafts: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    signals: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
    stats: Array<Record<string, unknown>>;
  } = {
    drafts: [],
    actions: [],
    signals: [],
    events: [],
    stats: []
  };

  const deps = {
    createSuggestionFeedbackDraft: async (input: Record<string, unknown>) => {
      calls.drafts.push(input);
      return "suggestion-1";
    },
    getLearningLoopStats: async (input: Record<string, unknown>) => {
      calls.stats.push(input);
      return { ok: true, bySuggestionType: [] };
    },
    getSuggestionFeedbackById: async () =>
      ({
        id: "suggestion-1",
        leadId: "lead-1",
        conversationId: "conv-1",
        operatorId: null,
        source: "ai_draft",
        suggestionStatus: "GENERATED",
        suggestionType: "REPLY",
        suggestionText: "Bonjour, voici la proposition.",
        suggestionPayload: null,
        stageBeforeReply: "QUALIFIED",
        stageAfterReply: null,
        accepted: null,
        finalHumanText: null,
        sendMessageId: null,
        generatedAt: new Date().toISOString(),
        actedAt: null,
        outcomeLabel: null,
        outcomeStatus: null,
        outcomeAt: null,
        outcomeEvaluatedAt: null,
        reviewStatus: "OPEN",
        reviewNotes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }) as any,
    markSuggestionAction: async (input: Record<string, unknown>) => {
      calls.actions.push(input);
      return true;
    },
    markSuggestionOutcome: async () => true,
    upsertSuggestionLearningSignal: async (input: Record<string, unknown>) => {
      calls.signals.push(input);
      return;
    },
    createMlEvent: async (input: Record<string, unknown>) => {
      calls.events.push(input);
      return;
    },
    getDbPool: () => null,
    isDbEnabled: () => false
  };

  return { deps: deps as any, calls };
}

test("canonical suggestion record emits generated event", async () => {
  const { deps, calls } = makeDeps();
  const id = await createCanonicalSuggestionRecord(
    {
      leadId: "lead-1",
      conversationId: "conv-1",
      source: "ai_draft",
      suggestionType: "REPLY",
      suggestionText: "Bonjour",
      stageBeforeReply: "QUALIFIED"
    },
    deps
  );

  assert.equal(id, "suggestion-1");
  assert.equal(calls.drafts.length, 1);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].eventType, "SUGGESTION_GENERATED");
});

test("exact operator send marks suggestion as ACCEPTED", async () => {
  const { deps, calls } = makeDeps();
  const result = await trackOperatorReplyDecision(
    {
      leadId: "lead-1",
      conversationId: "conv-1",
      suggestionFeedback: {
        id: "suggestion-1",
        suggested_text: "Bonjour, voici la proposition."
      },
      finalText: "Bonjour, voici la proposition.",
      sendMessageId: "msg-1"
    },
    deps
  );

  assert.equal(result.decisionType, "ACCEPTED");
  assert.equal(calls.actions[0].suggestionStatus, "ACCEPTED");
  assert.equal(calls.signals.length, 1);
});

test("edited operator send marks suggestion as EDITED and stores final text", async () => {
  const { deps, calls } = makeDeps();
  const result = await trackOperatorReplyDecision(
    {
      leadId: "lead-1",
      conversationId: "conv-1",
      suggestionFeedback: { id: "suggestion-1" },
      finalText: "Bonjour, voici une version plus courte ?",
      sendMessageId: "msg-2"
    },
    deps
  );

  assert.equal(result.decisionType, "EDITED");
  assert.equal(calls.actions[0].suggestionStatus, "EDITED");
  assert.equal(calls.actions[0].finalHumanText, "Bonjour, voici une version plus courte ?");
});

test("manual replacement with suggestion id marks suggestion as REJECTED", async () => {
  const { deps, calls } = makeDeps();
  const result = await trackOperatorReplyDecision(
    {
      leadId: "lead-1",
      conversationId: "conv-1",
      suggestionFeedback: {
        id: "suggestion-1",
        decision_type: "MANUAL"
      },
      finalText: "Message manuel totalement différent.",
      sendMessageId: "msg-3"
    },
    deps
  );

  assert.equal(result.decisionType, "REJECTED");
  assert.equal(calls.actions[0].suggestionStatus, "REJECTED");
});

test("outbound send without suggestion id logs MANUAL operator action", async () => {
  const { deps, calls } = makeDeps();
  const result = await trackOperatorReplyDecision(
    {
      leadId: "lead-1",
      conversationId: "conv-1",
      finalText: "Message manuel sans suggestion",
      sendMessageId: "msg-4"
    },
    deps
  );

  assert.equal(result.decisionType, "MANUAL");
  assert.equal(calls.actions.length, 0);
  assert.equal(calls.events[0].eventType, "MANUAL_REPLY_SENT");
});

test("outcome attribution rules cover inbound reply and stage progression", () => {
  const replied = deriveOutcomeStatus({
    leadOutcome: null,
    hasDepositSignal: false,
    movedUp: false,
    hasInboundAfterReply: true,
    hoursSinceReply: 25
  });
  assert.equal(replied, "CLIENT_REPLIED");

  const moved = deriveOutcomeStatus({
    leadOutcome: null,
    hasDepositSignal: false,
    movedUp: true,
    hasInboundAfterReply: false,
    hoursSinceReply: 30
  });
  assert.equal(moved, "STAGE_ADVANCED");
});

test("learning-loop stats endpoint remains backed by repository stats", async () => {
  const { deps, calls } = makeDeps();
  const result = await computeLearningLoopStats({ days: 14, suggestionType: "REPLY" }, deps);
  assert.deepEqual(result, { ok: true, bySuggestionType: [] });
  assert.equal(calls.stats.length, 1);
  assert.equal(calls.stats[0].days, 14);
  assert.equal(calls.stats[0].suggestionType, "REPLY");
});
