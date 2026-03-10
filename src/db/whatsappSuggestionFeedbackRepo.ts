import { getDbPool } from "./client.js";

export type SuggestionSource = "rules_suggest_reply" | "ai_followup" | "ai_classify" | "ai_draft" | "manual";
export type OutcomeLabel = "NO_REPLY" | "REPLIED" | "PAYMENT_QUESTION" | "DEPOSIT_LINK_SENT" | "CONFIRMED" | "CONVERTED" | "LOST";
export type ReviewStatus = "OPEN" | "REVIEWED" | "ARCHIVED";
export type SuggestionStatus = "GENERATED" | "ACCEPTED" | "EDITED" | "REJECTED" | "IGNORED" | "EXPIRED";
export type SuggestionOutcomeStatus =
  | "CLIENT_REPLIED"
  | "STAGE_ADVANCED"
  | "DEPOSIT_SIGNAL"
  | "CONVERTED"
  | "LOST"
  | "NO_RESPONSE_24H"
  | "NO_RESPONSE_72H"
  | "UNKNOWN";
export type SuggestionDecisionType = "ACCEPTED" | "EDITED" | "REJECTED" | "MANUAL";

export type SuggestionFeedbackRecord = {
  id: string;
  leadId: string;
  conversationId: string | null;
  operatorId: string | null;
  source: SuggestionSource | string;
  suggestionStatus: SuggestionStatus;
  suggestionType: string | null;
  suggestionText: string;
  suggestionPayload: Record<string, unknown> | null;
  stageBeforeReply: string | null;
  stageAfterReply: string | null;
  accepted: boolean | null;
  finalHumanText: string | null;
  sendMessageId: string | null;
  generatedAt: string;
  actedAt: string | null;
  outcomeLabel: OutcomeLabel | null;
  outcomeStatus: SuggestionOutcomeStatus | null;
  outcomeAt: string | null;
  outcomeEvaluatedAt: string | null;
  reviewStatus: ReviewStatus;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mapSuggestionFeedbackRow(row: {
  id: string;
  lead_id: string;
  conversation_id: string | null;
  operator_id: string | null;
  source: string;
  suggestion_status: string;
  suggestion_type: string | null;
  suggestion_text: string;
  suggestion_payload: unknown;
  stage_before_reply: string | null;
  stage_after_reply: string | null;
  accepted: boolean | null;
  final_human_text: string | null;
  send_message_id: string | null;
  generated_at: string;
  acted_at: string | null;
  outcome_label: string | null;
  outcome_status: string | null;
  outcome_at: string | null;
  outcome_evaluated_at: string | null;
  review_status: string;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
}): SuggestionFeedbackRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    conversationId: row.conversation_id,
    operatorId: row.operator_id,
    source: row.source,
    suggestionStatus: row.suggestion_status as SuggestionStatus,
    suggestionType: row.suggestion_type,
    suggestionText: row.suggestion_text,
    suggestionPayload: toRecord(row.suggestion_payload),
    stageBeforeReply: row.stage_before_reply,
    stageAfterReply: row.stage_after_reply,
    accepted: row.accepted,
    finalHumanText: row.final_human_text,
    sendMessageId: row.send_message_id,
    generatedAt: row.generated_at,
    actedAt: row.acted_at,
    outcomeLabel: (row.outcome_label || null) as OutcomeLabel | null,
    outcomeStatus: (row.outcome_status || null) as SuggestionOutcomeStatus | null,
    outcomeAt: row.outcome_at,
    outcomeEvaluatedAt: row.outcome_evaluated_at,
    reviewStatus: row.review_status as ReviewStatus,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createSuggestionFeedbackDraft(input: {
  leadId: string;
  source: SuggestionSource;
  suggestionType: string | null;
  suggestionText: string;
  suggestionPayload?: Record<string, unknown> | null;
  conversationId?: string | null;
  operatorId?: string | null;
  stageBeforeReply?: string | null;
  wasAiGenerated?: boolean;
  generatedAt?: string | null;
}): Promise<string | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{ id: string }>(
    `
      insert into whatsapp_suggestion_feedback (
        lead_id,
        conversation_id,
        operator_id,
        source,
        suggestion_status,
        suggestion_type,
        suggestion_text,
        suggestion_payload,
        stage_before_reply,
        was_ai_generated,
        generated_at
      )
      values (
        $1::uuid,
        coalesce($2::uuid, $1::uuid),
        nullif(trim($3::text), ''),
        $4::text,
        'GENERATED',
        nullif(trim($5::text), ''),
        $6::text,
        $7::jsonb,
        nullif(trim($8::text), ''),
        coalesce($9::boolean, true),
        coalesce($10::timestamptz, now())
      )
      returning id
    `,
    [
      input.leadId,
      input.conversationId ?? null,
      input.operatorId ?? null,
      input.source,
      input.suggestionType ?? null,
      String(input.suggestionText || "").trim(),
      input.suggestionPayload ? JSON.stringify(input.suggestionPayload) : null,
      input.stageBeforeReply ?? null,
      input.wasAiGenerated == null ? true : Boolean(input.wasAiGenerated),
      input.generatedAt ?? null
    ]
  );
  return q.rows[0]?.id || null;
}

export async function getSuggestionFeedbackById(id: string): Promise<SuggestionFeedbackRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    lead_id: string;
    conversation_id: string | null;
    operator_id: string | null;
    source: string;
    suggestion_status: string;
    suggestion_type: string | null;
    suggestion_text: string;
    suggestion_payload: unknown;
    stage_before_reply: string | null;
    stage_after_reply: string | null;
    accepted: boolean | null;
    final_human_text: string | null;
    send_message_id: string | null;
    generated_at: string;
    acted_at: string | null;
    outcome_label: string | null;
    outcome_status: string | null;
    outcome_at: string | null;
    outcome_evaluated_at: string | null;
    review_status: string;
    review_notes: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select
        id,
        lead_id,
        conversation_id,
        operator_id,
        source,
        suggestion_status,
        suggestion_type,
        suggestion_text,
        suggestion_payload,
        stage_before_reply,
        stage_after_reply,
        accepted,
        final_human_text,
        send_message_id,
        generated_at,
        acted_at,
        outcome_label,
        outcome_status,
        outcome_at,
        outcome_evaluated_at,
        review_status,
        review_notes,
        created_at,
        updated_at
      from whatsapp_suggestion_feedback
      where id = $1::uuid
      limit 1
    `,
    [id]
  );
  const row = q.rows[0];
  return row ? mapSuggestionFeedbackRow(row) : null;
}

export async function markSuggestionAction(input: {
  id: string;
  suggestionStatus: Extract<SuggestionStatus, "ACCEPTED" | "EDITED" | "REJECTED" | "IGNORED" | "EXPIRED">;
  finalHumanText?: string | null;
  sendMessageId?: string | null;
  stageBeforeReply?: string | null;
  stageAfterReply?: string | null;
  actedAt?: string | null;
  operatorId?: string | null;
  conversationId?: string | null;
  accepted?: boolean | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const normalizedFinal = input.finalHumanText == null ? null : String(input.finalHumanText || "").trim();
  const q = await db.query(
    `
      update whatsapp_suggestion_feedback
      set
        conversation_id = coalesce($2::uuid, conversation_id),
        operator_id = coalesce(nullif(trim($3::text), ''), operator_id),
        suggestion_status = $4::text,
        stage_before_reply = coalesce(nullif(trim($5::text), ''), stage_before_reply),
        stage_after_reply = coalesce(nullif(trim($6::text), ''), stage_after_reply),
        accepted = coalesce(
          $7::boolean,
          case
            when $4::text = 'ACCEPTED' then true
            when $4::text in ('EDITED', 'REJECTED') then false
            else accepted
          end,
          case when trim(lower(suggestion_text)) = trim(lower(coalesce($8::text, suggestion_text))) then true else false end
        ),
        final_human_text = coalesce($8::text, final_human_text),
        final_text = coalesce($8::text, final_text),
        send_message_id = coalesce($9::uuid, send_message_id),
        final_message_id = coalesce($9::uuid, final_message_id),
        acted_at = coalesce($10::timestamptz, acted_at, now()),
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.conversationId ?? null,
      input.operatorId ?? null,
      input.suggestionStatus,
      input.stageBeforeReply ?? null,
      input.stageAfterReply ?? null,
      input.accepted == null ? null : Boolean(input.accepted),
      normalizedFinal,
      input.sendMessageId ?? null,
      input.actedAt ?? null
    ]
  );
  return (q.rowCount || 0) > 0;
}

export async function attachFinalMessageToSuggestion(input: {
  id: string;
  finalText: string;
  finalMessageId: string;
  accepted?: boolean | null;
}): Promise<boolean> {
  return markSuggestionAction({
    id: input.id,
    suggestionStatus: input.accepted === true ? "ACCEPTED" : input.accepted === false ? "EDITED" : "EDITED",
    finalHumanText: input.finalText,
    sendMessageId: input.finalMessageId,
    accepted: input.accepted
  });
}

export async function markSuggestionOutcome(input: {
  id: string;
  outcomeLabel: OutcomeLabel;
  reviewNotes?: string | null;
  outcomeStatus?: SuggestionOutcomeStatus | null;
  stageAfterReply?: string | null;
  evaluatedAt?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_suggestion_feedback
      set
        outcome_label = $2::text,
        outcome_status = coalesce($3::text, outcome_status),
        stage_after_reply = coalesce(nullif(trim($4::text), ''), stage_after_reply),
        outcome_at = coalesce($5::timestamptz, now()),
        outcome_evaluated_at = coalesce($5::timestamptz, now()),
        review_notes = coalesce(nullif(trim($6::text), ''), review_notes),
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.outcomeLabel,
      input.outcomeStatus ?? null,
      input.stageAfterReply ?? null,
      input.evaluatedAt ?? null,
      input.reviewNotes ?? null
    ]
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
    final_human_text: string | null;
    suggestion_status: string;
    outcome_label: string | null;
    outcome_status: string | null;
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
    final_human_text: string | null;
    suggestion_status: string;
    outcome_label: string | null;
    outcome_status: string | null;
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
        sf.final_human_text,
        sf.suggestion_status,
        sf.outcome_label,
        sf.outcome_status,
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
}): Promise<
  Map<
    string,
    {
      total: number;
      acceptedRate: number;
      successRate: number;
      lostRate: number;
      boost: number;
    }
  >
> {
  const db = getPoolOrThrow();
  const days = Math.max(7, Math.min(365, Math.round(options?.days || 90)));
  const minSamples = Math.max(1, Math.min(50, Math.round(options?.minSamples || 3)));
  const successWeight = Math.max(0, Math.min(100, Math.round(options?.successWeight ?? 20)));
  const acceptedWeight = Math.max(0, Math.min(100, Math.round(options?.acceptedWeight ?? 10)));
  const lostWeight = Math.max(0, Math.min(100, Math.round(options?.lostWeight ?? 14)));
  const boostMin = Math.max(-100, Math.min(0, Math.round(options?.boostMin ?? -15)));
  const boostMax = Math.max(0, Math.min(100, Math.round(options?.boostMax ?? 20)));
  const successOutcomes =
    Array.isArray(options?.successOutcomes) && options.successOutcomes.length
      ? options.successOutcomes.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
      : ["CONFIRMED", "CONVERTED", "STAGE_ADVANCED", "CLIENT_REPLIED", "DEPOSIT_SIGNAL"];
  const failureOutcomes =
    Array.isArray(options?.failureOutcomes) && options.failureOutcomes.length
      ? options.failureOutcomes.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
      : ["LOST", "NO_RESPONSE_72H"];
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
        where generated_at >= now() - ($1::int * interval '1 day')
          and nullif(trim(coalesce(suggestion_type, '')), '') is not null
      )
      select
        lower(trim(suggestion_type)) as suggestion_type,
        count(*) as total,
        count(*) filter (
          where
            suggestion_status = 'ACCEPTED'
            or accepted = true
        ) as accepted_yes,
        count(*) filter (
          where upper(coalesce(outcome_status, outcome_label, '')) = any($3::text[])
        ) as success_count,
        count(*) filter (
          where upper(coalesce(outcome_status, outcome_label, '')) = any($4::text[])
        ) as lost_count
      from scoped
      group by lower(trim(suggestion_type))
      having count(*) >= $2::int
    `,
    [days, minSamples, successOutcomes, failureOutcomes]
  );

  const out = new Map<
    string,
    {
      total: number;
      acceptedRate: number;
      successRate: number;
      lostRate: number;
      boost: number;
    }
  >();
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

export async function upsertSuggestionLearningSignal(input: {
  suggestionFeedbackId: string;
  leadId: string;
  conversationId?: string | null;
  decisionType: SuggestionDecisionType;
  similarityScore?: number | null;
  editDistance?: number | null;
  flags?: Record<string, unknown> | null;
  outcomePositive?: boolean | null;
  outcomeStatus?: string | null;
}): Promise<string> {
  const db = getPoolOrThrow();
  const q = await db.query<{ id: string }>(
    `
      insert into whatsapp_suggestion_learning_signals (
        suggestion_feedback_id,
        lead_id,
        conversation_id,
        decision_type,
        similarity_score,
        edit_distance,
        flags,
        outcome_positive,
        outcome_status
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        $5::numeric,
        $6::int,
        $7::jsonb,
        $8::boolean,
        nullif(trim($9::text), '')
      )
      returning id
    `,
    [
      input.suggestionFeedbackId,
      input.leadId,
      input.conversationId ?? null,
      input.decisionType,
      input.similarityScore == null ? null : Number(input.similarityScore.toFixed(5)),
      input.editDistance == null ? null : Math.max(0, Math.round(input.editDistance)),
      JSON.stringify(input.flags || {}),
      input.outcomePositive == null ? null : Boolean(input.outcomePositive),
      input.outcomeStatus ?? null
    ]
  );
  return String(q.rows[0]?.id || "");
}

export async function getLearningLoopStats(options?: {
  days?: number;
  suggestionType?: string | null;
}): Promise<{
  bySuggestionType: Array<{
    suggestionType: string;
    total: number;
    accepted: number;
    edited: number;
    rejected: number;
    ignoredOrExpired: number;
    positiveOutcomes: number;
  }>;
  byDecisionType: Array<{
    decisionType: string;
    total: number;
    positiveOutcomes: number;
  }>;
  topEditPatterns: Array<{
    pattern: string;
    count: number;
  }>;
}> {
  const db = getPoolOrThrow();
  const days = Math.max(1, Math.min(365, Math.round(options?.days || 30)));
  const suggestionType = String(options?.suggestionType || "").trim().toLowerCase();

  const bySuggestionQ = await db.query<{
    suggestion_type: string;
    total: string;
    accepted_count: string;
    edited_count: string;
    rejected_count: string;
    ignored_or_expired_count: string;
    positive_outcomes: string;
  }>(
    `
      select
        lower(trim(coalesce(suggestion_type, 'unknown'))) as suggestion_type,
        count(*) as total,
        count(*) filter (where suggestion_status = 'ACCEPTED') as accepted_count,
        count(*) filter (where suggestion_status = 'EDITED') as edited_count,
        count(*) filter (where suggestion_status = 'REJECTED') as rejected_count,
        count(*) filter (where suggestion_status in ('IGNORED', 'EXPIRED')) as ignored_or_expired_count,
        count(*) filter (where coalesce(outcome_status, '') in ('CLIENT_REPLIED', 'STAGE_ADVANCED', 'DEPOSIT_SIGNAL', 'CONVERTED')) as positive_outcomes
      from whatsapp_suggestion_feedback
      where generated_at >= now() - ($1::int * interval '1 day')
        and ($2::text = '' or lower(trim(coalesce(suggestion_type, ''))) = $2::text)
      group by lower(trim(coalesce(suggestion_type, 'unknown')))
      order by total desc
      limit 100
    `,
    [days, suggestionType]
  );

  const byDecisionQ = await db.query<{
    decision_type: string;
    total: string;
    positive_outcomes: string;
  }>(
    `
      select
        decision_type,
        count(*) as total,
        count(*) filter (where outcome_positive = true) as positive_outcomes
      from whatsapp_suggestion_learning_signals
      where created_at >= now() - ($1::int * interval '1 day')
      group by decision_type
      order by total desc
    `,
    [days]
  );

  const editPatternsQ = await db.query<{
    pattern: string;
    count: string;
  }>(
    `
      with exploded as (
        select
          key as pattern,
          value
        from whatsapp_suggestion_learning_signals,
          jsonb_each(flags)
        where created_at >= now() - ($1::int * interval '1 day')
          and decision_type in ('EDITED', 'REJECTED', 'MANUAL')
      )
      select
        pattern,
        count(*) as count
      from exploded
      where value = 'true'::jsonb
      group by pattern
      order by count(*) desc, pattern asc
      limit 12
    `,
    [days]
  );

  return {
    bySuggestionType: bySuggestionQ.rows.map((row) => ({
      suggestionType: row.suggestion_type,
      total: Number(row.total || 0),
      accepted: Number(row.accepted_count || 0),
      edited: Number(row.edited_count || 0),
      rejected: Number(row.rejected_count || 0),
      ignoredOrExpired: Number(row.ignored_or_expired_count || 0),
      positiveOutcomes: Number(row.positive_outcomes || 0)
    })),
    byDecisionType: byDecisionQ.rows.map((row) => ({
      decisionType: row.decision_type,
      total: Number(row.total || 0),
      positiveOutcomes: Number(row.positive_outcomes || 0)
    })),
    topEditPatterns: editPatternsQ.rows.map((row) => ({
      pattern: row.pattern,
      count: Number(row.count || 0)
    }))
  };
}
