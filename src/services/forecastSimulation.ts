// FORECAST V3 SIMULATION ENGINE
export type BaselineDailyPoint = {
  date: string;
  revenue_mad: number;
  orders: number;
};

export type SimulationConfig = {
  trafficPct: number;
  conversionPct: number;
  aovPct: number;
  showroomEnabled: boolean;
  showroomStartMonth: string | null;
  showroomMaxUpliftPct?: number;
  capacityEnabled: boolean;
  capacityLimitOrdersPerDay?: number | null;
};

export type SimulatedDailyPoint = BaselineDailyPoint & {
  baseline_revenue_mad: number;
  baseline_orders: number;
  capped: boolean;
};

export type SimulationResult = {
  simulatedDaily: SimulatedDailyPoint[];
  totals: {
    baseline_revenue_365: number;
    baseline_orders_365: number;
    revenue_365: number;
    orders_365: number;
  };
  deltas: {
    revenue_delta: number;
    orders_delta: number;
    revenue_delta_pct: number;
    orders_delta_pct: number;
  };
  constraints: {
    capped_days: number;
    capped_ratio: number;
    capacity_limit_orders_per_day: number;
    warning: boolean;
  };
  explanation: {
    trafficFactor: number;
    conversionFactor: number;
    aovFactor: number;
    showroomRampApplied: boolean;
    showroomStartMonth: string | null;
    showroomMaxUpliftPct: number;
    capacityLimitOrdersPerDay: number;
  };
};

export type MonthlyAggregatePoint = {
  month: string;
  revenue_mad: number;
  orders: number;
};

function round2(value: number): number {
  return Number(Number(value || 0).toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentile(values: number[], p: number): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function pctDelta(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function showroomRampFactor(
  isoDate: string,
  enabled: boolean,
  startMonth: string | null,
  maxUpliftPct: number
): number {
  if (!enabled) return 1;
  const start = String(startMonth || "").slice(0, 7);
  if (!start) return 1;
  const startDate = new Date(start + "-01T00:00:00Z");
  const d = new Date(String(isoDate || "") + "T00:00:00Z");
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(d.getTime())) return 1;
  if (d.getTime() < startDate.getTime()) return 1;
  const days = Math.floor((d.getTime() - startDate.getTime()) / 86400000);
  const rampDays = 90;
  const progress = clamp(days / rampDays, 0, 1);
  const uplift = (maxUpliftPct / 100) * progress;
  return 1 + uplift;
}

export function aggregateMonthly(daily: Array<{ date: string; revenue_mad: number; orders: number }>): MonthlyAggregatePoint[] {
  const map = new Map<string, { revenue: number; orders: number }>();
  (Array.isArray(daily) ? daily : []).forEach((row) => {
    const month = String(row.date || "").slice(0, 7);
    if (!month) return;
    const bucket = map.get(month) || { revenue: 0, orders: 0 };
    bucket.revenue += Number(row.revenue_mad || 0);
    bucket.orders += Number(row.orders || 0);
    map.set(month, bucket);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, agg]) => ({
      month,
      revenue_mad: round2(agg.revenue),
      orders: Math.max(0, Math.round(agg.orders))
    }));
}

export function deriveCapacityLimitOrdersPerDay(baselineDaily: BaselineDailyPoint[]): number {
  const values = (Array.isArray(baselineDaily) ? baselineDaily : [])
    .map((p) => Number(p.orders || 0))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const p90 = percentile(values, 0.9);
  return Math.max(1, Math.round(p90));
}

export function applySimulation(
  baselineDaily: BaselineDailyPoint[],
  config: SimulationConfig
): SimulationResult {
  const safeBaseline = Array.isArray(baselineDaily) ? baselineDaily : [];
  const trafficFactor = Math.max(0, 1 + (Number(config.trafficPct || 0) / 100));
  const conversionFactor = Math.max(0, 1 + (Number(config.conversionPct || 0) / 100));
  const aovFactor = Math.max(0, 1 + (Number(config.aovPct || 0) / 100));
  const showroomMaxUpliftPct = Number.isFinite(Number(config.showroomMaxUpliftPct))
    ? Number(config.showroomMaxUpliftPct)
    : 8;
  const derivedCap = deriveCapacityLimitOrdersPerDay(safeBaseline);
  const capacityLimitOrdersPerDay =
    Number.isFinite(Number(config.capacityLimitOrdersPerDay))
      ? Math.max(1, Math.round(Number(config.capacityLimitOrdersPerDay)))
      : derivedCap;

  let cappedDays = 0;

  const simulatedDaily: SimulatedDailyPoint[] = safeBaseline.map((row) => {
    const baselineOrders = Math.max(0, Number(row.orders || 0));
    const baselineRevenue = Math.max(0, Number(row.revenue_mad || 0));
    const baselineAov = baselineOrders > 0 ? baselineRevenue / baselineOrders : 0;
    if (baselineOrders <= 0) {
      return {
        date: String(row.date || ""),
        revenue_mad: 0,
        orders: 0,
        baseline_revenue_mad: round2(baselineRevenue),
        baseline_orders: Math.round(baselineOrders),
        capped: false
      };
    }

    const ramp = showroomRampFactor(
      String(row.date || ""),
      Boolean(config.showroomEnabled),
      config.showroomStartMonth,
      showroomMaxUpliftPct
    );

    let simulatedOrders =
      baselineOrders *
      trafficFactor *
      conversionFactor *
      ramp;
    let capped = false;
    if (config.capacityEnabled) {
      if (simulatedOrders > capacityLimitOrdersPerDay) {
        simulatedOrders = capacityLimitOrdersPerDay;
        capped = true;
      }
    }
    if (capped) cappedDays += 1;

    const simulatedRevenue = simulatedOrders * baselineAov * aovFactor;
    return {
      date: String(row.date || ""),
      revenue_mad: round2(Math.max(0, simulatedRevenue)),
      orders: Math.max(0, Math.round(simulatedOrders)),
      baseline_revenue_mad: round2(baselineRevenue),
      baseline_orders: Math.max(0, Math.round(baselineOrders)),
      capped
    };
  });

  const baselineRevenue365 = round2(safeBaseline.reduce((s, p) => s + Math.max(0, Number(p.revenue_mad || 0)), 0));
  const baselineOrders365 = Math.max(0, Math.round(safeBaseline.reduce((s, p) => s + Math.max(0, Number(p.orders || 0)), 0)));
  const revenue365 = round2(simulatedDaily.reduce((s, p) => s + Math.max(0, Number(p.revenue_mad || 0)), 0));
  const orders365 = Math.max(0, Math.round(simulatedDaily.reduce((s, p) => s + Math.max(0, Number(p.orders || 0)), 0)));

  const constraints = {
    capped_days: cappedDays,
    capped_ratio: safeBaseline.length > 0 ? cappedDays / safeBaseline.length : 0,
    capacity_limit_orders_per_day: capacityLimitOrdersPerDay,
    warning: safeBaseline.length > 0 ? (cappedDays / safeBaseline.length) > 0.05 : false
  };

  return {
    simulatedDaily,
    totals: {
      baseline_revenue_365: baselineRevenue365,
      baseline_orders_365: baselineOrders365,
      revenue_365: revenue365,
      orders_365: orders365
    },
    deltas: {
      revenue_delta: round2(revenue365 - baselineRevenue365),
      orders_delta: Math.round(orders365 - baselineOrders365),
      revenue_delta_pct: round2(pctDelta(revenue365, baselineRevenue365)),
      orders_delta_pct: round2(pctDelta(orders365, baselineOrders365))
    },
    constraints,
    explanation: {
      trafficFactor: round2(trafficFactor),
      conversionFactor: round2(conversionFactor),
      aovFactor: round2(aovFactor),
      showroomRampApplied: Boolean(config.showroomEnabled),
      showroomStartMonth: config.showroomStartMonth ? String(config.showroomStartMonth).slice(0, 7) : null,
      showroomMaxUpliftPct: round2(showroomMaxUpliftPct),
      capacityLimitOrdersPerDay
    }
  };
}
