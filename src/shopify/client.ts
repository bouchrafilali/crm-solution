import { LATEST_API_VERSION, shopifyApi } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import { env } from "../config/env.js";

export const shopify = shopifyApi({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecretKey: env.SHOPIFY_API_SECRET,
  scopes: env.SHOPIFY_SCOPES.split(",").map((scope) => scope.trim()),
  hostName: env.SHOPIFY_APP_URL.replace(/^https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true
});
