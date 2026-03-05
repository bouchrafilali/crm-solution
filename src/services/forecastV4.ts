import type { BaselineDailyPoint } from "./forecastSimulation.js";

export type ForecastV4Options = {
  rdv_no_show_rate?: number;
  rdv_to_order_rate?: number;
  avg_days_rdv_to_order?: number;
  production_capacity_weekly?: number;
  avg_deposit_ratio?: number;
  rdv_session_conversion_rate?: number;
  whatsapp_share?: number;
  rdv_data_available?: boolean;
};

export type ForecastV4DailyPoint = {
  date: string;
  baseline_orders: number;
  baseline_revenue_mad: number;
  rdv_daily: number;
  rdv_confirmed_daily: number;
  rdv_no_show_rate: number;
  rdv_to_order_rate: number;
  avg_days_rdv_to_order: number;
  production_capacity_weekly: number;
  avg_deposit_ratio: number;
  sessions_rolling_7: number;
  whatsapp_rdv_requests: number;
  orders_forecast: number;
  revenue_forecast_mad: number;
  backlog_orders: number;
  deposit_forecast_mad: number;
  remaining_balance_forecast_mad: number;
};

export type ForecastV4Result = {
  generatedAt: string;
  horizonDays: number;
  dataAvailability: {
    rdvDataAvailable: boolean;
  };
  dataModel: {
    rdv_no_show_rate: number;
    rdv_to_order_rate: number;
    avg_days_rdv_to_order: number;
    production_capacity_weekly: number;
    avg_deposit_ratio: number;
  };
  points: ForecastV4DailyPoint[];
  layers: {
    demand: {
      demandMomentumIndex: number;
      sessionsRolling7: number;
      whatsappRdvRequests: number;
    };
    showroomConversion: {
      rdvConfirmed: number;
      rdvNoShowRate: number;
      rdvToOrderRate: number;
      avgDaysRdvToOrder: number;
    };
    production: {
      forecastOrders30Days: number;
      forecastOrders90Days: number;
      weeklyCapacity: number;
      productionPressureScore: number;
      backlogEstimation: number;
    };
    cash: {
      depositForecast: number;
      remainingBalanceForecast: number;
      cashProjection30Days: number;
      cashProjection90Days: number;
      cashStabilityScore: number;
    };
  };
};

const DEFAULTS = {
  rdv_no_show_rate: 0.12,
  rdv_to_order_rate: 0.56,
  avg_days_rdv_to_order: 12,
  avg_deposit_ratio: 0.42,
  rdv_session_conversion_rate: 0.017,
  whatsapp_share: 0.63
} as const;

function round2(value: number): number {
  return Number(Number(value || 0).toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toWeekKey(dateIso: string): string {
  const d = new Date(String(dateIso || "") + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "invalid";
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const ratio = rank - low;
  return sorted[low] * (1 - ratio) + sorted[high] * ratio;
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((sum, row) => sum + Number(pick(row) || 0), 0);
}

export function runForecastV4FromBaseline(
  baselineDaily: BaselineDailyPoint[],
  options: ForecastV4Options = {}
): ForecastV4Result {
  const baseline = (Array.isArray(baselineDaily) ? baselineDaily : []).map((row) => ({
    date: String(row.date || ""),
    orders: Math.max(0, Number(row.orders || 0)),
    revenue_mad: Math.max(0, Number(row.revenue_mad || 0))
  }));

  const rdv_no_show_rate = clamp(Number(options.rdv_no_show_rate ?? DEFAULTS.rdv_no_show_rate), 0.01, 0.8);
  const rdv_to_order_rate = clamp(Number(options.rdv_to_order_rate ?? DEFAULTS.rdv_to_order_rate), 0.05, 0.95);
  const avg_days_rdv_to_order = Math.max(1, Math.round(Number(options.avg_days_rdv_to_order ?? DEFAULTS.avg_days_rdv_to_order)));
  const avg_deposit_ratio = clamp(Number(options.avg_deposit_ratio ?? DEFAULTS.avg_deposit_ratio), 0.05, 0.95);
  const rdv_session_conversion_rate = clamp(
    Number(options.rdv_session_conversion_rate ?? DEFAULTS.rdv_session_conversion_rate),
    0.001,
    0.2
  );
  const whatsapp_share = clamp(Number(options.whatsapp_share ?? DEFAULTS.whatsapp_share), 0.1, 0.95);
  const rdvDataAvailable = Boolean(options.rdv_data_available);

  const weeklyOrders = new Map<string, number>();
  baseline.forEach((row) => {
    const key = toWeekKey(row.date);
    weeklyOrders.set(key, Number(weeklyOrders.get(key) || 0) + row.orders);
  });

  const weeklyBaselineValues = Array.from(weeklyOrders.values());
  const derivedCapacityWeekly = Math.max(1, Math.round(percentile(weeklyBaselineValues, 0.85) * 1.05));
  const production_capacity_weekly = Number.isFinite(Number(options.production_capacity_weekly))
    ? Math.max(1, Math.round(Number(options.production_capacity_weekly)))
    : derivedCapacityWeekly;

  const weekScale = new Map<string, number>();
  weeklyOrders.forEach((orders, key) => {
    const scale = orders > production_capacity_weekly ? production_capacity_weekly / orders : 1;
    weekScale.set(key, scale);
  });

  const points: ForecastV4DailyPoint[] = baseline.map((row, index) => {
    const weekKey = toWeekKey(row.date);
    const capScale = Number(weekScale.get(weekKey) || 1);
    const orders_forecast = Math.max(0, row.orders * capScale);
    const aov = row.orders > 0 ? row.revenue_mad / row.orders : 0;
    const revenue_forecast_mad = Math.max(0, orders_forecast * aov);
    const rdv_confirmed_daily = orders_forecast / Math.max(rdv_to_order_rate, 0.0001);
    const rdv_daily = rdv_confirmed_daily / Math.max(1 - rdv_no_show_rate, 0.0001);
    const sessions7Rows = baseline.slice(Math.max(0, index - 6), index + 1);
    const sessions_rolling_7 =
      sumBy(sessions7Rows, (r) => (r.orders / Math.max(rdv_to_order_rate, 0.0001)) / rdv_session_conversion_rate);
    const backlog_orders = Math.max(0, row.orders - orders_forecast);
    const deposit_forecast_mad = revenue_forecast_mad * avg_deposit_ratio;
    return {
      date: row.date,
      baseline_orders: Math.round(row.orders),
      baseline_revenue_mad: round2(row.revenue_mad),
      rdv_daily: round2(rdv_daily),
      rdv_confirmed_daily: round2(rdv_confirmed_daily),
      rdv_no_show_rate: round2(rdv_no_show_rate),
      rdv_to_order_rate: round2(rdv_to_order_rate),
      avg_days_rdv_to_order,
      production_capacity_weekly,
      avg_deposit_ratio: round2(avg_deposit_ratio),
      sessions_rolling_7: Math.round(sessions_rolling_7),
      whatsapp_rdv_requests: round2(rdv_daily * whatsapp_share),
      orders_forecast: round2(orders_forecast),
      revenue_forecast_mad: round2(revenue_forecast_mad),
      backlog_orders: round2(backlog_orders),
      deposit_forecast_mad: round2(deposit_forecast_mad),
      remaining_balance_forecast_mad: round2(revenue_forecast_mad - deposit_forecast_mad)
    };
  });

  const points30 = points.slice(0, 30);
  const points90 = points.slice(0, 90);
  const firstWindow = points.slice(0, Math.min(30, points.length));
  const secondWindow = points.slice(Math.min(30, points.length), Math.min(60, points.length));
  const demandMomentumBase = sumBy(firstWindow, (p) => p.orders_forecast);
  const demandMomentumCurrent = sumBy(secondWindow, (p) => p.orders_forecast);
  const demandMomentumIndex = demandMomentumBase > 0
    ? ((demandMomentumCurrent - demandMomentumBase) / demandMomentumBase) * 100
    : 0;

  const totalRdvConfirmed = sumBy(points30, (p) => p.rdv_confirmed_daily);
  const totalOrders30 = sumBy(points30, (p) => p.orders_forecast);
  const totalRevenue30 = sumBy(points30, (p) => p.revenue_forecast_mad);
  const totalRevenue90 = sumBy(points90, (p) => p.revenue_forecast_mad);
  const totalBacklog30 = sumBy(points30, (p) => p.backlog_orders);
  const totalDeposit30 = sumBy(points30, (p) => p.deposit_forecast_mad);
  const totalRemaining30 = sumBy(points30, (p) => p.remaining_balance_forecast_mad);
  const weeklyProjected = Array.from(
    points.reduce((acc, p) => {
      const key = toWeekKey(p.date);
      acc.set(key, Number(acc.get(key) || 0) + Number(p.orders_forecast || 0));
      return acc;
    }, new Map<string, number>()).values()
  );
  const avgWeeklyProjected = weeklyProjected.length ? sumBy(weeklyProjected, (v) => v) / weeklyProjected.length : 0;
  const productionPressureScore = clamp((avgWeeklyProjected / Math.max(1, production_capacity_weekly)) * 100, 0, 200);
  const avgDailyCash30 = points30.length ? totalRevenue30 / points30.length : 0;
  const avgDailyCash90 = points90.length ? totalRevenue90 / points90.length : 0;
  const cashStabilityScore = clamp(
    100 - Math.abs(avgDailyCash30 - avgDailyCash90) / Math.max(1, avgDailyCash90) * 100,
    0,
    100
  );

  return {
    generatedAt: new Date().toISOString(),
    horizonDays: points.length,
    dataAvailability: {
      rdvDataAvailable
    },
    dataModel: {
      rdv_no_show_rate: round2(rdv_no_show_rate),
      rdv_to_order_rate: round2(rdv_to_order_rate),
      avg_days_rdv_to_order,
      production_capacity_weekly,
      avg_deposit_ratio: round2(avg_deposit_ratio)
    },
    points,
    layers: {
      demand: {
        demandMomentumIndex: round2(demandMomentumIndex),
        sessionsRolling7: Math.max(0, Math.round(points[points.length - 1]?.sessions_rolling_7 || 0)),
        whatsappRdvRequests: round2(sumBy(points.slice(Math.max(0, points.length - 7)), (p) => p.whatsapp_rdv_requests))
      },
      showroomConversion: {
        rdvConfirmed: round2(totalRdvConfirmed),
        rdvNoShowRate: round2(rdv_no_show_rate * 100),
        rdvToOrderRate: round2(rdv_to_order_rate * 100),
        avgDaysRdvToOrder: avg_days_rdv_to_order
      },
      production: {
        forecastOrders30Days: Math.round(totalOrders30),
        forecastOrders90Days: Math.round(sumBy(points90, (p) => p.orders_forecast)),
        weeklyCapacity: production_capacity_weekly,
        productionPressureScore: round2(productionPressureScore),
        backlogEstimation: round2(totalBacklog30)
      },
      cash: {
        depositForecast: round2(totalDeposit30),
        remainingBalanceForecast: round2(totalRemaining30),
        cashProjection30Days: round2(totalRevenue30),
        cashProjection90Days: round2(totalRevenue90),
        cashStabilityScore: round2(cashStabilityScore)
      }
    }
  };
}
