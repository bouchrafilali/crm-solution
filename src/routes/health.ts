import { Router } from "express";
import { isDbEnabled, withDbClient } from "../db/db.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({ ok: true });
});

healthRouter.get("/db", async (_req, res) => {
  if (!isDbEnabled()) {
    res.status(503).json({
      ok: false,
      db: "disabled",
      message: "DATABASE_URL is not configured"
    });
    return;
  }

  try {
    const startedAt = Date.now();
    await withDbClient(async (client) => {
      await client.query("select 1 as ok");
    });
    const latencyMs = Date.now() - startedAt;

    res.status(200).json({
      ok: true,
      db: "up",
      latencyMs
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      db: "down",
      error: error instanceof Error ? error.message : "Unknown database error"
    });
  }
});
