import { getDbPool } from "./client.js";

export type WhatsAppOperatorSurface = "priority_desk" | "reactivation_queue" | "mobile_lab" | "chat";
export type WhatsAppOperatorFeedType = "active" | "reactivation";
export type WhatsAppOperatorActionType =
  | "feed_item_opened"
  | "feed_item_skipped"
  | "feed_item_unskipped"
  | "reply_card_inserted"
  | "reply_card_sent"
  | "reply_card_dismissed"
  | "reactivation_card_inserted"
  | "reactivation_card_sent"
  | "reactivation_card_dismissed";

export type WhatsAppOperatorEventInsert = {
  leadId: string;
  surface: WhatsAppOperatorSurface;
  feedType?: WhatsAppOperatorFeedType | null;
  actionType: WhatsAppOperatorActionType;
  stage?: string | null;
  recommendedAction?: string | null;
  cardLabel?: string | null;
  cardIntent?: string | null;
  mode?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type WhatsAppOperatorEventRow = {
  id: string;
  leadId: string;
  surface: WhatsAppOperatorSurface;
  feedType: WhatsAppOperatorFeedType | null;
  actionType: WhatsAppOperatorActionType;
  stage: string | null;
  recommendedAction: string | null;
  cardLabel: string | null;
  cardIntent: string | null;
  mode: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

export async function createWhatsAppOperatorEvent(input: WhatsAppOperatorEventInsert): Promise<string> {
  const db = getPoolOrThrow();
  const q = await db.query<{ id: string }>(
    `
      insert into whatsapp_operator_events (
        lead_id,
        surface,
        feed_type,
        action_type,
        stage,
        recommended_action,
        card_label,
        card_intent,
        mode,
        metadata
      )
      values (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        nullif(trim($5::text), ''),
        nullif(trim($6::text), ''),
        nullif(trim($7::text), ''),
        nullif(trim($8::text), ''),
        nullif(trim($9::text), ''),
        $10::jsonb
      )
      returning id
    `,
    [
      input.leadId,
      input.surface,
      input.feedType ?? null,
      input.actionType,
      input.stage ?? null,
      input.recommendedAction ?? null,
      input.cardLabel ?? null,
      input.cardIntent ?? null,
      input.mode ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ]
  );
  return String(q.rows[0]?.id || "");
}

export async function listWhatsAppOperatorEventsByRange(input: {
  from: string;
  to: string;
}): Promise<WhatsAppOperatorEventRow[]> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    lead_id: string;
    surface: WhatsAppOperatorSurface;
    feed_type: WhatsAppOperatorFeedType | null;
    action_type: WhatsAppOperatorActionType;
    stage: string | null;
    recommended_action: string | null;
    card_label: string | null;
    card_intent: string | null;
    mode: string | null;
    metadata: unknown;
    created_at: string;
  }>(
    `
      select
        id,
        lead_id,
        surface,
        feed_type,
        action_type,
        stage,
        recommended_action,
        card_label,
        card_intent,
        mode,
        metadata,
        created_at
      from whatsapp_operator_events
      where created_at >= $1::timestamptz
        and created_at <= $2::timestamptz
      order by created_at asc
    `,
    [input.from, input.to]
  );
  return q.rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    surface: row.surface,
    feedType: row.feed_type,
    actionType: row.action_type,
    stage: row.stage,
    recommendedAction: row.recommended_action,
    cardLabel: row.card_label,
    cardIntent: row.card_intent,
    mode: row.mode,
    metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null,
    createdAt: row.created_at
  }));
}
