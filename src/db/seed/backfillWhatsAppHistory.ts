import "dotenv/config";
import { env } from "../../config/env.js";
import { initDb } from "../client.js";
import { syncZokoConversationHistory } from "../../services/zokoConversationSync.js";

async function main(): Promise<void> {
  const nodeEnv = String(env.NODE_ENV || "development").toLowerCase();
  const confirm = String(process.env.BACKFILL_CONFIRM || "").toLowerCase();
  if (nodeEnv === "production") throw new Error("Backfill désactivé en production.");
  if (!["yes", "true", "1"].includes(confirm)) {
    throw new Error("Ajoute BACKFILL_CONFIRM=yes pour lancer le backfill.");
  }

  const baseUrl = String(env.ZOKO_HISTORY_API_URL || "").trim();
  if (!baseUrl) {
    throw new Error("ZOKO_HISTORY_API_URL manquant dans .env");
  }

  await initDb();
  const maxPages = Math.max(1, Math.min(200, Number(process.env.BACKFILL_MAX_PAGES || 20)));
  const result = await syncZokoConversationHistory({ maxPages });

  // eslint-disable-next-line no-console
  console.log(
    `[backfill:whatsapp-history] done pages=${result.pages} rows=${result.rows} leads_upserted=${result.leadsUpserted} messages_imported=${result.messagesImported}`
  );
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[backfill:whatsapp-history] failed", error);
  process.exitCode = 1;
});
