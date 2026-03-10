import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import {
  detectStageFromTranscript,
  type StageDetectionResult
} from "./whatsappStageDetectionService.js";
import {
  buildStrategicAdvisorFromContext,
  type StrategicAdvisorResult
} from "./whatsappStrategicAdvisorService.js";
import {
  buildReplyGeneratorFromContext,
  type ReplyGeneratorResult
} from "./whatsappReplyGeneratorService.js";
import {
  buildBrandGuardianFromContext,
  type BrandGuardianResult
} from "./whatsappBrandGuardianService.js";

export type AiCardsStep = "transcript" | "stage_detection" | "strategic_advisor" | "reply_generator" | "brand_guardian";

export class AiCardsOrchestrationError extends Error {
  step: AiCardsStep;

  constructor(step: AiCardsStep, message: string, options?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type AiCardsViewModel = {
  leadId: string;
  summary: {
    stage: string;
    stageConfidence: number;
    urgency: string;
    paymentIntent: boolean;
    dropoffRisk: string;
    priorityScore: number;
  };
  strategy: {
    recommendedAction: string;
    commercialPriority: string;
    tone: string;
    pressureLevel: string;
    primaryGoal: string;
    secondaryGoal: string;
  };
  signals: Array<{ type: string; evidence: string }>;
  facts: {
    productsOfInterest: string[];
    eventDate: string | null;
    deliveryDeadline: string | null;
    destinationCountry: string | null;
    budget: string | null;
    pricePointsDetected: Array<string | number>;
    customizationRequests: string[];
    preferredColors: string[];
    preferredFabrics: string[];
    paymentMethodPreference: string | null;
  };
  replyCards: Array<{
    label: string;
    intent: string;
    messages: string[];
    reason_short?: string;
  }>;
  brandGuardian: {
    approved: boolean;
    issues: string[];
  };
  meta: {
    messageCount: number;
    transcriptLength: number;
    provider: string;
    model: string;
    timestamp: string;
  };
};

type AiCardsDeps = {
  getTranscript: (leadId: string) => Promise<LeadTranscriptResult>;
  getStageDetection: (input: { leadId: string; transcript: LeadTranscriptResult }) => Promise<StageDetectionResult>;
  getStrategicAdvisor: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageDetection: StageDetectionResult;
  }) => Promise<StrategicAdvisorResult>;
  getReplyGenerator: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageDetection: StageDetectionResult;
    strategicAdvisor: StrategicAdvisorResult;
  }) => Promise<ReplyGeneratorResult>;
  getBrandGuardian: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageDetection: StageDetectionResult;
    strategicAdvisor: StrategicAdvisorResult;
    replyGenerator: ReplyGeneratorResult;
  }) => Promise<BrandGuardianResult>;
};

function defaultDeps(): AiCardsDeps {
  return {
    getTranscript: (leadId: string) => buildLeadTranscript(leadId, 30),
    getStageDetection: (input) => detectStageFromTranscript({ leadId: input.leadId, transcript: input.transcript }),
    getStrategicAdvisor: (input) =>
      buildStrategicAdvisorFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageDetection.analysis
      }),
    getReplyGenerator: (input) =>
      buildReplyGeneratorFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageDetection.analysis,
        strategy: input.strategicAdvisor.strategy
      }),
    getBrandGuardian: (input) =>
      buildBrandGuardianFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageDetection.analysis,
        strategy: input.strategicAdvisor.strategy,
        replyOptions: input.replyGenerator.replyOptions
      })
  };
}

function mapToViewModel(input: {
  leadId: string;
  stageDetection: StageDetectionResult;
  strategicAdvisor: StrategicAdvisorResult;
  brandGuardian: BrandGuardianResult;
}): AiCardsViewModel {
  const stage = input.stageDetection.analysis;
  const strategy = input.strategicAdvisor.strategy;
  const review = input.brandGuardian.review;

  return {
    leadId: input.leadId,
    summary: {
      stage: stage.stage,
      stageConfidence: stage.stage_confidence,
      urgency: stage.urgency,
      paymentIntent: stage.payment_intent,
      dropoffRisk: stage.dropoff_risk,
      priorityScore: stage.priority_score
    },
    strategy: {
      recommendedAction: strategy.recommended_action,
      commercialPriority: strategy.commercial_priority,
      tone: strategy.tone,
      pressureLevel: strategy.pressure_level,
      primaryGoal: strategy.primary_goal,
      secondaryGoal: strategy.secondary_goal
    },
    signals: stage.signals.map((signal) => ({ type: signal.type, evidence: signal.evidence })),
    facts: {
      productsOfInterest: stage.facts.products_of_interest,
      eventDate: stage.facts.event_date,
      deliveryDeadline: stage.facts.delivery_deadline,
      destinationCountry: stage.facts.destination_country,
      budget: stage.facts.budget,
      pricePointsDetected: stage.facts.price_points_detected,
      customizationRequests: stage.facts.customization_requests,
      preferredColors: stage.facts.preferred_colors,
      preferredFabrics: stage.facts.preferred_fabrics,
      paymentMethodPreference: stage.facts.payment_method_preference
    },
    replyCards: review.reply_options.map((option) => ({
      label: option.label,
      intent: option.intent,
      messages: option.messages,
      ...(typeof option.reason_short === "string" && option.reason_short.trim()
        ? { reason_short: option.reason_short.trim() }
        : {})
    })),
    brandGuardian: {
      approved: review.approved,
      issues: review.issues
    },
    meta: {
      messageCount: input.brandGuardian.messageCount,
      transcriptLength: input.brandGuardian.transcriptLength,
      provider: input.brandGuardian.provider,
      model: input.brandGuardian.model,
      timestamp: input.brandGuardian.timestamp
    }
  };
}

export async function buildAiCardsViewModel(
  leadId: string,
  depsOverride?: Partial<AiCardsDeps>
): Promise<AiCardsViewModel> {
  const startedAt = Date.now();
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new AiCardsOrchestrationError("transcript", "Lead ID is required");
  }

  const deps: AiCardsDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  console.info("[ai-cards] start", { leadId: safeLeadId });

  const stepStart = (step: AiCardsStep) => console.info("[ai-cards] step_start", { leadId: safeLeadId, step });
  const stepSuccess = (step: AiCardsStep, started: number) =>
    console.info("[ai-cards] step_end", { leadId: safeLeadId, step, durationMs: Date.now() - started });

  let transcript: LeadTranscriptResult;
  {
    const step: AiCardsStep = "transcript";
    const s = Date.now();
    stepStart(step);
    try {
      transcript = await deps.getTranscript(safeLeadId);
      stepSuccess(step, s);
    } catch (error) {
      console.error("[ai-cards] step_failed", { leadId: safeLeadId, step, error: error instanceof Error ? error.message : String(error) });
      throw new AiCardsOrchestrationError(step, error instanceof Error ? error.message : "Transcript failed", { cause: error });
    }
  }

  let stageDetection: StageDetectionResult;
  {
    const step: AiCardsStep = "stage_detection";
    const s = Date.now();
    stepStart(step);
    try {
      stageDetection = await deps.getStageDetection({ leadId: safeLeadId, transcript });
      stepSuccess(step, s);
    } catch (error) {
      console.error("[ai-cards] step_failed", { leadId: safeLeadId, step, error: error instanceof Error ? error.message : String(error) });
      throw new AiCardsOrchestrationError(step, error instanceof Error ? error.message : "Stage detection failed", { cause: error });
    }
  }

  let strategicAdvisor: StrategicAdvisorResult;
  {
    const step: AiCardsStep = "strategic_advisor";
    const s = Date.now();
    stepStart(step);
    try {
      strategicAdvisor = await deps.getStrategicAdvisor({ leadId: safeLeadId, transcript, stageDetection });
      stepSuccess(step, s);
    } catch (error) {
      console.error("[ai-cards] step_failed", { leadId: safeLeadId, step, error: error instanceof Error ? error.message : String(error) });
      throw new AiCardsOrchestrationError(step, error instanceof Error ? error.message : "Strategic advisor failed", { cause: error });
    }
  }

  let replyGenerator: ReplyGeneratorResult;
  {
    const step: AiCardsStep = "reply_generator";
    const s = Date.now();
    stepStart(step);
    try {
      replyGenerator = await deps.getReplyGenerator({ leadId: safeLeadId, transcript, stageDetection, strategicAdvisor });
      stepSuccess(step, s);
    } catch (error) {
      console.error("[ai-cards] step_failed", { leadId: safeLeadId, step, error: error instanceof Error ? error.message : String(error) });
      throw new AiCardsOrchestrationError(step, error instanceof Error ? error.message : "Reply generator failed", { cause: error });
    }
  }

  let brandGuardian: BrandGuardianResult;
  {
    const step: AiCardsStep = "brand_guardian";
    const s = Date.now();
    stepStart(step);
    try {
      brandGuardian = await deps.getBrandGuardian({
        leadId: safeLeadId,
        transcript,
        stageDetection,
        strategicAdvisor,
        replyGenerator
      });
      stepSuccess(step, s);
    } catch (error) {
      console.error("[ai-cards] step_failed", { leadId: safeLeadId, step, error: error instanceof Error ? error.message : String(error) });
      throw new AiCardsOrchestrationError(step, error instanceof Error ? error.message : "Brand guardian failed", { cause: error });
    }
  }

  const vm = mapToViewModel({
    leadId: safeLeadId,
    stageDetection,
    strategicAdvisor,
    brandGuardian
  });

  console.info("[ai-cards] done", { leadId: safeLeadId, durationMs: Date.now() - startedAt });
  return vm;
}
