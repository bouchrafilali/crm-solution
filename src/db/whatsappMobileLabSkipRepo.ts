import { getDbPool } from "./client.js";

export type MobileLabFeedType = "active" | "reactivation";

export type MobileLabSkipRecord = {
  leadId: string;
  feedType: MobileLabFeedType;
  skippedUntil: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

export async function skipMobileLabItemRecord(input: {
  leadId: string;
  feedType: MobileLabFeedType;
  skippedUntil: string;
  reason?: string | null;
}): Promise<MobileLabSkipRecord> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    feed_type: MobileLabFeedType;
    skipped_until: string;
    reason: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      insert into whatsapp_mobile_lab_skips (
        lead_id, feed_type, skipped_until, reason
      )
      values (
        $1::uuid,
        $2::text,
        $3::timestamptz,
        nullif(trim($4::text), '')
      )
      on conflict (lead_id, feed_type)
      do update set
        skipped_until = excluded.skipped_until,
        reason = excluded.reason,
        updated_at = now()
      returning lead_id, feed_type, skipped_until, reason, created_at, updated_at
    `,
    [input.leadId, input.feedType, input.skippedUntil, input.reason ?? null]
  );
  const row = q.rows[0];
  return {
    leadId: row.lead_id,
    feedType: row.feed_type,
    skippedUntil: row.skipped_until,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function clearSkippedMobileLabItemRecord(input: {
  leadId: string;
  feedType: MobileLabFeedType;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      delete from whatsapp_mobile_lab_skips
      where lead_id = $1::uuid
        and feed_type = $2::text
    `,
    [input.leadId, input.feedType]
  );
  return (q.rowCount || 0) > 0;
}

export async function listActiveSkippedMobileLabItems(nowIso = new Date().toISOString()): Promise<MobileLabSkipRecord[]> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    feed_type: MobileLabFeedType;
    skipped_until: string;
    reason: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select lead_id, feed_type, skipped_until, reason, created_at, updated_at
      from whatsapp_mobile_lab_skips
      where skipped_until > $1::timestamptz
      order by skipped_until desc, updated_at desc
    `,
    [nowIso]
  );
  return q.rows.map((row) => ({
    leadId: row.lead_id,
    feedType: row.feed_type,
    skippedUntil: row.skipped_until,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}
