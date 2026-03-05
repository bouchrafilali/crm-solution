export type LocalPhase = "NIGHT" | "EARLY" | "BUSINESS" | "EVENING";

export type LocalTimeContext = {
  tz: string | null;
  time: string;
  hour: number;
  minute?: number;
  phase: LocalPhase;
  is_business_hours: boolean;
};

export type SmartRelanceDelayInput = {
  localTimeCtx: LocalTimeContext | null;
  stage: string;
  elapsed_minutes: number | null;
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
};

export type SmartRelanceDelayResult = {
  should_delay: boolean;
  delay_until_iso: string | null;
  delay_until_label: string | null;
  delay_reason: string | null;
  override_allowed_now: boolean;
};

function getPartsInTz(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  return {
    year: Number(map.year || "0"),
    month: Number(map.month || "1"),
    day: Number(map.day || "1"),
    hour: Number(map.hour || "0"),
    minute: Number(map.minute || "0"),
    second: Number(map.second || "0")
  };
}

function zonedLocalToIso(input: {
  timeZone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): string {
  // Convert a local wall-clock date/time in a timezone to a UTC ISO timestamp.
  const desiredLocalAsUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
  let utcGuess = desiredLocalAsUtc;

  for (let i = 0; i < 2; i += 1) {
    const p = getPartsInTz(new Date(utcGuess), input.timeZone);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offset = localAsUtc - utcGuess;
    utcGuess = desiredLocalAsUtc - offset;
  }

  return new Date(utcGuess).toISOString();
}

function plusOneDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function computeSmartRelanceDelay(input: SmartRelanceDelayInput): SmartRelanceDelayResult {
  const ctx = input.localTimeCtx;
  if (!ctx || !ctx.tz) {
    return {
      should_delay: false,
      delay_until_iso: null,
      delay_until_label: null,
      delay_reason: null,
      override_allowed_now: false
    };
  }

  const stage = String(input.stage || "").toUpperCase();
  const urgency = String(input.urgency || "LOW").toUpperCase();
  const now = new Date();
  const nowParts = getPartsInTz(now, ctx.tz);
  const hour = Number(nowParts.hour);

  const isQualificationLike =
    stage === "QUALIFICATION_PENDING" || stage === "QUALIFIED" || stage === "VIDEO_PROPOSED";
  const isRevenueLike = stage === "PRICE_SENT" || stage === "DEPOSIT_PENDING";

  if ((urgency === "CRITICAL" || urgency === "HIGH") && isRevenueLike) {
    return {
      should_delay: false,
      delay_until_iso: null,
      delay_until_label: null,
      delay_reason: "Lead à forte valeur — envoyer maintenant malgré les heures creuses",
      override_allowed_now: true
    };
  }

  const makeResult = (target: { year: number; month: number; day: number; hour: number; minute: number }, label: string, reason: string): SmartRelanceDelayResult => ({
    should_delay: true,
    delay_until_iso: zonedLocalToIso({
      timeZone: ctx.tz!,
      year: target.year,
      month: target.month,
      day: target.day,
      hour: target.hour,
      minute: target.minute
    }),
    delay_until_label: label,
    delay_reason: reason,
    override_allowed_now: false
  });

  if (ctx.phase === "BUSINESS") {
    return {
      should_delay: false,
      delay_until_iso: null,
      delay_until_label: null,
      delay_reason: null,
      override_allowed_now: false
    };
  }

  if (urgency === "CRITICAL") {
    return {
      should_delay: false,
      delay_until_iso: null,
      delay_until_label: null,
      delay_reason: null,
      override_allowed_now: false
    };
  }

  if (ctx.phase === "NIGHT") {
    if (isRevenueLike) {
      return {
        should_delay: false,
        delay_until_iso: null,
        delay_until_label: null,
        delay_reason: "Lead à forte valeur — envoyer maintenant malgré les heures creuses",
        override_allowed_now: true
      };
    }
    if (!isQualificationLike) {
      return {
        should_delay: false,
        delay_until_iso: null,
        delay_until_label: null,
        delay_reason: null,
        override_allowed_now: false
      };
    }
    const next = plusOneDay(nowParts.year, nowParts.month, nowParts.day);
    return makeResult({ ...next, hour: 9, minute: 15 }, "Demain 09:15", "Le client est probablement en train de dormir");
  }

  if (ctx.phase === "EARLY") {
    if (!isQualificationLike) {
      return {
        should_delay: false,
        delay_until_iso: null,
        delay_until_label: null,
        delay_reason: null,
        override_allowed_now: false
      };
    }
    return makeResult(
      { year: nowParts.year, month: nowParts.month, day: nowParts.day, hour: 9, minute: 15 },
      "Aujourd’hui 09:15",
      "Plus pertinent pendant les heures ouvrées"
    );
  }

  if (ctx.phase === "EVENING") {
    if (stage === "QUALIFICATION_PENDING" && hour > 22) {
      const next = plusOneDay(nowParts.year, nowParts.month, nowParts.day);
      return makeResult({ ...next, hour: 9, minute: 15 }, "Demain 09:15", "Mieux vaut attendre la prochaine fenêtre ouvrée");
    }
    return {
      should_delay: false,
      delay_until_iso: null,
      delay_until_label: null,
      delay_reason: null,
      override_allowed_now: false
    };
  }

  return {
    should_delay: false,
    delay_until_iso: null,
    delay_until_label: null,
    delay_reason: null,
    override_allowed_now: false
  };
}
