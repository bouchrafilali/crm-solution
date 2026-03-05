import { getDbPool } from "../db/client.js";
import { computeConversionScore } from "../services/conversionScore.js";

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
      await computeConversionScore(row.id);
      computed += 1;
    } catch (error) {
      failed += 1;
      console.error("[backfill-conversion-score] failed", {
        leadId: row.id,
        error: error instanceof Error ? error.message : String(error || "unknown_error")
      });
    }
  }

  console.log(`[backfill-conversion-score] done: computed=${computed}, failed=${failed}, total=${q.rows.length}`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[backfill-conversion-score] fatal", error);
    process.exit(1);
  });
