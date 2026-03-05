import { getDbPool, isDbEnabled } from "../db/client.js";
import { createMlEvent } from "../db/mlRepo.js";
import { createSuggestionFeedbackDraft } from "../db/whatsappSuggestionFeedbackRepo.js";

const RULE_KEY = "auto_24h_followup";
const SUGGESTION_TYPE = "FOLLOW_UP_24H_SOFT";
const DEFAULT_TEXT =
  "Bonjour, je me permets un suivi discret concernant votre projet. Si vous le souhaitez, je peux vous guider sur la prochaine étape en toute simplicité.";

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

export async function runAuto24hFollowupRuleForLead(leadId: string): Promise<{ triggered: boolean; reason?: string }> {
  const db = getPoolOrThrow();
  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return { triggered: false, reason: "invalid_lead_id" };

  const leadQ = await db.query<{
    id: string;
    stage: string;
    conversion_score: number | string | null;
    country: string | null;
  }>(
    `
      select id, stage, conversion_score, country
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const lead = leadQ.rows[0];
  if (!lead) return { triggered: false, reason: "lead_not_found" };
  if (String(lead.stage || "").toUpperCase() !== "PRICE_SENT") return { triggered: false, reason: "stage_not_price_sent" };

  const score = Number(lead.conversion_score || 0);
  if (!Number.isFinite(score) || score <= 50) return { triggered: false, reason: "low_conversion_score" };

  const lastInboundQ = await db.query<{ last_inbound_at: string | null }>(
    `
      select max(created_at) as last_inbound_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
        and direction = 'IN'
    `,
    [normalizedLeadId]
  );
  const lastInboundAt = lastInboundQ.rows[0]?.last_inbound_at || null;
  if (!lastInboundAt) return { triggered: false, reason: "no_inbound_found" };
  const sinceLastInboundMs = Date.now() - new Date(lastInboundAt).getTime();
  if (!Number.isFinite(sinceLastInboundMs) || sinceLastInboundMs < 24 * 3600000) {
    return { triggered: false, reason: "inbound_recent_lt_24h" };
  }

  const dedupeQ = await db.query<{ already_triggered: boolean; already_suggested: boolean }>(
    `
      select
        exists(
          select 1
          from ml_events
          where lead_id = $1::uuid
            and event_type = 'RULE_TRIGGERED'
            and coalesce(payload->>'rule_key', '') = $2::text
            and created_at >= now() - interval '24 hours'
        ) as already_triggered,
        exists(
          select 1
          from whatsapp_suggestion_feedback
          where lead_id = $1::uuid
            and source = 'rules_suggest_reply'
            and coalesce(lower(suggestion_type), '') = lower($3::text)
            and created_at >= now() - interval '24 hours'
            and review_status <> 'ARCHIVED'
        ) as already_suggested
    `,
    [normalizedLeadId, RULE_KEY, SUGGESTION_TYPE]
  );
  if (dedupeQ.rows[0]?.already_triggered || dedupeQ.rows[0]?.already_suggested) {
    return { triggered: false, reason: "already_triggered_recently" };
  }

  const suggestionText = DEFAULT_TEXT;
  const suggestionId = await createSuggestionFeedbackDraft({
    leadId: normalizedLeadId,
    source: "rules_suggest_reply",
    suggestionType: SUGGESTION_TYPE,
    suggestionText,
    suggestionPayload: {
      category: "FOLLOW_UP",
      rule_key: RULE_KEY,
      trigger: {
        stage: "PRICE_SENT",
        no_inbound_hours: Math.floor(sinceLastInboundMs / 3600000),
        conversion_score: Math.round(score)
      }
    }
  });

  await createMlEvent({
    eventType: "RULE_TRIGGERED",
    leadId: normalizedLeadId,
    source: "SYSTEM",
    payload: {
      category: "FOLLOW_UP",
      rule_key: RULE_KEY,
      suggestion_id: suggestionId || null,
      suggestion_type: SUGGESTION_TYPE,
      no_inbound_hours: Math.floor(sinceLastInboundMs / 3600000),
      conversion_score: Math.round(score),
      country: lead.country || null
    }
  });

  return { triggered: true };
}

export async function runAuto24hFollowupRuleTick(limit = 300): Promise<{ scanned: number; triggered: number }> {
  const db = getPoolOrThrow();
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 300)));
  const q = await db.query<{ id: string }>(
    `
      select id
      from whatsapp_leads
      where stage = 'PRICE_SENT'
        and coalesce(conversion_score, 0) > 50
      order by coalesce(conversion_score, 0) desc, updated_at desc
      limit $1::int
    `,
    [safeLimit]
  );
  let triggered = 0;
  for (const row of q.rows) {
    const result = await runAuto24hFollowupRuleForLead(row.id);
    if (result.triggered) triggered += 1;
  }
  return { scanned: q.rows.length, triggered };
}

let workerStarted = false;

export function startAuto24hFollowupWorker(): void {
  if (workerStarted) return;
  if (!isDbEnabled()) return;
  workerStarted = true;
  const intervalMs = 30 * 60 * 1000;

  void runAuto24hFollowupRuleTick().catch((error) => {
    console.error("[followup-rule] startup tick failed", error);
  });

  setInterval(() => {
    void runAuto24hFollowupRuleTick().catch((error) => {
      console.error("[followup-rule] tick failed", error);
    });
  }, intervalMs);

  console.log("[followup-rule] worker started (every 30 minutes)");
}
