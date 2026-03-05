import { listOrdersForAnalytics, type AnalyticsOrderRecord } from "../db/ordersRepo.js";
import { listOrdersForQueue, type OrderSnapshot } from "./orderSnapshots.js";

type InsightLevel = "info" | "warning";
type InsightKind = "growth" | "risk" | "concentration" | "stability";

export type InsightMessage = {
  level: InsightLevel;
  kind: InsightKind;
  title: string;
  message: string;
};

export type DashboardInsights = {
  period: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    days: number;
  };
  metrics: {
    orders: number;
    revenueMad: number;
    aovMad: number;
    repeatCustomerRate: number;
    outstandingMad: number;
  };
  deltas: {
    ordersPct: number | null;
    revenuePct: number | null;
    aovPct: number | null;
    repeatRatePts: number;
  };
  messages: InsightMessage[];
};

export type DashboardSeriesPoint = {
  date: string;
  orders: number;
  revenueMad: number;
  aovMad: number;
  repeatRate: number;
};

type ComputedStats = {
  orders: number;
  revenueMad: number;
  aovMad: number;
  repeatCustomerRate: number;
  outstandingMad: number;
  maxDayRevenue: number;
  maxDayRevenueDate: string;
};

const MAD_RATES: Record<string, number> = {
  MAD: 1,
  EUR: 10.9,
  USD: 10,
  GBP: 12.7,
  CAD: 7.4
};

function toMad(amount: number, currency: string): number {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const code = String(currency || "MAD").toUpperCase();
  return safeAmount * (MAD_RATES[code] ?? 1);
}

function toIsoDay(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || "").trim();
  if (!text) return "";
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct && direct[1]) return direct[1];
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function customerKey(order: Pick<AnalyticsOrderRecord, "customerId" | "customerEmail" | "customerPhone" | "customerLabel">): string {
  if (order.customerId) return `id:${order.customerId}`;
  const email = String(order.customerEmail || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const phoneDigits = String(order.customerPhone || "").replace(/[^0-9]/g, "");
  if (phoneDigits) return `phone:${phoneDigits}`;
  return `label:${String(order.customerLabel || "unknown").trim().toLowerCase() || "unknown"}`;
}

function computeStats(rows: AnalyticsOrderRecord[]): ComputedStats {
  const byCustomer = new Map<string, number>();
  const byDayRevenue = new Map<string, number>();
  let revenueMad = 0;
  let outstandingMad = 0;

  rows.forEach((row) => {
    const rowRevenueMad = toMad(Math.max(0, row.totalAmount), row.currency);
    const rowOutstandingMad = toMad(Math.max(0, row.outstandingAmount), row.currency);
    revenueMad += rowRevenueMad;
    outstandingMad += rowOutstandingMad;

    const day = toIsoDay(row.createdAt);
    if (!day) return;
    byDayRevenue.set(day, (byDayRevenue.get(day) || 0) + rowRevenueMad);

    const key = customerKey(row);
    byCustomer.set(key, (byCustomer.get(key) || 0) + 1);
  });

  const repeatCustomers = Array.from(byCustomer.values()).filter((count) => count > 1).length;
  const repeatCustomerRate = byCustomer.size > 0 ? (repeatCustomers / byCustomer.size) * 100 : 0;

  let maxDayRevenue = 0;
  let maxDayRevenueDate = "";
  byDayRevenue.forEach((amount, day) => {
    if (amount > maxDayRevenue) {
      maxDayRevenue = amount;
      maxDayRevenueDate = day;
    }
  });

  return {
    orders: rows.length,
    revenueMad,
    aovMad: rows.length > 0 ? revenueMad / rows.length : 0,
    repeatCustomerRate,
    outstandingMad,
    maxDayRevenue,
    maxDayRevenueDate
  };
}

function percentageDelta(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function formatMad(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "MAD",
    maximumFractionDigits: 0
  }).format(Math.round(value));
}

function formatPeriodDay(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function buildMessages(current: ComputedStats, previous: ComputedStats): InsightMessage[] {
  const messages: InsightMessage[] = [];

  const revenueDelta = percentageDelta(current.revenueMad, previous.revenueMad);
  if (revenueDelta !== null) {
    if (revenueDelta >= 20) {
      messages.push({
        level: "info",
        kind: "growth",
        title: "Croissance solide",
        message: `Le chiffre d'affaires progresse de ${revenueDelta.toFixed(1)}% vs période précédente.`
      });
    } else if (revenueDelta <= -20) {
      messages.push({
        level: "warning",
        kind: "risk",
        title: "Baisse du chiffre d'affaires",
        message: `Le chiffre d'affaires recule de ${Math.abs(revenueDelta).toFixed(1)}% vs période précédente.`
      });
    }
  }

  const collectionRate = current.revenueMad > 0 ? (current.outstandingMad / current.revenueMad) * 100 : 0;
  if (collectionRate >= 20) {
    messages.push({
      level: "warning",
      kind: "risk",
      title: "Risque encaissement",
      message: `${collectionRate.toFixed(1)}% du CA est encore en solde restant (${formatMad(current.outstandingMad)}).`
    });
  }

  if (current.maxDayRevenue > 0 && current.revenueMad > 0) {
    const peakShare = (current.maxDayRevenue / current.revenueMad) * 100;
    if (peakShare >= 35) {
      messages.push({
        level: "info",
        kind: "concentration",
        title: "Pic de vente concentré",
        message: `${peakShare.toFixed(1)}% du CA vient du ${formatPeriodDay(current.maxDayRevenueDate)}. Prévoir stock et capacité sur ce créneau.`
      });
    }
  }

  if (messages.length === 0) {
    messages.push({
      level: "info",
      kind: "stability",
      title: "Tendance stable",
      message: "Aucune anomalie forte détectée sur la période. Continuez le suivi hebdomadaire."
    });
  }

  return messages.slice(0, 3);
}

function snapshotToAnalytics(order: OrderSnapshot): AnalyticsOrderRecord {
  return {
    id: order.id,
    createdAt: order.createdAt,
    customerId: null,
    customerEmail: order.customerEmail || null,
    customerPhone: order.customerPhone || null,
    customerLabel: order.customerLabel || null,
    currency: String(order.currency || "MAD").toUpperCase(),
    totalAmount: Number(order.totalAmount || 0),
    outstandingAmount: Number(order.outstandingAmount || 0),
    paymentGateway: order.paymentGateway || null
  };
}

function loadAnalyticsRowsWithFallback(
  from: Date,
  toExclusive: Date
): Promise<AnalyticsOrderRecord[]> {
  return listOrdersForAnalytics(from.toISOString(), toExclusive.toISOString()).then((rows) => {
    if (rows.length > 0) return rows;
    const queueOrders = listOrdersForQueue().map(snapshotToAnalytics);
    return queueOrders.filter((order) => {
      const at = new Date(order.createdAt).getTime();
      return Number.isFinite(at) && at >= from.getTime() && at < toExclusive.getTime();
    });
  });
}

export async function computeDashboardInsights(
  from: Date,
  toExclusive: Date,
  comparisonRange?: { from: Date; toExclusive: Date }
): Promise<DashboardInsights> {
  const periodDays = Math.max(1, Math.ceil((toExclusive.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
  const previousToExclusive = comparisonRange?.toExclusive ?? new Date(from.getTime());
  const previousFrom =
    comparisonRange?.from ?? new Date(from.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const currentRows = await loadAnalyticsRowsWithFallback(from, toExclusive);
  const previousRows = await loadAnalyticsRowsWithFallback(previousFrom, previousToExclusive);

  const current = computeStats(currentRows);
  const previous = computeStats(previousRows);

  return {
    period: {
      from: from.toISOString().slice(0, 10),
      to: new Date(toExclusive.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      previousFrom: previousFrom.toISOString().slice(0, 10),
      previousTo: new Date(previousToExclusive.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      days: periodDays
    },
    metrics: {
      orders: current.orders,
      revenueMad: current.revenueMad,
      aovMad: current.aovMad,
      repeatCustomerRate: current.repeatCustomerRate,
      outstandingMad: current.outstandingMad
    },
    deltas: {
      ordersPct: percentageDelta(current.orders, previous.orders),
      revenuePct: percentageDelta(current.revenueMad, previous.revenueMad),
      aovPct: percentageDelta(current.aovMad, previous.aovMad),
      repeatRatePts: current.repeatCustomerRate - previous.repeatCustomerRate
    },
    messages: buildMessages(current, previous)
  };
}

export async function computeDashboardSeries(from: Date, toExclusive: Date): Promise<DashboardSeriesPoint[]> {
  const rows = await loadAnalyticsRowsWithFallback(from, toExclusive);
  const sorted = [...rows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.ceil((toExclusive.getTime() - from.getTime()) / dayMs));
  const points: DashboardSeriesPoint[] = [];
  const dayMap = new Map<string, { revenue: number; orders: number; uniqueCustomers: Set<string>; repeatCustomers: Set<string> }>();
  const seenCustomers = new Set<string>();

  for (let i = 0; i < totalDays; i += 1) {
    const day = new Date(from.getTime() + i * dayMs).toISOString().slice(0, 10);
    dayMap.set(day, {
      revenue: 0,
      orders: 0,
      uniqueCustomers: new Set<string>(),
      repeatCustomers: new Set<string>()
    });
  }

  sorted.forEach((row) => {
    const day = toIsoDay(row.createdAt);
    if (!day) return;
    const bucket = dayMap.get(day);
    if (!bucket) return;
    bucket.revenue += toMad(Math.max(0, row.totalAmount), row.currency);
    bucket.orders += 1;

    const key = customerKey(row);
    if (!bucket.uniqueCustomers.has(key)) {
      bucket.uniqueCustomers.add(key);
    }
    if (seenCustomers.has(key)) {
      bucket.repeatCustomers.add(key);
    }
    seenCustomers.add(key);
  });

  dayMap.forEach((bucket, day) => {
    const aovMad = bucket.orders > 0 ? bucket.revenue / bucket.orders : 0;
    const repeatRate =
      bucket.uniqueCustomers.size > 0
        ? (bucket.repeatCustomers.size / bucket.uniqueCustomers.size) * 100
        : 0;
    points.push({
      date: day,
      orders: bucket.orders,
      revenueMad: bucket.revenue,
      aovMad,
      repeatRate
    });
  });

  return points;
}
