import { getDbPool } from "./client.js";

export type LeadPriceQuoteRow = {
  id: string;
  leadId: string;
  messageId: string;
  amount: number;
  currency: "USD" | "EUR" | "MAD";
  formatted: string;
  productTitle: string | null;
  productHandle: string | null;
  qty: number;
  confidence: number;
  createdAt: string;
};

export type LeadPriceQuoteInsert = {
  leadId: string;
  messageId: string;
  amount: number;
  currency: "USD" | "EUR" | "MAD";
  formatted: string;
  productTitle?: string | null;
  productHandle?: string | null;
  qty?: number;
  confidence?: number;
  createdAt?: string;
};

function toCurrency(value: unknown): "USD" | "EUR" | "MAD" | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "USD" || normalized === "EUR" || normalized === "MAD") return normalized;
  return null;
}

function normalizeTimestampInput(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = new Date(raw).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function mapRow(row: {
  id: string;
  lead_id: string;
  message_id: string;
  amount: string | number;
  currency: string;
  formatted: string;
  product_title: string | null;
  product_handle: string | null;
  qty: string | number;
  confidence: string | number;
  created_at: string;
}): LeadPriceQuoteRow {
  const currency = toCurrency(row.currency);
  if (!currency) throw new Error("Invalid quote currency");
  return {
    id: row.id,
    leadId: row.lead_id,
    messageId: row.message_id,
    amount: Number(row.amount),
    currency,
    formatted: String(row.formatted || "").trim(),
    productTitle: row.product_title ? String(row.product_title) : null,
    productHandle: String(row.product_handle || "").trim() || null,
    qty: Math.max(1, Number(row.qty) || 1),
    confidence: Math.max(0, Math.min(100, Math.round(Number(row.confidence) || 0))),
    createdAt: row.created_at
  };
}

export async function insertLeadPriceQuotes(quotes: LeadPriceQuoteInsert[]): Promise<number> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const rows = (Array.isArray(quotes) ? quotes : [])
    .map((q) => {
      const leadId = String(q.leadId || "").trim();
      const messageId = String(q.messageId || "").trim();
      const currency = toCurrency(q.currency);
      const amount = Number(q.amount);
      const formatted = String(q.formatted || "").trim();
      if (!leadId || !messageId || !currency || !Number.isFinite(amount) || amount <= 0 || !formatted) return null;
      return {
        leadId,
        messageId,
        amount,
        currency,
        formatted,
        productTitle: String(q.productTitle || "").trim() || null,
        productHandle: String(q.productHandle || "").trim().toLowerCase() || "",
        qty: Math.max(1, Math.round(Number(q.qty) || 1)),
        confidence: Math.max(0, Math.min(100, Math.round(Number(q.confidence) || 70))),
        createdAt: normalizeTimestampInput(q.createdAt)
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (!rows.length) return 0;

  let inserted = 0;
  for (const row of rows) {
    const q = await db.query(
      `
        insert into lead_price_quotes (
          lead_id,
          message_id,
          amount,
          currency,
          formatted,
          product_title,
          product_handle,
          qty,
          confidence,
          created_at
        )
        select
          $1::uuid,
          $2::uuid,
          $3::numeric,
          $4::text,
          $5::text,
          $6::text,
          $7::text,
          $8::int,
          $9::int,
          coalesce($10::timestamptz, now())
        where not exists (
          select 1
          from lead_price_quotes existing
          where existing.lead_id = $1::uuid
            and existing.message_id = $2::uuid
            and existing.amount = $3::numeric
        )
        on conflict (lead_id, message_id, amount, currency, product_handle, qty) do nothing
      `,
      [
        row.leadId,
        row.messageId,
        row.amount,
        row.currency,
        row.formatted,
        row.productTitle,
        row.productHandle,
        row.qty,
        row.confidence,
        row.createdAt
      ]
    );
    inserted += Number(q.rowCount || 0);
  }

  return inserted;
}

export async function listLeadPriceQuotes(leadId: string, limit = 3): Promise<LeadPriceQuoteRow[]> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const safeLimit = Math.max(1, Math.min(50, Math.round(limit || 3)));

  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    amount: string | number;
    currency: string;
    formatted: string;
    product_title: string | null;
    product_handle: string | null;
    qty: string | number;
    confidence: string | number;
    created_at: string;
  }>(
    `
      select id, lead_id, message_id, amount, currency, formatted, product_title, product_handle, qty, confidence, created_at
      from lead_price_quotes
      where lead_id = $1::uuid
      order by created_at desc
      limit $2::int
    `,
    [leadId, safeLimit]
  );

  return q.rows.map((row) => mapRow(row));
}

export async function recomputeLeadTicketEstimateFromQuotes(leadId: string): Promise<{
  ticketValue: number | null;
  ticketCurrency: "USD" | "EUR" | "MAD" | null;
  strategy: "sum_latest_per_product" | "max_without_product" | "none";
}> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const leadQ = await db.query<{ ticket_value: string | number | null; ticket_currency: string | null }>(
    `
      select ticket_value, ticket_currency
      from whatsapp_leads
      where id = $1::uuid
      limit 1
    `,
    [leadId]
  );
  if (!leadQ.rows[0]) return { ticketValue: null, ticketCurrency: null, strategy: "none" };

  const byProductQ = await db.query<{ amount: string | number; qty: number | string; currency: string }>(
    `
      with ranked as (
        select
          amount,
          qty,
          currency,
          product_handle,
          row_number() over (partition by product_handle order by created_at desc) as rn
        from lead_price_quotes
        where lead_id = $1::uuid
          and nullif(trim(product_handle), '') is not null
      )
      select amount, qty, currency
      from ranked
      where rn = 1
    `,
    [leadId]
  );

  if (byProductQ.rows.length > 0) {
    const totals = byProductQ.rows.map((row) => Math.max(1, Number(row.amount) || 0) * Math.max(1, Math.round(Number(row.qty) || 1)));
    const currencies = Array.from(new Set(byProductQ.rows.map((row) => String(row.currency || "").toUpperCase()).filter((c) => c === "USD" || c === "EUR" || c === "MAD")));
    const ticketValue = Math.round(totals.reduce((sum, value) => sum + value, 0));
    const ticketCurrency = currencies.length === 1 ? (currencies[0] as "USD" | "EUR" | "MAD") : null;

    await db.query(
      `
        update whatsapp_leads
        set ticket_value = $2::numeric,
            ticket_currency = $3::text,
            updated_at = now()
        where id = $1::uuid
      `,
      [leadId, ticketValue, ticketCurrency]
    );

    return {
      ticketValue,
      ticketCurrency,
      strategy: "sum_latest_per_product"
    };
  }

  const maxQuoteQ = await db.query<{ max_amount: string | number | null; currency: string | null }>(
    `
      select (amount * greatest(qty, 1)) as max_amount, currency
      from lead_price_quotes
      where lead_id = $1::uuid
      order by (amount * greatest(qty, 1)) desc, created_at desc
      limit 1
    `,
    [leadId]
  );

  const maxAmount = maxQuoteQ.rows[0]?.max_amount == null ? null : Number(maxQuoteQ.rows[0].max_amount);
  if (maxAmount == null || !Number.isFinite(maxAmount) || maxAmount <= 0) {
    return { ticketValue: null, ticketCurrency: null, strategy: "none" };
  }

  const existingValue = leadQ.rows[0].ticket_value == null ? null : Number(leadQ.rows[0].ticket_value);
  const ticketValue = Math.max(existingValue && Number.isFinite(existingValue) ? existingValue : 0, Math.round(maxAmount));
  const existingCurrency = toCurrency(leadQ.rows[0].ticket_currency);
  const maxCurrency = toCurrency(maxQuoteQ.rows[0]?.currency);
  const ticketCurrency = existingCurrency && maxCurrency && existingCurrency !== maxCurrency
    ? null
    : (existingCurrency || maxCurrency || null);

  await db.query(
    `
      update whatsapp_leads
      set ticket_value = $2::numeric,
          ticket_currency = $3::text,
          updated_at = now()
      where id = $1::uuid
    `,
    [leadId, ticketValue, ticketCurrency]
  );

  return {
    ticketValue,
    ticketCurrency,
    strategy: "max_without_product"
  };
}
