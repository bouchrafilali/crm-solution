import { getDbPool } from "../db/client.js";
import { createMlEvent } from "../db/mlRepo.js";
import {
  insertLeadPriceQuotes,
  listLeadPriceQuotes,
  recomputeLeadTicketEstimateFromQuotes,
  type LeadPriceQuoteInsert
} from "../db/leadPriceQuotesRepo.js";
import { extractLatestPrice, extractPrice, type ExtractedPrice, type PriceCurrency } from "./priceExtraction.js";

const FALLBACK_BY_PRODUCT: Record<string, { amount: number; currency: PriceCurrency }> = {
  takchita: { amount: 3500, currency: "EUR" },
  kaftan: { amount: 2800, currency: "EUR" },
  kimono: { amount: 1800, currency: "EUR" }
};

const MULTIPLIER_REGEX = /\b(\d{1,2})\s*(?:x\s*)?(?:dresses?|robes?|pieces?|tenues?|takchitas?|kaftans?|kimonos?)\b/i;

export type TicketInferenceMessage = {
  id: string;
  direction?: "IN" | "OUT" | string;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

export type TicketValueInferenceDetails = {
  strategy: "quoted_amount" | "fallback_product_interest" | "none";
  inferredValue: number | null;
  currency: PriceCurrency | null;
  formatted: string | null;
  rawMatch: string | null;
  messageId: string | null;
  multiplier: number;
  fallbackProduct: string | null;
};

function formatByCurrency(amount: number, currency: PriceCurrency): string {
  const n = Math.round(amount);
  if (currency === "USD") return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;
  if (currency === "EUR") {
    const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\u202f/g, " ");
    return `${formatted}€`;
  }
  const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\u202f/g, " ");
  return `${formatted} MAD`;
}

function extractMultiplier(text: string): number {
  const match = String(text || "").match(MULTIPLIER_REGEX);
  if (!match) return 1;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 2) return 1;
  return Math.min(20, Math.round(n));
}

function inferFallbackProduct(productReference: string | null, messages: TicketInferenceMessage[]): string | null {
  const corpus = `${String(productReference || "")} ${(messages || []).map((m) => m.text || "").join(" ")}`.toLowerCase();
  const matches = Object.keys(FALLBACK_BY_PRODUCT).filter((key) => corpus.includes(key));
  if (!matches.length) return null;
  return matches.sort((a, b) => FALLBACK_BY_PRODUCT[a].amount - FALLBACK_BY_PRODUCT[b].amount)[0] || null;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstHandleFromText(text: string): string {
  const src = String(text || "");
  const patterns = [/\/products\/([a-z0-9][a-z0-9\-]*)/gi, /\/collections\/[^/\s]+\/products\/([a-z0-9][a-z0-9\-]*)/gi];
  for (const pattern of patterns) {
    const match = pattern.exec(src);
    if (match && match[1]) return String(match[1]).trim().toLowerCase();
  }
  return "";
}

function titleHintFromText(text: string): string {
  const src = String(text || "");
  const lower = src.toLowerCase();
  const markers = ["interested in this article:", "article:", "produit:"];
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx === -1) continue;
    const tail = src.slice(idx + marker.length).trim();
    if (!tail) continue;
    const firstLine = (tail.split("\n")[0] || "").replace(/\*/g, "").trim();
    if (firstLine) return firstLine;
  }
  return "";
}

function quoteContext(text: string, metadata: Record<string, unknown> | null | undefined): {
  productHandle: string | null;
  productTitle: string | null;
} {
  const meta = normalizeRecord(metadata);
  const productHandle =
    metadataString(meta, ["product_handle", "productHandle", "handle"]).toLowerCase() ||
    firstHandleFromText(text) ||
    null;

  const productTitle =
    metadataString(meta, ["product_title", "productTitle", "title", "product_name", "productName"]) ||
    titleHintFromText(text) ||
    null;

  return {
    productHandle,
    productTitle
  };
}

function toQuoteRowsForMessage(input: {
  leadId: string;
  messageId: string;
  text: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}): {
  matches: ExtractedPrice[];
  rows: LeadPriceQuoteInsert[];
  payloadMatches: Array<{
    amount: number;
    currency: PriceCurrency;
    formatted: string;
    rawMatch: string;
    messageId: string;
    product_handle: string | null;
    product_title: string | null;
    qty: number;
    confidence: number;
  }>;
} {
  const matches = extractPrice(input.text);
  if (!matches.length) return { matches: [], rows: [], payloadMatches: [] };

  const qty = extractMultiplier(input.text);
  const context = quoteContext(input.text, input.metadata);
  const confidence = Math.min(98, 78 + (context.productHandle ? 10 : 0) + (qty > 1 ? 4 : 0));

  const rows: LeadPriceQuoteInsert[] = matches.map((match) => ({
    leadId: input.leadId,
    messageId: input.messageId,
    amount: match.amount,
    currency: match.currency,
    formatted: match.formatted,
    productTitle: context.productTitle,
    productHandle: context.productHandle,
    qty,
    confidence,
    createdAt: input.createdAt
  }));

  const payloadMatches = matches.map((match) => ({
    amount: match.amount,
    currency: match.currency,
    formatted: match.formatted,
    rawMatch: match.rawMatch,
    messageId: input.messageId,
    product_handle: context.productHandle,
    product_title: context.productTitle,
    qty,
    confidence
  }));

  return { matches, rows, payloadMatches };
}

function selectMostRecentPrice(messages: TicketInferenceMessage[]): { message: TicketInferenceMessage; price: ExtractedPrice } | null {
  const list = Array.isArray(messages) ? messages : [];

  for (const msg of list) {
    if (String(msg.direction || "").toUpperCase() !== "OUT") continue;
    const price = extractLatestPrice(msg.text);
    if (price) return { message: msg, price };
  }

  for (const msg of list) {
    const price = extractLatestPrice(msg.text);
    if (price) return { message: msg, price };
  }

  return null;
}

export function inferTicketValueFromConversation(input: {
  productReference?: string | null;
  messages: TicketInferenceMessage[];
}): TicketValueInferenceDetails {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const selected = selectMostRecentPrice(messages);

  if (selected) {
    const multiplier = extractMultiplier(selected.message.text);
    const amount = Math.max(1, Math.round(selected.price.amount * multiplier));
    return {
      strategy: "quoted_amount",
      inferredValue: amount,
      currency: selected.price.currency,
      formatted: formatByCurrency(amount, selected.price.currency),
      rawMatch: selected.price.rawMatch,
      messageId: selected.message.id,
      multiplier,
      fallbackProduct: null
    };
  }

  const fallbackProduct = inferFallbackProduct(input.productReference || null, messages);
  if (fallbackProduct) {
    const fallback = FALLBACK_BY_PRODUCT[fallbackProduct];
    return {
      strategy: "fallback_product_interest",
      inferredValue: fallback.amount,
      currency: fallback.currency,
      formatted: formatByCurrency(fallback.amount, fallback.currency),
      rawMatch: null,
      messageId: null,
      multiplier: 1,
      fallbackProduct
    };
  }

  return {
    strategy: "none",
    inferredValue: null,
    currency: null,
    formatted: null,
    rawMatch: null,
    messageId: null,
    multiplier: 1,
    fallbackProduct: null
  };
}

async function upsertLeadTicketValue(input: {
  leadId: string;
  amount: number;
  currency: PriceCurrency;
}): Promise<void> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  await db.query(
    `
      update whatsapp_leads
      set ticket_value = $2::numeric,
          ticket_currency = $3::text,
          updated_at = now()
      where id = $1::uuid
    `,
    [input.leadId, input.amount, input.currency]
  );
}

export async function applyDetectedPriceForLeadMessage(input: {
  leadId: string;
  messageId: string;
  text: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  emitEvent?: boolean;
}): Promise<ExtractedPrice[]> {
  const leadId = String(input.leadId || "").trim();
  const messageId = String(input.messageId || "").trim();
  if (!leadId || !messageId) return [];

  const built = toQuoteRowsForMessage({
    leadId,
    messageId,
    text: String(input.text || ""),
    metadata: input.metadata || null,
    createdAt: input.createdAt
  });

  if (!built.rows.length) return [];

  const insertedCount = await insertLeadPriceQuotes(built.rows);
  const estimate = await recomputeLeadTicketEstimateFromQuotes(leadId);

  if (input.emitEvent !== false) {
    const latest = built.matches[built.matches.length - 1] || null;
    await createMlEvent({
      eventType: "INFERENCE",
      leadId,
      source: "SYSTEM",
      payload: {
        inference: "ticket_value_message",
        price_matches: built.payloadMatches,
        price: latest
          ? {
              amount: latest.amount,
              currency: latest.currency,
              formatted: latest.formatted,
              rawMatch: latest.rawMatch,
              messageId
            }
          : null,
        inserted_quotes: insertedCount,
        estimate: {
          ticket_value: estimate.ticketValue,
          ticket_currency: estimate.ticketCurrency,
          strategy: estimate.strategy
        }
      }
    });
  }

  return built.matches;
}

export async function inferTicketValueForLead(
  leadId: string,
  options?: { emitEvent?: boolean }
): Promise<TicketValueInferenceDetails | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const normalizedLeadId = String(leadId || "").trim();
  if (!normalizedLeadId) return null;

  const leadQ = await db.query<{
    id: string;
    product_reference: string | null;
    ticket_value: string | number | null;
    ticket_currency: string | null;
  }>(
    `
      select id, product_reference, ticket_value, ticket_currency
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [normalizedLeadId]
  );
  const lead = leadQ.rows[0];
  if (!lead) return null;

  const messagesQ = await db.query<{
    id: string;
    direction: string;
    text: string;
    metadata: unknown;
    created_at: string;
  }>(
    `
      select id, direction, text, metadata, created_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
      order by created_at desc
      limit 50
    `,
    [normalizedLeadId]
  );

  const messages: TicketInferenceMessage[] = messagesQ.rows.map((row) => ({
    id: row.id,
    direction: String(row.direction || "").toUpperCase(),
    text: String(row.text || ""),
    metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null,
    createdAt: row.created_at
  }));

  const quoteRows: LeadPriceQuoteInsert[] = [];
  let totalMatches = 0;
  for (const message of messages) {
    const built = toQuoteRowsForMessage({
      leadId: normalizedLeadId,
      messageId: message.id,
      text: message.text,
      metadata: message.metadata || null,
      createdAt: message.createdAt
    });
    totalMatches += built.rows.length;
    quoteRows.push(...built.rows);
  }

  let insertedQuotes = 0;
  if (quoteRows.length) {
    insertedQuotes = await insertLeadPriceQuotes(quoteRows);
  }

  const estimate = await recomputeLeadTicketEstimateFromQuotes(normalizedLeadId);

  let details: TicketValueInferenceDetails;
  if (estimate.ticketValue != null && estimate.ticketCurrency) {
    const latestQuote = (await listLeadPriceQuotes(normalizedLeadId, 1))[0] || null;
    details = {
      strategy: "quoted_amount",
      inferredValue: estimate.ticketValue,
      currency: estimate.ticketCurrency,
      formatted: formatByCurrency(estimate.ticketValue, estimate.ticketCurrency),
      rawMatch: latestQuote ? latestQuote.formatted : null,
      messageId: latestQuote ? latestQuote.messageId : null,
      multiplier: latestQuote ? Math.max(1, latestQuote.qty) : 1,
      fallbackProduct: null
    };
  } else {
    details = inferTicketValueFromConversation({
      productReference: lead.product_reference,
      messages
    });

    if (details.inferredValue != null && details.currency) {
      await upsertLeadTicketValue({
        leadId: normalizedLeadId,
        amount: details.inferredValue,
        currency: details.currency
      });
    }
  }

  if (options?.emitEvent !== false) {
    await createMlEvent({
      eventType: "INFERENCE",
      leadId: normalizedLeadId,
      source: "SYSTEM",
      payload: {
        inference: "ticket_value_backfill",
        strategy: details.strategy,
        scanned_messages: messages.length,
        detected_price_matches: totalMatches,
        inserted_quotes: insertedQuotes,
        price: details.inferredValue != null && details.currency
          ? {
              amount: details.inferredValue,
              currency: details.currency,
              formatted: details.formatted,
              rawMatch: details.rawMatch,
              messageId: details.messageId
            }
          : null,
        fallback_product: details.fallbackProduct,
        multiplier: details.multiplier,
        estimate_strategy: estimate.strategy,
        previous_ticket_value: lead.ticket_value == null ? null : Number(lead.ticket_value),
        previous_ticket_currency: lead.ticket_currency || null
      }
    });
  }

  return details;
}

function amountKey(amount: number): string {
  return String(Math.round(Number(amount || 0) * 100));
}

export async function backfillHistoricalPriceQuotes(options?: {
  leadLimit?: number;
  messageLimit?: number;
}): Promise<{ leadsProcessed: number; quotesInserted: number; leadsUpdated: number }> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const leadLimit = Math.max(1, Math.min(2000, Math.round(options?.leadLimit || 500)));
  const messageLimit = Math.max(1, Math.min(300, Math.round(options?.messageLimit || 100)));

  const tableCheck = await db.query<{ exists: string | null }>(
    `
      select to_regclass('public.lead_price_quotes')::text as exists
    `
  );
  if (!String(tableCheck.rows[0]?.exists || "").trim()) {
    throw new Error("lead_price_quotes_table_missing");
  }

  const leadsQ = await db.query<{ id: string; stage: string }>(
    `
      select id, stage
      from whatsapp_leads
      order by updated_at desc
      limit $1::int
    `,
    [leadLimit]
  );

  let leadsProcessed = 0;
  let quotesInserted = 0;
  let leadsUpdated = 0;

  for (const lead of leadsQ.rows) {
    const leadId = String(lead.id || "").trim();
    if (!leadId) continue;
    leadsProcessed += 1;
    try {
      const messagesQ = await db.query<{
        id: string;
        direction: string;
        text: string;
        created_at: string;
      }>(
        `
          select id, direction, text, created_at
          from whatsapp_lead_messages
          where lead_id = $1::uuid
          order by created_at desc
          limit $2::int
        `,
        [leadId, messageLimit]
      );

      if (!messagesQ.rows.length) continue;

      const messageIds = messagesQ.rows.map((row) => row.id);
      const existingQ = await db.query<{ message_id: string; amount: string | number }>(
        `
          select message_id, amount
          from lead_price_quotes
          where lead_id = $1::uuid
            and message_id = any($2::uuid[])
        `,
        [leadId, messageIds]
      );
      const existingKeys = new Set(
        existingQ.rows.map((row) => `${String(row.message_id)}:${amountKey(Number(row.amount || 0))}`)
      );

      const rowsToInsert: LeadPriceQuoteInsert[] = [];
      const seenInBatch = new Set<string>();
      const allMatches: Array<{
        amount: number;
        currency: PriceCurrency;
        direction: "IN" | "OUT";
        createdAt: string;
      }> = [];

      for (const msg of messagesQ.rows) {
        const matches = extractPrice(String(msg.text || ""));
        if (!matches.length) continue;
        const direction: "IN" | "OUT" = String(msg.direction || "").toUpperCase() === "OUT" ? "OUT" : "IN";

        for (const match of matches) {
          if (!Number.isFinite(match.amount) || match.amount <= 0) continue;
          allMatches.push({
            amount: Number(match.amount),
            currency: match.currency,
            direction,
            createdAt: msg.created_at
          });

          const key = `${msg.id}:${amountKey(match.amount)}`;
          if (existingKeys.has(key) || seenInBatch.has(key)) continue;
          seenInBatch.add(key);

          rowsToInsert.push({
            leadId,
            messageId: msg.id,
            amount: Number(match.amount),
            currency: match.currency,
            formatted: String(match.formatted || ""),
            productTitle: null,
            productHandle: null,
            qty: 1,
            confidence: 70,
            createdAt: msg.created_at
          });
        }
      }

      let insertedNow = 0;
      if (rowsToInsert.length) {
        insertedNow = await insertLeadPriceQuotes(rowsToInsert);
        quotesInserted += insertedNow;
      }

      if (!allMatches.length) {
        try {
          await createMlEvent({
            eventType: "INFERENCE",
            leadId,
            source: "SYSTEM_BACKFILL",
            payload: {
              reconstructed: true,
              quotesInserted: 0,
              messagesScanned: messagesQ.rows.length
            }
          });
        } catch (eventError) {
          console.warn("[price-backfill] ml event log failed", {
            leadId,
            error: eventError instanceof Error ? eventError.message : String(eventError || "unknown_error")
          });
        }
        continue;
      }

      const byCurrency = new Map<PriceCurrency, number[]>();
      for (const match of allMatches) {
        const arr = byCurrency.get(match.currency) || [];
        arr.push(match.amount);
        byCurrency.set(match.currency, arr);
      }

      let selectedCurrency: PriceCurrency;
      if (byCurrency.size === 1) {
        selectedCurrency = Array.from(byCurrency.keys())[0] as PriceCurrency;
      } else {
        const recentOutbound = allMatches
          .filter((m) => m.direction === "OUT")
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (recentOutbound) {
          selectedCurrency = recentOutbound.currency;
        } else {
          selectedCurrency = allMatches
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]!.currency;
        }
      }

      const selectedAmounts = byCurrency.get(selectedCurrency) || [];
      const ticketValue = selectedAmounts.length ? Math.max(...selectedAmounts.map((n) => Math.round(Number(n || 0)))) : null;

      let updatedLead = false;
      if (ticketValue != null && Number.isFinite(ticketValue) && ticketValue > 0 && String(lead.stage || "").toUpperCase() !== "CONVERTED") {
        const updateQ = await db.query(
          `
            update whatsapp_leads
            set ticket_value = $2::numeric,
                ticket_currency = $3::text,
                updated_at = now()
            where id = $1::uuid
              and stage <> 'CONVERTED'
          `,
          [leadId, ticketValue, selectedCurrency]
        );
        updatedLead = Number(updateQ.rowCount || 0) > 0;
        if (updatedLead) leadsUpdated += 1;
      }

      try {
        await createMlEvent({
          eventType: "INFERENCE",
          leadId,
          source: "SYSTEM_BACKFILL",
          payload: {
            reconstructed: true,
            quotesInserted: insertedNow,
            messagesScanned: messagesQ.rows.length,
            currenciesDetected: Array.from(byCurrency.keys()),
            ticketValue,
            ticketCurrency: selectedCurrency,
            leadUpdated: updatedLead
          }
        });
      } catch (eventError) {
        console.warn("[price-backfill] ml event log failed", {
          leadId,
          error: eventError instanceof Error ? eventError.message : String(eventError || "unknown_error")
        });
        try {
          await createMlEvent({
            eventType: "INFERENCE",
            leadId,
            source: "SYSTEM",
            payload: {
              reconstructed: true,
              quotesInserted: insertedNow,
              fallbackSource: "SYSTEM",
              reason: "system_backfill_source_check_failed"
            }
          });
        } catch {
          // no-op
        }
      }
    } catch (leadError) {
      console.error("[price-backfill] failed lead", {
        leadId,
        error: leadError instanceof Error ? leadError.message : String(leadError || "unknown_error")
      });
      continue;
    }
  }

  return { leadsProcessed, quotesInserted, leadsUpdated };
}
