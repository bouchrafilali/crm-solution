import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatLeadTranscript } from "./whatsappTranscriptFormatter.js";
import type { WhatsAppLeadMessage } from "../db/whatsappLeadsRepo.js";

function msg(input: Partial<WhatsAppLeadMessage> & Pick<WhatsAppLeadMessage, "id" | "leadId" | "direction" | "createdAt">): WhatsAppLeadMessage {
  return {
    id: input.id,
    leadId: input.leadId,
    direction: input.direction,
    text: input.text ?? "",
    provider: input.provider ?? "manual",
    messageType: input.messageType ?? "text",
    templateName: input.templateName ?? null,
    externalId: input.externalId ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt,
    replyTo: input.replyTo ?? null
  };
}

test("formatLeadTranscript keeps last messages chronological and labels speakers", () => {
  const result = formatLeadTranscript([
    msg({
      id: "2",
      leadId: "lead-1",
      direction: "OUT",
      createdAt: "2026-03-01T10:05:00.000Z",
      text: "Bonjour, with pleasure."
    }),
    msg({
      id: "1",
      leadId: "lead-1",
      direction: "IN",
      createdAt: "2026-03-01T10:00:00.000Z",
      text: "How much is this kaftan?"
    })
  ]);

  assert.equal(
    result.transcript,
    "[2026-03-01 10:00] CLIENT: How much is this kaftan?\n[2026-03-01 10:05] BFL: Bonjour, with pleasure."
  );
  assert.equal(result.messageCount, 2);
  assert.equal(result.transcriptLength, result.transcript.length);
});

test("formatLeadTranscript ignores empty and non-text messages", () => {
  const result = formatLeadTranscript([
    msg({
      id: "1",
      leadId: "lead-1",
      direction: "IN",
      createdAt: "2026-03-01T10:00:00.000Z",
      text: "   "
    }),
    msg({
      id: "2",
      leadId: "lead-1",
      direction: "IN",
      createdAt: "2026-03-01T10:01:00.000Z",
      text: "Photo attached",
      messageType: "image"
    }),
    msg({
      id: "3",
      leadId: "lead-1",
      direction: "OUT",
      createdAt: "2026-03-01T10:02:00.000Z",
      text: "Thank you for your message."
    })
  ]);

  assert.equal(result.transcript, "[2026-03-01 10:02] BFL: Thank you for your message.");
  assert.equal(result.messageCount, 1);
});
