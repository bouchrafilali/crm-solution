import { env } from "../config/env.js";
import { runClaudeAdvisor } from "./claudeAdvisor.js";

function isAiAutoAnalyzeEnabled(): boolean {
  const raw = String(env.WHATSAPP_LEGACY_ADVISOR_AUTO_ANALYZE || "false").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function onMessagePersisted(leadId: string, messageId: string, triggerSource = "message_persisted"): void {
  if (!isAiAutoAnalyzeEnabled()) {
    console.info("[on-message-persisted] legacy_claude_skipped_auto_disabled", {
      leadId: String(leadId || "").trim(),
      messageId: String(messageId || "").trim(),
      triggerSource: String(triggerSource || "message_persisted")
    });
    return;
  }
  if (!String(env.CLAUDE_API_KEY || "").trim()) {
    return;
  }
  const safeLeadId = String(leadId || "").trim();
  const safeMessageId = String(messageId || "").trim();
  if (!safeLeadId || !safeMessageId) {
    console.warn("[on-message-persisted] skipped_invalid_input", { leadId: safeLeadId, messageId: safeMessageId });
    return;
  }

  setImmediate(() => {
    void runClaudeAdvisor({
      leadId: safeLeadId,
      messageId: safeMessageId,
      triggerSource: String(triggerSource || "message_persisted"),
      messageLimit: 20
    }).catch((error) => {
      console.error("[on-message-persisted] claude_advisor_unhandled_error", {
        leadId: safeLeadId,
        messageId: safeMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}
