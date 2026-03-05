import { env } from "../config/env.js";
import { getCachedProductPreviews, upsertProductPreview, type ProductPreview } from "../db/productPreviewsRepo.js";

const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='100%' height='100%' fill='#0f1725'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#8fa6c9' font-size='10'>No image</text></svg>"
  );

function normalizeHandle(raw: string): string {
  return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function fallbackPreview(handle: string): ProductPreview {
  const shop = String(env.SHOPIFY_SHOP || "").trim();
  const productUrl = shop ? `https://${shop}/products/${handle}` : "";
  return {
    handle,
    title: handle.replace(/-/g, " "),
    imageUrl: PLACEHOLDER_IMAGE,
    productUrl,
    updatedAt: new Date().toISOString()
  };
}

async function fetchStorefrontByHandle(handle: string): Promise<ProductPreview | null> {
  const shop = String(env.SHOPIFY_SHOP || "").trim();
  const token = String(env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "").trim();
  const apiVersion = String(env.SHOPIFY_STOREFRONT_API_VERSION || "2025-01").trim();
  if (!shop || !token) return null;

  const endpoint = `https://${shop}/api/${apiVersion}/graphql.json`;
  const query = `
    query ProductByHandle($handle: String!) {
      product(handle: $handle) {
        title
        onlineStoreUrl
        featuredImage { url altText }
      }
    }
  `;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token
      },
      body: JSON.stringify({ query, variables: { handle } })
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as any;
    const product = payload?.data?.product;
    if (!product) return null;
    return {
      handle,
      title: String(product?.title || handle).trim(),
      imageUrl: String(product?.featuredImage?.url || PLACEHOLDER_IMAGE).trim(),
      productUrl: String(product?.onlineStoreUrl || `https://${shop}/products/${handle}`).trim(),
      updatedAt: new Date().toISOString()
    };
  } catch {
    return null;
  }
}

async function fetchPublicProductJson(handle: string): Promise<ProductPreview | null> {
  const shop = String(env.SHOPIFY_SHOP || "").trim();
  if (!shop) return null;
  const url = `https://${shop}/products/${handle}.js`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const payload = (await res.json()) as any;
    return {
      handle,
      title: String(payload?.title || handle).trim(),
      imageUrl: String(payload?.featured_image || (Array.isArray(payload?.images) ? payload.images[0] : "") || PLACEHOLDER_IMAGE).trim(),
      productUrl: `https://${shop}/products/${handle}`,
      updatedAt: new Date().toISOString()
    };
  } catch {
    return null;
  }
}

async function fetchOneProductPreview(handle: string): Promise<ProductPreview> {
  const sf = await fetchStorefrontByHandle(handle);
  if (sf) return sf;
  const pub = await fetchPublicProductJson(handle);
  if (pub) return pub;
  return fallbackPreview(handle);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, limit) }).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function getProductPreviews(handles: string[]): Promise<Record<string, { title: string; image_url: string; product_url: string }>> {
  const normalized = Array.from(new Set((handles || []).map(normalizeHandle).filter(Boolean)));
  if (!normalized.length) return {};

  const cached = await getCachedProductPreviews(normalized, 24);
  const missing = normalized.filter((h) => !cached.has(h));

  const fetched = await mapWithConcurrency(missing, 5, async (handle) => {
    const preview = await fetchOneProductPreview(handle);
    await upsertProductPreview({
      handle,
      title: preview.title,
      imageUrl: preview.imageUrl,
      productUrl: preview.productUrl
    });
    return preview;
  });

  const result: Record<string, { title: string; image_url: string; product_url: string }> = {};
  normalized.forEach((h) => {
    const fromCache = cached.get(h);
    const fromFetched = fetched.find((item) => item.handle === h);
    const chosen = fromCache || fromFetched || fallbackPreview(h);
    result[h] = {
      title: chosen.title || h,
      image_url: chosen.imageUrl || PLACEHOLDER_IMAGE,
      product_url: chosen.productUrl || ""
    };
  });

  return result;
}
