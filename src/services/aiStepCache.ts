import { listWhatsAppLeadMessages } from "../db/whatsappLeadsRepo.js";

export type AiStepName = "stage_detection" | "strategic_advisor" | "reply_generator" | "brand_guardian";

const STEP_CACHE_TTL_MS = 5 * 60 * 1000;

type StepCacheEntry<T> = {
  value: T;
  createdAtMs: number;
};

const stepCache = new Map<string, StepCacheEntry<unknown>>();
const stepInFlight = new Map<string, Promise<unknown>>();

export function buildAiStepCacheKey(input: {
  leadId: string;
  latestMessageId: string;
  step: AiStepName;
  provider: string;
  model: string;
  promptVersion: string;
}): string {
  return [
    String(input.leadId || "").trim(),
    String(input.latestMessageId || "").trim(),
    String(input.step || "").trim(),
    String(input.provider || "").trim().toLowerCase(),
    String(input.model || "").trim().toLowerCase(),
    String(input.promptVersion || "").trim()
  ].join(":");
}

export function getAiStepCache<T>(key: string): T | null {
  const safeKey = String(key || "").trim();
  if (!safeKey) return null;
  const hit = stepCache.get(safeKey);
  if (!hit) return null;
  if (Date.now() - hit.createdAtMs > STEP_CACHE_TTL_MS) {
    stepCache.delete(safeKey);
    return null;
  }
  return hit.value as T;
}

export function setAiStepCache<T>(key: string, value: T): void {
  const safeKey = String(key || "").trim();
  if (!safeKey) return;
  stepCache.set(safeKey, { value, createdAtMs: Date.now() });
}

export function hasAiStepInFlight(key: string): boolean {
  const safeKey = String(key || "").trim();
  if (!safeKey) return false;
  return stepInFlight.has(safeKey);
}

export async function runAiStepSingleFlight<T>(
  key: string,
  compute: () => Promise<T>
): Promise<{ value: T; joined: boolean }> {
  const safeKey = String(key || "").trim();
  if (!safeKey) {
    const value = await compute();
    return { value, joined: false };
  }

  const existing = stepInFlight.get(safeKey);
  if (existing) {
    const value = await (existing as Promise<T>);
    return { value, joined: true };
  }

  const work = Promise.resolve().then(compute);
  stepInFlight.set(safeKey, work as Promise<unknown>);
  try {
    const value = await work;
    return { value, joined: false };
  } finally {
    const current = stepInFlight.get(safeKey);
    if (current === (work as Promise<unknown>)) {
      stepInFlight.delete(safeKey);
    }
  }
}

export async function resolveLatestMessageIdForLead(leadId: string): Promise<string | null> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) return null;
  let rows: Array<{ id: string }>;
  try {
    rows = await listWhatsAppLeadMessages(safeLeadId, { limit: 1, order: "desc" });
  } catch {
    return null;
  }
  const latest = rows[0];
  if (!latest || !latest.id) return null;
  const id = String(latest.id || "").trim();
  return id || null;
}
