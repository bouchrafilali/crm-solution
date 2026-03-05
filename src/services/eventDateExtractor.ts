export type EventDateInputMessage = {
  id: string;
  text: string;
  createdAt: string;
};

export type EventDatePrecision = "DAY" | "MONTH" | "UNKNOWN";

export type EventDateExtraction = {
  date: string | null;
  raw: string | null;
  confidence: number;
  sourceMessageId: string | null;
  eventMonth: number | null;
  eventDatePrecision: EventDatePrecision;
  eventDateEstimateIso: string | null;
};

type Candidate = {
  date: string | null;
  raw: string;
  confidence: number;
  eventMonth: number | null;
  precision: EventDatePrecision;
  eventDateEstimateIso: string | null;
};

const EN_MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12
};

const FR_MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  "février": 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  "août": 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  "décembre": 12
};

function toYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function makeUtcDate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

function normalizeYear(twoOrFour: number, nowYear: number): number {
  if (twoOrFour >= 1000) return twoOrFour;
  const century = Math.floor(nowYear / 100) * 100;
  return century + twoOrFour;
}

function withMissingYearRule(now: Date, month: number, day: number): Date | null {
  const nowYear = now.getUTCFullYear();
  const candidate = makeUtcDate(nowYear, month, day);
  if (!candidate) return null;
  const nowStart = makeUtcDate(nowYear, now.getUTCMonth() + 1, now.getUTCDate());
  if (nowStart && candidate.getTime() < nowStart.getTime()) {
    return makeUtcDate(nowYear + 1, month, day);
  }
  return candidate;
}

function dateFromParts(now: Date, month: number, day: number, yearRaw?: string): Date | null {
  if (!month || !day) return null;
  if (yearRaw && yearRaw.trim()) {
    const y = normalizeYear(Number(yearRaw), now.getUTCFullYear());
    return makeUtcDate(y, month, day);
  }
  return withMissingYearRule(now, month, day);
}

function addDaysUtc(base: Date, days: number): Date {
  const out = new Date(base.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function nextWeekdayUtc(base: Date, weekday: number): Date {
  const current = base.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDaysUtc(base, delta);
}

function monthEstimateIso(now: Date, month: number): string {
  let year = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  if (month < currentMonth) year += 1;
  return `${String(year)}-${String(month).padStart(2, "0")}-01`;
}

function detectMonthFromText(text: string): { month: number | null; raw: string | null } {
  const src = String(text || "");
  const lower = src.toLowerCase();
  const map = { ...EN_MONTHS, ...FR_MONTHS };
  for (const [token, month] of Object.entries(map)) {
    const re = new RegExp("(^|[^a-zA-Z\\u00C0-\\u017F])" + token + "([^a-zA-Z\\u00C0-\\u017F]|$)", "i");
    const m = lower.match(re);
    if (m) return { month, raw: token };
  }
  return { month: null, raw: null };
}

export function inferEventDateFacts(input: {
  eventDate?: string | null;
  eventDateText?: string | null;
  nowInput?: Date;
}): {
  event_month: number | null;
  event_date_precision: EventDatePrecision;
  event_date_estimate_iso: string | null;
} {
  const now = input.nowInput instanceof Date ? input.nowInput : new Date();
  const eventDate = String(input.eventDate || "").trim();
  if (eventDate) {
    const d = new Date(eventDate);
    if (!Number.isNaN(d.getTime())) {
      return {
        event_month: d.getUTCMonth() + 1,
        event_date_precision: "DAY",
        event_date_estimate_iso: null
      };
    }
  }

  const monthDetected = detectMonthFromText(String(input.eventDateText || ""));
  if (monthDetected.month) {
    return {
      event_month: monthDetected.month,
      event_date_precision: "MONTH",
      event_date_estimate_iso: monthEstimateIso(now, monthDetected.month)
    };
  }

  return {
    event_month: null,
    event_date_precision: "UNKNOWN",
    event_date_estimate_iso: null
  };
}

function guessLocale(text: string): "FR" | "EN" {
  const lower = text.toLowerCase();
  if (/(\bpour\b|\bsemaine\b|\bdans\b|\bprochain\b|\bvendredi\b|\bmars\b|\bavril\b)/i.test(lower)) {
    return "FR";
  }
  return "EN";
}

function extractFromText(text: string, now: Date, locale: "FR" | "EN"): Candidate[] {
  const out: Candidate[] = [];
  const src = String(text || "");
  const lower = src.toLowerCase();

  const pushDay = (date: Date, raw: string, confidence: number, month: number | null) => {
    out.push({
      date: toYmd(date),
      raw,
      confidence,
      eventMonth: month,
      precision: "DAY",
      eventDateEstimateIso: null
    });
  };

  const enMonthDay = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:[\s,]+(\d{2,4}))?/gi;
  for (const match of src.matchAll(enMonthDay)) {
    const month = EN_MONTHS[String(match[1] || "").toLowerCase()];
    const day = Number(match[2]);
    const d = dateFromParts(now, month, day, match[3]);
    if (!d) continue;
    pushDay(d, String(match[0] || "").trim(), 90, month);
  }

  const enDayMonth = /\b(\d{1,2})\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:[\s,]+(\d{2,4}))?/gi;
  for (const match of src.matchAll(enDayMonth)) {
    const day = Number(match[1]);
    const month = EN_MONTHS[String(match[2] || "").toLowerCase()];
    const d = dateFromParts(now, month, day, match[3]);
    if (!d) continue;
    pushDay(d, String(match[0] || "").trim(), 90, month);
  }

  const frDayMonth = /\b(\d{1,2})\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)(?:[\s,]+(\d{2,4}))?/gi;
  for (const match of src.matchAll(frDayMonth)) {
    const day = Number(match[1]);
    const month = FR_MONTHS[String(match[2] || "").toLowerCase()];
    const d = dateFromParts(now, month, day, match[3]);
    if (!d) continue;
    pushDay(d, String(match[0] || "").trim(), 90, month);
  }

  const numeric = /\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/g;
  for (const match of src.matchAll(numeric)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    let day = a;
    let month = b;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a;
    } else if (locale === "EN") {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }

    const d = dateFromParts(now, month, day, match[3]);
    if (!d) continue;
    pushDay(d, String(match[0] || "").trim(), 85, month);
  }

  if (/\bnext week\b/i.test(lower) || /\bla semaine prochaine\b/i.test(lower)) {
    const d = addDaysUtc(now, 7);
    pushDay(d, /next week/i.test(lower) ? "next week" : "la semaine prochaine", 60, d.getUTCMonth() + 1);
  }

  if (/\btoday\b/i.test(lower) || /\baujourd['’]hui\b/i.test(lower)) {
    const d = now;
    pushDay(d, /\btoday\b/i.test(lower) ? "today" : "aujourd'hui", 70, d.getUTCMonth() + 1);
  }
  if (/\btomorrow\b/i.test(lower) || /\bdemain\b/i.test(lower)) {
    const d = addDaysUtc(now, 1);
    pushDay(d, /\btomorrow\b/i.test(lower) ? "tomorrow" : "demain", 70, d.getUTCMonth() + 1);
  }
  if (/\bday after tomorrow\b/i.test(lower) || /\bapres[-\s]?demain\b/i.test(lower) || /\baprès[-\s]?demain\b/i.test(lower)) {
    const d = addDaysUtc(now, 2);
    pushDay(d, /\bday after tomorrow\b/i.test(lower) ? "day after tomorrow" : "après-demain", 70, d.getUTCMonth() + 1);
  }

  const inWeeks = lower.match(/\bin\s+(\d{1,2})\s+weeks?\b/i) || lower.match(/\bdans\s+(\d{1,2})\s+semaines?\b/i);
  if (inWeeks) {
    const count = Number(inWeeks[1]);
    if (Number.isFinite(count) && count > 0 && count < 53) {
      const d = addDaysUtc(now, count * 7);
      pushDay(d, inWeeks[0], 60, d.getUTCMonth() + 1);
    }
  }

  const inDays = lower.match(/\bin\s+(\d{1,3})\s+days?\b/i) || lower.match(/\bdans\s+(\d{1,3})\s+jours?\b/i);
  if (inDays) {
    const count = Number(inDays[1]);
    if (Number.isFinite(count) && count > 0 && count <= 366) {
      const d = addDaysUtc(now, count);
      pushDay(d, inDays[0], 70, d.getUTCMonth() + 1);
    }
  }

  const weekdayMap: Array<{ re: RegExp; day: number }> = [
    { re: /\bnext monday\b/i, day: 1 },
    { re: /\bnext tuesday\b/i, day: 2 },
    { re: /\bnext wednesday\b/i, day: 3 },
    { re: /\bnext thursday\b/i, day: 4 },
    { re: /\bnext friday\b/i, day: 5 },
    { re: /\bnext saturday\b/i, day: 6 },
    { re: /\bnext sunday\b/i, day: 0 },
    { re: /\blundi\s+prochain(?:e)?\b/i, day: 1 },
    { re: /\bmardi\s+prochain(?:e)?\b/i, day: 2 },
    { re: /\bmercredi\s+prochain(?:e)?\b/i, day: 3 },
    { re: /\bjeudi\s+prochain(?:e)?\b/i, day: 4 },
    { re: /\bvendredi\s+prochain(?:e)?\b/i, day: 5 },
    { re: /\bsamedi\s+prochain(?:e)?\b/i, day: 6 },
    { re: /\bdimanche\s+prochain(?:e)?\b/i, day: 0 }
  ];

  for (const it of weekdayMap) {
    const m = lower.match(it.re);
    if (m) {
      const d = nextWeekdayUtc(now, it.day);
      pushDay(d, m[0], 65, d.getUTCMonth() + 1);
    }
  }

  if (/\bthis weekend\b/i.test(lower) || /\bce week[- ]?end\b/i.test(lower)) {
    const d = nextWeekdayUtc(now, 6);
    pushDay(d, /this weekend/i.test(lower) ? "this weekend" : "ce week-end", 60, d.getUTCMonth() + 1);
  }

  // Month-level extraction (non-blocking precision): only when no explicit day is present.
  const monthToken = detectMonthFromText(src);
  if (monthToken.month) {
    const hasExplicitDay = /(\b\d{1,2}\b\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b)|(\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+\d{1,2}\b)/i.test(src);
    if (!hasExplicitDay) {
      out.push({
        date: null,
        raw: String(monthToken.raw || "").trim() || "month",
        confidence: 72,
        eventMonth: monthToken.month,
        precision: "MONTH",
        eventDateEstimateIso: monthEstimateIso(now, monthToken.month)
      });
    }
  }

  return out;
}

export function extractEventDateFromMessages(
  messages: EventDateInputMessage[],
  nowInput?: Date,
  _timezone?: string
): EventDateExtraction {
  const now = nowInput instanceof Date ? nowInput : new Date();
  const safeMessages = Array.isArray(messages) ? messages : [];
  let best: (Candidate & { sourceMessageId: string; createdAtMs: number }) | null = null;

  for (const msg of safeMessages) {
    try {
      const text = String(msg?.text || "");
      if (!text.trim()) continue;
      const locale = guessLocale(text);
      const candidates = extractFromText(text, now, locale);
      const createdAtMs = new Date(String(msg?.createdAt || "")).getTime();
      for (const c of candidates) {
        if (
          !best ||
          c.confidence > best.confidence ||
          (c.confidence === best.confidence && (createdAtMs || 0) > (best.createdAtMs || 0))
        ) {
          best = {
            ...c,
            sourceMessageId: String(msg?.id || "").trim(),
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0
          };
        }
      }
    } catch {
      // Safe extractor: ignore malformed message and continue.
    }
  }

  if (!best) {
    return {
      date: null,
      raw: null,
      confidence: 0,
      sourceMessageId: null,
      eventMonth: null,
      eventDatePrecision: "UNKNOWN",
      eventDateEstimateIso: null
    };
  }

  return {
    date: best.date,
    raw: best.raw || null,
    confidence: Math.max(0, Math.min(100, Math.round(best.confidence))),
    sourceMessageId: best.sourceMessageId || null,
    eventMonth: best.eventMonth,
    eventDatePrecision: best.precision,
    eventDateEstimateIso: best.eventDateEstimateIso
  };
}
