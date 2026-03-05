export type PriceCurrency = "USD" | "EUR" | "MAD";

export type ExtractedPrice = {
  amount: number;
  currency: PriceCurrency;
  formatted: string;
  rawMatch: string;
  index: number;
};

const CURRENCY_BEFORE_RE = /(?:\b(mad|dhs?|dh|eur|usd)\b|([€$]))\s*([0-9][0-9\s.,]*(?:\s*[kK])?)/gi;
const CURRENCY_AFTER_RE = /([0-9][0-9\s.,]*(?:\s*[kK])?)\s*(?:\b(mad|dhs?|dh|eur|usd)\b|([€$]))/gi;

function toCurrency(token: string): PriceCurrency | null {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;
  if (t === "$" || t === "usd") return "USD";
  if (t === "€" || t === "eur") return "EUR";
  if (t === "mad" || t === "dh" || t === "dhs") return "MAD";
  return null;
}

function normalizeNumberToken(raw: string): number | null {
  const original = String(raw || "").trim();
  if (!original) return null;

  const kMatch = original.match(/^([0-9]+(?:[.,][0-9]+)?)\s*[kK]$/);
  if (kMatch) {
    const base = Number(String(kMatch[1]).replace(",", "."));
    if (!Number.isFinite(base) || base <= 0) return null;
    return Math.round(base * 1000);
  }

  const cleaned = original.replace(/\s+/g, "").replace(/[^0-9.,]/g, "");
  if (!cleaned) return null;

  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  let normalized = cleaned;

  if (dotCount > 0 || commaCount > 0) {
    const decimalDigits = lastSep >= 0 ? cleaned.length - lastSep - 1 : 0;
    const manySeps = dotCount + commaCount > 1;
    const hasBoth = dotCount > 0 && commaCount > 0;

    if (hasBoth || manySeps || decimalDigits === 3 || decimalDigits === 0) {
      normalized = cleaned.replace(/[.,]/g, "");
    } else if (decimalDigits > 0 && decimalDigits <= 2) {
      const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
      const fracPart = cleaned.slice(lastSep + 1).replace(/[.,]/g, "");
      normalized = `${intPart}.${fracPart}`;
    } else {
      normalized = cleaned.replace(/[.,]/g, "");
    }
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function formatPrice(amount: number, currency: PriceCurrency): string {
  const n = Math.round(amount);
  if (currency === "USD") return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;
  if (currency === "EUR") {
    const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\u202f/g, " ");
    return `${formatted}€`;
  }
  const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\u202f/g, " ");
  return `${formatted} MAD`;
}

function pushMatch(
  out: ExtractedPrice[],
  input: { amount: number; currency: PriceCurrency; rawMatch: string; index: number }
): void {
  const key = `${input.index}:${input.currency}:${Math.round(input.amount * 100)}:${input.rawMatch.toLowerCase()}`;
  if (out.some((item) => `${item.index}:${item.currency}:${Math.round(item.amount * 100)}:${item.rawMatch.toLowerCase()}` === key)) {
    return;
  }
  out.push({
    amount: input.amount,
    currency: input.currency,
    formatted: formatPrice(input.amount, input.currency),
    rawMatch: input.rawMatch,
    index: input.index
  });
}

export function extractPrice(text: string): ExtractedPrice[] {
  const input = String(text || "");
  if (!input.trim()) return [];
  const matches: ExtractedPrice[] = [];

  CURRENCY_BEFORE_RE.lastIndex = 0;
  CURRENCY_AFTER_RE.lastIndex = 0;

  for (let m = CURRENCY_BEFORE_RE.exec(input); m; m = CURRENCY_BEFORE_RE.exec(input)) {
    const currency = toCurrency(String(m[1] || m[2] || ""));
    const amount = normalizeNumberToken(String(m[3] || ""));
    if (!currency || !amount) continue;
    pushMatch(matches, {
      amount,
      currency,
      rawMatch: String(m[0] || "").trim(),
      index: m.index
    });
  }

  for (let m = CURRENCY_AFTER_RE.exec(input); m; m = CURRENCY_AFTER_RE.exec(input)) {
    const currency = toCurrency(String(m[2] || m[3] || ""));
    const amount = normalizeNumberToken(String(m[1] || ""));
    if (!currency || !amount) continue;
    pushMatch(matches, {
      amount,
      currency,
      rawMatch: String(m[0] || "").trim(),
      index: m.index
    });
  }

  return matches.sort((a, b) => a.index - b.index);
}

export function extractLatestPrice(text: string): ExtractedPrice | null {
  const matches = extractPrice(text);
  if (!matches.length) return null;
  return matches[matches.length - 1] || null;
}
