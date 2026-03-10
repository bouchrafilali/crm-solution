import {
  ActivityEvent,
  Agent,
  ApprovalItem,
  AppMockData,
  ConversationMessage,
  LearningEvent,
  Lead,
  RunRecord,
  StrategicAnalysis,
  SuggestedReply
} from "./types.js";
import { generateStrategicAdvisorAnalysisRecord, StrategicAdvisorContext } from "./strategicAdvisorAgentV1";

const agents: Agent[] = [
  {
    id: "orchestrator-agent",
    name: "Orchestrator Agent",
    role: "Coordinates multi-agent execution and handoff sequencing.",
    version: "v3.8.2",
    status: "running",
    autonomyLevel: "high_autonomy",
    lastRun: "08:41",
    totalRuns: 1842,
    successRate: 98.6,
    avgRuntimeSec: 1.8,
    primaryTriggers: ["New inbound WhatsApp message", "Lead priority jump", "Approval decision received"],
    mission:
      "Route each conversation event to the right specialist agent while enforcing escalation and approval policies.",
    triggers: ["Inbound webhook", "Priority score update", "Human approval completed"],
    expectedInputs: ["Lead context", "Last 25 messages", "Current policy profile"],
    expectedOutputs: ["Agent call plan", "Risk flags", "Next-step recommendation envelope"],
    dependencies: ["State / CRM Intelligence Agent", "Strategic Advisor Agent", "Human Approval Agent"],
    recentRuns: [
      { id: "run-2142", timestamp: "08:41", summary: "Escalated high-value lead to advisor + approval", status: "success", durationSec: 2.2 },
      { id: "run-2139", timestamp: "08:32", summary: "Skipped due to duplicate inbound event", status: "skipped", durationSec: 0.4 },
      { id: "run-2133", timestamp: "08:19", summary: "Blocked pending missing event date", status: "blocked", durationSec: 1.6 }
    ],
    recentIssues: [{ id: "issue-93", timestamp: "08:19", type: "blocked", message: "Lead missing mandatory event_date field." }]
  },
  {
    id: "strategic-advisor-agent",
    name: "Strategic Advisor Agent",
    role: "Evaluates conversion strategy and recommends next best action.",
    version: "v2.5.0",
    status: "running",
    autonomyLevel: "semi_autonomous",
    lastRun: "08:41",
    totalRuns: 1318,
    successRate: 96.9,
    avgRuntimeSec: 2.7,
    primaryTriggers: ["Orchestrator strategy request", "Stage ambiguity detected", "High-priority queue insertion"],
    mission:
      "Produce concise strategic guidance that moves each lead forward while preserving brand positioning and sales discipline.",
    triggers: ["Orchestrator invoke", "Manual Analyze Now action", "Learning drift alert"],
    expectedInputs: ["Conversation digest", "Lead lifecycle state", "Price policy"],
    expectedOutputs: ["Probable stage", "Risk/opportunity grid", "Action recommendation"],
    dependencies: ["State / CRM Intelligence Agent", "Learning Loop Agent"],
    recentRuns: [
      { id: "run-2141", timestamp: "08:41", summary: "Identified purchase intent; requested quote framing", status: "success", durationSec: 3.1 },
      { id: "run-2136", timestamp: "08:24", summary: "Waiting on human clarification for payment terms", status: "waiting_human_input", durationSec: 2.9 }
    ],
    recentIssues: []
  },
  {
    id: "reply-draft-agent",
    name: "Reply Draft Agent",
    role: "Generates multilingual WhatsApp-ready responses for operator review.",
    version: "v4.1.3",
    status: "running",
    autonomyLevel: "semi_autonomous",
    lastRun: "08:42",
    totalRuns: 2204,
    successRate: 97.3,
    avgRuntimeSec: 1.4,
    primaryTriggers: ["Strategic recommendation available", "Operator Generate Replies action", "Follow-up schedule reached"],
    mission: "Draft concise high-conversion responses with correct tone, sequencing, and qualification awareness.",
    triggers: ["Strategic advisor output", "Manual generate request", "Follow-up automation tick"],
    expectedInputs: ["Target intent", "Tone policy", "Lead language"],
    expectedOutputs: ["Reply candidates", "Intent labels", "Confidence score"],
    dependencies: ["Strategic Advisor Agent", "Human Approval Agent"],
    recentRuns: [
      { id: "run-2143", timestamp: "08:42", summary: "Generated 3 bilingual premium reply options", status: "success", durationSec: 1.2 },
      { id: "run-2138", timestamp: "08:30", summary: "Awaiting reply approval before send", status: "waiting_human_approval", durationSec: 0.9 }
    ],
    recentIssues: []
  },
  {
    id: "state-crm-intelligence-agent",
    name: "State / CRM Intelligence Agent",
    role: "Maintains lead state truth and surfaces missing fields/blockers.",
    version: "v2.9.7",
    status: "running",
    autonomyLevel: "high_autonomy",
    lastRun: "08:40",
    totalRuns: 2987,
    successRate: 99.1,
    avgRuntimeSec: 1.1,
    primaryTriggers: ["Inbound message update", "Manual lead refresh", "Run post-processing"],
    mission: "Keep stage progression, qualification completeness, and CRM signals synchronized for all active leads.",
    triggers: ["Message persisted", "Run finalized", "Lead opened in workspace"],
    expectedInputs: ["Lead record", "Conversation text", "Historical deltas"],
    expectedOutputs: ["Stage update", "Signal chips", "Missing fields list"],
    dependencies: ["Orchestrator Agent"],
    recentRuns: [
      { id: "run-2140", timestamp: "08:40", summary: "Moved lead to DEPOSIT_PENDING", status: "success", durationSec: 1.0 },
      { id: "run-2137", timestamp: "08:27", summary: "Flagged missing destination field", status: "success", durationSec: 1.3 }
    ],
    recentIssues: []
  },
  {
    id: "human-approval-agent",
    name: "Human Approval Agent",
    role: "Routes high-risk outputs to operators for controlled execution.",
    version: "v1.9.4",
    status: "degraded",
    autonomyLevel: "manual_guarded",
    lastRun: "08:38",
    totalRuns: 932,
    successRate: 93.8,
    avgRuntimeSec: 3.5,
    primaryTriggers: ["Sensitive action candidate", "Price disclosure threshold reached", "Policy confidence below threshold"],
    mission: "Guarantee that sensitive commercial decisions are explicitly validated by a human operator.",
    triggers: ["Policy gate hit", "Operator asks for escalation", "Quote update request"],
    expectedInputs: ["Proposed action", "Policy context", "Reason code"],
    expectedOutputs: ["Approval request", "Escalation rationale", "Action unlock token"],
    dependencies: ["Orchestrator Agent", "Reply Draft Agent"],
    recentRuns: [
      { id: "run-2135", timestamp: "08:38", summary: "Queued pricing approval for high-value inquiry", status: "waiting_human_approval", durationSec: 4.1 },
      { id: "run-2128", timestamp: "08:05", summary: "Rejected automatic discount disclosure", status: "success", durationSec: 3.6 }
    ],
    recentIssues: [
      {
        id: "issue-92",
        timestamp: "08:38",
        type: "error",
        message: "Approval SLA monitor delayed by 11 minutes due to queue contention."
      }
    ]
  },
  {
    id: "learning-loop-agent",
    name: "Learning Loop Agent",
    role: "Transforms human edits into actionable tuning insights.",
    version: "v1.4.8",
    status: "idle",
    autonomyLevel: "semi_autonomous",
    lastRun: "08:16",
    totalRuns: 411,
    successRate: 95.4,
    avgRuntimeSec: 5.2,
    primaryTriggers: ["Approval edited", "Reply rejected", "Daily model feedback batch"],
    mission: "Capture correction patterns and feed improvement candidates back into prompts and business rules.",
    triggers: ["Edited approval", "Rejected response", "Scheduled learning digest"],
    expectedInputs: ["Original AI draft", "Human final response", "Outcome labels"],
    expectedOutputs: ["Pattern tags", "Prompt patch suggestions", "Agent logic review tasks"],
    dependencies: ["Human Approval Agent", "Reply Draft Agent"],
    recentRuns: [
      { id: "run-2126", timestamp: "08:16", summary: "Tagged frequent 'too verbose' drift in French replies", status: "success", durationSec: 4.8 }
    ],
    recentIssues: []
  }
];

const leads: Lead[] = [
  {
    id: "lead-nadia-belhaj",
    name: "Nadia Belhaj",
    country: "Morocco",
    language: "FR",
    currentStage: "DEPOSIT_PENDING",
    priorityScore: 96,
    estimatedValue: 28400,
    eventDate: "2026-04-21",
    destination: "Casablanca",
    lastMessage: "Merci, je peux confirmer aujourd'hui si vous m'envoyez le prochain step.",
    assignedOperator: "Meryem L.",
    nextBestAction: "Share payment instructions and secure production slot.",
    approvalStatus: "pending",
    paymentIntent: "high",
    waitingReply: true,
    highValue: true,
    qualificationStatus: "complete",
    paymentStatus: "deposit_pending",
    detectedSignals: ["Urgency high", "Ready to confirm", "Asks next step"],
    missingFields: [],
    openTasks: [
      { id: "task-nadia-1", title: "Approve payment message", due: "09:10", done: false },
      { id: "task-nadia-2", title: "Attach invoice reference", due: "09:20", done: false }
    ]
  },
  {
    id: "lead-camille-roux",
    name: "Camille Roux",
    country: "France",
    language: "FR",
    currentStage: "QUALIFIED",
    priorityScore: 89,
    estimatedValue: 19700,
    eventDate: "2026-05-14",
    destination: "Marrakech",
    lastMessage: "Le tarif dépend-il du tissu final ?",
    assignedOperator: "Hassan T.",
    nextBestAction: "Answer pricing range precisely and ask commitment signal.",
    approvalStatus: "none",
    paymentIntent: "medium",
    waitingReply: true,
    highValue: true,
    qualificationStatus: "complete",
    paymentStatus: "quote_sent",
    detectedSignals: ["Price sensitivity", "Still engaged", "Comparing options"],
    missingFields: [],
    openTasks: [{ id: "task-camille-1", title: "Generate concise price clarification", due: "09:05", done: false }]
  },
  {
    id: "lead-dalia-karim",
    name: "Dalia Karim",
    country: "UAE",
    language: "EN",
    currentStage: "PRICE_SENT",
    priorityScore: 82,
    estimatedValue: 32500,
    eventDate: "2026-06-02",
    destination: "Dubai",
    lastMessage: "Can you hold the slot until tomorrow evening?",
    assignedOperator: "Meryem L.",
    nextBestAction: "Reassure hold policy and secure timeline confirmation.",
    approvalStatus: "pending",
    paymentIntent: "high",
    waitingReply: true,
    highValue: true,
    qualificationStatus: "complete",
    paymentStatus: "quote_sent",
    detectedSignals: ["Intent strong", "Timing uncertainty"],
    missingFields: [],
    openTasks: [{ id: "task-dalia-1", title: "Request hold authorization", due: "09:30", done: false }]
  },
  {
    id: "lead-omar-hadid",
    name: "Omar Hadid",
    country: "Saudi Arabia",
    language: "AR",
    currentStage: "QUALIFICATION_PENDING",
    priorityScore: 77,
    estimatedValue: 15100,
    eventDate: "2026-07-18",
    destination: "Riyadh",
    lastMessage: "Need options for July event, maybe two dresses.",
    assignedOperator: "Salma N.",
    nextBestAction: "Collect missing measurements and final event details.",
    approvalStatus: "none",
    paymentIntent: "medium",
    waitingReply: false,
    highValue: false,
    qualificationStatus: "partial",
    paymentStatus: "not_started",
    detectedSignals: ["Multi-item interest", "Date identified"],
    missingFields: ["Budget range", "Preferred silhouette"],
    openTasks: [{ id: "task-omar-1", title: "Send structured qualification prompt", due: "10:00", done: false }]
  },
  {
    id: "lead-sara-elhadi",
    name: "Sara Elhadi",
    country: "Morocco",
    language: "FR",
    currentStage: "INQUIRY",
    priorityScore: 74,
    estimatedValue: 12800,
    eventDate: "2026-08-09",
    destination: "Rabat",
    lastMessage: "Bonjour, dispo pour un fitting cette semaine ?",
    assignedOperator: "Hassan T.",
    nextBestAction: "Propose fitting slots and qualify event context.",
    approvalStatus: "none",
    paymentIntent: "low",
    waitingReply: true,
    highValue: false,
    qualificationStatus: "missing",
    paymentStatus: "not_started",
    detectedSignals: ["Inbound fresh", "Availability request"],
    missingFields: ["Event type", "Event date precision", "Budget range"],
    openTasks: [{ id: "task-sara-1", title: "Confirm event details before pricing", due: "09:50", done: false }]
  },
  {
    id: "lead-ines-lamrani",
    name: "Ines Lamrani",
    country: "Belgium",
    language: "FR",
    currentStage: "QUALIFIED",
    priorityScore: 69,
    estimatedValue: 14300,
    eventDate: "2026-09-12",
    destination: "Brussels",
    lastMessage: "Je préfère une option plus sobre, sans broderie lourde.",
    assignedOperator: "Salma N.",
    nextBestAction: "Offer toned-down style options and validate budget fit.",
    approvalStatus: "approved",
    paymentIntent: "medium",
    waitingReply: false,
    highValue: false,
    qualificationStatus: "complete",
    paymentStatus: "quote_sent",
    detectedSignals: ["Style refinement", "Clear preference"],
    missingFields: [],
    openTasks: [{ id: "task-ines-1", title: "Prepare minimal style references", due: "11:00", done: false }]
  },
  {
    id: "lead-julien-fabre",
    name: "Julien Fabre",
    country: "France",
    language: "EN",
    currentStage: "PRICE_SENT",
    priorityScore: 65,
    estimatedValue: 21400,
    eventDate: "2026-05-30",
    destination: "Paris",
    lastMessage: "If we proceed this week, can delivery still be guaranteed?",
    assignedOperator: "Meryem L.",
    nextBestAction: "Clarify production timeline and payment trigger.",
    approvalStatus: "pending",
    paymentIntent: "high",
    waitingReply: true,
    highValue: true,
    qualificationStatus: "complete",
    paymentStatus: "quote_sent",
    detectedSignals: ["Timeline pressure", "Commitment likely"],
    missingFields: [],
    openTasks: [{ id: "task-julien-1", title: "Approve timeline commitment wording", due: "09:40", done: false }]
  },
  {
    id: "lead-leila-benna",
    name: "Leila Benna",
    country: "Qatar",
    language: "EN",
    currentStage: "DEPOSIT_PENDING",
    priorityScore: 92,
    estimatedValue: 36700,
    eventDate: "2026-04-05",
    destination: "Doha",
    lastMessage: "Please send me the payment link again, I’m ready.",
    assignedOperator: "Hassan T.",
    nextBestAction: "Resend secure payment link and confirm production lock.",
    approvalStatus: "pending",
    paymentIntent: "high",
    waitingReply: true,
    highValue: true,
    qualificationStatus: "complete",
    paymentStatus: "deposit_pending",
    detectedSignals: ["Ready to pay", "Urgency high", "Repeat request"],
    missingFields: [],
    openTasks: [{ id: "task-leila-1", title: "Approve payment link resend", due: "09:00", done: false }]
  }
];

const runs: RunRecord[] = [
  {
    id: "run-2143",
    timestamp: "2026-03-09 08:42:11",
    eventType: "reply_generation",
    leadId: "lead-nadia-belhaj",
    conversationId: "wa-cn-8911",
    triggeredAgentId: "reply-draft-agent",
    decisionSummary: "Generated 3 premium FR reply drafts aligned to deposit lock objective.",
    status: "success",
    durationMs: 1240,
    nextStep: "Await approval selection",
    priority: "high",
    trace: {
      eventContext: "Lead responded with readiness to confirm today.",
      inputSnapshot: [
        "Stage: DEPOSIT_PENDING",
        "Language: FR",
        "Policy: Payment confirmation requires approved wording",
        "Last inbound intent: asks next step"
      ],
      decisionSummary: "Prioritized concise payment instruction variants with reassurance and urgency control.",
      agentsInvoked: ["Orchestrator Agent", "Strategic Advisor Agent", "Reply Draft Agent"],
      output: "Three draft replies generated, ranked by confidence 0.92 / 0.88 / 0.84.",
      timeline: [
        { id: "tl-1", time: "08:42:11", title: "Event received", detail: "Inbound message persisted", status: "info" },
        { id: "tl-2", time: "08:42:12", title: "Strategy check", detail: "Advisor confirms DEPOSIT_PENDING push", status: "success" },
        { id: "tl-3", time: "08:42:13", title: "Draft generation", detail: "Reply Draft Agent produced 3 candidates", status: "success" },
        { id: "tl-4", time: "08:42:14", title: "Approval gate", detail: "Routing to Human Approval Agent", status: "waiting_human_approval" }
      ]
    }
  },
  {
    id: "run-2142",
    timestamp: "2026-03-09 08:41:49",
    eventType: "orchestration",
    leadId: "lead-nadia-belhaj",
    conversationId: "wa-cn-8911",
    triggeredAgentId: "orchestrator-agent",
    decisionSummary: "Escalated to advisor and reply draft due to high priority + deposit intent.",
    status: "success",
    durationMs: 2210,
    nextStep: "Trigger reply generation",
    priority: "high",
    trace: {
      eventContext: "Priority score exceeded auto-handling threshold.",
      inputSnapshot: ["Priority score: 96", "Approval status: pending", "Lead value: 28.4k"],
      decisionSummary: "Selected advisor+draft path with human gate enabled.",
      agentsInvoked: ["Orchestrator Agent", "Strategic Advisor Agent"],
      output: "Run plan emitted with trace id tr-99122.",
      timeline: [
        { id: "tl-5", time: "08:41:49", title: "Priority trigger", detail: "Lead entered urgent queue", status: "info" },
        { id: "tl-6", time: "08:41:50", title: "Routing decision", detail: "Advisor path selected", status: "success" },
        { id: "tl-7", time: "08:41:51", title: "Guard applied", detail: "Approval required before send", status: "success" }
      ]
    }
  },
  {
    id: "run-2141",
    timestamp: "2026-03-09 08:41:12",
    eventType: "strategic_analysis",
    leadId: "lead-nadia-belhaj",
    conversationId: "wa-cn-8911",
    triggeredAgentId: "strategic-advisor-agent",
    decisionSummary: "Confirmed stage likely deposit pending with urgency to close in same session.",
    status: "success",
    durationMs: 3060,
    nextStep: "Draft concise approval-ready message",
    priority: "high",
    trace: {
      eventContext: "Client explicitly requested immediate next step.",
      inputSnapshot: ["Last 10 messages loaded", "Intent: ready_to_confirm", "Risk: message verbosity drift"],
      decisionSummary: "Recommend payment instruction + production lock mention in one message.",
      agentsInvoked: ["Strategic Advisor Agent"],
      output: "Strategy card emitted with confidence 0.91.",
      timeline: [
        { id: "tl-8", time: "08:41:12", title: "Context parse", detail: "Intent classified as high commitment", status: "success" },
        { id: "tl-9", time: "08:41:14", title: "Risk scan", detail: "No policy breaches detected", status: "success" }
      ]
    }
  },
  {
    id: "run-2140",
    timestamp: "2026-03-09 08:40:27",
    eventType: "state_update",
    leadId: "lead-leila-benna",
    conversationId: "wa-cn-7803",
    triggeredAgentId: "state-crm-intelligence-agent",
    decisionSummary: "Maintained DEPOSIT_PENDING and raised urgency due to repeated payment link request.",
    status: "success",
    durationMs: 1020,
    nextStep: "Queue payment approval",
    priority: "high",
    trace: {
      eventContext: "Lead asked for payment link resend.",
      inputSnapshot: ["Previous stage: DEPOSIT_PENDING", "Payment status: deposit_pending"],
      decisionSummary: "No stage change, urgency +8 points.",
      agentsInvoked: ["State / CRM Intelligence Agent"],
      output: "Lead priority score updated from 84 to 92.",
      timeline: [{ id: "tl-10", time: "08:40:27", title: "State delta", detail: "Urgency signal captured", status: "success" }]
    }
  },
  {
    id: "run-2139",
    timestamp: "2026-03-09 08:32:06",
    eventType: "orchestration",
    leadId: "lead-camille-roux",
    conversationId: "wa-cn-7711",
    triggeredAgentId: "orchestrator-agent",
    decisionSummary: "Skipped duplicate event caused by provider resend.",
    status: "skipped",
    durationMs: 420,
    nextStep: "No action",
    priority: "medium",
    trace: {
      eventContext: "Webhook duplicate detected within 3s window.",
      inputSnapshot: ["event_hash already processed"],
      decisionSummary: "Safe skip to avoid duplicate reply generation.",
      agentsInvoked: ["Orchestrator Agent"],
      output: "Run marked skipped.",
      timeline: [{ id: "tl-11", time: "08:32:06", title: "Dedup", detail: "Duplicate inbound prevented", status: "skipped" }]
    }
  },
  {
    id: "run-2138",
    timestamp: "2026-03-09 08:30:52",
    eventType: "approval_wait",
    leadId: "lead-dalia-karim",
    conversationId: "wa-cn-6620",
    triggeredAgentId: "reply-draft-agent",
    decisionSummary: "Draft prepared but waiting price hold approval.",
    status: "waiting_human_approval",
    durationMs: 910,
    nextStep: "Operator approve hold commitment",
    priority: "high",
    trace: {
      eventContext: "Client requested hold until tomorrow evening.",
      inputSnapshot: ["Hold window requested", "Policy requires manager approval for holds >12h"],
      decisionSummary: "Prepared message with conditional hold language.",
      agentsInvoked: ["Reply Draft Agent", "Human Approval Agent"],
      output: "Approval item approval-002 created.",
      timeline: [
        { id: "tl-12", time: "08:30:52", title: "Draft generated", detail: "1 candidate high confidence", status: "success" },
        { id: "tl-13", time: "08:30:53", title: "Gate hit", detail: "Hold policy requires approval", status: "waiting_human_approval" }
      ]
    }
  },
  {
    id: "run-2137",
    timestamp: "2026-03-09 08:27:15",
    eventType: "state_update",
    leadId: "lead-omar-hadid",
    conversationId: "wa-cn-5501",
    triggeredAgentId: "state-crm-intelligence-agent",
    decisionSummary: "Qualification remains partial; destination captured but budget missing.",
    status: "success",
    durationMs: 1310,
    nextStep: "Trigger missing info prompt",
    priority: "medium",
    trace: {
      eventContext: "Lead requested options for July event.",
      inputSnapshot: ["Fields complete: event_date, destination", "Fields missing: budget, silhouette"],
      decisionSummary: "Prompt should ask only two missing fields.",
      agentsInvoked: ["State / CRM Intelligence Agent"],
      output: "Missing fields list updated.",
      timeline: [{ id: "tl-14", time: "08:27:15", title: "Field sync", detail: "Missing fields recalculated", status: "success" }]
    }
  },
  {
    id: "run-2136",
    timestamp: "2026-03-09 08:24:02",
    eventType: "strategic_analysis",
    leadId: "lead-julien-fabre",
    conversationId: "wa-cn-4100",
    triggeredAgentId: "strategic-advisor-agent",
    decisionSummary: "Needs human clarification on guaranteed delivery commitment.",
    status: "waiting_human_input",
    durationMs: 2870,
    nextStep: "Operator add realistic delivery boundary",
    priority: "high",
    trace: {
      eventContext: "Lead asked if delivery is guaranteed this week.",
      inputSnapshot: ["Production capacity uncertain", "High deal value"],
      decisionSummary: "Avoid hard guarantee until ops confirms.",
      agentsInvoked: ["Strategic Advisor Agent"],
      output: "Human clarification ticket raised.",
      timeline: [
        { id: "tl-15", time: "08:24:02", title: "Strategy start", detail: "Delivery promise risk detected", status: "info" },
        { id: "tl-16", time: "08:24:05", title: "Clarification required", detail: "Needs manual production check", status: "waiting_human_input" }
      ]
    }
  },
  {
    id: "run-2135",
    timestamp: "2026-03-09 08:38:16",
    eventType: "approval_request",
    leadId: "lead-leila-benna",
    conversationId: "wa-cn-7803",
    triggeredAgentId: "human-approval-agent",
    decisionSummary: "Approval queued for payment link resend with secure language.",
    status: "waiting_human_approval",
    durationMs: 4120,
    nextStep: "Approve or edit message",
    priority: "high",
    trace: {
      eventContext: "Sensitive action policy: payment link send",
      inputSnapshot: ["Lead intent: ready_to_pay", "Stage: DEPOSIT_PENDING"],
      decisionSummary: "Queue immediate approval card.",
      agentsInvoked: ["Human Approval Agent"],
      output: "Approval item approval-001 created.",
      timeline: [{ id: "tl-17", time: "08:38:16", title: "Approval queued", detail: "Operator action required", status: "waiting_human_approval" }]
    }
  },
  {
    id: "run-2134",
    timestamp: "2026-03-09 08:21:21",
    eventType: "error_handling",
    leadId: "lead-sara-elhadi",
    conversationId: "wa-cn-3002",
    triggeredAgentId: "orchestrator-agent",
    decisionSummary: "Failed to fetch prior conversation chunk from provider timeout.",
    status: "error",
    durationMs: 5400,
    nextStep: "Retry with cached context",
    priority: "medium",
    trace: {
      eventContext: "Provider API timeout while loading message history.",
      inputSnapshot: ["Timeout at 4.8s", "Retry budget: 1 remaining"],
      decisionSummary: "Fallback path activated; run flagged for retry.",
      agentsInvoked: ["Orchestrator Agent"],
      output: "Error captured with retry scheduled.",
      timeline: [
        { id: "tl-18", time: "08:21:21", title: "Provider timeout", detail: "History API did not respond", status: "error" },
        { id: "tl-19", time: "08:21:22", title: "Retry scheduled", detail: "Will run in 90 seconds", status: "info" }
      ]
    }
  },
  {
    id: "run-2133",
    timestamp: "2026-03-09 08:19:47",
    eventType: "orchestration",
    leadId: "lead-sara-elhadi",
    conversationId: "wa-cn-3002",
    triggeredAgentId: "orchestrator-agent",
    decisionSummary: "Blocked due to missing mandatory event date before price qualification.",
    status: "blocked",
    durationMs: 1600,
    nextStep: "Request missing event date",
    priority: "medium",
    trace: {
      eventContext: "Inbound asks fitting availability without event date.",
      inputSnapshot: ["qualification_status: missing", "event_date: null"],
      decisionSummary: "Do not move to pricing until date captured.",
      agentsInvoked: ["Orchestrator Agent", "State / CRM Intelligence Agent"],
      output: "Blocked card posted in activity feed.",
      timeline: [{ id: "tl-20", time: "08:19:47", title: "Block raised", detail: "Mandatory field missing", status: "blocked" }]
    }
  },
  {
    id: "run-2128",
    timestamp: "2026-03-09 08:05:33",
    eventType: "approval_enforcement",
    leadId: "lead-camille-roux",
    conversationId: "wa-cn-7711",
    triggeredAgentId: "human-approval-agent",
    decisionSummary: "Rejected automatic discount disclosure request.",
    status: "success",
    durationMs: 3600,
    nextStep: "Propose value-first framing",
    priority: "medium",
    trace: {
      eventContext: "Draft contained premature discount mention.",
      inputSnapshot: ["Policy violation: discount_before_qualification"],
      decisionSummary: "Enforce rejection and trigger learning event.",
      agentsInvoked: ["Human Approval Agent", "Learning Loop Agent"],
      output: "Correction pattern logged as price_shared_too_early.",
      timeline: [
        { id: "tl-21", time: "08:05:33", title: "Violation detected", detail: "Discount mention before commitment", status: "info" },
        { id: "tl-22", time: "08:05:36", title: "Rejected", detail: "Reply blocked and rerouted", status: "success" }
      ]
    }
  },
  {
    id: "run-2126",
    timestamp: "2026-03-09 08:16:09",
    eventType: "learning_capture",
    leadId: "lead-camille-roux",
    conversationId: "wa-cn-7711",
    triggeredAgentId: "learning-loop-agent",
    decisionSummary: "Captured correction trend: replies too verbose in FR follow-ups.",
    status: "success",
    durationMs: 4810,
    nextStep: "Suggest prompt tightening",
    priority: "low",
    trace: {
      eventContext: "Human edited two generated replies in same style.",
      inputSnapshot: ["2 edits in 40 minutes", "avg tokens reduced by 38%"],
      decisionSummary: "Pattern confidence reached threshold.",
      agentsInvoked: ["Learning Loop Agent"],
      output: "Improvement candidate emitted.",
      timeline: [{ id: "tl-23", time: "08:16:09", title: "Pattern mined", detail: "Too verbose FR pattern detected", status: "success" }]
    }
  }
];

const activityFeed: ActivityEvent[] = [
  {
    id: "act-1",
    timestamp: "08:42",
    title: "Reply drafts generated",
    detail: "Reply Draft Agent produced 3 options for Nadia Belhaj.",
    type: "reply",
    leadId: "lead-nadia-belhaj"
  },
  {
    id: "act-2",
    timestamp: "08:41",
    title: "Strategic advisor triggered",
    detail: "High-intent signal identified; deposit push recommended.",
    type: "advisor",
    leadId: "lead-nadia-belhaj"
  },
  {
    id: "act-3",
    timestamp: "08:40",
    title: "Orchestrator triggered",
    detail: "Urgent lead routed through guarded approval flow.",
    type: "orchestrator",
    leadId: "lead-leila-benna"
  },
  {
    id: "act-4",
    timestamp: "08:38",
    title: "Waiting for human approval",
    detail: "Payment link resend requires operator validation.",
    type: "approval",
    leadId: "lead-leila-benna"
  },
  {
    id: "act-5",
    timestamp: "08:24",
    title: "Blocked by missing info",
    detail: "Delivery commitment request requires ops clarification.",
    type: "blocked",
    leadId: "lead-julien-fabre"
  },
  {
    id: "act-6",
    timestamp: "08:16",
    title: "Learning event captured",
    detail: "Correction tagged: too verbose French replies.",
    type: "learning",
    leadId: "lead-camille-roux"
  },
  {
    id: "act-7",
    timestamp: "08:12",
    title: "New inbound message",
    detail: "Leila Benna asked for payment link resend.",
    type: "inbound",
    leadId: "lead-leila-benna"
  }
];

const approvals: ApprovalItem[] = [
  {
    id: "approval-001",
    group: "Waiting Price Approval",
    leadId: "lead-leila-benna",
    urgency: "high",
    reason: "Sensitive payment link resend after expired session.",
    requestedByAgentId: "human-approval-agent",
    requestedAt: "08:38",
    contentPreview: "I can resend your secure payment link now and confirm your production slot immediately after confirmation.",
    decision: "pending"
  },
  {
    id: "approval-002",
    group: "Waiting Reply Approval",
    leadId: "lead-dalia-karim",
    urgency: "high",
    reason: "Hold policy wording requires explicit operator confirmation.",
    requestedByAgentId: "reply-draft-agent",
    requestedAt: "08:30",
    contentPreview: "We can reserve your slot until tomorrow 18:00 with confirmation in this thread.",
    decision: "pending"
  },
  {
    id: "approval-003",
    group: "Waiting Missing Info",
    leadId: "lead-omar-hadid",
    urgency: "medium",
    reason: "Budget and silhouette still missing before price frame.",
    requestedByAgentId: "state-crm-intelligence-agent",
    requestedAt: "08:27",
    contentPreview: "Before I share precise options, may I confirm your expected budget range and preferred silhouette?",
    decision: "pending"
  },
  {
    id: "approval-004",
    group: "Waiting Sensitive Action Approval",
    leadId: "lead-julien-fabre",
    urgency: "high",
    reason: "Delivery guarantee phrasing could create legal exposure.",
    requestedByAgentId: "strategic-advisor-agent",
    requestedAt: "08:24",
    contentPreview: "If payment is completed this week, we can prioritize your order with confirmed delivery window after ops validation.",
    decision: "pending"
  }
];

const learningEvents: LearningEvent[] = [
  {
    id: "learn-001",
    timestamp: "08:16",
    leadId: "lead-camille-roux",
    aiSuggestion:
      "Merci beaucoup pour votre retour. Nous pouvons vous proposer une solution élégante adaptée à votre budget et organiser les étapes suivantes en douceur.",
    finalHumanVersion: "Parfait, je vous envoie deux options claires avec le budget correspondant.",
    deltaSummary: "Reduced verbosity, clearer next step, stronger commercial direction.",
    correctionPattern: "too verbose"
  },
  {
    id: "learn-002",
    timestamp: "07:54",
    leadId: "lead-ines-lamrani",
    aiSuggestion: "We can discuss pricing after your preferences are complete.",
    finalHumanVersion: "Je vous partage d'abord les styles sobres, puis le tarif précis juste après.",
    deltaSummary: "Made tone warmer and more natural in lead language.",
    correctionPattern: "not natural enough"
  },
  {
    id: "learn-003",
    timestamp: "07:26",
    leadId: "lead-julien-fabre",
    aiSuggestion: "We guarantee delivery this week.",
    finalHumanVersion: "Nous pouvons prioriser la production et confirmer le créneau exact après validation atelier.",
    deltaSummary: "Removed risky guarantee, aligned with policy.",
    correctionPattern: "too direct"
  },
  {
    id: "learn-004",
    timestamp: "07:02",
    leadId: "lead-sara-elhadi",
    aiSuggestion: "Here is our pricing range for custom work.",
    finalHumanVersion: "Avant le tarif, je peux confirmer la date de votre événement pour vous orienter précisément ?",
    deltaSummary: "Delayed price sharing until qualification complete.",
    correctionPattern: "price shared too early"
  }
];

const suggestedReplies: SuggestedReply[] = [
  {
    id: "reply-001",
    leadId: "lead-nadia-belhaj",
    label: "Close the deposit",
    intent: "Secure payment confirmation",
    tone: "Confident, premium, concise",
    language: "FR",
    content:
      "Parfait Nadia, je vous envoie le lien de règlement sécurisé maintenant. Dès confirmation, nous bloquons votre créneau de production immédiatement."
  },
  {
    id: "reply-002",
    leadId: "lead-nadia-belhaj",
    label: "Reassure + next step",
    intent: "Reduce friction and guide",
    tone: "Warm, elegant",
    language: "FR",
    content:
      "Merci Nadia. Je vous partage le prochain step en une seule action: règlement sécurisé puis validation instantanée de votre réservation atelier."
  },
  {
    id: "reply-003",
    leadId: "lead-nadia-belhaj",
    label: "Soft commitment",
    intent: "Confirm readiness before payment",
    tone: "Consultative",
    language: "FR",
    content:
      "Souhaitez-vous que je vous envoie le lien de confirmation maintenant pour sécuriser votre place aujourd'hui ?"
  }
];

const conversations: ConversationMessage[] = [
  {
    id: "msg-001",
    leadId: "lead-nadia-belhaj",
    actor: "brand",
    text: "Bonjour Nadia, votre création est prête pour la prochaine étape dès que vous validez.",
    timestamp: "08:12",
    state: "read"
  },
  {
    id: "msg-002",
    leadId: "lead-nadia-belhaj",
    actor: "client",
    text: "Super, je veux avancer aujourd'hui. Quel est le prochain step ?",
    timestamp: "08:14",
    state: "read"
  },
  {
    id: "msg-003",
    leadId: "lead-nadia-belhaj",
    actor: "operator",
    text: "Parfait. Je confirme en interne et je vous envoie l'instruction immédiatement.",
    timestamp: "08:15",
    state: "read"
  },
  {
    id: "msg-004",
    leadId: "lead-nadia-belhaj",
    actor: "client",
    text: "Merci, je peux confirmer aujourd'hui si vous m'envoyez le prochain step.",
    timestamp: "08:39",
    state: "read",
    replyTo: {
      actor: "operator",
      text: "Je vous envoie l'instruction immédiatement."
    }
  },
  {
    id: "msg-005",
    leadId: "lead-nadia-belhaj",
    actor: "brand",
    text: "Je prépare votre confirmation sécurisée dans ce fil.",
    timestamp: "08:40",
    state: "delivered"
  },
  {
    id: "msg-006",
    leadId: "lead-leila-benna",
    actor: "client",
    text: "Please send me the payment link again, I'm ready.",
    timestamp: "08:12",
    state: "read"
  },
  {
    id: "msg-007",
    leadId: "lead-leila-benna",
    actor: "operator",
    text: "Absolutely, I’m requesting secure resend now.",
    timestamp: "08:13",
    state: "read"
  }
];

function toIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(" ", "T");
  return normalized.includes("Z") ? normalized : `${normalized}Z`;
}

function buildStrategicAdvisorContext(lead: Lead): StrategicAdvisorContext {
  const latestRun = runs.find((run) => run.leadId === lead.id) ?? null;
  const recentMessages = conversations.filter((message) => message.leadId === lead.id).slice(-6);
  const lastOperatorMessage = [...recentMessages].reverse().find((message) => message.actor === "operator");

  return {
    lead,
    conversation: {
      id: latestRun?.conversationId ?? `wa-${lead.id}`,
      label: `Conversation ${latestRun?.conversationId ?? lead.id}`
    },
    recentMessages,
    currentStage: lead.currentStage,
    signals: lead.detectedSignals,
    priorityScore: lead.priorityScore,
    openTasks: lead.openTasks,
    missingFields: lead.missingFields,
    lastOperatorAction: lastOperatorMessage?.text ?? null,
    generatedAt: toIsoTimestamp(latestRun?.timestamp)
  };
}

const strategicAdvisorRecords = leads.map((lead) => generateStrategicAdvisorAnalysisRecord(buildStrategicAdvisorContext(lead)));
const strategicAnalyses: StrategicAnalysis[] = strategicAdvisorRecords.map((record) => record.output);

export const mockData: AppMockData = {
  agents,
  leads,
  runs,
  activityFeed,
  approvals,
  learningEvents,
  suggestedReplies,
  strategicAnalyses,
  conversations
};

export const byId = {
  lead: Object.fromEntries(leads.map((lead) => [lead.id, lead])),
  agent: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
  strategicAnalysis: Object.fromEntries(strategicAnalyses.map((analysis) => [analysis.leadId, analysis])),
  strategicAdvisorRecord: Object.fromEntries(strategicAdvisorRecords.map((record) => [record.leadId, record]))
};
