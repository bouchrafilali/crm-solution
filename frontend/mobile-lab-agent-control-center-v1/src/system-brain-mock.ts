import { MobileLabSystemBrainData } from "./system-brain-types.js";

export const systemBrainMock: MobileLabSystemBrainData = {
  kpis: [
    { id: "agents", label: "Agents Active", value: "12", delta: "2 degraded", tone: "attention" },
    { id: "providers", label: "Providers Active", value: "2", delta: "Claude + OpenAI", tone: "neutral" },
    { id: "prompt-versions", label: "Prompt Versions", value: "34", delta: "8 in production", tone: "neutral" },
    { id: "tokens", label: "Token Spend Today", value: "$182.40", delta: "-11.2% vs yesterday", tone: "good" },
    { id: "orchestrator", label: "Orchestrator Health", value: "99.21%", delta: "p95 1.9s", tone: "good" },
    { id: "cache", label: "Cache Health", value: "86.4%", delta: "step cache hit", tone: "good" },
    { id: "fallback", label: "Fallback Activity", value: "2.8%", delta: "infra-only fallback", tone: "neutral" },
    { id: "incident", label: "Last Incident", value: "03:14 UTC", delta: "resolved in 6m", tone: "attention" }
  ],
  architecture: {
    nodes: [
      {
        id: "whatsapp-message",
        name: "WhatsApp Message Trigger",
        role: "Ingress event normalization and dedupe",
        provider: "internal",
        model: "rule-engine",
        promptVersion: "n/a",
        avgInputTokens: 0,
        avgOutputTokens: 0,
        failRate: 0.2,
        p95LatencyMs: 38,
        cacheBehavior: "ID + window dedupe",
        dependencies: ["Webhook"]
      },
      {
        id: "stage-detection",
        name: "Stage Detection",
        role: "Lifecycle stage inference + next action intent",
        provider: "claude",
        model: "claude-haiku-4-5",
        promptVersion: "stage_detection@v2.4.1",
        avgInputTokens: 1190,
        avgOutputTokens: 214,
        failRate: 1.4,
        p95LatencyMs: 1610,
        cacheBehavior: "single-flight + keyed cache",
        dependencies: ["Transcript Formatter", "Token Budget Guard"]
      },
      {
        id: "strategic-advisor",
        name: "Strategic Advisor",
        role: "Commercial strategy and action recommendation",
        provider: "claude",
        model: "claude-haiku-4-5",
        promptVersion: "strategic_advisor@v3.1.0",
        avgInputTokens: 890,
        avgOutputTokens: 173,
        failRate: 1.1,
        p95LatencyMs: 1432,
        cacheBehavior: "single-flight + keyed cache",
        dependencies: ["Stage Detection"]
      },
      {
        id: "reply-generator",
        name: "Reply Generator",
        role: "High-conversion message option synthesis",
        provider: "openai",
        model: "gpt-4.1-mini",
        promptVersion: "reply_generator@v4.6.2",
        avgInputTokens: 1354,
        avgOutputTokens: 411,
        failRate: 1.8,
        p95LatencyMs: 1906,
        cacheBehavior: "single-flight + result cache",
        dependencies: ["Strategic Advisor"]
      },
      {
        id: "brand-guardian",
        name: "Brand Guardian",
        role: "Tone, compliance, and luxury positioning gate",
        provider: "openai",
        model: "gpt-4.1-mini",
        promptVersion: "brand_guardian@v2.2.3",
        avgInputTokens: 522,
        avgOutputTokens: 144,
        failRate: 0.9,
        p95LatencyMs: 1220,
        cacheBehavior: "review cache + single-flight",
        dependencies: ["Reply Generator"]
      },
      {
        id: "operator-send",
        name: "Operator / Automation Send Path",
        role: "Human approval or auto-send execution",
        provider: "internal",
        model: "policy-engine",
        promptVersion: "send_policies@v1.7.0",
        avgInputTokens: 0,
        avgOutputTokens: 0,
        failRate: 0.4,
        p95LatencyMs: 91,
        cacheBehavior: "idempotent event key",
        dependencies: ["Brand Guardian", "Approvals"]
      }
    ],
    edges: [
      { from: "whatsapp-message", to: "stage-detection", label: "NEW_MESSAGE" },
      { from: "stage-detection", to: "strategic-advisor", label: "STAGE_READY" },
      { from: "strategic-advisor", to: "reply-generator", label: "STRATEGY_READY" },
      { from: "reply-generator", to: "brand-guardian", label: "REPLY_READY" },
      { from: "brand-guardian", to: "operator-send", label: "APPROVED" }
    ]
  },
  flowRules: [
    {
      id: "fr-01",
      trigger: "NEW_MESSAGE",
      condition: "direction=IN AND dedupe=false",
      action: "run stage_detection",
      status: "active",
      version: "flow@2.8.0"
    },
    {
      id: "fr-02",
      trigger: "STAGE_READY",
      condition: "stage in (QUALIFIED, PRICE_SENT, DEPOSIT_PENDING)",
      action: "run strategic_advisor",
      status: "active",
      version: "flow@2.8.0"
    },
    {
      id: "fr-03",
      trigger: "STRATEGY_READY",
      condition: "confidence>=0.55",
      action: "run reply_generator",
      status: "active",
      version: "flow@2.8.0"
    },
    {
      id: "fr-04",
      trigger: "REPLY_READY",
      condition: "sensitive_action=false",
      action: "run brand_guardian",
      status: "active",
      version: "flow@2.8.0"
    },
    {
      id: "fr-05",
      trigger: "BRAND_READY",
      condition: "approval_required=true",
      action: "route to human_review",
      status: "staging",
      version: "flow@2.9.0-rc1"
    }
  ],
  prompts: [
    {
      id: "pd-stage",
      name: "Stage Detection Prompt",
      purpose: "Infer stage and next action from transcript",
      activeVersion: "v2.4.1",
      versions: [
        {
          id: "pd-stage-v241",
          version: "v2.4.1",
          environment: "production",
          providerCompatibility: ["claude-haiku-4-5", "gpt-4.1-mini"],
          tokenSize: 732,
          status: "active",
          updatedAt: "2026-03-09T19:42:00Z",
          updatedBy: "ops@mobilelab",
          diffSummary: "Compressed schema block, tightened stage constraints"
        },
        {
          id: "pd-stage-v242",
          version: "v2.4.2",
          environment: "staging",
          providerCompatibility: ["claude-haiku-4-5"],
          tokenSize: 689,
          status: "rollback_available",
          updatedAt: "2026-03-10T01:15:00Z",
          updatedBy: "ops@mobilelab",
          diffSummary: "Added budget guard + urgency hint"
        }
      ]
    },
    {
      id: "pd-strategy",
      name: "Strategic Advisor Prompt",
      purpose: "Generate commercial strategy and move recommendation",
      activeVersion: "v3.1.0",
      versions: [
        {
          id: "pd-strategy-v310",
          version: "v3.1.0",
          environment: "production",
          providerCompatibility: ["claude-haiku-4-5"],
          tokenSize: 604,
          status: "active",
          updatedAt: "2026-03-08T23:58:00Z",
          updatedBy: "revops@mobilelab",
          diffSummary: "Reduced redundant rationale requirements"
        }
      ]
    },
    {
      id: "pd-reply",
      name: "Reply Generator Prompt",
      purpose: "Produce high-conversion response options",
      activeVersion: "v4.6.2",
      versions: [
        {
          id: "pd-reply-v462",
          version: "v4.6.2",
          environment: "production",
          providerCompatibility: ["gpt-4.1-mini"],
          tokenSize: 811,
          status: "active",
          updatedAt: "2026-03-10T03:20:00Z",
          updatedBy: "product@mobilelab",
          diffSummary: "Added deposit-intent microcopy guard"
        }
      ]
    }
  ],
  stepPerformance: [
    {
      step: "stage_detection",
      provider: "claude",
      model: "claude-haiku-4-5",
      avgInputTokens: 1190,
      avgOutputTokens: 214,
      avgCostUsd: 0.0031,
      p50LatencyMs: 920,
      p95LatencyMs: 1610,
      successRate: 98.6,
      fallbackRate: 1.1,
      cacheHitRate: 84.2,
      inflightJoinRate: 22.1
    },
    {
      step: "strategic_advisor",
      provider: "claude",
      model: "claude-haiku-4-5",
      avgInputTokens: 890,
      avgOutputTokens: 173,
      avgCostUsd: 0.0024,
      p50LatencyMs: 870,
      p95LatencyMs: 1432,
      successRate: 98.9,
      fallbackRate: 0.9,
      cacheHitRate: 82.6,
      inflightJoinRate: 19.4
    },
    {
      step: "reply_generator",
      provider: "openai",
      model: "gpt-4.1-mini",
      avgInputTokens: 1354,
      avgOutputTokens: 411,
      avgCostUsd: 0.0052,
      p50LatencyMs: 1184,
      p95LatencyMs: 1906,
      successRate: 98.1,
      fallbackRate: 0.0,
      cacheHitRate: 77.8,
      inflightJoinRate: 16.2
    },
    {
      step: "brand_guardian",
      provider: "openai",
      model: "gpt-4.1-mini",
      avgInputTokens: 522,
      avgOutputTokens: 144,
      avgCostUsd: 0.0019,
      p50LatencyMs: 746,
      p95LatencyMs: 1220,
      successRate: 99.1,
      fallbackRate: 0.0,
      cacheHitRate: 88.7,
      inflightJoinRate: 11.9
    }
  ],
  tokenEconomy: [
    { day: "Mar 05", totalTokens: 812300, totalCostUsd: 241.2 },
    { day: "Mar 06", totalTokens: 744100, totalCostUsd: 216.9 },
    { day: "Mar 07", totalTokens: 701550, totalCostUsd: 204.1 },
    { day: "Mar 08", totalTokens: 688200, totalCostUsd: 198.3 },
    { day: "Mar 09", totalTokens: 642880, totalCostUsd: 186.2 },
    { day: "Mar 10", totalTokens: 625440, totalCostUsd: 182.4 }
  ],
  logs: [
    {
      id: "ev-1",
      timestamp: "2026-03-10T03:11:12Z",
      leadId: "lead-nadia-belhaj",
      step: "stage_detection",
      provider: "claude",
      status: "success",
      inputTokens: 1221,
      outputTokens: 218,
      latencyMs: 902,
      cache: "miss",
      joinedInflight: false,
      fallbackTriggered: false,
      error: null
    },
    {
      id: "ev-2",
      timestamp: "2026-03-10T03:11:13Z",
      leadId: "lead-nadia-belhaj",
      step: "strategic_advisor",
      provider: "claude",
      status: "success",
      inputTokens: 843,
      outputTokens: 164,
      latencyMs: 781,
      cache: "hit",
      joinedInflight: true,
      fallbackTriggered: false,
      error: null
    },
    {
      id: "ev-3",
      timestamp: "2026-03-10T03:11:16Z",
      leadId: "lead-camille-roux",
      step: "reply_generator",
      provider: "openai",
      status: "success",
      inputTokens: 1467,
      outputTokens: 437,
      latencyMs: 1364,
      cache: "miss",
      joinedInflight: false,
      fallbackTriggered: false,
      error: null
    }
  ],
  debugger: [
    {
      leadId: "lead-nadia-belhaj",
      leadName: "Nadia Belhaj",
      latestInbound: "Merci, je peux confirmer aujourd'hui si vous m'envoyez le prochain step.",
      stageResult: "DEPOSIT_PENDING (0.93)",
      strategyResult: "advance_to_deposit",
      replyResult: "Option 2 selected: payment clarity + slot urgency",
      brandGuardianResult: "Approved (tone premium, low pressure)",
      finalOutput: "Parfait Nadia. Je vous envoie le lien de réservation sécurisé et je bloque l’atelier immédiatement.",
      snapshotId: "snap_20260310_031112_nadia",
      steps: [
        {
          id: "dbg-stage",
          title: "Stage Detection",
          promptVersion: "stage_detection@v2.4.1",
          provider: "claude",
          model: "claude-haiku-4-5",
          summary: "Detected high purchase intent and immediate next-step readiness.",
          tokens: { in: 1221, out: 218, costUsd: 0.0032 }
        },
        {
          id: "dbg-strategy",
          title: "Strategic Advisor",
          promptVersion: "strategic_advisor@v3.1.0",
          provider: "claude",
          model: "claude-haiku-4-5",
          summary: "Recommended low-friction payment progression with commitment framing.",
          tokens: { in: 843, out: 164, costUsd: 0.0023 }
        },
        {
          id: "dbg-reply",
          title: "Reply Generator",
          promptVersion: "reply_generator@v4.6.2",
          provider: "openai",
          model: "gpt-4.1-mini",
          summary: "Generated 3 options, selected option #2 by confidence and brevity.",
          tokens: { in: 1304, out: 392, costUsd: 0.0049 }
        }
      ]
    }
  ],
  pipelineEditor: {
    publishedVersion: "flow@2.8.0",
    draftVersion: "flow@2.9.0-rc1",
    nodes: [
      { id: "n-trigger", type: "trigger", label: "New WhatsApp Message", x: 80, y: 80, metadata: { version: "v1" } },
      { id: "n-stage", type: "ai_step", label: "Stage Detection", x: 360, y: 80, metadata: { provider: "claude", model: "claude-haiku-4-5", version: "v2.4.1" } },
      { id: "n-strategy", type: "ai_step", label: "Strategic Advisor", x: 640, y: 80, metadata: { provider: "claude", model: "claude-haiku-4-5", version: "v3.1.0" } },
      { id: "n-reply", type: "ai_step", label: "Reply Generator", x: 920, y: 80, metadata: { provider: "openai", model: "gpt-4.1-mini", version: "v4.6.2" } },
      { id: "n-condition", type: "condition", label: "Sensitive Action?", x: 920, y: 260, metadata: { condition: "contains_price_override OR legal_risk" } },
      { id: "n-brand", type: "ai_step", label: "Brand Guardian", x: 1200, y: 80, metadata: { provider: "openai", model: "gpt-4.1-mini", version: "v2.2.3" } },
      { id: "n-human", type: "human_review", label: "Human Review", x: 1200, y: 260, metadata: { approvalRequired: true } },
      { id: "n-send", type: "automation", label: "Auto Send / Operator Send", x: 1480, y: 80, metadata: { version: "v1.7.0" } }
    ],
    edges: [
      { id: "e1", from: "n-trigger", to: "n-stage", label: "new_message", kind: "default" },
      { id: "e2", from: "n-stage", to: "n-strategy", label: "stage_ready", kind: "default" },
      { id: "e3", from: "n-strategy", to: "n-reply", label: "strategy_ready", kind: "default" },
      { id: "e4", from: "n-reply", to: "n-condition", label: "evaluate_risk", kind: "default" },
      { id: "e5", from: "n-condition", to: "n-brand", label: "false", kind: "condition_false" },
      { id: "e6", from: "n-condition", to: "n-human", label: "true", kind: "condition_true" },
      { id: "e7", from: "n-brand", to: "n-send", label: "approved", kind: "default" },
      { id: "e8", from: "n-human", to: "n-send", label: "approved", kind: "default" }
    ]
  }
};
