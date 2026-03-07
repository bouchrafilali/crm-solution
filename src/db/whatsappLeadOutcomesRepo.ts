import { getDbPool } from "./client.js";

export type WhatsAppLeadOutcome = "open" | "converted" | "lost" | "stalled";

export type WhatsAppLeadOutcomeRecord = {
  leadId: string;
  outcome: WhatsAppLeadOutcome;
  finalStage: string | null;
  outcomeAt: string;
  orderValue: number | null;
  currency: string | null;
  source: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

export async function upsertWhatsAppLeadOutcome(input: {
  leadId: string;
  outcome: WhatsAppLeadOutcome;
  finalStage?: string | null;
  outcomeAt: string;
  orderValue?: number | null;
  currency?: string | null;
  source?: string | null;
  notes?: string | null;
}): Promise<WhatsAppLeadOutcomeRecord> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    outcome: WhatsAppLeadOutcome;
    final_stage: string | null;
    outcome_at: string;
    order_value: string | number | null;
    currency: string | null;
    source: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      insert into whatsapp_lead_outcomes (
        lead_id, outcome, final_stage, outcome_at, order_value, currency, source, notes
      )
      values (
        $1::uuid,
        $2::text,
        nullif(trim($3::text), ''),
        $4::timestamptz,
        $5::numeric,
        nullif(trim($6::text), ''),
        nullif(trim($7::text), ''),
        nullif(trim($8::text), '')
      )
      on conflict (lead_id)
      do update set
        outcome = excluded.outcome,
        final_stage = excluded.final_stage,
        outcome_at = excluded.outcome_at,
        order_value = excluded.order_value,
        currency = excluded.currency,
        source = excluded.source,
        notes = excluded.notes,
        updated_at = now()
      returning
        lead_id,
        outcome,
        final_stage,
        outcome_at,
        order_value,
        currency,
        source,
        notes,
        created_at,
        updated_at
    `,
    [
      input.leadId,
      input.outcome,
      input.finalStage ?? null,
      input.outcomeAt,
      input.orderValue ?? null,
      input.currency ?? null,
      input.source ?? null,
      input.notes ?? null
    ]
  );
  const row = q.rows[0];
  return {
    leadId: row.lead_id,
    outcome: row.outcome,
    finalStage: row.final_stage,
    outcomeAt: row.outcome_at,
    orderValue: row.order_value == null ? null : Number(row.order_value),
    currency: row.currency,
    source: row.source,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getWhatsAppLeadOutcome(leadId: string): Promise<WhatsAppLeadOutcomeRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    outcome: WhatsAppLeadOutcome;
    final_stage: string | null;
    outcome_at: string;
    order_value: string | number | null;
    currency: string | null;
    source: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select
        lead_id,
        outcome,
        final_stage,
        outcome_at,
        order_value,
        currency,
        source,
        notes,
        created_at,
        updated_at
      from whatsapp_lead_outcomes
      where lead_id = $1::uuid
      limit 1
    `,
    [leadId]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    leadId: row.lead_id,
    outcome: row.outcome,
    finalStage: row.final_stage,
    outcomeAt: row.outcome_at,
    orderValue: row.order_value == null ? null : Number(row.order_value),
    currency: row.currency,
    source: row.source,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listWhatsAppLeadOutcomesByRange(input: {
  from: string;
  to: string;
}): Promise<WhatsAppLeadOutcomeRecord[]> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    outcome: WhatsAppLeadOutcome;
    final_stage: string | null;
    outcome_at: string;
    order_value: string | number | null;
    currency: string | null;
    source: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select
        lead_id,
        outcome,
        final_stage,
        outcome_at,
        order_value,
        currency,
        source,
        notes,
        created_at,
        updated_at
      from whatsapp_lead_outcomes
      where outcome_at >= $1::timestamptz
        and outcome_at <= $2::timestamptz
      order by outcome_at asc
    `,
    [input.from, input.to]
  );

  return q.rows.map((row) => ({
    leadId: row.lead_id,
    outcome: row.outcome,
    finalStage: row.final_stage,
    outcomeAt: row.outcome_at,
    orderValue: row.order_value == null ? null : Number(row.order_value),
    currency: row.currency,
    source: row.source,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}
