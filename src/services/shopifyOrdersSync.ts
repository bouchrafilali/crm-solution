import { assertShopifyShop, getShopifyAdminToken } from "./shopifyAdminAuth.js";

type ShopifyOrder = {
  id: number;
  name?: string;
  created_at: string;
  total_price: string;
  total_outstanding?: string;
  currency?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  source_name?: string;
  location_id?: number;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  shipping_address?: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    country?: string;
    zip?: string;
    phone?: string;
  };
  billing_address?: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    country?: string;
    zip?: string;
    phone?: string;
  };
  payment_gateway_names?: string[];
  line_items?: Array<{
    id?: number;
    title?: string;
    quantity?: number;
    price?: string;
    fulfillment_status?: string | null;
  }>;
};

function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

export async function fetchOrdersForPeriod(fromIso: string, toIso: string): Promise<ShopifyOrder[]> {
  const shop = assertShopifyShop();
  const token = await getShopifyAdminToken(shop);
  const fields =
    "id,name,created_at,total_price,total_outstanding,currency,financial_status,fulfillment_status,source_name,location_id,customer,shipping_address,billing_address,payment_gateway_names,line_items";
  let url: string | null = `https://${shop}/admin/api/2026-01/orders.json?status=any&limit=250&fields=${fields}&created_at_min=${encodeURIComponent(fromIso)}&created_at_max=${encodeURIComponent(toIso)}`;
  const orders: ShopifyOrder[] = [];
  let pageCount = 0;

  while (url && pageCount < 20) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify sync failed (${res.status}): ${body.slice(0, 250)}`);
    }

    const json = (await res.json()) as { orders?: ShopifyOrder[] };
    orders.push(...(json.orders ?? []));
    url = getNextPageUrl(res.headers.get("link"));
    pageCount += 1;
  }

  return orders;
}
