import { getDbPool } from "./client.js";

export type WhatsAppPriorityIntelligenceRecord = {
  leadId: string;
  stage: string;
  facts: Record<string, unknown>;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  eventDate: string | null;
  paymentIntent: boolean;
  awaitingReply: boolean;
  ticketValueEstimate: number | null;
  conversionProbability: number;
  dropoffRisk: number;
  priorityScore: number;
  priorityBand: "critical" | "high" | "medium" | "low";
  recommendedAttention: string;
  reasonCodes: string[];
  primaryReasonCode: string | null;
  inputSignature: string;
  computedAt: string;
  updatedAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asReasonCodes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function mapRow(row: {
  lead_id: string;
  stage: string;
  facts: unknown;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  event_date: string | null;
  payment_intent: boolean;
  awaiting_reply: boolean;
  ticket_value_estimate: string | number | null;
  conversion_probability: string | number;
  dropoff_risk: string | number;
  priority_score: number;
  priority_band: "critical" | "high" | "medium" | "low";
  recommended_attention: string;
  reason_codes: unknown;
  primary_reason_code: string | null;
  input_signature: string;
  computed_at: string;
  updated_at: string;
}): WhatsAppPriorityIntelligenceRecord {
  return {
    leadId: row.lead_id,
    stage: String(row.stage || "").trim(),
    facts: asRecord(row.facts),
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    eventDate: row.event_date,
    paymentIntent: Boolean(row.payment_intent),
    awaitingReply: Boolean(row.awaiting_reply),
    ticketValueEstimate: row.ticket_value_estimate == null ? null : Number(row.ticket_value_estimate),
    conversionProbability: Number(row.conversion_probability || 0),
    dropoffRisk: Number(row.dropoff_risk || 0),
    priorityScore: Math.max(0, Math.min(100, Number(row.priority_score || 0))),
    priorityBand: row.priority_band,
    recommendedAttention: String(row.recommended_attention || "").trim(),
    reasonCodes: asReasonCodes(row.reason_codes),
    primaryReasonCode: row.primary_reason_code ? String(row.primary_reason_code) : null,
    inputSignature: String(row.input_signature || "").trim(),
    computedAt: row.computed_at,
    updatedAt: row.updated_at
  };
}

export async function getWhatsAppPriorityIntelligence(
  leadId: string
): Promise<WhatsAppPriorityIntelligenceRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    stage: string;
    facts: unknown;
    last_inbound_at: string | null;
    last_outbound_at: string | null;
    event_date: string | null;
    payment_intent: boolean;
    awaiting_reply: boolean;
    ticket_value_estimate: string | number | null;
    conversion_probability: string | number;
    dropoff_risk: string | number;
    priority_score: number;
    priority_band: "critical" | "high" | "medium" | "low";
    recommended_attention: string;
    reason_codes: unknown;
    primary_reason_code: string | null;
    input_signature: string;
    computed_at: string;
    updated_at: string;
  }>(
    `
      select
        lead_id,
        stage,
        facts,
        last_inbound_at,
        last_outbound_at,
        event_date,
        payment_intent,
        awaiting_reply,
        ticket_value_estimate,
        conversion_probability,
        dropoff_risk,
        priority_score,
        priority_band,
        recommended_attention,
        reason_codes,
        primary_reason_code,
        input_signature,
        computed_at,
        updated_at
      from whatsapp_priority_intelligence
      where lead_id = $1::uuid
      limit 1
    `,
    [leadId]
  );
  if (!q.rows.length) return null;
  return mapRow(q.rows[0]);
}

export async function upsertWhatsAppPriorityIntelligence(input: {
  leadId: string;
  stage: string;
  facts: Record<string, unknown>;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  eventDate: string | null;
  paymentIntent: boolean;
  awaitingReply: boolean;
  ticketValueEstimate: number | null;
  conversionProbability: number;
  dropoffRisk: number;
  priorityScore: number;
  priorityBand: "critical" | "high" | "medium" | "low";
  recommendedAttention: string;
  reasonCodes: string[];
  primaryReasonCode: string | null;
  inputSignature: string;
}): Promise<void> {
  const db = getPoolOrThrow();
  await db.query(
    `
      insert into whatsapp_priority_intelligence (
        lead_id,
        stage,
        facts,
        last_inbound_at,
        last_outbound_at,
        event_date,
        payment_intent,
        awaiting_reply,
        ticket_value_estimate,
        conversion_probability,
        dropoff_risk,
        priority_score,
        priority_band,
        recommended_attention,
        reason_codes,
        primary_reason_code,
        input_signature,
        computed_at
      )
      values (
        $1::uuid,
        $2::text,
        $3::jsonb,
        $4::timestamptz,
        $5::timestamptz,
        $6::date,
        $7::bool,
        $8::bool,
        $9::numeric(12,2),
        $10::numeric(8,4),
        $11::numeric(8,4),
        $12::int,
        $13::text,
        $14::text,
        $15::jsonb,
        $16::text,
        $17::text,
        now()
      )
      on conflict (lead_id) do update
      set
        stage = excluded.stage,
        facts = excluded.facts,
        last_inbound_at = excluded.last_inbound_at,
        last_outbound_at = excluded.last_outbound_at,
        event_date = excluded.event_date,
        payment_intent = excluded.payment_intent,
        awaiting_reply = excluded.awaiting_reply,
        ticket_value_estimate = excluded.ticket_value_estimate,
        conversion_probability = excluded.conversion_probability,
        dropoff_risk = excluded.dropoff_risk,
        priority_score = excluded.priority_score,
        priority_band = excluded.priority_band,
        recommended_attention = excluded.recommended_attention,
        reason_codes = excluded.reason_codes,
        primary_reason_code = excluded.primary_reason_code,
        input_signature = excluded.input_signature,
        computed_at = now(),
        updated_at = now()
    `,
    [
      input.leadId,
      input.stage,
      JSON.stringify(input.facts || {}),
      input.lastInboundAt,
      input.lastOutboundAt,
      input.eventDate,
      Boolean(input.paymentIntent),
      Boolean(input.awaitingReply),
      input.ticketValueEstimate == null ? null : Number(input.ticketValueEstimate),
      Number(input.conversionProbability || 0),
      Number(input.dropoffRisk || 0),
      Math.max(0, Math.min(100, Math.round(Number(input.priorityScore || 0)))),
      input.priorityBand,
      input.recommendedAttention,
      JSON.stringify(Array.isArray(input.reasonCodes) ? input.reasonCodes : []),
      input.primaryReasonCode,
      String(input.inputSignature || "")
    ]
  );
}
