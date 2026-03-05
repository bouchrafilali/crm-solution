import { getDbPool } from "./client.js";

type SuggestionSource = "rules_suggest_reply" | "ai_followup" | "ai_classify" | "ai_draft" | "manual";
type OutcomeLabel = "NO_REPLY" | "REPLIED" | "PAYMENT_QUESTION" | "DEPOSIT_LINK_SENT" | "CONFIRMED" | "CONVERTED" | "LOST";
type ReviewStatus = "OPEN" | "REVIEWED" | "ARCHIVED";

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

export async function createSuggestionFeedbackDraft(input: {
  leadId: string;
  source: SuggestionSource;
  suggestionType: string | null;
  suggestionText: string;
  suggestionPayload?: Record<string, unknown> | null;
}): Promise<string | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{ id: string }>(
    `
      insert into whatsapp_suggestion_feedback (
        lead_id, source, suggestion_type, suggestion_text, suggestion_payload
      )
      values ($1::uuid, $2::text, nullif(trim($3::text), ''), $4::text, $5::jsonb)
      returning id
    `,
    [
      input.leadId,
      input.source,
      input.suggestionType ?? null,
      String(input.suggestionText || "").trim(),
      input.suggestionPayload ? JSON.stringify(input.suggestionPayload) : null
    ]
  );
  return q.rows[0]?.id || null;
}

export async function attachFinalMessageToSuggestion(input: {
  id: string;
  finalText: string;
  finalMessageId: string;
  accepted?: boolean | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const normalizedFinal = String(input.finalText || "").trim();
  const q = await db.query(
    `
      update whatsapp_suggestion_feedback
      set
        final_text = $2::text,
        final_message_id = $3::uuid,
        accepted = coalesce($4::boolean, case when trim(lower(suggestion_text)) = trim(lower($2::text)) then true else false end),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, normalizedFinal, input.finalMessageId, input.accepted == null ? null : Boolean(input.accepted)]
  );
  return (q.rowCount || 0) > 0;
}

export async function markSuggestionOutcome(input: {
  id: string;
  outcomeLabel: OutcomeLabel;
  reviewNotes?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_suggestion_feedback
      set
        outcome_label = $2::text,
        outcome_at = now(),
        review_notes = coalesce(nullif(trim($3::text), ''), review_notes),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, input.outcomeLabel, input.reviewNotes ?? null]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateSuggestionReviewStatus(input: {
  id: string;
  status: ReviewStatus;
  reviewNotes?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_suggestion_feedback
      set
        review_status = $2::text,
        review_notes = coalesce(nullif(trim($3::text), ''), review_notes),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, input.status, input.reviewNotes ?? null]
  );
  return (q.rowCount || 0) > 0;
}

export async function listSuggestionFeedbackQueue(options?: {
  limit?: number;
  status?: ReviewStatus | "ALL";
}): Promise<
  Array<{
    id: string;
    lead_id: string;
    client_name: string | null;
    source: string;
    suggestion_type: string | null;
    suggestion_text: string;
    accepted: boolean | null;
    final_text: string | null;
    outcome_label: string | null;
    review_status: string;
    review_notes: string | null;
    created_at: string;
    updated_at: string;
  }>
> {
  const db = getPoolOrThrow();
  const limit = Math.max(1, Math.min(500, Math.round(options?.limit || 100)));
  const status = String(options?.status || "OPEN").toUpperCase();
  const q = await db.query<{
    id: string;
    lead_id: string;
    client_name: string | null;
    source: string;
    suggestion_type: string | null;
    suggestion_text: string;
    accepted: boolean | null;
    final_text: string | null;
    outcome_label: string | null;
    review_status: string;
    review_notes: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select
        sf.id,
        sf.lead_id,
        l.client_name,
        sf.source,
        sf.suggestion_type,
        sf.suggestion_text,
        sf.accepted,
        sf.final_text,
        sf.outcome_label,
        sf.review_status,
        sf.review_notes,
        sf.created_at,
        sf.updated_at
      from whatsapp_suggestion_feedback sf
      left join whatsapp_leads l on l.id = sf.lead_id
      where ($1::text = 'ALL' or review_status = $1::text)
      order by sf.created_at desc
      limit $2::int
    `,
    [status, limit]
  );
  return q.rows;
}

export async function getSuggestionTypePerformance(options?: {
  days?: number;
  minSamples?: number;
  successWeight?: number;
  acceptedWeight?: number;
  lostWeight?: number;
  boostMin?: number;
  boostMax?: number;
  successOutcomes?: string[];
  failureOutcomes?: string[];
}): Promise<Map<string, {
  total: number;
  acceptedRate: number;
  successRate: number;
  lostRate: number;
  boost: number;
}>> {
  const db = getPoolOrThrow();
  const days = Math.max(7, Math.min(365, Math.round(options?.days || 90)));
  const minSamples = Math.max(1, Math.min(50, Math.round(options?.minSamples || 3)));
  const successWeight = Math.max(0, Math.min(100, Math.round(options?.successWeight ?? 20)));
  const acceptedWeight = Math.max(0, Math.min(100, Math.round(options?.acceptedWeight ?? 10)));
  const lostWeight = Math.max(0, Math.min(100, Math.round(options?.lostWeight ?? 14)));
  const boostMin = Math.max(-100, Math.min(0, Math.round(options?.boostMin ?? -15)));
  const boostMax = Math.max(0, Math.min(100, Math.round(options?.boostMax ?? 20)));
  const successOutcomes = Array.isArray(options?.successOutcomes) && options.successOutcomes.length
    ? options.successOutcomes.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
    : ["CONFIRMED", "CONVERTED"];
  const failureOutcomes = Array.isArray(options?.failureOutcomes) && options.failureOutcomes.length
    ? options.failureOutcomes.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
    : ["LOST"];
  const q = await db.query<{
    suggestion_type: string;
    total: string | number;
    accepted_yes: string | number;
    success_count: string | number;
    lost_count: string | number;
  }>(
    `
      with scoped as (
        select *
        from whatsapp_suggestion_feedback
        where created_at >= now() - ($1::int * interval '1 day')
          and nullif(trim(coalesce(suggestion_type, '')), '') is not null
      )
      select
        lower(trim(suggestion_type)) as suggestion_type,
        count(*) as total,
        count(*) filter (where accepted = true) as accepted_yes,
        count(*) filter (where upper(coalesce(outcome_label, '')) = any($3::text[])) as success_count,
        count(*) filter (where upper(coalesce(outcome_label, '')) = any($4::text[])) as lost_count
      from scoped
      group by lower(trim(suggestion_type))
      having count(*) >= $2::int
    `,
    [days, minSamples, successOutcomes, failureOutcomes]
  );

  const out = new Map<string, {
    total: number;
    acceptedRate: number;
    successRate: number;
    lostRate: number;
    boost: number;
  }>();
  for (const row of q.rows) {
    const key = String(row.suggestion_type || "").trim();
    if (!key) continue;
    const total = Number(row.total || 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    const acceptedRate = Number(row.accepted_yes || 0) / total;
    const successRate = Number(row.success_count || 0) / total;
    const lostRate = Number(row.lost_count || 0) / total;
    const boostRaw = Math.round(successRate * successWeight + acceptedRate * acceptedWeight - lostRate * lostWeight);
    const boost = Math.max(boostMin, Math.min(boostMax, boostRaw));
    out.set(key, { total, acceptedRate, successRate, lostRate, boost });
  }
  return out;
}
