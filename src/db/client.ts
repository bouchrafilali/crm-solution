import { Pool } from "pg";
import { env } from "../config/env.js";
import { DB_SCHEMA_SQL } from "./schema.js";

let pool: Pool | null = null;

export function isDbEnabled(): boolean {
  return Boolean(env.DATABASE_URL);
}

export function getDbPool(): Pool | null {
  if (!env.DATABASE_URL) return null;
  if (!pool) {
    const shouldUseSsl =
      env.DATABASE_URL.includes("sslmode=") || env.DATABASE_URL.includes("ssl=true");
    const rejectUnauthorized = env.DB_SSL_REJECT_UNAUTHORIZED !== "false";

    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: shouldUseSsl ? { rejectUnauthorized } : undefined,
      connectionTimeoutMillis: 8000
    });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  const db = getDbPool();
  if (!db) return;
  await db.query(DB_SCHEMA_SQL);
}
