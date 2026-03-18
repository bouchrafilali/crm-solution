import express, { Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "../config/env.js";

export const shoppingBrainRouter = Router();

// ── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = env.CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";
const CLAUDE_MAX_TOKENS = 1024;

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveAssetsDirs(): string[] {
  const candidates = [
    join(process.cwd(), "frontend/shopping/dist"),
    join(process.cwd(), "dist/frontend/shopping/dist"),
  ];
  return candidates.filter((p) => existsSync(p));
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.[a-z0-9]+$/i.test(pathname);
}

function renderShoppingShell(): string {
  const assetsDirs = resolveAssetsDirs();
  const assetsLoaded = assetsDirs.length > 0;
  const version = Date.now();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Maison Bouchra Filali Lahlou — Style Advisor</title>
  <meta name="description" content="Your personal luxury style advisor. Describe the occasion and discover curated pieces." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
  ${assetsLoaded ? `<link rel="stylesheet" href="/shopping/bundle.css?v=${version}" />` : ""}
  <style>
    body { margin: 0; background: #faf7f2; font-family: -apple-system, sans-serif; }
    #root:empty::after {
      content: '';
      display: block;
      width: 48px;
      height: 1px;
      background: #b8935a;
      margin: 48vh auto 0;
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse { 0%,100%{opacity:.25} 50%{opacity:1} }
  </style>
</head>
<body>
  <div id="root"></div>
  ${
    !assetsLoaded
      ? `<noscript>
           <p style="text-align:center;padding:80px 24px;font-family:Georgia,serif;color:#b8935a">
             Shopping advisor assets are missing. Run <code>npm run build:shopping</code>.
           </p>
         </noscript>`
      : ""
  }
  ${
    assetsLoaded
      ? `<script>
      window.__importMap__ = {
        imports: {
          "react": "https://esm.sh/react@19.2.4",
          "react/jsx-runtime": "https://esm.sh/react@19.2.4/jsx-runtime",
          "react-dom/client": "https://esm.sh/react-dom@19.2.4/client"
        }
      };
    </script>
    <script type="module" src="/shopping/bundle.js?v=${version}"></script>`
      : ""
  }
</body>
</html>`;
}

// ── Static assets ────────────────────────────────────────────────────────────

const staticOptions = {
  index: false,
  maxAge: 0,
  etag: true,
  setHeaders: (res: express.Response, filePath: string) => {
    if (/\.(js|css|html)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
};

shoppingBrainRouter.use("/shopping", (req, res, next) => {
  const assetsDirs = resolveAssetsDirs();
  if (!assetsDirs.length) {
    next();
    return;
  }

  let idx = 0;
  const tryNext = (): void => {
    if (idx >= assetsDirs.length) { next(); return; }
    const mw = express.static(assetsDirs[idx++], staticOptions);
    mw(req, res, (err) => { if (err) { next(err); return; } tryNext(); });
  };
  tryNext();
});

// ── SPA shell ────────────────────────────────────────────────────────────────

shoppingBrainRouter.get(["/shopping", "/shopping/*"], (req, res, next) => {
  if (isStaticAssetPath(req.path)) { next(); return; }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).type("html").send(renderShoppingShell());
});

// ── POST /api/shopping-brain ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a luxury personal style advisor for Maison Bouchra Filali Lahlou, a prestigious Moroccan couture house known for exquisite kaftans, evening gowns, and refined occasion wear. Your tone is warm, knowledgeable, and discerning — like a private stylist at a high-end atelier.

When a client describes their needs, you respond with curated recommendations that feel personal and editorial, not transactional.

You MUST respond with a single valid JSON object — no markdown fences, no extra text — with exactly this structure:
{
  "assistantSummary": "A 2–3 sentence editorial response addressing the client directly. Warm, specific, refined.",
  "recommendations": [
    {
      "id": "unique-string-id",
      "title": "Piece name (evocative, editorial)",
      "merchant": "Maison Bouchra Filali Lahlou",
      "reason": "One sentence explaining why this piece suits the occasion and client.",
      "price": "Price in a readable format, e.g. 12 500 MAD or Price on request",
      "image": null,
      "productUrl": null
    }
  ],
  "suggestedNextQuestion": "A natural follow-up question to refine the recommendation, phrased from the advisor's perspective.",
  "nextAction": "one of: explore_more | ask_size_or_details | move_toward_checkout | suggest_consultation"
}

Rules:
- Always return 1–3 recommendations. Never return 0 unless the request is completely off-topic.
- nextAction must be exactly one of the four allowed values.
- If the client seems ready to buy, use move_toward_checkout. If they need guidance, use suggest_consultation. If they want options, use explore_more. If sizing or fabric details are the next step, use ask_size_or_details.
- Keep assistantSummary to 2–3 sentences maximum.
- Prices should reflect luxury positioning: 6 000–60 000 MAD range.
- image and productUrl may be null.
- Never include markdown, code blocks, or extra commentary outside the JSON.`;

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: ClaudeMessage[];
}

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
}

async function callClaude(userMessage: string): Promise<string> {
  const apiKey = env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error("CLAUDE_API_KEY is not configured.");
  }

  const body: ClaudeRequest = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  };

  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  const block = data.content?.find((b) => b.type === "text");
  if (!block?.text) throw new Error("Empty response from Claude");

  return block.text;
}

shoppingBrainRouter.post("/api/shopping-brain", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (message.length > 1000) {
    res.status(400).json({ error: "message too long (max 1000 characters)" });
    return;
  }

  try {
    const raw = await callClaude(message);

    // strip any accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    // Normalise recommendations to always be an array
    if (!Array.isArray(parsed.recommendations)) {
      parsed.recommendations = [];
    }

    res.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[shopping-brain] error:", message);
    res.status(500).json({ error: "The advisor is momentarily unavailable. Please try again." });
  }
});

// ── POST /api/shopping-brain-checkout (stub for future handoff) ──────────────

shoppingBrainRouter.post("/api/shopping-brain-checkout", (_req, res) => {
  res.status(501).json({ error: "Checkout handoff coming soon." });
});
