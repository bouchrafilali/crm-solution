import { getShopifyAdminToken } from "./shopifyAdminAuth.js";

export type ShopifyPointOfSale = {
  id: string;
  name: string;
  city: string;
  country: string;
  active: boolean;
};

export async function listShopifyPointsOfSale(shop: string): Promise<ShopifyPointOfSale[]> {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop || !safeShop.endsWith(".myshopify.com")) {
    throw new Error("Shop Shopify invalide pour charger les points de vente.");
  }

  const token = await getShopifyAdminToken(safeShop);
  const res = await fetch(`https://${safeShop}/admin/api/2026-01/locations.json?limit=250`, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    }
  });

  const raw = await res.text();
  let json: { locations?: Array<Record<string, unknown>> } | null = null;
  try {
    json = JSON.parse(raw) as { locations?: Array<Record<string, unknown>> };
  } catch {
    json = null;
  }

  if (!res.ok || !json || !Array.isArray(json.locations)) {
    throw new Error(`Shopify locations API failed (${res.status}): ${raw.slice(0, 300)}`);
  }

  return json.locations.map((row) => ({
    id: String(row.id || ""),
    name: String(row.name || "Point de vente"),
    city: String(row.city || ""),
    country: String(row.country_name || row.country || ""),
    active: Boolean(row.active !== false)
  }));
}

