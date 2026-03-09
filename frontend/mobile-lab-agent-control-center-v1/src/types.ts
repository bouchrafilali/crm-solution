export type NavPage =
  | "dashboard"
  | "agents"
  | "runs"
  | "leads"
  | "lead-workspace"
  | "approvals"
  | "learning"
  | "system-architecture-map";

export type AgentStatus = "running" | "idle" | "degraded" | "paused";

export type RunStatus =
  | "success"
  | "waiting_human_input"
  | "waiting_human_approval"
  | "blocked"
  | "error"
  | "skipped";

export type ApprovalGroup =
  | "Waiting Price Approval"
  | "Waiting Reply Approval"
  | "Waiting Missing Info"
  | "Waiting Sensitive Action Approval";

export type ApprovalDecision = "pending" | "approved" | "rejected";

export type StrategicAdvisorStage =
  | "NEW"
  | "PRODUCT_INTEREST"
  | "QUALIFICATION_PENDING"
  | "QUALIFIED"
  | "PRICE_SENT"
  | "VIDEO_PROPOSED"
  | "DEPOSIT_PENDING"
  | "CONFIRMED"
  | "CONVERTED"
  | "LOST";

export type StrategicAdvisorMomentum = "low" | "medium" | "high" | "critical";

export type StrategicAdvisorActionType =
  | "clarify_missing_info"
  | "qualify_before_price"
  | "send_contextualized_price"
  | "reassure_and_progress"
  | "propose_video_call"
  | "advance_to_deposit"
  | "reactivate_gently"
  | "hold_until_confirmation"
  | "route_to_human_approval";

export type StrategicAdvisorPriority = "low" | "medium" | "high" | "critical";

export interface AgentRunSummary {
  id: string;
  timestamp: string;
  summary: string;
  status: RunStatus;
  durationSec: number;
}

export interface AgentIssue {
  id: string;
  timestamp: string;
  type: "blocked" | "error";
  message: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  version: string;
  status: AgentStatus;
  autonomyLevel: "manual_guarded" | "semi_autonomous" | "high_autonomy";
  lastRun: string;
  totalRuns: number;
  successRate: number;
  avgRuntimeSec: number;
  primaryTriggers: string[];
  mission: string;
  triggers: string[];
  expectedInputs: string[];
  expectedOutputs: string[];
  dependencies: string[];
  recentRuns: AgentRunSummary[];
  recentIssues: AgentIssue[];
}

export interface Lead {
  id: string;
  name: string;
  country: string;
  language: string;
  currentStage: string;
  priorityScore: number;
  estimatedValue: number;
  eventDate: string;
  destination: string;
  lastMessage: string;
  assignedOperator: string;
  nextBestAction: string;
  approvalStatus: "none" | "pending" | "approved" | "rejected";
  paymentIntent: "low" | "medium" | "high";
  waitingReply: boolean;
  highValue: boolean;
  qualificationStatus: "complete" | "partial" | "missing";
  paymentStatus: "not_started" | "quote_sent" | "deposit_pending" | "confirmed";
  detectedSignals: string[];
  missingFields: string[];
  openTasks: Array<{ id: string; title: string; due: string; done: boolean }>;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  title: string;
  detail: string;
  type:
    | "inbound"
    | "orchestrator"
    | "advisor"
    | "reply"
    | "approval"
    | "blocked"
    | "learning";
  leadId: string;
}

export interface RunRecord {
  id: string;
  timestamp: string;
  eventType: string;
  leadId: string;
  conversationId: string;
  triggeredAgentId: string;
  decisionSummary: string;
  status: RunStatus;
  durationMs: number;
  nextStep: string;
  priority: "high" | "medium" | "low";
  trace: {
    eventContext: string;
    inputSnapshot: string[];
    decisionSummary: string;
    agentsInvoked: string[];
    output: string;
    timeline: Array<{ id: string; time: string; title: string; detail: string; status: RunStatus | "info" }>;
  };
}

export interface ApprovalItem {
  id: string;
  group: ApprovalGroup;
  leadId: string;
  urgency: "high" | "medium" | "low";
  reason: string;
  requestedByAgentId: string;
  requestedAt: string;
  contentPreview: string;
  decision: ApprovalDecision;
}

export interface LearningEvent {
  id: string;
  timestamp: string;
  leadId: string;
  aiSuggestion: string;
  finalHumanVersion: string;
  deltaSummary: string;
  correctionPattern: string;
}

export interface SuggestedReply {
  id: string;
  leadId: string;
  label: string;
  intent: string;
  tone: string;
  language: string;
  content: string;
}

export interface StrategicAnalysis {
  leadId: string;
  probableStage: StrategicAdvisorStage;
  stageConfidence: number;
  momentum: StrategicAdvisorMomentum;
  priorityRecommendation: StrategicAdvisorPriority;
  keySignals: string[];
  risks: string[];
  opportunities: string[];
  missingInformation: string[];
  nextBestAction: StrategicAdvisorActionType;
  replyObjective: string;
  rationale: string;
  humanApprovalRequired: boolean;
}

export interface ConversationMessage {
  id: string;
  leadId: string;
  actor: "client" | "operator" | "brand";
  text: string;
  timestamp: string;
  state: "sent" | "delivered" | "read";
  replyTo?: { actor: string; text: string };
}

export interface AppMockData {
  agents: Agent[];
  leads: Lead[];
  runs: RunRecord[];
  activityFeed: ActivityEvent[];
  approvals: ApprovalItem[];
  learningEvents: LearningEvent[];
  suggestedReplies: SuggestedReply[];
  strategicAnalyses: StrategicAnalysis[];
  conversations: ConversationMessage[];
}
