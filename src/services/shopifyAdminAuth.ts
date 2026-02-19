import { env } from "../config/env.js";

export function assertShopifyShop(): string {
  if (!env.SHOPIFY_SHOP) {
    throw new Error("Missing SHOPIFY_SHOP in .env");
  }
  return env.SHOPIFY_SHOP;
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
  let json: { access_token?: string } | null = null;
  try {
    json = JSON.parse(raw) as { access_token?: string };
  } catch {
    json = null;
  }

  if (response.ok && json?.access_token) {
    return json.access_token;
  }
  return null;
}

async function exchangeRefreshToken(shop: string): Promise<string | null> {
  if (!env.SHOPIFY_REFRESH_TOKEN) return null;

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
  let json: { access_token?: string } | null = null;
  try {
    json = JSON.parse(raw) as { access_token?: string };
  } catch {
    json = null;
  }

  if (response.ok && json?.access_token) {
    return json.access_token;
  }
  return null;
}

export async function getShopifyAdminToken(shop: string): Promise<string> {
  if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  }

  const clientCredentialsToken = await exchangeClientCredentialsToken(shop);
  if (clientCredentialsToken) return clientCredentialsToken;

  const refreshTokenAccess = await exchangeRefreshToken(shop);
  if (refreshTokenAccess) return refreshTokenAccess;

  throw new Error(
    "Token exchange failed. Configure SHOPIFY_ADMIN_ACCESS_TOKEN or valid client credentials in .env (SHOPIFY_API_KEY/SHOPIFY_API_SECRET/SHOPIFY_SCOPES)."
  );
}
