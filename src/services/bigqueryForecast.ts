import { BigQuery } from "@google-cloud/bigquery";
import { env } from "../config/env.js";
import { listOrdersForAnalytics } from "../db/ordersRepo.js";
import { computeExternalSignals, type ExternalSignalsSummary } from "./externalSignals.js";
import { getInlineGcpCredentials } from "./gcpCredentials.js";
import { listOrdersForQueue, type OrderSnapshot } from "./orderSnapshots.js";

export type RevenueForecastPoint = {
  date: string;
  value: number;
  lower: number;
  upper: number;
};

export type RevenueForecastResult = {
  horizon: number;
  points: RevenueForecastPoint[];
  next7RevenueMad: number;
  next30RevenueMad: number;
  next365RevenueMad: number;
  next7Orders: number;
  next30Orders: number;
  nextHorizonOrders: number;
  scenarios: {
    horizonDays: number;
    pessimisticMad: number;
    realisticMad: number;
    optimisticMad: number;
    pessimisticOrders: number;
    realisticOrders: number;
    optimisticOrders: number;
  };
  ordersComparison: {
    horizonDays: number;
    forecastOrders: number;
    previousPeriodOrders: number;
    deltaPct: number;
  };
  horizonSummaries: Array<{
    horizonDays: number;
    revenueMad: number;
    orders: number;
    previousPeriodOrders: number;
    deltaPct: number;
    pessimisticMad: number;
    realisticMad: number;
    optimisticMad: number;
  }>;
  monthlyOrdersForecast: Array<{
    month: string;
    orders: number;
    revenueMad: number;
  }>;
  modelName: string;
  mode: "raw" | "robust";
  dataUsage: {
    source: "db" | "queue_fallback";
    historyFrom: string;
    historyTo: string;
    historyPoints: number;
    historyOrders: number;
    modelType: "ARIMA_PLUS";
    trainingTable: string;
    currencyNormalization: string;
      features: string[];
      ordersForecastMethod: string;
      calibration: string;
      referenceAovMad: number;
      externalSignals: ExternalSignalsSummary;
      rareMonthAdjustment: string;
  };
};

const MAD_RATES: Record<string, number> = {
  MAD: 1,
  EUR: 10.9,
  USD: 10,
  GBP: 12.7,
  CAD: 7.4
};

function toMad(amount: number, currency: string): number {
  const code = String(currency || "MAD").toUpperCase();
  return Math.max(0, Number(amount || 0)) * (MAD_RATES[code] ?? 1);
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

function shiftIsoYear(isoDay: string, deltaYears: number): string {
  const d = new Date(isoDay + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCFullYear(d.getUTCFullYear() + deltaYears);
  return d.toISOString().slice(0, 10);
}

function weekdayFromIso(isoDay: string): number {
  const d = new Date(isoDay + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return -1;
  return d.getUTCDay();
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function avg(values: number[]): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function percentageDelta(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function applyRareMonthAdjustment(
  series: Array<{ date: string; revenueMad: number; ordersCount: number; aovMad: number }>,
  capMad: number,
  maxRepeat: number
): {
  adjustedSeries: Array<{ date: string; revenueMad: number; ordersCount: number; aovMad: number }>;
  adjustedMonths: string[];
  detectedMonths: string[];
  monthsOverCap: number;
} {
  const isExcludedMonth = (monthIso: string) => {
    const monthNumber = Number(String(monthIso || "").slice(5, 7));
    return Number.isFinite(monthNumber) && monthNumber >= 3 && monthNumber <= 8;
  };
  const monthTotals = new Map<string, number>();
  series.forEach((row) => {
    const month = String(row.date || "").slice(0, 7);
    if (!month) return;
    monthTotals.set(month, (monthTotals.get(month) || 0) + Number(row.revenueMad || 0));
  });
  const monthsOverCap = Array.from(monthTotals.entries()).filter(([month, total]) => total > capMad && !isExcludedMonth(month));
  const detectedMonths = monthsOverCap.map(([month]) => month).sort((a, b) => a.localeCompare(b));
  const monthsOverCapCount = monthsOverCap.length;
  // Always adjust detected rare months above cap (except Mar->Aug) so exceptional spikes do not bias next-year forecast.
  const shouldAdjust = monthsOverCapCount > 0;
  if (!shouldAdjust) {
    return { adjustedSeries: series, adjustedMonths: [], detectedMonths, monthsOverCap: monthsOverCapCount };
  }

  const scaleByMonth = new Map<string, number>();
  monthsOverCap.forEach(([month, total]) => {
    const scale = clamp(capMad / Math.max(1, total), 0.35, 1);
    scaleByMonth.set(month, scale);
  });

  const adjustedSeries = series.map((row) => {
    const month = String(row.date || "").slice(0, 7);
    const scale = scaleByMonth.get(month) || 1;
    const revenueMad = round2(Math.max(0, Number(row.revenueMad || 0) * scale));
    return {
      ...row,
      revenueMad,
      aovMad: 0
    };
  });
  return {
    adjustedSeries,
    adjustedMonths: Array.from(scaleByMonth.keys()).sort((a, b) => a.localeCompare(b)),
    detectedMonths,
    monthsOverCap: monthsOverCapCount
  };
}

function snapshotToAnalytics(order: OrderSnapshot): {
  createdAt: string;
  totalAmount: number;
  currency: string;
} {
  return {
    createdAt: order.createdAt,
    totalAmount: Number(order.totalAmount || 0),
    currency: String(order.currency || "MAD").toUpperCase()
  };
}

function buildLocalForecastPoints(
  modelSeries: Array<{ date: string; revenueMad: number; ordersCount: number; aovMad: number }>,
  horizon: number
): RevenueForecastPoint[] {
  const historyByDay = new Map<string, number>(modelSeries.map((row) => [row.date, Number(row.revenueMad || 0)]));
  const recentSlice = modelSeries.slice(-56);
  const recent28Slice = modelSeries.slice(-28);
  const prevRecentSlice = modelSeries.slice(-112, -56);
  const prev28Slice = modelSeries.slice(-56, -28);
  const recentSum = recentSlice.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const prevRecentSum = prevRecentSlice.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const trendFactor = prevRecentSum > 0 ? clamp(recentSum / prevRecentSum, 0.85, 1.2) : 1;
  const recentDailyAvg = avg(recentSlice.map((row) => Number(row.revenueMad || 0)));
  const recent28Avg = avg(recent28Slice.map((row) => Number(row.revenueMad || 0)));
  const prev28Avg = avg(prev28Slice.map((row) => Number(row.revenueMad || 0)));
  const shortTrendFactor = prev28Avg > 0 ? clamp(recent28Avg / prev28Avg, 0.92, 1.08) : 1;
  const recentByWeekday = new Map<number, number[]>();
  const monthRevenueByMonthNumber = new Map<number, number[]>();
  recentSlice.forEach((row) => {
    const wd = weekdayFromIso(row.date);
    if (wd < 0) return;
    const bucket = recentByWeekday.get(wd) || [];
    bucket.push(Number(row.revenueMad || 0));
    recentByWeekday.set(wd, bucket);
  });
  modelSeries.forEach((row) => {
    const monthNumber = Number(String(row.date || "").slice(5, 7));
    if (!Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) return;
    const bucket = monthRevenueByMonthNumber.get(monthNumber) || [];
    bucket.push(Number(row.revenueMad || 0));
    monthRevenueByMonthNumber.set(monthNumber, bucket);
  });

  const monthSeasonality = new Map<number, number>();
  for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
    const monthValues = monthRevenueByMonthNumber.get(monthNumber) || [];
    const monthAvg = avg(monthValues);
    const factor = recentDailyAvg > 0 && monthAvg > 0 ? clamp(monthAvg / recentDailyAvg, 0.8, 1.2) : 1;
    monthSeasonality.set(monthNumber, factor);
  }

  const recentStdDev = Math.sqrt(
    avg(recentSlice.map((row) => {
      const delta = Number(row.revenueMad || 0) - recentDailyAvg;
      return delta * delta;
    }))
  );
  const variabilityFactor = recentDailyAvg > 0 ? clamp(recentStdDev / recentDailyAvg, 0.06, 0.18) : 0.12;

  const lastHistoryDate = modelSeries[modelSeries.length - 1]?.date || toIsoDay(new Date());
  const lastDate = new Date(lastHistoryDate + "T00:00:00Z");
  const points: RevenueForecastPoint[] = [];

  for (let index = 1; index <= horizon; index += 1) {
    const cursor = new Date(lastDate.getTime() + index * 86400000);
    const iso = toIsoDay(cursor);
    const weekday = weekdayFromIso(iso);
    const weekdaySeries = recentByWeekday.get(weekday) || [];
    const weekdayAvg =
      weekdaySeries.length > 0
        ? weekdaySeries.reduce((sum, value) => sum + value, 0) / weekdaySeries.length
        : recentDailyAvg;
    const lastYearRevenue = Number(historyByDay.get(shiftIsoYear(iso, -1)) || 0);
    const monthNumber = cursor.getUTCMonth() + 1;
    const driftFactor = Math.pow(shortTrendFactor, index / 28);
    const baseLevel = Math.max(0, recentDailyAvg * driftFactor * (monthSeasonality.get(monthNumber) || 1));
    const weekdayFactor = recentDailyAvg > 0 ? clamp(weekdayAvg / recentDailyAvg, 0.82, 1.18) : 1;
    const weekdayComponent = baseLevel * weekdayFactor;
    const yearlyComponent = lastYearRevenue > 0 ? lastYearRevenue * trendFactor : baseLevel;
    const blended =
      baseLevel * 0.5 +
      weekdayComponent * 0.3 +
      yearlyComponent * 0.2;
    const value = round2(Math.max(0, blended));
    const spread = Math.max(value * (0.18 + variabilityFactor), recentDailyAvg * 0.08);
    points.push({
      date: iso,
      value,
      lower: round2(Math.max(0, value - spread)),
      upper: round2(Math.max(value, value + spread))
    });
  }

  return points;
}

export function isBigQueryForecastConfigured(): boolean {
  return Boolean(env.GCP_PROJECT_ID && env.BIGQUERY_DATASET && env.BIGQUERY_LOCATION);
}

async function loadDailySalesRows(historyDays: number): Promise<{
  series: Array<{ date: string; revenueMad: number; ordersCount: number; aovMad: number }>;
  source: "db" | "queue_fallback";
}> {
  return loadDailySalesRowsAsOf(historyDays, new Date());
}

async function loadDailySalesRowsAsOf(
  historyDays: number,
  asOfDate: Date
): Promise<{
  series: Array<{ date: string; revenueMad: number; ordersCount: number; aovMad: number }>;
  source: "db" | "queue_fallback";
}> {
  const safeAsOf = Number.isNaN(asOfDate.getTime()) ? new Date() : asOfDate;
  const toExclusive = new Date(Date.UTC(
    safeAsOf.getUTCFullYear(),
    safeAsOf.getUTCMonth(),
    safeAsOf.getUTCDate() + 1,
    0,
    0,
    0,
    0
  ));
  const from = new Date(toExclusive.getTime() - historyDays * 24 * 60 * 60 * 1000);

  let rows = await listOrdersForAnalytics(from.toISOString(), toExclusive.toISOString());
  let source: "db" | "queue_fallback" = "db";
  if (rows.length === 0) {
    source = "queue_fallback";
    rows = listOrdersForQueue().map((order) => ({
      id: order.id,
      createdAt: snapshotToAnalytics(order).createdAt,
      customerId: null,
      customerEmail: order.customerEmail || null,
      customerPhone: order.customerPhone || null,
      customerLabel: order.customerLabel || null,
      currency: snapshotToAnalytics(order).currency,
      totalAmount: snapshotToAnalytics(order).totalAmount,
      outstandingAmount: Number(order.outstandingAmount || 0),
      paymentGateway: order.paymentGateway || null
    }));
  }

  const byDay = new Map<string, { revenueMad: number; ordersCount: number }>();
  rows.forEach((row) => {
    const day = toIsoDay(row.createdAt);
    if (!day) return;
    const current = byDay.get(day) || { revenueMad: 0, ordersCount: 0 };
    current.revenueMad += toMad(Number(row.totalAmount || 0), String(row.currency || "MAD"));
    current.ordersCount += 1;
    byDay.set(day, current);
  });

  const startIso = toIsoDay(from);
  const endIso = toIsoDay(new Date(toExclusive.getTime() - 1));
  const startDate = new Date(startIso + "T00:00:00Z");
  const endDate = new Date(endIso + "T00:00:00Z");
  const result: Array<{ date: string; revenueMad: number; ordersCount: number; aovMad: number }> = [];
  for (
    let cursor = new Date(startDate.getTime());
    cursor.getTime() <= endDate.getTime();
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    const agg = byDay.get(date) || { revenueMad: 0, ordersCount: 0 };
    const revenueMad = Number(agg.revenueMad.toFixed(2));
    const ordersCount = Math.max(0, Math.round(Number(agg.ordersCount || 0)));
    result.push({
      date,
      revenueMad,
      ordersCount,
      aovMad: ordersCount > 0 ? Number((revenueMad / ordersCount).toFixed(2)) : 0
    });
  }

  return { series: result, source };
}

async function runRevenueForecastInternal(
  horizon = 30,
  mode: "raw" | "robust" = "robust",
  forceLocal = false,
  asOfDate?: Date
): Promise<RevenueForecastResult> {
  if (!forceLocal && !isBigQueryForecastConfigured()) {
    throw new Error("BigQuery non configuré (GCP_PROJECT_ID, BIGQUERY_DATASET, BIGQUERY_LOCATION).");
  }

  const projectId = env.GCP_PROJECT_ID as string;
  const datasetId = env.BIGQUERY_DATASET as string;
  const location = env.BIGQUERY_LOCATION as string;
  let modelName = env.BIGQUERY_REVENUE_MODEL_NAME || "revenue_forecast_model";
  const tableName = env.BIGQUERY_SALES_TABLE_NAME || "sales_daily";

  const referenceDate = asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate : new Date();
  const { series, source } = await loadDailySalesRowsAsOf(730, referenceDate);
  if (series.length < 14) {
    throw new Error("Pas assez d'historique pour entraîner un forecast (minimum 14 jours).");
  }
  const rareMonthCapMad = Number(env.FORECAST_RARE_MONTH_CAP_MAD || 1400000);
  const rareMonthMaxRepeat = Math.max(1, Math.floor(Number(env.FORECAST_RARE_MONTH_MAX_REPEAT || 2)));
  const rareMonth = applyRareMonthAdjustment(series, rareMonthCapMad, rareMonthMaxRepeat);
  const modelSeries = rareMonth.adjustedSeries;

  const safeHorizon = Math.max(7, Math.min(365, Math.floor(horizon)));
  let rawPoints: RevenueForecastPoint[];
  if (forceLocal) {
    modelName = "local_orders_baseline";
    rawPoints = buildLocalForecastPoints(modelSeries, safeHorizon);
  } else try {
    const inlineCredentials = getInlineGcpCredentials();
    const bigquery = new BigQuery({
      projectId,
      credentials: inlineCredentials
    });
    const dataset = bigquery.dataset(datasetId);
    await dataset.get({ autoCreate: true });

    async function runJob(query: string, params?: Record<string, unknown>) {
      const [job] = await bigquery.createQueryJob({
        query,
        params,
        location
      });
      const [rows] = await job.getQueryResults();
      return rows as unknown[];
    }

    const createTableSql = `
      create table if not exists \`${projectId}.${datasetId}.${tableName}\` (
        date date,
        revenue_mad float64,
        orders_count int64,
        aov_mad float64
      )
    `;
    await runJob(createTableSql);
    await runJob(`truncate table \`${projectId}.${datasetId}.${tableName}\``);

    await dataset.table(tableName).insert(
      modelSeries.map((row) => ({
        date: row.date,
        revenue_mad: row.revenueMad,
        orders_count: row.ordersCount,
        aov_mad: row.aovMad
      }))
    );

    const trainSql = `
      create or replace model \`${projectId}.${datasetId}.${modelName}\`
      options(
        model_type='ARIMA_PLUS',
        time_series_timestamp_col='date',
        time_series_data_col='revenue_mad',
        holiday_region='MA'
      ) as
      select date, revenue_mad
      from \`${projectId}.${datasetId}.${tableName}\`
      order by 1
    `;
    await runJob(trainSql);

    const forecastSql = `
      select
        cast(forecast_timestamp as string) as date_text,
        forecast_value,
        prediction_interval_lower_bound,
        prediction_interval_upper_bound
      from ML.FORECAST(
        model \`${projectId}.${datasetId}.${modelName}\`,
        struct(${safeHorizon} as horizon, 0.8 as confidence_level)
      )
      order by 1
    `;
    const rowsRaw = (await runJob(forecastSql)) as Array<{
      date_text: string;
      forecast_value: number;
      prediction_interval_lower_bound: number;
      prediction_interval_upper_bound: number;
    }>;

    rawPoints = rowsRaw.map((row) => {
      const value = Math.max(0, Number(row.forecast_value || 0));
      const lower = Math.max(0, Number(row.prediction_interval_lower_bound || 0));
      const upper = Math.max(value, Math.max(0, Number(row.prediction_interval_upper_bound || 0)));
      return {
        date: toIsoDay(row.date_text),
        value,
        lower,
        upper
      };
    });
  } catch (error) {
    console.warn("[forecast] BigQuery unavailable, falling back to local forecast", error);
    modelName = "local_orders_baseline";
    rawPoints = buildLocalForecastPoints(modelSeries, safeHorizon);
  }

  const historyByDay = new Map<string, number>(modelSeries.map((row) => [row.date, Number(row.revenueMad || 0)]));
  const recentSlice = modelSeries.slice(-56);
  const prevRecentSlice = modelSeries.slice(-112, -56);
  const recentSum = recentSlice.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const prevRecentSum = prevRecentSlice.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const trendFactor =
    prevRecentSum > 0 ? Math.max(0.75, Math.min(1.35, recentSum / prevRecentSum)) : 1;
  const recentOrdersSum = recentSlice.reduce((sum, row) => sum + Number(row.ordersCount || 0), 0);
  const prevRecentOrdersSum = prevRecentSlice.reduce((sum, row) => sum + Number(row.ordersCount || 0), 0);
  const ordersTrendFactor =
    prevRecentOrdersSum > 0 ? clamp(recentOrdersSum / prevRecentOrdersSum, 0.8, 1.25) : 1;
  const combinedTrendFactor = clamp(trendFactor * 0.75 + ordersTrendFactor * 0.25, 0.75, 1.35);

  const recentByWeekday = new Map<number, number[]>();
  const recentOrdersByWeekday = new Map<number, number[]>();
  recentSlice.forEach((row) => {
    const wd = weekdayFromIso(row.date);
    if (wd < 0) return;
    const bucket = recentByWeekday.get(wd) || [];
    bucket.push(Number(row.revenueMad || 0));
    recentByWeekday.set(wd, bucket);
    const ordersBucket = recentOrdersByWeekday.get(wd) || [];
    ordersBucket.push(Number(row.ordersCount || 0));
    recentOrdersByWeekday.set(wd, ordersBucket);
  });

  const points: RevenueForecastPoint[] = rawPoints.map((point) => {
    if (mode !== "robust") return point;
    const lyDate = shiftIsoYear(point.date, -1);
    const lyRevenue = Number(historyByDay.get(lyDate) || 0);
    const wd = weekdayFromIso(point.date);
    const weekdaySeries = recentByWeekday.get(wd) || [];
    const weekdayAvg =
      weekdaySeries.length > 0
        ? weekdaySeries.reduce((sum, value) => sum + value, 0) / weekdaySeries.length
        : 0;
    const weekdayOrdersSeries = recentOrdersByWeekday.get(wd) || [];
    const weekdayOrdersAvg =
      weekdayOrdersSeries.length > 0
        ? weekdayOrdersSeries.reduce((sum, value) => sum + value, 0) / weekdayOrdersSeries.length
        : 0;
    const ordersSeasonalityBoost = clamp(weekdayOrdersAvg > 0 ? 1 + (weekdayOrdersAvg - 1) * 0.015 : 1, 0.9, 1.2);
    const baseline =
      lyRevenue > 0 ? lyRevenue * combinedTrendFactor * ordersSeasonalityBoost : weekdayAvg * ordersSeasonalityBoost;

    const arima = Number(point.value || 0);
    let robust = arima;
    if (baseline > 0) {
      robust = 0.6 * arima + 0.4 * baseline;
      if (arima < baseline * 0.35) robust = baseline * 0.75;
    }
    robust = Math.max(0, robust);

    const spreadDown = Math.max(0, arima - Number(point.lower || 0));
    const spreadUp = Math.max(0, Number(point.upper || 0) - arima);
    const lower = Math.max(0, robust - spreadDown);
    const upper = Math.max(robust, robust + spreadUp);
    return {
      date: point.date,
      value: round2(robust),
      lower: round2(lower),
      upper: round2(upper)
    };
  });

  // Calibrate all horizons versus equivalent trailing period to keep projections realistic.
  const trailingWindow = modelSeries.slice(-safeHorizon);
  const previousWindow = modelSeries.slice(-(safeHorizon * 2), -safeHorizon);
  const trailingRevenue = trailingWindow.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const previousRevenue = previousWindow.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const trendWindow = previousRevenue > 0 ? trailingRevenue / previousRevenue : 1;
  const boundedTrendWindow = clamp(trendWindow, 0.85, 1.2);
  const trailingOrdersWindow = trailingWindow.reduce((sum, row) => sum + Number(row.ordersCount || 0), 0);
  const previousOrdersWindow = previousWindow.reduce((sum, row) => sum + Number(row.ordersCount || 0), 0);
  const ordersTrendWindow = previousOrdersWindow > 0 ? clamp(trailingOrdersWindow / previousOrdersWindow, 0.85, 1.2) : 1;
  const blendedTrendWindow = clamp(boundedTrendWindow * 0.8 + ordersTrendWindow * 0.2, 0.85, 1.2);
  const targetRevenue = trailingRevenue > 0 ? trailingRevenue * blendedTrendWindow : 0;
  const currentHorizonRevenue = points.slice(0, safeHorizon).reduce((sum, point) => sum + Number(point.value || 0), 0);
  if (mode === "robust" && targetRevenue > 0 && currentHorizonRevenue > 0) {
    const boundedTarget = clamp(targetRevenue, trailingRevenue * 0.8, trailingRevenue * 1.25);
    const rawScale = boundedTarget / currentHorizonRevenue;
    const scale = clamp(rawScale, 0.2, 1.5);
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const value = round2(Math.max(0, Number(p.value || 0) * scale));
      const lower = round2(Math.max(0, Number(p.lower || 0) * scale));
      const upper = round2(Math.max(value, Number(p.upper || 0) * scale));
      points[i] = { date: p.date, value, lower, upper };
    }
  }

  const trailing365 = modelSeries.slice(-365);
  const trailing365From = trailing365[0]?.date || modelSeries[0]?.date || "";
  const trailing365To = trailing365[trailing365.length - 1]?.date || modelSeries[modelSeries.length - 1]?.date || "";
  const externalSignals = await computeExternalSignals(trailing365From, trailing365To);
  const signalScale = mode === "robust" ? clamp(externalSignals.appliedFactor, 0.9, 1.1) : 1;
  if (signalScale !== 1) {
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const value = round2(Math.max(0, Number(p.value || 0) * signalScale));
      const lower = round2(Math.max(0, Number(p.lower || 0) * signalScale));
      const upper = round2(Math.max(value, Number(p.upper || 0) * signalScale));
      points[i] = { date: p.date, value, lower, upper };
    }
  }

  const next7RevenueMad = points.slice(0, 7).reduce((sum, point) => sum + point.value, 0);
  const next30RevenueMad = points.slice(0, 30).reduce((sum, point) => sum + point.value, 0);
  const next365RevenueMad = points.slice(0, 365).reduce((sum, point) => sum + point.value, 0);
  const horizonSlice = points.slice(0, safeHorizon);
  const realisticMad = horizonSlice.reduce((sum, point) => sum + Number(point.value || 0), 0);
  const rawPessimisticMad = horizonSlice.reduce((sum, point) => sum + Number(point.lower || 0), 0);
  const rawOptimisticMad = horizonSlice.reduce((sum, point) => sum + Number(point.upper || 0), 0);
  const pessimisticMad = clamp(rawPessimisticMad, realisticMad * 0.7, realisticMad * 0.98);
  const optimisticMad = clamp(rawOptimisticMad, realisticMad * 1.02, realisticMad * 1.45);

  const trailing365Revenue = trailing365.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const referenceOrderValueFromEnv = Number(env.FORECAST_REFERENCE_ORDER_VALUE_MAD || 0);
  const safeAov = Number.isFinite(referenceOrderValueFromEnv) && referenceOrderValueFromEnv > 0 ? referenceOrderValueFromEnv : 35000;
  const next7Orders = Math.max(0, Math.round(next7RevenueMad / safeAov));
  const next30Orders = Math.max(0, Math.round(next30RevenueMad / safeAov));
  const nextHorizonOrders = Math.max(0, Math.round(realisticMad / safeAov));

  const pessimisticOrders = Math.max(
    0,
    Math.round(nextHorizonOrders * (realisticMad > 0 ? pessimisticMad / realisticMad : 1))
  );
  const optimisticOrders = Math.max(
    0,
    Math.round(nextHorizonOrders * (realisticMad > 0 ? optimisticMad / realisticMad : 1))
  );
  const previousPeriodRevenue = previousWindow.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
  const previousPeriodOrders = Math.max(0, Math.round(previousPeriodRevenue / safeAov));
  const orderDeltaPct = percentageDelta(nextHorizonOrders, previousPeriodOrders);
  const historyFrom = modelSeries[0]?.date || "";
  const historyTo = modelSeries[modelSeries.length - 1]?.date || "";
  const historyOrders = modelSeries.reduce((sum, row) => sum + Number(row.ordersCount || 0), 0);

  function buildHorizonSummary(days: number) {
    const horizonDays = Math.max(1, Math.min(days, points.length));
    const slice = points.slice(0, horizonDays);
    const realistic = slice.reduce((sum, p) => sum + Number(p.value || 0), 0);
    const rawPess = slice.reduce((sum, p) => sum + Number(p.lower || 0), 0);
    const rawOpti = slice.reduce((sum, p) => sum + Number(p.upper || 0), 0);
    const pessimistic = clamp(rawPess, realistic * 0.7, realistic * 0.98);
    const optimistic = clamp(rawOpti, realistic * 1.02, realistic * 1.45);

    const previous = modelSeries.slice(-(horizonDays * 2), -horizonDays);
    const previousRevenue = previous.reduce((sum, row) => sum + Number(row.revenueMad || 0), 0);
    const orders = Math.max(0, Math.round(realistic / safeAov));
    const previousPeriodOrders = Math.max(0, Math.round(previousRevenue / safeAov));
    return {
      horizonDays,
      revenueMad: round2(realistic),
      orders,
      previousPeriodOrders: Math.max(0, previousPeriodOrders),
      deltaPct: round2(percentageDelta(orders, previousPeriodOrders)),
      pessimisticMad: round2(pessimistic),
      realisticMad: round2(realistic),
      optimisticMad: round2(optimistic)
    };
  }

  const requestedSummary = buildHorizonSummary(safeHorizon);
  const defaultHorizons = [30, 90, 180, 365].filter((h) => h <= points.length);
  const horizons = Array.from(new Set([...defaultHorizons, safeHorizon])).sort((a, b) => a - b);
  const horizonSummaries = horizons.map((h) => buildHorizonSummary(h));

  const monthlyActualMap = new Map<string, { revenueMad: number; orders: number }>();
  modelSeries.forEach((row) => {
    const month = String(row.date || "").slice(0, 7);
    if (!month) return;
    const bucket = monthlyActualMap.get(month) || { revenueMad: 0, orders: 0 };
    bucket.revenueMad += Number(row.revenueMad || 0);
    bucket.orders += Math.max(0, Number(row.ordersCount || 0));
    monthlyActualMap.set(month, bucket);
  });

  const currentMonthIso = toIsoDay(referenceDate).slice(0, 7);
  const monthlyMap = new Map<string, { revenueMad: number; orders: number }>();
  points.forEach((p) => {
    const month = String(p.date || "").slice(0, 7);
    if (!month) return;
    const bucket = monthlyMap.get(month) || { revenueMad: 0, orders: 0 };
    const revenue = Number(p.value || 0);
    bucket.revenueMad += revenue;
    bucket.orders += Math.max(0, Math.round(revenue / safeAov));
    monthlyMap.set(month, bucket);
  });
  const monthlyOrdersForecast = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, agg]) => {
      const actualMonth = month === currentMonthIso ? monthlyActualMap.get(month) : null;
      const revenueMad = Number(agg.revenueMad || 0) + Number(actualMonth?.revenueMad || 0);
      const orders = Number(agg.orders || 0) + Number(actualMonth?.orders || 0);
      return {
        month,
        orders: Math.max(0, Math.round(orders)),
        revenueMad: round2(revenueMad)
      };
    });

  return {
    horizon: safeHorizon,
    points,
    next7RevenueMad: round2(next7RevenueMad),
    next30RevenueMad: round2(next30RevenueMad),
    next365RevenueMad: round2(next365RevenueMad),
    next7Orders: Math.max(0, next7Orders),
    next30Orders: Math.max(0, next30Orders),
    nextHorizonOrders: Math.max(0, requestedSummary.orders),
    scenarios: {
      horizonDays: safeHorizon,
      pessimisticMad: requestedSummary.pessimisticMad,
      realisticMad: requestedSummary.realisticMad,
      optimisticMad: requestedSummary.optimisticMad,
      pessimisticOrders,
      realisticOrders: Math.max(0, requestedSummary.orders),
      optimisticOrders
    },
    ordersComparison: {
      horizonDays: safeHorizon,
      forecastOrders: Math.max(0, requestedSummary.orders),
      previousPeriodOrders: Math.max(0, requestedSummary.previousPeriodOrders),
      deltaPct: requestedSummary.deltaPct
    },
    horizonSummaries,
    monthlyOrdersForecast,
    modelName,
    mode,
    dataUsage: {
      source,
      historyFrom,
      historyTo,
      historyPoints: modelSeries.length,
      historyOrders,
      modelType: "ARIMA_PLUS",
      trainingTable: modelName === "local_orders_baseline" ? "local_orders_history" : `${projectId}.${datasetId}.${tableName}`,
      currencyNormalization: "Montants convertis en MAD avec taux internes avant agrégation journalière.",
      features: ["date", "revenue_mad", "orders_count (historical signal)"],
      ordersForecastMethod:
        "Commandes prévues dérivées du CA prévu et calibrées par la cadence historique des commandes (orders_count) avec une valeur commande de référence (FORECAST_REFERENCE_ORDER_VALUE_MAD).",
      calibration:
        "Calibration robuste basée sur CA historique + trend/saisonnalité orders_count + facteur signaux externes (Search Console/Trends/GA4).",
      referenceAovMad: round2(safeAov),
      externalSignals,
      rareMonthAdjustment:
        rareMonth.adjustedMonths.length > 0
          ? "Mois rares > " +
            Math.round(rareMonthCapMad).toLocaleString("fr-FR") +
            " MAD (hors mois 03-08) ajustés: " +
            rareMonth.adjustedMonths.join(", ")
          : rareMonth.detectedMonths.length > 0
            ? "Mois rares > " +
              Math.round(rareMonthCapMad).toLocaleString("fr-FR") +
              " MAD (hors mois 03-08) détectés (sans ajustement): " +
              rareMonth.detectedMonths.join(", ")
          : "Aucun mois rare > " + Math.round(rareMonthCapMad).toLocaleString("fr-FR") + " MAD (hors mois 03-08)."
    }
  };
}

export async function runRevenueForecast(horizon = 30, mode: "raw" | "robust" = "robust"): Promise<RevenueForecastResult> {
  return runRevenueForecastInternal(horizon, mode, false);
}

export async function runLocalRevenueForecast(
  horizon = 30,
  mode: "raw" | "robust" = "robust"
): Promise<RevenueForecastResult> {
  return runRevenueForecastInternal(horizon, mode, true);
}

export async function runLocalRevenueForecastAsOf(
  asOfIsoDay: string,
  horizon = 365,
  mode: "raw" | "robust" = "robust"
): Promise<RevenueForecastResult> {
  const parsed = new Date(`${String(asOfIsoDay || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Date de reconstruction forecast invalide.");
  }
  return runRevenueForecastInternal(horizon, mode, true, parsed);
}
