import { Pool, type PoolClient } from "pg";
import { env } from "../config/env.js";
import { DB_SCHEMA_SQL } from "./schema.js";

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 3000;

let pool: Pool | null = null;

export function isDbEnabled(): boolean {
  return Boolean(env.DATABASE_URL);
}

export function getDbPool(): Pool | null {
  if (!env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      ssl: { rejectUnauthorized: false }
    });

    pool.on("error", (error) => {
      console.error("[db] Unexpected pool error", error);
    });
  }
  return pool;
}

export async function withDbClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = getDbPool();
  if (!db) {
    throw new Error("DATABASE_URL is not configured");
  }

  const client = await db.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export async function verifyDbConnection(): Promise<void> {
  await withDbClient(async (client) => {
    await client.query("select 1");
  });
}

export async function initDb(): Promise<void> {
  const db = getDbPool();
  if (!db) return;
  await db.query(DB_SCHEMA_SQL);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function connectDbWithRetry(
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
): Promise<void> {
  if (!isDbEnabled()) return;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await verifyDbConnection();
      console.log(`[db] Connected on attempt ${attempt}/${maxAttempts}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`[db] Connection attempt ${attempt}/${maxAttempts} failed`, error);
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }
  }

  throw new Error(
    `[db] Failed to connect after ${maxAttempts} attempts`,
    lastError ? { cause: lastError } : undefined
  );
}
