import { getDbPool } from "../db/client.js";

type LeadRow = {
  id: string;
  stage: string;
  event_date: string | null;
  ship_city: string | null;
  ship_region: string | null;
  ship_country: string | null;
  ship_destination_text: string | null;
  last_message_at: string | null;
  lead_json: Record<string, unknown>;
};

type MessageRow = {
  direction: string;
  text: string;
  created_at: string;
};

export type ConversionScoreResult = {
  score: number;
  factors: Record<string, number>;
};

export type ConversionScoreDebugResult = {
  score: number;
  factors: Record<string, number>;
  lastSignals: {
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    eventDate: string | null;
    destination: string | null;
  };
  computedAt: string | null;
};

let scoringTableEnsured = false;

async function ensureLeadScoringFactorsTable(): Promise<void> {
  if (scoringTableEnsured) return;
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  await db.query(`
    create table if not exists lead_scoring_factors (
      lead_id uuid primary key references whatsapp_leads(id) on delete cascade,
      score int not null default 0,
      factors jsonb not null default '{}'::jsonb,
      computed_at timestamptz not null default now()
    )
  `);
  await db.query(
    "create index if not exists idx_lead_scoring_factors_computed_at on lead_scoring_factors(computed_at desc)"
  );
  scoringTableEnsured = true;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  const normalized = String(text || "").toLowerCase();
  return patterns.some((pattern) => pattern.test(normalized));
}

function resolveEventDate(lead: LeadRow): string | null {
  const qEvent = String(lead?.lead_json?.qualification_event_date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(qEvent)) return qEvent;
  const eventDate = String(lead?.event_date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return eventDate;
  return null;
}

function eventDatePoints(eventDate: string | null): number {
  if (!eventDate) return 0;
  const target = new Date(eventDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(target)) return 0;
  const diffDays = (target - Date.now()) / 86400000;
  if (diffDays < 0) return 0;
  if (diffDays <= 14) return 40;
  if (diffDays <= 30) return 30;
  return 0;
}

function hasShippingIntent(messages: MessageRow[]): boolean {
  const patterns = [
    /\bdeliver\b/,
    /\bdelivery\b/,
    /\bship\b/,
    /\bgermany\b/,
    /\bfrance\b/,
    /\bparis\b/,
    /\badresse\b/,
    /\blivraison\b/
  ];
  return messages.some((m) => String(m.direction || "").toUpperCase() === "IN" && includesAny(m.text, patterns));
}

function hasInboundToOutboundReplyWithin5Min(messages: MessageRow[]): boolean {
  const ordered = messages
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((m) => ({ ...m, direction: String(m.direction || "").toUpperCase() }));

  for (let i = 0; i < ordered.length; i += 1) {
    const inbound = ordered[i];
    if (inbound.direction !== "IN") continue;
    const inboundTs = new Date(inbound.created_at).getTime();
    if (!Number.isFinite(inboundTs)) continue;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const next = ordered[j];
      const nextTs = new Date(next.created_at).getTime();
      if (!Number.isFinite(nextTs) || nextTs < inboundTs) continue;
      if (next.direction === "IN") break;
      if (next.direction === "OUT") {
        const diffMinutes = (nextTs - inboundTs) / 60000;
        if (diffMinutes <= 5) return true;
        break;
      }
    }
  }
  return false;
}

function hasDepositMention(messages: MessageRow[]): boolean {
  const patterns = [/\bdeposit\b/, /\bacompte\b/, /\badvance\b/, /\bvirement\b/, /\bpayer\b/];
  return messages.some((m) => includesAny(m.text, patterns));
}

function hasVideoProposed(messages: MessageRow[]): boolean {
  const patterns = [/\bvideo\b/, /\bvisio\b/];
  return messages.some((m) => String(m.direction || "").toUpperCase() === "OUT" && includesAny(m.text, patterns));
}

function hasNoReply48h(messages: MessageRow[], leadLastMessageAt: string | null): boolean {
  const ordered = messages
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((m) => ({ ...m, direction: String(m.direction || "").toUpperCase() }));
  const last = ordered[ordered.length - 1];
  if (!last || last.direction !== "IN") return false;
  const ref = String(leadLastMessageAt || last.created_at || "").trim();
  const refTs = new Date(ref).getTime();
  if (!Number.isFinite(refTs)) return false;
  return Date.now() - refTs > 48 * 3600000;
}

function hasPriceObjection(messages: MessageRow[]): boolean {
  const patterns = [/\btoo\s+expensive\b/, /\bcher\b/, /\bbudget\b/, /\bprix\s+[ée]lev[ée]\b/, /\bexpensive\b/];
  return messages.some((m) => includesAny(m.text, patterns));
}

function buildDestination(lead: LeadRow): string | null {
  const direct = String(lead.ship_destination_text || "").trim();
  if (direct) return direct;
  const parts = [lead.ship_city, lead.ship_region, lead.ship_country]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export async function computeConversionScore(leadId: string): Promise<ConversionScoreResult | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  await ensureLeadScoringFactorsTable();
  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return null;

  const leadQ = await db.query<LeadRow>(
    `
      select
        id,
        stage,
        event_date::text as event_date,
        ship_city,
        ship_region,
        ship_country,
        ship_destination_text,
        last_message_at,
        to_jsonb(whatsapp_leads) as lead_json
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const lead = leadQ.rows[0];
  if (!lead) return null;

  const messagesQ = await db.query<MessageRow>(
    `
      select direction, text, created_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
      order by created_at asc
    `,
    [normalizedLeadId]
  );
  const messages = messagesQ.rows || [];

  const factors: Record<string, number> = {};
  const eventDate = resolveEventDate(lead);
  const eventPts = eventDatePoints(eventDate);
  if (eventPts > 0) factors[eventPts === 40 ? "event_date_within_14d" : "event_date_within_30d"] = eventPts;
  if (hasShippingIntent(messages)) factors.shipping_intent = 20;
  if (hasInboundToOutboundReplyWithin5Min(messages)) factors.fast_reply_5m = 20;
  if (hasDepositMention(messages)) factors.deposit_mentioned = 15;
  if (hasVideoProposed(messages)) factors.video_proposed = 10;
  if (hasNoReply48h(messages, lead.last_message_at)) factors.no_reply_48h = -20;
  if (hasPriceObjection(messages)) factors.price_objection = -30;

  const rawScore = Object.values(factors).reduce((sum, points) => sum + Number(points || 0), 0);
  const score = clampScore(rawScore);

  await db.query(
    `
      update whatsapp_leads
      set conversion_score = $2::int,
          updated_at = now()
      where id = $1::uuid
    `,
    [normalizedLeadId, score]
  );

  await db.query(
    `
      insert into lead_scoring_factors (lead_id, score, factors, computed_at)
      values ($1::uuid, $2::int, $3::jsonb, now())
      on conflict (lead_id)
      do update set
        score = excluded.score,
        factors = excluded.factors,
        computed_at = now()
    `,
    [normalizedLeadId, score, JSON.stringify(factors)]
  );

  return { score, factors };
}

export async function getConversionScoreDebug(leadId: string): Promise<ConversionScoreDebugResult | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  await ensureLeadScoringFactorsTable();
  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return null;

  const leadQ = await db.query<LeadRow>(
    `
      select
        id,
        stage,
        event_date::text as event_date,
        ship_city,
        ship_region,
        ship_country,
        ship_destination_text,
        last_message_at,
        to_jsonb(whatsapp_leads) as lead_json
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const lead = leadQ.rows[0];
  if (!lead) return null;

  const [latestFactorsQ, lastSignalsQ] = await Promise.all([
    db.query<{ score: number | string; factors: unknown; computed_at: string }>(
      `
        select score, factors, computed_at
        from lead_scoring_factors
        where lead_id = $1::uuid
        limit 1
      `,
      [normalizedLeadId]
    ),
    db.query<{ last_inbound_at: string | null; last_outbound_at: string | null }>(
      `
        select
          max(case when direction = 'IN' then created_at end) as last_inbound_at,
          max(case when direction = 'OUT' then created_at end) as last_outbound_at
        from whatsapp_lead_messages
        where lead_id = $1::uuid
      `,
      [normalizedLeadId]
    )
  ]);

  const latestFactors = latestFactorsQ.rows[0];
  if (!latestFactors) {
    const computed = await computeConversionScore(normalizedLeadId);
    return {
      score: computed?.score ?? 0,
      factors: computed?.factors ?? {},
      lastSignals: {
        lastInboundAt: lastSignalsQ.rows[0]?.last_inbound_at || null,
        lastOutboundAt: lastSignalsQ.rows[0]?.last_outbound_at || null,
        eventDate: resolveEventDate(lead),
        destination: buildDestination(lead)
      },
      computedAt: null
    };
  }

  const factors =
    latestFactors.factors && typeof latestFactors.factors === "object" && !Array.isArray(latestFactors.factors)
      ? (latestFactors.factors as Record<string, number>)
      : {};

  return {
    score: Math.max(0, Math.min(100, Math.round(Number(latestFactors.score || 0)))),
    factors,
    lastSignals: {
      lastInboundAt: lastSignalsQ.rows[0]?.last_inbound_at || null,
      lastOutboundAt: lastSignalsQ.rows[0]?.last_outbound_at || null,
      eventDate: resolveEventDate(lead),
      destination: buildDestination(lead)
    },
    computedAt: latestFactors.computed_at || null
  };
}
