import { getDbPool } from "./client.js";

export type AiInsightRecord = {
  id: string;
  conversationId: string;
  intents: Record<string, unknown>;
  suggestedReplies: string[];
  proposedStage: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function toObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item || "").trim()).filter(Boolean);
}

export async function createAiInsight(input: {
  conversationId: string;
  intents?: Record<string, unknown>;
  suggestedReplies?: string[];
  proposedStage?: string | null;
  payload?: Record<string, unknown>;
}): Promise<AiInsightRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    conversation_id: string;
    intents: unknown;
    suggested_replies: unknown;
    proposed_stage: string | null;
    payload: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `
      insert into ai_insights (
        conversation_id, intents, suggested_replies, proposed_stage, payload
      )
      values (
        $1::uuid, $2::jsonb, $3::jsonb, nullif(trim($4::text), ''), $5::jsonb
      )
      returning *
    `,
    [
      input.conversationId,
      JSON.stringify(input.intents || {}),
      JSON.stringify(Array.isArray(input.suggestedReplies) ? input.suggestedReplies.slice(0, 4) : []),
      input.proposedStage ?? null,
      JSON.stringify(input.payload || {})
    ]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    intents: toObject(row.intents),
    suggestedReplies: toStringArray(row.suggested_replies),
    proposedStage: row.proposed_stage || null,
    payload: toObject(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getLatestAiInsightByConversationId(conversationId: string): Promise<AiInsightRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    conversation_id: string;
    intents: unknown;
    suggested_replies: unknown;
    proposed_stage: string | null;
    payload: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `
      select *
      from ai_insights
      where conversation_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [conversationId]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    intents: toObject(row.intents),
    suggestedReplies: toStringArray(row.suggested_replies),
    proposedStage: row.proposed_stage || null,
    payload: toObject(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
