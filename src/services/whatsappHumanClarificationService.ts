import { getWhatsAppAgentLeadState, upsertWhatsAppAgentLeadState } from "../db/whatsappAgentRunsRepo.js";
import {
  answerWhatsAppHumanQuery,
  createWhatsAppHumanQuery,
  getOldestPendingWhatsAppHumanQuery
} from "../db/whatsappHumanQueriesRepo.js";
import { dispatchWhatsAppFollowUp } from "./whatsappChannelProvider.js";

export type HumanClarificationQuestion = {
  field: string;
  question: string;
};

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function queueHumanClarificationQuestions(input: {
  leadId: string;
  phoneNumber: string | null;
  questions: HumanClarificationQuestion[];
  context?: Record<string, unknown> | null;
}): Promise<{ created: number }> {
  const leadId = String(input.leadId || "").trim();
  if (!leadId) return { created: 0 };
  const phoneNumber = String(input.phoneNumber || "").trim();
  const baseContext = safeRecord(input.context);
  let created = 0;
  for (const row of input.questions || []) {
    const question = String(row && row.question ? row.question : "").trim();
    const field = String(row && row.field ? row.field : "").trim();
    if (!question) continue;
    await createWhatsAppHumanQuery({
      leadId,
      question,
      context: { ...baseContext, field }
    });
    created += 1;
    if (phoneNumber) {
      const text = `Clarification needed (${field || "field"}): ${question}`;
      void dispatchWhatsAppFollowUp("48h", {
        leadId,
        phoneNumber,
        text,
        metadata: {
          source: "human_clarification_agent",
          field
        }
      }).catch(() => {});
    }
  }
  return { created };
}

export async function applyInboundHumanClarificationAnswer(input: {
  leadId: string;
  messageText: string;
}): Promise<{ resumed: boolean; field: string | null; answer: string | null }> {
  const leadId = String(input.leadId || "").trim();
  const answer = String(input.messageText || "").trim();
  if (!leadId || !answer) return { resumed: false, field: null, answer: null };
  const pending = await getOldestPendingWhatsAppHumanQuery(leadId);
  if (!pending) return { resumed: false, field: null, answer: null };
  const answered = await answerWhatsAppHumanQuery({ queryId: pending.id, answer });
  if (!answered) return { resumed: false, field: null, answer: null };

  const field = String((answered.context && answered.context.field) || "").trim() || null;
  const state = await getWhatsAppAgentLeadState(leadId).catch(() => null);
  const structuredState = safeRecord(state?.structuredState);
  const humanClarifications = safeRecord(structuredState.humanClarifications);
  const updates = safeRecord(humanClarifications.updates);
  if (field) {
    updates[field] = answer;
  }
  const mergedStructuredState: Record<string, unknown> = {
    ...structuredState,
    humanClarifications: {
      ...humanClarifications,
      updates,
      lastAnsweredAt: new Date().toISOString()
    }
  };

  await upsertWhatsAppAgentLeadState({
    leadId,
    structuredState: mergedStructuredState,
    providers: {
      ...(state?.providers && typeof state.providers === "object" ? state.providers : {}),
      human_clarification_last_field: field,
      human_clarification_last_answered_at: new Date().toISOString()
    }
  }).catch(() => {});

  return { resumed: true, field, answer };
}
