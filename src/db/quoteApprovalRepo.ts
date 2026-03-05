import { getDbPool } from "./client.js";

export type QuotePriceOption = {
  id: "A" | "B" | "C";
  label: string;
  amount: number;
  currency: "USD" | "EUR" | "MAD";
};

export type QuoteRequestRecord = {
  id: string;
  leadId: string;
  productHandle: string;
  productTitle: string;
  productImageUrl: string | null;
  availability: Record<string, unknown>;
  priceOptions: QuotePriceOption[];
  status: "PENDING" | "APPROVED" | "REJECTED";
  approvedOptionId: string | null;
  approvedPriceAmount: number | null;
  approvedCurrency: "USD" | "EUR" | "MAD" | null;
  approvedAvailability: boolean | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
};

export type QuoteDecisionApplyResult =
  | {
      ok: true;
      applied: true;
      record: QuoteRequestRecord;
      approved: boolean;
      decisionTimeSeconds: number;
    }
  | {
      ok: true;
      applied: false;
      record: QuoteRequestRecord;
      approved: boolean;
      decisionTimeSeconds: number | null;
      reason: "already_decided";
    }
  | {
      ok: false;
      reason: "not_found";
    };

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toCurrency(input: unknown): "USD" | "EUR" | "MAD" {
  const value = String(input || "MAD").trim().toUpperCase();
  if (value === "USD" || value === "EUR") return value;
  return "MAD";
}

function mapQuoteRequestRow(row: {
  id: string;
  lead_id: string;
  product_handle: string;
  product_title: string;
  product_image_url: string | null;
  availability: unknown;
  price_options: unknown;
  status: string;
  approved_option_id: string | null;
  approved_price_amount: string | number | null;
  approved_currency: string | null;
  approved_availability: boolean | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}): QuoteRequestRecord {
  const rawPriceOptions = Array.isArray(row.price_options) ? row.price_options : [];
  const priceOptions: QuotePriceOption[] = rawPriceOptions
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const id = String(obj.id || "").trim().toUpperCase();
      if (id !== "A" && id !== "B" && id !== "C") return null;
      const amount = Number(obj.amount);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return {
        id,
        label: String(obj.label || `Option ${id}`).trim() || `Option ${id}`,
        amount,
        currency: toCurrency(obj.currency)
      } as QuotePriceOption;
    })
    .filter((entry): entry is QuotePriceOption => Boolean(entry));

  return {
    id: row.id,
    leadId: row.lead_id,
    productHandle: String(row.product_handle || "").trim(),
    productTitle: String(row.product_title || "").trim(),
    productImageUrl: row.product_image_url ? String(row.product_image_url).trim() : null,
    availability: toObject(row.availability),
    priceOptions,
    status: String(row.status || "PENDING").trim().toUpperCase() as QuoteRequestRecord["status"],
    approvedOptionId: row.approved_option_id ? String(row.approved_option_id).trim() : null,
    approvedPriceAmount: row.approved_price_amount == null ? null : Number(row.approved_price_amount),
    approvedCurrency: row.approved_currency ? toCurrency(row.approved_currency) : null,
    approvedAvailability: row.approved_availability == null ? null : Boolean(row.approved_availability),
    approvedBy: row.approved_by ? String(row.approved_by).trim() : null,
    approvedAt: row.approved_at || null,
    createdAt: row.created_at
  };
}

export async function findRecentQuoteRequestByLeadProduct(input: {
  leadId: string;
  productHandle: string;
  withinMinutes?: number;
}): Promise<QuoteRequestRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const withinMinutes = Math.max(1, Math.min(60, Math.round(input.withinMinutes || 10)));
  const q = await db.query<{
    id: string;
    lead_id: string;
    product_handle: string;
    product_title: string;
    product_image_url: string | null;
    availability: unknown;
    price_options: unknown;
    status: string;
    approved_option_id: string | null;
    approved_price_amount: string | number | null;
    approved_currency: string | null;
    approved_availability: boolean | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
  }>(
    `
      select *
      from quote_requests
      where lead_id = $1::uuid
        and lower(product_handle) = lower($2::text)
        and created_at >= now() - ($3::int * interval '1 minute')
      order by created_at desc
      limit 1
    `,
    [input.leadId, input.productHandle, withinMinutes]
  );
  return q.rows[0] ? mapQuoteRequestRow(q.rows[0]) : null;
}

export async function createQuoteRequest(input: {
  leadId: string;
  productHandle: string;
  productTitle: string;
  productImageUrl?: string | null;
  availability: Record<string, unknown>;
  priceOptions: QuotePriceOption[];
}): Promise<QuoteRequestRecord> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    product_handle: string;
    product_title: string;
    product_image_url: string | null;
    availability: unknown;
    price_options: unknown;
    status: string;
    approved_option_id: string | null;
    approved_price_amount: string | number | null;
    approved_currency: string | null;
    approved_availability: boolean | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
  }>(
    `
      insert into quote_requests (
        lead_id,
        product_handle,
        product_title,
        product_image_url,
        availability,
        price_options
      )
      values (
        $1::uuid,
        lower($2::text),
        $3::text,
        nullif(trim($4::text), ''),
        $5::jsonb,
        $6::jsonb
      )
      returning *
    `,
    [
      input.leadId,
      input.productHandle,
      input.productTitle,
      input.productImageUrl || null,
      JSON.stringify(input.availability || {}),
      JSON.stringify(input.priceOptions || [])
    ]
  );
  return mapQuoteRequestRow(q.rows[0]);
}

export async function createQuoteRequestIdempotent(input: {
  leadId: string;
  productHandle: string;
  productTitle: string;
  productImageUrl?: string | null;
  availability: Record<string, unknown>;
  priceOptions: QuotePriceOption[];
  withinMinutes?: number;
}): Promise<{ record: QuoteRequestRecord; created: boolean }> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const client = await db.connect();
  const withinMinutes = Math.max(1, Math.min(60, Math.round(input.withinMinutes || 5)));
  try {
    await client.query("begin");
    await client.query(
      `
        select pg_advisory_xact_lock(hashtext($1::text || ':' || lower($2::text)))
      `,
      [input.leadId, input.productHandle]
    );

    const existing = await client.query<{
      id: string;
      lead_id: string;
      product_handle: string;
      product_title: string;
      product_image_url: string | null;
      availability: unknown;
      price_options: unknown;
      status: string;
      approved_option_id: string | null;
      approved_price_amount: string | number | null;
      approved_currency: string | null;
      approved_availability: boolean | null;
      approved_by: string | null;
      approved_at: string | null;
      created_at: string;
    }>(
      `
        select *
        from quote_requests
        where lead_id = $1::uuid
          and lower(product_handle) = lower($2::text)
          and created_at >= now() - ($3::int * interval '1 minute')
        order by created_at desc
        limit 1
      `,
      [input.leadId, input.productHandle, withinMinutes]
    );

    if (existing.rows[0]) {
      await client.query("commit");
      return {
        record: mapQuoteRequestRow(existing.rows[0]),
        created: false
      };
    }

    const inserted = await client.query<{
      id: string;
      lead_id: string;
      product_handle: string;
      product_title: string;
      product_image_url: string | null;
      availability: unknown;
      price_options: unknown;
      status: string;
      approved_option_id: string | null;
      approved_price_amount: string | number | null;
      approved_currency: string | null;
      approved_availability: boolean | null;
      approved_by: string | null;
      approved_at: string | null;
      created_at: string;
    }>(
      `
        insert into quote_requests (
          lead_id,
          product_handle,
          product_title,
          product_image_url,
          availability,
          price_options
        )
        values (
          $1::uuid,
          lower($2::text),
          $3::text,
          nullif(trim($4::text), ''),
          $5::jsonb,
          $6::jsonb
        )
        returning *
      `,
      [
        input.leadId,
        input.productHandle,
        input.productTitle,
        input.productImageUrl || null,
        JSON.stringify(input.availability || {}),
        JSON.stringify(input.priceOptions || [])
      ]
    );

    await client.query("commit");
    return {
      record: mapQuoteRequestRow(inserted.rows[0]),
      created: true
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getQuoteRequestById(id: string): Promise<QuoteRequestRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    product_handle: string;
    product_title: string;
    product_image_url: string | null;
    availability: unknown;
    price_options: unknown;
    status: string;
    approved_option_id: string | null;
    approved_price_amount: string | number | null;
    approved_currency: string | null;
    approved_availability: boolean | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
  }>(
    `
      select *
      from quote_requests
      where id = $1::uuid
      limit 1
    `,
    [id]
  );
  return q.rows[0] ? mapQuoteRequestRow(q.rows[0]) : null;
}

export async function createQuoteAction(input: {
  quoteRequestId: string;
  actionType: "APPROVE_PRICE" | "REQUEST_PRICE_EDIT" | "MARK_READY_PIECE" | "PRICE_OVERRIDE" | "MARK_OOS" | "SEND_TO_CLIENT";
  payload?: Record<string, unknown>;
}): Promise<void> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  await db.query(
    `
      insert into quote_actions (quote_request_id, action_type, payload)
      values ($1::uuid, $2::text, $3::jsonb)
    `,
    [input.quoteRequestId, input.actionType, JSON.stringify(input.payload || {})]
  );
}

export async function markQuoteRequestApproved(input: {
  quoteRequestId: string;
  optionId: "A" | "B" | "C";
  amount: number;
  currency: "USD" | "EUR" | "MAD";
  actor: string;
}): Promise<boolean> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query(
    `
      update quote_requests
      set
        status = 'APPROVED',
        approved_option_id = $2::text,
        approved_price_amount = $3::numeric,
        approved_currency = $4::text,
        approved_availability = true,
        approved_by = $5::text,
        approved_at = now()
      where id = $1::uuid
        and status = 'PENDING'
    `,
    [input.quoteRequestId, input.optionId, input.amount, input.currency, input.actor]
  );
  return Number(q.rowCount || 0) > 0;
}

export async function markQuoteRequestRejected(input: {
  quoteRequestId: string;
  actor: string;
}): Promise<boolean> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query(
    `
      update quote_requests
      set
        status = 'REJECTED',
        approved_option_id = 'OOS',
        approved_availability = false,
        approved_by = $2::text,
        approved_at = now()
      where id = $1::uuid
        and status = 'PENDING'
    `,
    [input.quoteRequestId, input.actor]
  );
  return Number(q.rowCount || 0) > 0;
}

export async function applyQuoteDecisionAtomic(input: {
  quoteRequestId: string;
  decision: "APPROVE" | "EDIT" | "READY" | "PRICE_OVERRIDE";
  actor: string;
  analyticsEnabled: boolean;
  overrideAmount?: number | null;
  overrideCurrency?: "USD" | "EUR" | "MAD" | null;
}): Promise<QuoteDecisionApplyResult> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const client = await db.connect();
  try {
    await client.query("begin");

    const current = await client.query<{
      id: string;
      lead_id: string;
      product_handle: string;
      product_title: string;
      product_image_url: string | null;
      availability: unknown;
      price_options: unknown;
      status: string;
      approved_option_id: string | null;
      approved_price_amount: string | number | null;
      approved_currency: string | null;
      approved_availability: boolean | null;
      approved_by: string | null;
      approved_at: string | null;
      created_at: string;
    }>(
      `
        select *
        from quote_requests
        where id = $1::uuid
        for update
      `,
      [input.quoteRequestId]
    );

    if (!current.rows[0]) {
      await client.query("rollback");
      return { ok: false, reason: "not_found" };
    }

    const currentRecord = mapQuoteRequestRow(current.rows[0]);
    if (currentRecord.status !== "PENDING") {
      await client.query("commit");
      return {
        ok: true,
        applied: false,
        record: currentRecord,
        approved: false,
        decisionTimeSeconds: null,
        reason: "already_decided"
      };
    }

    const previouslyDecided = Boolean(currentRecord.approvedOptionId);
    if (input.decision !== "PRICE_OVERRIDE" && previouslyDecided) {
      await client.query("commit");
      return {
        ok: true,
        applied: false,
        record: currentRecord,
        approved: false,
        decisionTimeSeconds: null,
        reason: "already_decided"
      };
    }

    if (input.decision === "EDIT") {
      await client.query(
        `
          insert into quote_actions (quote_request_id, action_type, payload)
          values ($1::uuid, 'REQUEST_PRICE_EDIT', $2::jsonb)
        `,
        [
          input.quoteRequestId,
          JSON.stringify({
            actor: input.actor,
            decision: "EDIT"
          })
        ]
      );

      await client.query(
        `
          update quote_requests
          set
            approved_option_id = 'EDIT',
            approved_by = $2::text,
            approved_at = now()
          where id = $1::uuid
        `,
        [input.quoteRequestId, input.actor]
      );
    } else if (input.decision === "READY") {
      await client.query(
        `
          insert into quote_actions (quote_request_id, action_type, payload)
          values ($1::uuid, 'MARK_READY_PIECE', $2::jsonb)
        `,
        [
          input.quoteRequestId,
          JSON.stringify({
            actor: input.actor,
            decision: "READY"
          })
        ]
      );

      await client.query(
        `
          update quote_requests
          set
            approved_option_id = 'READY',
            approved_by = $2::text,
            approved_at = now()
          where id = $1::uuid
        `,
        [input.quoteRequestId, input.actor]
      );
    } else if (input.decision === "PRICE_OVERRIDE") {
      if (currentRecord.approvedOptionId !== "EDIT") {
        await client.query("rollback");
        return { ok: false, reason: "not_found" };
      }
      const fallbackOption = currentRecord.priceOptions.find((item) => item.id === "A") || currentRecord.priceOptions[0] || null;
      const amount = Number(input.overrideAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        await client.query("rollback");
        return { ok: false, reason: "not_found" };
      }
      const currency = input.overrideCurrency || fallbackOption?.currency || "MAD";

      await client.query(
        `
          insert into quote_actions (quote_request_id, action_type, payload)
          values ($1::uuid, 'PRICE_OVERRIDE', $2::jsonb)
        `,
        [
          input.quoteRequestId,
          JSON.stringify({
            actor: input.actor,
            decision: "PRICE_OVERRIDE",
            amount,
            currency
          })
        ]
      );

      await client.query(
        `
          update quote_requests
          set
            status = 'APPROVED',
            approved_option_id = $2::text,
            approved_price_amount = $3::numeric,
            approved_currency = $4::text,
            approved_availability = true,
            approved_by = $5::text,
            approved_at = now()
          where id = $1::uuid
        `,
        [input.quoteRequestId, "MANAGER_OVERRIDE", amount, currency, input.actor]
      );
    } else {
      const option = currentRecord.priceOptions.find((item) => item.id === "A") || currentRecord.priceOptions[0] || null;
      if (!option) {
        await client.query("rollback");
        return { ok: false, reason: "not_found" };
      }

      await client.query(
        `
          insert into quote_actions (quote_request_id, action_type, payload)
          values ($1::uuid, 'APPROVE_PRICE', $2::jsonb)
        `,
        [
          input.quoteRequestId,
          JSON.stringify({
            actor: input.actor,
            decision: "APPROVE",
            option
          })
        ]
      );

      await client.query(
        `
          update quote_requests
          set
            status = 'APPROVED',
            approved_option_id = 'APPROVE',
            approved_price_amount = $2::numeric,
            approved_currency = $3::text,
            approved_availability = true,
            approved_by = $4::text,
            approved_at = now()
          where id = $1::uuid
        `,
        [input.quoteRequestId, option.amount, option.currency, input.actor]
      );
    }

    const updated = await client.query<{
      id: string;
      lead_id: string;
      product_handle: string;
      product_title: string;
      product_image_url: string | null;
      availability: unknown;
      price_options: unknown;
      status: string;
      approved_option_id: string | null;
      approved_price_amount: string | number | null;
      approved_currency: string | null;
      approved_availability: boolean | null;
      approved_by: string | null;
      approved_at: string | null;
      created_at: string;
    }>(
      `
        select *
        from quote_requests
        where id = $1::uuid
        limit 1
      `,
      [input.quoteRequestId]
    );

    const updatedRecord = mapQuoteRequestRow(updated.rows[0]);
    const decisionTimeSeconds = Math.max(
      0,
      Math.round(
        (new Date(updatedRecord.approvedAt || new Date().toISOString()).getTime() - new Date(updatedRecord.createdAt).getTime()) /
          1000
      )
    );

    if (input.analyticsEnabled) {
      await client.query(
        `
          insert into quote_approval_metrics (
            quote_request_id,
            decision_time_seconds,
            approved
          )
          values ($1::uuid, $2::int, $3::boolean)
        `,
        [updatedRecord.id, decisionTimeSeconds, updatedRecord.status === "APPROVED"]
      );
    }

    await client.query("commit");
    return {
      ok: true,
      applied: true,
      record: updatedRecord,
      approved: updatedRecord.status === "APPROVED",
      decisionTimeSeconds
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getQuoteApprovalStats(rangeDays: number): Promise<{
  approvalRate: number;
  rejectionRate: number;
  avgDecisionTimeSeconds: number;
  count: number;
}> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const days = Math.max(1, Math.min(365, Math.round(rangeDays || 30)));
  const q = await db.query<{
    count_total: string;
    approved_count: string;
    rejected_count: string;
    avg_decision_time_seconds: string | null;
  }>(
    `
      select
        count(*)::text as count_total,
        count(*) filter (where approved is true)::text as approved_count,
        count(*) filter (where approved is false)::text as rejected_count,
        avg(decision_time_seconds)::text as avg_decision_time_seconds
      from quote_approval_metrics
      where created_at >= now() - ($1::int * interval '1 day')
    `,
    [days]
  );
  const row = q.rows[0] || {
    count_total: "0",
    approved_count: "0",
    rejected_count: "0",
    avg_decision_time_seconds: "0"
  };
  const count = Number(row.count_total || 0);
  const approvedCount = Number(row.approved_count || 0);
  const rejectedCount = Number(row.rejected_count || 0);
  return {
    approvalRate: count > 0 ? Number(((approvedCount / count) * 100).toFixed(2)) : 0,
    rejectionRate: count > 0 ? Number(((rejectedCount / count) * 100).toFixed(2)) : 0,
    avgDecisionTimeSeconds: Number.isFinite(Number(row.avg_decision_time_seconds))
      ? Number(Number(row.avg_decision_time_seconds).toFixed(2))
      : 0,
    count
  };
}

export async function getLatestPendingEditQuoteRequestByActor(actor: string): Promise<QuoteRequestRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    product_handle: string;
    product_title: string;
    product_image_url: string | null;
    availability: unknown;
    price_options: unknown;
    status: string;
    approved_option_id: string | null;
    approved_price_amount: string | number | null;
    approved_currency: string | null;
    approved_availability: boolean | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
  }>(
    `
      select *
      from quote_requests
      where status = 'PENDING'
        and approved_option_id = 'EDIT'
        and approved_by = $1::text
      order by approved_at desc nulls last, created_at desc
      limit 1
    `,
    [actor]
  );
  return q.rows[0] ? mapQuoteRequestRow(q.rows[0]) : null;
}

export async function getLatestPendingEditQuoteRequestByLead(leadId: string): Promise<QuoteRequestRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    product_handle: string;
    product_title: string;
    product_image_url: string | null;
    availability: unknown;
    price_options: unknown;
    status: string;
    approved_option_id: string | null;
    approved_price_amount: string | number | null;
    approved_currency: string | null;
    approved_availability: boolean | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
  }>(
    `
      select *
      from quote_requests
      where lead_id = $1::uuid
        and status = 'PENDING'
        and approved_option_id = 'EDIT'
      order by approved_at desc nulls last, created_at desc
      limit 1
    `,
    [leadId]
  );
  return q.rows[0] ? mapQuoteRequestRow(q.rows[0]) : null;
}
