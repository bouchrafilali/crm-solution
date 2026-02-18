import express from "express";
import { env } from "./config/env.js";
import { adminRouter } from "./routes/admin.js";
import { healthRouter } from "./routes/health.js";
import { webhooksRouter } from "./routes/webhooks.js";
import "./shopify/client.js";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const shopParam = typeof req.query.shop === "string" ? req.query.shop : "";
  const isValidShop = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopParam);
  const frameAncestors = ["https://admin.shopify.com", isValidShop ? `https://${shopParam}` : "https://*.myshopify.com"];

  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors.join(" ")};`);
  next();
});

app.get("/", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(`/admin${query}`);
});

app.use("/admin", adminRouter);
app.use("/health", healthRouter);
app.use("/webhooks", webhooksRouter);

app.listen(env.PORT, () => {
  console.log(`Shopify app listening on port ${env.PORT}`);
});
