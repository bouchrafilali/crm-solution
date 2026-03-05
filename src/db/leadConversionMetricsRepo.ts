import type { Pool } from "pg";
import { getDbPool } from "./client.js";

export type LeadConversionMetricsRecord = {
  id: string;
  leadId: string;
  ticketValue: number | null;
  totalMessages: number;
  firstResponseDelayMinutes: number | null;
  avgResponseDelayMinutes: number | null;
  priceSentDelayMinutes: number | null;
  suggestionUsed: boolean;
  templateUsed: boolean;
  followUpTriggered: boolean;
  videoProposed: boolean;
  conversionProbabilityAtPrice: number | null;
  country: string | null;
  createdAt: string;
};

type Direction = "IN" | "OUT";

type MessageRow = {
  id: string;
  direction: Direction;
  text: string;
  template_name: string | null;
  created_at: string;
};

type MlEventRow = {
  event_type: string;
  source: string | null;
  payload: unknown;
  created_at: string;
};

type StageEventRow = {
  payload: unknown;
  created_at: string;
};

function getPoolOrThrow(): Pool {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function asUpperDirection(value: string): Direction {
  return String(value || "").toUpperCase() === "OUT" ? "OUT" : "IN";
}

function minutesBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null;
  const fromTs = new Date(fromIso).getTime();
  const toTs = new Date(toIso).getTime();
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs < fromTs) return null;
  return Math.max(0, Math.round((toTs - fromTs) / 60000));
}

function computeFirstResponseDelayFromMessages(messages: MessageRow[]): number | null {
  const firstInbound = messages.find((m) => m.direction === "IN");
  if (!firstInbound) return null;
  const reply = messages.find(
    (m) => m.direction === "OUT" && new Date(m.created_at).getTime() > new Date(firstInbound.created_at).getTime()
  );
  return minutesBetween(firstInbound.created_at, reply?.created_at || null);
}

function computeAvgResponseDelay(messages: MessageRow[]): number | null {
  const ordered = messages
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const inboundIndices: number[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i].direction === "IN") inboundIndices.push(i);
  }
  if (!inboundIndices.length) return null;

  const delays: number[] = [];
  for (let i = 0; i < inboundIndices.length; i += 1) {
    const inboundIdx = inboundIndices[i];
    const nextInboundIdx = i + 1 < inboundIndices.length ? inboundIndices[i + 1] : ordered.length;
    let response: MessageRow | null = null;
    for (let j = inboundIdx + 1; j < nextInboundIdx; j += 1) {
      if (ordered[j].direction === "OUT") {
        response = ordered[j];
        break;
      }
    }
    if (!response) continue;
    const delay = minutesBetween(ordered[inboundIdx].created_at, response.created_at);
    if (delay != null) delays.push(delay);
  }

  if (!delays.length) return null;
  const avg = delays.reduce((sum, value) => sum + value, 0) / delays.length;
  return Math.round(avg);
}

function stagePayloadToStage(payload: unknown, key: "from_stage" | "to_stage"): string {
  const obj = asObject(payload);
  return String(obj[key] || "").trim().toUpperCase();
}

function looksLikePriceMessage(text: string): boolean {
  return (
    /\b(le\s+prix\s+est|price\s+is|priced\s+at|prix)\b/i.test(text) ||
    /\b(?:mad|dhs?|dh|€|\$|eur|usd)\s*[0-9]/i.test(text)
  );
}

function extractProbabilityFromPayload(payload: Record<string, unknown>): number | null {
  const directKeys = [
    "conversion_probability_at_price",
    "conversion_probability",
    "conversionProbabilityAtPrice",
    "conversionProbability",
    "probability",
    "confidence",
    "score"
  ];
  for (const key of directKeys) {
    const raw = payload[key];
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n >= 0 && n <= 1) return Math.round(n * 100);
    if (n >= 0 && n <= 100) return Math.round(n);
  }
  return null;
}

function isPriceContextPayload(payload: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(payload).toLowerCase();
  return serialized.includes("price_sent") || serialized.includes("price sent") || serialized.includes("prix");
}

export async function upsertLeadConversionMetrics(leadId: string): Promise<LeadConversionMetricsRecord | null> {
  const db = getPoolOrThrow();
  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return null;

  const leadQ = await db.query<{
    id: string;
    country: string | null;
    ticket_value: string | number | null;
    conversion_value: string | number | null;
    first_response_time_minutes: number | null;
    created_at: string;
    converted_at: string | null;
  }>(
    `
      select
        id,
        country,
        ticket_value,
        conversion_value,
        first_response_time_minutes,
        created_at,
        converted_at
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const lead = leadQ.rows[0];
  if (!lead) return null;

  const [messagesQ, eventsQ, stageEventsQ] = await Promise.all([
    db.query<MessageRow>(
      `
        select id, direction, text, template_name, created_at
        from whatsapp_lead_messages
        where lead_id = $1::uuid
        order by created_at asc
      `,
      [normalizedLeadId]
    ),
    db.query<MlEventRow>(
      `
        select event_type, source, payload, created_at
        from ml_events
        where lead_id = $1::uuid
        order by created_at asc
      `,
      [normalizedLeadId]
    ),
    db.query<StageEventRow>(
      `
        select payload, created_at
        from whatsapp_lead_events
        where lead_id = $1::uuid
          and event_type = 'STAGE_CHANGED'
        order by created_at asc
      `,
      [normalizedLeadId]
    )
  ]);

  const messages = messagesQ.rows.map((row) => ({
    ...row,
    direction: asUpperDirection(row.direction)
  }));
  const events = eventsQ.rows.map((row) => ({
    event_type: String(row.event_type || "").toUpperCase(),
    source: row.source ? String(row.source || "").toUpperCase() : null,
    payload: asObject(row.payload),
    created_at: row.created_at
  }));
  const stageEvents = stageEventsQ.rows.map((row) => ({
    payload: asObject(row.payload),
    created_at: row.created_at
  }));

  const totalMessages = messages.length;
  const firstResponseDelayMinutes =
    lead.first_response_time_minutes != null
      ? Math.max(0, Math.round(Number(lead.first_response_time_minutes)))
      : computeFirstResponseDelayFromMessages(messages);
  const avgResponseDelayMinutes = computeAvgResponseDelay(messages);

  let priceSentAt: string | null = null;
  const priceStageEvent = stageEvents.find((evt) => stagePayloadToStage(evt.payload, "to_stage") === "PRICE_SENT");
  if (priceStageEvent?.created_at) {
    priceSentAt = priceStageEvent.created_at;
  } else {
    const priceMessage = messages.find((msg) => msg.direction === "OUT" && looksLikePriceMessage(String(msg.text || "")));
    if (priceMessage?.created_at) priceSentAt = priceMessage.created_at;
  }
  const priceSentDelayMinutes = minutesBetween(lead.created_at, priceSentAt);

  const suggestionUsed = events.some((evt) => evt.event_type === "SUGGESTION_USED");
  const templateUsed =
    messages.some((msg) => String(msg.template_name || "").trim().length > 0) ||
    events.some((evt) => evt.source === "OUTBOUND_TEMPLATE");
  const followUpTriggered = events.some((evt) => {
    if (evt.event_type !== "RULE_TRIGGERED" && evt.event_type !== "AUTO_STAGE_CHANGE") return false;
    const payloadText = JSON.stringify(evt.payload).toLowerCase();
    return payloadText.includes("follow_up") || payloadText.includes("follow-up") || payloadText.includes("follow up");
  });
  const videoProposed =
    stageEvents.some((evt) => stagePayloadToStage(evt.payload, "to_stage") === "VIDEO_PROPOSED") ||
    messages.some((msg) => msg.direction === "OUT" && /\b(visio|video\s*call|appel\s+vid[eé]o)\b/i.test(msg.text || ""));

  const convertedAt = lead.converted_at || null;
  const priceContextEvents = events
    .filter((evt) => {
      if (convertedAt && new Date(evt.created_at).getTime() > new Date(convertedAt).getTime()) return false;
      const payload = asObject(evt.payload);
      if (isPriceContextPayload(payload)) return true;
      return evt.event_type === "MODEL_PREDICTION";
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  let conversionProbabilityAtPrice: number | null = null;
  for (const evt of priceContextEvents) {
    conversionProbabilityAtPrice = extractProbabilityFromPayload(asObject(evt.payload));
    if (conversionProbabilityAtPrice != null) break;
  }

  const insertQ = await db.query<{
    id: string;
    lead_id: string;
    ticket_value: string | number | null;
    total_messages: number;
    first_response_delay_minutes: number | null;
    avg_response_delay_minutes: number | null;
    price_sent_delay_minutes: number | null;
    suggestion_used: boolean;
    template_used: boolean;
    follow_up_triggered: boolean;
    video_proposed: boolean;
    conversion_probability_at_price: number | null;
    country: string | null;
    created_at: string;
  }>(
    `
      insert into lead_conversion_metrics (
        lead_id,
        ticket_value,
        total_messages,
        first_response_delay_minutes,
        avg_response_delay_minutes,
        price_sent_delay_minutes,
        suggestion_used,
        template_used,
        follow_up_triggered,
        video_proposed,
        conversion_probability_at_price,
        country
      )
      values (
        $1::uuid,
        $2::numeric,
        $3::int,
        $4::int,
        $5::int,
        $6::int,
        $7::boolean,
        $8::boolean,
        $9::boolean,
        $10::boolean,
        $11::int,
        nullif(trim($12::text), '')
      )
      on conflict (lead_id)
      do update set
        ticket_value = excluded.ticket_value,
        total_messages = excluded.total_messages,
        first_response_delay_minutes = excluded.first_response_delay_minutes,
        avg_response_delay_minutes = excluded.avg_response_delay_minutes,
        price_sent_delay_minutes = excluded.price_sent_delay_minutes,
        suggestion_used = excluded.suggestion_used,
        template_used = excluded.template_used,
        follow_up_triggered = excluded.follow_up_triggered,
        video_proposed = excluded.video_proposed,
        conversion_probability_at_price = excluded.conversion_probability_at_price,
        country = excluded.country
      returning *
    `,
    [
      normalizedLeadId,
      lead.ticket_value != null
        ? Number(lead.ticket_value)
        : lead.conversion_value == null
          ? null
          : Number(lead.conversion_value),
      totalMessages,
      firstResponseDelayMinutes,
      avgResponseDelayMinutes,
      priceSentDelayMinutes,
      suggestionUsed,
      templateUsed,
      followUpTriggered,
      videoProposed,
      conversionProbabilityAtPrice,
      lead.country || null
    ]
  );

  const row = insertQ.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    ticketValue: row.ticket_value == null ? null : Number(row.ticket_value),
    totalMessages: Number(row.total_messages || 0),
    firstResponseDelayMinutes: row.first_response_delay_minutes == null ? null : Number(row.first_response_delay_minutes),
    avgResponseDelayMinutes: row.avg_response_delay_minutes == null ? null : Number(row.avg_response_delay_minutes),
    priceSentDelayMinutes: row.price_sent_delay_minutes == null ? null : Number(row.price_sent_delay_minutes),
    suggestionUsed: Boolean(row.suggestion_used),
    templateUsed: Boolean(row.template_used),
    followUpTriggered: Boolean(row.follow_up_triggered),
    videoProposed: Boolean(row.video_proposed),
    conversionProbabilityAtPrice:
      row.conversion_probability_at_price == null ? null : Number(row.conversion_probability_at_price),
    country: row.country,
    createdAt: row.created_at
  };
}

export async function getLeadConversionMetricsByLeadId(leadId: string): Promise<LeadConversionMetricsRecord | null> {
  const db = getPoolOrThrow();
  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return null;
  const q = await db.query<{
    id: string;
    lead_id: string;
    ticket_value: string | number | null;
    total_messages: number;
    first_response_delay_minutes: number | null;
    avg_response_delay_minutes: number | null;
    price_sent_delay_minutes: number | null;
    suggestion_used: boolean;
    template_used: boolean;
    follow_up_triggered: boolean;
    video_proposed: boolean;
    conversion_probability_at_price: number | null;
    country: string | null;
    created_at: string;
  }>(
    `
      select
        id,
        lead_id,
        ticket_value,
        total_messages,
        first_response_delay_minutes,
        avg_response_delay_minutes,
        price_sent_delay_minutes,
        suggestion_used,
        template_used,
        follow_up_triggered,
        video_proposed,
        conversion_probability_at_price,
        country,
        created_at
      from lead_conversion_metrics
      where lead_id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    ticketValue: row.ticket_value == null ? null : Number(row.ticket_value),
    totalMessages: Number(row.total_messages || 0),
    firstResponseDelayMinutes: row.first_response_delay_minutes == null ? null : Number(row.first_response_delay_minutes),
    avgResponseDelayMinutes: row.avg_response_delay_minutes == null ? null : Number(row.avg_response_delay_minutes),
    priceSentDelayMinutes: row.price_sent_delay_minutes == null ? null : Number(row.price_sent_delay_minutes),
    suggestionUsed: Boolean(row.suggestion_used),
    templateUsed: Boolean(row.template_used),
    followUpTriggered: Boolean(row.follow_up_triggered),
    videoProposed: Boolean(row.video_proposed),
    conversionProbabilityAtPrice:
      row.conversion_probability_at_price == null ? null : Number(row.conversion_probability_at_price),
    country: row.country,
    createdAt: row.created_at
  };
}
