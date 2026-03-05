import { env } from "../config/env.js";
import { syncZokoConversationHistory } from "./zokoConversationSync.js";

let started = false;
let inFlight = false;

function envFlag(raw: unknown, fallback: boolean): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function toPositiveInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function runSyncTick(maxPages: number): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const result = await syncZokoConversationHistory({ maxPages });
    console.log(
      `[zoko-sync] ok pages=${result.pages} rows=${result.rows} leads=${result.leadsUpserted} messages=${result.messagesImported} nextCursor=${result.nextCursor || "-"}`
    );
  } catch (error) {
    console.error("[zoko-sync] failed", error);
  } finally {
    inFlight = false;
  }
}

export function startZokoHistorySyncWorker(): void {
  if (started) return;
  started = true;

  const historyUrl = String(env.ZOKO_HISTORY_API_URL || "").trim();
  if (!historyUrl) {
    console.log("[zoko-sync] disabled: ZOKO_HISTORY_API_URL is missing");
    return;
  }
  const authToken = String(env.ZOKO_AUTH_TOKEN || "").trim();
  if (!authToken) {
    console.log("[zoko-sync] disabled: ZOKO_AUTH_TOKEN is missing");
    return;
  }

  const maxPages = toPositiveInt(env.ZOKO_HISTORY_SYNC_MAX_PAGES, 40, 1, 100);
  const intervalMinutes = toPositiveInt(env.ZOKO_HISTORY_SYNC_INTERVAL_MINUTES, 10, 1, 24 * 60);
  const runOnStartup = envFlag(env.ZOKO_HISTORY_SYNC_ON_STARTUP, true);

  if (runOnStartup) {
    void runSyncTick(maxPages);
  } else {
    console.log("[zoko-sync] startup catch-up disabled");
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  setInterval(() => {
    void runSyncTick(maxPages);
  }, intervalMs);

  console.log(`[zoko-sync] worker started (every ${intervalMinutes} min, maxPages=${maxPages})`);
}
