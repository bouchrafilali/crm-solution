import { Router } from "express";
import { z } from "zod";
import { runWhatsAppLabSimulation } from "../services/whatsappLabSimulation.js";
import { listStageRules } from "../db/whatsappIntelligenceSettingsRepo.js";

export const whatsappLabRouter = Router();

const runSimulationSchema = z.object({
  messages: z.array(
    z.object({
      direction: z.enum(["IN", "OUT"]),
      text: z.string(),
      created_at: z.string().optional()
    })
  ),
  mode: z.enum(["basic", "strict"]).optional(),
  language: z.enum(["FR", "EN"]).optional()
});

type LogicDiagramConfigResponse = {
  updated_at: string;
  signals: string[];
  qualification_logic: {
    condition: string;
    when_true: string;
    when_false: string;
  };
  main_progression: Array<{ from: string; to: string; note: string }>;
  hard_rules: Array<{ rule: string; effect: string }>;
  suggestion_mapping: Array<{ stage: string; suggestion_type: string; note: string }>;
  configured_stage_rules: Array<{
    rule_name: string;
    required_tags: string[];
    forbidden_tags: string[];
    recommended_stage: string;
    priority: number;
    enabled: boolean;
  }>;
};

whatsappLabRouter.get("/api/whatsapp-logic-diagram/config", async (_req, res) => {
  try {
    let configuredStageRules: Awaited<ReturnType<typeof listStageRules>> = [];
    try {
      configuredStageRules = await Promise.race([
        listStageRules(),
        new Promise<Awaited<ReturnType<typeof listStageRules>>>((resolve) => {
          setTimeout(() => resolve([]), 2500);
        })
      ]);
    } catch (error) {
      console.warn("[whatsapp-logic-diagram] stage rules unavailable, fallback config", error);
    }
    const payload: LogicDiagramConfigResponse = {
      updated_at: new Date().toISOString(),
      signals: [
        "product_interest",
        "event_date",
        "destination",
        "price_sent",
        "video_proposed",
        "payment_question",
        "deposit_link_sent",
        "chat_confirmed",
        "price_intent",
        "video_intent",
        "payment_intent",
        "deposit_intent",
        "confirmation_intent"
      ],
      qualification_logic: {
        condition: "missing_event_date",
        when_true: "QUALIFICATION_PENDING",
        when_false: "QUALIFIED"
      },
      main_progression: [
        { from: "NEW", to: "QUALIFICATION_PENDING", note: "Initial discovery / qualification kickoff" },
        { from: "QUALIFICATION_PENDING", to: "QUALIFIED", note: "Event date present (destination optional)" },
        { from: "QUALIFIED", to: "PRICE_SENT", note: "Price shared in outbound or manually marked as sent" },
        { from: "PRICE_SENT", to: "DEPOSIT_PENDING", note: "Payment intent or deposit step detected" },
        { from: "DEPOSIT_PENDING", to: "CONFIRMED", note: "Deposit paid or Shopify partially_paid/paid" },
        { from: "CONFIRMED", to: "CONVERTED", note: "Full payment validated only (Shopify paid/payment received)" }
      ],
      hard_rules: [
        {
          rule: "shopify_financial_status = 'paid' OR payment_received = true",
          effect: "Force stage = CONVERTED"
        },
        {
          rule: "shopify_financial_status = 'partially_paid' OR deposit_paid = true",
          effect: "Set stage >= CONFIRMED (not CONVERTED)"
        }
      ],
      suggestion_mapping: [
        { stage: "NEW", suggestion_type: "QUALIFICATION", note: "Start with key qualification fields" },
        { stage: "QUALIFICATION_PENDING", suggestion_type: "QUALIFICATION", note: "Ask only missing fields" },
        { stage: "QUALIFIED", suggestion_type: "PRICE_CONTEXTUALIZED", note: "Share contextualized price + timeline + optional video" },
        { stage: "PRICE_SENT", suggestion_type: "FOLLOW_UP", note: "Video-slot follow-up or elegant 48h reactivation" },
        { stage: "DEPOSIT_PENDING", suggestion_type: "DEPOSIT_STEP", note: "Move to deposit link / payment step" },
        { stage: "CONFIRMED", suggestion_type: "CONFIRMATION_STEP", note: "Final confirmation and conversion prep" },
        { stage: "CONVERTED", suggestion_type: "FOLLOW_UP", note: "Post-conversion operational follow-up" }
      ],
      configured_stage_rules: configuredStageRules.map((row) => ({
        rule_name: row.rule_name,
        required_tags: row.required_tags || [],
        forbidden_tags: row.forbidden_tags || [],
        recommended_stage: row.recommended_stage,
        priority: Number(row.priority || 100),
        enabled: Boolean(row.enabled)
      }))
    };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[whatsapp-logic-diagram] config failed", error);
    return res.status(200).json({
      updated_at: new Date().toISOString(),
      signals: [
        "product_interest",
        "event_date",
        "destination",
        "price_sent",
        "video_proposed",
        "payment_question",
        "deposit_link_sent",
        "chat_confirmed",
        "price_intent",
        "video_intent",
        "payment_intent",
        "deposit_intent",
        "confirmation_intent"
      ],
      qualification_logic: {
        condition: "missing_event_date",
        when_true: "QUALIFICATION_PENDING",
        when_false: "QUALIFIED"
      },
      main_progression: [
        { from: "NEW", to: "QUALIFICATION_PENDING", note: "Initial discovery / qualification kickoff" },
        { from: "QUALIFICATION_PENDING", to: "QUALIFIED", note: "Event date present (destination optional)" },
        { from: "QUALIFIED", to: "PRICE_SENT", note: "Price shared in outbound or manually marked as sent" },
        { from: "PRICE_SENT", to: "DEPOSIT_PENDING", note: "Payment intent or deposit step detected" },
        { from: "DEPOSIT_PENDING", to: "CONFIRMED", note: "Deposit paid or Shopify partially_paid/paid" },
        { from: "CONFIRMED", to: "CONVERTED", note: "Full payment validated only (Shopify paid/payment received)" }
      ],
      hard_rules: [
        { rule: "shopify_financial_status = 'paid' OR payment_received = true", effect: "CONVERTED" },
        { rule: "shopify_financial_status = 'partially_paid' OR deposit_paid = true", effect: "CONFIRMED" }
      ],
      suggestion_mapping: [
        { stage: "NEW", suggestion_type: "QUALIFICATION", note: "Start with key qualification fields" },
        { stage: "QUALIFICATION_PENDING", suggestion_type: "QUALIFICATION", note: "Ask only missing fields" },
        { stage: "QUALIFIED", suggestion_type: "PRICE_CONTEXTUALIZED", note: "Share contextualized price + timeline + optional video" },
        { stage: "PRICE_SENT", suggestion_type: "FOLLOW_UP", note: "Video-slot follow-up or elegant 48h reactivation" },
        { stage: "DEPOSIT_PENDING", suggestion_type: "DEPOSIT_STEP", note: "Move to deposit link / payment step" },
        { stage: "CONFIRMED", suggestion_type: "CONFIRMATION_STEP", note: "Final confirmation and conversion prep" },
        { stage: "CONVERTED", suggestion_type: "FOLLOW_UP", note: "Post-conversion operational follow-up" }
      ],
      configured_stage_rules: []
    });
  }
});

whatsappLabRouter.get("/whatsapp-lab", (_req, res) => {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WhatsApp Classification Lab</title>
    <style>
      :root {
        --bg: #0a1220;
        --panel: #0e1a2e;
        --line: #2b3d5a;
        --text: #e5eefc;
        --muted: #9db0cf;
        --accent: #2eb67d;
        --chip: #122540;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: radial-gradient(circle at 20% 0%, #12233f, var(--bg)); color: var(--text); }
      .wrap { max-width: 1280px; margin: 0 auto; padding: 18px; }
      h1 { margin: 0 0 14px; font-size: 22px; }
      .grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
      .row { display: flex; gap: 8px; align-items: center; }
      .row.wrap { flex-wrap: wrap; }
      button, select, textarea {
        border: 1px solid var(--line);
        border-radius: 9px;
        background: #0c172a;
        color: var(--text);
      }
      button { padding: 8px 10px; cursor: pointer; }
      button.primary { background: var(--accent); color: #062114; border-color: #4bda9d; font-weight: 700; }
      textarea { width: 100%; min-height: 58px; resize: vertical; padding: 8px; }
      .msg { border: 1px solid var(--line); border-radius: 10px; padding: 8px; margin-top: 8px; background: #0b1628; }
      .msg .meta { display: grid; grid-template-columns: 110px 1fr 84px; gap: 8px; margin-bottom: 6px; }
      .muted { color: var(--muted); font-size: 12px; }
      .chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
      .chip { background: var(--chip); border: 1px solid #36517a; border-radius: 999px; padding: 4px 9px; font-size: 12px; }
      .badge { display: inline-block; border-radius: 999px; padding: 8px 12px; border: 1px solid #5e84c1; background: #142846; font-weight: 700; margin-top: 6px; }
      pre { white-space: pre-wrap; margin: 8px 0 0; background: #0a1425; border: 1px solid var(--line); border-radius: 10px; padding: 10px; color: #d6e4ff; }
      .scenario { width: 100%; margin-top: 8px; }
      @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } .msg .meta { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>WhatsApp Classification Lab</h1>
      <div class="grid">
        <section class="panel">
          <div class="row wrap">
            <button id="addMsg">Add message</button>
            <button id="run" class="primary">Run Classification</button>
            <button id="reset">Reset Conversation</button>
            <select id="scenario">
              <option value="">Load Test Scenario</option>
              <option value="A">A · intérêt produit → qualif → prix → confirmé</option>
              <option value="B">B · intérêt produit + prix direct</option>
              <option value="C">C · prix + silence 48h</option>
              <option value="D">D · question paiement</option>
              <option value="E">E · confirmation + Shopify paid</option>
            </select>
            <select id="mode">
              <option value="basic">Basic gating mode</option>
              <option value="strict">Strict gating mode</option>
            </select>
            <select id="lang">
              <option value="FR">FR simulation</option>
              <option value="EN">EN simulation</option>
            </select>
          </div>
          <div id="messages"></div>
        </section>
        <section class="panel">
          <h3 style="margin:2px 0 8px;">Results</h3>
          <div id="signals"></div>
          <div id="qualification" style="margin-top:10px;"></div>
          <div id="stage" style="margin-top:10px;"></div>
          <div id="suggestion" style="margin-top:10px;"></div>
          <pre id="raw"></pre>
        </section>
      </div>
    </div>
    <script>
      const elMessages = document.getElementById("messages");
      const elSignals = document.getElementById("signals");
      const elQualification = document.getElementById("qualification");
      const elStage = document.getElementById("stage");
      const elSuggestion = document.getElementById("suggestion");
      const elRaw = document.getElementById("raw");
      const elMode = document.getElementById("mode");
      const elLang = document.getElementById("lang");

      const scenarios = {
        "A": [
          { direction: "IN", text: "https://maison.com/products/caftan-nour" },
          { direction: "OUT", text: "Quelle date souhaitez-vous ?" },
          { direction: "IN", text: "6 août, Paris" },
          { direction: "OUT", text: "Parfait, nous sommes dans les délais. Le prix est de 40 000 DHS avec un délai de confection de 3 semaines. Si vous le souhaitez, nous pouvons faire une courte visio privée." },
          { direction: "IN", text: "Je confirme la commande." }
        ],
        "B": [
          { direction: "IN", text: "Hi, I am interested in this article kaftan." },
          { direction: "OUT", text: "Le prix est de 28 000 DHS, avec confection en 2 semaines." }
        ],
        "C": [
          { direction: "IN", text: "6 août, Casablanca" },
          { direction: "OUT", text: "Le prix est de 30 000 DHS avec un délai de 3 semaines." }
        ],
        "D": [
          { direction: "IN", text: "6 août, Rabat" },
          { direction: "OUT", text: "Le prix est de 32 000 DHS." },
          { direction: "IN", text: "Comment je peux payer l’acompte ?" }
        ],
        "E": [
          { direction: "IN", text: "6 août, Paris" },
          { direction: "OUT", text: "Le prix est de 36 000 DHS avec délai 3 semaines." },
          { direction: "IN", text: "C’est confirmé." }
        ]
      };

      function nowIso(offset = 0) {
        return new Date(Date.now() + offset * 1000).toISOString();
      }

      function row(data = { direction: "IN", text: "", created_at: nowIso() }) {
        const div = document.createElement("div");
        div.className = "msg";
        div.innerHTML = \`
          <div class="meta">
            <select data-direction>
              <option value="IN"\${data.direction === "IN" ? " selected" : ""}>IN</option>
              <option value="OUT"\${data.direction === "OUT" ? " selected" : ""}>OUT</option>
            </select>
            <input data-ts type="datetime-local" style="border:1px solid var(--line);border-radius:9px;background:#0c172a;color:var(--text);padding:8px;" />
            <button data-del>Delete</button>
          </div>
          <textarea data-text placeholder="Message text"></textarea>
        \`;
        const tsInput = div.querySelector("[data-ts]");
        const text = div.querySelector("[data-text]");
        const del = div.querySelector("[data-del]");
        const ts = new Date(data.created_at || nowIso()).toISOString().slice(0, 16);
        tsInput.value = ts;
        text.value = data.text || "";
        del.addEventListener("click", () => div.remove());
        return div;
      }

      function addMessage(data) {
        elMessages.appendChild(row(data));
      }

      function collectMessages() {
        return Array.from(elMessages.querySelectorAll(".msg")).map((node) => ({
          direction: node.querySelector("[data-direction]").value,
          text: node.querySelector("[data-text]").value,
          created_at: new Date(node.querySelector("[data-ts]").value).toISOString()
        })).filter((m) => (m.text || "").trim().length > 0);
      }

      function render(data) {
        const s = data.signals || {};
        const q = data.qualification || {};
        const st = data.stage || {};
        const sug = data.suggestion || {};
        const chips = [];
        if (s.product_interest) chips.push("Produit");
        if (s.price_sent) chips.push("Prix envoyé");
        if (s.video_proposed) chips.push("Visio proposée");
        if (s.payment_question) chips.push("Paiement demandé");
        if (s.deposit_link_sent) chips.push("Acompte envoyé");
        if (s.chat_confirmed) chips.push("Confirmé");
        elSignals.innerHTML = "<div><strong>Signals detected</strong></div>" +
          (chips.length ? "<div class='chips'>" + chips.map((c) => "<span class='chip'>" + c + "</span>").join("") + "</div>" : "<div class='muted'>No signal detected.</div>");
        elQualification.innerHTML =
          "<div><strong>Qualification Status</strong></div>" +
          "<div class='muted'>Event date detected: " + (q.event_date || "-") + "</div>" +
          "<div class='muted'>Destination detected: " +
            ((q.destination && typeof q.destination === "object")
              ? ([q.destination.city || "-", q.destination.country || "-"].join(", "))
              : (q.destination || "-")) +
          "</div>" +
          "<div class='muted'>Complete: " + (q.complete ? "YES" : "NO") + "</div>" +
          "<div class='muted'>Missing: " + ((q.missing || []).join(", ") || "-") + "</div>";
        elStage.innerHTML =
          "<div><strong>Main Stage</strong></div>" +
          "<div class='badge'>" + (st.main || "-") + "</div>" +
          "<div class='muted'>Reasoning: " + (st.reasoning || "-") + "</div>" +
          "<div class='muted'>Confidence: " + (st.confidence != null ? st.confidence + "%" : "-") + "</div>";
        elSuggestion.innerHTML =
          "<div><strong>Suggested Reply</strong></div>" +
          "<div class='muted'>Type: " + (sug.type || "-") + "</div>" +
          "<pre>" + (sug.text || "") + "</pre>" +
          "<div class='muted'>Reasoning: " + (sug.reasoning || "-") + "</div>" +
          "<div class='muted'>Confidence: " + (sug.confidence != null ? sug.confidence + "%" : "-") + "</div>";
        elRaw.textContent = JSON.stringify(data, null, 2);
      }

      async function run() {
        const payload = {
          messages: collectMessages(),
          mode: elMode.value,
          language: elLang.value
        };
        const res = await fetch("/api/whatsapp-lab/run-simulation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error || "simulation_failed");
        render(data);
      }

      document.getElementById("addMsg").addEventListener("click", () => addMessage({ direction: "IN", text: "", created_at: nowIso() }));
      document.getElementById("reset").addEventListener("click", () => {
        elMessages.innerHTML = "";
        addMessage({ direction: "IN", text: "", created_at: nowIso() });
      });
      document.getElementById("run").addEventListener("click", async () => {
        try { await run(); } catch (e) { alert(e.message || "simulation failed"); }
      });
      document.getElementById("scenario").addEventListener("change", (e) => {
        const key = e.target.value;
        if (!key || !scenarios[key]) return;
        elMessages.innerHTML = "";
        scenarios[key].forEach((msg, i) => addMessage({ ...msg, created_at: nowIso(i) }));
      });

      addMessage({ direction: "IN", text: "https://maison.com/products/test-piece", created_at: nowIso() });
    </script>
  </body>
</html>`;

  res.status(200).type("html").send(html);
});

whatsappLabRouter.get("/whatsapp-logic-diagram", (_req, res) => {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WhatsApp Intelligence Logic Diagram</title>
    <style>
      :root {
        --bg: #061121;
        --panel: #0b1a31;
        --line: #214163;
        --text: #e6efff;
        --muted: #97accd;
        --accent: #43c38b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--text);
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
        background: radial-gradient(1400px 560px at 12% -5%, #17365d 0%, var(--bg) 56%);
      }
      .wrap { max-width: 1540px; margin: 0 auto; padding: 22px 16px 28px; }
      h1 { margin: 0; font-size: 34px; letter-spacing: 0.3px; }
      .sub { margin-top: 6px; color: var(--muted); }
      .panel {
        margin-top: 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: linear-gradient(180deg, rgba(10,27,50,.92) 0%, rgba(9,20,38,.95) 100%);
        padding: 10px 10px 14px;
      }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 2px 4px 10px; flex-wrap: wrap; }
      .meta { color: var(--muted); font-size: 13px; }
      .btn {
        border: 1px solid #2d557d;
        border-radius: 999px;
        background: #0f2440;
        color: var(--text);
        padding: 8px 12px;
        cursor: pointer;
      }
      .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .controls select, .controls button, .controls input, .tool-grid textarea {
        border:1px solid #2d557d; border-radius:999px; background:#0f2440; color:var(--text); padding:8px 12px;
      }
      .controls input { min-width: 240px; border-radius: 10px; }
      .canvas-wrap {
        position: relative;
        min-height: 760px;
        border-radius: 12px;
        border: 1px solid #28486b;
        overflow: hidden;
        background:
          radial-gradient(circle at 1px 1px, rgba(132,168,216,.22) 1px, transparent 0) 0 0/22px 22px,
          linear-gradient(180deg, rgba(10,26,48,.95) 0%, rgba(7,18,34,.96) 100%);
      }
      #diagram {
        width: 100%;
        height: 760px;
      }
      #minimap {
        position: absolute;
        right: 12px;
        bottom: 12px;
        width: 240px;
        height: 160px;
        border: 1px solid #385b84;
        border-radius: 10px;
        background: rgba(8, 18, 34, .92);
      }
      #minimapViewport {
        position: absolute;
        border: 1px solid rgba(84, 226, 160, .85);
        background: rgba(84, 226, 160, .12);
        pointer-events: none;
      }
      .legend {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 8px;
      }
      .legend-card {
        border: 1px solid #234264;
        border-radius: 10px;
        background: rgba(11, 25, 47, 0.74);
        padding: 10px 11px;
      }
      .legend-card strong { display: block; margin-bottom: 4px; }
      .legend-card .note { color: var(--muted); font-size: 13px; line-height: 1.35; }
      .tool-grid {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 10px;
      }
      .tool-card {
        border: 1px solid #244667;
        border-radius: 10px;
        background: rgba(9, 21, 40, .75);
        padding: 10px;
      }
      .tool-card h3 { margin: 0 0 8px; font-size: 15px; }
      .tool-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .tool-row input, .tool-row select, .tool-row button { border-radius: 10px; }
      .tool-grid textarea {
        width: 100%;
        min-height: 82px;
        border-radius: 10px;
        padding: 10px;
        resize: vertical;
      }
      .kv { font-size: 13px; color: var(--muted); line-height: 1.45; white-space: pre-wrap; margin-top: 8px; }
      .error {
        margin: 14px 0 0;
        border: 1px solid #6c2b3b;
        background: rgba(84, 22, 35, 0.28);
        color: #ffdce4;
        border-radius: 10px;
        padding: 10px;
        display: none;
      }
      @media (max-width: 940px) {
        h1 { font-size: 26px; }
        #diagram { height: 620px; }
        .canvas-wrap { min-height: 620px; }
        #minimap { width: 170px; height: 118px; }
      }
    </style>
    <link rel="stylesheet" href="https://unpkg.com/cytoscape-navigator/cytoscape.js-navigator.css" />
    <script src="https://unpkg.com/cytoscape/dist/cytoscape.min.js"></script>
    <script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"></script>
    <script src="https://unpkg.com/cytoscape-dagre/cytoscape-dagre.js"></script>
    <script src="https://unpkg.com/cytoscape-navigator/cytoscape-navigator.js"></script>
  </head>
  <body>
    <div class="wrap">
      <h1>WhatsApp Intelligence Logic Diagram</h1>
      <div class="sub">Signal detection, qualification gating, monotonic stage progression, and suggestion decision tree.</div>
      <section class="panel">
        <div class="row">
          <div id="meta" class="meta">Loading configuration...</div>
          <div class="controls">
            <select id="focusStage">
              <option value="ALL">Focus: ALL</option>
              <option>NEW</option>
              <option>QUALIFICATION_PENDING</option>
              <option>QUALIFIED</option>
              <option>PRICE_SENT</option>
              <option>VIDEO_PROPOSED</option>
              <option>DEPOSIT_PENDING</option>
              <option>CONFIRMED</option>
              <option>CONVERTED</option>
              <option>LOST</option>
            </select>
            <input id="leadIdInput" type="text" placeholder="Lead ID (optional)" />
            <button id="loadLeadBtn" class="btn" type="button">Load Lead</button>
            <button id="zoomInBtn" class="btn" type="button">Zoom +</button>
            <button id="zoomOutBtn" class="btn" type="button">Zoom -</button>
            <button id="fitBtn" class="btn" type="button">Fit</button>
            <button id="resetBtn" class="btn" type="button">Reset</button>
            <button id="autoLayoutBtn" class="btn" type="button">Auto layout</button>
            <button id="reflowBtn" class="btn" type="button">Reflow</button>
            <button id="refreshBtn" class="btn" type="button">Refresh</button>
          </div>
        </div>
        <div class="canvas-wrap">
          <div id="diagram"></div>
          <div id="minimap"></div>
          <div id="minimapViewport"></div>
        </div>
        <div id="error" class="error"></div>
        <section class="tool-grid">
          <article class="tool-card">
            <h3>Current Lead Overlay</h3>
            <div id="leadOverlay" class="kv">No lead loaded.</div>
          </article>
          <article class="tool-card">
            <h3>What-if Simulator</h3>
            <div class="tool-row">
              <select id="whatIfDirection">
                <option value="IN">IN</option>
                <option value="OUT">OUT</option>
              </select>
              <button id="whatIfRunBtn" class="btn" type="button">Preview next step</button>
            </div>
            <textarea id="whatIfText" placeholder="Type a new message to test impact on stage/flags..."></textarea>
            <div id="whatIfResult" class="kv">No preview yet.</div>
          </article>
        </section>
      </section>
      <section class="legend" id="legend"></section>
    </div>
    <script>
      const metaEl = document.getElementById("meta");
      const diagramEl = document.getElementById("diagram");
      const minimapEl = document.getElementById("minimap");
      const minimapViewportEl = document.getElementById("minimapViewport");
      const errorEl = document.getElementById("error");
      const legendEl = document.getElementById("legend");
      const focusStageEl = document.getElementById("focusStage");
      const zoomInBtn = document.getElementById("zoomInBtn");
      const zoomOutBtn = document.getElementById("zoomOutBtn");
      const fitBtn = document.getElementById("fitBtn");
      const resetBtn = document.getElementById("resetBtn");
      const autoLayoutBtn = document.getElementById("autoLayoutBtn");
      const reflowBtn = document.getElementById("reflowBtn");
      const refreshBtn = document.getElementById("refreshBtn");
      const leadIdInput = document.getElementById("leadIdInput");
      const loadLeadBtn = document.getElementById("loadLeadBtn");
      const leadOverlayEl = document.getElementById("leadOverlay");
      const whatIfDirectionEl = document.getElementById("whatIfDirection");
      const whatIfTextEl = document.getElementById("whatIfText");
      const whatIfRunBtn = document.getElementById("whatIfRunBtn");
      const whatIfResultEl = document.getElementById("whatIfResult");
      let cy = null;
      let miniCy = null;
      let lastConfig = null;
      let loadedLead = null;
      let loadedLeadMessages = [];

      function esc(v) {
        return String(v || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\\"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function fmtDate(iso) {
        const d = new Date(String(iso || ""));
        if (Number.isNaN(d.getTime())) return "-";
        return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
      }

      function sanitizeLabel(value) {
        return String(value || "").replace(/\\s+/g, " ").trim();
      }

      function collectStageSet(value) {
        const out = String(value || "").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean);
        return Array.from(new Set(out));
      }

      function buildGraph(config) {
        const nodes = [];
        const edges = [];

        function pushNode(id, label, section, stages, kind) {
          nodes.push({
            data: {
              id,
              label: sanitizeLabel(label),
              section,
              stages: Array.isArray(stages) ? stages : [],
              kind: kind || "default"
            }
          });
        }

        function pushEdge(id, source, target, label, stages) {
          edges.push({
            data: {
              id,
              source,
              target,
              label: sanitizeLabel(label),
              stages: Array.isArray(stages) ? stages : []
            }
          });
        }

        // Section headers as lanes
        ["INPUTS","SIGNALS","GATE","STAGES","SUGGESTIONS"].forEach((lane) => {
          pushNode("lane_" + lane, lane, lane, [], "lane");
        });

        // A) Inputs
        (config.signals || []).forEach((signal, i) => {
          const sid = "sig_" + i;
          const normalizedSignal = String(signal || "").toLowerCase();
          const stages =
            normalizedSignal === "price_intent"
              ? ["QUALIFICATION_PENDING", "QUALIFIED", "PRICE_SENT"]
              : normalizedSignal === "payment_intent" || normalizedSignal === "deposit_intent"
                ? ["DEPOSIT_PENDING"]
                : normalizedSignal === "confirmation_intent"
                  ? ["CONFIRMED"]
                  : [];
          pushNode(sid, signal, "INPUTS", stages, "signal");
          pushEdge("edge_input_" + i, sid, "signal_norm", "", []);
        });

        // B) Signal Detection
        pushNode("signal_norm", "Signals normalized (IN/OUT + patterns)", "SIGNALS", [], "detector");

        // C) Qualification gate
        pushNode("gate_decision", "missing_event_date ?", "GATE", [], "decision");
        pushNode("stage_QUALIFICATION_PENDING", "QUALIFICATION_PENDING", "STAGES", ["QUALIFICATION_PENDING"], "stage");
        pushNode("stage_QUALIFIED", "QUALIFIED", "STAGES", ["QUALIFIED"], "stage");
        pushEdge("edge_norm_gate", "signal_norm", "gate_decision", "", []);
        pushEdge("edge_gate_yes", "gate_decision", "stage_QUALIFICATION_PENDING", "YES", ["QUALIFICATION_PENDING"]);
        pushEdge("edge_gate_no", "gate_decision", "stage_QUALIFIED", "NO", ["QUALIFIED"]);

        // D) Stage progression
        const seenStages = new Set(["QUALIFICATION_PENDING","QUALIFIED"]);
        (config.main_progression || []).forEach((tr, i) => {
          const from = String(tr.from || "").toUpperCase();
          const to = String(tr.to || "").toUpperCase();
          if (!from || !to) return;
          if (!seenStages.has(from)) {
            pushNode("stage_" + from, from, "STAGES", [from], "stage");
            seenStages.add(from);
          }
          if (!seenStages.has(to)) {
            pushNode("stage_" + to, to, "STAGES", [to], "stage");
            seenStages.add(to);
          }
          pushEdge("edge_stage_" + i, "stage_" + from, "stage_" + to, String(tr.note || ""), [to]);
        });

        // hard conversion rule
        (config.hard_rules || []).forEach((hr, i) => {
          const id = "hard_" + i;
          pushNode(id, String(hr.rule || "Hard rule"), "STAGES", ["CONVERTED"], "hard");
          pushEdge("edge_hard_" + i, id, "stage_CONVERTED", String(hr.effect || "CONVERTED"), ["CONVERTED"]);
        });

        // E) suggestion mapping
        (config.suggestion_mapping || []).forEach((sm, i) => {
          const stage = String(sm.stage || "").toUpperCase();
          const sid = "suggest_" + i;
          pushNode(sid, String(sm.suggestion_type || "SUGGESTION") + "\\n" + String(sm.note || ""), "SUGGESTIONS", [stage], "suggestion");
          if (!seenStages.has(stage)) {
            pushNode("stage_" + stage, stage, "STAGES", [stage], "stage");
            seenStages.add(stage);
          }
          pushEdge("edge_suggest_" + i, "stage_" + stage, sid, "", [stage]);
        });

        return { nodes, edges };
      }

      function applyLayout() {
        if (!cy) return;
        cy.layout({
          name: "dagre",
          rankDir: "TB",
          nodeSep: 70,
          edgeSep: 35,
          rankSep: 90,
          fit: false,
          animate: false
        }).run();
      }

      function fitView() {
        if (!cy) return;
        cy.fit(undefined, 40);
      }

      function syncMinimapViewport() {
        if (!cy || !miniCy || !minimapViewportEl) return;
        const ext = cy.extent();
        const miniExt = miniCy.extent();
        const box = minimapEl.getBoundingClientRect();
        const w = Math.max(1, miniExt.w || 1);
        const h = Math.max(1, miniExt.h || 1);
        const xRatio = box.width / w;
        const yRatio = box.height / h;
        const vx = (ext.x1 - miniExt.x1) * xRatio;
        const vy = (ext.y1 - miniExt.y1) * yRatio;
        const vw = ext.w * xRatio;
        const vh = ext.h * yRatio;
        minimapViewportEl.style.left = (box.left + vx - minimapEl.parentElement.getBoundingClientRect().left) + "px";
        minimapViewportEl.style.top = (box.top + vy - minimapEl.parentElement.getBoundingClientRect().top) + "px";
        minimapViewportEl.style.width = Math.max(18, vw) + "px";
        minimapViewportEl.style.height = Math.max(14, vh) + "px";
      }

      function applyFocusStage(stage) {
        if (!cy) return;
        const target = String(stage || "ALL").toUpperCase();
        cy.elements().removeClass("dimmed focused");
        if (target === "ALL") return;
        const focusedNodeIds = new Set();
        cy.elements().forEach((el) => {
          const stages = collectStageSet((el.data("stages") || []).join ? (el.data("stages") || []).join(",") : el.data("stages"));
          const hit = stages.includes(target);
          if (hit) {
            el.addClass("focused");
            if (el.isNode && el.isNode()) focusedNodeIds.add(el.id());
          }
          else el.addClass("dimmed");
        });
        cy.edges().forEach((edge) => {
          const connectFocused = focusedNodeIds.has(edge.source().id()) || focusedNodeIds.has(edge.target().id());
          if (connectFocused) {
            edge.removeClass("dimmed");
            edge.addClass("focused");
            edge.source().removeClass("dimmed").addClass("focused");
            edge.target().removeClass("dimmed").addClass("focused");
          }
        });
      }

      function initGraph(config) {
        const graph = buildGraph(config);
        if (cy) cy.destroy();
        if (miniCy) miniCy.destroy();

        cy = cytoscape({
          container: diagramEl,
          elements: [...graph.nodes, ...graph.edges],
          style: [
            { selector: "node", style: {
              "background-color": "#1a3a60",
              "border-color": "#7db1ef",
              "border-width": 1.3,
              "shape": "round-rectangle",
              "width": "label",
              "height": "label",
              "padding": "10px",
              "label": "data(label)",
              "color": "#ecf4ff",
              "font-size": 11,
              "text-wrap": "wrap",
              "text-max-width": 180,
              "text-valign": "center",
              "text-halign": "center"
            }},
            { selector: "node[kind='signal']", style: { "background-color": "#153358", "border-color": "#67a2de" }},
            { selector: "node[kind='detector']", style: { "background-color": "#1d416d", "border-color": "#8ec1ff" }},
            { selector: "node[kind='decision']", style: { "shape": "diamond", "background-color": "#2a2446", "border-color": "#b5a0f1", "text-max-width": 210 }},
            { selector: "node[kind='stage']", style: { "background-color": "#18406b", "border-color": "#94c2ff", "font-size": 12 }},
            { selector: "node[kind='hard']", style: { "background-color": "#3f2130", "border-color": "#ff9db0", "text-max-width": 260 }},
            { selector: "node[kind='suggestion']", style: { "background-color": "#263150", "border-color": "#9aabd7", "text-max-width": 220 }},
            { selector: "node[kind='lane']", style: { "display": "none" }},
            { selector: "edge", style: {
              "curve-style": "bezier",
              "line-color": "#6d8fb8",
              "target-arrow-color": "#6d8fb8",
              "target-arrow-shape": "triangle",
              "arrow-scale": 0.9,
              "width": 1.2,
              "label": "data(label)",
              "font-size": 10,
              "color": "#b7cae7",
              "text-background-opacity": 0.6,
              "text-background-color": "#0c203a",
              "text-background-padding": 2
            }},
            { selector: ".dimmed", style: { "opacity": 0.14 }},
            { selector: ".focused", style: { "opacity": 1, "border-width": 2.3, "line-color": "#55e2a0", "target-arrow-color": "#55e2a0" }}
          ],
          minZoom: 0.2,
          maxZoom: 2.4,
          wheelSensitivity: 0.17
        });

        applyLayout();
        fitView();

        // mini map graph
        miniCy = cytoscape({
          container: minimapEl,
          elements: [...graph.nodes, ...graph.edges],
          style: [
            { selector: "node", style: { "background-color": "#43658d", "width": 7, "height": 7, "label": "" }},
            { selector: "edge", style: { "line-color": "#56789e", "width": 0.8, "target-arrow-shape": "none" }},
            { selector: "node[kind='lane']", style: { "display": "none" }}
          ],
          userZoomingEnabled: false,
          userPanningEnabled: false,
          boxSelectionEnabled: false,
          autoungrabify: true
        });
        miniCy.layout({
          name: "dagre",
          rankDir: "TB",
          nodeSep: 28,
          rankSep: 36,
          fit: true,
          animate: false
        }).run();
        miniCy.fit(undefined, 8);
        syncMinimapViewport();
        cy.on("pan zoom resize", syncMinimapViewport);
      }

      function renderLegend(config) {
        const safe = (value) =>
          String(value || "")
            .replace(/[\\[\\]{}()<>|]/g, " ")
            .replace(/[!]/g, " not ")
            .replace(/[+]/g, " and ")
            .replace(/"/g, "'")
            .replace(/\\s+/g, " ")
            .trim();

        const transitions = (config.main_progression || [])
          .map((x) => "<div class='note'>" + esc(x.from) + " → " + esc(x.to) + ": " + esc(x.note || "-") + "</div>")
          .join("");
        const suggestions = (config.suggestion_mapping || [])
          .map((x) => "<div class='note'><strong>" + esc(x.stage) + "</strong> → " + esc(x.suggestion_type) + " · " + esc(x.note || "-") + "</div>")
          .join("");
        const intents = [
          "price_intent: commercial interest only (does not move stage to PRICE_SENT)",
          "video_intent: soft signal for suggestion quality",
          "payment_intent/deposit_intent: can move to DEPOSIT_PENDING",
          "confirmation_intent: increases score and follow-up priority"
        ]
          .map((x) => "<div class='note'>" + esc(x) + "</div>")
          .join("");
        legendEl.innerHTML =
          "<article class='legend-card'><strong>Qualification Gate</strong><div class='note'>IF " + esc(config.qualification_logic?.condition || "missing_event_date") + " => " + esc(config.qualification_logic?.when_true || "QUALIFICATION_PENDING") + ", else " + esc(config.qualification_logic?.when_false || "QUALIFIED") + ".</div></article>" +
          "<article class='legend-card'><strong>Intent Flags</strong>" + intents + "</article>" +
          "<article class='legend-card'><strong>Transition Notes</strong>" + transitions + "</article>" +
          "<article class='legend-card'><strong>Suggestion Mapping</strong>" + suggestions + "</article>";
      }

      async function fetchJson(url, options) {
        const res = await fetch(url, options || {});
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) throw new Error((data && data.error) || ("request_failed: " + url));
        return data;
      }

      function listTrueFlags(flags) {
        const out = [];
        const src = flags || {};
        Object.keys(src).forEach((k) => { if (src[k]) out.push(k); });
        return out;
      }

      async function loadLeadOverlay(leadId) {
        const id = String(leadId || "").trim();
        if (!id) {
          loadedLead = null;
          loadedLeadMessages = [];
          if (leadOverlayEl) leadOverlayEl.textContent = "No lead loaded.";
          return;
        }
        const debug = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(id) + "/debug-proof");
        const messagesPayload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(id) + "/messages?limit=30");
        loadedLead = debug;
        loadedLeadMessages = Array.isArray(messagesPayload && messagesPayload.items) ? messagesPayload.items : [];

        const stageCurrent = String(debug.stage_current || "-");
        const stageNext = String(debug.stage_next || "-");
        const trueFlags = listTrueFlags(debug.flags).join(", ") || "-";
        const ship = [debug.ship_city || "-", debug.ship_country || "-"].join(", ");
        if (leadOverlayEl) {
          leadOverlayEl.textContent =
            "stage_current: " + stageCurrent + "\\n" +
            "stage_next: " + stageNext + "\\n" +
            "flags_true: " + trueFlags + "\\n" +
            "event_date: " + String(debug.event_date || "-") + "\\n" +
            "destination: " + ship + "\\n" +
            "rule_applied: " + String(debug.rule_applied || "-") + "\\n" +
            "why: " + String(debug.why || "-");
        }
        if (focusStageEl) {
          focusStageEl.value = stageNext && stageNext !== "-" ? stageNext : "ALL";
          applyFocusStage(focusStageEl.value);
        }
      }

      async function runWhatIf() {
        const text = String((whatIfTextEl && whatIfTextEl.value) || "").trim();
        if (!text) {
          if (whatIfResultEl) whatIfResultEl.textContent = "Please type a message first.";
          return;
        }
        const direction = String((whatIfDirectionEl && whatIfDirectionEl.value) || "IN").toUpperCase() === "OUT" ? "OUT" : "IN";
        const baseMessages = Array.isArray(loadedLeadMessages)
          ? loadedLeadMessages.map((m) => ({
              direction: String(m.direction || "IN").toUpperCase() === "OUT" ? "OUT" : "IN",
              text: String(m.text || ""),
              created_at: String(m.created_at || m.createdAt || new Date().toISOString())
            }))
          : [];
        const payload = {
          messages: [...baseMessages, { direction, text, created_at: new Date().toISOString() }],
          mode: "basic",
          language: "FR"
        };
        const out = await fetchJson("/api/whatsapp/dev/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const trueFlags = listTrueFlags(out.signals).join(", ") || "-";
        const reasoning = String((out.stage && out.stage.reasoning) || "-");
        if (whatIfResultEl) {
          whatIfResultEl.textContent =
            "next_stage: " + String(out.stage && out.stage.main || "-") + "\\n" +
            "flags_true: " + trueFlags + "\\n" +
            "reasoning: " + reasoning;
        }
      }

      async function load() {
        errorEl.style.display = "none";
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 7000);
        let res;
        try {
          res = await fetch("/api/whatsapp-logic-diagram/config", { signal: controller.signal });
        } finally {
          window.clearTimeout(timeout);
        }
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok || !data) throw new Error((data && data.error) || "logic_diagram_load_failed");

        lastConfig = data;
        metaEl.textContent = "Config loaded: " + fmtDate(data.updated_at) + " · Dynamic rules: " + String((data.configured_stage_rules || []).length);
        renderLegend(data);
        initGraph(data);
        applyFocusStage(focusStageEl ? focusStageEl.value : "ALL");
      }

      refreshBtn.addEventListener("click", async () => {
        try { await load(); } catch (e) {
          metaEl.textContent = "Config load failed";
          errorEl.textContent = String((e && e.message) || "Failed to refresh diagram.");
          errorEl.style.display = "block";
        }
      });

      if (zoomInBtn) zoomInBtn.addEventListener("click", () => { if (!cy) return; cy.zoom({ level: cy.zoom() * 1.16, renderedPosition: { x: 260, y: 180 } }); syncMinimapViewport(); });
      if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => { if (!cy) return; cy.zoom({ level: cy.zoom() * 0.86, renderedPosition: { x: 260, y: 180 } }); syncMinimapViewport(); });
      if (fitBtn) fitBtn.addEventListener("click", () => { fitView(); syncMinimapViewport(); });
      if (resetBtn) resetBtn.addEventListener("click", () => {
        if (!cy) return;
        if (focusStageEl) focusStageEl.value = "ALL";
        applyFocusStage("ALL");
        fitView();
        syncMinimapViewport();
      });
      if (autoLayoutBtn) autoLayoutBtn.addEventListener("click", () => {
        if (!cy) return;
        applyLayout();
        fitView();
        syncMinimapViewport();
      });
      if (reflowBtn) reflowBtn.addEventListener("click", () => {
        if (!lastConfig) return;
        initGraph(lastConfig);
        applyFocusStage(focusStageEl ? focusStageEl.value : "ALL");
      });
      if (focusStageEl) focusStageEl.addEventListener("change", () => applyFocusStage(focusStageEl.value));
      if (loadLeadBtn) loadLeadBtn.addEventListener("click", async () => {
        try {
          await loadLeadOverlay(leadIdInput ? leadIdInput.value : "");
        } catch (e) {
          if (leadOverlayEl) leadOverlayEl.textContent = "Lead load failed: " + String((e && e.message) || "unknown_error");
        }
      });
      if (whatIfRunBtn) whatIfRunBtn.addEventListener("click", async () => {
        try {
          await runWhatIf();
        } catch (e) {
          if (whatIfResultEl) whatIfResultEl.textContent = "What-if failed: " + String((e && e.message) || "unknown_error");
        }
      });

      let refreshTimer = null;
      async function boot() {
        try {
          if (typeof window.cytoscape === "undefined") {
            metaEl.textContent = "Graph engine unavailable";
            errorEl.textContent = "Cytoscape CDN indisponible. Vérifiez la connexion et rechargez.";
            errorEl.style.display = "block";
            return;
          }
          cytoscape.use(cytoscapeDagre);
          await load();
          const query = new URLSearchParams(window.location.search || "");
          const prefilledLeadId = String(query.get("lead_id") || query.get("leadId") || "").trim();
          if (prefilledLeadId) {
            if (leadIdInput) leadIdInput.value = prefilledLeadId;
            try { await loadLeadOverlay(prefilledLeadId); } catch {}
          }
          if (refreshTimer) window.clearInterval(refreshTimer);
          refreshTimer = window.setInterval(async () => {
            try { await load(); } catch {}
          }, 30000);
        } catch (e) {
          metaEl.textContent = "Config load failed";
          errorEl.textContent = String((e && e.message) || "Unable to load logic diagram.");
          errorEl.style.display = "block";
        }
      }
      boot();
    </script>
  </body>
</html>`;

  return res.status(200).type("html").send(html);
});

whatsappLabRouter.post("/api/whatsapp-lab/run-simulation", (req, res) => {
  const parsed = runSimulationSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const result = runWhatsAppLabSimulation({
      messages: parsed.data.messages.map((m) => ({
        direction: m.direction,
        text: m.text,
        created_at: m.created_at || new Date().toISOString()
      })),
      mode: parsed.data.mode || "basic",
      language: parsed.data.language || "FR"
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("[whatsapp-lab] simulation failed", error);
    return res.status(500).json({ error: "simulation_failed" });
  }
});
