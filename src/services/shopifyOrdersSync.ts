import { assertShopifyShop, getShopifyAdminToken } from "./shopifyAdminAuth.js";

type ShopifyOrder = {
  id: number;
  name?: string;
  created_at: string;
  subtotal_price?: string;
  total_price: string;
  total_discounts?: string;
  current_subtotal_price?: string;
  current_total_discounts?: string;
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
  transactions?: Array<{
    gateway?: string;
    kind?: string;
    status?: string;
    amount?: string;
    currency?: string;
    processed_at?: string;
    created_at?: string;
  }>;
  line_items?: Array<{
    id?: number;
    title?: string;
    quantity?: number;
    current_quantity?: number;
    price?: string;
    fulfillment_status?: string | null;
  }>;
};

type ShopifyTransaction = {
  gateway?: string;
  kind?: string;
  status?: string;
  amount?: string;
  currency?: string;
  processed_at?: string;
  created_at?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shopifyFetchWithRetry(url: string, token: string, maxRetries = 6): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      }
    });

    if (res.status !== 429 || attempt >= maxRetries) {
      return res;
    }

    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const waitMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(500, retryAfterSeconds * 1000)
      : Math.min(4000, 700 * (attempt + 1));
    await sleep(waitMs);
    attempt += 1;
  }
}

function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function fetchOrderTransactions(shop: string, token: string, orderId: number): Promise<ShopifyTransaction[]> {
  const url = `https://${shop}/admin/api/2026-01/orders/${orderId}/transactions.json?fields=gateway,kind,status,amount,currency,processed_at,created_at`;
  const res = await shopifyFetchWithRetry(url, token);
  if (!res.ok) return [];
  const json = (await res.json()) as { transactions?: ShopifyTransaction[] };
  return Array.isArray(json.transactions) ? json.transactions : [];
}

async function attachTransactions(shop: string, token: string, orders: ShopifyOrder[]): Promise<void> {
  if (!orders.length) return;
  // Keep bulk sync fast: only hydrate a few recent orders for payment details.
  const maxOrdersToHydrate = orders.length <= 8 ? orders.length : Math.min(8, orders.length);
  const targetOrders = orders.slice(0, Math.min(maxOrdersToHydrate, orders.length));

  for (const order of targetOrders) {
    try {
      order.transactions = await fetchOrderTransactions(shop, token, order.id);
    } catch {
      order.transactions = [];
    }
    if (targetOrders.length > 1) {
      // Keep calls under low API budgets (e.g., 2 calls/s).
      await sleep(520);
    }
  }
}

export async function fetchOrdersForPeriod(
  fromIso: string,
  toIso: string,
  options?: { includeTransactions?: boolean }
): Promise<ShopifyOrder[]> {
  const shop = assertShopifyShop();
  const token = await getShopifyAdminToken(shop);
  const fields =
    "id,name,created_at,subtotal_price,total_price,total_discounts,current_subtotal_price,current_total_discounts,total_outstanding,currency,financial_status,fulfillment_status,source_name,location_id,customer,shipping_address,billing_address,payment_gateway_names,transactions,line_items";
  let url: string | null = `https://${shop}/admin/api/2026-01/orders.json?status=any&limit=250&fields=${fields}&created_at_min=${encodeURIComponent(fromIso)}&created_at_max=${encodeURIComponent(toIso)}`;
  const orders: ShopifyOrder[] = [];
  let pageCount = 0;

  while (url && pageCount < 20) {
    const res = await shopifyFetchWithRetry(url, token);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify sync failed (${res.status}): ${body.slice(0, 250)}`);
    }

    const json = (await res.json()) as { orders?: ShopifyOrder[] };
    orders.push(...(json.orders ?? []));
    url = getNextPageUrl(res.headers.get("link"));
    pageCount += 1;
  }

  if (options?.includeTransactions) {
    await attachTransactions(shop, token, orders);
  }

  return orders;
}
