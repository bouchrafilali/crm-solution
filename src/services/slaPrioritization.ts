import { getDbPool } from "../db/client.js";
import { createMlEvent } from "../db/mlRepo.js";

export type SlaStatus = "OK" | "DUE_SOON" | "BREACHED";

function toSlaStatus(value: string | null | undefined): SlaStatus {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "DUE_SOON") return "DUE_SOON";
  if (normalized === "BREACHED") return "BREACHED";
  return "OK";
}

function deriveSlaStatus(dueAtIso: string | null, nowMs: number): SlaStatus {
  if (!dueAtIso) return "OK";
  const dueMs = new Date(dueAtIso).getTime();
  if (!Number.isFinite(dueMs)) return "OK";
  if (nowMs > dueMs) return "BREACHED";
  if (dueMs - nowMs <= 5 * 60 * 1000) return "DUE_SOON";
  return "OK";
}

export async function recomputeLeadSla(leadId: string): Promise<{ slaDueAt: string | null; slaStatus: SlaStatus } | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return null;

  const leadQ = await db.query<{
    id: string;
    conversion_score: number | string | null;
    ticket_value: number | string | null;
    sla_status: string | null;
  }>(
    `
      select id, conversion_score, ticket_value, sla_status
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const lead = leadQ.rows[0];
  if (!lead) return null;

  const lastMessageQ = await db.query<{
    direction: string;
    created_at: string;
  }>(
    `
      select direction, created_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [normalizedLeadId]
  );

  const lastMessage = lastMessageQ.rows[0];
  let slaDueAt: string | null = null;
  const nowMs = Date.now();
  const conversionScore = Number(lead.conversion_score || 0);
  const ticketValue = Number(lead.ticket_value || 0);
  const highPriority = conversionScore >= 70 || ticketValue >= 3000;

  if (lastMessage && String(lastMessage.direction || "").toUpperCase() === "IN") {
    const inboundMs = new Date(lastMessage.created_at).getTime();
    if (Number.isFinite(inboundMs)) {
      slaDueAt = new Date(inboundMs + (highPriority ? 10 : 60) * 60 * 1000).toISOString();
    }
  }

  const nextStatus = deriveSlaStatus(slaDueAt, nowMs);
  const prevStatus = toSlaStatus(lead.sla_status);

  await db.query(
    `
      update whatsapp_leads
      set sla_due_at = $2::timestamptz,
          sla_status = $3::text
      where id = $1::uuid
    `,
    [normalizedLeadId, slaDueAt, nextStatus]
  );

  if (nextStatus === "BREACHED" && prevStatus !== "BREACHED") {
    await createMlEvent({
      eventType: "RULE_TRIGGERED",
      leadId: normalizedLeadId,
      source: "SYSTEM",
      payload: {
        rule_key: "sla_breached",
        category: "FOLLOW_UP",
        previous_status: prevStatus,
        sla_status: nextStatus,
        sla_due_at: slaDueAt,
        high_priority: highPriority,
        conversion_score: conversionScore,
        ticket_value: Number.isFinite(ticketValue) ? ticketValue : null,
        breached_at: new Date(nowMs).toISOString()
      }
    });
  }

  return { slaDueAt, slaStatus: nextStatus };
}

export async function recomputeSlaForPriorityLeads(limit = 200): Promise<void> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const safeLimit = Math.max(1, Math.min(500, Math.round(limit || 200)));

  const q = await db.query<{ id: string }>(
    `
      select id
      from whatsapp_leads
      where coalesce(inquiry_source, '') = 'Zoko' or coalesce(channel_type, 'API') = 'SHARED'
      order by coalesce(last_activity_at, created_at) desc
      limit $1::int
    `,
    [safeLimit]
  );

  const batchSize = 25;
  for (let i = 0; i < q.rows.length; i += batchSize) {
    const batch = q.rows.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (row) => {
        try {
          await recomputeLeadSla(row.id);
        } catch (error) {
          console.warn("[sla] recompute failed", {
            leadId: row.id,
            error
          });
        }
      })
    );
  }
}
