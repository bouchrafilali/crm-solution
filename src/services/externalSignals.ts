import { google } from "googleapis";
import googleTrends from "google-trends-api";
import { env } from "../config/env.js";

type DailyPoint = { date: string; value: number };
type SearchConsoleRow = {
  date: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};
type Ga4DailyRow = {
  date: string;
  sessions: number;
  users: number;
  sessionConversionRate: number;
};

export type ExternalSignalsSummary = {
  searchConsole: {
    configured: boolean;
    siteUrl?: string;
    points: number;
    recentAvg: number;
    previousAvg: number;
    factor: number;
  };
  trends: {
    configured: boolean;
    keywords: string[];
    geo: string;
    points: number;
    recentAvg: number;
    previousAvg: number;
    factor: number;
  };
  ga4: {
    configured: boolean;
    propertyId?: string;
    points: number;
    recentAvg: number;
    previousAvg: number;
    factor: number;
  };
  combinedFactor: number;
  appliedFactor: number;
  notes: string[];
};

function toIsoDay(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function avg(values: number[]): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, v) => sum + Number(v || 0), 0) / values.length;
}

function stddev(values: number[]): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const m = avg(values);
  const variance = avg(values.map((v) => Math.pow(Number(v || 0) - m, 2)));
  return Math.sqrt(variance);
}

function signalFactor(points: DailyPoint[], windowDays = 28): { recentAvg: number; previousAvg: number; factor: number } {
  if (!Array.isArray(points) || points.length === 0) {
    return { recentAvg: 0, previousAvg: 0, factor: 1 };
  }
  const values = points.map((p) => Number(p.value || 0));
  const recent = values.slice(-windowDays);
  const previous = values.slice(-(windowDays * 2), -windowDays);
  const recentAvg = avg(recent);
  const previousAvg = avg(previous);
  const ratio = previousAvg > 0 ? recentAvg / previousAvg : recentAvg > 0 ? 1.1 : 1;
  return {
    recentAvg,
    previousAvg,
    factor: clamp(ratio, 0.8, 1.25)
  };
}

async function fetchSearchConsoleDaily(fromIso: string, toIso: string): Promise<DailyPoint[]> {
  const siteUrl = String(env.GSC_SITE_URL || "").trim();
  if (!siteUrl) return [];

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"]
  });
  const searchconsole = google.searchconsole({ version: "v1", auth: auth as never });
  const response = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fromIso,
      endDate: toIso,
      dimensions: ["date"],
      rowLimit: 25000,
      dataState: "all"
    }
  });
  const rows = response.data.rows || [];
  return rows
    .map((row) => {
      const key = Array.isArray(row.keys) && row.keys.length > 0 ? String(row.keys[0]) : "";
      return {
        date: toIsoDay(key),
        value: Number(row.clicks || 0)
      };
    })
    .filter((row) => !!row.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSearchConsoleDailyRows(fromIso: string, toIso: string): Promise<SearchConsoleRow[]> {
  const siteUrl = String(env.GSC_SITE_URL || "").trim();
  if (!siteUrl) return [];

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"]
  });
  const searchconsole = google.searchconsole({ version: "v1", auth: auth as never });
  const response = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fromIso,
      endDate: toIso,
      dimensions: ["date", "query"],
      rowLimit: 25000,
      dataState: "all"
    }
  });
  const rows = response.data.rows || [];
  return rows
    .map((row) => {
      const keys = Array.isArray(row.keys) ? row.keys : [];
      const date = toIsoDay(keys[0] || "");
      const query = String(keys[1] || "").trim().toLowerCase();
      return {
        date,
        query,
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        ctr: Number(row.ctr || 0),
        position: Number(row.position || 0)
      };
    })
    .filter((r) => !!r.date);
}

async function fetchTrendsDaily(fromIso: string, toIso: string): Promise<DailyPoint[]> {
  const keywords = String(env.TRENDS_KEYWORDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (keywords.length === 0) return [];
  const geo = String(env.TRENDS_GEO || "MA").trim().toUpperCase();

  const payload = await googleTrends.interestOverTime({
    keyword: keywords,
    geo,
    startTime: new Date(fromIso + "T00:00:00Z"),
    endTime: new Date(toIso + "T23:59:59Z")
  });

  const raw = String(payload || "").trim();
  // Google Trends responses may include anti-XSSI prefixes or non-JSON wrappers.
  const jsonStart = Math.min(
    raw.indexOf("{") >= 0 ? raw.indexOf("{") : Number.POSITIVE_INFINITY,
    raw.indexOf("[") >= 0 ? raw.indexOf("[") : Number.POSITIVE_INFINITY
  );
  const candidate = Number.isFinite(jsonStart) ? raw.slice(jsonStart) : raw;
  let parsed: {
    default?: { timelineData?: Array<{ time?: string; value?: number[] }> };
  };
  if (/<html|<!doctype|<body/i.test(candidate)) {
    throw new Error("réponse HTML reçue (service temporairement indisponible)");
  }
  try {
    parsed = JSON.parse(candidate) as {
      default?: { timelineData?: Array<{ time?: string; value?: number[] }> };
    };
  } catch (error) {
    throw new Error("réponse non JSON invalide");
  }

  const parsedTyped = parsed as {
    default?: { timelineData?: Array<{ time?: string; value?: number[] }> };
  };
  const timeline = parsedTyped?.default?.timelineData || [];
  return timeline
    .map((item) => {
      const ts = Number(item.time || 0) * 1000;
      const date = toIsoDay(new Date(ts));
      const values = Array.isArray(item.value) ? item.value : [];
      const value = values.length > 0 ? avg(values) : 0;
      return { date, value };
    })
    .filter((row) => !!row.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseGaDate(dateText: string): string {
  const raw = String(dateText || "").trim();
  if (!/^\d{8}$/.test(raw)) return "";
  return raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8);
}

async function fetchGa4Daily(fromIso: string, toIso: string): Promise<Ga4DailyRow[]> {
  const propertyId = String(env.GA4_PROPERTY_ID || "").trim();
  if (!propertyId) return [];

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"]
  });
  const analyticsdata = google.analyticsdata({ version: "v1beta", auth: auth as never });
  const response = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: fromIso, endDate: toIso }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "activeUsers" },
        { name: "sessionConversionRate" }
      ],
      limit: "100000"
    }
  });
  const rows = Array.isArray(response.data.rows) ? response.data.rows : [];
  return rows
    .map((row) => {
      const dim = Array.isArray(row.dimensionValues) ? row.dimensionValues : [];
      const met = Array.isArray(row.metricValues) ? row.metricValues : [];
      return {
        date: parseGaDate(String(dim[0]?.value || "")),
        sessions: Number(met[0]?.value || 0),
        users: Number(met[1]?.value || 0),
        sessionConversionRate: Number(met[2]?.value || 0)
      };
    })
    .filter((r) => !!r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function classifySearchQuery(query: string): "brand" | "product" | "other" {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return "other";
  const brandTokens = ["bouchra", "filali", "lahlou", "maison bouchra", "mbfl"];
  const productTokens = [
    "caftan",
    "djellaba",
    "takchita",
    "robe",
    "dress",
    "gandoura",
    "abaya",
    "couture"
  ];
  if (brandTokens.some((token) => q.includes(token))) return "brand";
  if (productTokens.some((token) => q.includes(token))) return "product";
  return "other";
}

export type ExternalSignalsDaily = {
  date: string;
  brand_clicks: number;
  brand_impressions: number;
  product_clicks: number;
  product_impressions: number;
  ctr: number;
  avg_position: number;
  trend_index: number;
  trend_zscore: number;
  ga4_sessions: number;
  ga4_users: number;
  ga4_conversion_rate: number;
};

export async function fetchExternalSignalsDaily(fromIso: string, toIso: string): Promise<ExternalSignalsDaily[]> {
  const gscConfigured = Boolean(String(env.GSC_SITE_URL || "").trim());
  const trendsConfigured = String(env.TRENDS_KEYWORDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean).length > 0;
  const ga4Configured = Boolean(String(env.GA4_PROPERTY_ID || "").trim());

  const gscRows = gscConfigured ? await fetchSearchConsoleDailyRows(fromIso, toIso) : [];
  const trendsRows = trendsConfigured ? await fetchTrendsDaily(fromIso, toIso) : [];
  const ga4Rows = ga4Configured ? await fetchGa4Daily(fromIso, toIso) : [];

  const byDay = new Map<
    string,
    {
      brandClicks: number;
      brandImpr: number;
      productClicks: number;
      productImpr: number;
      totalClicks: number;
      totalImpr: number;
      weightedPos: number;
      trend: number;
      ga4Sessions: number;
      ga4Users: number;
      ga4ConversionRate: number;
    }
  >();

  function ensure(day: string) {
    const existing =
      byDay.get(day) || {
        brandClicks: 0,
        brandImpr: 0,
        productClicks: 0,
        productImpr: 0,
        totalClicks: 0,
        totalImpr: 0,
        weightedPos: 0,
        trend: 0,
        ga4Sessions: 0,
        ga4Users: 0,
        ga4ConversionRate: 0
      };
    byDay.set(day, existing);
    return existing;
  }

  gscRows.forEach((row) => {
    if (!row.date) return;
    const bucket = ensure(row.date);
    const cls = classifySearchQuery(row.query);
    if (cls === "brand") {
      bucket.brandClicks += Number(row.clicks || 0);
      bucket.brandImpr += Number(row.impressions || 0);
    } else if (cls === "product") {
      bucket.productClicks += Number(row.clicks || 0);
      bucket.productImpr += Number(row.impressions || 0);
    }
    bucket.totalClicks += Number(row.clicks || 0);
    bucket.totalImpr += Number(row.impressions || 0);
    bucket.weightedPos += Number(row.position || 0) * Math.max(1, Number(row.impressions || 0));
  });

  const trendRawByDay = new Map<string, number>();
  trendsRows.forEach((row) => {
    const day = String(row.date || "");
    if (!day) return;
    trendRawByDay.set(day, Number(row.value || 0));
    const bucket = ensure(day);
    bucket.trend = Number(row.value || 0);
  });
  ga4Rows.forEach((row) => {
    if (!row.date) return;
    const bucket = ensure(row.date);
    bucket.ga4Sessions = Number(row.sessions || 0);
    bucket.ga4Users = Number(row.users || 0);
    bucket.ga4ConversionRate = Number(row.sessionConversionRate || 0);
  });

  const trendValues = Array.from(trendRawByDay.values());
  const mean = avg(trendValues);
  const sigma = stddev(trendValues);

  const days: string[] = [];
  const fromDate = new Date(fromIso + "T00:00:00Z");
  const toDate = new Date(toIso + "T00:00:00Z");
  for (
    let d = new Date(fromDate.getTime());
    d.getTime() <= toDate.getTime();
    d = new Date(d.getTime() + 86400000)
  ) {
    days.push(d.toISOString().slice(0, 10));
  }

  return days.map((day) => {
    const bucket = byDay.get(day) || {
      brandClicks: 0,
      brandImpr: 0,
      productClicks: 0,
      productImpr: 0,
      totalClicks: 0,
      totalImpr: 0,
      weightedPos: 0,
      trend: 0,
      ga4Sessions: 0,
      ga4Users: 0,
      ga4ConversionRate: 0
    };
    const ctr = bucket.totalImpr > 0 ? bucket.totalClicks / bucket.totalImpr : 0;
    const avgPosition = bucket.totalImpr > 0 ? bucket.weightedPos / bucket.totalImpr : 0;
    const z = sigma > 0 ? (bucket.trend - mean) / sigma : 0;
    const zCapped = clamp(z, -3, 3);
    return {
      date: day,
      brand_clicks: Number(bucket.brandClicks.toFixed(3)),
      brand_impressions: Number(bucket.brandImpr.toFixed(3)),
      product_clicks: Number(bucket.productClicks.toFixed(3)),
      product_impressions: Number(bucket.productImpr.toFixed(3)),
      ctr: Number(ctr.toFixed(6)),
      avg_position: Number(avgPosition.toFixed(4)),
      trend_index: Number(bucket.trend.toFixed(3)),
      trend_zscore: Number(zCapped.toFixed(4)),
      ga4_sessions: Number(bucket.ga4Sessions.toFixed(3)),
      ga4_users: Number(bucket.ga4Users.toFixed(3)),
      ga4_conversion_rate: Number(bucket.ga4ConversionRate.toFixed(6))
    };
  });
}

export async function computeExternalSignals(fromIso: string, toIso: string): Promise<ExternalSignalsSummary> {
  const notes: string[] = [];
  const gscConfigured = Boolean(String(env.GSC_SITE_URL || "").trim());
  const trendsKeywords = String(env.TRENDS_KEYWORDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const trendsConfigured = trendsKeywords.length > 0;
  const ga4Configured = Boolean(String(env.GA4_PROPERTY_ID || "").trim());
  const geo = String(env.TRENDS_GEO || "MA").trim().toUpperCase();
  const ga4PropertyId = String(env.GA4_PROPERTY_ID || "").trim();

  let searchConsolePoints: DailyPoint[] = [];
  let trendsPoints: DailyPoint[] = [];
  let ga4Points: DailyPoint[] = [];

  if (gscConfigured) {
    try {
      searchConsolePoints = await fetchSearchConsoleDaily(fromIso, toIso);
    } catch (error) {
      notes.push("Search Console indisponible: " + (error instanceof Error ? error.message : "erreur"));
    }
  } else {
    notes.push("Search Console non configuré (GSC_SITE_URL).");
  }

  if (trendsConfigured) {
    try {
      trendsPoints = await fetchTrendsDaily(fromIso, toIso);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "erreur";
      const safeMessage =
        /html|non json|invalid json|tempor/i.test(rawMessage.toLowerCase())
          ? "service temporairement indisponible"
          : "erreur de connexion";
      notes.push("Google Trends indisponible: " + safeMessage);
    }
  } else {
    notes.push("Google Trends non configuré (TRENDS_KEYWORDS).");
  }
  if (ga4Configured) {
    try {
      const gaRows = await fetchGa4Daily(fromIso, toIso);
      ga4Points = gaRows.map((row) => ({ date: row.date, value: Number(row.sessions || 0) }));
    } catch (error) {
      notes.push("GA4 indisponible: " + (error instanceof Error ? error.message : "erreur de connexion"));
    }
  } else {
    notes.push("GA4 non configuré (GA4_PROPERTY_ID).");
  }

  const sc = signalFactor(searchConsolePoints);
  const tr = signalFactor(trendsPoints);
  const ga = signalFactor(ga4Points);
  // Blend Search Console + Trends + GA4 with conservative weights.
  const scWeight = searchConsolePoints.length > 0 ? 0.55 : 0;
  const trWeight = trendsPoints.length > 0 ? 0.2 : 0;
  const gaWeight = ga4Points.length > 0 ? 0.25 : 0;
  const totalWeight = scWeight + trWeight + gaWeight;
  const combinedFactor =
    totalWeight > 0
      ? ((scWeight * sc.factor) + (trWeight * tr.factor) + (gaWeight * ga.factor)) / totalWeight
      : 1;
  const appliedFactor = clamp(1 + (combinedFactor - 1) * 0.45, 0.88, 1.12);
  if (trendsConfigured && trendsPoints.length > 0) {
    notes.push("Google Trends intégré au forecast (pondération 20%).");
  }
  if (ga4Configured && ga4Points.length > 0) {
    notes.push("GA4 intégré au forecast (pondération 25%).");
  }

  return {
    searchConsole: {
      configured: gscConfigured,
      siteUrl: gscConfigured ? String(env.GSC_SITE_URL) : undefined,
      points: searchConsolePoints.length,
      recentAvg: sc.recentAvg,
      previousAvg: sc.previousAvg,
      factor: sc.factor
    },
    trends: {
      configured: trendsConfigured,
      keywords: trendsKeywords,
      geo,
      points: trendsPoints.length,
      recentAvg: tr.recentAvg,
      previousAvg: tr.previousAvg,
      factor: tr.factor
    },
    ga4: {
      configured: ga4Configured,
      propertyId: ga4Configured ? ga4PropertyId : undefined,
      points: ga4Points.length,
      recentAvg: ga.recentAvg,
      previousAvg: ga.previousAvg,
      factor: ga.factor
    },
    combinedFactor,
    appliedFactor,
    notes
  };
}
