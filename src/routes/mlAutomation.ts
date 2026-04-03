import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { getMlOverview, listMlModels, listAutomationRules, updateAutomationRuleEnabled } from "../db/mlRepo.js";
import { getConversionScoreDebug } from "../services/conversionScore.js";
import { backfillHistoricalPriceQuotes } from "../services/ticketValueInference.js";
import { getQuoteApprovalStats } from "../services/quoteRequestService.js";

export const mlAutomationRouter = Router();

mlAutomationRouter.get("/api/ml/overview", async (_req, res) => {
  try {
    const overview = await getMlOverview();
    return res.status(200).json(overview);
  } catch (error) {
    console.error("[ml/overview] Error:", error);
    return res.status(500).json({ error: "Failed to fetch ML overview" });
  }
});

mlAutomationRouter.get("/api/ml/models", async (_req, res) => {
  try {
    const models = await listMlModels();
    return res.status(200).json({ models });
  } catch (error) {
    console.error("[ml/models] Error:", error);
    return res.status(500).json({ error: "Failed to fetch ML models" });
  }
});

mlAutomationRouter.get("/api/ml/rules", async (_req, res) => {
  try {
    const rules = await listAutomationRules();
    return res.status(200).json({ rules });
  } catch (error) {
    console.error("[ml/rules] Error:", error);
    return res.status(500).json({ error: "Failed to fetch automation rules" });
  }
});

mlAutomationRouter.get("/api/ml/scoring/:leadId", async (req, res) => {
  const leadId = String(req.params.leadId || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_lead_id" });
  try {
    const debug = await getConversionScoreDebug(leadId);
    if (!debug) return res.status(404).json({ error: "lead_not_found" });
    return res.status(200).json({
      score: debug.score,
      factors: debug.factors,
      lastSignals: debug.lastSignals,
      computedAt: debug.computedAt
    });
  } catch (error) {
    console.error("[ml/scoring/:leadId] Error:", error);
    return res.status(500).json({ error: "Failed to fetch scoring debug" });
  }
});

const ruleEnabledSchema = z.object({
  enabled: z.boolean()
});

const priceBackfillSchema = z.object({
  leadLimit: z.coerce.number().int().min(1).max(2000).optional(),
  messageLimit: z.coerce.number().int().min(1).max(300).optional()
});

mlAutomationRouter.patch("/api/ml/rules/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const parsed = ruleEnabledSchema.safeParse(req.body);
    
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    }

    const updated = await updateAutomationRuleEnabled(id, parsed.data.enabled);
    
    if (!updated) {
      return res.status(404).json({ error: "Automation rule not found" });
    }

    return res.status(200).json({ rule: updated });
  } catch (error) {
    console.error("[ml/rules/:id] Error:", error);
    return res.status(500).json({ error: "Failed to update automation rule" });
  }
});

mlAutomationRouter.post("/api/ml/backfill/prices", async (req, res) => {
  const parsed = priceBackfillSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", details: parsed.error.issues });
  }
  try {
    const result = await backfillHistoricalPriceQuotes({
      leadLimit: parsed.data.leadLimit ?? 500,
      messageLimit: parsed.data.messageLimit ?? 100
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("[ml/backfill/prices] Error:", error);
    return res.status(500).json({
      error: "price_backfill_failed",
      message: error instanceof Error ? error.message : String(error || "unknown_error")
    });
  }
});

mlAutomationRouter.get("/api/ml/quote-approval/stats", async (req, res) => {
  const analyticsEnabled = ["1", "true", "yes", "on"].includes(
    String(env.ENABLE_TEAM_QUOTE_ANALYTICS || "").trim().toLowerCase()
  );
  if (!analyticsEnabled) {
    return res.status(404).json({ error: "quote_analytics_disabled" });
  }
  const rangeDays = Math.max(1, Math.min(365, Number(req.query.rangeDays) || 30));
  try {
    const stats = await getQuoteApprovalStats(rangeDays);
    return res.status(200).json(stats);
  } catch (error) {
    console.error("[ml/quote-approval/stats] Error:", error);
    return res.status(500).json({ error: "quote_approval_stats_failed" });
  }
});

mlAutomationRouter.get("/admin/ml", (req, res) => {
  const navSuffix = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Machine Learning & Automation</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      :root {
        --bg-primary: #0a0e14;
        --bg-secondary: #0f1419;
        --bg-tertiary: #1a1f26;
        --border: #1e2738;
        --border-hover: #2a3548;
        --text-primary: #e6edf3;
        --text-secondary: #8b949e;
        --text-muted: #6e7681;
        --accent-green: #2eb67d;
        --accent-blue: #4a9eff;
        --accent-purple: #a29bfe;
        --accent-orange: #f59e0b;
        --status-active: #10b981;
        --status-inactive: #6b7280;
        --status-warning: #f59e0b;
      }
      
      body {
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        padding: 0;
      }
      
      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 32px 24px;
      }
      
      .header {
        margin-bottom: 32px;
      }
      
      .header-title {
        font-size: 28px;
        font-weight: 700;
        margin-bottom: 8px;
        background: linear-gradient(135deg, var(--accent-green), var(--accent-blue));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      
      .header-subtitle {
        font-size: 14px;
        color: var(--text-secondary);
      }
      
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
        margin-bottom: 32px;
      }
      
      .stat-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 20px;
        transition: all 0.2s ease;
      }
      
      .stat-card:hover {
        border-color: var(--border-hover);
        transform: translateY(-2px);
      }
      
      .stat-label {
        font-size: 12px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }
      
      .stat-value {
        font-size: 32px;
        font-weight: 700;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      
      .stat-trend {
        font-size: 12px;
        color: var(--accent-green);
        margin-top: 4px;
      }
      
      .section {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        margin-bottom: 24px;
      }
      
      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 20px;
      }
      
      .section-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }
      
      .section-badge {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        padding: 4px 12px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
      }
      
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      
      .table th {
        text-align: left;
        padding: 12px 16px;
        font-size: 12px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid var(--border);
      }
      
      .table td {
        padding: 16px;
        border-bottom: 1px solid var(--border);
      }
      
      .table tr:last-child td {
        border-bottom: none;
      }
      
      .table tr:hover {
        background: var(--bg-tertiary);
      }
      
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
      
      .badge-active {
        background: rgba(16, 185, 129, 0.15);
        color: var(--status-active);
      }
      
      .badge-inactive {
        background: rgba(107, 114, 128, 0.15);
        color: var(--status-inactive);
      }
      
      .badge-training {
        background: rgba(245, 158, 11, 0.15);
        color: var(--status-warning);
      }
      
      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      
      .toggle-switch {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
      }
      
      .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      
      .toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        transition: 0.3s;
        border-radius: 24px;
      }
      
      .toggle-slider:before {
        position: absolute;
        content: "";
        height: 16px;
        width: 16px;
        left: 3px;
        bottom: 3px;
        background: var(--text-muted);
        transition: 0.3s;
        border-radius: 50%;
      }
      
      input:checked + .toggle-slider {
        background: var(--accent-green);
        border-color: var(--accent-green);
      }
      
      input:checked + .toggle-slider:before {
        transform: translateX(20px);
        background: white;
      }
      
      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 400px;
        flex-direction: column;
        gap: 16px;
      }
      
      .loading-spinner {
        width: 40px;
        height: 40px;
        border: 3px solid var(--border);
        border-top-color: var(--accent-green);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      
      .error {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 8px;
        padding: 16px;
        color: #fca5a5;
        font-size: 14px;
      }
      
      .model-type {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .accuracy {
        font-weight: 600;
        color: var(--accent-green);
      }
      
      .rule-description {
        font-size: 13px;
        color: var(--text-secondary);
        margin-top: 4px;
      }

    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel">
      const { useState, useEffect } = React;
      const NAV_SUFFIX = ${JSON.stringify(navSuffix)};

      function MlAutomationPage() {
        const [overview, setOverview] = useState(null);
        const [models, setModels] = useState([]);
        const [rules, setRules] = useState([]);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);

        useEffect(() => {
          Promise.all([
            fetch('/api/ml/overview').then(r => r.json()),
            fetch('/api/ml/models').then(r => r.json()),
            fetch('/api/ml/rules').then(r => r.json())
          ])
            .then(([overviewData, modelsData, rulesData]) => {
              setOverview(overviewData);
              setModels(modelsData.models || []);
              setRules(rulesData.rules || []);
              setLoading(false);
            })
            .catch(err => {
              setError(err.message);
              setLoading(false);
            });
        }, []);

        const handleToggleRule = async (ruleId, currentEnabled) => {
          try {
            const response = await fetch(\`/api/ml/rules/\${ruleId}\`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: !currentEnabled })
            });
            
            if (!response.ok) throw new Error('Failed to update rule');
            
            const { rule } = await response.json();
            setRules(prev => prev.map(r => r.id === ruleId ? rule : r));
          } catch (err) {
            console.error('Toggle error:', err);
          }
        };

        const formatMad = (value) => {
          const n = Number(value || 0);
          if (!Number.isFinite(n)) return "0 MAD";
          return new Intl.NumberFormat('fr-MA', { maximumFractionDigits: 0 }).format(n) + " MAD";
        };

        if (loading) {
          return (
            <div className="loading">
              <div className="loading-spinner"></div>
              <div style={{ color: 'var(--text-secondary)' }}>Loading ML & Automation...</div>
            </div>
          );
        }

        if (error) {
          return (
            <div className="container">
              <div className="error">Error: {error}</div>
            </div>
          );
        }

        return (
          <div className="container">
            <ui-nav-menu>
              <a href={"/admin/orders" + NAV_SUFFIX}>Commandes</a>
              <a href={"/admin/invoices" + NAV_SUFFIX}>Factures</a>
              <a href={"/admin/appointments" + NAV_SUFFIX}>Rendez-vous</a>
              <a href={"/admin/forecast" + NAV_SUFFIX}>Forecast</a>
              <a href={"/admin/whatsapp-intelligence" + NAV_SUFFIX}>WhatsApp</a>
              <a href={"/admin/control-center" + NAV_SUFFIX + "#outils"}>Outils</a>
            </ui-nav-menu>
            <div className="header">
              <div className="header-title">Machine Learning & Automation</div>
              <div className="header-subtitle">
                AI-powered decision engine and automation rules
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Automated Decisions</div>
                <div className="stat-value">{overview?.automatedDecisions7d || 0}</div>
                <div className="stat-trend">Last 7 days</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Risk Alerts</div>
                <div className="stat-value">{overview?.riskAlerts7d || 0}</div>
                <div className="stat-trend">Last 7 days</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Suggestions Used</div>
                <div className="stat-value">{overview?.suggestionUsed7d || 0}</div>
                <div className="stat-trend">Last 7 days</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Template Messages</div>
                <div className="stat-value">{overview?.templateUsed7d || 0}</div>
                <div className="stat-trend">vs {overview?.manualSent7d || 0} manual</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Active Models</div>
                <div className="stat-value">{overview?.activeModels || 0}</div>
                <div className="stat-trend">Production ready</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Projected Revenue (30 days)</div>
                <div className="stat-value" style={{ fontSize: '26px' }}>{formatMad(overview?.projectedRevenue30d || 0)}</div>
                <div className="stat-trend">Active leads pipeline</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Actual vs Projected (30 days)</div>
                <div className="stat-value" style={{ fontSize: '24px' }}>
                  {formatMad(overview?.actualRevenue30d || 0)}
                </div>
                <div className="stat-trend">
                  vs {formatMad(overview?.projectedRevenue30d || 0)} projected
                  {" • Gap " + formatMad((overview?.actualRevenue30d || 0) - (overview?.projectedRevenue30d || 0))}
                </div>
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div className="section-title">ML Models</div>
                <div className="section-badge">{models.length} models</div>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Accuracy</th>
                    <th>Version</th>
                    <th>Last Trained</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map(model => (
                    <tr key={model.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{model.name}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {model.description}
                        </div>
                      </td>
                      <td>
                        <div className="model-type">{model.modelType}</div>
                      </td>
                      <td>
                        <span className={\`badge badge-\${model.status.toLowerCase()}\`}>
                          <span className="status-dot"></span>
                          {model.status}
                        </span>
                      </td>
                      <td>
                        <span className="accuracy">
                          {model.accuracyScore ? \`\${(model.accuracyScore * 100).toFixed(1)}%\` : '—'}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                        v{model.version}
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                        {model.lastTrainedAt ? new Date(model.lastTrainedAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="section">
              <div className="section-header">
                <div className="section-title">Automation Rules</div>
                <div className="section-badge">{rules.filter(r => r.enabled).length} active</div>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Type</th>
                    <th>Priority</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(rule => (
                    <tr key={rule.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{rule.name}</div>
                        <div className="rule-description">{rule.description}</div>
                      </td>
                      <td>
                        <div className="model-type">{rule.ruleType}</div>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 600 }}>
                        {rule.priority}
                      </td>
                      <td>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={() => handleToggleRule(rule.id, rule.enabled)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      }

      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(<MlAutomationPage />);
    </script>
  </body>
</html>`;

  return res.status(200).type("html").send(html);
});
