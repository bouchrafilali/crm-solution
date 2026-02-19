import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().min(1),
  SHOPIFY_APP_URL: z.string().url(),
  SHOPIFY_SHOP: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_REFRESH_TOKEN: z.string().optional(),
  ZOKO_API_URL: z.string().url().optional(),
  ZOKO_AUTH_TOKEN: z.string().optional(),
  ZOKO_AUTH_HEADER: z.string().optional(),
  ZOKO_AUTH_PREFIX: z.string().optional(),
  ZOKO_TEMPLATE_NAME: z.string().optional(),
  ZOKO_TEMPLATE_LANGUAGE: z.string().optional(),
  ZOKO_TEMPLATE_TYPE: z.string().optional(),
  ZOKO_TEMPLATE_ARGS_JSON: z.string().optional(),
  ZOKO_CHANNEL: z.string().optional(),
  ZOKO_TEMPLATE_PAYLOAD_JSON: z.string().optional(),
  ZOKO_REVIEW_TEMPLATE_NAME: z.string().optional(),
  ZOKO_REVIEW_TEMPLATE_LANGUAGE: z.string().optional(),
  ZOKO_REVIEW_TEMPLATE_TYPE: z.string().optional(),
  ZOKO_REVIEW_TEMPLATE_ARGS_JSON: z.string().optional(),
  ZOKO_REVIEW_TEMPLATE_PAYLOAD_JSON: z.string().optional(),
  ZOKO_ALLOW_INSECURE_TLS: z.string().optional()
});

export const env = envSchema.parse(process.env);
