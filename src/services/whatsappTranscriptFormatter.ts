import { listWhatsAppLeadMessages, type WhatsAppLeadMessage } from "../db/whatsappLeadsRepo.js";

const DEFAULT_MESSAGE_LIMIT = 30;

type TranscriptSpeaker = "CLIENT" | "BFL";

export type LeadTranscriptResult = {
  transcript: string;
  messageCount: number;
  transcriptLength: number;
};

function toTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    const raw = String(value || "").trim();
    const direct = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (direct) return `${direct[1]} ${direct[2]}`;
    return "0000-00-00 00:00";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getSpeaker(direction: WhatsAppLeadMessage["direction"]): TranscriptSpeaker {
  return direction === "IN" ? "CLIENT" : "BFL";
}

function isTextMessage(message: Pick<WhatsAppLeadMessage, "messageType">): boolean {
  const type = String(message.messageType || "").trim().toLowerCase();
  return !type || type === "text";
}

function compareChronological(a: Pick<WhatsAppLeadMessage, "createdAt">, b: Pick<WhatsAppLeadMessage, "createdAt">): number {
  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
    return aTime - bTime;
  }
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

export function formatLeadTranscript(messages: WhatsAppLeadMessage[]): LeadTranscriptResult {
  const lines = messages
    .slice()
    .sort(compareChronological)
    .filter((message) => isTextMessage(message))
    .map((message) => ({
      createdAt: toTimestamp(message.createdAt),
      speaker: getSpeaker(message.direction),
      text: String(message.text || "").trim()
    }))
    .filter((message) => message.text.length > 0)
    .map((message) => `[${message.createdAt}] ${message.speaker}: ${message.text}`);

  const transcript = lines.join("\n");
  return {
    transcript,
    messageCount: lines.length,
    transcriptLength: transcript.length
  };
}

export async function buildLeadTranscript(leadId: string, messageLimit = DEFAULT_MESSAGE_LIMIT): Promise<LeadTranscriptResult> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new Error("lead_id_required");
  }

  const limit = Math.max(1, Math.min(100, Math.round(Number(messageLimit || DEFAULT_MESSAGE_LIMIT))));
  const messages = await listWhatsAppLeadMessages(safeLeadId, { limit, order: "asc" });
  return formatLeadTranscript(messages);
}
