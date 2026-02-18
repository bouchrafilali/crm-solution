import { env } from "../config/env.js";

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

function assertSyncConfig(): { shop: string } {
  if (!env.SHOPIFY_SHOP) {
    throw new Error("Missing SHOPIFY_SHOP in .env");
  }

  return {
    shop: env.SHOPIFY_SHOP
  };
}

async function exchangeClientCredentialsToken(shop: string): Promise<string | null> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      grant_type: "client_credentials",
      scope: env.SHOPIFY_SCOPES
    })
  });

  const raw = await response.text();
  let json: { access_token?: string; error_description?: string } | null = null;
  try {
    json = JSON.parse(raw) as { access_token?: string; error_description?: string };
  } catch {
    json = null;
  }

  if (response.ok && json?.access_token) {
    return json.access_token;
  }

  return null;
}

async function exchangeRefreshToken(shop: string): Promise<string | null> {
  if (!env.SHOPIFY_REFRESH_TOKEN) {
    return null;
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      refresh_token: env.SHOPIFY_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });

  const raw = await response.text();
  let json: { access_token?: string; error_description?: string } | null = null;
  try {
    json = JSON.parse(raw) as { access_token?: string; error_description?: string };
  } catch {
    json = null;
  }

  if (response.ok && json?.access_token) {
    return json.access_token;
  }

  return null;
}

async function getAdminToken(shop: string): Promise<string> {
  if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  }

  const clientCredentialsToken = await exchangeClientCredentialsToken(shop);
  if (clientCredentialsToken) {
    return clientCredentialsToken;
  }

  const refreshTokenAccess = await exchangeRefreshToken(shop);
  if (refreshTokenAccess) {
    return refreshTokenAccess;
  }

  throw new Error(
    "Token exchange failed. Configure SHOPIFY_ADMIN_ACCESS_TOKEN or valid client credentials in .env (SHOPIFY_API_KEY/SHOPIFY_API_SECRET/SHOPIFY_SCOPES)."
  );
}

function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

export async function fetchOrdersForPeriod(fromIso: string, toIso: string): Promise<ShopifyOrder[]> {
  const { shop } = assertSyncConfig();
  const token = await getAdminToken(shop);
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
