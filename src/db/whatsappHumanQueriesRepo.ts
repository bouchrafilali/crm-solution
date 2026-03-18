import { getDbPool } from "./client.js";

export type WhatsAppHumanQueryStatus = "pending" | "answered" | "cancelled";

export type WhatsAppHumanQueryRecord = {
  id: string;
  leadId: string;
  question: string;
  context: Record<string, unknown> | null;
  status: WhatsAppHumanQueryStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapRow(row: {
  id: string;
  lead_id: string;
  question: string;
  context: unknown;
  status: WhatsAppHumanQueryStatus;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}): WhatsAppHumanQueryRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    question: String(row.question || "").trim(),
    context: asRecord(row.context),
    status: row.status,
    answer: row.answer ? String(row.answer) : null,
    createdAt: row.created_at,
    answeredAt: row.answered_at
  };
}

export async function createWhatsAppHumanQuery(input: {
  leadId: string;
  question: string;
  context?: Record<string, unknown> | null;
}): Promise<WhatsAppHumanQueryRecord> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    lead_id: string;
    question: string;
    context: unknown;
    status: WhatsAppHumanQueryStatus;
    answer: string | null;
    created_at: string;
    answered_at: string | null;
  }>(
    `
      insert into whatsapp_human_queries (lead_id, question, context, status)
      values ($1::uuid, $2::text, $3::jsonb, 'pending')
      returning id, lead_id, question, context, status, answer, created_at, answered_at
    `,
    [input.leadId, input.question, JSON.stringify(input.context || {})]
  );
  return mapRow(q.rows[0]);
}

export async function listPendingWhatsAppHumanQueries(leadId: string): Promise<WhatsAppHumanQueryRecord[]> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    lead_id: string;
    question: string;
    context: unknown;
    status: WhatsAppHumanQueryStatus;
    answer: string | null;
    created_at: string;
    answered_at: string | null;
  }>(
    `
      select id, lead_id, question, context, status, answer, created_at, answered_at
      from whatsapp_human_queries
      where lead_id = $1::uuid and status = 'pending'
      order by created_at asc
    `,
    [leadId]
  );
  return q.rows.map(mapRow);
}

export async function getOldestPendingWhatsAppHumanQuery(leadId: string): Promise<WhatsAppHumanQueryRecord | null> {
  const rows = await listPendingWhatsAppHumanQueries(leadId);
  return rows.length ? rows[0] : null;
}

export async function answerWhatsAppHumanQuery(input: {
  queryId: string;
  answer: string;
}): Promise<WhatsAppHumanQueryRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    lead_id: string;
    question: string;
    context: unknown;
    status: WhatsAppHumanQueryStatus;
    answer: string | null;
    created_at: string;
    answered_at: string | null;
  }>(
    `
      update whatsapp_human_queries
      set status = 'answered', answer = $2::text, answered_at = now()
      where id = $1::uuid and status = 'pending'
      returning id, lead_id, question, context, status, answer, created_at, answered_at
    `,
    [input.queryId, input.answer]
  );
  if (!q.rows.length) return null;
  return mapRow(q.rows[0]);
}
