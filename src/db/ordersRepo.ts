import type { Pool, PoolClient } from "pg";
import { getDbPool } from "./client.js";
import type { ShopifyOrderPayload } from "../services/orderSnapshots.js";

export type ShopifyOrder = ShopifyOrderPayload;

export type AnalyticsOrderRecord = {
  id: string;
  createdAt: string;
  customerId: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerLabel: string | null;
  currency: string;
  totalAmount: number;
  outstandingAmount: number;
  paymentGateway: string | null;
};

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferOutstandingAmount(payload: ShopifyOrderPayload, totalAmount: number): number {
  if (payload.total_outstanding !== undefined) {
    return Math.max(0, toNumber(payload.total_outstanding));
  }
  const financialStatus = String(payload.financial_status ?? "").toLowerCase();
  if (financialStatus === "paid") return 0;
  if (financialStatus === "partially_paid") return Math.max(0, totalAmount * 0.5);
  return totalAmount;
}

function paymentGatewayLabel(payload: ShopifyOrderPayload): string {
  const gateways = Array.isArray(payload.payment_gateway_names) ? payload.payment_gateway_names : [];
  const normalized = gateways.map((name) => String(name ?? "").trim()).filter(Boolean);
  return normalized.join(", ");
}

function buildPaymentRows(payload: ShopifyOrderPayload): Array<{ gateway: string; amount: number; currency: string; occurredAt: string | null }> {
  const txs = Array.isArray(payload.transactions) ? payload.transactions : [];
  const currency = String(payload.currency || "USD").toUpperCase();
  const rows = txs
    .map((tx) => {
      const status = String(tx.status ?? "").toLowerCase();
      const kind = String(tx.kind ?? "").toLowerCase();
      if (status && status !== "success") return null;
      if (kind === "refund" || kind === "void" || kind === "authorization") return null;
      const amount = Math.max(0, toNumber(tx.amount));
      if (amount <= 0) return null;
      return {
        gateway: String(tx.gateway || "Autre").trim() || "Autre",
        amount,
        currency: String(tx.currency || currency).toUpperCase(),
        occurredAt: String(tx.processed_at ?? tx.created_at ?? "").trim() || null
      };
    })
    .filter((row): row is { gateway: string; amount: number; currency: string; occurredAt: string | null } => !!row);

  if (rows.length > 0) return rows;

  const totalAmount = Math.max(0, toNumber(payload.total_price));
  const outstandingAmount = inferOutstandingAmount(payload, totalAmount);
  const paidAmount = Math.max(0, totalAmount - outstandingAmount);
  const gateways = (payload.payment_gateway_names ?? []).map((name) => String(name || "").trim()).filter(Boolean);
  if (paidAmount > 0 && gateways.length === 1) {
    return [
      {
        gateway: gateways[0],
        amount: paidAmount,
        currency,
        occurredAt: null
      }
    ];
  }

  return [];
}

function normalizeCreatedAt(payload: ShopifyOrderPayload): Date {
  const raw = String(payload.created_at || "").trim();
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function customerIdFromPayload(payload: ShopifyOrderPayload): string | null {
  const email = String(payload.customer?.email || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const phone = String(payload.customer?.phone || "").replace(/[^0-9]/g, "");
  if (phone) return `phone:${phone}`;
  return null;
}

async function upsertSingleOrder(client: PoolClient, payload: ShopifyOrderPayload): Promise<void> {
  const orderId = payload.id ? String(payload.id) : "";
  if (!orderId) return;

  const totalAmount = Math.max(0, toNumber(payload.total_price));
  const outstandingAmount = inferOutstandingAmount(payload, totalAmount);
  const currency = String(payload.currency || "USD").toUpperCase();
  const createdAt = normalizeCreatedAt(payload);
  const customerLabel = [payload.customer?.first_name, payload.customer?.last_name].map((v) => String(v || "").trim()).filter(Boolean).join(" ").trim();
  const customerEmail = String(payload.customer?.email || "").trim() || null;
  const customerPhone = String(payload.customer?.phone || "").trim() || null;
  const paymentGateway = paymentGatewayLabel(payload) || null;
  const paymentRows = buildPaymentRows(payload);

  await client.query(
    `
      insert into orders (
        id, name, created_at, customer_id, customer_label, customer_email, customer_phone,
        currency, total_amount, outstanding_amount, financial_status, shipping_status,
        payment_gateway, order_location, raw, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15::jsonb, now()
      )
      on conflict (id) do update set
        name = excluded.name,
        created_at = excluded.created_at,
        customer_id = excluded.customer_id,
        customer_label = excluded.customer_label,
        customer_email = excluded.customer_email,
        customer_phone = excluded.customer_phone,
        currency = excluded.currency,
        total_amount = excluded.total_amount,
        outstanding_amount = excluded.outstanding_amount,
        financial_status = excluded.financial_status,
        shipping_status = excluded.shipping_status,
        payment_gateway = excluded.payment_gateway,
        order_location = excluded.order_location,
        raw = excluded.raw,
        updated_at = now()
    `,
    [
      orderId,
      String(payload.name || `Order #${orderId}`),
      createdAt.toISOString(),
      customerIdFromPayload(payload),
      customerLabel || customerEmail || "Unknown customer",
      customerEmail,
      customerPhone,
      currency,
      totalAmount,
      outstandingAmount,
      String(payload.financial_status || "").trim() || null,
      String(payload.fulfillment_status || "").trim() || null,
      paymentGateway,
      String(payload.source_name || "").trim() || null,
      JSON.stringify(payload)
    ]
  );

  await client.query("delete from order_items where order_id = $1", [orderId]);
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  if (lineItems.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    lineItems.forEach((item, i) => {
      const lineId = item.id ? String(item.id) : `line-${i}`;
      const base = values.length;
      values.push(
        orderId,
        lineId,
        String(item.title || "Untitled article"),
        Math.max(1, Math.floor(toNumber(item.quantity || 1))),
        Math.max(0, toNumber(item.price || 0)),
        String(item.fulfillment_status || "").trim() || null
      );
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
    });
    await client.query(
      `
        insert into order_items (order_id, line_id, title, quantity, unit_price, status)
        values ${placeholders.join(",")}
        on conflict (order_id, line_id) do update set
          title = excluded.title,
          quantity = excluded.quantity,
          unit_price = excluded.unit_price,
          status = excluded.status
      `,
      values
    );
  }

  await client.query("delete from order_payments where order_id = $1", [orderId]);
  if (paymentRows.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    paymentRows.forEach((row) => {
      const base = values.length;
      values.push(orderId, row.gateway, row.amount, row.currency, row.occurredAt);
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    });
    await client.query(
      `
        insert into order_payments (order_id, gateway, amount, currency, occurred_at)
        values ${placeholders.join(",")}
      `,
      values
    );
  }
}

export async function persistOrdersPayloads(payloads: ShopifyOrderPayload[]): Promise<number> {
  const pool: Pool | null = getDbPool();
  if (!pool || payloads.length === 0) return 0;

  const startedAt = Date.now();
  const client = await pool.connect();
  let persisted = 0;
  try {
    await client.query("begin");
    for (const payload of payloads) {
      await upsertSingleOrder(client, payload);
      persisted += 1;
    }
    await client.query("commit");
    const elapsedMs = Date.now() - startedAt;
    console.log(`[sync-db] Persisted ${persisted} order(s) in ${elapsedMs}ms.`);
  } catch (error) {
    await client.query("rollback");
    console.error("[sync-db] Transaction rolled back while persisting Shopify orders.", error);
    throw error;
  } finally {
    client.release();
  }

  return persisted;
}

export async function upsertManyFromShopifyPayloads(orders: ShopifyOrder[]): Promise<number> {
  return persistOrdersPayloads(orders);
}

export async function persistOrderPayload(payload: ShopifyOrderPayload): Promise<void> {
  await persistOrdersPayloads([payload]);
}

export async function listOrdersForAnalytics(fromIso: string, toExclusiveIso: string): Promise<AnalyticsOrderRecord[]> {
  const pool: Pool | null = getDbPool();
  if (!pool) return [];

  const result = await pool.query<{
    id: string;
    created_at: string;
    customer_id: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    customer_label: string | null;
    currency: string;
    total_amount: string | number;
    outstanding_amount: string | number;
    payment_gateway: string | null;
  }>(
    `
      select
        id,
        created_at,
        customer_id,
        customer_email,
        customer_phone,
        customer_label,
        currency,
        total_amount,
        outstanding_amount,
        payment_gateway
      from orders
      where created_at >= $1::timestamptz
        and created_at < $2::timestamptz
      order by created_at asc
    `,
    [fromIso, toExclusiveIso]
  );

  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    customerId: row.customer_id,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    customerLabel: row.customer_label,
    currency: String(row.currency || "MAD").toUpperCase(),
    totalAmount: toNumber(row.total_amount),
    outstandingAmount: toNumber(row.outstanding_amount),
    paymentGateway: row.payment_gateway
  }));
}

export async function listPersistedOrderPayloads(
  fromIso: string,
  toExclusiveIso: string,
  limit = 800
): Promise<ShopifyOrderPayload[]> {
  const pool: Pool | null = getDbPool();
  if (!pool) return [];

  const result = await pool.query<{ raw: unknown }>(
    `
      select raw
      from orders
      where created_at >= $1::timestamptz
        and created_at < $2::timestamptz
      order by created_at desc
      limit $3
    `,
    [fromIso, toExclusiveIso, Math.max(1, Math.floor(limit))]
  );

  return result.rows
    .map((row) => row.raw)
    .filter((raw): raw is ShopifyOrderPayload => !!raw && typeof raw === "object");
}

export async function deleteOrderById(orderId: string): Promise<number> {
  const pool: Pool | null = getDbPool();
  if (!pool) return 0;
  const normalizedId = String(orderId || "").trim();
  if (!normalizedId) return 0;

  const result = await pool.query(
    `
      delete from orders
      where id = $1
    `,
    [normalizedId]
  );
  return Number(result.rowCount || 0);
}

export async function pruneOrdersMissingInRange(
  fromIso: string,
  toExclusiveIso: string,
  keepOrderIds: string[]
): Promise<number> {
  const pool: Pool | null = getDbPool();
  if (!pool) return 0;

  const keepIds = Array.from(
    new Set((Array.isArray(keepOrderIds) ? keepOrderIds : []).map((id) => String(id || "").trim()).filter(Boolean))
  );

  let result;
  if (keepIds.length === 0) {
    result = await pool.query(
      `
        delete from orders
        where created_at >= $1::timestamptz
          and created_at < $2::timestamptz
      `,
      [fromIso, toExclusiveIso]
    );
  } else {
    result = await pool.query(
      `
        delete from orders
        where created_at >= $1::timestamptz
          and created_at < $2::timestamptz
          and not (id = any($3::text[]))
      `,
      [fromIso, toExclusiveIso, keepIds]
    );
  }

  return Number(result.rowCount || 0);
}
