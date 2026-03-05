import { env } from "../config/env.js";
import { getShopifyAdminToken } from "./shopifyAdminAuth.js";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type AppointmentMetafieldItem = {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  appointmentAt: string;
  status: string;
  location: string | null;
  notes: string | null;
  lastMessageAt: string | null;
};

const API_VERSION = "2026-01";

function metafieldNamespace(): string {
  return String(env.SHOPIFY_APPOINTMENTS_METAFIELD_NAMESPACE || "custom").trim() || "custom";
}

function metafieldKey(): string {
  return String(env.SHOPIFY_APPOINTMENTS_METAFIELD_KEY || "appointments").trim() || "appointments";
}

async function adminGraphql<T>(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const raw = await res.text();
  let json: GraphqlResponse<T> | null = null;
  try {
    json = JSON.parse(raw) as GraphqlResponse<T>;
  } catch {
    json = null;
  }

  if (!res.ok || !json || !json.data || (Array.isArray(json.errors) && json.errors.length > 0)) {
    throw new Error(`Shopify GraphQL failed (${res.status}): ${raw.slice(0, 500)}`);
  }

  return json.data;
}

export async function syncAppointmentsMetafield(
  shop: string,
  appointments: AppointmentMetafieldItem[]
): Promise<{ ok: boolean; metafieldId?: string; error?: string }> {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop || !safeShop.endsWith(".myshopify.com")) {
    return { ok: false, error: "Shop Shopify invalide pour sync metafield." };
  }

  try {
    const token = await getShopifyAdminToken(safeShop);

    const shopInfo = await adminGraphql<{ shop: { id: string } }>(
      safeShop,
      token,
      `query ShopId { shop { id } }`,
      {}
    );

    const ownerId = shopInfo.shop?.id;
    if (!ownerId) {
      return { ok: false, error: "Impossible de récupérer l'ID shop Shopify." };
    }

    const payload = JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: appointments.length,
      appointments: appointments.map((entry) => ({
        id: entry.id,
        customerName: entry.customerName,
        customerPhone: entry.customerPhone,
        customerEmail: entry.customerEmail,
        appointmentAt: entry.appointmentAt,
        status: entry.status,
        location: entry.location,
        notes: entry.notes,
        lastMessageAt: entry.lastMessageAt
      }))
    });

    const mutation = `
      mutation UpsertAppointmentsMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            type
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const response = await adminGraphql<{
      metafieldsSet: {
        metafields: Array<{ id: string }>;
        userErrors: Array<{ message?: string }>;
      };
    }>(safeShop, token, mutation, {
      metafields: [
        {
          ownerId,
          namespace: metafieldNamespace(),
          key: metafieldKey(),
          type: "json",
          value: payload
        }
      ]
    });

    const userErrors = response.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      return {
        ok: false,
        error: userErrors.map((entry) => String(entry.message || "Erreur metafield")).join(" | ")
      };
    }

    return { ok: true, metafieldId: response.metafieldsSet?.metafields?.[0]?.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec sync metafield Shopify";
    return { ok: false, error: message };
  }
}
