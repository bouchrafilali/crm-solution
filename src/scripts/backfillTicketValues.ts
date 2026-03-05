import { getDbPool } from "../db/client.js";
import { inferTicketValueForLead } from "../services/ticketValueInference.js";

async function run(): Promise<void> {
  const db = getDbPool();
  if (!db) {
    throw new Error("DATABASE_URL is not configured");
  }

  const q = await db.query<{ id: string }>(
    `
      select id
      from whatsapp_leads
      order by updated_at desc
      limit 200
    `
  );

  let computed = 0;
  let failed = 0;

  for (const row of q.rows) {
    try {
      await inferTicketValueForLead(row.id);
      computed += 1;
    } catch (error) {
      failed += 1;
      console.error("[backfill-ticket-value] failed", {
        leadId: row.id,
        error: error instanceof Error ? error.message : String(error || "unknown_error")
      });
    }
  }

  console.log(`[backfill-ticket-value] done: computed=${computed}, failed=${failed}, total=${q.rows.length}`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[backfill-ticket-value] fatal", error);
    process.exit(1);
  });
