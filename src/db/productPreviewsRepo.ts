import { randomUUID } from "node:crypto";
import { getDbPool } from "./client.js";

export type ProductPreviewCacheRow = {
  handle: string;
  title: string | null;
  image_url: string | null;
  product_url: string | null;
  updated_at: string;
};

export type ProductPreview = {
  handle: string;
  title: string;
  imageUrl: string;
  productUrl: string;
  updatedAt: string;
};

function mapRow(row: ProductPreviewCacheRow): ProductPreview {
  return {
    handle: String(row.handle || "").trim().toLowerCase(),
    title: String(row.title || "").trim(),
    imageUrl: String(row.image_url || "").trim(),
    productUrl: String(row.product_url || "").trim(),
    updatedAt: String(row.updated_at || "")
  };
}

export async function getCachedProductPreviews(handles: string[], maxAgeHours = 24): Promise<Map<string, ProductPreview>> {
  const db = getDbPool();
  const normalized = Array.from(new Set(
    (handles || [])
      .map((h) => String(h || "").trim().toLowerCase())
      .filter(Boolean)
  ));
  const map = new Map<string, ProductPreview>();
  if (!db || !normalized.length) return map;

  const q = await db.query<ProductPreviewCacheRow>(
    `
      select handle, title, image_url, product_url, updated_at
      from product_previews_cache
      where handle = any($1::text[])
        and updated_at >= now() - ($2::int * interval '1 hour')
    `,
    [normalized, Math.max(1, Math.round(maxAgeHours))]
  );
  q.rows.forEach((row) => {
    const mapped = mapRow(row);
    if (mapped.handle) map.set(mapped.handle, mapped);
  });
  return map;
}

export async function upsertProductPreview(input: {
  handle: string;
  title?: string | null;
  imageUrl?: string | null;
  productUrl?: string | null;
}): Promise<void> {
  const db = getDbPool();
  if (!db) return;
  const handle = String(input.handle || "").trim().toLowerCase();
  if (!handle) return;
  await db.query(
    `
      insert into product_previews_cache (id, handle, title, image_url, product_url, updated_at)
      values ($1::uuid, $2::text, nullif(trim($3::text), ''), nullif(trim($4::text), ''), nullif(trim($5::text), ''), now())
      on conflict (handle)
      do update set
        title = coalesce(excluded.title, product_previews_cache.title),
        image_url = coalesce(excluded.image_url, product_previews_cache.image_url),
        product_url = coalesce(excluded.product_url, product_previews_cache.product_url),
        updated_at = now()
    `,
    [randomUUID(), handle, input.title || "", input.imageUrl || "", input.productUrl || ""]
  );
}

export async function searchCachedProductHandlesByText(text: string, limit = 5): Promise<string[]> {
  const db = getDbPool();
  if (!db) return [];
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const tokens = Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 4)
    )
  ).slice(0, 8);
  if (!tokens.length) return [];

  const safeLimit = Math.max(1, Math.min(20, Math.round(limit || 5)));
  const patterns = tokens.map((token) => `%${token}%`);
  const q = await db.query<{ handle: string; score: number }>(
    `
      select
        handle,
        sum(
          case
            when lower(coalesce(title, '')) like any($1::text[]) then 1
            else 0
          end
        )::int as score
      from product_previews_cache
      where lower(coalesce(title, '')) like any($1::text[])
      group by handle
      order by score desc, handle asc
      limit $2::int
    `,
    [patterns, safeLimit]
  );
  return q.rows.map((row) => String(row.handle || "").trim().toLowerCase()).filter(Boolean);
}
