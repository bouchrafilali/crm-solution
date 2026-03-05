import {
  listWhatsAppFollowUpCandidates,
  markWhatsAppFollowUpSent,
  type WhatsAppFollowUpCandidate,
  type WhatsAppFollowUpKind
} from "../db/whatsappLeadsRepo.js";
import { isDbEnabled } from "../db/client.js";
import { dispatchWhatsAppFollowUp } from "./whatsappChannelProvider.js";
import { generateFollowUpMessage } from "./whatsappIntelligenceAi.js";

async function processCandidate(lead: WhatsAppFollowUpCandidate, kind: WhatsAppFollowUpKind): Promise<void> {
  const generated = await generateFollowUpMessage(lead, kind);
  const dispatch = await dispatchWhatsAppFollowUp(kind, {
    leadId: lead.id,
    phoneNumber: lead.phoneNumber,
    shop: lead.shop,
    text: generated.text,
    metadata: {
      ai_provider: generated.provider,
      ai_model: generated.model,
      prompt_key: generated.promptKey
    }
  });

  if (!dispatch.ok) {
    console.warn(`[whatsapp] follow-up ${kind} failed for ${lead.id}: ${dispatch.error || "unknown error"}`);
    return;
  }

  await markWhatsAppFollowUpSent(lead.id, kind, {
    outbound_text: generated.text,
    ai_provider: generated.provider,
    ai_model: generated.model,
    prompt_key: generated.promptKey,
    channel_provider: dispatch.provider,
    provider_message_id: dispatch.messageId || null,
    provider_payload: dispatch.payload || null,
    sent_at: new Date().toISOString()
  });
}

export async function runWhatsAppIntelligenceTick(): Promise<void> {
  const due72 = await listWhatsAppFollowUpCandidates("72h", { limit: 300 });
  for (const lead of due72) {
    await processCandidate(lead, "72h");
  }

  const due48 = await listWhatsAppFollowUpCandidates("48h", { limit: 300 });
  for (const lead of due48) {
    await processCandidate(lead, "48h");
  }
}

let workerStarted = false;

export function startWhatsAppIntelligenceWorker(): void {
  if (workerStarted) return;
  if (!isDbEnabled()) return;
  workerStarted = true;
  const intervalMs = 60 * 60 * 1000;

  void runWhatsAppIntelligenceTick().catch((error) => {
    console.error("[whatsapp] intelligence tick failed at startup", error);
  });

  setInterval(() => {
    void runWhatsAppIntelligenceTick().catch((error) => {
      console.error("[whatsapp] intelligence tick failed", error);
    });
  }, intervalMs);

  console.log("[whatsapp] intelligence worker started (every 60 minutes)");
}
