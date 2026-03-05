import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../config/env.js";

export const blueprintRouter = Router();

blueprintRouter.get("/api/blueprint", (_req, res) => {
  try {
    const blueprintPath = join(process.cwd(), "system-blueprint.json");
    const blueprintData = readFileSync(blueprintPath, "utf-8");
    const blueprint = JSON.parse(blueprintData);
    
    const enhancedBlueprint = {
      ...blueprint,
      nodes: blueprint.nodes.map((node: any) => ({
        ...node,
        ...(() => {
          const statusMeta = getNodeStatusMeta(node);
          return {
            status: statusMeta.status,
            statusReason: statusMeta.reason
          };
        })(),
        layer: getNodeLayer(node),
        importance: getNodeImportance(node),
        metrics: getNodeMetrics(node),
        lastSync: node.type === "external" ? new Date().toISOString() : null
      }))
    };
    
    return res.status(200).json(enhancedBlueprint);
  } catch (error) {
    console.error("[blueprint] Failed to load blueprint", error);
    return res.status(500).json({ error: "blueprint_load_failed" });
  }
});

function getNodeStatusMeta(node: any): {
  status: "healthy" | "warning" | "error" | "inactive";
  reason: string | null;
} {
  if (node.type !== "external") return { status: "healthy", reason: "Internal service" };
  const nodeId = String(node.id || "").trim().toLowerCase();
  if (nodeId === "google_trends") {
    const trendsKeywords = String(env.TRENDS_KEYWORDS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return trendsKeywords.length > 0
      ? { status: "healthy", reason: `Configured (${trendsKeywords.length} keyword${trendsKeywords.length > 1 ? "s" : ""})` }
      : { status: "warning", reason: "Missing TRENDS_KEYWORDS" };
  }
  if (nodeId === "bigquery") {
    const missing: string[] = [];
    if (!String(env.GCP_PROJECT_ID || "").trim()) missing.push("GCP_PROJECT_ID");
    if (!String(env.BIGQUERY_DATASET || "").trim()) missing.push("BIGQUERY_DATASET");
    if (!String(env.BIGQUERY_LOCATION || "").trim()) missing.push("BIGQUERY_LOCATION");
    return missing.length === 0
      ? { status: "healthy", reason: "Configured (project, dataset, location)" }
      : { status: "warning", reason: `Missing ${missing.join(", ")}` };
  }
  if (nodeId === "shopify_api") {
    const configured = Boolean(String(env.SHOPIFY_SHOP || "").trim());
    return configured
      ? { status: "healthy", reason: "Configured (SHOPIFY_SHOP)" }
      : { status: "warning", reason: "Missing SHOPIFY_SHOP" };
  }
  if (nodeId === "zoko_api") {
    const missing: string[] = [];
    if (!String(env.ZOKO_API_URL || "").trim()) missing.push("ZOKO_API_URL");
    if (!String(env.ZOKO_AUTH_TOKEN || "").trim()) missing.push("ZOKO_AUTH_TOKEN");
    return missing.length === 0
      ? { status: "healthy", reason: "Configured (API URL + auth token)" }
      : { status: "warning", reason: `Missing ${missing.join(", ")}` };
  }

  return { status: "healthy", reason: "External service" };
}

function getNodeLayer(node: any): "business" | "service" | "repository" | "route" {
  if (node.type === "module") return "business";
  if (node.type === "service") return "service";
  if (node.type === "database") return "repository";
  if (node.type === "endpoint" || node.type === "webhook") return "route";
  return "service";
}

function getNodeImportance(node: any): "core" | "secondary" {
  const coreModules = ["whatsapp_intelligence", "ai_services", "orders", "forecasting"];
  const coreServices = ["service_ai_whatsapp", "service_stage_progression", "service_suggestions"];
  
  if (coreModules.includes(node.id)) return "core";
  if (coreServices.includes(node.id)) return "core";
  if (node.type === "module") return "core";
  return "secondary";
}

function getNodeMetrics(node: any): any {
  if (node.id === "whatsapp_intelligence") {
    return {
      activeLeads: 47,
      pendingQualification: 12,
      depositPending: 8,
      avgResponseTime: 3.2
    };
  }
  if (node.id === "appointments") {
    return {
      todayAppointments: 5,
      upcomingWeek: 23,
      noShowRate: 8
    };
  }
  if (node.id === "orders") {
    return {
      pendingOrders: 14,
      readyToShip: 6,
      avgFulfillmentTime: 4.5
    };
  }
  return null;
}

blueprintRouter.get("/blueprint", (_req, res) => {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>System Blueprint - Interactive Architecture</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/reactflow@11.10.4/dist/umd/index.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reactflow@11.10.4/dist/style.css" />
    <script>
      window.addEventListener('error', function(e) {
        console.error('Global error:', e.error);
        document.body.innerHTML = '<div style="color: white; padding: 20px; font-family: monospace;">Error: ' + e.message + '<br><br>Check console for details</div>';
      });
    </script>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      
      :root {
        --bg-primary: #0a0e1a;
        --bg-secondary: #0f1420;
        --bg-tertiary: #151b2b;
        --border: #1e2738;
        --text-primary: #e5e9f0;
        --text-secondary: #8892a6;
        --text-muted: #5e6b7f;
        --accent-green: #2eb67d;
        --accent-blue: #36c5f0;
        --accent-purple: #9b59b6;
        --accent-red: #e01e5a;
        --accent-yellow: #ecb22e;
        --status-active: #10b981;
        --status-warning: #f59e0b;
        --status-error: #ef4444;
      }
      
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        overflow: hidden;
      }
      
      #root { width: 100vw; height: 100vh; }
      
      .blueprint-container {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      
      .blueprint-header {
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        padding: 16px 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      
      .header-left {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      
      .header-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }
      
      .header-subtitle {
        font-size: 13px;
        color: var(--text-muted);
      }
      
      .header-controls {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      
      .filter-group {
        display: flex;
        gap: 8px;
        background: var(--bg-tertiary);
        border-radius: 8px;
        padding: 4px;
      }
      
      .filter-btn {
        padding: 6px 12px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: all 0.2s;
      }
      
      .filter-btn:hover {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      
      .filter-btn.active {
        background: var(--accent-green);
        color: white;
      }
      
      .zoom-controls {
        display: flex;
        gap: 4px;
        background: var(--bg-tertiary);
        border-radius: 8px;
        padding: 4px;
      }
      
      .zoom-btn {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
      }
      
      .zoom-btn:hover {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      
      .blueprint-canvas {
        flex: 1;
        position: relative;
        background: var(--bg-primary);
      }
      
      .react-flow__node {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px;
        min-width: 180px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .react-flow__node:hover {
        border-color: var(--accent-green);
        box-shadow: 0 0 0 2px rgba(46, 182, 125, 0.1);
      }
      
      .react-flow__node.selected {
        border-color: var(--accent-green);
        box-shadow: 0 0 0 3px rgba(46, 182, 125, 0.2);
      }
      
      .node-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      
      .node-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      
      .node-status.active { background: var(--status-active); }
      .node-status.warning { background: var(--status-warning); }
      .node-status.error { background: var(--status-error); }
      
      .node-label {
        font-weight: 600;
        color: var(--text-primary);
        font-size: 14px;
        margin-bottom: 4px;
      }
      
      .node-type {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .node-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        margin-top: 8px;
      }
      
      .node-module { border-left: 3px solid var(--accent-green); }
      .node-database { border-left: 3px solid var(--accent-blue); }
      .node-service { border-left: 3px solid var(--accent-purple); }
      .node-endpoint { border-left: 3px solid var(--accent-yellow); }
      .node-external { border-left: 3px solid var(--accent-red); }
      
      .react-flow__edge-path {
        stroke: var(--border);
        stroke-width: 2;
      }
      
      .react-flow__edge.selected .react-flow__edge-path {
        stroke: var(--accent-green);
      }
      
      .react-flow__controls {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      
      .react-flow__controls-button {
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--border);
        color: var(--text-secondary);
      }
      
      .react-flow__controls-button:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      
      .side-drawer {
        position: fixed;
        top: 0;
        right: 0;
        width: 480px;
        height: 100vh;
        background: var(--bg-secondary);
        border-left: 1px solid var(--border);
        transform: translateX(100%);
        transition: transform 0.3s ease;
        z-index: 1000;
        display: flex;
        flex-direction: column;
      }
      
      .side-drawer.open {
        transform: translateX(0);
      }
      
      .drawer-header {
        padding: 20px 24px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      
      .drawer-title {
        font-size: 18px;
        font-weight: 600;
      }
      
      .drawer-close {
        width: 32px;
        height: 32px;
        border: none;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .drawer-close:hover {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      
      .drawer-content {
        flex: 1;
        overflow-y: auto;
        padding: 24px;
      }
      
      .drawer-section {
        margin-bottom: 24px;
      }
      
      .drawer-section-title {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted);
        margin-bottom: 12px;
      }
      
      .drawer-field {
        margin-bottom: 12px;
      }
      
      .drawer-field-label {
        font-size: 13px;
        color: var(--text-secondary);
        margin-bottom: 4px;
      }
      
      .drawer-field-value {
        font-size: 14px;
        color: var(--text-primary);
        font-family: "SF Mono", Monaco, monospace;
        background: var(--bg-tertiary);
        padding: 8px 12px;
        border-radius: 6px;
      }
      
      .drawer-list {
        list-style: none;
      }
      
      .drawer-list-item {
        padding: 8px 12px;
        background: var(--bg-tertiary);
        border-radius: 6px;
        margin-bottom: 6px;
        font-size: 13px;
        font-family: "SF Mono", Monaco, monospace;
      }
      
      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        font-size: 14px;
        color: var(--text-secondary);
      }
      
      .error {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        flex-direction: column;
        gap: 12px;
      }
      
      .error-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--status-error);
      }
      
      .error-message {
        font-size: 14px;
        color: var(--text-secondary);
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel">
      console.log('Available globals:', Object.keys(window).filter(k => k.includes('React')));
      const { useState, useEffect, useMemo, useCallback, memo } = React;
      
      // React Flow is available as window.ReactFlow
      if (!window.ReactFlow) {
        throw new Error('ReactFlow library not loaded');
      }
      
      const { ReactFlow, Controls, Background, useNodesState, useEdgesState, MarkerType } = window.ReactFlow;
      
      const CustomNode = memo(({ data }) => {
        return (
          <div className={\`node-\${data.type}\`}>
            <div className="node-header">
              <div className={\`node-status \${data.status || 'active'}\`}></div>
            </div>
            <div className="node-label">{data.label}</div>
            <div className="node-type">{data.type}</div>
            {data.routes > 0 && (
              <div className="node-badge" style={{ background: 'rgba(46, 182, 125, 0.15)', color: '#2eb67d' }}>
                {data.routes} routes
              </div>
            )}
          </div>
        );
      });
      
      const SideDrawer = ({ node, onClose }) => {
        if (!node) return null;
        
        return (
          <div className={\`side-drawer \${node ? 'open' : ''}\`}>
            <div className="drawer-header">
              <div className="drawer-title">{node.data.label}</div>
              <button className="drawer-close" onClick={onClose}>✕</button>
            </div>
            <div className="drawer-content">
              <div className="drawer-section">
                <div className="drawer-section-title">Details</div>
                <div className="drawer-field">
                  <div className="drawer-field-label">Type</div>
                  <div className="drawer-field-value">{node.data.type}</div>
                </div>
                {node.data.description && (
                  <div className="drawer-field">
                    <div className="drawer-field-label">Description</div>
                    <div className="drawer-field-value">{node.data.description}</div>
                  </div>
                )}
                {node.data.file && (
                  <div className="drawer-field">
                    <div className="drawer-field-label">File</div>
                    <div className="drawer-field-value">{node.data.file}</div>
                  </div>
                )}
                {node.data.module && (
                  <div className="drawer-field">
                    <div className="drawer-field-label">Module</div>
                    <div className="drawer-field-value">{node.data.module}</div>
                  </div>
                )}
                {node.data.method && (
                  <div className="drawer-field">
                    <div className="drawer-field-label">Method</div>
                    <div className="drawer-field-value">{node.data.method}</div>
                  </div>
                )}
              </div>
              
              {node.data.functions && node.data.functions.length > 0 && (
                <div className="drawer-section">
                  <div className="drawer-section-title">Functions</div>
                  <ul className="drawer-list">
                    {node.data.functions.map((fn, i) => (
                      <li key={i} className="drawer-list-item">{fn}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {node.data.endpoints && node.data.endpoints.length > 0 && (
                <div className="drawer-section">
                  <div className="drawer-section-title">Endpoints</div>
                  <ul className="drawer-list">
                    {node.data.endpoints.map((ep, i) => (
                      <li key={i} className="drawer-list-item">{ep}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {node.data.tables && node.data.tables.length > 0 && (
                <div className="drawer-section">
                  <div className="drawer-section-title">Tables</div>
                  <ul className="drawer-list">
                    {node.data.tables.map((table, i) => (
                      <li key={i} className="drawer-list-item">{table}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        );
      };
      
      function BlueprintApp() {
        const [blueprint, setBlueprint] = useState(null);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);
        const [filter, setFilter] = useState('all');
        const [selectedNode, setSelectedNode] = useState(null);
        const [nodes, setNodes, onNodesChange] = useNodesState([]);
        const [edges, setEdges, onEdgesChange] = useEdgesState([]);
        
        useEffect(() => {
          console.log('Fetching blueprint data...');
          fetch('/api/blueprint')
            .then(res => {
              console.log('Response received:', res.status);
              if (!res.ok) throw new Error('Failed to fetch: ' + res.status);
              return res.json();
            })
            .then(data => {
              console.log('Blueprint data loaded:', data);
              setBlueprint(data);
              setLoading(false);
            })
            .catch(err => {
              console.error('Error loading blueprint:', err);
              setError(err.message);
              setLoading(false);
            });
        }, []);
        
        useEffect(() => {
          if (!blueprint) return;
          
          let filteredNodes = blueprint.nodes;
          
          if (filter === 'business') {
            filteredNodes = blueprint.nodes.filter(n => n.type === 'module');
          } else if (filter === 'whatsapp') {
            filteredNodes = blueprint.nodes.filter(n => 
              n.id.includes('whatsapp') || n.module === 'whatsapp_intelligence'
            );
          }
          
          const flowNodes = filteredNodes.map((node, index) => ({
            id: node.id,
            type: 'default',
            data: { ...node },
            position: calculatePosition(index, filteredNodes.length),
          }));
          
          const nodeIds = new Set(flowNodes.map(n => n.id));
          const flowEdges = blueprint.edges
            .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
            .map((edge, index) => ({
              id: \`edge-\${index}\`,
              source: edge.from,
              target: edge.to,
              label: edge.label,
              type: 'smoothstep',
              animated: edge.type === 'event' || edge.type === 'webhook',
            }));
          
          setNodes(flowNodes);
          setEdges(flowEdges);
        }, [blueprint, filter, setNodes, setEdges]);
        
        const calculatePosition = (index, total) => {
          const cols = Math.ceil(Math.sqrt(total));
          const row = Math.floor(index / cols);
          const col = index % cols;
          return {
            x: col * 280,
            y: row * 180,
          };
        };
        
        const onNodeClick = useCallback((event, node) => {
          if (node.data.type === 'endpoint' && node.data.route) {
            window.location.href = node.data.route;
          } else {
            setSelectedNode(node);
          }
        }, []);
        
        const handleZoomIn = () => {
          const viewport = document.querySelector('.react-flow__viewport');
          if (viewport) {
            const currentScale = parseFloat(viewport.style.transform.match(/scale\\(([^)]+)\\)/)?.[1] || 1);
            viewport.style.transform = \`translate(0px, 0px) scale(\${Math.min(currentScale * 1.2, 2)})\`;
          }
        };
        
        const handleZoomOut = () => {
          const viewport = document.querySelector('.react-flow__viewport');
          if (viewport) {
            const currentScale = parseFloat(viewport.style.transform.match(/scale\\(([^)]+)\\)/)?.[1] || 1);
            viewport.style.transform = \`translate(0px, 0px) scale(\${Math.max(currentScale * 0.8, 0.5)})\`;
          }
        };
        
        const handleFitView = () => {
          const viewport = document.querySelector('.react-flow__viewport');
          if (viewport) {
            viewport.style.transform = 'translate(0px, 0px) scale(1)';
          }
        };
        
        if (loading) {
          return <div className="loading">Loading blueprint...</div>;
        }
        
        if (error) {
          return (
            <div className="error">
              <div className="error-title">Failed to load blueprint</div>
              <div className="error-message">{error}</div>
            </div>
          );
        }
        
        return (
          <div className="blueprint-container">
            <div className="blueprint-header">
              <div className="header-left">
                <div>
                  <div className="header-title">System Blueprint</div>
                  <div className="header-subtitle">
                    {blueprint.metadata.totalRoutes} routes · {blueprint.metadata.totalModules} modules · {blueprint.metadata.totalServices} services
                  </div>
                </div>
              </div>
              <div className="header-controls">
                <div className="filter-group">
                  <button 
                    className={\`filter-btn \${filter === 'all' ? 'active' : ''}\`}
                    onClick={() => setFilter('all')}
                  >
                    All
                  </button>
                  <button 
                    className={\`filter-btn \${filter === 'business' ? 'active' : ''}\`}
                    onClick={() => setFilter('business')}
                  >
                    Business
                  </button>
                  <button 
                    className={\`filter-btn \${filter === 'whatsapp' ? 'active' : ''}\`}
                    onClick={() => setFilter('whatsapp')}
                  >
                    WhatsApp
                  </button>
                </div>
                <div className="zoom-controls">
                  <button className="zoom-btn" onClick={handleZoomIn}>+</button>
                  <button className="zoom-btn" onClick={handleZoomOut}>−</button>
                  <button className="zoom-btn" onClick={handleFitView}>⊡</button>
                </div>
              </div>
            </div>
            <div className="blueprint-canvas">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                fitView
                nodesDraggable
                nodesConnectable={false}
                elementsSelectable
              >
                <Background color="#1e2738" gap={16} />
                <Controls />
              </ReactFlow>
            </div>
            <SideDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
          </div>
        );
      }
      
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(<BlueprintApp />);
    </script>
  </body>
</html>`;
  
  return res.status(200).type("html").send(html);
});
