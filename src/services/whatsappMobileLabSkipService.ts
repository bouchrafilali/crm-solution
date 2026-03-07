import {
  clearSkippedMobileLabItemRecord,
  listActiveSkippedMobileLabItems,
  skipMobileLabItemRecord,
  type MobileLabFeedType,
  type MobileLabSkipRecord
} from "../db/whatsappMobileLabSkipRepo.js";

export type SkipMode = "1_hour" | "later_today" | "tomorrow" | "custom";

export class MobileLabSkipError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type SkipDeps = {
  saveSkip: (input: { leadId: string; feedType: MobileLabFeedType; skippedUntil: string; reason?: string | null }) => Promise<MobileLabSkipRecord>;
  clearSkip: (input: { leadId: string; feedType: MobileLabFeedType }) => Promise<boolean>;
  listActive: (nowIso?: string) => Promise<MobileLabSkipRecord[]>;
  now: () => Date;
};

function defaultDeps(): SkipDeps {
  return {
    saveSkip: (input) => skipMobileLabItemRecord(input),
    clearSkip: (input) => clearSkippedMobileLabItemRecord(input),
    listActive: (nowIso) => listActiveSkippedMobileLabItems(nowIso),
    now: () => new Date()
  };
}

function ensureFeedType(value: unknown): MobileLabFeedType {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "active" || normalized === "reactivation") return normalized;
  throw new MobileLabSkipError("mobile_lab_skip_invalid_feed_type", "feedType must be active or reactivation");
}

function resolveSkippedUntil(input: {
  mode: SkipMode;
  customUntil?: string | null;
  now: Date;
}): string {
  const nowMs = input.now.getTime();

  if (input.mode === "1_hour") {
    return new Date(nowMs + 3600000).toISOString();
  }

  if (input.mode === "later_today") {
    const endOfDay = new Date(nowMs);
    endOfDay.setUTCHours(23, 59, 59, 999);
    if (endOfDay.getTime() <= nowMs) {
      return new Date(nowMs + 3600000).toISOString();
    }
    return endOfDay.toISOString();
  }

  if (input.mode === "tomorrow") {
    const endOfTomorrow = new Date(nowMs);
    endOfTomorrow.setUTCDate(endOfTomorrow.getUTCDate() + 1);
    endOfTomorrow.setUTCHours(23, 59, 59, 999);
    return endOfTomorrow.toISOString();
  }

  if (input.mode === "custom") {
    const custom = String(input.customUntil || "").trim();
    const parsedMs = custom ? new Date(custom).getTime() : NaN;
    if (!Number.isFinite(parsedMs)) {
      throw new MobileLabSkipError("mobile_lab_skip_invalid_custom_until", "customUntil must be a valid ISO timestamp");
    }
    if (parsedMs <= nowMs) {
      throw new MobileLabSkipError("mobile_lab_skip_invalid_custom_until", "customUntil must be in the future");
    }
    return new Date(parsedMs).toISOString();
  }

  throw new MobileLabSkipError("mobile_lab_skip_invalid_mode", "Unsupported skip mode");
}

export async function skipMobileLabItem(
  input: {
    leadId: string;
    feedType: MobileLabFeedType;
    mode: SkipMode;
    customUntil?: string | null;
    reason?: string | null;
  },
  depsOverride?: Partial<SkipDeps>
): Promise<{ ok: true; leadId: string; feedType: MobileLabFeedType; skippedUntil: string }> {
  const deps: SkipDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  const leadId = String(input.leadId || "").trim();
  if (!leadId) {
    throw new MobileLabSkipError("mobile_lab_skip_invalid_lead_id", "leadId is required");
  }
  const feedType = ensureFeedType(input.feedType);
  const mode = String(input.mode || "").trim() as SkipMode;
  if (!mode) {
    throw new MobileLabSkipError("mobile_lab_skip_invalid_mode", "mode is required");
  }

  const skippedUntil = resolveSkippedUntil({
    mode,
    customUntil: input.customUntil ?? null,
    now: deps.now()
  });

  const row = await deps.saveSkip({
    leadId,
    feedType,
    skippedUntil,
    reason: input.reason ?? null
  });

  return {
    ok: true,
    leadId: row.leadId,
    feedType: row.feedType,
    skippedUntil: row.skippedUntil
  };
}

export async function clearSkippedMobileLabItem(
  input: { leadId: string; feedType: MobileLabFeedType },
  depsOverride?: Partial<SkipDeps>
): Promise<{ ok: true }> {
  const deps: SkipDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  const leadId = String(input.leadId || "").trim();
  if (!leadId) {
    throw new MobileLabSkipError("mobile_lab_unskip_invalid_lead_id", "leadId is required");
  }
  const feedType = ensureFeedType(input.feedType);
  await deps.clearSkip({ leadId, feedType });
  return { ok: true };
}

export async function listActiveSkippedItems(depsOverride?: Partial<SkipDeps>): Promise<MobileLabSkipRecord[]> {
  const deps: SkipDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  return deps.listActive(deps.now().toISOString());
}
