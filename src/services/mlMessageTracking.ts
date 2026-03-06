import { createMlEvent } from "../db/mlRepo.js";
import {
  createWhatsAppLeadMessage,
  type WhatsAppDirection,
  type WhatsAppLeadMessage
} from "../db/whatsappLeadsRepo.js";
import { computeConversionScore } from "./conversionScore.js";
import { runAuto24hFollowupRuleForLead } from "./autoFollowUpRule.js";
import { applyDetectedPriceForLeadMessage, inferTicketValueForLead } from "./ticketValueInference.js";
import { recomputeLeadSla } from "./slaPrioritization.js";
import { onMessagePersisted as onMessagePersistedAdvisor } from "./onMessagePersisted.js";
import { runDynamicDecisionShadowForMessage } from "./dynamicDecisionShadow.js";

export type MessageTrackingSource =
  | "INBOUND"
  | "OUTBOUND_MANUAL"
  | "OUTBOUND_TEMPLATE"
  | "OUTBOUND_SUGGESTION";

export type MessageTrackingMeta = {
  source: MessageTrackingSource;
  ui_source?: string | null;
  template_key?: string | null;
};

function hasNegativeSentimentKeyword(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return ["refund", "bad", "angry", "complaint", "not happy"].some((keyword) => normalized.includes(keyword));
}

export async function onMessagePersisted(
  leadId: string,
  message: WhatsAppLeadMessage,
  meta: MessageTrackingMeta
): Promise<void> {
  const metadata =
    message && message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : {};

  await createMlEvent({
    eventType: "MESSAGE_PERSISTED",
    leadId: leadId || null,
    source: meta.source,
    payload: {
      messageId: String(message.id || ""),
      textLength: String(message.text || "").length,
      ui_source: meta.ui_source ? String(meta.ui_source) : null,
      ...(meta.template_key ? { template_key: String(meta.template_key) } : {})
    }
  });

  if (meta.source === "INBOUND" && hasNegativeSentimentKeyword(message.text)) {
    await createMlEvent({
      eventType: "RULE_TRIGGERED",
      leadId: leadId || null,
      source: "INBOUND",
      payload: {
        category: "RISK_ALERT",
        ruleKey: "risk_negative_sentiment",
        messageId: String(message.id || ""),
        keywordMatch: true
      }
    });
  }

  if (metadata.synthetic === true) {
    return;
  }

  await applyDetectedPriceForLeadMessage({
    leadId: leadId || "",
    messageId: String(message.id || ""),
    text: String(message.text || ""),
    metadata: message.metadata || null,
    createdAt: message.createdAt,
    emitEvent: true
  });
}

export async function createWhatsAppLeadMessageWithTracking(
  input: {
    leadId: string;
    direction: WhatsAppDirection;
    text: string;
    createdAt?: string;
    provider?: string;
    messageType?: string;
    templateName?: string | null;
    externalId?: string | null;
    externalMessageId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  meta: MessageTrackingMeta
): Promise<WhatsAppLeadMessage | null> {
  const message = await createWhatsAppLeadMessage(input);
  if (!message) return null;

  // Non-blocking Claude advisor analysis hook (inbound + outbound).
  onMessagePersistedAdvisor(input.leadId, message.id);
  setImmediate(() => {
    void runDynamicDecisionShadowForMessage({
      leadId: input.leadId,
      messageId: message.id,
      source: meta.source,
      triggerSource: "message_persisted"
    }).catch((error) => {
      console.warn("[dynamic-decision-shadow] evaluate failed", {
        leadId: input.leadId,
        messageId: message.id,
        source: meta.source,
        error
      });
    });
  });

  try {
    await onMessagePersisted(input.leadId, message, meta);
  } catch (error) {
    console.warn("[ml-tracking] onMessagePersisted failed", {
      leadId: input.leadId,
      messageId: message.id,
      source: meta.source,
      error
    });
  }
  try {
    await computeConversionScore(input.leadId);
  } catch (error) {
    console.warn("[conversion-score] recompute after message failed", {
      leadId: input.leadId,
      messageId: message.id,
      error
    });
  }
  try {
    await inferTicketValueForLead(input.leadId, { emitEvent: false });
  } catch (error) {
    console.warn("[ticket-value] recompute after message failed", {
      leadId: input.leadId,
      messageId: message.id,
      error
    });
  }
  try {
    await recomputeLeadSla(input.leadId);
  } catch (error) {
    console.warn("[sla] recompute after message failed", {
      leadId: input.leadId,
      messageId: message.id,
      error
    });
  }
  try {
    await runAuto24hFollowupRuleForLead(input.leadId);
  } catch (error) {
    console.warn("[followup-rule] run after message failed", {
      leadId: input.leadId,
      messageId: message.id,
      error
    });
  }
  return message;
}

export async function logSuggestionUsed(input: {
  leadId: string;
  messageId: string;
  suggestionKey?: string | null;
  ui_source?: string | null;
  template_key?: string | null;
}): Promise<void> {
  await createMlEvent({
    eventType: "SUGGESTION_USED",
    leadId: input.leadId || null,
    source: "OUTBOUND_SUGGESTION",
    payload: {
      messageId: String(input.messageId || ""),
      leadId: String(input.leadId || ""),
      suggestionKey: input.suggestionKey ? String(input.suggestionKey) : null,
      ui_source: input.ui_source ? String(input.ui_source) : null,
      ...(input.template_key ? { template_key: String(input.template_key) } : {})
    }
  });
}
