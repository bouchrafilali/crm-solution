export type DestinationInputMessage = {
  id: string;
  text: string;
  createdAt: string;
  direction?: "IN" | "OUT";
};

export type DestinationLeadContext = {
  country?: string | null;
  shipCountry?: string | null;
};

export type DestinationExtraction = {
  ship_city: string | null;
  ship_region: string | null;
  ship_country: string | null;
  destination: {
    city: string | null;
    country: string | null;
  };
  raw: string | null;
  confidence: number;
  sourceMessageId: string | null;
};

type Candidate = Omit<DestinationExtraction, "destination"> & { createdAtMs: number };

const COUNTRY_ALIASES: Array<{ aliases: string[]; iso2: string }> = [
  { aliases: ["usa", "u.s.a.", "us", "united states", "etats unis", "états unis"], iso2: "US" },
  { aliases: ["france", "fr"], iso2: "FR" },
  { aliases: ["morocco", "maroc", "ma"], iso2: "MA" },
  { aliases: ["united arab emirates", "uae", "eau", "emirats", "émirats", "ae"], iso2: "AE" },
  { aliases: ["canada", "ca"], iso2: "CA" },
  { aliases: ["uk", "united kingdom", "royaume uni", "gb"], iso2: "GB" }
];

const COUNTRY_MAP: Array<{ re: RegExp; iso2: string }> = COUNTRY_ALIASES.flatMap((entry) =>
  entry.aliases.map((alias) => ({ re: new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i"), iso2: entry.iso2 }))
);

const MONTH_FR = new Set([
  "janvier", "fevrier", "février", "mars", "avril", "mai", "juin", "juillet", "aout", "août", "septembre", "octobre", "novembre", "decembre", "décembre"
]);

const MONTH_EN = new Set([
  "january", "jan", "february", "feb", "march", "mar", "april", "apr", "may", "june", "jun", "july", "jul", "august", "aug", "september", "sept", "sep", "october", "oct", "november", "nov", "december", "dec"
]);

const US_REGIONS = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
  "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "dc", "d.c.", "district of columbia"
]);

const CITY_COUNTRY_FALLBACK: Record<string, string> = {
  paris: "FR",
  rabat: "MA",
  casablanca: "MA",
  marrakech: "MA",
  dubai: "AE",
  london: "GB",
  nyc: "US",
  "new york city": "US"
};

const NON_DESTINATION_PHRASES = [
  "this article",
  "that article",
  "this product",
  "that product",
  "this item",
  "that item",
  "the article",
  "the product",
  "cet article",
  "ce produit",
  "ce modèle",
  "ce modele",
  "this model",
  "that model"
];

function asciiFold(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function inferCountryFromCity(city: string | null | undefined): string | null {
  const key = asciiFold(String(city || "").trim());
  if (!key) return null;
  return CITY_COUNTRY_FALLBACK[key] || null;
}

function looksLikeNonDestinationValue(raw: string | null | undefined): boolean {
  const folded = asciiFold(String(raw || "").trim());
  if (!folded) return false;
  if (NON_DESTINATION_PHRASES.includes(folded)) return true;
  if (/^(article|product|item|model|modele|modèle)$/i.test(folded)) return true;
  if (/^(this|that|ce|cet|cette)\s+/i.test(folded)) return true;
  return false;
}

function pickCountryIso(text: string): string | null {
  const src = String(text || "");
  for (const item of COUNTRY_MAP) {
    if (item.re.test(src)) return item.iso2;
  }
  return null;
}

function pickCountryIsoStrict(text: string): string | null {
  const cleaned = cleanChunk(text);
  if (!cleaned) return null;
  const folded = asciiFold(cleaned);
  for (const item of COUNTRY_ALIASES) {
    if (item.aliases.map((a) => asciiFold(a)).includes(folded)) return item.iso2;
  }
  return null;
}

function inferCountryFromLead(lead?: DestinationLeadContext | null): string | null {
  const primary = String(lead?.shipCountry || lead?.country || "").trim();
  if (!primary) return null;
  if (/^[A-Za-z]{2}$/.test(primary)) return primary.toUpperCase();
  return pickCountryIso(primary);
}

function cleanChunk(raw: string): string {
  return String(raw || "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[.]+$/g, "")
    .replace(/^(sorry|desole|désolé|pardon|oops|oups)\b[\s,:-]*/i, "")
    .replace(/^[,:;\-\s]+|[,:;\-\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function titleCase(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function normalizeRegion(raw: string): string {
  const v = cleanChunk(raw);
  if (!v) return "";
  if (v.length <= 3) return v.toUpperCase();
  return titleCase(v);
}

function looksLikeMonthToken(token: string): boolean {
  const folded = asciiFold(token).trim();
  return MONTH_FR.has(folded) || MONTH_EN.has(folded);
}

function looksLikeDateFragment(text: string): boolean {
  const src = cleanChunk(text);
  if (!src) return false;
  if (/\b(demain|aujourd['’]hui|apres[-\s]?demain|après[-\s]?demain|today|tomorrow|day after tomorrow)\b/i.test(src)) return true;
  if (/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(src)) return true;
  if (/\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+prochain(?:e)?\b/i.test(src)) return true;
  if (/\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(src)) return true;
  if (/\b\d{1,2}\s+[A-Za-zÀ-ÿ]{3,}\b/.test(src)) {
    const m = src.match(/\b\d{1,2}\s+([A-Za-zÀ-ÿ]{3,})\b/);
    if (m && looksLikeMonthToken(m[1])) return true;
  }
  if (/^[A-Za-zÀ-ÿ]{3,}$/.test(src) && looksLikeMonthToken(src)) return true;
  return false;
}

function splitPlace(raw: string): { city: string | null; region: string | null; country: string | null } {
  const text = cleanChunk(raw);
  if (!text) return { city: null, region: null, country: null };

  const country = pickCountryIso(text);
  const withoutCountry = cleanChunk(
    text
      .replace(/\b(usa|u\.s\.a\.|us|united states|etats[- ]?unis|états[- ]?unis)\b/ig, "")
      .replace(/\b(france|maroc|morocco|uae|eau|emirats?|émirats?|canada|uk|united kingdom|royaume[- ]uni)\b/ig, "")
  );

  const commaParts = withoutCountry
    .split(",")
    .map((p) => cleanChunk(p))
    .filter(Boolean);

  if (commaParts.length >= 2) {
    const city = titleCase(commaParts[0]);
    return {
      city,
      region: normalizeRegion(commaParts[1]) || null,
      country: country || inferCountryFromCity(city)
    };
  }

  const words = withoutCountry.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const tailTwo = words.slice(-2).join(" ").toLowerCase();
    const tailOne = String(words[words.length - 1] || "").toLowerCase();
    if (US_REGIONS.has(tailTwo)) {
      const city = titleCase(words.slice(0, -2).join(" ")) || null;
      return {
        city,
        region: normalizeRegion(words.slice(-2).join(" ")) || null,
        country: country || inferCountryFromCity(city) || "US"
      };
    }
    if (US_REGIONS.has(tailOne) || tailOne.length <= 3) {
      const city = titleCase(words.slice(0, -1).join(" ")) || null;
      return {
        city,
        region: normalizeRegion(words[words.length - 1] || "") || null,
        country: country || inferCountryFromCity(city)
      };
    }
    const city = titleCase(withoutCountry);
    return {
      city,
      region: null,
      country: country || inferCountryFromCity(city)
    };
  }

  const singleCity = words.length ? titleCase(words[0]) : null;
  return {
    city: singleCity,
    region: null,
    country: country || inferCountryFromCity(singleCity)
  };
}

function pushCandidate(out: Candidate[], params: {
  raw: string;
  confidence: number;
  sourceMessageId: string;
  createdAtMs: number;
  forceCountry?: string | null;
  forceCity?: string | null;
  forceRegion?: string | null;
}): void {
  const raw = cleanChunk(params.raw);
  if (!raw || looksLikeDateFragment(raw) || looksLikeNonDestinationValue(raw)) return;
  const split = splitPlace(raw);
  const city = params.forceCity ?? split.city ?? null;
  if (looksLikeNonDestinationValue(city)) return;
  out.push({
    ship_city: city,
    ship_region: params.forceRegion ?? split.region,
    ship_country: params.forceCountry || split.country || pickCountryIso(raw),
    raw,
    confidence: params.confidence,
    sourceMessageId: params.sourceMessageId,
    createdAtMs: Number.isFinite(params.createdAtMs) ? params.createdAtMs : 0
  });
}

function looksLikeDestinationQuestion(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return [
    "ville/pays",
    "livraison",
    "destination",
    "shipping",
    "deliver",
    "to where"
  ].some((kw) => t.includes(kw));
}

function parseShortDestinationReply(text: string): { city: string | null; region: string | null; country: string | null; raw: string | null } {
  const cleaned = cleanChunk(text);
  if (!cleaned) return { city: null, region: null, country: null, raw: null };
  if (/\d/.test(cleaned) || looksLikeDateFragment(cleaned)) return { city: null, region: null, country: null, raw: null };

  const country = pickCountryIsoStrict(cleaned);
  if (country) return { city: null, region: null, country, raw: cleaned };

  if (cleaned.includes(",")) {
    const [left, right] = cleaned.split(",").map((v) => cleanChunk(v));
    if (!left) return { city: null, region: null, country: null, raw: null };
    // Handle "date, city" phrasing like "lundi prochaine, Barcelone"
    if (looksLikeDateFragment(left) && right && !looksLikeDateFragment(right)) {
      const cityFromRight = titleCase(right);
      if (looksLikeNonDestinationValue(cityFromRight)) return { city: null, region: null, country: null, raw: null };
      return {
        city: cityFromRight,
        region: null,
        country: pickCountryIso(right || ""),
        raw: cleaned
      };
    }
    if (looksLikeMonthToken(left) || looksLikeDateFragment(left)) return { city: null, region: null, country: null, raw: null };
    const cityFromLeft = titleCase(left);
    if (looksLikeNonDestinationValue(cityFromLeft)) return { city: null, region: null, country: null, raw: null };
    return {
      city: cityFromLeft,
      region: right ? normalizeRegion(right) || null : null,
      country: pickCountryIso(right || ""),
      raw: cleaned
    };
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1 && looksLikeMonthToken(words[0])) return { city: null, region: null, country: null, raw: null };
  if (words.length >= 1 && words.length <= 3) {
    if (looksLikeNonDestinationValue(cleaned)) return { city: null, region: null, country: null, raw: null };
    return {
      city: titleCase(cleaned),
      region: null,
      country: null,
      raw: cleaned
    };
  }

  return { city: null, region: null, country: null, raw: null };
}

function candidateFromPattern(text: string, sourceMessageId: string, createdAt: string, lead?: DestinationLeadContext | null): Candidate[] {
  const out: Candidate[] = [];
  const src = String(text || "");
  const createdAtMs = new Date(String(createdAt || "")).getTime();

  // A1: French date + city pattern, e.g. "9 juin, Paris"
  const frDateCity = src.match(/\b(?:le\s+)?(\d{1,2})\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\s*,\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'\-]{1,60})\b/i);
  if (frDateCity) {
    const cityRaw = cleanChunk(String(frDateCity[3] || ""));
    if (cityRaw && !looksLikeDateFragment(cityRaw)) {
      const city = titleCase(cityRaw);
      out.push({
        ship_city: city,
        ship_region: null,
        ship_country: inferCountryFromCity(city) || inferCountryFromLead(lead),
        raw: cleanChunk(String(frDateCity[0] || src)),
        confidence: 90,
        sourceMessageId,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0
      });
    }
  }

  // A1-bis: weekday + city pattern, e.g. "lundi prochaine, Barcelone"
  const weekdayCity = src.match(/\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+prochain(?:e)?\s*,\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'\-]{1,60})\b/i);
  if (weekdayCity) {
    const cityRaw = cleanChunk(String(weekdayCity[1] || ""));
    if (cityRaw && !looksLikeDateFragment(cityRaw)) {
      const city = titleCase(cityRaw);
      out.push({
        ship_city: city,
        ship_region: null,
        ship_country: inferCountryFromCity(city) || inferCountryFromLead(lead),
        raw: cleanChunk(String(weekdayCity[0] || src)),
        confidence: 90,
        sourceMessageId,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0
      });
    }
  }

  // A1-ter: relative date + city, e.g. "dans 30 jours, Casablanca" / "in 30 days, Madrid"
  const relativeDateCity = src.match(/\b(?:dans\s+\d{1,3}\s+jours?|in\s+\d{1,3}\s+days?)\s*,\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'\-]{1,60})\b/i);
  if (relativeDateCity) {
    const cityRaw = cleanChunk(String(relativeDateCity[1] || ""));
    if (cityRaw && !looksLikeDateFragment(cityRaw)) {
      const city = titleCase(cityRaw);
      out.push({
        ship_city: city,
        ship_region: null,
        ship_country: inferCountryFromCity(city) || inferCountryFromLead(lead),
        raw: cleanChunk(String(relativeDateCity[0] || src)),
        confidence: 90,
        sourceMessageId,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0
      });
    }
  }

  const actionPatterns: Array<{ re: RegExp; confidence: number }> = [
    { re: /\b(?:shipping to|deliver to|delivery to|ship to)\s+([^.!?\n]{2,120})/i, confidence: 85 },
    { re: /\b(?:livraison\s+[àa]|envoyer\s+[àa])\s+([^.!?\n]{2,120})/i, confidence: 85 }
  ];
  for (const p of actionPatterns) {
    const m = src.match(p.re);
    if (!m) continue;
    pushCandidate(out, {
      raw: String(m[1] || ""),
      confidence: p.confidence,
      sourceMessageId,
      createdAtMs
    });
  }

  const prepositionPatterns: Array<{ re: RegExp; confidence: number }> = [
    { re: /\bto\s+([A-Za-z][A-Za-z\s,'\-]{2,80})/i, confidence: 75 },
    { re: /\bin\s+([A-Za-z][A-Za-z\s,'\-]{2,80})/i, confidence: 72 },
    { re: /\b(?:à|au|pour)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s,'\-]{2,80})/i, confidence: 75 }
  ];
  for (const p of prepositionPatterns) {
    const m = src.match(p.re);
    if (!m) continue;
    pushCandidate(out, {
      raw: String(m[1] || ""),
      confidence: p.confidence,
      sourceMessageId,
      createdAtMs
    });
  }

  const triple = src.match(/\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'\-]{1,40})[, ]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'\-]{1,30})[, ]+(USA|US|United States|France|Maroc|Morocco|Canada|UAE|Emirats?|Émirats?)\b/i);
  if (triple) {
    pushCandidate(out, {
      raw: `${String(triple[1] || "").trim()} ${String(triple[2] || "").trim()} ${String(triple[3] || "").trim()}`,
      confidence: 80,
      sourceMessageId,
      createdAtMs
    });
  }

  // A3: country-only
  const countryOnly = pickCountryIsoStrict(src);
  if (countryOnly) {
    out.push({
      ship_city: null,
      ship_region: null,
      ship_country: countryOnly,
      raw: cleanChunk(src),
      confidence: 70,
      sourceMessageId,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0
    });
  }

  return out;
}

function candidateFromShortReplyWithPrompt(messages: DestinationInputMessage[], lead?: DestinationLeadContext | null): Candidate[] {
  const out: Candidate[] = [];
  const ordered = messages
    .slice()
    .sort((a, b) => new Date(String(a.createdAt || "")).getTime() - new Date(String(b.createdAt || "")).getTime());

  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i];
    if (String(current.direction || "IN").toUpperCase() !== "IN") continue;
    const inbound = cleanChunk(current.text);
    if (!inbound) continue;

    const words = inbound.split(/\s+/).filter(Boolean);
    if (words.length > 3 || inbound.length > 30) continue;

    let previousOutbound: DestinationInputMessage | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = ordered[j];
      if (String(prev.direction || "").toUpperCase() === "OUT") {
        previousOutbound = prev;
        break;
      }
    }
    if (!previousOutbound || !looksLikeDestinationQuestion(previousOutbound.text)) continue;

    const parsed = parseShortDestinationReply(inbound);
    if (!parsed.raw) continue;

    out.push({
      ship_city: parsed.city,
      ship_region: parsed.region,
      ship_country: parsed.country || inferCountryFromCity(parsed.city) || inferCountryFromLead(lead),
      raw: parsed.raw,
      confidence: 85,
      sourceMessageId: String(current.id || "").trim() || null,
      createdAtMs: new Date(String(current.createdAt || "")).getTime()
    });
  }

  return out;
}

export function extractDestinationFromMessages(
  messages: DestinationInputMessage[],
  lead?: DestinationLeadContext | null,
  _nowInput?: Date
): DestinationExtraction {
  const safe = Array.isArray(messages) ? messages : [];
  let best: Candidate | null = null;

  for (const msg of safe) {
    try {
      const text = String(msg?.text || "");
      if (!text.trim()) continue;
      const direction = String(msg?.direction || "IN").toUpperCase();
      if (direction === "OUT") continue;
      const candidates = candidateFromPattern(text, String(msg?.id || ""), String(msg?.createdAt || ""), lead);
      for (const c of candidates) {
        if (!best || c.confidence > best.confidence || (c.confidence === best.confidence && c.createdAtMs > best.createdAtMs)) {
          best = c;
        }
      }
    } catch {
      // Safe extractor: ignore malformed message and continue.
    }
  }

  try {
    const contextual = candidateFromShortReplyWithPrompt(safe, lead);
    for (const c of contextual) {
      if (!best || c.confidence > best.confidence || (c.confidence === best.confidence && c.createdAtMs > best.createdAtMs)) {
        best = c;
      }
    }
  } catch {
    // no throw
  }

  if (!best) {
    return {
      ship_city: null,
      ship_region: null,
      ship_country: null,
      destination: { city: null, country: null },
      raw: null,
      confidence: 0,
      sourceMessageId: null
    };
  }

  return {
    ship_city: best.ship_city,
    ship_region: best.ship_region,
    ship_country: best.ship_country,
    destination: {
      city: best.ship_city,
      country: best.ship_country
    },
    raw: best.raw,
    confidence: Math.max(0, Math.min(100, Math.round(best.confidence))),
    sourceMessageId: best.sourceMessageId || null
  };
}
