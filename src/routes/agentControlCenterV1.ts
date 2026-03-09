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

function resolveAssetsDir(): string | null {
  return firstExistingPath([
    join(process.cwd(), "frontend/mobile-lab-agent-control-center-v1/dist"),
    join(process.cwd(), "dist/frontend/mobile-lab-agent-control-center-v1/dist")
  ]);
}

agentControlCenterV1Router.use("/agent-control-center-v1", (req, res, next) => {
  const assetsDir = resolveAssetsDir();
  if (!assetsDir) {
    next();
    return;
  }

  return express.static(assetsDir, {
    index: false,
    maxAge: "1h",
    etag: true
  })(req, res, next);
});

agentControlCenterV1Router.get("/agent-control-center-v1", (_req, res) => {
  const assetsDir = resolveAssetsDir();
  const assetsLoaded = Boolean(assetsDir);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mobile-Lab Agent Control Center V1</title>
    <meta name="description" content="Mission control interface for AI-powered WhatsApp sales operations." />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet" />

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

    <style type="text/tailwindcss">
      @theme {
        --font-display: "Sora", ui-sans-serif, system-ui, sans-serif;
      }
      @layer base {
        html, body, #root {
          min-height: 100%;
        }
        body {
          margin: 0;
          font-family: var(--font-display);
          background: #07090f;
        }
        * {
          box-sizing: border-box;
        }
      }
    </style>

    <style>
      .scroll-dark {
        scrollbar-width: thin;
        scrollbar-color: #2b3445 #11151f;
      }
      .scroll-dark::-webkit-scrollbar {
        width: 8px;
      }
      .scroll-dark::-webkit-scrollbar-track {
        background: #11151f;
      }
      .scroll-dark::-webkit-scrollbar-thumb {
        background: #2b3445;
        border-radius: 99px;
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

  res.status(200).type("html").send(html);
});
