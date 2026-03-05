import type { Pool } from "pg";
import { getDbPool } from "./client.js";
import type { RevenueForecastResult } from "../services/bigqueryForecast.js";

export async function saveForecastRun(forecast: RevenueForecastResult): Promise<number | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;

  const result = await pool.query<{ id: number }>(
    `
      insert into forecast_runs (horizon_days, mode, model_name, payload)
      values ($1, $2, $3, $4::jsonb)
      returning id
    `,
    [
      Math.max(1, Math.floor(Number(forecast.horizon || 0))),
      String(forecast.mode || "robust"),
      String(forecast.modelName || "unknown"),
      JSON.stringify(forecast)
    ]
  );

  return result.rows[0]?.id ?? null;
}

export async function getLatestForecastRun(): Promise<RevenueForecastResult | null> {
  const pool: Pool | null = getDbPool();
  if (!pool) return null;

  const result = await pool.query<{ payload: unknown }>(
    `
      select payload
      from forecast_runs
      order by created_at desc, id desc
      limit 1
    `
  );

  const payload = result.rows[0]?.payload;
  if (!payload || typeof payload !== "object") return null;
  return payload as RevenueForecastResult;
}
