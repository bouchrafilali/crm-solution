import { z } from "zod";
import {
  createWhatsAppOperatorEvent,
  type WhatsAppOperatorActionType,
  type WhatsAppOperatorEventInsert,
  type WhatsAppOperatorFeedType,
  type WhatsAppOperatorSurface
} from "../db/whatsappOperatorEventsRepo.js";

const operatorSurfaceSchema = z.enum(["priority_desk", "reactivation_queue", "mobile_lab", "chat"]);
const operatorFeedTypeSchema = z.enum(["active", "reactivation"]);
const operatorActionTypeSchema = z.enum([
  "feed_item_opened",
  "feed_item_skipped",
  "feed_item_unskipped",
  "reply_card_inserted",
  "reply_card_sent",
  "reply_card_dismissed",
  "reactivation_card_inserted",
  "reactivation_card_sent",
  "reactivation_card_dismissed"
]);
const operatorModeSchema = z.enum(["balanced", "active_first", "reactivation_first", "active_only", "reactivation_only"]);

export const whatsappOperatorEventPayloadSchema = z
  .object({
    leadId: z.string().uuid(),
    surface: operatorSurfaceSchema,
    feedType: operatorFeedTypeSchema.optional(),
    actionType: operatorActionTypeSchema,
    stage: z.string().trim().min(1).max(100).optional(),
    recommendedAction: z.string().trim().min(1).max(120).optional(),
    cardLabel: z.string().trim().min(1).max(120).optional(),
    cardIntent: z.string().trim().min(1).max(200).optional(),
    mode: operatorModeSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export type WhatsAppOperatorEventPayload = z.infer<typeof whatsappOperatorEventPayloadSchema>;

export class WhatsAppOperatorEventError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type OperatorEventDeps = {
  insertEvent: (input: WhatsAppOperatorEventInsert) => Promise<string>;
};

function defaultDeps(): OperatorEventDeps {
  return {
    insertEvent: (input) => createWhatsAppOperatorEvent(input)
  };
}

export function validateWhatsAppOperatorEventPayload(input: unknown): WhatsAppOperatorEventPayload {
  const parsed = whatsappOperatorEventPayloadSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    throw new WhatsAppOperatorEventError("operator_event_invalid_payload", issues || "Invalid operator event payload");
  }
  return parsed.data;
}

export async function trackWhatsAppOperatorEvent(
  input: unknown,
  depsOverride?: Partial<OperatorEventDeps>
): Promise<{ ok: true; eventId: string }> {
  const deps: OperatorEventDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const payload = validateWhatsAppOperatorEventPayload(input);
  const eventId = await deps.insertEvent({
    leadId: payload.leadId,
    surface: payload.surface as WhatsAppOperatorSurface,
    feedType: (payload.feedType ?? null) as WhatsAppOperatorFeedType | null,
    actionType: payload.actionType as WhatsAppOperatorActionType,
    stage: payload.stage ?? null,
    recommendedAction: payload.recommendedAction ?? null,
    cardLabel: payload.cardLabel ?? null,
    cardIntent: payload.cardIntent ?? null,
    mode: payload.mode ?? null,
    metadata: payload.metadata ?? null
  });
  if (!eventId) {
    throw new WhatsAppOperatorEventError("operator_event_persist_failed", "Failed to persist operator event");
  }
  return { ok: true, eventId };
}
