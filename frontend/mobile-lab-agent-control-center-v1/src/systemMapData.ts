export interface SystemMapNode {
  name: string;
  role: string;
}

export interface SystemMapLayer {
  id:
    | "input"
    | "processing"
    | "orchestration"
    | "intelligence"
    | "human"
    | "execution"
    | "learning"
    | "ui";
  title:
    | "Input Layer"
    | "Processing / Normalization Layer"
    | "Orchestration Layer"
    | "Intelligence Layer"
    | "Human Control Layer"
    | "Execution Layer"
    | "Learning Layer"
    | "Product Interface Layer";
  purpose: string;
  emphasis?: "core" | "control" | "feedback";
  nodes: SystemMapNode[];
}

export interface SystemMapFlowStep {
  id: string;
  title: string;
  summary: string;
}

export interface UiBinding {
  surface: string;
  sources: string[];
  outcome: string;
}

export interface ControlPath {
  name: string;
  path: string[];
  why: string;
}

export interface BuildPriority {
  step: string;
  focus: string;
  deliverable: string;
}

export const systemMapFlowSteps: SystemMapFlowStep[] = [
  {
    id: "flow-1",
    title: "Inputs",
    summary: "Operational events enter Mobile-Lab from messaging, operators, schedules, and business state changes."
  },
  {
    id: "flow-2",
    title: "Ingestion / Normalization",
    summary: "Raw events are parsed, normalized, linked to the correct lead, and enriched with context."
  },
  {
    id: "flow-3",
    title: "Orchestrator",
    summary: "Central coordination classifies event type, checks governance, and decides execution plan."
  },
  {
    id: "flow-4",
    title: "Decision Routing",
    summary: "The orchestrator routes work to specialized intelligence engines and controls sensitive branches."
  },
  {
    id: "flow-5",
    title: "Intelligence Modules",
    summary: "State, signals, priority, strategy, and reply generation modules produce actionable outputs."
  },
  {
    id: "flow-6",
    title: "Human Control",
    summary: "Sensitive or incomplete actions are gated until human approval or missing data resolution."
  },
  {
    id: "flow-7",
    title: "Execution",
    summary: "Approved outputs are persisted, tasks are created, responses prepared, and lead state updated."
  },
  {
    id: "flow-8",
    title: "Learning Loop",
    summary: "Human edits are compared with AI outputs to detect patterns and propose prompt/rule improvements."
  },
  {
    id: "flow-9",
    title: "Product Interface",
    summary: "All traces, decisions, and outcomes feed Dashboard, Runs, Workspace, Approvals, and Learning UI."
  }
];

export const systemMapLayers: SystemMapLayer[] = [
  {
    id: "input",
    title: "Input Layer",
    purpose: "Captures all event sources that trigger system behavior.",
    nodes: [
      { name: "WhatsApp / Zoko / Webhooks", role: "Inbound conversation and platform events." },
      { name: "Operator Actions", role: "Manual actions from human operators in Mobile-Lab UI." },
      { name: "Human Approvals", role: "Resolved approval outcomes from human gate." },
      { name: "Scheduled Tasks", role: "Time-based reactivation, follow-up, and operational jobs." },
      { name: "Business Events", role: "Payment detection, stage changes, and business-state updates." }
    ]
  },
  {
    id: "processing",
    title: "Processing / Normalization Layer",
    purpose: "Transforms heterogeneous events into a consistent lead-centric operational context.",
    nodes: [
      { name: "Message Ingestion", role: "Parses incoming payloads and persists message records." },
      { name: "Conversation Normalization", role: "Formats timeline context across channels and event types." },
      { name: "Lead Context Retrieval", role: "Loads lead profile, stage, tasks, history, and policy context." }
    ]
  },
  {
    id: "orchestration",
    title: "Orchestration Layer",
    purpose: "Central authority for event classification, control logic, governance, and execution ordering.",
    emphasis: "core",
    nodes: [
      { name: "Orchestrator Agent", role: "Classifies event and composes execution plan." },
      { name: "Governance Check", role: "Validates policy boundaries and sensitive-action eligibility." },
      { name: "Decision Routing", role: "Routes to intelligence modules, human gate, and execution paths." }
    ]
  },
  {
    id: "intelligence",
    title: "Intelligence Layer",
    purpose: "Produces operational intelligence and AI outputs for sales decisions and response generation.",
    nodes: [
      { name: "State / CRM Intelligence Engine", role: "Updates stage, health, and commercial metadata." },
      { name: "Signals Engine", role: "Detects urgency, intent, objections, and qualification clues." },
      { name: "Priority Engine", role: "Scores lead urgency and operator prioritization." },
      { name: "Strategic Advisor Agent", role: "Recommends next action, risks, opportunities, and direction." },
      { name: "Reply Draft Agent", role: "Generates premium short-form suggested replies." }
    ]
  },
  {
    id: "human",
    title: "Human Control Layer",
    purpose: "Ensures controlled execution for sensitive actions and unresolved information dependencies.",
    emphasis: "control",
    nodes: [{ name: "Human Approval Agent / Human Gate", role: "Approves, blocks, or requests additional context." }]
  },
  {
    id: "execution",
    title: "Execution Layer",
    purpose: "Commits approved outputs and updates system state for downstream operations and UI visibility.",
    nodes: [
      { name: "Suggested Replies Store", role: "Persists generated reply variants and recommendation metadata." },
      { name: "Tasks Engine", role: "Creates and manages operational tasks for operators." },
      { name: "Outgoing Response Preparation", role: "Prepares/authorizes outbound message payloads." },
      { name: "Lead State Update", role: "Writes stage, priority, payment, and health updates." }
    ]
  },
  {
    id: "learning",
    title: "Learning Layer",
    purpose: "Continuously improves agent quality through human correction analysis and policy tuning.",
    emphasis: "feedback",
    nodes: [
      { name: "Learning Loop Agent", role: "Compares AI outputs against final human responses." },
      { name: "Correction Pattern Detection", role: "Extracts recurring correction motifs and risk drifts." },
      { name: "Prompt / Rule Improvement", role: "Produces improvement candidates for prompts and governance." }
    ]
  },
  {
    id: "ui",
    title: "Product Interface Layer",
    purpose: "Operational surfaces where teams monitor, decide, and execute with traceability.",
    nodes: [
      { name: "Dashboard", role: "System overview, activity, blockers, approvals, priority queue." },
      { name: "Agents", role: "Agent health, autonomy, runtime quality, and incidents." },
      { name: "Runs", role: "Execution traces, event context, decisions, and timeline." },
      { name: "Leads", role: "Portfolio management, filtering, and prioritization." },
      { name: "Lead Workspace", role: "Unified lead cockpit: conversation + intelligence + suggestions." },
      { name: "Approvals", role: "Human validation center for gated actions." },
      { name: "Learning", role: "Correction review, patterns, and improvement candidates." }
    ]
  }
];

export const controlPaths: ControlPath[] = [
  {
    name: "Standard Assisted Reply",
    path: [
      "WhatsApp / Zoko / Webhooks",
      "Message Ingestion",
      "Orchestrator Agent",
      "Decision Routing",
      "Strategic Advisor Agent",
      "Reply Draft Agent",
      "Suggested Replies Store",
      "Lead Workspace"
    ],
    why: "Default path for high-quality assisted response generation."
  },
  {
    name: "Sensitive Action Gate",
    path: [
      "Decision Routing",
      "Governance Check",
      "Human Approval Agent / Human Gate",
      "Outgoing Response Preparation",
      "Approvals",
      "Lead Workspace"
    ],
    why: "Enforces human validation before sensitive execution."
  },
  {
    name: "Learning Feedback Loop",
    path: [
      "Lead Workspace",
      "Learning Loop Agent",
      "Correction Pattern Detection",
      "Prompt / Rule Improvement",
      "Governance Check",
      "Strategic Advisor Agent",
      "Reply Draft Agent"
    ],
    why: "Feeds improvements back into strategic and drafting behavior."
  }
];

export const uiBindings: UiBinding[] = [
  {
    surface: "Dashboard",
    sources: ["Priority Engine", "Decision Routing", "Human Approval Agent / Human Gate", "Lead State Update"],
    outcome: "Global health, high-priority queue, blockers, and pending approvals."
  },
  {
    surface: "Agents",
    sources: ["Orchestrator Agent", "Strategic Advisor Agent", "Reply Draft Agent", "Learning Loop Agent"],
    outcome: "Agent status, run quality, autonomy profile, and failure visibility."
  },
  {
    surface: "Runs",
    sources: ["Decision Routing", "Governance Check", "Execution Layer"],
    outcome: "Traceable run history with context, decisions, and timeline."
  },
  {
    surface: "Leads",
    sources: ["Lead State Update", "Priority Engine", "Signals Engine"],
    outcome: "Portfolio management with commercial state and urgency ranking."
  },
  {
    surface: "Lead Workspace",
    sources: [
      "Conversation Normalization",
      "State / CRM Intelligence Engine",
      "Signals Engine",
      "Strategic Advisor Agent",
      "Reply Draft Agent",
      "Decision Routing"
    ],
    outcome: "Single-lead operating cockpit with conversation, strategy, and next actions."
  },
  {
    surface: "Approvals",
    sources: ["Human Approval Agent / Human Gate", "Governance Check", "Outgoing Response Preparation"],
    outcome: "Human decision center for approval/deny/edit flows."
  },
  {
    surface: "Learning",
    sources: ["Learning Loop Agent", "Correction Pattern Detection", "Prompt / Rule Improvement"],
    outcome: "Improvement visibility, correction patterns, and optimization backlog."
  }
];

export const buildPriorities: BuildPriority[] = [
  {
    step: "Phase 1 — Control Backbone",
    focus: "Input + Processing + Orchestrator + Runs traceability",
    deliverable: "Stable event pipeline with deterministic routing and observability."
  },
  {
    step: "Phase 2 — Commercial Intelligence",
    focus: "State/CRM + Signals + Priority + Lead Workspace core",
    deliverable: "Reliable lead intelligence and prioritization for daily operator execution."
  },
  {
    step: "Phase 3 — Human Governance",
    focus: "Human Gate + Approvals + sensitive-action enforcement",
    deliverable: "Policy-safe operations with auditable approval control."
  },
  {
    step: "Phase 4 — Learning Compounding",
    focus: "Learning loop + correction detection + prompt/rule improvement",
    deliverable: "Continuous quality improvement and strategic response refinement."
  }
];
