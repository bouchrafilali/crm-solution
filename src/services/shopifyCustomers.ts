import { getShopifyAdminToken } from "./shopifyAdminAuth.js";

type ShopifyCustomer = {
  id: number;
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type ShopifyCustomerSuggestion = {
  id: string;
  name: string;
  email: string;
  phone: string;
};

function toSuggestion(entry: ShopifyCustomer): ShopifyCustomerSuggestion {
  const first = String(entry.first_name || "").trim();
  const last = String(entry.last_name || "").trim();
  const name = [first, last].filter(Boolean).join(" ").trim() || "Client Shopify";
  return {
    id: String(entry.id),
    name,
    email: String(entry.email || "").trim(),
    phone: String(entry.phone || "").trim()
  };
}

function normalizePhone(phone: string): string {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/[^0-9]/g, "");
    return digits ? `+${digits}` : "";
  }
  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? `+${digits}` : "";
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const safe = String(fullName || "").trim().replace(/\s+/g, " ");
  if (!safe) return { firstName: "Client", lastName: "Appointment" };
  const parts = safe.split(" ");
  const firstName = parts.shift() || "Client";
  const lastName = parts.join(" ").trim() || "Appointment";
  return { firstName, lastName };
}

async function shopifyRest<T>(
  shop: string,
  token: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/2026-01${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      ...(init?.headers || {})
    }
  });

  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    throw new Error(`Shopify customer API failed (${res.status}): ${raw.slice(0, 300)}`);
  }
  return parsed as T;
}

async function findCustomerByEmail(shop: string, token: string, email: string): Promise<ShopifyCustomer | null> {
  if (!email) return null;
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail) return null;
  const data = await shopifyRest<{ customers?: ShopifyCustomer[] }>(
    shop,
    token,
    `/customers/search.json?query=${encodeURIComponent(`email:${safeEmail}`)}&limit=1`
  );
  return Array.isArray(data.customers) && data.customers.length > 0 ? data.customers[0] : null;
}

async function findCustomerByPhone(shop: string, token: string, phone: string): Promise<ShopifyCustomer | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const data = await shopifyRest<{ customers?: ShopifyCustomer[] }>(
    shop,
    token,
    `/customers/search.json?query=${encodeURIComponent(`phone:${normalized}`)}&limit=1`
  );
  return Array.isArray(data.customers) && data.customers.length > 0 ? data.customers[0] : null;
}

async function createCustomer(
  shop: string,
  token: string,
  input: { customerName: string; customerPhone: string; customerEmail?: string | null }
): Promise<ShopifyCustomer> {
  const name = splitName(input.customerName);
  const normalizedPhone = normalizePhone(input.customerPhone);
  const safeEmail = String(input.customerEmail || "").trim().toLowerCase();

  const payload = {
    customer: {
      first_name: name.firstName,
      last_name: name.lastName,
      email: safeEmail || undefined,
      phone: normalizedPhone || undefined,
      verified_email: false,
      tags: "appointment-client",
      note: "Created from appointment workflow"
    }
  };

  const data = await shopifyRest<{ customer?: ShopifyCustomer }>(shop, token, "/customers.json", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!data.customer) {
    throw new Error("Customer creation succeeded but payload.customer is missing.");
  }
  return data.customer;
}

export async function ensureShopifyCustomerForAppointment(input: {
  shop: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
}): Promise<{ customerId: string; created: boolean }> {
  const shop = String(input.shop || "").trim().toLowerCase();
  if (!shop || !shop.endsWith(".myshopify.com")) {
    throw new Error("Shop Shopify invalide pour créer/rechercher le client.");
  }
  const token = await getShopifyAdminToken(shop);

  const safeEmail = String(input.customerEmail || "").trim().toLowerCase();
  if (safeEmail) {
    const byEmail = await findCustomerByEmail(shop, token, safeEmail);
    if (byEmail?.id) return { customerId: String(byEmail.id), created: false };
  }

  const byPhone = await findCustomerByPhone(shop, token, input.customerPhone);
  if (byPhone?.id) return { customerId: String(byPhone.id), created: false };

  const created = await createCustomer(shop, token, input);
  return { customerId: String(created.id), created: true };
}

export async function suggestShopifyCustomers(input: {
  shop: string;
  query: string;
  limit?: number;
}): Promise<ShopifyCustomerSuggestion[]> {
  const shop = String(input.shop || "").trim().toLowerCase();
  if (!shop || !shop.endsWith(".myshopify.com")) {
    throw new Error("Shop Shopify invalide pour suggestion client.");
  }
  const query = String(input.query || "").trim();
  if (query.length < 1) return [];

  const token = await getShopifyAdminToken(shop);
  const safeLimit = Math.max(1, Math.min(10, Math.floor(Number(input.limit || 6))));
  const safeQueryLower = query.toLowerCase();
  const safeQueryDigits = query.replace(/[^0-9]/g, "");

  try {
    const data = await shopifyRest<{ customers?: ShopifyCustomer[] }>(
      shop,
      token,
      `/customers/search.json?query=${encodeURIComponent(query)}&limit=${safeLimit}`
    );
    const rows = Array.isArray(data.customers) ? data.customers : [];
    if (rows.length > 0) return rows.map(toSuggestion);
  } catch {
    // fallback below
  }

  const fallback = await shopifyRest<{ customers?: ShopifyCustomer[] }>(
    shop,
    token,
    `/customers.json?limit=${Math.max(30, safeLimit * 12)}&fields=id,first_name,last_name,email,phone`
  );
  const rows = Array.isArray(fallback.customers) ? fallback.customers : [];

  const filtered = rows.filter((entry) => {
    const name = `${String(entry.first_name || "")} ${String(entry.last_name || "")}`.toLowerCase();
    const email = String(entry.email || "").toLowerCase();
    const phoneRaw = String(entry.phone || "");
    const phoneDigits = phoneRaw.replace(/[^0-9]/g, "");
    const byText = name.includes(safeQueryLower) || email.includes(safeQueryLower) || phoneRaw.toLowerCase().includes(safeQueryLower);
    const byDigits = safeQueryDigits.length > 0 && phoneDigits.includes(safeQueryDigits);
    return byText || byDigits;
  });

  return filtered.slice(0, safeLimit).map(toSuggestion);
}
