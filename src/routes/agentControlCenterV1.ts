import express, { Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const agentControlCenterV1Router = Router();

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveAssetsDirs(): string[] {
  const candidates = [
    join(process.cwd(), "frontend/mobile-lab-agent-control-center-v1/dist"),
    join(process.cwd(), "dist/frontend/mobile-lab-agent-control-center-v1/dist")
  ];

  return candidates.filter((candidate) => existsSync(candidate));
}

function resolveAssetsDir(): string | null {
  return firstExistingPath(resolveAssetsDirs());
}

agentControlCenterV1Router.get("/agent-control-center-v1/strategicAdvisorAgentV1.js", (req, res, next) => {
  const assetsDir = resolveAssetsDir();
  if (assetsDir && existsSync(join(assetsDir, "strategicAdvisorAgentV1.js"))) {
    next();
    return;
  }

  const fallbackModule = `const defaultOutput = {
  leadId: "",
  probableStage: "PRODUCT_INTEREST",
  stageConfidence: 0.62,
  momentum: "medium",
  priorityRecommendation: "medium",
  keySignals: ["Limited context available"],
  risks: ["Strategic advisor module fallback in use"],
  opportunities: ["Continue with controlled next-step guidance"],
  missingInformation: [],
  nextBestAction: "reassure_and_progress",
  replyObjective: "Keep response concise while gathering missing context.",
  rationale: "Fallback strategic module served because deployment assets are out of sync.",
  humanApprovalRequired: false
};

export function generateStrategicAdvisorAnalysis(context) {
  const leadId = context?.lead?.id ?? "";
  const currentStage = context?.currentStage ?? context?.lead?.currentStage ?? "PRODUCT_INTEREST";
  const mappedStage = typeof currentStage === "string" ? currentStage : "PRODUCT_INTEREST";
  return { ...defaultOutput, leadId, probableStage: mappedStage };
}

export function generateStrategicAdvisorAnalysisRecord(context) {
  const output = generateStrategicAdvisorAnalysis(context);
  return {
    schemaVersion: "strategic_advisor_v1",
    leadId: output.leadId,
    conversationId: context?.conversation?.id ?? "",
    timestamp: new Date().toISOString(),
    provider: "fallback_strategic_advisor_v1",
    model: "fallback-rule",
    decisionSummary: "Fallback strategic advisor output",
    inputSnapshot: {
      currentStage: output.probableStage,
      priorityScore: Number(context?.priorityScore ?? 0),
      signalCount: Array.isArray(context?.signals) ? context.signals.length : 0,
      missingFields: Array.isArray(context?.missingFields) ? context.missingFields : [],
      openTaskCount: Array.isArray(context?.openTasks) ? context.openTasks.length : 0,
      lastOperatorAction: context?.lastOperatorAction ?? null,
      recentMessageCount: Array.isArray(context?.recentMessages) ? context.recentMessages.length : 0
    },
    output,
    confidenceIndicators: {
      stageConfidence: output.stageConfidence,
      actionConfidence: 0.58
    }
  };
}
`;

  res.status(200).type("application/javascript").send(fallbackModule);
});

agentControlCenterV1Router.use("/agent-control-center-v1", (req, res, next) => {
  const assetsDirs = resolveAssetsDirs();
  if (!assetsDirs.length) {
    next();
    return;
  }

  const staticOptions = {
    index: false,
    maxAge: "1h",
    etag: true
  };

  let currentIndex = 0;
  const serveFromNextDir = (): void => {
    if (currentIndex >= assetsDirs.length) {
      next();
      return;
    }

    const staticMiddleware = express.static(assetsDirs[currentIndex], staticOptions);
    currentIndex += 1;
    staticMiddleware(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }
      serveFromNextDir();
    });
  };

  serveFromNextDir();
});

function renderAgentControlCenterShell(): string {
  const assetsDir = resolveAssetsDir();
  const assetsLoaded = Boolean(assetsDir);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mobile-Lab Agent Control Center V1</title>
    <meta name="description" content="Mission control interface for AI-powered WhatsApp sales operations." />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

    <style type="text/tailwindcss">
      @theme {
        --font-display: "Sora", ui-sans-serif, system-ui, sans-serif;
        --font-mono-display: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      @layer base {
        html, body, #root {
          min-height: 100%;
        }
        body {
          margin: 0;
          font-family: var(--font-display);
          background: #06080d;
          color: #f1f5f9;
          letter-spacing: 0.01em;
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
        }
        * {
          box-sizing: border-box;
        }
      }
    </style>

    <style>
      :root {
        --ml-bg: #06080d;
        --ml-surface: #0c1119;
        --ml-surface-2: #0f1520;
        --ml-surface-3: #121a27;
        --ml-border: rgba(148, 163, 184, 0.18);
        --ml-border-strong: rgba(148, 163, 184, 0.28);
        --ml-text: #f3f6fb;
        --ml-muted: #9aa5b7;
        --ml-soft: #6b778a;
        --ml-accent: #5dd9ff;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: -1;
        background:
          radial-gradient(circle at 14% 18%, rgba(71, 132, 255, 0.14), transparent 34%),
          radial-gradient(circle at 86% 2%, rgba(46, 200, 167, 0.10), transparent 28%),
          linear-gradient(180deg, #05070b 0%, #070b12 46%, #070a10 100%);
      }

      body::after {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: -1;
        opacity: 0.24;
        background-image: linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px);
        background-size: 100% 26px;
      }

      .ml-panel {
        position: relative;
        border: 1px solid var(--ml-border);
        background: linear-gradient(180deg, rgba(18, 24, 35, 0.95) 0%, rgba(12, 17, 26, 0.95) 100%);
        box-shadow:
          0 18px 42px -28px rgba(0, 0, 0, 0.88),
          inset 0 1px 0 rgba(255, 255, 255, 0.035);
      }

      .ml-panel-soft {
        border: 1px solid rgba(148, 163, 184, 0.14);
        background: linear-gradient(180deg, rgba(15, 22, 33, 0.85) 0%, rgba(10, 15, 24, 0.9) 100%);
      }

      .ml-interactive {
        transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
      }

      .ml-interactive:hover {
        border-color: var(--ml-border-strong);
        transform: translateY(-1px);
        box-shadow:
          0 24px 46px -30px rgba(0, 0, 0, 0.95),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }

      .ml-chip {
        border: 1px solid rgba(148, 163, 184, 0.24);
        background: linear-gradient(180deg, rgba(18, 25, 37, 0.9) 0%, rgba(13, 18, 28, 0.9) 100%);
      }

      .ml-button {
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: linear-gradient(180deg, rgba(26, 34, 49, 0.95) 0%, rgba(18, 24, 35, 0.95) 100%);
        color: #d9e3f0;
        transition: border-color 160ms ease, background 160ms ease, transform 160ms ease, color 160ms ease;
      }

      .ml-button:hover {
        border-color: rgba(148, 163, 184, 0.4);
        transform: translateY(-1px);
      }

      .ml-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px rgba(93, 217, 255, 0.34);
      }

      .ml-button-primary {
        border-color: rgba(93, 217, 255, 0.36);
        background: linear-gradient(180deg, rgba(22, 68, 86, 0.42) 0%, rgba(12, 38, 51, 0.5) 100%);
        color: #d7f3ff;
      }

      .ml-button-primary:hover {
        border-color: rgba(93, 217, 255, 0.54);
        background: linear-gradient(180deg, rgba(28, 84, 105, 0.48) 0%, rgba(14, 47, 63, 0.56) 100%);
      }

      .ml-button-danger {
        border-color: rgba(251, 113, 133, 0.34);
        background: linear-gradient(180deg, rgba(91, 28, 43, 0.38) 0%, rgba(63, 20, 33, 0.46) 100%);
        color: #ffd3dc;
      }

      .ml-table-shell {
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: linear-gradient(180deg, rgba(16, 22, 33, 0.9) 0%, rgba(10, 15, 24, 0.92) 100%);
      }

      .ml-table thead {
        background: linear-gradient(180deg, rgba(16, 23, 34, 1) 0%, rgba(13, 18, 28, 1) 100%);
      }

      .ml-table th {
        color: #8e9aaf;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.11em;
        font-weight: 600;
      }

      .ml-table td {
        color: #ced6e2;
      }

      .ml-table tbody tr {
        border-top: 1px solid rgba(148, 163, 184, 0.12);
      }

      .ml-table tbody tr:nth-child(2n) {
        background: rgba(11, 17, 26, 0.28);
      }

      .ml-table tbody tr:hover {
        background: rgba(29, 42, 60, 0.46);
      }

      .scroll-dark {
        scrollbar-width: thin;
        scrollbar-color: #334155 #111827;
      }
      .scroll-dark::-webkit-scrollbar {
        width: 8px;
      }
      .scroll-dark::-webkit-scrollbar-track {
        background: #0e1420;
      }
      .scroll-dark::-webkit-scrollbar-thumb {
        background: #334155;
        border-radius: 99px;
      }

      .ml-code {
        font-family: var(--font-mono-display);
      }
    </style>
  </head>

  <body>
    <div id="root">${
      assetsLoaded
        ? ""
        : `<div style="padding:24px;font-family:Sora,system-ui,sans-serif;color:#e4e4e7;background:#07090f;min-height:100vh;">
             Agent Control Center assets are missing. Build frontend/mobile-lab-agent-control-center-v1 before loading this route.
           </div>`
    }</div>

    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19.2.4",
          "react/jsx-runtime": "https://esm.sh/react@19.2.4/jsx-runtime",
          "react-dom/client": "https://esm.sh/react-dom@19.2.4/client",
          "framer-motion": "https://esm.sh/framer-motion@12.34.3?bundle"
        }
      }
    </script>

    ${assetsLoaded ? '<script type="module" src="/agent-control-center-v1/main.js"></script>' : ""}
  </body>
</html>`;
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.[a-z0-9]+$/i.test(pathname);
}

agentControlCenterV1Router.get(["/agent-control-center-v1", "/agent-control-center-v1/*"], (req, res, next) => {
  if (isStaticAssetPath(req.path)) {
    next();
    return;
  }

  const html = renderAgentControlCenterShell();

  res.status(200).type("html").send(html);
});
