export type BrainNodeType =
  | "trigger"
  | "ai_step"
  | "condition"
  | "human_review"
  | "automation"
  | "delay"
  | "webhook"
  | "metrics";

export interface SystemBrainKpi {
  id: string;
  label: string;
  value: string;
  delta: string;
  tone: "neutral" | "good" | "attention";
}

export interface ArchitectureNode {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  promptVersion: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  failRate: number;
  p95LatencyMs: number;
  cacheBehavior: string;
  dependencies: string[];
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label: string;
}

export interface FlowRule {
  id: string;
  trigger: string;
  condition: string;
  action: string;
  status: "active" | "staging" | "disabled";
  version: string;
}

export interface PromptVersionRecord {
  id: string;
  version: string;
  environment: "draft" | "staging" | "production";
  providerCompatibility: string[];
  tokenSize: number;
  status: "active" | "rollback_available" | "deprecated";
  updatedAt: string;
  updatedBy: string;
  diffSummary: string;
}

export interface PromptDefinitionRecord {
  id: string;
  name: string;
  purpose: string;
  activeVersion: string;
  versions: PromptVersionRecord[];
}

export interface StepPerformanceRow {
  step: string;
  provider: string;
  model: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  fallbackRate: number;
  cacheHitRate: number;
  inflightJoinRate: number;
}

export interface TokenEconomyPoint {
  day: string;
  totalTokens: number;
  totalCostUsd: number;
}

export interface EventLogRow {
  id: string;
  timestamp: string;
  leadId: string;
  step: string;
  provider: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cache: "hit" | "miss";
  joinedInflight: boolean;
  fallbackTriggered: boolean;
  error: string | null;
}

export interface LeadTraceStep {
  id: string;
  title: string;
  promptVersion: string;
  provider: string;
  model: string;
  summary: string;
  tokens: { in: number; out: number; costUsd: number };
}

export interface LeadDebuggerTrace {
  leadId: string;
  leadName: string;
  latestInbound: string;
  stageResult: string;
  strategyResult: string;
  replyResult: string;
  brandGuardianResult: string;
  finalOutput: string;
  snapshotId: string;
  steps: LeadTraceStep[];
}

export interface PipelineEditorNode {
  id: string;
  type: BrainNodeType;
  label: string;
  x: number;
  y: number;
  metadata: {
    provider?: string;
    model?: string;
    condition?: string;
    version?: string;
    approvalRequired?: boolean;
  };
}

export interface PipelineEditorEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: "default" | "fallback" | "condition_true" | "condition_false";
}

export interface MobileLabSystemBrainData {
  kpis: SystemBrainKpi[];
  architecture: { nodes: ArchitectureNode[]; edges: ArchitectureEdge[] };
  flowRules: FlowRule[];
  prompts: PromptDefinitionRecord[];
  stepPerformance: StepPerformanceRow[];
  tokenEconomy: TokenEconomyPoint[];
  logs: EventLogRow[];
  debugger: LeadDebuggerTrace[];
  pipelineEditor: {
    nodes: PipelineEditorNode[];
    edges: PipelineEditorEdge[];
    publishedVersion: string;
    draftVersion: string;
  };
}
