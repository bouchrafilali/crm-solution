# Shopify Business App Starter

Custom Shopify app starter built for adapting behavior to your business model.

## What is included

- TypeScript + Express app skeleton
- Shopify API client initialization
- Verified `orders/create` webhook endpoint
- Business rules module (`src/config/business.ts`)
- Order action evaluator (`src/services/orderProcessor.ts`)

## 1) Configure environment

1. Copy `.env.example` to `.env`.
2. Fill app credentials from Shopify Partners.
3. Set `SHOPIFY_APP_URL` to your public tunnel/app URL.
4. To sync historical orders in dashboard, set `SHOPIFY_ADMIN_ACCESS_TOKEN`.
5. If no Admin token is available, sync uses client credentials (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`).
6. For PDF invoice upload to Shopify Files, include `write_files` in `SHOPIFY_SCOPES` and re-authorize app if needed.
7. `SHOPIFY_REFRESH_TOKEN` remains only as legacy fallback.

## 2) Install and run

```bash
npm install
npm run dev
```

Open the visual dashboard at:

```text
http://localhost:3000/admin
```

In the dashboard:
- Sync existing orders by date range
- Manage shipping queue order (rank), status, shipping date, and per-article states
- Send invoices to clients via API template (Zoko/configurable), without opening WhatsApp Web

## 3) Connect to Shopify

1. In Shopify Partners, create an app for your store.
2. Add scopes from `SHOPIFY_SCOPES`.
3. Set app URL and redirect URLs to match your public URL.
4. Register webhook topic `orders/create` pointing to:

```text
https://your-app-url/webhooks/orders/create
```

## 4) Adapt business behavior

- Update brand/business settings in `src/config/business.ts`.
- Add your automations in `src/routes/webhooks.ts`:
  - Tag VIP customers
  - Push orders to ERP/CRM
  - Trigger review or retention workflows

## Recommended next features

- OAuth install + session storage
- Admin embedded UI for business settings
- Product recommendations engine
- Customer segmentation + lifecycle campaigns

## WhatsApp API template invoice sending

1. Set in `.env`:
   - `ZOKO_API_URL`
   - `ZOKO_AUTH_TOKEN`
   - Optional: `ZOKO_AUTH_HEADER`, `ZOKO_AUTH_PREFIX`, `ZOKO_TEMPLATE_NAME`, `ZOKO_TEMPLATE_LANGUAGE`, `ZOKO_CHANNEL`
   - Optional troubleshooting: `ZOKO_ALLOW_INSECURE_TLS=true` (temporary only)
2. (Optional advanced) set `ZOKO_TEMPLATE_PAYLOAD_JSON` with placeholders:
   - `{{phone}}`, `{{customer_name}}`, `{{order_name}}`, `{{invoice_url}}`, `{{total_amount}}`, `{{outstanding_amount}}`, `{{currency}}`
3. In Orders details, click `Envoyer facture via API template`.
4. The app generates a signed invoice URL and sends it through your configured API.

## WhatsApp Google review request

1. Set in `.env`:
   - `ZOKO_REVIEW_TEMPLATE_NAME` (ex: `demander_avis`)
   - `ZOKO_REVIEW_TEMPLATE_LANGUAGE` (ex: `fr`)
   - Optional: `ZOKO_REVIEW_TEMPLATE_TYPE` (ex: `buttonTemplate`)
2. Optional:
   - `ZOKO_REVIEW_TEMPLATE_ARGS_JSON`
   - `ZOKO_REVIEW_TEMPLATE_PAYLOAD_JSON` with placeholders: `{{phone}}`, `{{customer_name}}`, `{{order_name}}`
   - If your Zoko template already has a static CTA URL, no extra URL env variable is needed
3. In order details (Client card), click `Envoyer demande avis Google`.
