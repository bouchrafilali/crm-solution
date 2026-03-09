import {
  ConversationMessage,
  Lead,
  StrategicAdvisorActionType,
  StrategicAdvisorMomentum,
  StrategicAdvisorPriority,
  StrategicAdvisorStage,
  StrategicAnalysis
} from "./types.js";

const stageOrder: StrategicAdvisorStage[] = [
  "NEW",
  "PRODUCT_INTEREST",
  "QUALIFICATION_PENDING",
  "QUALIFIED",
  "PRICE_SENT",
  "VIDEO_PROPOSED",
  "DEPOSIT_PENDING",
  "CONFIRMED",
  "CONVERTED",
  "LOST"
];

const actionLabels: Record<StrategicAdvisorActionType, string> = {
  clarify_missing_info: "Clarify missing qualification data",
  qualify_before_price: "Complete qualification before pricing",
  send_contextualized_price: "Send contextualized pricing",
  reassure_and_progress: "Reassure and move to commitment",
  propose_video_call: "Propose a short video consultation",
  advance_to_deposit: "Advance to deposit confirmation",
  reactivate_gently: "Reactivate with a soft check-in",
  hold_until_confirmation: "Hold progression until confirmation",
  route_to_human_approval: "Route to human approval"
};

const paymentPatterns = [/\bpay\b/, /\bpayment\b/, /\bdeposit\b/, /\bready\b/, /\bconfirm\b/, /\bconfirmation\b/, /\bpr[eê]t\b/i];
const urgencyPatterns = [/\btoday\b/, /\bnow\b/, /\burgent\b/, /\basap\b/, /\bimmediately\b/, /\bmaintenant\b/];
const pricePatterns = [/\bprice\b/, /\btarif\b/, /\bbudget\b/, /\bcost\b/, /\bquote\b/, /\bpricing\b/];
const discountPatterns = [/\bdiscount\b/, /\breduc\b/, /\bbest price\b/, /\boffer\b/];
const hesitationPatterns = [/\bmaybe\b/, /\bnot sure\b/, /\bcan i think\b/, /\bhesitat\b/, /\bpeut[- ]?être\b/];
const timelineRiskPatterns = [/\bguarantee\b/, /\bdelivery\b/, /\bship\b/, /\bdeadline\b/, /\blivraison\b/];
const holdPatterns = [/\bhold\b/, /\breserve\b/, /\bkeep\b/, /\buntil tomorrow\b/, /\bbloquer\b/];
const videoPatterns = [/\bvideo\b/, /\bcall\b/, /\bzoom\b/, /\bvisio\b/];
const reactivationPatterns = [/\bstill available\b/, /\bfollow[- ]?up\b/, /\bback\b/, /\breactivate\b/, /\breprise\b/];

export interface StrategicAdvisorBusinessRules {
  requireQualificationBeforePrice: boolean;
  disallowUnverifiedDeliveryPromise: boolean;
  enforceHumanApprovalForSensitiveActions: boolean;
  highValueThreshold: number;
}

export interface StrategicAdvisorBrandRules {
  premiumTone: "high";
  avoidOverpromising: boolean;
  conciseGuidance: boolean;
}

export interface StrategicAdvisorContext {
  lead: Pick<
    Lead,
    | "id"
    | "name"
    | "currentStage"
    | "priorityScore"
    | "estimatedValue"
    | "eventDate"
    | "destination"
    | "qualificationStatus"
    | "paymentStatus"
    | "detectedSignals"
    | "missingFields"
    | "openTasks"
    | "paymentIntent"
    | "highValue"
    | "lastMessage"
  >;
  conversation: {
    id: string;
    label: string;
  };
  recentMessages: Array<
    Pick<ConversationMessage, "id" | "actor" | "text" | "timestamp" | "state"> & {
      source?: "whatsapp" | "operator_action";
    }
  >;
  currentStage: StrategicAdvisorStage | string;
  signals: string[];
  priorityScore: number;
  openTasks: Array<Pick<Lead["openTasks"][number], "id" | "title" | "done">>;
  missingFields: string[];
  lastOperatorAction?: string | null;
  businessRules?: Partial<StrategicAdvisorBusinessRules>;
  brandRules?: Partial<StrategicAdvisorBrandRules>;
  generatedAt?: string;
}

export type StrategicAdvisorOutput = StrategicAnalysis;

export interface StrategicAdvisorAnalysisRecord {
  schemaVersion: "strategic_advisor_v1";
  leadId: string;
  conversationId: string;
  timestamp: string;
  provider: "mock_strategic_advisor_v1";
  model: "rule-based-v1";
  decisionSummary: string;
  inputSnapshot: {
    currentStage: StrategicAdvisorStage;
    priorityScore: number;
    signalCount: number;
    missingFields: string[];
    openTaskCount: number;
    lastOperatorAction: string | null;
    recentMessageCount: number;
  };
  output: StrategicAdvisorOutput;
  confidenceIndicators: {
    stageConfidence: number;
    actionConfidence: number;
  };
}

interface StrategicIndicators {
  paymentIntent: boolean;
  urgency: boolean;
  priceInquiry: boolean;
  priceSensitive: boolean;
  discountPressure: boolean;
  hesitation: boolean;
  timelineGuaranteeRisk: boolean;
  holdRequest: boolean;
  videoCallInterest: boolean;
  reactivationContext: boolean;
  highValue: boolean;
  qualificationIncomplete: boolean;
  missingEventDate: boolean;
  missingDeliveryCountry: boolean;
}

const defaultBusinessRules: StrategicAdvisorBusinessRules = {
  requireQualificationBeforePrice: true,
  disallowUnverifiedDeliveryPromise: true,
  enforceHumanApprovalForSensitiveActions: true,
  highValueThreshold: 25000
};

const defaultBrandRules: StrategicAdvisorBrandRules = {
  premiumTone: "high",
  avoidOverpromising: true,
  conciseGuidance: true
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatStageLabel(stage: StrategicAdvisorStage): string {
  return stage
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeStage(stage: string): StrategicAdvisorStage {
  const upper = stage.trim().toUpperCase();
  if (stageOrder.includes(upper as StrategicAdvisorStage)) return upper as StrategicAdvisorStage;
  if (upper.includes("INQUIRY")) return "NEW";
  if (upper.includes("INTEREST")) return "PRODUCT_INTEREST";
  if (upper.includes("QUAL")) return "QUALIFICATION_PENDING";
  if (upper.includes("PRICE")) return "PRICE_SENT";
  if (upper.includes("DEPOSIT")) return "DEPOSIT_PENDING";
  if (upper.includes("VIDEO")) return "VIDEO_PROPOSED";
  if (upper.includes("CONFIRM")) return "CONFIRMED";
  if (upper.includes("LOST")) return "LOST";
  return "PRODUCT_INTEREST";
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function toLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function hasKeyword(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasSignalHint(signalCorpus: string[], fragments: string[]): boolean {
  return fragments.some((fragment) => signalCorpus.some((signal) => signal.includes(fragment)));
}

function normalizeMissingField(field: string): string {
  const normalized = normalizeText(field).replace(/[._-]+/g, " ");
  if (normalized.includes("event date precision")) return "Event date precision";
  if (normalized.includes("destination") || normalized.includes("delivery country") || normalized.includes("shipping country")) {
    return "Delivery country";
  }
  if (normalized.includes("event date")) return "Event date";
  if (normalized.includes("event type")) return "Event type";
  if (normalized.includes("budget")) return "Budget range";
  if (normalized.includes("silhouette")) return "Preferred silhouette";
  if (normalized.includes("payment method")) return "Payment method";
  return toLabel(normalized);
}

function buildMessageDigest(messages: StrategicAdvisorContext["recentMessages"], lastMessage: string): string {
  return [...messages.slice(-8).map((message) => message.text), lastMessage]
    .filter((value) => value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function deriveIndicators(
  context: StrategicAdvisorContext,
  digest: string,
  signalCorpus: string[],
  missingInformation: string[],
  rules: StrategicAdvisorBusinessRules
): StrategicIndicators {
  const highValue = context.lead.highValue || context.lead.estimatedValue >= rules.highValueThreshold;

  return {
    paymentIntent:
      context.lead.paymentIntent === "high" ||
      hasKeyword(digest, paymentPatterns) ||
      hasSignalHint(signalCorpus, ["ready to pay", "ready_to_pay", "payment intent", "ready to confirm"]),
    urgency: hasKeyword(digest, urgencyPatterns) || hasSignalHint(signalCorpus, ["urgency", "next step", "repeat request"]),
    priceInquiry: hasKeyword(digest, pricePatterns) || hasSignalHint(signalCorpus, ["price", "tarif", "quote", "budget"]),
    priceSensitive:
      hasKeyword(digest, discountPatterns) || hasSignalHint(signalCorpus, ["price sensitivity", "comparing", "timing uncertainty"]),
    discountPressure: hasKeyword(digest, discountPatterns) || hasSignalHint(signalCorpus, ["discount", "best price"]),
    hesitation: hasKeyword(digest, hesitationPatterns) || hasSignalHint(signalCorpus, ["timing uncertainty", "hesitation"]),
    timelineGuaranteeRisk: hasKeyword(digest, timelineRiskPatterns),
    holdRequest: hasKeyword(digest, holdPatterns),
    videoCallInterest: hasKeyword(digest, videoPatterns) || hasSignalHint(signalCorpus, ["video", "call", "visio"]),
    reactivationContext: hasKeyword(digest, reactivationPatterns) || hasSignalHint(signalCorpus, ["reactivation", "follow-up"]),
    highValue,
    qualificationIncomplete: context.lead.qualificationStatus !== "complete",
    missingEventDate: missingInformation.some((item) => item.toLowerCase() === "event date"),
    missingDeliveryCountry: missingInformation.some((item) => item.toLowerCase() === "delivery country")
  };
}

function inferProbableStage(baseStage: StrategicAdvisorStage, indicators: StrategicIndicators): StrategicAdvisorStage {
  if (baseStage === "PRICE_SENT" && indicators.paymentIntent) return "DEPOSIT_PENDING";
  if (baseStage === "QUALIFICATION_PENDING" && !indicators.qualificationIncomplete) return "QUALIFIED";
  if (baseStage === "NEW" && indicators.priceInquiry) return "PRODUCT_INTEREST";
  if (baseStage === "PRODUCT_INTEREST" && indicators.priceInquiry && !indicators.qualificationIncomplete) return "QUALIFIED";
  if (baseStage === "DEPOSIT_PENDING" && indicators.hesitation) return "DEPOSIT_PENDING";
  return baseStage;
}

function inferMomentum(input: {
  priorityScore: number;
  paymentIntent: boolean;
  urgency: boolean;
  hesitation: boolean;
  reactivationContext: boolean;
}): StrategicAdvisorMomentum {
  if (input.paymentIntent && input.urgency) return "critical";
  if (input.paymentIntent || input.urgency || input.priorityScore >= 88) return "high";
  if (input.reactivationContext && !input.paymentIntent) return "low";
  if (input.hesitation) return "medium";
  return input.priorityScore >= 68 ? "medium" : "low";
}

function inferPriorityRecommendation(priorityScore: number): StrategicAdvisorPriority {
  if (priorityScore >= 92) return "critical";
  if (priorityScore >= 80) return "high";
  if (priorityScore >= 65) return "medium";
  return "low";
}

function pickNextAction(input: {
  probableStage: StrategicAdvisorStage;
  momentum: StrategicAdvisorMomentum;
  missingInformation: string[];
  qualificationStatus: Lead["qualificationStatus"];
  paymentIntent: boolean;
  priceSensitive: boolean;
  hesitation: boolean;
  videoCallInterest: boolean;
  reactivationContext: boolean;
}): StrategicAdvisorActionType {
  if (input.missingInformation.length > 0) {
    return input.qualificationStatus === "complete" ? "clarify_missing_info" : "qualify_before_price";
  }
  if (input.reactivationContext && input.momentum === "low") return "reactivate_gently";
  if (input.videoCallInterest) return "propose_video_call";
  if (input.probableStage === "DEPOSIT_PENDING" || input.paymentIntent) return "advance_to_deposit";
  if (input.probableStage === "PRICE_SENT" && (input.priceSensitive || input.hesitation)) return "reassure_and_progress";
  if (input.probableStage === "QUALIFICATION_PENDING") return "qualify_before_price";
  if (input.probableStage === "QUALIFIED" || input.probableStage === "PRODUCT_INTEREST") return "send_contextualized_price";
  if (input.hesitation && input.momentum === "medium") return "hold_until_confirmation";
  return "reassure_and_progress";
}

function requiresHumanApproval(input: {
  indicators: StrategicIndicators;
  probableStage: StrategicAdvisorStage;
  selectedAction: StrategicAdvisorActionType;
  rules: StrategicAdvisorBusinessRules;
}): boolean {
  if (!input.rules.enforceHumanApprovalForSensitiveActions) return false;

  const sensitiveCommitment = input.indicators.timelineGuaranteeRisk || input.indicators.holdRequest;
  const sensitivePricing = input.indicators.discountPressure && input.indicators.highValue && input.probableStage !== "QUALIFICATION_PENDING";
  const sensitiveGap =
    (input.selectedAction === "advance_to_deposit" || input.selectedAction === "send_contextualized_price") &&
    (input.indicators.missingDeliveryCountry || input.indicators.missingEventDate);

  return sensitiveCommitment || sensitivePricing || sensitiveGap;
}

function buildReplyObjective(input: {
  action: StrategicAdvisorActionType;
  missingInformation: string[];
  momentum: StrategicAdvisorMomentum;
}): string {
  if (input.action === "clarify_missing_info" && input.missingInformation.length > 0) {
    return `Confirm ${input.missingInformation.slice(0, 2).join(" and ").toLowerCase()} before moving to commitment language.`;
  }
  if (input.action === "qualify_before_price") return "Capture qualification essentials first, then position pricing with context.";
  if (input.action === "send_contextualized_price") return "Share a concise price frame tied to event scope and value.";
  if (input.action === "reassure_and_progress") return "Address concern directly and move the lead to one concrete next step.";
  if (input.action === "propose_video_call") return "Offer a short video call to accelerate trust and decision quality.";
  if (input.action === "advance_to_deposit") return "Secure deposit confirmation with one clear instruction and timeline clarity.";
  if (input.action === "reactivate_gently") return "Restart the thread with low pressure and a context-aware check-in.";
  if (input.action === "hold_until_confirmation") return "Maintain warmth while waiting for explicit confirmation to proceed.";
  return input.momentum === "critical"
    ? "Prepare approval-ready wording immediately before any sensitive commitment."
    : "Route the draft through human approval before progressing.";
}

function buildKeySignals(input: {
  probableStage: StrategicAdvisorStage;
  indicators: StrategicIndicators;
  missingInformation: string[];
  priorityScore: number;
  hasOpenTasks: boolean;
  eventDate?: string;
  destination?: string;
}): string[] {
  return unique([
    input.indicators.paymentIntent ? "Payment intent is explicit" : "",
    input.indicators.urgency ? "Lead expects immediate next step" : "",
    input.indicators.priceInquiry ? "Pricing discussion is active" : "",
    input.eventDate ? "Event date is captured" : "",
    input.destination ? "Delivery destination is captured" : "",
    input.indicators.highValue ? "Lead sits in a high-ticket segment" : "",
    input.hasOpenTasks ? "Operational follow-up tasks are already queued" : "",
    input.missingInformation.length === 0 ? "No mandatory data gaps detected" : "",
    `Current likely stage: ${formatStageLabel(input.probableStage)}`,
    input.priorityScore >= 90 ? "Priority score signals immediate handling" : ""
  ]);
}

function buildRisks(input: {
  indicators: StrategicIndicators;
  missingInformation: string[];
  rules: StrategicAdvisorBusinessRules;
}): string[] {
  const missingFieldRisks = input.missingInformation.map((field) => `${field} is missing before safe progression`);
  return unique([
    ...missingFieldRisks,
    input.indicators.timelineGuaranteeRisk && input.rules.disallowUnverifiedDeliveryPromise
      ? "Delivery timing guarantee requested without verified operations capacity"
      : "",
    input.indicators.holdRequest ? "Lead requested a hold window that may require policy approval" : "",
    input.indicators.priceSensitive ? "Price sensitivity can reduce conversion if framing is weak" : "",
    input.indicators.hesitation ? "Momentum may cool if next response is delayed or unclear" : "",
    input.indicators.qualificationIncomplete && input.rules.requireQualificationBeforePrice
      ? "Qualification is incomplete for controlled pricing progression"
      : ""
  ]);
}

function buildOpportunities(input: {
  probableStage: StrategicAdvisorStage;
  indicators: StrategicIndicators;
  momentum: StrategicAdvisorMomentum;
  hasOpenTasks: boolean;
  nearEventWindow: boolean;
}): string[] {
  return unique([
    input.indicators.paymentIntent ? "Lead is commercially ready for a deposit path" : "",
    input.momentum === "high" || input.momentum === "critical" ? "Active conversion window can be closed in-session" : "",
    input.indicators.videoCallInterest ? "Video consultation can accelerate trust and close quality" : "",
    input.indicators.highValue ? "High-value lead justifies fast senior handling" : "",
    input.nearEventWindow ? "Event timeline supports urgency-based progression" : "",
    input.hasOpenTasks ? "Existing tasks already align with the next move" : "",
    input.probableStage === "QUALIFIED" || input.probableStage === "PRICE_SENT"
      ? "Conversation context supports a clear commercial ask in the next reply"
      : ""
  ]);
}

function buildRationale(input: {
  probableStage: StrategicAdvisorStage;
  stageConfidence: number;
  momentum: StrategicAdvisorMomentum;
  nextBestAction: StrategicAdvisorActionType;
  primaryOpportunity?: string;
  primaryRisk?: string;
  humanApprovalRequired: boolean;
}): string {
  const confidence = Math.round(input.stageConfidence * 100);
  const firstSentence = `Likely ${formatStageLabel(input.probableStage)} (${confidence}% confidence) with ${input.momentum} momentum.`;
  const secondSentence = `Next move: ${actionLabels[input.nextBestAction]}.`;

  if (input.humanApprovalRequired && input.primaryRisk) {
    return `${firstSentence} ${secondSentence} Guardrail: ${input.primaryRisk}.`;
  }
  if (input.primaryOpportunity) {
    return `${firstSentence} ${secondSentence} Opportunity: ${input.primaryOpportunity}.`;
  }
  if (input.primaryRisk) {
    return `${firstSentence} ${secondSentence} Watchout: ${input.primaryRisk}.`;
  }
  return `${firstSentence} ${secondSentence}`;
}

function isNearEventWindow(eventDate: string | undefined, generatedAt: string | undefined): boolean {
  if (!eventDate) return false;
  const eventDateValue = new Date(`${eventDate}T00:00:00Z`);
  if (Number.isNaN(eventDateValue.getTime())) return false;

  const reference = generatedAt ? new Date(generatedAt) : new Date();
  const referenceDate = Number.isNaN(reference.getTime()) ? new Date() : reference;
  const diffMs = eventDateValue.getTime() - referenceDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 120;
}

export function generateStrategicAdvisorAnalysis(context: StrategicAdvisorContext): StrategicAdvisorOutput {
  const rules: StrategicAdvisorBusinessRules = { ...defaultBusinessRules, ...context.businessRules };
  const brandRules: StrategicAdvisorBrandRules = { ...defaultBrandRules, ...context.brandRules };
  const baseStage = normalizeStage(context.currentStage || context.lead.currentStage || "NEW");
  const missingInformation = unique([...context.missingFields, ...context.lead.missingFields].map(normalizeMissingField));
  const signalCorpus = unique([...context.signals, ...context.lead.detectedSignals].map(normalizeText));
  const digest = buildMessageDigest(context.recentMessages, context.lead.lastMessage);
  const indicators = deriveIndicators(context, digest, signalCorpus, missingInformation, rules);
  const probableStage = inferProbableStage(baseStage, indicators);

  const stageConfidence = round(
    0.62 +
      (probableStage !== baseStage ? 0.05 : 0) +
      (indicators.paymentIntent ? 0.09 : 0) +
      (indicators.qualificationIncomplete ? -0.08 : 0.06) +
      (missingInformation.length > 1 ? -0.06 : 0.03) +
      (context.recentMessages.length >= 4 ? 0.04 : 0),
    2
  );
  const boundedStageConfidence = Math.max(0.45, Math.min(stageConfidence, 0.96));

  const momentum = inferMomentum({
    priorityScore: context.priorityScore,
    paymentIntent: indicators.paymentIntent,
    urgency: indicators.urgency,
    hesitation: indicators.hesitation,
    reactivationContext: indicators.reactivationContext
  });

  const priorityRecommendation = inferPriorityRecommendation(context.priorityScore);
  const selectedAction = pickNextAction({
    probableStage,
    momentum,
    missingInformation,
    qualificationStatus: context.lead.qualificationStatus,
    paymentIntent: indicators.paymentIntent,
    priceSensitive: indicators.priceSensitive,
    hesitation: indicators.hesitation,
    videoCallInterest: indicators.videoCallInterest,
    reactivationContext: indicators.reactivationContext
  });

  const humanApprovalRequired = requiresHumanApproval({
    indicators,
    probableStage,
    selectedAction,
    rules
  });
  const nextBestAction: StrategicAdvisorActionType = humanApprovalRequired ? "route_to_human_approval" : selectedAction;

  const nearEventWindow = isNearEventWindow(context.lead.eventDate, context.generatedAt);
  const hasOpenTasks = context.openTasks.some((task) => !task.done);

  const keySignals = buildKeySignals({
    probableStage,
    indicators,
    missingInformation,
    priorityScore: context.priorityScore,
    hasOpenTasks,
    eventDate: context.lead.eventDate,
    destination: context.lead.destination
  });
  const risks = buildRisks({ indicators, missingInformation, rules });
  const opportunities = buildOpportunities({
    probableStage,
    indicators,
    momentum,
    hasOpenTasks,
    nearEventWindow
  });

  const replyObjective = buildReplyObjective({
    action: nextBestAction,
    missingInformation,
    momentum
  });
  const rationale = buildRationale({
    probableStage,
    stageConfidence: boundedStageConfidence,
    momentum,
    nextBestAction,
    primaryOpportunity: opportunities[0],
    primaryRisk: risks[0],
    humanApprovalRequired
  });

  return {
    leadId: context.lead.id,
    probableStage,
    stageConfidence: boundedStageConfidence,
    momentum,
    priorityRecommendation,
    keySignals,
    risks,
    opportunities,
    missingInformation,
    nextBestAction,
    replyObjective: brandRules.conciseGuidance ? replyObjective : `${replyObjective} Keep tone premium and controlled.`,
    rationale,
    humanApprovalRequired
  };
}

export function generateStrategicAdvisorAnalysisRecord(context: StrategicAdvisorContext): StrategicAdvisorAnalysisRecord {
  const output = generateStrategicAdvisorAnalysis(context);
  const actionConfidence = round(
    0.56 + output.stageConfidence * 0.34 + (output.momentum === "critical" ? 0.06 : output.momentum === "high" ? 0.03 : 0),
    2
  );

  return {
    schemaVersion: "strategic_advisor_v1",
    leadId: context.lead.id,
    conversationId: context.conversation.id,
    timestamp: context.generatedAt || new Date().toISOString(),
    provider: "mock_strategic_advisor_v1",
    model: "rule-based-v1",
    decisionSummary: `${actionLabels[output.nextBestAction]} (${Math.round(output.stageConfidence * 100)}% stage confidence)`,
    inputSnapshot: {
      currentStage: normalizeStage(context.currentStage || context.lead.currentStage),
      priorityScore: context.priorityScore,
      signalCount: context.signals.length,
      missingFields: context.missingFields,
      openTaskCount: context.openTasks.filter((task) => !task.done).length,
      lastOperatorAction: context.lastOperatorAction ?? null,
      recentMessageCount: context.recentMessages.length
    },
    output,
    confidenceIndicators: {
      stageConfidence: output.stageConfidence,
      actionConfidence: Math.max(0.45, Math.min(actionConfidence, 0.97))
    }
  };
}
