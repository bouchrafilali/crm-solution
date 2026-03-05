import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getDbPool } from "./client.js";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "reminder_sent"
  | "rescheduled"
  | "cancelled"
  | "completed"
  | "no_show";

export type AppointmentType =
  | "fitting"
  | "measurements"
  | "pickup"
  | "alteration"
  | "vip_consultation";

export const APPOINTMENT_DEFAULT_DURATIONS: Record<AppointmentType, number> = {
  fitting: 60,
  measurements: 45,
  pickup: 30,
  alteration: 30,
  vip_consultation: 90
};

export type AppointmentRecord = {
  id: string;
  shop: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  appointmentAt: string;
  endAt: string;
  type: AppointmentType;
  durationMinutes: number;
  status: AppointmentStatus;
  location: string | null;
  notes: string | null;
  orderId: string | null;
  shopifyOrderId: string | null;
  orderStatus: string | null;
  orderName: string | null;
  orderTotalAmount: number | null;
  orderCurrency: string | null;
  reminderD1Enabled: boolean;
  reminderH3Enabled: boolean;
  reminderDesignerEnabled: boolean;
  reminderD1SentAt: string | null;
  reminderH3SentAt: string | null;
  reminderDesignerSentAt: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AppointmentMessageRecord = {
  id: number;
  appointmentId: string;
  shop: string;
  direction: string;
  channel: string;
  messageType: string | null;
  templateName: string | null;
  payload: unknown;
  providerStatus: string | null;
  sentAt: string;
  createdAt: string;
};

export type AppointmentRdvSnapshot = {
  available: boolean;
  lookbackDays: number;
  total: number;
  confirmed: number;
  noShowRate: number | null;
  rdvToOrderRate: number | null;
};

export type CreateAppointmentInput = {
  shop: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  appointmentAt: string;
  endAt?: string;
  type?: AppointmentType;
  durationMinutes?: number;
  status?: AppointmentStatus;
  location?: string | null;
  notes?: string | null;
  reminderD1Enabled?: boolean;
  reminderH3Enabled?: boolean;
  reminderDesignerEnabled?: boolean;
};

export type UpdateAppointmentInput = Partial<Omit<CreateAppointmentInput, "shop">> & {
  status?: AppointmentStatus;
  lastMessageAt?: string | null;
  orderId?: string | null;
  shopifyOrderId?: string | null;
  orderStatus?: string | null;
  orderName?: string | null;
  orderTotalAmount?: number | null;
  orderCurrency?: string | null;
  reminderD1SentAt?: string | null;
  reminderH3SentAt?: string | null;
  reminderDesignerSentAt?: string | null;
};

export type ReminderKind = "d1" | "h3";

type AppointmentRow = {
  id: string;
  shop: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  appointment_at: string;
  end_at: string;
  type: AppointmentType;
  duration_minutes: number;
  status: AppointmentStatus;
  location: string | null;
  notes: string | null;
  order_id: string | null;
  shopify_order_id: string | null;
  order_status: string | null;
  order_name: string | null;
  order_total_amount: string | number | null;
  order_currency: string | null;
  reminder_d1_enabled: boolean;
  reminder_h3_enabled: boolean;
  reminder_designer_enabled: boolean;
  reminder_d1_sent_at: string | null;
  reminder_h3_sent_at: string | null;
  reminder_designer_sent_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeType(type: string | null | undefined): AppointmentType {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "measurements") return "measurements";
  if (raw === "pickup") return "pickup";
  if (raw === "alteration") return "alteration";
  if (raw === "vip_consultation") return "vip_consultation";
  return "fitting";
}

function normalizeDuration(type: AppointmentType, durationMinutes?: number | null): number {
  const parsed = Number(durationMinutes);
  if (Number.isFinite(parsed) && parsed >= 15 && parsed <= 360) {
    return Math.floor(parsed);
  }
  return APPOINTMENT_DEFAULT_DURATIONS[type];
}

function computeEndAt(appointmentAtIso: string, durationMinutes: number): string {
  const start = new Date(appointmentAtIso);
  if (Number.isNaN(start.getTime())) return appointmentAtIso;
  return new Date(start.getTime() + durationMinutes * 60_000).toISOString();
}

function mapRow(row: AppointmentRow): AppointmentRecord {
  const type = normalizeType(row.type);
  const durationMinutes = normalizeDuration(type, row.duration_minutes);
  const endAt = row.end_at || computeEndAt(row.appointment_at, durationMinutes);
  return {
    id: row.id,
    shop: row.shop,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    appointmentAt: row.appointment_at,
    endAt,
    type,
    durationMinutes,
    status: row.status,
    location: row.location,
    notes: row.notes,
    orderId: row.order_id,
    shopifyOrderId: row.shopify_order_id,
    orderStatus: row.order_status,
    orderName: row.order_name,
    orderTotalAmount:
      row.order_total_amount == null
        ? null
        : Number.isFinite(Number(row.order_total_amount))
          ? Number(row.order_total_amount)
          : null,
    orderCurrency: row.order_currency,
    reminderD1Enabled: Boolean(row.reminder_d1_enabled),
    reminderH3Enabled: Boolean(row.reminder_h3_enabled),
    reminderDesignerEnabled: Boolean(row.reminder_designer_enabled),
    reminderD1SentAt: row.reminder_d1_sent_at,
    reminderH3SentAt: row.reminder_h3_sent_at,
    reminderDesignerSentAt: row.reminder_designer_sent_at,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function appointmentSelectSql(): string {
  return `
    id, shop, customer_name, customer_phone, customer_email,
    appointment_at, end_at, type, duration_minutes, status, location, notes,
    order_id, shopify_order_id, order_status, order_name, order_total_amount, order_currency,
    reminder_d1_enabled, reminder_h3_enabled, reminder_designer_enabled,
    reminder_d1_sent_at, reminder_h3_sent_at, reminder_designer_sent_at,
    last_message_at, created_at, updated_at
  `;
}

export function resolveAppointmentWindow(
  appointmentAt: string,
  typeInput?: string | null,
  durationMinutesInput?: number | null,
  endAtInput?: string | null
): { type: AppointmentType; durationMinutes: number; appointmentAt: string; endAt: string } {
  const type = normalizeType(typeInput);
  const durationMinutes = normalizeDuration(type, durationMinutesInput);
  const start = new Date(appointmentAt);
  const safeStart = Number.isNaN(start.getTime()) ? new Date() : start;
  const fallbackEnd = new Date(safeStart.getTime() + durationMinutes * 60_000).toISOString();
  const rawEndAt = String(endAtInput || "").trim();
  const parsedEnd = rawEndAt ? new Date(rawEndAt) : new Date(fallbackEnd);
  const endAt =
    !Number.isNaN(parsedEnd.getTime()) && parsedEnd.getTime() > safeStart.getTime()
      ? parsedEnd.toISOString()
      : fallbackEnd;
  return {
    type,
    durationMinutes,
    appointmentAt: safeStart.toISOString(),
    endAt
  };
}

export async function listAppointmentsByShop(
  shop: string,
  limit = 300,
  filters?: { type?: AppointmentType | "all" }
): Promise<AppointmentRecord[]> {
  const pool: Pool | null = getDbPool();
  if (!pool) return [];
  const filterType = filters?.type && filters.type !== "all" ? normalizeType(filters.type) : null;
  const params: unknown[] = [shop];
  let where = `where shop = $1`;
  if (filterType) {
    params.push(filterType);
    where += ` and type = $${params.length}`;
  }
  params.push(Math.max(1, Math.floor(limit)));

  const result = await pool.query<AppointmentRow>(
    `
      select ${appointmentSelectSql()}
      from appointments
      ${where}
      order by appointment_at asc
      limit $${params.length}
    `,
    params
  );
  return result.rows.map(mapRow);
}

export async function listAppointmentsForMetafield(shop: string, limit = 120): Promise<AppointmentRecord[]> {
  const pool: Pool | null = getDbPool();
  if (!pool) return [];
  const result = await pool.query<AppointmentRow>(
    `
      select ${appointmentSelectSql()}
      from appointments
      where shop = $1
      order by appointment_at desc
      limit $2
    `,
    [shop, Math.max(1, Math.floor(limit))]
  );
  return result.rows.map(mapRow).reverse();
}

export async function findAppointmentConflict(
  shop: string,
  location: string | null | undefined,
  appointmentAt: string,
  endAt: string,
  excludeAppointmentId?: string
): Promise<AppointmentRecord | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;
  const whereLocation = String(location || "").trim();
  const params: unknown[] = [shop, whereLocation, appointmentAt, endAt];
  let excludeSql = "";
  if (excludeAppointmentId) {
    params.push(excludeAppointmentId);
    excludeSql = `and id <> $${params.length}`;
  }
  const result = await pool.query<AppointmentRow>(
    `
      select ${appointmentSelectSql()}
      from appointments
      where shop = $1
        and coalesce(location, '') = $2
        and status <> 'cancelled'
        and tstzrange(appointment_at, end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
        ${excludeSql}
      order by appointment_at asc
      limit 1
    `,
    params
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function createAppointment(input: CreateAppointmentInput): Promise<AppointmentRecord | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;
  const id = randomUUID();
  const window = resolveAppointmentWindow(input.appointmentAt, input.type, input.durationMinutes, input.endAt);
  const result = await pool.query<AppointmentRow>(
    `
      insert into appointments (
        id, shop, customer_name, customer_phone, customer_email, appointment_at, end_at,
        type, duration_minutes, status, location, notes,
        reminder_d1_enabled, reminder_h3_enabled, reminder_designer_enabled,
        created_at, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
        $8, $9, $10, $11, $12, $13, $14, $15, now(), now()
      )
      returning ${appointmentSelectSql()}
    `,
    [
      id,
      input.shop,
      input.customerName,
      input.customerPhone,
      input.customerEmail || null,
      window.appointmentAt,
      window.endAt,
      window.type,
      window.durationMinutes,
      input.status || "scheduled",
      input.location || null,
      input.notes || null,
      input.reminderD1Enabled ?? true,
      input.reminderH3Enabled ?? true,
      input.reminderDesignerEnabled ?? true
    ]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function updateAppointment(
  shop: string,
  id: string,
  patch: UpdateAppointmentInput
): Promise<AppointmentRecord | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;

  const existingResult = await pool.query<AppointmentRow>(
    `select ${appointmentSelectSql()} from appointments where shop = $1 and id = $2 limit 1`,
    [shop, id]
  );
  const existing = existingResult.rows[0] ? mapRow(existingResult.rows[0]) : null;
  if (!existing) return null;

  const mergedAt = patch.appointmentAt ?? existing.appointmentAt;
  const mergedType = normalizeType(patch.type ?? existing.type);
  const mergedDuration = normalizeDuration(mergedType, patch.durationMinutes ?? existing.durationMinutes);
  const mergedEndAt = patch.endAt ?? existing.endAt;
  const window = resolveAppointmentWindow(mergedAt, mergedType, mergedDuration, mergedEndAt);

  const result = await pool.query<AppointmentRow>(
    `
      update appointments
      set
        customer_name = coalesce($3, customer_name),
        customer_phone = coalesce($4, customer_phone),
        customer_email = coalesce($5, customer_email),
        appointment_at = $6::timestamptz,
        end_at = $7::timestamptz,
        type = $8,
        duration_minutes = $9,
        status = coalesce($10, status),
        location = coalesce($11, location),
        notes = coalesce($12, notes),
        order_id = coalesce($13, order_id),
        shopify_order_id = coalesce($14, shopify_order_id),
        order_status = coalesce($15, order_status),
        order_name = coalesce($16, order_name),
        order_total_amount = coalesce($17::numeric, order_total_amount),
        order_currency = coalesce($18, order_currency),
        reminder_d1_enabled = coalesce($19::boolean, reminder_d1_enabled),
        reminder_h3_enabled = coalesce($20::boolean, reminder_h3_enabled),
        reminder_designer_enabled = coalesce($21::boolean, reminder_designer_enabled),
        reminder_d1_sent_at = coalesce($22::timestamptz, reminder_d1_sent_at),
        reminder_h3_sent_at = coalesce($23::timestamptz, reminder_h3_sent_at),
        reminder_designer_sent_at = coalesce($24::timestamptz, reminder_designer_sent_at),
        last_message_at = coalesce($25::timestamptz, last_message_at),
        updated_at = now()
      where shop = $1 and id = $2
      returning ${appointmentSelectSql()}
    `,
    [
      shop,
      id,
      patch.customerName ?? null,
      patch.customerPhone ?? null,
      patch.customerEmail ?? null,
      window.appointmentAt,
      window.endAt,
      window.type,
      window.durationMinutes,
      patch.status ?? null,
      patch.location ?? null,
      patch.notes ?? null,
      patch.orderId ?? null,
      patch.shopifyOrderId ?? null,
      patch.orderStatus ?? null,
      patch.orderName ?? null,
      patch.orderTotalAmount ?? null,
      patch.orderCurrency ?? null,
      patch.reminderD1Enabled ?? null,
      patch.reminderH3Enabled ?? null,
      patch.reminderDesignerEnabled ?? null,
      patch.reminderD1SentAt ?? null,
      patch.reminderH3SentAt ?? null,
      patch.reminderDesignerSentAt ?? null,
      patch.lastMessageAt ?? null
    ]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function clearDeletedShopifyOrderLink(orderId: string): Promise<number> {
  const pool: Pool | null = getDbPool();
  if (!pool) return 0;
  const normalized = String(orderId || "").trim();
  if (!normalized) return 0;

  const result = await pool.query<{ id: string }>(
    `
      update appointments
      set
        order_id = null,
        shopify_order_id = null,
        order_status = 'deleted',
        order_name = null,
        order_total_amount = null,
        order_currency = null,
        updated_at = now()
      where shopify_order_id = $1
         or order_id = $1
      returning id
    `,
    [normalized]
  );
  return result.rowCount || 0;
}

export async function markReminderSent(
  shop: string,
  id: string,
  kind: ReminderKind,
  sentAtIso: string
): Promise<AppointmentRecord | null> {
  if (kind === "d1") {
    return updateAppointment(shop, id, { reminderD1SentAt: sentAtIso, lastMessageAt: sentAtIso, status: "reminder_sent" });
  }
  return updateAppointment(shop, id, { reminderH3SentAt: sentAtIso, lastMessageAt: sentAtIso, status: "reminder_sent" });
}

export async function markDesignerReminderSent(
  shop: string,
  id: string,
  sentAtIso: string
): Promise<AppointmentRecord | null> {
  return updateAppointment(shop, id, {
    reminderDesignerSentAt: sentAtIso
  });
}

export async function deleteAppointment(shop: string, id: string): Promise<boolean> {
  const pool: Pool | null = getDbPool();
  if (!pool) return false;
  const result = await pool.query(`delete from appointments where shop = $1 and id = $2`, [shop, id]);
  return (result.rowCount || 0) > 0;
}

export async function getAppointmentById(shop: string, id: string): Promise<AppointmentRecord | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;
  const result = await pool.query<AppointmentRow>(
    `
      select ${appointmentSelectSql()}
      from appointments
      where shop = $1 and id = $2
      limit 1
    `,
    [shop, id]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listReminderCandidates(untilIso: string, limit = 500): Promise<AppointmentRecord[]> {
  const pool: Pool | null = getDbPool();
  if (!pool) return [];
  const nowIso = new Date().toISOString();
  const result = await pool.query<AppointmentRow>(
    `
      select ${appointmentSelectSql()}
      from appointments
      where appointment_at > $1::timestamptz
        and appointment_at <= $2::timestamptz
        and status in ('scheduled', 'confirmed', 'rescheduled')
      order by appointment_at asc
      limit $3
    `,
    [nowIso, untilIso, Math.max(1, Math.floor(limit))]
  );
  return result.rows.map(mapRow);
}

export async function addAppointmentMessage(input: {
  appointmentId: string;
  shop: string;
  direction?: string;
  channel?: string;
  messageType?: string | null;
  templateName?: string | null;
  payload?: unknown;
  providerStatus?: string | null;
  sentAt?: string | null;
}): Promise<AppointmentMessageRecord | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;
  const result = await pool.query<{
    id: number;
    appointment_id: string;
    shop: string;
    direction: string;
    channel: string;
    message_type: string | null;
    template_name: string | null;
    payload: unknown;
    provider_status: string | null;
    sent_at: string;
    created_at: string;
  }>(
    `
      insert into appointment_messages (
        appointment_id, shop, direction, channel, message_type, template_name, payload, provider_status, sent_at, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, coalesce($9::timestamptz, now()), now())
      returning
        id, appointment_id, shop, direction, channel, message_type, template_name, payload, provider_status, sent_at, created_at
    `,
    [
      input.appointmentId,
      input.shop,
      input.direction || "outbound",
      input.channel || "whatsapp",
      input.messageType || null,
      input.templateName || null,
      JSON.stringify(input.payload ?? null),
      input.providerStatus || null,
      input.sentAt || null
    ]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    shop: row.shop,
    direction: row.direction,
    channel: row.channel,
    messageType: row.message_type,
    templateName: row.template_name,
    payload: row.payload,
    providerStatus: row.provider_status,
    sentAt: row.sent_at,
    createdAt: row.created_at
  };
}

export async function listAppointmentMessages(
  shop: string,
  appointmentId: string,
  limit = 100
): Promise<AppointmentMessageRecord[]> {
  const pool: Pool | null = getDbPool();
  if (!pool) return [];
  const result = await pool.query<{
    id: number;
    appointment_id: string;
    shop: string;
    direction: string;
    channel: string;
    message_type: string | null;
    template_name: string | null;
    payload: unknown;
    provider_status: string | null;
    sent_at: string;
    created_at: string;
  }>(
    `
      select
        id, appointment_id, shop, direction, channel, message_type, template_name, payload, provider_status, sent_at, created_at
      from appointment_messages
      where shop = $1 and appointment_id = $2
      order by sent_at desc, id desc
      limit $3
    `,
    [shop, appointmentId, Math.max(1, Math.floor(limit))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    appointmentId: row.appointment_id,
    shop: row.shop,
    direction: row.direction,
    channel: row.channel,
    messageType: row.message_type,
    templateName: row.template_name,
    payload: row.payload,
    providerStatus: row.provider_status,
    sentAt: row.sent_at,
    createdAt: row.created_at
  }));
}

export async function getAppointmentRdvSnapshot(shop: string, lookbackDays = 180): Promise<AppointmentRdvSnapshot> {
  const pool: Pool | null = getDbPool();
  if (!pool) {
    return {
      available: false,
      lookbackDays,
      total: 0,
      confirmed: 0,
      noShowRate: null,
      rdvToOrderRate: null
    };
  }
  const days = Math.max(30, Math.min(365, Math.floor(Number(lookbackDays || 180))));
  const result = await pool.query<{
    total: string | number;
    confirmed: string | number;
    no_show: string | number;
    converted: string | number;
  }>(
    `
      select
        count(*)::int as total,
        count(*) filter (where status in ('confirmed', 'completed', 'reminder_sent'))::int as confirmed,
        count(*) filter (where status = 'no_show')::int as no_show,
        count(*) filter (where coalesce(shopify_order_id, order_id) is not null)::int as converted
      from appointments
      where shop = $1
        and appointment_at >= (now() - ($2::int * interval '1 day'))
    `,
    [shop, days]
  );

  const row = result.rows[0];
  const total = Math.max(0, Math.floor(Number(row?.total || 0)));
  const confirmed = Math.max(0, Math.floor(Number(row?.confirmed || 0)));
  const noShow = Math.max(0, Math.floor(Number(row?.no_show || 0)));
  const converted = Math.max(0, Math.floor(Number(row?.converted || 0)));
  const available = total >= 5;
  const noShowRate = confirmed > 0 ? noShow / confirmed : null;
  const rdvToOrderRate = confirmed > 0 ? converted / confirmed : null;

  return {
    available,
    lookbackDays: days,
    total,
    confirmed,
    noShowRate,
    rdvToOrderRate
  };
}
