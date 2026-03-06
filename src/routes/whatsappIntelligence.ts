import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { getDbPool } from "../db/client.js";
import { getSettings, updateSettings } from "../db/aiSettingsRepo.js";
import { createAiInsight, getLatestAiInsightByConversationId } from "../db/aiInsightsRepo.js";
import {
  getSuggestionLearningSettings,
  resetSuggestionLearningSettings,
  updateSuggestionLearningSettings
} from "../db/suggestionLearningSettingsRepo.js";
import {
  createKeywordRule,
  createStageTemplateSuggestion,
  createReplyTemplate,
  deleteStageTemplateSuggestion,
  createStageRule,
  getCountrySettings,
  getGlobalSettings,
  listKeywordRules,
  listStageTemplateSuggestions,
  listReplyTemplates,
  listStageRules,
  patchCountrySettings,
  patchGlobalSettings,
  patchKeywordRule,
  patchReplyTemplate,
  patchStageTemplateSuggestion,
  patchStageRule,
  type CountryGroup
} from "../db/whatsappIntelligenceSettingsRepo.js";
import {
  WHATSAPP_LEAD_STAGES,
  createWhatsAppLead,
  getWhatsAppLeadById,
  getWhatsAppLeadSessionStatus,
  getWhatsAppMetrics,
  getYesterdayBriefStats,
  listWhatsAppLeadMessages,
  listWhatsAppLeadTimeline,
  listWhatsAppTopLeads,
  listRecentInboundMessageTextsByLead,
  listRecentMessagesByLeadIds,
  listRecentWhatsAppLeadMessages,
  listWhatsAppLeads,
  setLeadFirstResponseMinutesFromOutbound,
  updateLeadQualification,
  createWhatsAppLeadEvent,
  updateWhatsAppLeadDestination,
  updateWhatsAppLeadMarketingOptIn,
  updateWhatsAppLeadEventDate,
  updateWhatsAppLeadSignalFlags,
  listRecentInboundMessagesForLead,
  updateWhatsAppLeadFlags,
  updateWhatsAppLeadTestFlag,
  updateWhatsAppLeadNotes,
  updateWhatsAppLeadStage,
  type WhatsAppLeadStage
} from "../db/whatsappLeadsRepo.js";
import {
  classifyLeadWithAi,
  generateDailyBusinessBrief,
  generateFollowUp,
  generateStageDraft,
  generateStrategicAdvisorResponse,
  type DraftType,
  type FollowUpType
} from "../services/aiWhatsappService.js";
import { computeRuleQualification } from "../services/leadQualificationService.js";
import { syncZokoConversationHistory } from "../services/zokoConversationSync.js";
import { dispatchWhatsAppFollowUp } from "../services/whatsappChannelProvider.js";
import { suggestReplyRulesFirst } from "../services/whatsappSuggestEngine.js";
import { buildSuggestions } from "../services/suggestions.js";
import { getProductPreviews } from "../services/shopifyProductPreviews.js";
import { extractEventDateFromMessages, inferEventDateFacts } from "../services/eventDateExtractor.js";
import { extractDestinationFromMessages } from "../services/destinationExtractor.js";
import { applyInboundSignalExtraction } from "../services/whatsappLeadSignals.js";
import { applyStageProgression, detectConversationEvents, detectSignalsFromMessages } from "../services/conversationStageProgression.js";
import { runWhatsAppLabSimulation } from "../services/whatsappLabSimulation.js";
import { computeRiskScore } from "../services/riskScore.js";
import {
  addTemplateFavorite,
  fetchZokoTemplates,
  getTemplateByName,
  getTemplateCategoryByName,
  listTemplateFavorites,
  removeTemplateFavorite,
  sendZokoTemplateMessage
} from "../services/zokoTemplatesAdapter.js";
import {
  createWhatsAppLeadMessageWithTracking,
  logSuggestionUsed
} from "../services/mlMessageTracking.js";
import {
  attachFinalMessageToSuggestion,
  createSuggestionFeedbackDraft,
  getSuggestionTypePerformance,
  listSuggestionFeedbackQueue,
  markSuggestionOutcome,
  updateSuggestionReviewStatus
} from "../db/whatsappSuggestionFeedbackRepo.js";
import { createMlEvent } from "../db/mlRepo.js";
import { generateAiPersonalSuggestions } from "../services/aiPersonalSuggestions.js";
import { getLeadConversionMetricsByLeadId } from "../db/leadConversionMetricsRepo.js";
import { listLeadPriceQuotes } from "../db/leadPriceQuotesRepo.js";
import { createQuoteAction } from "../db/quoteApprovalRepo.js";
import {
  getAiAgentRunById,
  getLatestAiAgentRunByLead,
  listAiAgentRunsByLead
} from "../db/aiAgentRunsRepo.js";
import {
  estimateAdvisorCostUsd,
  formatEstimatedCostUsd,
  normalizeAdvisorModel,
  normalizeAdvisorRun
} from "../services/aiNormalize.js";
import { runClaudeAdvisor } from "../services/claudeAdvisor.js";
import { runOpenAiAdvisor } from "../services/openaiAdvisor.js";
import {
  applyTeamPriceOverrideFromLeadOutbound,
  composeApprovedQuoteClientText,
  isQuoteApprovalReadyForClientSend
} from "../services/quoteRequestService.js";

export const whatsappRouter = Router();
const MANUAL_AI_ANALYZE_MESSAGE_LIMIT = 200;

const daysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  range: z.coerce.number().int().min(1).max(365).optional(),
  stage: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const stagePatchSchema = z.object({
  stage: z.enum(WHATSAPP_LEAD_STAGES),
  internalNotes: z.string().optional().nullable(),
  priceSent: z.boolean().optional(),
  stageAuto: z.boolean().optional(),
  stageConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  stageAutoReason: z.string().optional().nullable()
});

const confirmVerbalSchema = z.object({
  source: z.enum(["UI_BUTTON"]).optional()
});

const eventDatePatchSchema = z.object({
  event_date: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).nullable()
});

const destinationPatchSchema = z.object({
  ship_city: z.string().optional().nullable(),
  ship_region: z.string().optional().nullable(),
  ship_country: z.string().optional().nullable(),
  ship_destination_text: z.string().optional().nullable()
});

const leadTestFlagPatchSchema = z.object({
  is_test: z.boolean(),
  test_tag: z.string().max(120).optional().nullable()
});

const followUpSchema = z.object({
  leadId: z.string().uuid(),
  type: z.enum(["48H_PRICE", "72H_PRICE", "72H_QUALIFIED_VIDEO"])
});

const aiUsageSchema = z.object({
  runId: z.string().uuid(),
  suggestionId: z.string().min(1).max(64),
  action: z.enum(["insert", "send"]),
  createdAt: z.string().datetime().optional()
});

const aiRunIdSchema = z.object({
  runId: z.string().uuid()
});

const aiRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const aiAdvisorProviderSchema = z.object({
  provider: z.enum(["claude", "gpt"]).optional()
});

const deleteTestLeadsSchema = z
  .object({
    mode: z.enum(["all"]).optional(),
    leadId: z.string().uuid().optional()
  })
  .refine((value) => value.mode === "all" || Boolean(value.leadId), {
    message: "mode_or_lead_id_required"
  });

const messageCreateSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  text: z.string().min(1).max(5000),
  provider: z.enum(["manual", "zoko", "meta", "system"]).optional(),
  message_type: z.enum(["text", "template", "image", "document"]).optional(),
  send_whatsapp: z.boolean().optional(),
  suggestion_feedback: z
    .object({
      id: z.string().uuid(),
      source: z.enum(["rules_suggest_reply", "ai_followup", "ai_classify", "ai_draft", "manual"]).optional(),
      suggestion_type: z.string().optional().nullable(),
      suggested_text: z.string().optional().nullable(),
      accepted: z.boolean().optional()
    })
    .optional()
});

const sharedImportSchema = z.object({
  conversation_id: z.string().uuid().optional(),
  client_name: z.string().min(1).max(200).optional(),
  phone_number: z.string().min(3).max(60).optional(),
  country: z.string().max(16).optional().nullable(),
  product_reference: z.string().max(255).optional().nullable(),
  raw_text: z.string().max(200000).optional(),
  imported_by: z.string().max(120).optional(),
  owner_labels: z.array(z.string().min(1).max(80)).max(12).optional(),
  messages: z
    .array(
      z.object({
        direction: z.enum(["IN", "OUT"]),
        text: z.string().min(1).max(5000),
        created_at: z.string().optional()
      })
    )
    .max(1000)
    .optional()
});

const classifySchema = z.object({
  leadId: z.string().uuid()
});

const draftSchema = z.object({
  leadId: z.string().uuid(),
  type: z.enum(["FIRST_RESPONSE", "PRICE_CONTEXTUALIZED", "FOLLOW_UP_48H", "REFLECTION_72H"])
});

const suggestReplySchema = z.object({
  leadId: z.string().uuid(),
  targetStage: z
    .enum(["NEW", "QUALIFICATION_PENDING", "QUALIFIED", "PRICE_SENT", "DEPOSIT_PENDING", "CONFIRMED"])
    .optional()
});

const suggestionsCardsSchema = z.object({
  leadId: z.string().uuid()
});

const aiSuggestionsSchema = z.object({
  leadId: z.string().uuid(),
  maxMessages: z.coerce.number().int().min(1).max(50).optional()
});

const suggestionCardFeedbackDraftSchema = z.object({
  leadId: z.string().uuid(),
  cardId: z.string().min(1).max(120),
  cardText: z.string().min(1).max(5000)
});

const syncSchema = z.object({
  max_pages: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional().nullable(),
  only_inbound: z.boolean().optional()
});

const devSimulateSchema = z.object({
  scenario: z.enum(["A", "B", "C", "D", "E", "PARIS_MA", "PRICE_SENT_CONFIRMED", "PRICE_SENT_PAYMENT_QUESTION"]).optional(),
  mode: z.enum(["basic", "strict"]).optional(),
  language: z.enum(["FR", "EN"]).optional(),
  has_paid_shopify_order: z.boolean().optional(),
  messages: z
    .array(
      z.object({
        direction: z.enum(["IN", "OUT"]),
        text: z.string(),
        created_at: z.string().optional()
      })
    )
    .optional()
});

const sendTemplateSchema = z.object({
  leadId: z.string().uuid(),
  templateName: z.string().min(1),
  language: z.string().min(1).optional(),
  variables: z.array(z.string()).optional()
});

const sendApprovedQuoteSchema = z.object({
  quoteRequestId: z.string().uuid().optional(),
  channel: z.literal("whatsapp"),
  mode: z.enum(["template", "text"]).optional()
});

const templatesQuerySchema = z.object({
  category: z.enum(["UTILITY", "MARKETING", "ALL"]).optional(),
  search: z.string().optional()
});

const marketingOptInSchema = z.object({
  marketing_opt_in: z.boolean(),
  source: z.literal("manual")
});

const templateFavoriteSchema = z.object({
  templateName: z.string().min(1)
});

const productPreviewsSchema = z.object({
  handles: z.array(z.string().min(1)).max(200)
});

const suggestionOutcomeSchema = z.object({
  outcome: z.enum(["NO_REPLY", "REPLIED", "PAYMENT_QUESTION", "DEPOSIT_LINK_SENT", "CONFIRMED", "CONVERTED", "LOST"]),
  review_notes: z.string().optional().nullable()
});

const suggestionReviewSchema = z.object({
  status: z.enum(["OPEN", "REVIEWED", "ARCHIVED"]),
  review_notes: z.string().optional().nullable()
});

const suggestionLearningSettingsPatchSchema = z.object({
  learning_window_days: z.coerce.number().int().min(7).max(365).optional(),
  min_samples: z.coerce.number().int().min(1).max(50).optional(),
  success_weight: z.coerce.number().int().min(0).max(100).optional(),
  accepted_weight: z.coerce.number().int().min(0).max(100).optional(),
  lost_weight: z.coerce.number().int().min(0).max(100).optional(),
  boost_min: z.coerce.number().int().min(-100).max(0).optional(),
  boost_max: z.coerce.number().int().min(0).max(100).optional(),
  success_outcomes: z.array(z.string().min(1).max(60)).min(1).max(10).optional(),
  failure_outcomes: z.array(z.string().min(1).max(60)).min(1).max(10).optional()
});

const globalSettingsPatchSchema = z.object({
  tone: z.enum(["FORMEL", "QUIET_LUXURY", "DIRECT"]).optional(),
  message_length: z.enum(["SHORT", "MEDIUM"]).optional(),
  no_emojis: z.boolean().optional(),
  avoid_follow_up_phrase: z.boolean().optional(),
  signature_enabled: z.boolean().optional(),
  signature_text: z.string().nullable().optional()
});

const countryGroupSchema = z.enum(["MA", "FR", "INTL"]);
const countrySettingsPatchSchema = z.object({
  language: z.enum(["AUTO", "FR", "EN"]).optional(),
  price_policy: z.enum(["NEVER_FIRST", "AFTER_QUALIFIED"]).optional(),
  video_policy: z.enum(["NEVER", "WHEN_HIGH_INTENT", "ALWAYS"]).optional(),
  urgency_style: z.enum(["SUBTLE", "NEUTRAL"]).optional(),
  followup_delay_hours: z.coerce.number().int().min(1).max(240).optional()
});

const keywordRuleSchema = z.object({
  language: z.enum(["FR", "EN"]),
  tag: z.enum([
    "PRICE_REQUEST",
    "EVENT_DATE",
    "SHIPPING",
    "SIZING",
    "RESERVATION_INTENT",
    "PAYMENT",
    "VIDEO_INTEREST",
    "URGENCY",
    "PRODUCT_LINK",
    "INTEREST"
  ]),
  keywords: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
});

const stageRuleSchema = z.object({
  rule_name: z.string().min(1),
  required_tags: z.array(z.string()).optional(),
  forbidden_tags: z.array(z.string()).optional(),
  recommended_stage: z.enum([
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
  ]),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional()
});

const stageTemplateSuggestionSchema = z.object({
  stage: z.enum([
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
  ]),
  template_name: z.string().min(1),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional()
});

const replyTemplateSchema = z.object({
  stage: z.enum([
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
  ]),
  language: z.enum(["FR", "EN"]),
  country_group: z.enum(["MA", "FR", "INTL"]).nullable().optional(),
  template_name: z.string().min(1),
  text: z.string().min(1),
  enabled: z.boolean().optional()
});

const aiSettingsPatchSchema = z.object({
  default_language: z.enum(["AUTO", "FR", "EN"]).optional(),
  tone: z.enum(["FORMEL", "QUIET_LUXURY", "DIRECT"]).optional(),
  message_length: z.enum(["SHORT", "MEDIUM"]).optional(),
  include_price_policy: z.enum(["NEVER_FIRST", "AFTER_QUALIFIED"]).optional(),
  include_video_call: z.enum(["NEVER", "WHEN_HIGH_INTENT", "ALWAYS"]).optional(),
  urgency_style: z.enum(["SUBTLE", "NEUTRAL"]).optional(),
  no_emojis: z.boolean().optional(),
  avoid_follow_up_phrase: z.boolean().optional(),
  signature_enabled: z.boolean().optional(),
  signature_text: z.string().nullable().optional()
});

function asStageOrAll(input: unknown): WhatsAppLeadStage | "ALL" {
  const value = String(input || "ALL").trim().toUpperCase();
  return (WHATSAPP_LEAD_STAGES as readonly string[]).includes(value) ? (value as WhatsAppLeadStage) : "ALL";
}

function queryRangeDays(input: { days?: number; range?: number }): number {
  const raw = input.range ?? input.days ?? 30;
  return Math.max(1, Math.min(365, Math.round(raw)));
}

function computeLeadUrgency(lead: {
  detectedSignals?: { tags?: string[] } | null;
  conversionProbability?: { probability?: number } | null;
  stage?: string | null;
  lastActivityAt?: string | null;
  country?: string | null;
}): boolean {
  const tags = new Set(
    Array.isArray(lead.detectedSignals?.tags)
      ? lead.detectedSignals!.tags.map((tag) => String(tag || "").toUpperCase())
      : []
  );
  if (tags.has("SHORT_TIMELINE") || tags.has("URGENT_TIMELINE")) return true;
  const stage = String(lead.stage || "").toUpperCase();
  const activeUrgentStages = new Set(["QUALIFIED", "PRICE_SENT", "VIDEO_PROPOSED", "DEPOSIT_PENDING", "CONFIRMED"]);
  const probability = Number(lead.conversionProbability?.probability || 0);
  const hoursSinceLast = (() => {
    const ts = new Date(String(lead.lastActivityAt || "")).getTime();
    if (!Number.isFinite(ts)) return Infinity;
    return (Date.now() - ts) / 3600000;
  })();
  const country = String(lead.country || "").trim().toUpperCase();
  return probability >= 70 && activeUrgentStages.has(stage) && hoursSinceLast <= 24 && country !== "MA";
}

const PRICE_TEXT_PATTERNS = [/\bprix\b/i, /\bprice\b/i, /\bcombien\b/i, /\bhow\s+much\b/i, /\bcost\b/i, /\bmad\b/i, /\beur\b/i, /\$|€|£/];
function containsPriceText(text: string): boolean {
  const clean = String(text || "");
  return PRICE_TEXT_PATTERNS.some((pattern) => pattern.test(clean));
}

function extractProductHandlesFromText(text: string): string[] {
  try {
    const src = String(text || "");
    if (!src) return [];
    const out: string[] = [];
    const patterns = [
      /\/products\/([a-z0-9][a-z0-9\-]*)/gi,
      /\/collections\/[^/\s]+\/products\/([a-z0-9][a-z0-9\-]*)/gi
    ];
    for (const re of patterns) {
      let m = re.exec(src);
      while (m) {
        const handle = String(m[1] || "").trim().toLowerCase();
        if (handle) out.push(handle);
        m = re.exec(src);
      }
    }
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

function buildLeadDestination(lead: {
  shipDestinationText?: string | null;
  shipCity?: string | null;
  shipRegion?: string | null;
  shipCountry?: string | null;
}): string | null {
  const raw = String(lead.shipDestinationText || "").trim();
  if (raw) return raw;
  const parts = [lead.shipCity, lead.shipRegion, lead.shipCountry]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getLeadQuoteApproval(lead: { detectedSignals?: unknown; detected_signals?: unknown }): Record<string, unknown> {
  const detected = toRecord((lead as { detectedSignals?: unknown }).detectedSignals ?? (lead as { detected_signals?: unknown }).detected_signals);
  return toRecord(detected.quote_approval);
}

function resolveLeadLanguage(lead: { country?: string | null }): "fr" | "en" {
  const country = String(lead.country || "").trim().toUpperCase();
  if (["FR", "MA", "BE", "CH", "DZ", "TN"].includes(country)) return "fr";
  return "en";
}

function formatApprovedAmount(amount: number, currency: "USD" | "EUR" | "MAD"): string {
  const rounded = Math.round(amount);
  if (currency === "USD") return `$${new Intl.NumberFormat("en-US").format(rounded)}`;
  if (currency === "EUR") return `${new Intl.NumberFormat("fr-FR").format(rounded).replace(/\u202f/g, " ")}€`;
  return `${new Intl.NumberFormat("fr-FR").format(rounded).replace(/\u202f/g, " ")} MAD`;
}

function isLeadReadyToSendApprovedQuote(lead: { stage?: string | null; detectedSignals?: unknown; detected_signals?: unknown }): boolean {
  return isQuoteApprovalReadyForClientSend({
    stage: String(lead.stage || ""),
    detectedSignals: toRecord((lead as { detectedSignals?: unknown }).detectedSignals ?? (lead as { detected_signals?: unknown }).detected_signals)
  });
}

function parseSharedWhatsAppExportText(rawText: string, ownerLabels: string[]): Array<{ direction: "IN" | "OUT"; text: string }> {
  const text = String(rawText || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const out: Array<{ direction: "IN" | "OUT"; text: string }> = [];
  const ownerSet = new Set(
    ownerLabels
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const pattern = /^(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}:\d{2})(?:\s?[APMapm]{2})?\s*-\s*([^:]+):\s*(.*)$/;

  for (const line of lines) {
    const value = String(line || "");
    const match = value.match(pattern);
    if (match) {
      const sender = String(match[3] || "").trim().toLowerCase();
      const message = String(match[4] || "").trim();
      if (!message) continue;
      out.push({
        direction: ownerSet.has(sender) ? "OUT" : "IN",
        text: message
      });
      continue;
    }
    if (!out.length) continue;
    const continuation = value.trim();
    if (!continuation) continue;
    out[out.length - 1].text = `${out[out.length - 1].text}\n${continuation}`.trim();
  }
  return out;
}

function safeIsoNow(): string {
  return new Date().toISOString();
}

function isSharedLead(lead: { channelType?: string | null; channel_type?: string | null }): boolean {
  const value = String(lead.channelType || lead.channel_type || "").trim().toUpperCase();
  return value === "SHARED";
}

function isTestDeletionEnabled(): boolean {
  if (String(env.NODE_ENV || "").toLowerCase() === "development") return true;
  const raw = String(env.ALLOW_TEST_DELETION || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isShowAiPromptsEnabled(): boolean {
  const raw = String(env.SHOW_AI_PROMPTS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function mapAiRunListItem(
  run: Awaited<ReturnType<typeof listAiAgentRunsByLead>>[number],
  includePrompt: boolean
) {
  const estimatedCostUsd = estimateAdvisorCostUsd(run.model, run.tokensIn, run.tokensOut);
  return {
    id: run.id,
    lead_id: run.leadId,
    message_id: run.messageId,
    status: run.status,
    trigger_source: run.triggerSource || "message_persisted",
    model: normalizeAdvisorModel(run.model),
    latency_ms: run.latencyMs,
    tokens_in: run.tokensIn,
    tokens_out: run.tokensOut,
    estimated_cost_usd: estimatedCostUsd,
    estimated_cost_label: formatEstimatedCostUsd(estimatedCostUsd),
    created_at: run.createdAt,
    error_text: run.errorText,
    prompt_text: includePrompt ? run.promptText : undefined
  };
}

function buildFlowStepsFromRun(normalized: ReturnType<typeof normalizeAdvisorRun>) {
  const at = normalized.createdAt || new Date().toISOString();
  const status = normalized.status;
  const isSuccess = status === "success";
  const isError = status === "error";
  const hasSuggestions = Array.isArray(normalized.suggestions) && normalized.suggestions.length > 0;
  return [
    { key: "message_persisted", status: "success", at },
    { key: "analysis_queued", status: "success", at },
    { key: "claude_called", status: status === "queued" ? "pending" : isError ? "error" : "success", at },
    { key: "response_received", status: status === "queued" ? "pending" : isError ? "error" : "success", at },
    { key: "suggestions_generated", status: isSuccess ? (hasSuggestions ? "success" : "warning") : isError ? "error" : "pending", at }
  ];
}

function splitSuggestionTextToBubbles(text: string): string[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const blocks = raw.split(/\n\s*\n+/).map((x) => x.trim()).filter(Boolean);
  const source = blocks.length > 1 ? blocks : [raw];
  const out: string[] = [];
  for (const block of source) {
    const sentenceMatches = block.match(/[^.!?]+[.!?]?/g);
    const sentences = sentenceMatches ? sentenceMatches.map((x) => x.trim()).filter(Boolean) : [];
    const parts = sentences.length ? sentences : [block];
    for (const part of parts) {
      out.push(part);
      if (out.length >= 4) return out;
    }
  }
  return out.slice(0, 4);
}

function stripEmojiText(input: string): string {
  return String(input || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").trim();
}

function normalizeGeneratedSuggestionMessages(input: Record<string, unknown>): string[] {
  const direct = Array.isArray(input.messages)
    ? input.messages.map((x) => stripEmojiText(String(x || "").trim())).filter(Boolean)
    : [];
  if (direct.length >= 2 && direct.length <= 4) return direct.slice(0, 4);
  const reply = stripEmojiText(String(input.reply || input.text || "").trim());
  if (!reply) return [];
  return splitSuggestionTextToBubbles(reply).map((x) => stripEmojiText(x)).filter(Boolean).slice(0, 4);
}

function stageRankValue(stage: string | null | undefined): number {
  const s = String(stage || "").trim().toUpperCase();
  const rank: Record<string, number> = {
    NEW: 0,
    PRODUCT_INTEREST: 1,
    QUALIFICATION_PENDING: 2,
    QUALIFIED: 3,
    PRICE_SENT: 4,
    VIDEO_PROPOSED: 4,
    DEPOSIT_PENDING: 5,
    CONFIRMED: 6,
    CONVERTED: 7,
    LOST: 8
  };
  return Number.isFinite(rank[s]) ? rank[s] : 0;
}

function mapAiSettingsResponse(settings: Awaited<ReturnType<typeof getSettings>>) {
  return {
    id: settings.id,
    default_language: settings.defaultLanguage,
    tone: settings.tone,
    message_length: settings.messageLength,
    include_price_policy: settings.includePricePolicy,
    include_video_call: settings.includeVideoCall,
    urgency_style: settings.urgencyStyle,
    no_emojis: settings.noEmojis,
    avoid_follow_up_phrase: settings.avoidFollowUpPhrase,
    signature_enabled: settings.signatureEnabled,
    signature_text: settings.signatureText,
    updated_at: settings.updatedAt
  };
}

whatsappRouter.get("/api/ai/settings", async (_req, res) => {
  try {
    const settings = await getSettings();
    return res.status(200).json(mapAiSettingsResponse(settings));
  } catch (error) {
    console.error("[ai-settings] get", error);
    return res.status(503).json({ error: "ai_settings_unavailable" });
  }
});

whatsappRouter.patch("/api/ai/settings", async (req, res) => {
  const parsed = aiSettingsPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const updated = await updateSettings({
      defaultLanguage: parsed.data.default_language,
      tone: parsed.data.tone,
      messageLength: parsed.data.message_length,
      includePricePolicy: parsed.data.include_price_policy,
      includeVideoCall: parsed.data.include_video_call,
      urgencyStyle: parsed.data.urgency_style,
      noEmojis: parsed.data.no_emojis,
      avoidFollowUpPhrase: parsed.data.avoid_follow_up_phrase,
      signatureEnabled: parsed.data.signature_enabled,
      signatureText: parsed.data.signature_text
    });
    return res.status(200).json(mapAiSettingsResponse(updated));
  } catch (error) {
    console.error("[ai-settings] patch", error);
    return res.status(503).json({ error: "ai_settings_update_failed" });
  }
});

whatsappRouter.get("/api/ai/settings/global", async (_req, res) => {
  try {
    return res.status(200).json(await getGlobalSettings());
  } catch (error) {
    console.error("[ai-settings-global] get", error);
    return res.status(503).json({ error: "ai_settings_global_unavailable" });
  }
});

whatsappRouter.patch("/api/ai/settings/global", async (req, res) => {
  const parsed = globalSettingsPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    return res.status(200).json(await patchGlobalSettings(parsed.data));
  } catch (error) {
    console.error("[ai-settings-global] patch", error);
    return res.status(503).json({ error: "ai_settings_global_update_failed" });
  }
});

whatsappRouter.get("/api/ai/settings/country-group/:group", async (req, res) => {
  const parsed = countryGroupSchema.safeParse(String(req.params.group || "").toUpperCase());
  if (!parsed.success) return res.status(400).json({ error: "invalid_country_group" });
  try {
    const row = await getCountrySettings(parsed.data as CountryGroup);
    if (!row) return res.status(404).json({ error: "country_settings_not_found" });
    return res.status(200).json(row);
  } catch (error) {
    console.error("[ai-settings-country] get", error);
    return res.status(503).json({ error: "ai_settings_country_unavailable" });
  }
});

whatsappRouter.patch("/api/ai/settings/country-group/:group", async (req, res) => {
  const groupParsed = countryGroupSchema.safeParse(String(req.params.group || "").toUpperCase());
  if (!groupParsed.success) return res.status(400).json({ error: "invalid_country_group" });
  const parsed = countrySettingsPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    return res.status(200).json(await patchCountrySettings(groupParsed.data as CountryGroup, parsed.data));
  } catch (error) {
    console.error("[ai-settings-country] patch", error);
    return res.status(503).json({ error: "ai_settings_country_update_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/rules/keywords", async (req, res) => {
  const language = String(req.query.language || "").toUpperCase();
  if (language && language !== "FR" && language !== "EN") return res.status(400).json({ error: "invalid_language" });
  try {
    return res.status(200).json({ items: await listKeywordRules((language || undefined) as "FR" | "EN" | undefined) });
  } catch (error) {
    console.error("[whatsapp-rules] keywords get", error);
    return res.status(503).json({ error: "keyword_rules_unavailable" });
  }
});

whatsappRouter.post("/api/whatsapp/rules/keywords", async (req, res) => {
  const parsed = keywordRuleSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const created = await createKeywordRule({
      ...parsed.data,
      keywords: parsed.data.keywords || [],
      patterns: parsed.data.patterns || [],
      enabled: parsed.data.enabled ?? true
    });
    return res.status(200).json(created);
  } catch (error) {
    console.error("[whatsapp-rules] keywords post", error);
    return res.status(503).json({ error: "keyword_rule_create_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/rules/keywords/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const parsed = keywordRuleSchema.partial().safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const updated = await patchKeywordRule(id, parsed.data);
    if (!updated) return res.status(404).json({ error: "keyword_rule_not_found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("[whatsapp-rules] keywords patch", error);
    return res.status(503).json({ error: "keyword_rule_update_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/rules/stages", async (_req, res) => {
  try {
    return res.status(200).json({ items: await listStageRules() });
  } catch (error) {
    console.error("[whatsapp-rules] stages get", error);
    return res.status(503).json({ error: "stage_rules_unavailable" });
  }
});

whatsappRouter.post("/api/whatsapp/rules/stages", async (req, res) => {
  const parsed = stageRuleSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    return res.status(200).json(
      await createStageRule({
        ...parsed.data,
        required_tags: parsed.data.required_tags || [],
        forbidden_tags: parsed.data.forbidden_tags || [],
        priority: parsed.data.priority ?? 100,
        enabled: parsed.data.enabled ?? true
      })
    );
  } catch (error) {
    console.error("[whatsapp-rules] stages post", error);
    return res.status(503).json({ error: "stage_rule_create_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/rules/stages/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const parsed = stageRuleSchema.partial().safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const updated = await patchStageRule(id, parsed.data);
    if (!updated) return res.status(404).json({ error: "stage_rule_not_found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("[whatsapp-rules] stages patch", error);
    return res.status(503).json({ error: "stage_rule_update_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/reply-templates", async (req, res) => {
  const stage = String(req.query.stage || "").trim().toUpperCase();
  const language = String(req.query.language || "").trim().toUpperCase();
  const countryGroup = String(req.query.country_group || "").trim().toUpperCase();
  if (language && language !== "FR" && language !== "EN") return res.status(400).json({ error: "invalid_language" });
  if (countryGroup && countryGroup !== "MA" && countryGroup !== "FR" && countryGroup !== "INTL" && countryGroup !== "GLOBAL") {
    return res.status(400).json({ error: "invalid_country_group" });
  }
  try {
    return res.status(200).json({
      items: await listReplyTemplates({
        stage: stage || undefined,
        language: (language || undefined) as "FR" | "EN" | undefined,
        country_group: (countryGroup || undefined) as "MA" | "FR" | "INTL" | "GLOBAL" | undefined
      })
    });
  } catch (error) {
    console.error("[whatsapp-templates] get", error);
    return res.status(503).json({ error: "reply_templates_unavailable" });
  }
});

whatsappRouter.post("/api/whatsapp/reply-templates", async (req, res) => {
  const parsed = replyTemplateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    return res.status(200).json(
      await createReplyTemplate({
        ...parsed.data,
        country_group: parsed.data.country_group ?? null,
        enabled: parsed.data.enabled ?? true
      })
    );
  } catch (error) {
    console.error("[whatsapp-templates] post", error);
    return res.status(503).json({ error: "reply_template_create_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/reply-templates/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const parsed = replyTemplateSchema.partial().safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const updated = await patchReplyTemplate(id, parsed.data);
    if (!updated) return res.status(404).json({ error: "reply_template_not_found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("[whatsapp-templates] patch", error);
    return res.status(503).json({ error: "reply_template_update_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/stage-template-suggestions", async (req, res) => {
  const stage = String(req.query.stage || "").trim().toUpperCase();
  const enabledRaw = String(req.query.enabled || "").trim().toLowerCase();
  const enabled = enabledRaw ? enabledRaw === "true" : undefined;
  try {
    const items = await listStageTemplateSuggestions({
      stage: stage || undefined,
      enabled,
      limit: 200
    });
    return res.status(200).json({ items });
  } catch (error) {
    console.error("[whatsapp-stage-templates] get", error);
    return res.status(503).json({ error: "stage_template_suggestions_unavailable" });
  }
});

whatsappRouter.post("/api/whatsapp/stage-template-suggestions", async (req, res) => {
  const parsed = stageTemplateSuggestionSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const created = await createStageTemplateSuggestion({
      stage: parsed.data.stage,
      template_name: parsed.data.template_name,
      priority: parsed.data.priority ?? 100,
      enabled: parsed.data.enabled ?? true
    });
    return res.status(200).json(created);
  } catch (error) {
    console.error("[whatsapp-stage-templates] post", error);
    return res.status(503).json({ error: "stage_template_suggestion_create_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/stage-template-suggestions/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const parsed = stageTemplateSuggestionSchema.pick({ priority: true, enabled: true }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const updated = await patchStageTemplateSuggestion(id, {
      priority: parsed.data.priority,
      enabled: parsed.data.enabled
    });
    if (!updated) return res.status(404).json({ error: "stage_template_suggestion_not_found" });
    return res.status(200).json(updated);
  } catch (error) {
    console.error("[whatsapp-stage-templates] patch", error);
    return res.status(503).json({ error: "stage_template_suggestion_update_failed" });
  }
});

whatsappRouter.delete("/api/whatsapp/stage-template-suggestions/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  try {
    const ok = await deleteStageTemplateSuggestion(id);
    if (!ok) return res.status(404).json({ error: "stage_template_suggestion_not_found" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp-stage-templates] delete", error);
    return res.status(503).json({ error: "stage_template_suggestion_delete_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/metrics", async (req, res) => {
  const parsed = daysQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });

  try {
    const metrics = await getWhatsAppMetrics(queryRangeDays(parsed.data));
    return res.status(200).json({
      total_inquiries: metrics.totalInquiries,
      conversion_rate: metrics.conversionRate,
      avg_response_time: metrics.avgResponseTime,
      avg_first_response_time: metrics.avgResponseTime,
      active_leads: metrics.activeLeads,
      leads_at_risk: metrics.leadsAtRisk,
      fast_response_pct: metrics.fastResponsePct,
      slow_response_pct: metrics.slowResponsePct,
      pct_response_under_15m: metrics.fastResponsePct,
      pct_response_over_1h: metrics.slowResponsePct,
      conversion_fast_pct: metrics.conversionFastPct,
      conversion_slow_pct: metrics.conversionSlowPct,
      stage_distribution: metrics.stageDistribution
    });
  } catch (error) {
    console.error("[whatsapp] metrics", error);
    return res.status(503).json({ error: "metrics_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/priority-inbox", async (req, res) => {
  try {
    const leads = await listWhatsAppLeads({
      days: 7,
      stage: "ALL",
      limit: 200
    });

    const leadIds = leads.map((lead) => String(lead.id || "")).filter(Boolean);
    const [recentMessagesByLead] = await Promise.all([
      listRecentMessagesByLeadIds(leadIds, 20)
    ]);

    const readyCards = await Promise.all(
      leads.map(async (lead) => {
        const destination = buildLeadDestination(lead);
        const riskMessagesRaw: Array<{ direction: "in" | "out"; text: string; ts: string }> = (
          recentMessagesByLead.get(String(lead.id || "")) || []
        ).map((msg) => ({
          direction: msg.direction === "OUT" ? "out" : "in",
          text: String(msg.text || ""),
          ts: msg.createdAt
        }));
        const riskMessages = riskMessagesRaw
          .slice()
          .sort((a, b) => Date.parse(String(a.ts || "")) - Date.parse(String(b.ts || "")));
        const lastRiskMessage = riskMessages.length ? riskMessages[riskMessages.length - 1] : null;
        const waitingFor = lastRiskMessage
          ? (lastRiskMessage.direction === "in" ? "WAITING_FOR_US" : "WAITING_FOR_CLIENT")
          : null;
        const readyToSendApprovedQuote = isLeadReadyToSendApprovedQuote(lead);

        if (waitingFor !== "WAITING_FOR_US" && !readyToSendApprovedQuote) return null;

        const suggestionMessages = riskMessages.map((msg) => ({
          direction: (msg.direction === "in" ? "IN" : "OUT") as "IN" | "OUT",
          text: msg.text,
          ts: msg.ts
        }));

        const suggestionFacts = {
          stage: lead.stage,
          lang: "FR",
          country: lead.country,
          event_date: lead.eventDate,
          event_date_text: lead.eventDateText,
          destination,
          conv_percent: lead.conversionProbability?.probability ?? null,
          risk_score: computeRiskScore({
            facts: {
              stage: lead.stage,
              lang: "FR",
              event_date: lead.eventDate,
              destination,
              conv_percent: lead.conversionProbability?.probability ?? null,
              intents: {
                price_intent: lead.priceIntent,
                video_intent: lead.videoIntent,
                payment_intent: lead.paymentIntent,
                deposit_intent: lead.depositIntent,
                confirmation_intent: lead.confirmationIntent
              },
              hours_since_last_activity: lead.risk.hoursSinceLastActivity
            },
            messages: riskMessages
          }).risk_score,
          intents: {
            price_intent: lead.priceIntent,
            video_intent: lead.videoIntent,
            payment_intent: lead.paymentIntent,
            deposit_intent: lead.depositIntent,
            confirmation_intent: lead.confirmationIntent
          }
        };

        const suggestions = buildSuggestions({
          facts: suggestionFacts,
          messages: suggestionMessages
        });

        if (!suggestions || suggestions.length === 0) return null;

        const qa = getLeadQuoteApproval(lead);
        const qaPrice = toRecord(qa.price);
        const qaAmount = Number(qaPrice.approved_amount);
        const qaCurrencyRaw = String(qaPrice.approved_currency || "MAD").toUpperCase();
        const qaCurrency =
          qaCurrencyRaw === "USD" || qaCurrencyRaw === "EUR" || qaCurrencyRaw === "MAD"
            ? (qaCurrencyRaw as "USD" | "EUR" | "MAD")
            : "MAD";
        const qaFormatted = Number.isFinite(qaAmount) && qaAmount > 0
          ? formatApprovedAmount(qaAmount, qaCurrency)
          : null;
        const topSuggestion = readyToSendApprovedQuote
          ? {
              id: "send_to_client",
              text: qaFormatted
                ? `Devis approuvé prêt à envoyer (${qaFormatted}).`
                : "Devis approuvé prêt à envoyer.",
              title: "Envoyer au client",
              reason: "Manager-approved quote ready",
              source: "system" as const,
              requiresReview: false,
              priority_unified: { level: "CRITICAL", score: 100 },
              timing: null,
              smart_delay: null
            }
          : suggestions[0];
        const sessionStatus = await getWhatsAppLeadSessionStatus(lead.id, 24);
        const lastInbound = riskMessages.filter((m) => m.direction === "in").slice(-1)[0];
        const timeSinceLastInbound = lastInbound
          ? Math.floor((Date.now() - Date.parse(lastInbound.ts)) / 60000)
          : null;

        const priorityLevel = topSuggestion.priority_unified?.level || "MEDIUM";
        const priorityScore = topSuggestion.priority_unified?.score || 50;
        const timingPressure = topSuggestion.timing?.pressure_score || 0;

        return {
          leadId: lead.id,
          displayName: lead.clientName,
          country: lead.country || "MA",
          stageMain: lead.stage,
          readyToSend: readyToSendApprovedQuote,
          readyBadge: readyToSendApprovedQuote ? "Prêt à envoyer" : null,
          approvedQuote: readyToSendApprovedQuote
            ? {
                quoteRequestId: String(qa.quote_request_id || ""),
                amount: Number.isFinite(qaAmount) ? qaAmount : null,
                currency: qaCurrency,
                formatted: qaFormatted,
                productionMode: String(qa.production_mode || "MADE_TO_ORDER")
              }
            : null,
          lastInboundAt: lastInbound?.ts || null,
          sessionEndsAt: sessionStatus.expiresAt,
          priorityScore,
          priorityLevel,
          timingPressure,
          riskScore: suggestionFacts.risk_score || 0,
          timeSinceLastInbound,
          sessionTimeLeft: sessionStatus.isSessionOpen
            ? Math.floor((Date.parse(sessionStatus.expiresAt || "") - Date.now()) / 60000)
            : null,
          suggestion: {
            id: topSuggestion.id,
            text: topSuggestion.text,
            title: topSuggestion.title,
            reason: topSuggestion.reason,
            source: "ai" as const,
            requiresReview: topSuggestion.smart_delay?.should_delay || false
          }
        };
      })
    );

    const filtered = readyCards.filter((card): card is NonNullable<typeof card> => card !== null);

    filtered.sort((a, b) => {
      if (Boolean(a.readyToSend) !== Boolean(b.readyToSend)) return a.readyToSend ? -1 : 1;
      if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
      if (a.timingPressure !== b.timingPressure) return b.timingPressure - a.timingPressure;
      const aTime = a.lastInboundAt ? Date.parse(a.lastInboundAt) : 0;
      const bTime = b.lastInboundAt ? Date.parse(b.lastInboundAt) : 0;
      return aTime - bTime;
    });

    return res.status(200).json({ cards: filtered });
  } catch (error) {
    console.error("[whatsapp] priority-inbox", error);
    return res.status(503).json({ error: "priority_inbox_unavailable" });
  }
});

whatsappRouter.get("/api/workflow/quote-approval/metrics", async (_req, res) => {
  const db = getDbPool();
  if (!db) {
    console.warn("[workflow-metrics] DATABASE_URL is not configured");
    return res.status(200).json({
      quoteRequests7d: 0,
      pendingManager: 0,
      readyToSend: 0,
      sentToday: 0
    });
  }

  try {
    const [quoteRequests7dQ, pendingManagerQ, readyToSendQ, sentTodayQ] = await Promise.all([
      db.query<{ count: string }>(
        `
          select count(*)::text as count
          from quote_requests
          where created_at >= now() - interval '7 days'
        `
      ),
      db.query<{ count: string }>(
        `
          with pending_requests as (
            select distinct lead_id
            from quote_requests
            where status = 'PENDING'
          ),
          lead_waiting as (
            select id as lead_id
            from whatsapp_leads
            where coalesce(detected_signals->'quote_approval'->>'stage_recommendation', '') = 'PRICE_EDIT_REQUIRED'
          )
          select count(distinct lead_id)::text as count
          from (
            select lead_id from pending_requests
            union all
            select lead_id from lead_waiting
          ) s
        `
      ),
      db.query<{ count: string }>(
        `
          select count(*)::text as count
          from whatsapp_leads
          where stage = 'PRICE_APPROVED_READY_TO_SEND'
             or (
               coalesce(detected_signals->'quote_approval'->'price'->>'approved', 'false') = 'true'
               and coalesce(detected_signals->'quote_approval'->>'price_sent', 'false') <> 'true'
             )
        `
      ),
      db.query<{ count: string }>(
        `
          with sent_actions as (
            select quote_request_id
            from quote_actions
            where action_type = 'SEND_TO_CLIENT'
              and created_at >= date_trunc('day', now())
          ),
          sent_messages as (
            select distinct nullif(trim(coalesce(metadata->>'quote_request_id', '')), '') as quote_request_id
            from whatsapp_lead_messages
            where direction = 'OUT'
              and created_at >= date_trunc('day', now())
              and coalesce(metadata->>'approved_quote_sent', 'false') = 'true'
          )
          select (
            coalesce((select count(*) from sent_actions), 0) +
            coalesce((select count(*) from sent_messages), 0)
          )::text as count
        `
      )
    ]);

    const asNumber = (value: unknown): number => {
      const num = Number(value || 0);
      return Number.isFinite(num) ? num : 0;
    };

    return res.status(200).json({
      quoteRequests7d: asNumber(quoteRequests7dQ.rows[0]?.count),
      pendingManager: asNumber(pendingManagerQ.rows[0]?.count),
      readyToSend: asNumber(readyToSendQ.rows[0]?.count),
      sentToday: asNumber(sentTodayQ.rows[0]?.count)
    });
  } catch (error) {
    console.warn("[workflow-metrics] query_failed", { error });
    return res.status(200).json({
      quoteRequests7d: 0,
      pendingManager: 0,
      readyToSend: 0,
      sentToday: 0
    });
  }
});

whatsappRouter.get("/api/whatsapp/leads", async (req, res) => {
  const parsed = daysQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });

  try {
    const leads = await listWhatsAppLeads({
      days: queryRangeDays(parsed.data),
      stage: asStageOrAll(parsed.data.stage),
      limit: 600
    });
    const leadIds = leads.map((lead) => String(lead.id || "")).filter(Boolean);
    const [inboundByLead, recentMessagesByLead] = await Promise.all([
      listRecentInboundMessageTextsByLead(leadIds, 30),
      listRecentMessagesByLeadIds(leadIds, 20)
    ]);

    const items = await Promise.all(
      leads.map(async (lead) => {
        const destination = buildLeadDestination(lead);
        const riskMessagesRaw: Array<{ direction: "in" | "out"; text: string; ts: string }> = (
          recentMessagesByLead.get(String(lead.id || "")) || []
        ).map((msg) => ({
          direction: msg.direction === "OUT" ? "out" : "in",
          text: String(msg.text || ""),
          ts: msg.createdAt
        }));
        const riskMessages = riskMessagesRaw
          .slice()
          .sort((a, b) => Date.parse(String(a.ts || "")) - Date.parse(String(b.ts || "")));
        const lastRiskMessage = riskMessages.length ? riskMessages[riskMessages.length - 1] : null;
        const waitingFor = lastRiskMessage
          ? (lastRiskMessage.direction === "in" ? "WAITING_FOR_US" : "WAITING_FOR_CLIENT")
          : null;
        const risk = computeRiskScore({
          facts: {
            stage: lead.stage,
            lang: "FR",
            event_date: lead.eventDate,
            destination,
            conv_percent: lead.conversionProbability?.probability ?? null,
            intents: {
              price_intent: lead.priceIntent,
              video_intent: lead.videoIntent,
              payment_intent: lead.paymentIntent,
              deposit_intent: lead.depositIntent,
              confirmation_intent: lead.confirmationIntent
            },
            hours_since_last_activity: lead.risk.hoursSinceLastActivity
          },
          messages: riskMessages
        });

        return {
        ...(() => {
          const fromLead = extractProductHandlesFromText(String(lead.productReference || ""));
          const fromInbound = (inboundByLead.get(String(lead.id || "")) || [])
            .flatMap((text) => extractProductHandlesFromText(String(text || "")));
          const mergedHandles = Array.from(new Set([...fromLead, ...fromInbound]));
          return { product_handles: mergedHandles };
        })(),
        ...(() => {
          const reason = String(lead.stageAutoReason || "");
          return {
            auto_stage_progression: {
              enabled: Boolean(lead.stageAuto),
              last_trigger: lead.stageAutoReason
                ? {
                    reason: lead.stageAutoReason,
                    source_message_id: lead.stageAutoSourceMessageId || null,
                    confidence: lead.stageAutoConfidence,
                    updated_at: lead.stageAutoUpdatedAt || null
                  }
                : null,
              signals: {
                product_interest: Boolean(lead.hasProductInterest),
                price_sent: Boolean(lead.hasPriceSent),
                video_proposed: Boolean(lead.hasVideoProposed),
                payment_question: Boolean(lead.hasPaymentQuestion),
                deposit_link_sent: Boolean(lead.hasDepositLinkSent),
                deposit_pending: Boolean(lead.hasPaymentQuestion || lead.hasDepositLinkSent),
                chat_confirmed: Boolean(lead.chatConfirmed),
                reason
              }
            }
          };
        })(),
        recommended_stage: lead.recommendedStage,
        recommended_reason: lead.recommendedStageReason,
        recommended_stage_confidence: lead.recommendedStageConfidence,
        id: lead.id,
        client: lead.clientName,
        phone: lead.phoneNumber || "",
        is_test: Boolean(lead.isTest),
        test_tag: lead.testTag || null,
        profile_image_url: lead.profileImageUrl || null,
        channel_type: lead.channelType,
        ai_mode: lead.aiMode,
        country: lead.country || "-",
        source: lead.inquirySource || "-",
        product: lead.productReference || "-",
        marketing_opt_in: lead.marketingOptIn,
        marketing_opt_in_source: lead.marketingOptInSource,
        marketing_opt_in_at: lead.marketingOptInAt,
        event_date: lead.eventDate,
        event_date_text: lead.eventDateText,
        event_date_confidence: lead.eventDateConfidence,
        event_date_source_message_id: lead.eventDateSourceMessageId,
        event_date_updated_at: lead.eventDateUpdatedAt,
        event_date_manual: lead.eventDateManual,
        ship_city: lead.shipCity,
        ship_region: lead.shipRegion,
        ship_country: lead.shipCountry,
        ship_destination_text: lead.shipDestinationText,
        ship_destination_confidence: lead.shipDestinationConfidence,
        ship_destination_source_message_id: lead.shipDestinationSourceMessageId,
        ship_destination_updated_at: lead.shipDestinationUpdatedAt,
        ship_destination_manual: lead.shipDestinationManual,
        has_product_interest: lead.hasProductInterest,
        has_price_sent: lead.hasPriceSent,
        has_video_proposed: lead.hasVideoProposed,
        has_payment_question: lead.hasPaymentQuestion,
        has_deposit_link_sent: lead.hasDepositLinkSent,
        chat_confirmed: lead.chatConfirmed,
        last_signal_at: lead.lastSignalAt,
        product_interest_source_message_id: lead.productInterestSourceMessageId,
        price_sent_source_message_id: lead.priceSentSourceMessageId,
        video_proposed_source_message_id: lead.videoProposedSourceMessageId,
        payment_question_source_message_id: lead.paymentQuestionSourceMessageId,
        deposit_link_source_message_id: lead.depositLinkSourceMessageId,
        chat_confirmed_source_message_id: lead.chatConfirmedSourceMessageId,
        stage: lead.stage,
        price_sent: lead.priceSent,
        first_response_time_minutes: lead.firstResponseTimeMinutes,
        last_activity_at: lead.lastActivityAt || lead.createdAt,
        created_at: lead.createdAt,
        risk: {
          ...risk,
          // Backward-compatible fields consumed by existing UI code paths.
          is_at_risk: risk.at_risk,
          hours_since_last_activity: lead.risk.hoursSinceLastActivity,
          threshold_hours: lead.risk.thresholdHours
        },
        internal_notes: lead.internalNotes || "",
        qualification_tags: lead.qualificationTags || [],
        intent_level: lead.intentLevel || null,
        stage_confidence: lead.stageConfidence,
        stage_auto: lead.stageAuto,
        stage_auto_reason: lead.stageAutoReason,
        stage_auto_source_message_id: lead.stageAutoSourceMessageId,
        waiting_for: waitingFor,
        last_message_snippet: lastRiskMessage ? String(lastRiskMessage.text || "") : "",
        stage_auto_confidence: lead.stageAutoConfidence,
        stage_auto_updated_at: lead.stageAutoUpdatedAt,
        detected_signals: lead.detectedSignals || { tags: [], rules_triggered: [], evidence: [] },
        shopify_order_id: lead.shopifyOrderId,
        shopify_financial_status: lead.shopifyFinancialStatus,
        payment_received: lead.paymentReceived,
        deposit_paid: lead.depositPaid,
        ticket_value: lead.ticketValue,
        ticket_currency: lead.ticketCurrency,
        score: lead.score,
        score_breakdown: lead.scoreBreakdown,
        conversion_probability: lead.conversionProbability.probability,
        conversion_band: lead.conversionProbability.band,
        conversion_reasons: lead.conversionProbability.reasons,
        urgency: computeLeadUrgency(lead),
        signals: {
          chat_confirmed: Boolean(lead.chatConfirmed),
          payment_question: Boolean(lead.hasPaymentQuestion),
          deposit_link_sent: Boolean(lead.hasDepositLinkSent)
        },
        rule_applied: lead.stageAutoReason || null
      };
      })
    );

    if (env.NODE_ENV !== "production" && items.length) {
      console.log("[whatsapp] leads risk sample", {
        id: items[0].id,
        stage: items[0].stage,
        risk: items[0].risk
      });
    }

    return res.status(200).json({
      items
    });
  } catch (error) {
    console.error("[whatsapp] leads", error);
    return res.status(503).json({ error: "leads_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/test", async (_req, res) => {
  if (!isTestDeletionEnabled()) return res.status(403).json({ error: "test_deletion_not_allowed" });
  const db = getDbPool();
  if (!db) return res.status(503).json({ error: "db_unavailable" });
  try {
    const q = await db.query<{
      id: string;
      client_name: string;
      phone_number: string;
      stage: string;
      test_tag: string | null;
      updated_at: string;
    }>(
      `
        select id, client_name, phone_number, stage, test_tag, updated_at
        from whatsapp_leads
        where is_test = true
        order by updated_at desc
        limit 200
      `
    );
    return res.status(200).json({
      items: q.rows.map((row) => ({
        id: row.id,
        client_name: row.client_name,
        phone_number: row.phone_number,
        stage: row.stage,
        test_tag: row.test_tag,
        updated_at: row.updated_at
      }))
    });
  } catch (error) {
    console.error("[whatsapp] list test leads failed", { error });
    return res.status(503).json({ error: "test_leads_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/test/counts", async (req, res) => {
  if (!isTestDeletionEnabled()) return res.status(403).json({ error: "test_deletion_not_allowed" });
  const db = getDbPool();
  if (!db) return res.status(503).json({ error: "db_unavailable" });
  const leadId = String(req.query.leadId || "").trim();
  try {
    let leadIds: string[] = [];
    if (leadId) {
      const one = await db.query<{ id: string; is_test: boolean }>(
        `select id, is_test from whatsapp_leads where id = $1::uuid limit 1`,
        [leadId]
      );
      if (!one.rows[0]) return res.status(404).json({ error: "lead_not_found" });
      if (!one.rows[0].is_test) return res.status(403).json({ error: "lead_not_test" });
      leadIds = [one.rows[0].id];
    } else {
      const all = await db.query<{ id: string }>(`select id from whatsapp_leads where is_test = true`);
      leadIds = all.rows.map((r) => String(r.id || "")).filter(Boolean);
    }
    if (!leadIds.length) {
      return res.status(200).json({
        leads: 0,
        messages: 0,
        ai_runs: 0,
        quotes: 0
      });
    }
    const [messagesQ, runsQ, quoteRequestsQ, quoteLinesQ] = await Promise.all([
      db.query<{ count: string }>(`select count(*)::text as count from whatsapp_lead_messages where lead_id = any($1::uuid[])`, [leadIds]),
      db.query<{ count: string }>(`select count(*)::text as count from ai_agent_runs where lead_id = any($1::uuid[])`, [leadIds]),
      db.query<{ count: string }>(`select count(*)::text as count from quote_requests where lead_id = any($1::uuid[])`, [leadIds]),
      db.query<{ count: string }>(`select count(*)::text as count from lead_price_quotes where lead_id = any($1::uuid[])`, [leadIds])
    ]);
    return res.status(200).json({
      leads: leadIds.length,
      messages: Number(messagesQ.rows[0]?.count || 0),
      ai_runs: Number(runsQ.rows[0]?.count || 0),
      quotes: Number(quoteRequestsQ.rows[0]?.count || 0) + Number(quoteLinesQ.rows[0]?.count || 0)
    });
  } catch (error) {
    console.error("[whatsapp] test counts failed", { leadId: leadId || null, error });
    return res.status(503).json({ error: "test_counts_unavailable" });
  }
});

whatsappRouter.delete("/api/whatsapp/leads/test", async (req, res) => {
  if (!isTestDeletionEnabled()) return res.status(403).json({ error: "test_deletion_not_allowed" });
  const db = getDbPool();
  if (!db) return res.status(503).json({ error: "db_unavailable" });

  const parsed = deleteTestLeadsSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const requestedLeadId = String(parsed.data.leadId || "").trim();
  const modeAll = parsed.data.mode === "all";

  const client = await db.connect();
  try {
    await client.query("begin");

    let leadIds: string[] = [];
    if (modeAll) {
      const all = await client.query<{ id: string }>(`select id from whatsapp_leads where is_test = true`);
      leadIds = all.rows.map((r) => String(r.id || "")).filter(Boolean);
    } else {
      const one = await client.query<{ id: string; is_test: boolean }>(
        `select id, is_test from whatsapp_leads where id = $1::uuid limit 1`,
        [requestedLeadId]
      );
      if (!one.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "lead_not_found" });
      }
      if (!one.rows[0].is_test) {
        await client.query("rollback");
        return res.status(403).json({ error: "lead_not_test" });
      }
      leadIds = [one.rows[0].id];
    }

    if (!leadIds.length) {
      await client.query("commit");
      return res.status(200).json({
        deleted_leads: 0,
        deleted_messages: 0,
        deleted_ai_runs: 0,
        deleted_quotes: 0
      });
    }

    const [messagesQ, runsQ, quoteRequestsQ, quoteLinesQ] = await Promise.all([
      client.query<{ count: string }>(`select count(*)::text as count from whatsapp_lead_messages where lead_id = any($1::uuid[])`, [leadIds]),
      client.query<{ count: string }>(`select count(*)::text as count from ai_agent_runs where lead_id = any($1::uuid[])`, [leadIds]),
      client.query<{ count: string }>(`select count(*)::text as count from quote_requests where lead_id = any($1::uuid[])`, [leadIds]),
      client.query<{ count: string }>(`select count(*)::text as count from lead_price_quotes where lead_id = any($1::uuid[])`, [leadIds])
    ]);

    const deletedLeads = await client.query(
      `delete from whatsapp_leads where id = any($1::uuid[]) and is_test = true`,
      [leadIds]
    );

    const deleted_messages = Number(messagesQ.rows[0]?.count || 0);
    const deleted_ai_runs = Number(runsQ.rows[0]?.count || 0);
    const deleted_quotes =
      Number(quoteRequestsQ.rows[0]?.count || 0) +
      Number(quoteLinesQ.rows[0]?.count || 0);
    const deleted_leads = Number(deletedLeads.rowCount || 0);

    await client.query("commit");
    console.warn("[whatsapp] test lead deletion", {
      mode: modeAll ? "all" : "single",
      requestedLeadId: requestedLeadId || null,
      deleted_leads,
      deleted_messages,
      deleted_ai_runs,
      deleted_quotes
    });
    return res.status(200).json({
      deleted_leads,
      deleted_messages,
      deleted_ai_runs,
      deleted_quotes
    });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    console.error("[whatsapp] delete test leads failed", {
      mode: modeAll ? "all" : "single",
      requestedLeadId: requestedLeadId || null,
      error
    });
    return res.status(503).json({ error: "test_leads_delete_failed" });
  } finally {
    client.release();
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/insights", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const insight = await getLatestAiInsightByConversationId(leadId);
    return res.status(200).json({
      conversation_id: leadId,
      insight: insight
        ? {
            intents: insight.intents,
            suggested_replies: insight.suggestedReplies,
            proposed_stage: insight.proposedStage,
            payload: insight.payload,
            updated_at: insight.updatedAt
          }
        : null
    });
  } catch (error) {
    console.error("[whatsapp] lead insights", error);
    return res.status(503).json({ error: "lead_insights_unavailable" });
  }
});

whatsappRouter.post("/api/whatsapp/shared-import", async (req, res) => {
  const parsed = sharedImportSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const importedAt = safeIsoNow();
    const importedBy = String(parsed.data.imported_by || "admin").trim() || "admin";
    const ownerLabels = Array.isArray(parsed.data.owner_labels) && parsed.data.owner_labels.length
      ? parsed.data.owner_labels
      : ["you", "moi", "me", "admin"];

    const parsedFromRaw = parsed.data.raw_text
      ? parseSharedWhatsAppExportText(parsed.data.raw_text, ownerLabels)
      : [];
    const parsedFromManual = Array.isArray(parsed.data.messages)
      ? parsed.data.messages.map((m) => ({
          direction: m.direction,
          text: String(m.text || "").trim(),
          created_at: m.created_at ? String(m.created_at) : null
        }))
      : [];

    const normalizedImportedMessages = [
      ...parsedFromRaw.map((m) => ({ direction: m.direction, text: m.text, created_at: null as string | null })),
      ...parsedFromManual
    ].filter((m) => String(m.text || "").trim());

    if (!normalizedImportedMessages.length) {
      return res.status(400).json({ error: "no_messages_to_import" });
    }

    const fallbackClientName = `Shared Import ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
    const fallbackPhoneNumber = `shared-${Date.now()}`;
    const safeClientName = String(parsed.data.client_name || "").trim() || fallbackClientName;
    const safePhoneNumber = String(parsed.data.phone_number || "").trim() || fallbackPhoneNumber;

    let lead = parsed.data.conversation_id ? await getWhatsAppLeadById(parsed.data.conversation_id) : null;
    if (!lead) {
      lead = await createWhatsAppLead({
        clientName: safeClientName,
        phoneNumber: safePhoneNumber,
        country: parsed.data.country || null,
        inquirySource: "Shared Import",
        productReference: parsed.data.product_reference || null,
        stage: "NEW",
        channelType: "SHARED",
        aiMode: "ANALYZE_ONLY"
      });
    }
    if (!lead) return res.status(503).json({ error: "lead_upsert_failed" });

    const baseTs = Date.now() - normalizedImportedMessages.length * 30000;
    await Promise.all(
      normalizedImportedMessages.map((msg, idx) =>
        createWhatsAppLeadMessageWithTracking({
          leadId: lead!.id,
          direction: msg.direction,
          text: String(msg.text || ""),
          createdAt:
            (msg.created_at && Number.isFinite(new Date(msg.created_at).getTime()) ? msg.created_at : null) ||
            new Date(baseTs + idx * 30000).toISOString(),
          provider: "shared_import",
          messageType: "text",
          metadata: {
            source: "SHARED_IMPORT",
            channel_type: "SHARED",
            reliability: "LOW",
            imported_by: importedBy,
            imported_at: importedAt
          }
        }, {
          source: msg.direction === "IN" ? "INBOUND" : "OUTBOUND_MANUAL",
          ui_source: "shared_import"
        })
      )
    );

    const recentConversation = await listRecentWhatsAppLeadMessages(lead.id, 80);
    const chronologicalConversation = recentConversation.slice().reverse();
    const progressionMessages = chronologicalConversation.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      createdAt: m.createdAt
    }));
    const inboundSnippets = progressionMessages
      .filter((m) => m.direction === "IN")
      .map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt }));

    const eventExtraction = extractEventDateFromMessages(inboundSnippets, new Date(), "UTC");
    const destinationExtraction = extractDestinationFromMessages(
      progressionMessages,
      { country: lead.country, shipCountry: lead.shipCountry },
      new Date()
    );

    const leadForSignals = {
      ...lead,
      eventDate: eventExtraction.date || lead.eventDate || null,
      shipCity: destinationExtraction.ship_city || lead.shipCity || null,
      shipRegion: destinationExtraction.ship_region || lead.shipRegion || null,
      shipCountry: destinationExtraction.ship_country || lead.shipCountry || null,
      shipDestinationText: destinationExtraction.raw || lead.shipDestinationText || null
    };
    const signalDetection = detectSignalsFromMessages(progressionMessages, leadForSignals);
    const leadForProgression = {
      ...leadForSignals,
      hasProductInterest: lead.hasProductInterest || signalDetection.hasProductInterest,
      hasPriceSent: lead.hasPriceSent || signalDetection.hasPriceSent,
      hasVideoProposed: lead.hasVideoProposed || signalDetection.hasVideoProposed,
      hasPaymentQuestion: lead.hasPaymentQuestion || signalDetection.hasPaymentQuestion,
      hasDepositLinkSent: lead.hasDepositLinkSent || signalDetection.hasDepositLinkSent,
      chatConfirmed: lead.chatConfirmed || signalDetection.chatConfirmed,
      priceIntent: lead.priceIntent || signalDetection.priceIntent,
      videoIntent: lead.videoIntent || signalDetection.videoIntent,
      paymentIntent: lead.paymentIntent || signalDetection.paymentIntent,
      depositIntent: lead.depositIntent || signalDetection.depositIntent,
      confirmationIntent: lead.confirmationIntent || signalDetection.confirmationIntent
    };
    const progression = applyStageProgression(
      leadForProgression,
      detectConversationEvents(progressionMessages, leadForProgression),
      {
        paymentReceived: leadForProgression.paymentReceived,
        depositPaid: leadForProgression.depositPaid,
        hasPaidShopifyOrder: leadForProgression.stage === "CONVERTED",
        shopifyFinancialStatus: leadForProgression.shopifyFinancialStatus
      }
    );

    const destinationText = buildLeadDestination({
      shipDestinationText: leadForProgression.shipDestinationText,
      shipCity: leadForProgression.shipCity,
      shipRegion: leadForProgression.shipRegion,
      shipCountry: leadForProgression.shipCountry
    });
    const suggestionCards = buildSuggestions({
      facts: {
        stage: progression.nextStage,
        lang: "FR",
        country: leadForProgression.country || null,
        event_date: leadForProgression.eventDate || null,
        event_month: eventExtraction.eventMonth,
        event_date_precision: eventExtraction.eventDatePrecision,
        event_date_estimate_iso: eventExtraction.eventDateEstimateIso,
        event_date_text: eventExtraction.raw || leadForProgression.eventDateText || null,
        destination: destinationText,
        intents: {
          price_intent: leadForProgression.priceIntent,
          video_intent: leadForProgression.videoIntent,
          payment_intent: leadForProgression.paymentIntent,
          deposit_intent: leadForProgression.depositIntent,
          confirmation_intent: leadForProgression.confirmationIntent
        }
      },
      messages: chronologicalConversation.slice(-20).map((m) => ({
        direction: m.direction === "OUT" ? "out" : "in",
        text: m.text,
        ts: m.createdAt
      }))
    });

    const insight = await createAiInsight({
      conversationId: lead.id,
      intents: {
        price_intent: Boolean(leadForProgression.priceIntent),
        video_intent: Boolean(leadForProgression.videoIntent),
        payment_intent: Boolean(leadForProgression.paymentIntent),
        deposit_intent: Boolean(leadForProgression.depositIntent),
        confirmation_intent: Boolean(leadForProgression.confirmationIntent),
        destination: destinationText,
        event_date: leadForProgression.eventDate || null
      },
      suggestedReplies: suggestionCards.slice(0, 4).map((card) => String(card.text || "").trim()).filter(Boolean),
      proposedStage: progression.nextStage,
      payload: {
        source: "SHARED_IMPORT",
        channel_type: "SHARED",
        ai_mode: "ANALYZE_ONLY",
        imported_by: importedBy,
        imported_at: importedAt,
        reasons: suggestionCards.slice(0, 4).map((card) => ({
          id: card.id,
          title: card.title,
          reason: card.reason,
          priority: card.priority
        }))
      }
    });

    if (env.NODE_ENV !== "production") {
      console.log("[whatsapp] shared-import analyzed", {
        lead_id: lead.id,
        imported_messages: normalizedImportedMessages.length,
        proposed_stage: progression.nextStage,
        suggested_replies: insight?.suggestedReplies?.length || 0
      });
    }

    return res.status(200).json({
      ok: true,
      conversation_id: lead.id,
      lead_id: lead.id,
      imported_messages: normalizedImportedMessages.length,
      channel_type: "SHARED",
      ai_mode: "ANALYZE_ONLY",
      analysis: {
        intents: insight?.intents || {},
        suggested_replies: insight?.suggestedReplies || [],
        proposed_stage: insight?.proposedStage || progression.nextStage
      }
    });
  } catch (error) {
    console.error("[whatsapp] shared import", error);
    return res.status(503).json({ error: "shared_import_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/leads/:id/event-date", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = eventDatePatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const ok = await updateWhatsAppLeadEventDate({
      id: leadId,
      eventDate: parsed.data.event_date,
      eventDateText: parsed.data.event_date ? (lead.eventDateText || "manual_override") : null,
      eventDateConfidence: parsed.data.event_date ? Math.max(lead.eventDateConfidence || 0, 95) : null,
      sourceMessageId: parsed.data.event_date ? lead.eventDateSourceMessageId : null,
      manual: true
    });
    if (!ok) return res.status(503).json({ error: "event_date_update_failed" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] event-date patch", error);
    return res.status(503).json({ error: "event_date_patch_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/leads/:id/destination", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = destinationPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const ok = await updateWhatsAppLeadDestination({
      id: leadId,
      shipCity: parsed.data.ship_city ?? null,
      shipRegion: parsed.data.ship_region ?? null,
      shipCountry: parsed.data.ship_country ?? null,
      shipDestinationText: parsed.data.ship_destination_text ?? null,
      shipDestinationConfidence: Math.max(lead.shipDestinationConfidence || 0, 95),
      sourceMessageId: lead.shipDestinationSourceMessageId,
      manual: true
    });
    if (!ok) return res.status(503).json({ error: "destination_update_failed" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] destination patch", error);
    return res.status(503).json({ error: "destination_patch_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/leads/:id/event-date/recalculate", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    await updateWhatsAppLeadEventDate({
      id: leadId,
      eventDate: lead.eventDate,
      eventDateText: lead.eventDateText,
      eventDateConfidence: lead.eventDateConfidence,
      sourceMessageId: lead.eventDateSourceMessageId,
      manual: false
    });
    const inbound = await listRecentInboundMessagesForLead(leadId, 20);
    const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
    const refreshedLead = { ...lead, eventDateManual: false };
    const result = await applyInboundSignalExtraction(
      refreshedLead,
      inbound,
      recentConversation.map((m) => ({
        id: m.id,
        text: m.text,
        createdAt: m.createdAt,
        direction: m.direction
      }))
    );
    const extracted = result.eventDateUpdated ? extractEventDateFromMessages(inbound, new Date(), "UTC") : null;
    return res.status(200).json({ ok: true, extracted });
  } catch (error) {
    console.error("[whatsapp] event-date recalculate", error);
    return res.status(503).json({ error: "event_date_recalculate_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/leads/:id/recalculate-signals", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    await updateWhatsAppLeadEventDate({
      id: leadId,
      eventDate: lead.eventDate,
      eventDateText: lead.eventDateText,
      eventDateConfidence: lead.eventDateConfidence,
      sourceMessageId: lead.eventDateSourceMessageId,
      manual: false
    });
    await updateWhatsAppLeadDestination({
      id: leadId,
      shipCity: lead.shipCity,
      shipRegion: lead.shipRegion,
      shipCountry: lead.shipCountry,
      shipDestinationText: lead.shipDestinationText,
      shipDestinationConfidence: lead.shipDestinationConfidence,
      sourceMessageId: lead.shipDestinationSourceMessageId,
      manual: false
    });
    const inbound = await listRecentInboundMessagesForLead(leadId, 20);
    const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
    const refreshedLead = {
      ...lead,
      eventDateManual: false,
      shipDestinationManual: false
    };
    await applyInboundSignalExtraction(
      refreshedLead,
      inbound,
      recentConversation.map((m) => ({
        id: m.id,
        text: m.text,
        createdAt: m.createdAt,
        direction: m.direction
      }))
    );
    const extracted = {
      event_date: extractEventDateFromMessages(inbound, new Date(), "UTC"),
      destination: extractDestinationFromMessages(
        recentConversation.map((m) => ({
          id: m.id,
          text: m.text,
          createdAt: m.createdAt,
          direction: m.direction
        })),
        { country: lead.country, shipCountry: lead.shipCountry },
        new Date()
      )
    };
    return res.status(200).json({ ok: true, extracted });
  } catch (error) {
    console.error("[whatsapp] recalculate signals", error);
    return res.status(503).json({ error: "recalculate_signals_failed" });
  }
});

whatsappRouter.post("/api/products/previews", async (req, res) => {
  const parsed = productPreviewsSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const previews = await getProductPreviews(parsed.data.handles || []);
    return res.status(200).json({ previews });
  } catch (error) {
    console.error("[products] previews", error);
    return res.status(503).json({ error: "product_previews_unavailable", previews: {} });
  }
});

whatsappRouter.get("/api/whatsapp/top-leads", async (req, res) => {
  const parsed = daysQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });

  try {
    const leads = await listWhatsAppTopLeads({
      days: queryRangeDays(parsed.data),
      limit: parsed.data.limit ?? 20
    });

    return res.status(200).json({
      items: leads.map((lead) => ({
        id: lead.id,
        client: lead.clientName,
        channel_type: lead.channelType,
        ai_mode: lead.aiMode,
        country: lead.country || "-",
        stage: lead.stage,
        recommended_stage: lead.recommendedStage,
        recommended_reason: lead.recommendedStageReason,
        score: lead.score,
        score_breakdown: lead.scoreBreakdown,
        conversion_probability: lead.conversionProbability.probability,
        conversion_band: lead.conversionProbability.band,
        conversion_reasons: lead.conversionProbability.reasons,
        urgency: computeLeadUrgency(lead),
        risk: {
          is_at_risk: lead.risk.isAtRisk,
          hours_since_last_activity: lead.risk.hoursSinceLastActivity,
          threshold_hours: lead.risk.thresholdHours
        }
      }))
    });
  } catch (error) {
    console.error("[whatsapp] top-leads", error);
    return res.status(503).json({ error: "top_leads_unavailable" });
  }
});

whatsappRouter.patch("/api/whatsapp/leads/:id", async (req, res) => {
  const parsed = stagePatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });

  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    if (isSharedLead(lead) && parsed.data.stageAuto) {
      return res.status(403).json({ error: "shared_channel_auto_stage_update_forbidden" });
    }
    const stageUpdated = await updateWhatsAppLeadStage({
      id: leadId,
      stage: parsed.data.stage,
      stageAuto: parsed.data.stageAuto,
      stageConfidence: parsed.data.stageConfidence ?? null,
      stageAutoReason: parsed.data.stageAutoReason ?? null,
      source: "manual_patch"
    });
    if (!stageUpdated) return res.status(404).json({ error: "lead_not_found" });

    if (parsed.data.internalNotes !== undefined) {
      await updateWhatsAppLeadNotes({ id: leadId, internalNotes: parsed.data.internalNotes || null });
    }
    if (parsed.data.priceSent !== undefined) {
      await updateWhatsAppLeadFlags({ id: leadId, priceSent: parsed.data.priceSent });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] lead patch", error);
    return res.status(503).json({ error: "lead_update_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/leads/:id/test-flag", async (req, res) => {
  const parsed = leadTestFlagPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });

  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });

    const updated = await updateWhatsAppLeadTestFlag({
      id: leadId,
      isTest: parsed.data.is_test,
      testTag: parsed.data.test_tag ?? null
    });
    if (!updated) return res.status(404).json({ error: "lead_not_found" });

    console.info("[whatsapp] lead test flag updated", {
      leadId,
      is_test: parsed.data.is_test,
      test_tag: parsed.data.test_tag ?? null
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] lead test flag patch failed", { leadId, error });
    return res.status(503).json({ error: "lead_test_flag_update_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/leads", async (req, res) => {
  return res.status(403).json({ error: "manual_lead_creation_disabled_use_zoko_webhook" });
});

whatsappRouter.patch("/api/whatsapp/leads/:id/confirm-verbal", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = confirmVerbalSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });

    await updateWhatsAppLeadSignalFlags({
      id: leadId,
      chatConfirmed: true
    });

    const currentStage = String(lead.stage || "").toUpperCase();
    const canMoveToConfirmed = stageRankValue(currentStage) >= stageRankValue("PRICE_SENT") && currentStage !== "CONVERTED" && currentStage !== "LOST";
    let stageUpdated = false;
    if (canMoveToConfirmed && currentStage !== "CONFIRMED") {
      stageUpdated = await updateWhatsAppLeadStage({
        id: leadId,
        stage: "CONFIRMED",
        stageAuto: !isSharedLead(lead),
        stageAutoReason: "Confirmed by operator button",
        source: "ui_button_confirm_verbal"
      });
    }

    await createWhatsAppLeadEvent({
      leadId,
      eventType: "OPERATOR_CONFIRMED",
      payload: {
        source: String(parsed.data.source || "UI_BUTTON"),
        previous_stage: currentStage,
        next_stage: canMoveToConfirmed ? "CONFIRMED" : currentStage,
        created_at: new Date().toISOString()
      }
    });

    return res.status(200).json({
      ok: true,
      stage: canMoveToConfirmed ? "CONFIRMED" : currentStage,
      stage_updated: stageUpdated,
      chat_confirmed: true,
      reason: "Confirmed by operator button"
    });
  } catch (error) {
    console.error("[whatsapp] confirm-verbal", error);
    return res.status(503).json({ error: "confirm_verbal_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/dev/seed", async (_req, res) => {
  return res.status(403).json({ error: "seed_disabled_zoko_only_mode" });
});

whatsappRouter.post("/api/whatsapp/dev/simulate", async (req, res) => {
  const parsed = devSimulateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const now = Date.now();
  const iso = (offsetSeconds: number) => new Date(now + offsetSeconds * 1000).toISOString();
  const scenarioMessages: Record<"A" | "B" | "C" | "D" | "E" | "PARIS_MA" | "PRICE_SENT_CONFIRMED" | "PRICE_SENT_PAYMENT_QUESTION", Array<{ direction: "IN" | "OUT"; text: string; created_at: string }>> = {
    A: [
      { direction: "IN", text: "https://maison.com/products/caftan-nour", created_at: iso(0) },
      { direction: "OUT", text: "Merci pour votre message. Pouvez-vous me confirmer la date et la destination ?", created_at: iso(20) },
      { direction: "IN", text: "6 août, Paris", created_at: iso(40) },
      { direction: "OUT", text: "Parfait, nous sommes dans les délais. Le prix est de 40 000 DHS avec un délai de confection de 3 semaines. Si vous le souhaitez, nous pouvons faire une courte visio privée.", created_at: iso(60) },
      { direction: "IN", text: "Je confirme", created_at: iso(80) }
    ],
    B: [
      { direction: "IN", text: "Hi, I am interested in this article Kaftan Jade", created_at: iso(0) },
      { direction: "OUT", text: "Le prix est de 28 000 DHS.", created_at: iso(20) }
    ],
    C: [
      { direction: "IN", text: "6 août, Casablanca", created_at: new Date(now - 49 * 3600000).toISOString() },
      { direction: "OUT", text: "Le prix est de 30 000 DHS avec un délai de 3 semaines.", created_at: new Date(now - 48 * 3600000).toISOString() }
    ],
    D: [
      { direction: "IN", text: "6 août, Rabat", created_at: iso(0) },
      { direction: "OUT", text: "Le prix est de 32 000 DHS.", created_at: iso(20) },
      { direction: "IN", text: "Comment je peux payer l’acompte ?", created_at: iso(40) }
    ],
    E: [
      { direction: "IN", text: "6 août, Paris", created_at: iso(0) },
      { direction: "OUT", text: "Le prix est de 36 000 DHS.", created_at: iso(20) },
      { direction: "IN", text: "C’est confirmé", created_at: iso(40) }
    ],
    PARIS_MA: [
      { direction: "IN", text: "9 juin, Paris", created_at: iso(0) }
    ],
    PRICE_SENT_CONFIRMED: [
      { direction: "IN", text: "9 juin, Paris", created_at: iso(0) },
      { direction: "OUT", text: "Le prix est de 40 000 DHS.", created_at: iso(20) },
      { direction: "IN", text: "C’est confirmé.", created_at: iso(40) }
    ],
    PRICE_SENT_PAYMENT_QUESTION: [
      { direction: "IN", text: "9 juin, Paris", created_at: iso(0) },
      { direction: "OUT", text: "Le prix est de 40 000 DHS.", created_at: iso(20) },
      { direction: "IN", text: "Comment je peux payer ?", created_at: iso(40) }
    ]
  };

  const messages = parsed.data.messages?.length
    ? parsed.data.messages.map((msg, index) => ({
        direction: msg.direction,
        text: msg.text,
        created_at: msg.created_at || iso(index * 10)
      }))
    : (parsed.data.scenario ? scenarioMessages[parsed.data.scenario] : scenarioMessages.A);

  const simulated = runWhatsAppLabSimulation({
    messages,
    mode: parsed.data.mode || "basic",
    language: parsed.data.language || "FR"
  });

  const timeline = messages.map((_, index) => {
    const partialMessages = messages.slice(0, index + 1);
    const partial = runWhatsAppLabSimulation({
      messages: partialMessages,
      mode: parsed.data.mode || "basic",
      language: parsed.data.language || "FR"
    });
    const partialInbound = partialMessages
      .filter((msg) => String(msg.direction || "").toUpperCase() === "IN")
      .map((msg, i) => ({ id: "sim-in-" + String(index + 1) + "-" + String(i + 1), text: msg.text, createdAt: msg.created_at }));
    const partialDestination = extractDestinationFromMessages(
      partialMessages.map((msg, i) => ({
        id: "sim-msg-" + String(index + 1) + "-" + String(i + 1),
        direction: msg.direction,
        text: msg.text,
        createdAt: msg.created_at
      })),
      { country: "MA", shipCountry: null },
      new Date()
    );
    const partialEventDate = extractEventDateFromMessages(partialInbound, new Date(), "UTC");
    return {
      step: index + 1,
      message: partialMessages[partialMessages.length - 1],
      extractions: {
        event_date: partialEventDate.date,
        destination: partialDestination.raw,
        ship_city: partialDestination.ship_city,
        ship_country: partialDestination.ship_country,
        missing: partial.qualification.missing
      },
      flags: partial.signals,
      stage_after: partial.stage.main,
      stage_reasoning: partial.stage.reasoning
    };
  });

  if (parsed.data.has_paid_shopify_order) {
    simulated.stage = {
      main: "CONVERTED",
      reasoning: "Forced CONVERTED by hard Shopify payment signal in dev simulation.",
      confidence: 100
    };
  }

  return res.status(200).json({
    scenario: parsed.data.scenario || null,
    mode: parsed.data.mode || "basic",
    language: parsed.data.language || "FR",
    messages,
    timeline,
    ...simulated
  });
});

whatsappRouter.get("/api/whatsapp/leads/:id/debug-proof", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });

    const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 50);
    const normalizedMessages = recentConversation.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      createdAt: m.createdAt
    }));
    const inboundMessages = normalizedMessages.filter((m) => String(m.direction || "").toUpperCase() === "IN");

    const eventExtraction = extractEventDateFromMessages(
      inboundMessages.map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt })),
      new Date(),
      "UTC"
    );
    const destinationExtraction = extractDestinationFromMessages(
      normalizedMessages,
      { country: lead.country, shipCountry: lead.shipCountry },
      new Date()
    );

    const mergedEventDate = eventExtraction.date || lead.eventDate || null;
    const mergedShipCity = destinationExtraction.ship_city || lead.shipCity || null;
    const mergedShipCountry = destinationExtraction.ship_country || lead.shipCountry || null;
    const mergedShipRegion = destinationExtraction.ship_region || lead.shipRegion || null;
    const mergedShipRaw = destinationExtraction.raw || lead.shipDestinationText || null;

    const leadForSignals = {
      ...lead,
      eventDate: mergedEventDate,
      shipCity: mergedShipCity,
      shipCountry: mergedShipCountry,
      shipRegion: mergedShipRegion,
      shipDestinationText: mergedShipRaw
    };

    const signalDetection = detectSignalsFromMessages(normalizedMessages, leadForSignals);
    const leadForProgression = {
      ...leadForSignals,
      hasProductInterest: lead.hasProductInterest || signalDetection.hasProductInterest,
      hasPriceSent: lead.hasPriceSent || signalDetection.hasPriceSent,
      hasVideoProposed: lead.hasVideoProposed || signalDetection.hasVideoProposed,
      hasPaymentQuestion: lead.hasPaymentQuestion || signalDetection.hasPaymentQuestion,
      hasDepositLinkSent: lead.hasDepositLinkSent || signalDetection.hasDepositLinkSent,
      chatConfirmed: lead.chatConfirmed || signalDetection.chatConfirmed,
      priceIntent: lead.priceIntent || signalDetection.priceIntent,
      videoIntent: lead.videoIntent || signalDetection.videoIntent,
      paymentIntent: lead.paymentIntent || signalDetection.paymentIntent,
      depositIntent: lead.depositIntent || signalDetection.depositIntent,
      confirmationIntent: lead.confirmationIntent || signalDetection.confirmationIntent
    };

    const events = detectConversationEvents(normalizedMessages, leadForProgression);
    const progression = applyStageProgression(leadForProgression, events, {
      paymentReceived: Boolean(lead.paymentReceived),
      depositPaid: Boolean(lead.depositPaid),
      hasPaidShopifyOrder: lead.stage === "CONVERTED",
      shopifyFinancialStatus: lead.shopifyFinancialStatus
    });

    const lastInbound = inboundMessages.slice().reverse()[0] || null;
    let suggestion: {
      text: string;
      type: string;
      stage_used: string;
      rule_applied: string;
      why: string;
    } | null = null;
    if (lastInbound) {
      try {
        const suggested = await suggestReplyRulesFirst({
          lead: leadForProgression,
          messages: normalizedMessages.map((m) => ({
            direction: m.direction,
            text: m.text,
            created_at: m.createdAt
          })),
          targetStage: progression.nextStage
        });
        suggestion = {
          text: suggested.suggested_message,
          type: suggested.suggestion_type,
          stage_used: suggested.stage_used,
          rule_applied: suggested.rule_applied,
          why: suggested.why
        };
      } catch {
        suggestion = null;
      }
    }

    const cityCountryFallback: Record<string, string> = {
      paris: "FR",
      rabat: "MA",
      casablanca: "MA",
      marrakech: "MA",
      dubai: "AE",
      london: "GB",
      nyc: "US",
      "new york city": "US"
    };
    const cityKey = String(mergedShipCity || "").trim().toLowerCase();
    const cityFallbackCountry = cityKey ? cityCountryFallback[cityKey] || null : null;

    return res.status(200).json({
      stage_current: lead.stage,
      stage_next: progression.nextStage,
      flags: progression.signals,
      event_date: mergedEventDate,
      ship_city: mergedShipCity,
      ship_country: mergedShipCountry,
      last_in_message: lastInbound
        ? { id: lastInbound.id, text: lastInbound.text, created_at: lastInbound.createdAt }
        : null,
      rule_applied: suggestion?.rule_applied || null,
      why: suggestion?.why || progression.reason || null,
      suggestion: suggestion ? { text: suggestion.text, type: suggestion.type, why: suggestion.why } : null,
      destination_merge_order: [
        "1) Extract destination/event candidates from inbound conversation.",
        "2) Choose highest-confidence (latest on tie).",
        "3) Assign ship_city from extracted candidate when present.",
        "4) Assign ship_country with priority: explicit country in message > city-country fallback > lead.shipCountry/country fallback.",
        "5) Persist/compute stage using merged event_date + destination fields."
      ],
      destination_assignation: {
        extracted_city: destinationExtraction.ship_city,
        extracted_country: destinationExtraction.ship_country,
        city_country_fallback: cityFallbackCountry,
        lead_country: lead.country || null,
        lead_ship_country: lead.shipCountry || null,
        final_ship_city: mergedShipCity,
        final_ship_country: mergedShipCountry
      }
    });
  } catch (error) {
    console.error("[whatsapp] debug-proof", error);
    return res.status(503).json({ error: "debug_proof_failed" });
  }
});

async function postProcessAfterOutboundMessage(input: {
  leadId: string;
  leadSnapshot: any;
  outboundText: string;
  messageCreatedAt: string;
  warnings?: string[];
}): Promise<string[]> {
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];
  const leadId = String(input.leadId || "").trim();
  if (!leadId) return warnings;
  const lead = input.leadSnapshot;
  if (!lead) return warnings;

  if (lead.firstResponseTimeMinutes == null) {
    try {
      await setLeadFirstResponseMinutesFromOutbound(leadId, input.messageCreatedAt);
    } catch (error) {
      console.warn("[whatsapp] post-process first response update failed", { leadId, error });
      warnings.push("first_response_update_failed");
    }
  }

  if (!isSharedLead(lead)) {
    try {
      const text = String(input.outboundText || "");
      const hasPrice = containsPriceText(text);
      if (hasPrice) {
        await updateWhatsAppLeadFlags({ id: leadId, priceSent: true });
      } else if (lead.stage === "NEW" || lead.stage === "PRODUCT_INTEREST") {
        await updateWhatsAppLeadStage({
          id: leadId,
          stage: "QUALIFICATION_PENDING",
          stageAuto: false,
          stageConfidence: null,
          stageAutoReason: "First response sent with qualification flow",
          source: "conversation_outbound"
        });
      }
    } catch (error) {
      console.warn("[whatsapp] post-process outbound stage/flags failed", { leadId, error });
      warnings.push("outbound_stage_flags_update_failed");
    }
  }

  const latestLeadAfterMessage = await getWhatsAppLeadById(leadId);
  if (!latestLeadAfterMessage) return warnings;

  try {
    const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
    const signalDetection = detectSignalsFromMessages(
      recentConversation.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        createdAt: m.createdAt
      })),
      latestLeadAfterMessage
    );
    await updateWhatsAppLeadSignalFlags({
      id: leadId,
      hasProductInterest: signalDetection.hasProductInterest,
      hasPriceSent: signalDetection.hasPriceSent,
      hasVideoProposed: signalDetection.hasVideoProposed,
      hasPaymentQuestion: signalDetection.hasPaymentQuestion,
      hasDepositLinkSent: signalDetection.hasDepositLinkSent,
      chatConfirmed: signalDetection.chatConfirmed,
      priceIntent: signalDetection.priceIntent,
      videoIntent: signalDetection.videoIntent,
      paymentIntent: signalDetection.paymentIntent,
      depositIntent: signalDetection.depositIntent,
      confirmationIntent: signalDetection.confirmationIntent,
      productInterestSourceMessageId: signalDetection.productInterestSourceMessageId,
      priceSentSourceMessageId: signalDetection.priceSentSourceMessageId,
      videoProposedSourceMessageId: signalDetection.videoProposedSourceMessageId,
      paymentQuestionSourceMessageId: signalDetection.paymentQuestionSourceMessageId,
      depositLinkSourceMessageId: signalDetection.depositLinkSourceMessageId,
      chatConfirmedSourceMessageId: signalDetection.chatConfirmedSourceMessageId
    });
    const leadForProgression = {
      ...latestLeadAfterMessage,
      hasProductInterest: latestLeadAfterMessage.hasProductInterest || signalDetection.hasProductInterest,
      hasPriceSent: latestLeadAfterMessage.hasPriceSent || signalDetection.hasPriceSent,
      hasVideoProposed: latestLeadAfterMessage.hasVideoProposed || signalDetection.hasVideoProposed,
      hasPaymentQuestion: latestLeadAfterMessage.hasPaymentQuestion || signalDetection.hasPaymentQuestion,
      hasDepositLinkSent: latestLeadAfterMessage.hasDepositLinkSent || signalDetection.hasDepositLinkSent,
      chatConfirmed: latestLeadAfterMessage.chatConfirmed || signalDetection.chatConfirmed,
      priceIntent: latestLeadAfterMessage.priceIntent || signalDetection.priceIntent,
      videoIntent: latestLeadAfterMessage.videoIntent || signalDetection.videoIntent,
      paymentIntent: latestLeadAfterMessage.paymentIntent || signalDetection.paymentIntent,
      depositIntent: latestLeadAfterMessage.depositIntent || signalDetection.depositIntent,
      confirmationIntent: latestLeadAfterMessage.confirmationIntent || signalDetection.confirmationIntent
    };
    const progression = applyStageProgression(
      leadForProgression,
      detectConversationEvents(
        recentConversation.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.text,
          createdAt: m.createdAt
        })),
        leadForProgression
      ),
      {
        paymentReceived: leadForProgression.paymentReceived,
        depositPaid: leadForProgression.depositPaid,
        hasPaidShopifyOrder: leadForProgression.stage === "CONVERTED",
        shopifyFinancialStatus: leadForProgression.shopifyFinancialStatus
      }
    );
    if (progression.changed && !isSharedLead(leadForProgression)) {
      await updateWhatsAppLeadStage({
        id: leadId,
        stage: progression.nextStage,
        stageAuto: true,
        stageConfidence: progression.confidence == null ? null : progression.confidence / 100,
        stageAutoReason: progression.reason || "conversation_progression",
        stageAutoSourceMessageId: progression.sourceMessageId,
        stageAutoConfidence: progression.confidence,
        source: "conversation_events_auto"
      });
    }
  } catch (error) {
    console.warn("[whatsapp] post-process progression/signals failed", { leadId, error });
    warnings.push("stage_progression_or_signal_update_failed");
  }

  return warnings;
}

whatsappRouter.post("/api/whatsapp/leads/:id/messages", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = messageCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    if (isSharedLead(lead) && parsed.data.direction === "OUT") {
      return res.status(403).json({ error: "shared_channel_analysis_only_no_send" });
    }

    const shouldDispatch =
      parsed.data.direction === "OUT" &&
      (parsed.data.provider || "manual") === "manual" &&
      parsed.data.send_whatsapp !== false;
    let dispatchedExternalId: string | null = null;
    if (shouldDispatch) {
      const dispatch = await dispatchWhatsAppFollowUp("48h", {
        leadId: lead.id,
        phoneNumber: lead.phoneNumber,
        text: parsed.data.text,
        metadata: { source: "conversation_composer", message_type: parsed.data.message_type || "text" }
      });
      if (!dispatch.ok) {
        return res.status(502).json({
          error: dispatch.error || "whatsapp_send_failed"
        });
      }
      dispatchedExternalId = dispatch.messageId ? String(dispatch.messageId) : null;
    }

    const messageTrackingSource =
      parsed.data.direction === "IN"
        ? "INBOUND"
        : parsed.data.suggestion_feedback?.id
          ? "OUTBOUND_SUGGESTION"
          : "OUTBOUND_MANUAL";
    const message = await createWhatsAppLeadMessageWithTracking({
      leadId,
      direction: parsed.data.direction,
      text: parsed.data.text,
      provider: shouldDispatch ? "zoko" : (parsed.data.provider || "manual"),
      messageType: parsed.data.message_type || "text",
      externalId: dispatchedExternalId
    }, {
      source: messageTrackingSource,
      ui_source: "conversation_composer"
    });
    if (!message) return res.status(503).json({ error: "message_store_failed" });

    if (parsed.data.direction === "OUT" && parsed.data.suggestion_feedback?.id) {
      try {
        await attachFinalMessageToSuggestion({
          id: parsed.data.suggestion_feedback.id,
          finalText: parsed.data.text,
          finalMessageId: message.id,
          accepted: parsed.data.suggestion_feedback.accepted
        });
        if (parsed.data.suggestion_feedback.accepted === true) {
          await logSuggestionUsed({
            leadId,
            messageId: message.id,
            suggestionKey: parsed.data.suggestion_feedback.suggestion_type || null,
            ui_source: "conversation_composer"
          });
        }
      } catch (error) {
        console.warn("[whatsapp] suggestion feedback attach failed", { leadId, error });
      }
    }

    const postProcessWarnings: string[] = [];
    if (parsed.data.direction === "OUT") {
      try {
        const override = await applyTeamPriceOverrideFromLeadOutbound({
          leadId,
          text: String(parsed.data.text || ""),
          actor: "manager_ui"
        });
        if (override.applied) {
          postProcessWarnings.push("quote_price_override_applied");
        }
      } catch (error) {
        console.warn("[whatsapp] quote price override from outbound failed", { leadId, error });
        postProcessWarnings.push("quote_price_override_failed");
      }

      await postProcessAfterOutboundMessage({
        leadId,
        leadSnapshot: lead,
        outboundText: String(parsed.data.text || ""),
        messageCreatedAt: message.createdAt,
        warnings: postProcessWarnings
      });
    }

    let inboundQualificationPayload: null | {
      tags: string[];
      recommended_stage: string | null;
      recommended_stage_reason: string | null;
      stage_auto_reason: string | null;
      detected_signals: unknown;
    } = null;

    if (parsed.data.direction === "IN") {
      try {
        const rules = computeRuleQualification(lead, parsed.data.text, {
          messageId: message.id,
          createdAt: message.createdAt
        });
        const latestLead = await getWhatsAppLeadById(leadId);
        if (latestLead) {
          const inbound = await listRecentInboundMessagesForLead(leadId, 20);
          const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
          await applyInboundSignalExtraction(
            latestLead,
            inbound,
            recentConversation.map((m) => ({
              id: m.id,
              text: m.text,
              createdAt: m.createdAt,
              direction: m.direction
            }))
          );
        }
        await updateLeadQualification({
          id: leadId,
          qualificationTags: rules.tags,
          intentLevel: rules.intentLevel || undefined,
          stageAutoReason: rules.stageAutoReason || undefined,
          recommendedStage: rules.recommendedStage || undefined,
          recommendedStageReason: rules.recommendedStageReason || undefined,
          recommendedStageConfidence: rules.confidence || undefined,
          detectedSignals: rules.detectedSignals
        });
        inboundQualificationPayload = {
          tags: rules.tags,
          recommended_stage: rules.recommendedStage || null,
          recommended_stage_reason: rules.recommendedStageReason || null,
          stage_auto_reason: rules.stageAutoReason || null,
          detected_signals: rules.detectedSignals
        };
      } catch (error) {
        console.warn("[whatsapp] post-process inbound qualification failed", { leadId, error });
        postProcessWarnings.push("inbound_qualification_failed");
      }
    }

    if (parsed.data.direction !== "OUT") {
      const latestLeadAfterMessage = await getWhatsAppLeadById(leadId);
      if (latestLeadAfterMessage) {
        try {
          const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
          const signalDetection = detectSignalsFromMessages(
            recentConversation.map((m) => ({
              id: m.id,
              direction: m.direction,
              text: m.text,
              createdAt: m.createdAt
            })),
            latestLeadAfterMessage
          );
          await updateWhatsAppLeadSignalFlags({
            id: leadId,
            hasProductInterest: signalDetection.hasProductInterest,
            hasPriceSent: signalDetection.hasPriceSent,
            hasVideoProposed: signalDetection.hasVideoProposed,
            hasPaymentQuestion: signalDetection.hasPaymentQuestion,
            hasDepositLinkSent: signalDetection.hasDepositLinkSent,
            chatConfirmed: signalDetection.chatConfirmed,
            priceIntent: signalDetection.priceIntent,
            videoIntent: signalDetection.videoIntent,
            paymentIntent: signalDetection.paymentIntent,
            depositIntent: signalDetection.depositIntent,
            confirmationIntent: signalDetection.confirmationIntent,
            productInterestSourceMessageId: signalDetection.productInterestSourceMessageId,
            priceSentSourceMessageId: signalDetection.priceSentSourceMessageId,
            videoProposedSourceMessageId: signalDetection.videoProposedSourceMessageId,
            paymentQuestionSourceMessageId: signalDetection.paymentQuestionSourceMessageId,
            depositLinkSourceMessageId: signalDetection.depositLinkSourceMessageId,
            chatConfirmedSourceMessageId: signalDetection.chatConfirmedSourceMessageId
          });
          const leadForProgression = {
            ...latestLeadAfterMessage,
            hasProductInterest: latestLeadAfterMessage.hasProductInterest || signalDetection.hasProductInterest,
            hasPriceSent: latestLeadAfterMessage.hasPriceSent || signalDetection.hasPriceSent,
            hasVideoProposed: latestLeadAfterMessage.hasVideoProposed || signalDetection.hasVideoProposed,
            hasPaymentQuestion: latestLeadAfterMessage.hasPaymentQuestion || signalDetection.hasPaymentQuestion,
            hasDepositLinkSent: latestLeadAfterMessage.hasDepositLinkSent || signalDetection.hasDepositLinkSent,
            chatConfirmed: latestLeadAfterMessage.chatConfirmed || signalDetection.chatConfirmed,
            priceIntent: latestLeadAfterMessage.priceIntent || signalDetection.priceIntent,
            videoIntent: latestLeadAfterMessage.videoIntent || signalDetection.videoIntent,
            paymentIntent: latestLeadAfterMessage.paymentIntent || signalDetection.paymentIntent,
            depositIntent: latestLeadAfterMessage.depositIntent || signalDetection.depositIntent,
            confirmationIntent: latestLeadAfterMessage.confirmationIntent || signalDetection.confirmationIntent
          };
          const progression = applyStageProgression(
            leadForProgression,
            detectConversationEvents(
              recentConversation.map((m) => ({
                id: m.id,
                direction: m.direction,
                text: m.text,
                createdAt: m.createdAt
              })),
              leadForProgression
            ),
            {
              paymentReceived: leadForProgression.paymentReceived,
              depositPaid: leadForProgression.depositPaid,
              hasPaidShopifyOrder: leadForProgression.stage === "CONVERTED",
              shopifyFinancialStatus: leadForProgression.shopifyFinancialStatus
            }
          );
          if (progression.changed && !isSharedLead(leadForProgression)) {
            await updateWhatsAppLeadStage({
              id: leadId,
              stage: progression.nextStage,
              stageAuto: true,
              stageConfidence: progression.confidence == null ? null : progression.confidence / 100,
              stageAutoReason: progression.reason || "conversation_progression",
              stageAutoSourceMessageId: progression.sourceMessageId,
              stageAutoConfidence: progression.confidence,
              source: "conversation_events_auto"
            });
          }
        } catch (error) {
          console.warn("[whatsapp] post-process progression/signals failed", { leadId, error });
          postProcessWarnings.push("stage_progression_or_signal_update_failed");
        }
      }
    }

    return res.status(200).json({
      ok: true,
      message_id: message.id,
      provider: message.provider,
      message_type: message.messageType,
      template_name: message.templateName,
      warnings: postProcessWarnings,
      ...(inboundQualificationPayload || {})
    });
  } catch (error) {
    console.error("[whatsapp] message create", error);
    return res.status(503).json({ error: "message_create_failed" });
  }
});

whatsappRouter.post("/api/leads/:leadId/send-approved-quote", async (req, res) => {
  const leadId = String(req.params.leadId || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_lead_id" });
  const parsed = sendApprovedQuoteSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const stage = String(lead.stage || "").toUpperCase();
    if (stage === "LOST" || stage === "CONVERTED") {
      return res.status(409).json({ error: "lead_not_sendable_in_current_stage" });
    }

    const qa = getLeadQuoteApproval(lead);
    const price = toRecord(qa.price);
    const approvedAmount = Number(price.approved_amount);
    const approvedCurrencyRaw = String(price.approved_currency || "MAD").trim().toUpperCase();
    const approvedCurrency =
      approvedCurrencyRaw === "USD" || approvedCurrencyRaw === "EUR" || approvedCurrencyRaw === "MAD"
        ? (approvedCurrencyRaw as "USD" | "EUR" | "MAD")
        : "MAD";
    if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
      return res.status(409).json({ error: "approved_price_missing" });
    }

    const recent = await listRecentWhatsAppLeadMessages(leadId, 12);
    const now = Date.now();
    const duplicateRecentSend = recent.find((msg) => {
      if (msg.direction !== "OUT") return false;
      const metadata = toRecord(msg.metadata);
      if (metadata.approved_quote_sent !== true) return false;
      const createdTs = new Date(String(msg.createdAt || "")).getTime();
      if (!Number.isFinite(createdTs)) return false;
      return now - createdTs <= 2 * 60 * 1000;
    });
    if (duplicateRecentSend) {
      return res.status(409).json({ error: "approved_quote_recently_sent" });
    }

    const productTitle = String(toRecord(qa.product).title || lead.productReference || "Pièce sélectionnée").trim();
    const productionMode = String(qa.production_mode || "MADE_TO_ORDER").toUpperCase() === "READY_PIECE"
      ? "READY_PIECE"
      : "MADE_TO_ORDER";
    const deliveryEstimate = String(toRecord(qa).delivery_estimate || "").trim() || null;
    const formattedPrice = formatApprovedAmount(approvedAmount, approvedCurrency);
    const textMessage = composeApprovedQuoteClientText({
      language: resolveLeadLanguage(lead),
      productTitle,
      formattedPrice,
      productionMode,
      deliveryEstimate
    });

    let dispatch: { ok: boolean; messageId?: string; error?: string } = { ok: false, error: "send_failed" };
    if (parsed.data.mode === "template") {
      const templateName = String(env.APPROVED_QUOTE_TEMPLATE_NAME || "").trim();
      if (templateName) {
        const templateSend = await sendZokoTemplateMessage({
          phoneNumber: lead.phoneNumber,
          templateName,
          language: resolveLeadLanguage(lead),
          variables: [productTitle, formattedPrice, productionMode === "READY_PIECE" ? "Pièce prête" : "Sur mesure"]
        });
        if (templateSend.ok) {
          dispatch = { ok: true, messageId: templateSend.externalId };
        }
      }
    }
    if (!dispatch.ok) {
      const fallbackDispatch = await dispatchWhatsAppFollowUp("48h", {
        leadId: lead.id,
        phoneNumber: lead.phoneNumber,
        text: textMessage,
        metadata: {
          source: "approved_quote_send",
          mode: parsed.data.mode || "text",
          quote_request_id: parsed.data.quoteRequestId || String(qa.quote_request_id || "")
        }
      });
      dispatch = {
        ok: fallbackDispatch.ok,
        messageId: fallbackDispatch.messageId,
        error: fallbackDispatch.error
      };
    }
    if (!dispatch.ok) {
      return res.status(502).json({ error: dispatch.error || "whatsapp_send_failed" });
    }

    const message = await createWhatsAppLeadMessageWithTracking(
      {
        leadId: lead.id,
        direction: "OUT",
        text: textMessage,
        provider: "zoko",
        messageType: "text",
        externalId: dispatch.messageId ? String(dispatch.messageId) : null,
        metadata: {
          approved_quote_sent: true,
          quote_request_id: parsed.data.quoteRequestId || String(qa.quote_request_id || ""),
          production_mode: productionMode,
          approved_amount: approvedAmount,
          approved_currency: approvedCurrency
        }
      },
      {
        source: "OUTBOUND_MANUAL",
        ui_source: "send_approved_quote"
      }
    );
    if (!message) return res.status(503).json({ error: "message_store_failed" });

    const nextDetectedSignals = {
      ...toRecord(lead.detectedSignals || {}),
      quote_approval: {
        ...qa,
        stage_recommendation: "PRICE_APPROVED_READY_TO_SEND",
        price_sent: true,
        price: {
          ...price,
          approved: true,
          approved_amount: approvedAmount,
          approved_currency: approvedCurrency,
          source: String(price.source || "team_approved")
        },
        production_mode: productionMode,
        sent_to_client_at: new Date().toISOString()
      }
    };
    await updateLeadQualification({
      id: lead.id,
      detectedSignals: nextDetectedSignals as any,
      recommendedStage: lead.recommendedStage,
      recommendedStageReason: "approved_quote_sent_to_client",
      recommendedStageConfidence: 0.98
    });

    await updateWhatsAppLeadSignalFlags({
      id: lead.id,
      hasPriceSent: true,
      priceSentSourceMessageId: message.id
    });

    const postProcessWarnings: string[] = [];
    await postProcessAfterOutboundMessage({
      leadId: lead.id,
      leadSnapshot: lead,
      outboundText: textMessage,
      messageCreatedAt: message.createdAt,
      warnings: postProcessWarnings
    });

    const quoteRequestId = String(parsed.data.quoteRequestId || qa.quote_request_id || "").trim();
    if (quoteRequestId) {
      try {
        await createQuoteAction({
          quoteRequestId,
          actionType: "SEND_TO_CLIENT",
          payload: {
            actor: "manager_ui",
            approved_amount: approvedAmount,
            approved_currency: approvedCurrency,
            production_mode: productionMode,
            message_preview: textMessage.slice(0, 300),
            message_id: message.id,
            sent_at: new Date().toISOString()
          }
        });
      } catch (error) {
        console.warn("[approved-quote] quote action audit failed", { leadId: lead.id, quoteRequestId, error });
      }
    }

    await createMlEvent({
      eventType: "INFERENCE",
      leadId: lead.id,
      source: "SYSTEM",
      payload: {
        inference: "send_to_client",
        quote_request_id: quoteRequestId || null,
        approved_amount: approvedAmount,
        approved_currency: approvedCurrency,
        production_mode: productionMode,
        message_id: message.id,
        ui_source: "send_approved_quote"
      }
    });
    await createWhatsAppLeadEvent({
      leadId: lead.id,
      eventType: "SEND_TO_CLIENT",
      payload: {
        actor: "manager_ui",
        quote_request_id: quoteRequestId || null,
        approved_amount: approvedAmount,
        approved_currency: approvedCurrency,
        production_mode: productionMode,
        message_id: message.id,
        message_preview: textMessage.slice(0, 300),
        sent_at: new Date().toISOString()
      }
    });

    return res.status(200).json({ ok: true, messageId: message.id, warnings: postProcessWarnings });
  } catch (error) {
    console.error("[approved-quote] send failed", { leadId, error });
    return res.status(503).json({ error: "send_approved_quote_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/messages", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  try {
    const [items, quotes] = await Promise.all([
      listWhatsAppLeadMessages(leadId, { limit: parsed.data.limit ?? 50, order: "asc" }),
      listLeadPriceQuotes(leadId, 50)
    ]);
    return res.status(200).json({
      items: items.map((item) => ({
        id: item.id,
        direction: item.direction,
        text: item.text,
        reply_to: item.replyTo
          ? {
              id: item.replyTo.id,
              sender_name: item.replyTo.senderName,
              text: item.replyTo.text
            }
          : null,
        provider: item.provider,
        message_type: item.messageType,
        template_name: item.templateName,
        external_id: item.externalId,
        metadata: item.metadata || null,
        created_at: item.createdAt
      })),
      quotes: quotes.map((quote) => ({
        id: quote.id,
        message_id: quote.messageId,
        amount: quote.amount,
        currency: quote.currency,
        formatted: quote.formatted,
        product_title: quote.productTitle,
        product_handle: quote.productHandle,
        qty: quote.qty,
        confidence: quote.confidence,
        created_at: quote.createdAt
      }))
    });
  } catch (error) {
    console.error("[whatsapp] lead messages", error);
    return res.status(503).json({ error: "lead_messages_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/timeline", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(300).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const items = await listWhatsAppLeadTimeline(leadId, parsed.data.limit ?? 80);
    return res.status(200).json({
      items: items.map((item) => ({
        id: item.id,
        event_type: item.eventType,
        payload: item.payload || {},
        created_at: item.createdAt
      }))
    });
  } catch (error) {
    console.error("[whatsapp] lead timeline", error);
    return res.status(503).json({ error: "lead_timeline_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/conversion-metrics", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const metrics = await getLeadConversionMetricsByLeadId(leadId);
    return res.status(200).json({
      metrics: metrics
        ? {
            id: metrics.id,
            lead_id: metrics.leadId,
            ticket_value: metrics.ticketValue,
            total_messages: metrics.totalMessages,
            first_response_delay_minutes: metrics.firstResponseDelayMinutes,
            avg_response_delay_minutes: metrics.avgResponseDelayMinutes,
            price_sent_delay_minutes: metrics.priceSentDelayMinutes,
            suggestion_used: metrics.suggestionUsed,
            template_used: metrics.templateUsed,
            follow_up_triggered: metrics.followUpTriggered,
            video_proposed: metrics.videoProposed,
            conversion_probability_at_price: metrics.conversionProbabilityAtPrice,
            country: metrics.country,
            created_at: metrics.createdAt
          }
        : null
    });
  } catch (error) {
    console.error("[whatsapp] lead conversion metrics", error);
    return res.status(503).json({ error: "lead_conversion_metrics_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/ai-runs", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsedQuery = aiRunsQuerySchema.safeParse(req.query || {});
  if (!parsedQuery.success) return res.status(400).json({ error: "invalid_query" });
  try {
    const limit = parsedQuery.data.limit || 20;
    const runs = await listAiAgentRunsByLead(leadId, limit);
    const includePrompt =
      String(env.NODE_ENV || "").toLowerCase() === "development" &&
      isShowAiPromptsEnabled();
    return res.status(200).json({
      items: runs.map((run) => mapAiRunListItem(run, includePrompt))
    });
  } catch (error) {
    console.error("[whatsapp] ai-runs list failed", { leadId, error });
    return res.status(503).json({ error: "ai_runs_list_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/ai-latest", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const run = await getLatestAiAgentRunByLead(leadId);
    if (!run) return res.status(204).send();
    const normalized = normalizeAdvisorRun(run);
    return res.status(200).json(normalized);
  } catch (error) {
    console.error("[whatsapp] ai-latest failed", { leadId, error });
    return res.status(503).json({ error: "ai_latest_unavailable" });
  }
});

whatsappRouter.get("/api/ai/runs/:runId", async (req, res) => {
  const parsed = aiRunIdSchema.safeParse({ runId: req.params.runId });
  if (!parsed.success) return res.status(400).json({ error: "invalid_run_id" });
  try {
    const run = await getAiAgentRunById(parsed.data.runId);
    if (!run) return res.status(404).json({ error: "run_not_found" });
    const normalized = normalizeAdvisorRun(run);
    const includePrompt =
      String(env.NODE_ENV || "").toLowerCase() === "development" &&
      isShowAiPromptsEnabled();
    return res.status(200).json({
      ...normalized,
      lastPromptSnippet: includePrompt ? String(run.promptText || "").slice(0, 600) : undefined
    });
  } catch (error) {
    console.error("[whatsapp] ai-run-by-id failed", { runId: parsed.data.runId, error });
    return res.status(503).json({ error: "ai_run_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/ai-flow-latest", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const run = await getLatestAiAgentRunByLead(leadId);
    if (!run) return res.status(204).send();
    const normalized = normalizeAdvisorRun(run);
    return res.status(200).json({
      latestRun: normalized,
      flowSteps: buildFlowStepsFromRun(normalized)
    });
  } catch (error) {
    console.error("[whatsapp] ai-flow-latest failed", { leadId, error });
    return res.status(503).json({ error: "ai_flow_unavailable" });
  }
});

function resolveAdvisorProvider(raw: unknown): "claude" | "gpt" {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "gpt" || normalized === "openai") return "gpt";
  return "claude";
}

async function runAdvisorByProvider(input: {
  provider: "claude" | "gpt";
  leadId: string;
  messageId: string;
  triggerSource: string;
  messageLimit: number;
}) {
  if (input.provider === "gpt") {
    return runOpenAiAdvisor({
      leadId: input.leadId,
      messageId: input.messageId,
      triggerSource: input.triggerSource,
      messageLimit: input.messageLimit
    });
  }
  return runClaudeAdvisor({
    leadId: input.leadId,
    messageId: input.messageId,
    triggerSource: input.triggerSource,
    messageLimit: input.messageLimit
  });
}

whatsappRouter.post("/api/whatsapp/leads/:id/ai-retry", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsedBody = aiAdvisorProviderSchema.safeParse(req.body || {});
  if (!parsedBody.success) return res.status(400).json({ error: "invalid_body" });
  const provider = resolveAdvisorProvider(parsedBody.data.provider);
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const recentMessages = await listRecentWhatsAppLeadMessages(leadId, 1);
    const latestMessage = recentMessages[0];
    if (!latestMessage || !latestMessage.id) {
      return res.status(400).json({ error: "no_messages_for_retry" });
    }
    const run = await runAdvisorByProvider({
      provider,
      leadId,
      messageId: String(latestMessage.id),
      triggerSource: "manual_retry_" + provider,
      messageLimit: MANUAL_AI_ANALYZE_MESSAGE_LIMIT
    });
    return res.status(200).json({ ok: true, runId: run.id, status: run.status, provider });
  } catch (error) {
    console.error("[whatsapp] ai-retry failed", { leadId, provider, error });
    return res.status(503).json({ error: "ai_retry_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/leads/:id/ai-regenerate", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsedBody = aiAdvisorProviderSchema.safeParse(req.body || {});
  if (!parsedBody.success) return res.status(400).json({ error: "invalid_body" });
  const provider = resolveAdvisorProvider(parsedBody.data.provider);
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const recentMessages = await listRecentWhatsAppLeadMessages(leadId, 1);
    const latestMessage = recentMessages[0];
    if (!latestMessage || !latestMessage.id) {
      return res.status(400).json({ error: "no_messages_for_regenerate" });
    }
    const run = await runAdvisorByProvider({
      provider,
      leadId,
      messageId: String(latestMessage.id),
      triggerSource: "manual_regenerate_" + provider,
      messageLimit: MANUAL_AI_ANALYZE_MESSAGE_LIMIT
    });
    const normalized = normalizeAdvisorRun(run);
    if (normalized.status === "error") {
      return res.status(422).json(normalized);
    }
    return res.status(200).json(normalized);
  } catch (error) {
    console.error("[whatsapp] ai-regenerate failed", { leadId, provider, error });
    return res.status(503).json({ error: "ai_regenerate_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/leads/:id/ai-usage", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = aiUsageSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    await createMlEvent({
      eventType: "INFERENCE",
      leadId,
      source: "SYSTEM",
      payload: {
        inference: "ai_card_usage",
        run_id: parsed.data.runId,
        suggestion_id: parsed.data.suggestionId,
        action: parsed.data.action,
        created_at: parsed.data.createdAt || new Date().toISOString()
      }
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] ai-usage failed", { leadId, error });
    return res.status(503).json({ error: "ai_usage_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/templates", async (req, res) => {
  const parsed = templatesQuerySchema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  try {
    const items = await fetchZokoTemplates({
      category: parsed.data.category || "ALL",
      search: parsed.data.search || ""
    });
    const favorites = new Set(await listTemplateFavorites());
    return res.status(200).json(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        language: item.language,
        components: item.components,
        variables_count: item.variables_count,
        preview_text: item.preview_text,
        favorite: favorites.has(item.name)
      }))
    );
  } catch (error) {
    console.error("[whatsapp] templates", error);
    return res.status(503).json({ error: "templates_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/templates/favorites", async (_req, res) => {
  try {
    const items = await listTemplateFavorites();
    return res.status(200).json({ items });
  } catch (error) {
    console.error("[whatsapp] template favorites list", error);
    return res.status(503).json({ error: "favorites_unavailable" });
  }
});

whatsappRouter.post("/api/whatsapp/templates/favorites", async (req, res) => {
  const parsed = templateFavoriteSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    await addTemplateFavorite(parsed.data.templateName);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] template favorite add", error);
    return res.status(503).json({ error: "favorite_add_failed" });
  }
});

whatsappRouter.delete("/api/whatsapp/templates/favorites/:templateName", async (req, res) => {
  const templateName = String(req.params.templateName || "").trim();
  if (!templateName) return res.status(400).json({ error: "invalid_template_name" });
  try {
    await removeTemplateFavorite(templateName);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] template favorite remove", error);
    return res.status(503).json({ error: "favorite_remove_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/leads/:id/marketing-opt-in", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  const parsed = marketingOptInSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const updated = await updateWhatsAppLeadMarketingOptIn({
      id: leadId,
      marketingOptIn: parsed.data.marketing_opt_in,
      source: "manual"
    });
    if (!updated) return res.status(404).json({ error: "lead_not_found" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] marketing opt-in patch", error);
    return res.status(503).json({ error: "opt_in_update_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/send-template", async (req, res) => {
  const parsed = sendTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead || !String(lead.phoneNumber || "").trim()) {
      return res.status(404).json({ error: "lead_not_found_or_missing_phone" });
    }
    if (isSharedLead(lead)) {
      return res.status(403).json({ error: "shared_channel_analysis_only_no_send" });
    }
    let templateCategory = await getTemplateCategoryByName(parsed.data.templateName);
    if (!templateCategory) {
      await fetchZokoTemplates({ forceRefresh: true });
      templateCategory = await getTemplateCategoryByName(parsed.data.templateName);
    }
    const category = String(templateCategory || "UTILITY").toUpperCase();
    if (category === "MARKETING" && !lead.marketingOptIn) {
      return res.status(403).json({ ok: false, error: "MARKETING_OPT_IN_REQUIRED" });
    }

    const sendResult = await sendZokoTemplateMessage({
      phoneNumber: lead.phoneNumber,
      templateName: parsed.data.templateName,
      language: parsed.data.language,
      variables: parsed.data.variables || []
    });
    if (!sendResult.ok) {
      return res.status(502).json({ error: sendResult.error || "template_send_failed" });
    }
    const cachedTemplate = (await getTemplateByName(parsed.data.templateName)) || null;
    const previewText = String(cachedTemplate?.preview_text || "").trim();
    const variableSuffix = (parsed.data.variables || []).filter(Boolean).join(" | ");
    const textForConversation = previewText || `[Template] ${parsed.data.templateName}`;
    const renderedText = variableSuffix ? `${textForConversation}\n${variableSuffix}` : textForConversation;

    const message = await createWhatsAppLeadMessageWithTracking({
      leadId: lead.id,
      direction: "OUT",
      text: renderedText,
      provider: "zoko",
      messageType: "template",
      templateName: parsed.data.templateName,
      externalId: sendResult.externalId || null,
      metadata: {
        templateName: parsed.data.templateName,
        category,
        variables: parsed.data.variables || [],
        language: parsed.data.language || "fr"
      }
    }, {
      source: "OUTBOUND_TEMPLATE",
      ui_source: "send_template_api",
      template_key: parsed.data.templateName
    });
    if (!message) return res.status(503).json({ error: "message_store_failed" });
    const postProcessWarnings = await postProcessAfterOutboundMessage({
      leadId: lead.id,
      leadSnapshot: lead,
      outboundText: renderedText,
      messageCreatedAt: message.createdAt,
      warnings: []
    });
    return res.status(200).json({
      ok: true,
      message_id: message.id,
      external_id: message.externalId || null,
      category,
      warnings: postProcessWarnings
    });
  } catch (error) {
    console.error("[whatsapp] send-template", error);
    return res.status(503).json({ error: "template_send_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/leads/:id/session-status", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const status = await getWhatsAppLeadSessionStatus(leadId, 24);
    return res.status(200).json({
      isSessionOpen: status.isSessionOpen,
      expiresAt: status.expiresAt
    });
  } catch (error) {
    console.error("[whatsapp] session-status", error);
    return res.status(503).json({ error: "session_status_unavailable" });
  }
});

async function handleFollowUpRequest(req: any, res: any) {
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const settings = await getSettings();
    const text = await generateFollowUp(lead, parsed.data.type as FollowUpType, settings);
    let feedback_token: string | null = null;
    try {
      feedback_token = await createSuggestionFeedbackDraft({
        leadId: lead.id,
        source: "ai_followup",
        suggestionType: parsed.data.type,
        suggestionText: text,
        suggestionPayload: {
          type: parsed.data.type,
          generated_at: new Date().toISOString()
        }
      });
    } catch (error) {
      console.warn("[whatsapp] follow-up feedback draft create failed", { leadId: lead.id, error });
    }
    return res.status(200).json({ text, feedback_token });
  } catch (error) {
    console.error("[whatsapp] ai follow-up", error);
    return res.status(503).json({ error: "ai_followup_failed" });
  }
}

whatsappRouter.post("/api/whatsapp/ai/follow-up", handleFollowUpRequest);
whatsappRouter.post("/api/whatsapp/ai/followup", handleFollowUpRequest);

whatsappRouter.post("/api/whatsapp/ai/brief", async (_req, res) => {
  try {
    const stats = await getYesterdayBriefStats();
    const brief = await generateDailyBusinessBrief(stats);
    return res.status(200).json(brief);
  } catch (error) {
    console.error("[whatsapp] ai brief", error);
    return res.status(503).json({ error: "ai_brief_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/ai/classify", async (req, res) => {
  const parsed = classifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });

    const messages = await listRecentWhatsAppLeadMessages(parsed.data.leadId, 10);
    const settings = await getSettings();
    const classification = await classifyLeadWithAi({
      lead,
      messages: messages
        .slice()
        .reverse()
        .map((m) => ({ direction: m.direction, text: m.text, createdAt: m.createdAt })),
      settings
    });
    const progressionMessages = messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      createdAt: m.createdAt
    }));
    const autoSignals = detectSignalsFromMessages(progressionMessages, lead);
    const leadForProgression = {
      ...lead,
      hasProductInterest: lead.hasProductInterest || autoSignals.hasProductInterest,
      hasPriceSent: lead.hasPriceSent || autoSignals.hasPriceSent,
      hasVideoProposed: lead.hasVideoProposed || autoSignals.hasVideoProposed,
      hasPaymentQuestion: lead.hasPaymentQuestion || autoSignals.hasPaymentQuestion,
      hasDepositLinkSent: lead.hasDepositLinkSent || autoSignals.hasDepositLinkSent,
      chatConfirmed: lead.chatConfirmed || autoSignals.chatConfirmed,
      priceIntent: lead.priceIntent || autoSignals.priceIntent,
      videoIntent: lead.videoIntent || autoSignals.videoIntent,
      paymentIntent: lead.paymentIntent || autoSignals.paymentIntent,
      depositIntent: lead.depositIntent || autoSignals.depositIntent,
      confirmationIntent: lead.confirmationIntent || autoSignals.confirmationIntent
    };
    const progression = applyStageProgression(
      leadForProgression,
      detectConversationEvents(progressionMessages, leadForProgression),
      {
        paymentReceived: leadForProgression.paymentReceived,
        depositPaid: leadForProgression.depositPaid,
        hasPaidShopifyOrder: leadForProgression.stage === "CONVERTED",
        shopifyFinancialStatus: leadForProgression.shopifyFinancialStatus
      }
    );

    const confidenceRatio = Number(classification.confidence || 0) / 100;
    const autoApplied = classification.confidence >= 85 && !isSharedLead(lead);
    const suggestedIntent =
      classification.urgency === "HIGH"
        ? "HIGH"
        : classification.detected_stage === "QUALIFIED" || classification.detected_stage === "DEPOSIT_PENDING" || classification.detected_stage === "CONFIRMED"
          ? "HIGH"
          : "MEDIUM";
    const aiSignals = {
      tags: Array.from(new Set([...(lead.detectedSignals?.tags || lead.qualificationTags || []), ...classification.signals_detected])),
      rules_triggered: lead.detectedSignals?.rules_triggered || [],
      evidence: lead.detectedSignals?.evidence || [],
      ai_suggestion: {
        reason: classification.explanation,
        next_question: classification.suggested_message,
        confidence: confidenceRatio,
        recommended_stage: classification.recommended_stage,
        evaluated_at: new Date().toISOString()
      }
    };
    if (autoApplied) {
      await updateWhatsAppLeadStage({
        id: lead.id,
        stage: classification.recommended_stage,
        stageAuto: true,
        stageConfidence: confidenceRatio,
        stageAutoReason: classification.explanation,
        source: "ai_classification_auto"
      });
      await updateLeadQualification({
        id: lead.id,
        intentLevel: suggestedIntent,
        recommendedStage: classification.recommended_stage,
        recommendedStageReason: classification.explanation,
        recommendedStageConfidence: confidenceRatio,
        detectedSignals: aiSignals
      });
    } else {
      await updateLeadQualification({
        id: lead.id,
        intentLevel: suggestedIntent,
        stageConfidence: confidenceRatio,
        stageAuto: false,
        stageAutoReason: classification.explanation,
        recommendedStage: classification.recommended_stage,
        recommendedStageReason: classification.explanation,
        recommendedStageConfidence: confidenceRatio,
        detectedSignals: aiSignals
      });
    }

    let feedback_token: string | null = null;
    try {
      feedback_token = await createSuggestionFeedbackDraft({
        leadId: lead.id,
        source: "ai_classify",
        suggestionType: classification.suggestion_type,
        suggestionText: classification.suggested_message,
        suggestionPayload: {
          detected_stage: classification.detected_stage,
          recommended_stage: classification.recommended_stage,
          confidence: classification.confidence,
          urgency: classification.urgency,
          explanation: classification.explanation,
          generated_at: new Date().toISOString()
        }
      });
    } catch (error) {
      console.warn("[whatsapp] classify feedback draft create failed", { leadId: lead.id, error });
    }

    return res.status(200).json({
      detected_stage: classification.detected_stage,
      confidence: classification.confidence,
      urgency: classification.urgency,
      signals_detected: classification.signals_detected,
      score: classification.score,
      score_breakdown: classification.score_breakdown,
      qualification_complete: classification.qualification_complete,
      missing_fields: classification.missing_fields,
      suggestion_type: classification.suggestion_type,
      suggested_message: classification.suggested_message,
      suggested_reply: classification.suggested_reply,
      recommended_next_action: classification.recommended_next_action,
      explanation: classification.explanation,
      recommended_stage: classification.recommended_stage,
      reason: classification.explanation,
      next_question: classification.suggested_message,
      intent_level: suggestedIntent,
      confidence_ratio: confidenceRatio,
      auto_applied: autoApplied,
      feedback_token,
      signals: {
        chat_confirmed: Boolean(leadForProgression.chatConfirmed),
        payment_question: Boolean(leadForProgression.hasPaymentQuestion),
        deposit_link_sent: Boolean(leadForProgression.hasDepositLinkSent)
      },
      rule_applied: progression.reason || "ai_classification"
    });
  } catch (error) {
    console.error("[whatsapp] ai classify", error);
    return res.status(503).json({ error: "ai_classify_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/ai/draft", async (req, res) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const settings = await getSettings();
    const draft = await generateStageDraft({
      lead,
      type: parsed.data.type as DraftType,
      settings
    });
    return res.status(200).json(draft);
  } catch (error) {
    console.error("[whatsapp] ai draft", error);
    return res.status(503).json({ error: "ai_draft_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/leads/:id/strategic-advisor", async (req, res) => {
  const leadId = String(req.params.id || "").trim();
  if (!leadId) return res.status(400).json({ error: "invalid_id" });
  try {
    const lead = await getWhatsAppLeadById(leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const messages = await listWhatsAppLeadMessages(leadId, { limit: 30, order: "asc" });
    const result = await generateStrategicAdvisorResponse({
      lead,
      messages: messages.map((m) => ({ direction: m.direction, text: m.text }))
    });
    return res.status(200).json({
      advisory: result.text,
      provider: result.provider,
      model: result.model,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[whatsapp] strategic-advisor", error);
    return res.status(503).json({ error: "strategic_advisor_unavailable" });
  }
});

async function suggestReplyHandler(req: any, res: any) {
  const parsed = suggestReplySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const recent = await listWhatsAppLeadMessages(lead.id, { limit: 10, order: "asc" });
    const suggestion = await suggestReplyRulesFirst({
      lead,
      messages: recent.map((m) => ({ direction: m.direction, text: m.text, created_at: m.createdAt })),
      targetStage: parsed.data.targetStage
    });
    const stageTemplateRows = await listStageTemplateSuggestions({
      stage: suggestion.stage_used,
      enabled: true,
      limit: 8
    });
    const template_options = (
      await Promise.all(
        stageTemplateRows.map(async (row) => {
          const tpl = await getTemplateByName(row.template_name);
          if (!tpl) return null;
          return {
            id: row.id,
            stage: row.stage,
            template_name: row.template_name,
            priority: row.priority,
            category: tpl.category,
            language: tpl.language,
            preview_text: tpl.preview_text
          };
        })
      )
    ).filter(Boolean);
    let feedback_token: string | null = null;
    try {
      feedback_token = await createSuggestionFeedbackDraft({
        leadId: lead.id,
        source: "rules_suggest_reply",
        suggestionType: suggestion.suggestion_type,
        suggestionText: suggestion.suggested_message,
        suggestionPayload: {
          stage_used: suggestion.stage_used,
          recommended_stage: suggestion.recommended_stage,
          tags_detected: suggestion.tags_detected,
          rule_applied: suggestion.rule_applied,
          qualification_complete: suggestion.qualification_complete,
          missing_fields: suggestion.missing_fields,
          generated_at: new Date().toISOString()
        }
      });
    } catch (error) {
      console.warn("[whatsapp] suggest-reply feedback draft create failed", { leadId: lead.id, error });
    }
    return res.status(200).json({
      suggested_message: suggestion.suggested_message,
      suggested_reply: suggestion.suggested_reply,
      text: suggestion.suggested_message,
      suggestion_type: suggestion.suggestion_type,
      suggestionType: suggestion.suggestionType,
      stage_used: suggestion.stage_used,
      recommended_stage: suggestion.recommended_stage,
      qualification_complete: suggestion.qualification_complete,
      missing_fields: suggestion.missing_fields,
      tags_detected: suggestion.tags_detected,
      rule_applied: suggestion.rule_applied,
      why: suggestion.why,
      based_on: "last inbound message + current stage",
      feedback_token,
      template_options
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ai_suggest_failed";
    if (String(message).startsWith("unknown_stage")) {
      return res.status(400).json({ error: "unsupported_stage", message });
    }
    if (String(message).startsWith("no_inbound_message")) {
      return res.status(400).json({ error: "no_inbound_message", message: "No inbound message found for selected lead." });
    }
    console.error("[whatsapp] ai suggest-reply", error);
    return res.status(503).json({ error: "ai_suggest_failed" });
  }
}

whatsappRouter.post("/api/whatsapp/suggest-reply", suggestReplyHandler);
whatsappRouter.post("/api/whatsapp/ai/suggest-reply", suggestReplyHandler);

whatsappRouter.post("/api/whatsapp/suggestions/cards", async (req, res) => {
  const parsed = suggestionsCardsSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const messages = await listRecentWhatsAppLeadMessages(parsed.data.leadId, 20);
    const lang = String(lead.country || "").toUpperCase() === "US" ? "EN" : "FR";
    const destinationParts = [lead.shipCity, lead.shipRegion, lead.shipCountry].filter((v) => String(v || "").trim());
    const destination = destinationParts.length ? destinationParts.join(", ") : lead.shipDestinationText || null;
    const leadDateFacts = inferEventDateFacts({ eventDate: lead.eventDate, eventDateText: lead.eventDateText });
    const normalizedMessages = messages.map((m) => ({
      direction: String(m.direction || "").toUpperCase() === "OUT" ? "out" as const : "in" as const,
      text: m.text,
      ts: m.createdAt
    }));
    const risk = computeRiskScore({
      facts: {
        stage: lead.stage,
        lang,
        event_date: lead.eventDate,
        destination,
        intents: {
          price_intent: lead.priceIntent,
          video_intent: lead.videoIntent,
          payment_intent: lead.paymentIntent,
          deposit_intent: lead.depositIntent,
          confirmation_intent: lead.confirmationIntent
        }
      },
      messages: normalizedMessages
    });

    const cards = buildSuggestions({
      facts: {
        stage: lead.stage,
        lang,
        event_date: lead.eventDate,
        event_month: leadDateFacts.event_month,
        event_date_precision: leadDateFacts.event_date_precision,
        event_date_estimate_iso: leadDateFacts.event_date_estimate_iso,
        event_date_text: lead.eventDateText,
        destination,
        risk_score: risk.risk_score,
        product_id: lead.productReference,
        intents: {
          price_intent: lead.priceIntent,
          video_intent: lead.videoIntent,
          payment_intent: lead.paymentIntent,
          deposit_intent: lead.depositIntent,
          confirmation_intent: lead.confirmationIntent
        }
      },
      messages: normalizedMessages
    });

    const learningSettings = await getSuggestionLearningSettings();
    const perf = await getSuggestionTypePerformance({
      days: learningSettings.learning_window_days,
      minSamples: learningSettings.min_samples,
      successWeight: learningSettings.success_weight,
      acceptedWeight: learningSettings.accepted_weight,
      lostWeight: learningSettings.lost_weight,
      boostMin: learningSettings.boost_min,
      boostMax: learningSettings.boost_max,
      successOutcomes: learningSettings.success_outcomes,
      failureOutcomes: learningSettings.failure_outcomes
    });
    const rankedCards = cards
      .map((card) => {
        const key = String(card.id || "").trim().toLowerCase();
        const stats = perf.get(key);
        const bonus = stats ? stats.boost : 0;
        return {
          ...card,
          priority: Number(card.priority || 0) + bonus
        };
      })
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
      .slice(0, 4);

    return res.status(200).json({
      lead_id: lead.id,
      stage: lead.stage,
      cards: rankedCards
    });
  } catch (error) {
    console.error("[whatsapp] suggestions cards", error);
    return res.status(503).json({ error: "suggestions_cards_unavailable" });
  }
});

async function handleAiSuggestionsRegenerate(req: Request, res: Response) {
  const parsed = aiSuggestionsSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const messages = await listWhatsAppLeadMessages(lead.id, { limit: parsed.data.maxMessages ?? 20, order: "asc" });
    const result = await generateAiPersonalSuggestions({
      lead,
      messages,
      maxMessages: parsed.data.maxMessages ?? 20
    });

    await createMlEvent({
      eventType: "SUGGESTIONS_GENERATED",
      source: "SYSTEM",
      leadId: lead.id,
      payload: {
        leadId: lead.id,
        model: result.model,
        n: result.suggestions.length,
        provider: result.provider,
        fallback: result.provider === "fallback",
        fallback_reason: result.fallbackReason
      }
    });

    const normalizedSuggestions = (Array.isArray(result.suggestions) ? result.suggestions : []).map((item, idx) => {
      const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const messages = normalizeGeneratedSuggestionMessages(raw);
      const text = messages.length ? messages.join("\n\n") : String(raw.text || raw.reply || "").trim();
      return {
        ...raw,
        id: String(raw.id || `ai_${idx + 1}`),
        messages,
        text
      };
    });

    return res.status(200).json({
      suggestions: normalizedSuggestions,
      contextSnapshot: result.contextSnapshot
    });
  } catch (error) {
    console.error("[whatsapp] ai suggestions", error);
    return res.status(503).json({ error: "ai_suggestions_unavailable" });
  }
}

whatsappRouter.post("/api/ai/suggestions", handleAiSuggestionsRegenerate);
whatsappRouter.post("/api/ai-regenerate", handleAiSuggestionsRegenerate);

whatsappRouter.post("/api/whatsapp/suggestions/cards/feedback-draft", async (req, res) => {
  const parsed = suggestionCardFeedbackDraftSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const lead = await getWhatsAppLeadById(parsed.data.leadId);
    if (!lead) return res.status(404).json({ error: "lead_not_found" });
    const feedbackToken = await createSuggestionFeedbackDraft({
      leadId: lead.id,
      source: "manual",
      suggestionType: String(parsed.data.cardId || "").trim().toLowerCase(),
      suggestionText: String(parsed.data.cardText || "").trim(),
      suggestionPayload: {
        card_id: String(parsed.data.cardId || "").trim(),
        generated_at: new Date().toISOString(),
        source: "suggestions_cards_insert"
      }
    });
    return res.status(200).json({ feedback_token: feedbackToken });
  } catch (error) {
    console.error("[whatsapp] suggestions card feedback draft", error);
    return res.status(503).json({ error: "suggestion_card_feedback_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/suggestions/review", async (req, res) => {
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      status: z.enum(["OPEN", "REVIEWED", "ARCHIVED", "ALL"]).optional()
    })
    .safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  try {
    const items = await listSuggestionFeedbackQueue({
      limit: parsed.data.limit ?? 100,
      status: parsed.data.status ?? "OPEN"
    });
    return res.status(200).json({ items });
  } catch (error) {
    console.error("[whatsapp] suggestions review list", error);
    return res.status(503).json({ error: "suggestions_review_unavailable" });
  }
});

whatsappRouter.get("/api/whatsapp/suggestions/learning-settings", async (_req, res) => {
  try {
    const settings = await getSuggestionLearningSettings();
    return res.status(200).json(settings);
  } catch (error) {
    console.error("[whatsapp] suggestion learning settings get", error);
    return res.status(503).json({ error: "suggestion_learning_settings_unavailable" });
  }
});

whatsappRouter.patch("/api/whatsapp/suggestions/learning-settings", async (req, res) => {
  const parsed = suggestionLearningSettingsPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const payload = parsed.data;
    const settings = await updateSuggestionLearningSettings({
      learning_window_days: payload.learning_window_days,
      min_samples: payload.min_samples,
      success_weight: payload.success_weight,
      accepted_weight: payload.accepted_weight,
      lost_weight: payload.lost_weight,
      boost_min: payload.boost_min,
      boost_max: payload.boost_max,
      success_outcomes: payload.success_outcomes?.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean),
      failure_outcomes: payload.failure_outcomes?.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean)
    });
    return res.status(200).json(settings);
  } catch (error) {
    console.error("[whatsapp] suggestion learning settings patch", error);
    return res.status(503).json({ error: "suggestion_learning_settings_update_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/suggestions/learning-settings/reset", async (_req, res) => {
  try {
    const settings = await resetSuggestionLearningSettings();
    return res.status(200).json(settings);
  } catch (error) {
    console.error("[whatsapp] suggestion learning settings reset", error);
    return res.status(503).json({ error: "suggestion_learning_settings_reset_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/suggestions/learning-settings/recompute", async (_req, res) => {
  try {
    const settings = await getSuggestionLearningSettings();
    const perf = await getSuggestionTypePerformance({
      days: settings.learning_window_days,
      minSamples: settings.min_samples,
      successWeight: settings.success_weight,
      acceptedWeight: settings.accepted_weight,
      lostWeight: settings.lost_weight,
      boostMin: settings.boost_min,
      boostMax: settings.boost_max,
      successOutcomes: settings.success_outcomes,
      failureOutcomes: settings.failure_outcomes
    });
    return res.status(200).json({
      ok: true,
      settings,
      recomputed_types: perf.size
    });
  } catch (error) {
    console.error("[whatsapp] suggestion learning recompute", error);
    return res.status(503).json({ error: "suggestion_learning_recompute_failed" });
  }
});

whatsappRouter.get("/api/whatsapp/suggestions/performance", async (req, res) => {
  const parsed = z
    .object({
      days: z.coerce.number().int().min(7).max(365).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional()
    })
    .safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  try {
    const learningSettings = await getSuggestionLearningSettings();
    const days = parsed.data.days ?? learningSettings.learning_window_days;
    const perf = await getSuggestionTypePerformance({
      days,
      minSamples: learningSettings.min_samples,
      successWeight: learningSettings.success_weight,
      acceptedWeight: learningSettings.accepted_weight,
      lostWeight: learningSettings.lost_weight,
      boostMin: learningSettings.boost_min,
      boostMax: learningSettings.boost_max,
      successOutcomes: learningSettings.success_outcomes,
      failureOutcomes: learningSettings.failure_outcomes
    });
    const items = [...perf.entries()]
      .map(([suggestion_type, value]) => ({
        suggestion_type,
        total: value.total,
        accepted_rate: value.acceptedRate,
        success_rate: value.successRate,
        lost_rate: value.lostRate,
        boost: value.boost
      }))
      .sort((a, b) => b.boost - a.boost || b.total - a.total)
      .slice(0, parsed.data.limit ?? 12);
    return res.status(200).json({
      days,
      items
    });
  } catch (error) {
    console.error("[whatsapp] suggestion performance", error);
    return res.status(503).json({ error: "suggestion_performance_unavailable" });
  }
});

whatsappRouter.patch("/api/whatsapp/suggestions/:id/outcome", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const parsed = suggestionOutcomeSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const ok = await markSuggestionOutcome({
      id,
      outcomeLabel: parsed.data.outcome,
      reviewNotes: parsed.data.review_notes ?? null
    });
    if (!ok) return res.status(404).json({ error: "suggestion_not_found" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] suggestion outcome patch", error);
    return res.status(503).json({ error: "suggestion_outcome_update_failed" });
  }
});

whatsappRouter.patch("/api/whatsapp/suggestions/:id/review", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const parsed = suggestionReviewSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const ok = await updateSuggestionReviewStatus({
      id,
      status: parsed.data.status,
      reviewNotes: parsed.data.review_notes ?? null
    });
    if (!ok) return res.status(404).json({ error: "suggestion_not_found" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp] suggestion review patch", error);
    return res.status(503).json({ error: "suggestion_review_update_failed" });
  }
});

whatsappRouter.post("/api/whatsapp/sync", async (req, res) => {
  const parsed = syncSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const historyUrl = String(env.ZOKO_HISTORY_API_URL || "").trim();
  if (!historyUrl) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: "history_url_missing",
      pages: 0,
      rows: 0,
      leadsUpserted: 0,
      messagesImported: 0,
      nextCursor: null
    });
  }
  try {
    new URL(historyUrl);
  } catch {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: "history_url_invalid",
      message: "ZOKO_HISTORY_API_URL invalide (format URL).",
      pages: 0,
      rows: 0,
      leadsUpserted: 0,
      messagesImported: 0,
      nextCursor: null
    });
  }
  try {
    const result = await syncZokoConversationHistory({
      maxPages: parsed.data.max_pages ?? 5,
      cursor: parsed.data.cursor ?? null,
      onlyInbound: parsed.data.only_inbound ?? false
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("[whatsapp] sync", error);
    return res.status(503).json({ error: "sync_failed", message: error instanceof Error ? error.message : "unknown" });
  }
});

whatsappRouter.get("/admin/whatsapp-intelligence/settings", (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  return res.status(200).type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Réglages WhatsApp Intelligence</title>
  <style>
    :root { --line:#1d2b44; --txt:#e8eef9; --muted:#9aa9c4; --card:#0b1321; --bg:#060b14; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(1100px 500px at 18% -10%, #17243a 0%, #060b14 58%); color:var(--txt); font:14px/1.5 "Avenir Next","Helvetica Neue",Arial,sans-serif; }
    .wrap { max-width:1280px; margin:22px auto; padding:0 14px; }
    .nav { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
    .nav a { color:#d6e0f3; text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:7px 12px; background:#0b1423; font-size:13px; }
    .nav a.current { background:#162237; border-color:#4f6b94; color:#fff; }
    .card { border:1px solid var(--line); border-radius:14px; background:linear-gradient(180deg,#0c1423,#0a1220); padding:16px; }
    .tabs { display:flex; gap:8px; margin:8px 0 14px; }
    .tab { border:1px solid #314868; border-radius:999px; background:#0f182a; color:#e6eefc; padding:7px 12px; cursor:pointer; }
    .tab.active { background:#1a2a43; border-color:#6589bc; }
    .panel { display:none; }
    .panel.active { display:block; }
    .grid3 { display:grid; gap:10px; grid-template-columns: repeat(3,minmax(0,1fr)); }
    .country-card, .box { border:1px solid #22324b; border-radius:12px; background:#0b1422; padding:12px; }
    .row { display:grid; gap:8px; grid-template-columns: repeat(2,minmax(0,1fr)); margin-top:8px; }
    label { display:grid; gap:5px; color:#c6d4ec; font-size:12px; }
    input, select, textarea { width:100%; border:1px solid #304562; border-radius:10px; background:#0d1626; color:#f4f8ff; padding:8px 10px; }
    textarea { min-height:90px; resize:vertical; }
    .btn { border:1px solid #4f6b94; border-radius:10px; background:linear-gradient(180deg,#2e4363,#1c2a41); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
    .btn.small { padding:6px 10px; font-size:12px; }
    table { width:100%; border-collapse:collapse; margin-top:8px; }
    th, td { padding:8px; border-bottom:1px solid #1d2b44; text-align:left; vertical-align:top; }
    th { color:#9db0cf; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .muted { color:var(--muted); font-size:12px; }
    .toast { position:fixed; right:16px; bottom:16px; border:1px solid #3f5f85; background:rgba(79,107,148,.2); color:#dce8ff; border-radius:10px; padding:8px 10px; display:none; z-index:50; }
    .toast.show { display:block; }
    .inline { display:flex; gap:8px; align-items:center; }
    @media (max-width:980px){ .grid3, .row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <nav class="nav">
      <a href="/admin${navSuffix}">Commandes</a>
      <a href="/admin/invoices${navSuffix}">Factures</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/forecast-v2${navSuffix}">Forecast V2</a>
      <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
      <a href="/blueprint${navSuffix}">Blueprint</a>
      <a href="/admin/spline${navSuffix}">Spline</a>
      <a href="/admin/whatsapp-intelligence${navSuffix}">Intelligence WhatsApp</a>
      <a href="/whatsapp-intelligence/workflow${navSuffix}">Manager Approval Flow</a>
      <a href="/whatsapp-intelligence/mobile-lab${navSuffix}">Mobile App</a>
      <a href="/whatsapp-lab${navSuffix}">WhatsApp Lab</a>
      <a href="/whatsapp-logic-diagram${navSuffix}">Logic Diagram</a>
      <a class="current" href="/admin/whatsapp-intelligence/settings${navSuffix}">Réglages WhatsApp Intelligence</a>
    </nav>
    <section class="card">
      <h1 style="margin:0 0 4px;">Réglages WhatsApp Intelligence</h1>
      <p class="muted">Pilotage règles de classification, templates de réponse et politiques par pays.</p>
      <div class="tabs" id="tabs">
        <button class="tab active" data-tab="countries">Pays</button>
        <button class="tab" data-tab="keywords">Mots-clés</button>
        <button class="tab" data-tab="templates">Templates de réponse</button>
      </div>

      <div id="countries" class="panel active">
        <div class="box" style="margin-bottom:10px;">
          <h3 style="margin:0 0 8px;">Global</h3>
          <div class="row">
            <label>Ton <select id="gTone"><option>QUIET_LUXURY</option><option>FORMEL</option><option>DIRECT</option></select></label>
            <label>Longueur <select id="gLength"><option>SHORT</option><option>MEDIUM</option></select></label>
            <label><span class="inline"><input type="checkbox" id="gNoEmoji" /> Sans emojis</span></label>
            <label><span class="inline"><input type="checkbox" id="gNoFollowup" /> Éviter "follow up"</span></label>
            <label><span class="inline"><input type="checkbox" id="gSigEnabled" /> Signature active</span></label>
            <label>Signature <input id="gSigText" type="text" placeholder="Maison BFL" /></label>
          </div>
          <button id="saveGlobalBtn" class="btn small" type="button">Enregistrer global</button>
        </div>
        <div class="grid3" id="countryCards"></div>
      </div>

      <div id="keywords" class="panel">
        <div class="inline" style="margin-bottom:8px;">
          <label>Langue
            <select id="kwLanguage"><option value="FR">FR</option><option value="EN">EN</option></select>
          </label>
          <button id="reloadKwBtn" class="btn small" type="button">Recharger</button>
          <button id="newKwBtn" class="btn small" type="button">Nouvelle règle</button>
        </div>
        <div class="box">
          <table>
            <thead><tr><th>Tag</th><th>Keywords (csv)</th><th>Patterns regex (csv)</th><th>Enabled</th><th>Action</th></tr></thead>
            <tbody id="kwRows"></tbody>
          </table>
        </div>
        <div class="box" style="margin-top:10px;">
          <h3 style="margin:0 0 8px;">Règles de stage (funnel)</h3>
          <button id="newStageRuleBtn" class="btn small" type="button">Nouvelle règle stage</button>
          <table>
            <thead><tr><th>Rule</th><th>Required tags</th><th>Forbidden tags</th><th>Stage</th><th>Priority</th><th>Enabled</th><th>Action</th></tr></thead>
            <tbody id="stageRuleRows"></tbody>
          </table>
        </div>
      </div>

      <div id="templates" class="panel">
        <div class="inline">
          <label>Stage <select id="tplStageFilter"><option value="">ALL</option><option>NEW</option><option>QUALIFICATION_PENDING</option><option>QUALIFIED</option><option>PRICE_SENT</option><option>DEPOSIT_PENDING</option><option>CONFIRMED</option><option>CONVERTED</option><option>LOST</option></select></label>
          <label>Langue <select id="tplLanguageFilter"><option value="">ALL</option><option>FR</option><option>EN</option></select></label>
          <label>Pays <select id="tplCountryFilter"><option value="">ALL</option><option value="GLOBAL">GLOBAL</option><option>MA</option><option>FR</option><option>INTL</option></select></label>
          <button id="reloadTplBtn" class="btn small" type="button">Recharger</button>
          <button id="newTplBtn" class="btn small" type="button">Nouveau template</button>
        </div>
        <div class="box" style="margin-top:8px;">
          <table>
            <thead><tr><th>Template</th><th>Stage</th><th>Langue</th><th>Pays</th><th>Texte</th><th>Enabled</th><th>Action</th></tr></thead>
            <tbody id="tplRows"></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
  <div id="toast" class="toast">Saved</div>
  <script>
    const rawQ = new URLSearchParams(window.location.search);
    const q = new URLSearchParams();
    const queryAllowList = new Set(["tab"]);
    rawQ.forEach((value, key) => {
      if (queryAllowList.has(String(key || "").toLowerCase())) q.set(key, value);
    });
    const qs = q.toString() ? "?" + q.toString() : "";
    const toast = document.getElementById("toast");
    const countryGroups = ["MA","FR","INTL"];
    function showToast(msg){ toast.textContent = msg; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 1800); }
    async function fetchJson(url, opts){ const r = await fetch(url, opts); const t = await r.text(); let b=null; try{ b=t?JSON.parse(t):null;}catch{ b=null; } if(!r.ok) throw new Error((b && (b.error||b.message)) || r.statusText); return b; }
    function esc(v){ return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;"); }
    document.getElementById("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]"); if(!b) return;
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      document.getElementById(String(b.getAttribute("data-tab"))).classList.add("active");
    });

    async function loadGlobalAndCountries(){
      const g = await fetchJson("/api/ai/settings/global"+qs);
      gTone.value = g.tone; gLength.value = g.message_length; gNoEmoji.checked = !!g.no_emojis; gNoFollowup.checked = !!g.avoid_follow_up_phrase; gSigEnabled.checked = !!g.signature_enabled; gSigText.value = g.signature_text || "";
      const cards = await Promise.all(countryGroups.map((grp) => fetchJson("/api/ai/settings/country-group/"+grp+qs)));
      countryCards.innerHTML = cards.map((c) => '<div class="country-card" data-group="'+esc(c.country_group)+'">'+
        "<h3 style='margin:0 0 8px;'>"+esc(c.country_group)+"</h3>"+
        '<div class="row">'+
        '<label>Langue<select data-k="language"><option>AUTO</option><option>FR</option><option>EN</option></select></label>'+
        '<label>Price policy<select data-k="price_policy"><option>NEVER_FIRST</option><option>AFTER_QUALIFIED</option></select></label>'+
        '<label>Video policy<select data-k="video_policy"><option>NEVER</option><option>WHEN_HIGH_INTENT</option><option>ALWAYS</option></select></label>'+
        '<label>Urgency style<select data-k="urgency_style"><option>SUBTLE</option><option>NEUTRAL</option></select></label>'+
        '<label>Follow-up delay (h)<input data-k="followup_delay_hours" type="number" min="1" max="240" value="'+esc(c.followup_delay_hours)+'"/></label>'+
        '</div><button class="btn small save-country-btn" type="button">Enregistrer '+esc(c.country_group)+'</button></div>').join("");
      cards.forEach((c) => {
        const root = countryCards.querySelector('[data-group="'+c.country_group+'"]'); if(!root) return;
        ["language","price_policy","video_policy","urgency_style","followup_delay_hours"].forEach((k) => {
          const el = root.querySelector('[data-k="'+k+'"]'); if(!el) return; el.value = String(c[k] ?? "");
        });
      });
    }
    saveGlobalBtn.addEventListener("click", async () => {
      await fetchJson("/api/ai/settings/global"+qs, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
        tone: gTone.value, message_length: gLength.value, no_emojis: gNoEmoji.checked, avoid_follow_up_phrase: gNoFollowup.checked, signature_enabled: gSigEnabled.checked, signature_text: gSigText.value || null
      })});
      showToast("Global enregistré");
    });
    countryCards.addEventListener("click", async (e) => {
      const b = e.target.closest(".save-country-btn"); if(!b) return;
      const card = b.closest("[data-group]"); const grp = card.getAttribute("data-group");
      await fetchJson("/api/ai/settings/country-group/"+grp+qs, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
        language: card.querySelector('[data-k="language"]').value,
        price_policy: card.querySelector('[data-k="price_policy"]').value,
        video_policy: card.querySelector('[data-k="video_policy"]').value,
        urgency_style: card.querySelector('[data-k="urgency_style"]').value,
        followup_delay_hours: Number(card.querySelector('[data-k="followup_delay_hours"]').value || 48)
      })});
      showToast("Pays "+grp+" enregistré");
    });

    async function loadKeywordRules(){
      const lang = kwLanguage.value;
      const data = await fetchJson("/api/whatsapp/rules/keywords?language="+encodeURIComponent(lang)+(qs ? "&"+qs.slice(1) : ""));
      kwRows.innerHTML = (data.items || []).map((r) => '<tr data-id="'+esc(r.id)+'">'+
        "<td>"+esc(r.tag)+"</td>"+
        '<td><input data-k="keywords" value="'+esc((r.keywords||[]).join(", "))+'"/></td>'+
        '<td><input data-k="patterns" value="'+esc((r.patterns||[]).join(", "))+'"/></td>'+
        '<td><input data-k="enabled" type="checkbox" '+(r.enabled?"checked":"")+'/></td>'+
        '<td><button class="btn small save-kw-btn" type="button">Save</button></td>'+
      "</tr>").join("");
      const stageData = await fetchJson("/api/whatsapp/rules/stages"+qs);
      stageRuleRows.innerHTML = (stageData.items || []).map((r) => '<tr data-id="'+esc(r.id)+'">'+
        '<td><input data-k="rule_name" value="'+esc(r.rule_name)+'"/></td>'+
        '<td><input data-k="required_tags" value="'+esc((r.required_tags||[]).join(", "))+'"/></td>'+
        '<td><input data-k="forbidden_tags" value="'+esc((r.forbidden_tags||[]).join(", "))+'"/></td>'+
        '<td><input data-k="recommended_stage" value="'+esc(r.recommended_stage)+'"/></td>'+
        '<td><input data-k="priority" type="number" value="'+esc(r.priority)+'"/></td>'+
        '<td><input data-k="enabled" type="checkbox" '+(r.enabled?"checked":"")+'/></td>'+
        '<td><button class="btn small save-stage-rule-btn" type="button">Save</button></td>'+
      "</tr>").join("");
    }
    reloadKwBtn.addEventListener("click", () => loadKeywordRules().catch((e)=>showToast(e.message||"Erreur")));
    kwLanguage.addEventListener("change", () => loadKeywordRules().catch((e)=>showToast(e.message||"Erreur")));
    kwRows.addEventListener("click", async (e) => {
      const b = e.target.closest(".save-kw-btn"); if(!b) return;
      const tr = b.closest("tr");
      await fetchJson("/api/whatsapp/rules/keywords/"+tr.getAttribute("data-id")+qs, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
        keywords: tr.querySelector('[data-k="keywords"]').value.split(",").map((s)=>s.trim()).filter(Boolean),
        patterns: tr.querySelector('[data-k="patterns"]').value.split(",").map((s)=>s.trim()).filter(Boolean),
        enabled: tr.querySelector('[data-k="enabled"]').checked
      })});
      showToast("Règle mots-clés enregistrée");
    });
    newKwBtn.addEventListener("click", async () => {
      await fetchJson("/api/whatsapp/rules/keywords"+qs, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ language: kwLanguage.value, tag: "INTEREST", keywords:["interested"], patterns:[], enabled:true }) });
      await loadKeywordRules(); showToast("Nouvelle règle créée");
    });
    stageRuleRows.addEventListener("click", async (e) => {
      const b = e.target.closest(".save-stage-rule-btn"); if(!b) return;
      const tr = b.closest("tr");
      await fetchJson("/api/whatsapp/rules/stages/"+tr.getAttribute("data-id")+qs, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
        rule_name: tr.querySelector('[data-k="rule_name"]').value,
        required_tags: tr.querySelector('[data-k="required_tags"]').value.split(",").map((s)=>s.trim()).filter(Boolean),
        forbidden_tags: tr.querySelector('[data-k="forbidden_tags"]').value.split(",").map((s)=>s.trim()).filter(Boolean),
        recommended_stage: tr.querySelector('[data-k="recommended_stage"]').value,
        priority: Number(tr.querySelector('[data-k="priority"]').value || 100),
        enabled: tr.querySelector('[data-k="enabled"]').checked
      })});
      showToast("Règle stage enregistrée");
    });
    newStageRuleBtn.addEventListener("click", async () => {
      await fetchJson("/api/whatsapp/rules/stages"+qs, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ rule_name:"new_rule", required_tags:["INTEREST"], forbidden_tags:[], recommended_stage:"PRODUCT_INTEREST", priority:120, enabled:true })});
      await loadKeywordRules(); showToast("Nouvelle règle stage créée");
    });

    async function loadReplyTemplates(){
      const p = new URLSearchParams();
      if (tplStageFilter.value) p.set("stage", tplStageFilter.value);
      if (tplLanguageFilter.value) p.set("language", tplLanguageFilter.value);
      if (tplCountryFilter.value) p.set("country_group", tplCountryFilter.value);
      const data = await fetchJson("/api/whatsapp/reply-templates?"+p.toString()+(qs ? "&"+qs.slice(1) : ""));
      tplRows.innerHTML = (data.items || []).map((r) => '<tr data-id="'+esc(r.id)+'">'+
        '<td><input data-k="template_name" value="'+esc(r.template_name)+'"/></td>'+
        '<td><input data-k="stage" value="'+esc(r.stage)+'"/></td>'+
        '<td><input data-k="language" value="'+esc(r.language)+'"/></td>'+
        '<td><input data-k="country_group" value="'+esc(r.country_group || "")+'" placeholder="GLOBAL"/></td>'+
        '<td><textarea data-k="text">'+esc(r.text)+'</textarea></td>'+
        '<td><input data-k="enabled" type="checkbox" '+(r.enabled?"checked":"")+'/></td>'+
        '<td><button class="btn small save-tpl-btn" type="button">Save</button></td>'+
      "</tr>").join("");
    }
    reloadTplBtn.addEventListener("click", () => loadReplyTemplates().catch((e)=>showToast(e.message||"Erreur")));
    [tplStageFilter, tplLanguageFilter, tplCountryFilter].forEach((el) => el.addEventListener("change", () => loadReplyTemplates().catch((e)=>showToast(e.message||"Erreur"))));
    tplRows.addEventListener("click", async (e) => {
      const b = e.target.closest(".save-tpl-btn"); if(!b) return;
      const tr = b.closest("tr");
      const cgRaw = tr.querySelector('[data-k="country_group"]').value.trim().toUpperCase();
      await fetchJson("/api/whatsapp/reply-templates/"+tr.getAttribute("data-id")+qs, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
        template_name: tr.querySelector('[data-k="template_name"]').value,
        stage: tr.querySelector('[data-k="stage"]').value,
        language: tr.querySelector('[data-k="language"]').value,
        country_group: !cgRaw || cgRaw === "GLOBAL" ? null : cgRaw,
        text: tr.querySelector('[data-k="text"]').value,
        enabled: tr.querySelector('[data-k="enabled"]').checked
      })});
      showToast("Template enregistré");
    });
    newTplBtn.addEventListener("click", async () => {
      await fetchJson("/api/whatsapp/reply-templates"+qs, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
        stage: "NEW", language: "FR", country_group: null, template_name: "new_template", text: "Merci {client_name}, pouvez-vous confirmer la date et le pays de livraison ?", enabled: true
      })});
      await loadReplyTemplates(); showToast("Nouveau template créé");
    });

    Promise.all([loadGlobalAndCountries(), loadKeywordRules(), loadReplyTemplates()])
      .catch((e) => showToast(e && e.message ? e.message : "Erreur chargement"));
  </script>
</body>
</html>`);
});

whatsappRouter.get("/whatsapp-intelligence/mobile-lab", (req, res) => {
  const navParams = new URLSearchParams();
  const host = typeof req.query.host === "string" ? req.query.host.trim() : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop.trim() : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded.trim() : "";
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  const modeRaw = typeof req.query.mode === "string" ? req.query.mode.trim().toLowerCase() : "";
  const mode = modeRaw === "mock" ? "mock" : "live";
  const leadId = typeof req.query.leadId === "string" ? req.query.leadId.trim().slice(0, 120) : "";

  const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>WhatsApp Mobile Lab</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        min-height: 100%;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(circle at top, rgba(35,44,95,.55), rgba(4,6,20,1) 42%);
        color: #fff;
      }
      #root { min-height: 100dvh; }
      .page {
        min-height: 100dvh;
        display: block;
        padding: 64px 14px 14px;
        overflow-x: hidden;
        overflow-y: auto;
        background:
          radial-gradient(80% 52% at 50% -8%, rgba(76, 130, 255, .22) 0%, rgba(8, 12, 24, 0) 60%),
          radial-gradient(34% 40% at 10% 32%, rgba(45, 212, 255, .13) 0%, rgba(8, 12, 24, 0) 72%),
          radial-gradient(34% 36% at 90% 70%, rgba(177, 95, 255, .10) 0%, rgba(8, 12, 24, 0) 72%);
      }
      .preview-grid {
        width: min(1500px, 100%);
        margin: 0 auto;
        display: grid;
        gap: 14px;
      }
      .preview-grid.all {
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        align-items: start;
      }
      .preview-grid.single {
        grid-template-columns: 1fr;
        justify-items: center;
      }
      .device-wrap { display: grid; gap: 8px; justify-items: center; }
      .device-label {
        font-size: 11px;
        letter-spacing: .14em;
        text-transform: uppercase;
        color: rgba(219, 234, 254, .78);
      }
      .mode-switch {
        position: fixed;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 13;
        display: inline-flex;
        gap: 6px;
        padding: 6px;
        border-radius: 999px;
        border: 1px solid rgba(131,153,187,.45);
        background: rgba(7,12,22,.76);
        backdrop-filter: blur(12px);
      }
      .mode-switch button {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        color: rgba(234, 245, 255, .9);
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 12px;
        cursor: pointer;
      }
      .mode-switch button.active {
        background: linear-gradient(135deg, rgba(103,232,249,.92) 0%, rgba(96,165,250,.9) 100%);
        color: #0f172a;
        border-color: rgba(207,250,254,.75);
        font-weight: 700;
      }
      .shell {
        position: relative;
        width: 100%;
        max-width: 430px;
        height: 840px;
        max-height: calc(100dvh - 20px);
        border-radius: 2.5rem;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.04);
        box-shadow: 0 26px 90px rgba(0,0,0,.5);
        backdrop-filter: blur(18px);
      }
      .shell.tablet {
        max-width: 860px;
        border-radius: 2.2rem;
      }
      .shell.desktop {
        max-width: 1452px;
        border-radius: 2rem;
        background:
          linear-gradient(180deg, rgba(16, 24, 44, .72) 0%, rgba(11, 18, 34, .8) 100%);
        border-color: rgba(168, 208, 255, .2);
        box-shadow:
          0 36px 100px rgba(0,0,0,.58),
          0 0 0 1px rgba(162, 211, 255, .10) inset;
      }
      .shell.desktop::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(48% 32% at 20% 10%, rgba(61, 216, 255, .16) 0%, rgba(0,0,0,0) 72%),
          radial-gradient(62% 52% at 88% 72%, rgba(163, 96, 255, .26) 0%, rgba(0,0,0,0) 74%),
          radial-gradient(45% 38% at 74% 30%, rgba(186, 104, 255, .18) 0%, rgba(0,0,0,0) 76%);
        filter: blur(10px);
      }
      .shell.desktop::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(180deg, rgba(255,255,255,.06), transparent 16%, transparent 82%, rgba(255,255,255,.04));
      }
      .app-desktop {
        position: relative;
        z-index: 3;
        height: 100%;
        display: grid;
        grid-template-columns: 364px 560px minmax(300px, 1fr);
        gap: 0;
      }
      .app-desktop::before {
        content: none;
      }
      .app-desktop::after {
        content: none;
      }
      .desk-col {
        position: relative;
        min-height: 0;
        display: flex;
        flex-direction: column;
        margin: 10px 0;
        border-radius: 22px;
        overflow: hidden;
        border: 1px solid rgba(170, 209, 255, .16);
        box-shadow:
          0 20px 45px rgba(0,0,0,.32),
          inset 0 1px 0 rgba(255,255,255,.06);
        backdrop-filter: blur(16px);
      }
      .desk-col.left {
        margin-left: 10px;
        background:
          radial-gradient(120% 90% at 18% -10%, rgba(62, 205, 255, .12) 0%, rgba(8,12,24,0) 68%),
          linear-gradient(180deg, rgba(13,21,38,.78), rgba(9,14,27,.72));
      }
      .desk-col.center {
        margin-left: 10px;
        background:
          radial-gradient(120% 90% at 46% -16%, rgba(87, 145, 255, .16) 0%, rgba(8,12,24,0) 66%),
          radial-gradient(80% 90% at 92% 42%, rgba(158, 92, 255, .17) 0%, rgba(8,12,24,0) 72%),
          linear-gradient(180deg, rgba(14,23,42,.78), rgba(9,15,28,.72));
      }
      .desk-col.right {
        margin-left: 10px;
        margin-right: 10px;
        background:
          radial-gradient(120% 95% at 92% -12%, rgba(155, 102, 255, .2) 0%, rgba(8,12,24,0) 68%),
          linear-gradient(180deg, rgba(14,24,43,.8), rgba(10,16,30,.74));
      }
      .desk-col.left::before,
      .desk-col.center::before,
      .desk-col.right::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        border-radius: 22px;
        filter: blur(8px);
      }
      .desk-col.left::before {
        background:
          radial-gradient(62% 46% at 15% 8%, rgba(62, 214, 255, .12) 0%, rgba(0,0,0,0) 72%),
          linear-gradient(180deg, rgba(255,255,255,.04), transparent 22%, transparent 82%, rgba(255,255,255,.025));
      }
      .desk-col.center::before {
        background:
          radial-gradient(56% 40% at 46% 6%, rgba(90, 156, 255, .14) 0%, rgba(0,0,0,0) 70%),
          radial-gradient(44% 48% at 86% 78%, rgba(151, 98, 255, .13) 0%, rgba(0,0,0,0) 74%),
          linear-gradient(180deg, rgba(255,255,255,.045), transparent 22%, transparent 84%, rgba(255,255,255,.03));
      }
      .desk-col.right::before {
        background:
          radial-gradient(60% 52% at 90% 18%, rgba(168, 103, 255, .2) 0%, rgba(0,0,0,0) 74%),
          radial-gradient(44% 44% at 18% 84%, rgba(98, 170, 255, .12) 0%, rgba(0,0,0,0) 76%),
          linear-gradient(180deg, rgba(255,255,255,.04), transparent 24%, transparent 82%, rgba(255,255,255,.03));
      }
      .desk-col.left .section-head {
        border-bottom: 1px solid rgba(167, 204, 248, .15);
        background: linear-gradient(180deg, rgba(23, 35, 58, .55), rgba(13, 22, 40, .38));
      }
      .desk-col.left .lead-list {
        flex: 1;
        height: auto;
        border-bottom: 0;
      }
      .desk-col.center .suggestion-wrap {
        border-top: 0;
        border-bottom: 0;
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        padding-top: 14px;
        background: linear-gradient(180deg, rgba(18, 30, 51, .46), rgba(12, 21, 38, .38));
      }
      .desk-col.center .cards {
        display: flex;
        flex-wrap: nowrap;
        gap: 10px;
        overflow-x: auto;
        overflow-y: hidden;
        margin-top: 14px;
        padding: 8px 6px 12px;
        align-items: flex-start;
      }
      .desk-col.center .card {
        position: relative;
        border: 1px solid rgba(173, 214, 255, .2);
        background: linear-gradient(180deg, rgba(26,40,66,.78), rgba(18,31,52,.74));
        box-shadow:
          0 24px 34px rgba(0,0,0,.42),
          0 0 24px rgba(80, 178, 255, .12),
          0 0 0 1px rgba(176, 221, 255, .1) inset;
        transform: translateY(-2px);
      }
      .desk-col.center .card::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        border-radius: 24px;
        background:
          radial-gradient(80% 55% at 10% 0%, rgba(110, 210, 255, .13) 0%, rgba(0,0,0,0) 65%),
          radial-gradient(70% 50% at 100% 100%, rgba(153, 102, 255, .12) 0%, rgba(0,0,0,0) 72%);
      }
      .desk-col.center .card .card-zap {
        border-color: rgba(146, 233, 255, .3);
        background: rgba(61, 212, 255, .14);
        box-shadow: 0 0 18px rgba(95, 219, 255, .16);
      }
      .chat-panel {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .chat-panel-head {
        padding: 14px 12px 10px;
        border-bottom: 1px solid rgba(170, 208, 249, .16);
        background: linear-gradient(180deg, rgba(25, 38, 61, .58), rgba(14, 23, 39, .42));
        backdrop-filter: blur(14px);
      }
      .chat-panel-title {
        font-size: 15px;
        font-weight: 600;
        color: #f2f7ff;
      }
      .chat-panel-sub {
        margin-top: 2px;
        font-size: 11px;
        color: rgba(204, 223, 246, .7);
      }
      .chat-panel-foot {
        padding: 10px;
        border-top: 1px solid rgba(170, 208, 249, .14);
        background: linear-gradient(180deg, rgba(18, 29, 47, .62), rgba(12, 22, 38, .54));
        backdrop-filter: blur(16px);
      }
      .desk-col.right .chat-messages {
        background:
          radial-gradient(120% 90% at 50% -18%, rgba(76, 147, 255, .14) 0%, rgba(0,0,0,0) 60%),
          radial-gradient(70% 80% at 90% 100%, rgba(140, 93, 255, .11) 0%, rgba(0,0,0,0) 72%),
          linear-gradient(180deg, rgba(11, 18, 33, .7), rgba(10, 16, 30, .64));
      }
      .chat-panel-foot .draft-stack {
        max-height: 130px;
        overflow-y: auto;
      }
      .chat-panel-foot .composer-row {
        margin-top: 8px;
      }
      .preview-grid.all .shell.mobile { max-width: 390px; }
      .preview-grid.all .shell.tablet { max-width: 540px; }
      .preview-grid.all .shell.desktop { max-width: 700px; }
      .preview-grid.all .shell.desktop .app-desktop { grid-template-columns: 1fr; }
      .preview-grid.all .shell.desktop .desk-col.left,
      .preview-grid.all .shell.desktop .desk-col.center {
        border-right: 0;
        border-bottom: 1px solid rgba(255,255,255,.08);
        margin: 8px;
      }
      .glow { position: absolute; inset: 0; pointer-events: none; }
      .glow .a { position: absolute; top: -64px; left: 34px; width: 180px; height: 180px; border-radius: 999px; background: rgba(34,211,238,.15); filter: blur(42px); }
      .glow .b { position: absolute; top: 190px; right: -28px; width: 210px; height: 210px; border-radius: 999px; background: rgba(217,70,239,.12); filter: blur(50px); }
      .glow .c { position: absolute; bottom: 130px; left: 34px; width: 150px; height: 150px; border-radius: 999px; background: rgba(139,92,246,.12); filter: blur(42px); }
      .glow .d { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(255,255,255,.05), transparent 18%, transparent 80%, rgba(255,255,255,.03)); }
      .app { position: relative; z-index: 3; height: 100%; display: flex; flex-direction: column; }
      .section-head {
        padding: 16px 14px 10px;
        border-bottom: 1px solid rgba(255,255,255,.1);
        background: rgba(0,0,0,.12);
        backdrop-filter: blur(14px);
      }
      .head-row { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .kicker { font-size: 11px; letter-spacing: .35em; text-transform: uppercase; color: rgba(255,255,255,.45); }
      .title { font-size: 24px; font-weight: 600; letter-spacing: -.02em; margin-top: 3px; }
      .spark {
        width: 40px; height: 40px; border-radius: 14px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.1);
        display: flex; align-items: center; justify-content: center;
        font-size: 18px; color: #b9ecff;
        animation: pulse 2.4s infinite ease-in-out;
      }
      @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.08)} }
      .search-wrap { position: relative; margin-bottom: 8px; }
      .search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: rgba(255,255,255,.45); font-size: 14px; }
      .search {
        width: 100%; height: 40px; border-radius: 16px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.08);
        color: #fff; padding: 0 10px 0 34px; outline: none;
      }
      .search::placeholder { color: rgba(255,255,255,.35); }
      .filters { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 2px; }
      .pill {
        border-radius: 999px; border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.05); color: rgba(255,255,255,.75);
        font-size: 12px; height: 32px; padding: 0 12px; cursor: pointer; white-space: nowrap;
      }
      .pill.active { background: #fff; color: #0f172a; border-color: #fff; font-weight: 600; }
      .lead-list {
        padding: 10px 12px; height: 250px; overflow-y: auto; border-bottom: 1px solid rgba(255,255,255,.1);
      }
      .lead-item {
        width: 100%; text-align: left; border-radius: 24px; border: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.045); color: #fff; padding: 11px; margin-bottom: 8px; cursor: pointer;
        animation: rise .2s ease-out;
      }
      .lead-item.active {
        background: rgba(255,255,255,.12);
        border-color: rgba(120,220,255,.3);
        box-shadow: 0 0 0 1px rgba(120,220,255,.18);
      }
      @keyframes rise { from { opacity:.0; transform: translateY(10px);} to {opacity:1; transform:none;} }
      .lead-row { display: flex; gap: 10px; align-items: flex-start; }
      .avatar {
        width: 42px; height: 42px; border-radius: 14px; border: 1px solid rgba(255,255,255,.1);
        background: linear-gradient(135deg, rgba(255,255,255,.2), rgba(255,255,255,.04));
        display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;
      }
      .name-line { display: flex; justify-content: space-between; gap: 8px; }
      .name-line .name { font-size: 15px; font-weight: 600; }
      .name-line .at { font-size: 11px; color: rgba(255,255,255,.45); white-space: nowrap; }
      .preview { margin-top: 3px; font-size: 13px; color: rgba(255,255,255,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .lead-meta { margin-top: 7px; display: flex; align-items: center; gap: 7px; }
      .badge { border-radius: 999px; border: 1px solid transparent; padding: 4px 8px; font-size: 11px; }
      .urg-high { background: rgba(239,68,68,.15); color: #fecaca; border-color: rgba(248,113,113,.3); }
      .urg-medium { background: rgba(245,158,11,.15); color: #fde68a; border-color: rgba(251,191,36,.25); }
      .urg-low { background: rgba(16,185,129,.15); color: #a7f3d0; border-color: rgba(52,211,153,.25); }
      .stage {
        border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 4px 8px; font-size: 11px;
        background: linear-gradient(90deg, rgba(34,211,238,.2), rgba(59,130,246,.2));
        color: #e0f2fe;
      }
      .stage.price { background: linear-gradient(90deg, rgba(232,121,249,.2), rgba(139,92,246,.2)); color: #f5d0fe; }
      .stage.deposit { background: linear-gradient(90deg, rgba(253,224,71,.2), rgba(251,146,60,.2)); color: #fef3c7; }
      .unread {
        margin-left: auto; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 999px;
        background: #67e8f9; color: #0f172a; font-size: 11px; font-weight: 700;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .suggestion-wrap {
        border-bottom: 1px solid rgba(255,255,255,.1);
        border-top: 1px solid rgba(255,255,255,.08);
        background: rgba(0,0,0,.12);
        backdrop-filter: blur(14px);
        padding: 10px 10px 9px;
      }
      .chat-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
      .chat-head .n { font-size: 14px; font-weight: 600; }
      .chat-head .sub { margin-top: 2px; font-size: 11px; color: rgba(255,255,255,.45); }
      .icon-btn {
        width: 36px; height: 36px; border-radius: 14px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.08);
        color: #baf2ff; cursor: pointer;
      }
      .cards { display: flex; gap: 10px; overflow-x: auto; }
      .card {
        min-width: 244px; max-width: 244px;
        border-radius: 24px; border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.06); backdrop-filter: blur(16px);
        box-shadow: 0 16px 30px rgba(0,0,0,.35);
        padding: 11px;
        animation: rise .22s ease-out;
      }
      .card-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
      .card-title { font-size: 14px; font-weight: 600; }
      .card-tag { font-size: 11px; color: rgba(186,230,253,.9); margin-top: 2px; }
      .card-zap {
        width: 32px; height: 32px; border-radius: 14px;
        border: 1px solid rgba(103,232,249,.2);
        background: rgba(34,211,238,.1);
        display: flex; align-items: center; justify-content: center;
        color: #cffafe;
      }
      .snips { min-height: 104px; display: grid; gap: 7px; }
      .snip {
        border-radius: 14px; border: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.08);
        padding: 8px 9px; font-size: 12px; color: rgba(255,255,255,.8); line-height: 1.4;
      }
      .card-actions { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .btn {
        height: 36px; border-radius: 14px; cursor: pointer; font-size: 12px;
        border: 1px solid rgba(255,255,255,.12);
      }
      .btn.insert { background: #fff; color: #0f172a; font-weight: 600; border-color: #fff; }
      .btn.send { background: rgba(255,255,255,.06); color: #fff; }
      .chat-messages {
        flex: 1; overflow-y: auto; padding: 12px; display: grid; gap: 10px;
      }
      .mobile-chat-stage {
        position: relative;
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .mobile-chat-messages {
        position: relative;
        overflow: hidden;
        padding: 0;
      }
      .chat-scroll-list {
        height: 100%;
        overflow-y: auto;
        padding: 12px;
        display: grid;
        gap: 10px;
      }
      .mobile-ai-drawer {
        position: absolute;
        top: 8px;
        right: 0;
        bottom: 8px;
        width: 318px;
        border-radius: 24px 0 0 24px;
        border: 1px solid rgba(170, 212, 255, .28);
        border-right: 0;
        background:
          radial-gradient(120% 95% at 86% 16%, rgba(153, 102, 255, .22) 0%, rgba(0,0,0,0) 72%),
          radial-gradient(95% 85% at 18% 0%, rgba(74, 198, 255, .18) 0%, rgba(0,0,0,0) 70%),
          linear-gradient(180deg, rgba(16,28,48,.84), rgba(10,19,35,.9));
        box-shadow:
          -20px 24px 46px rgba(0,0,0,.48),
          0 0 0 1px rgba(169,214,255,.1) inset;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 9;
      }
      .mobile-ai-dragzone {
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        touch-action: none;
        cursor: grab;
      }
      .mobile-ai-dragzone span {
        width: 44px;
        height: 4px;
        border-radius: 999px;
        background: rgba(196, 230, 255, .34);
      }
      .mobile-ai-head {
        padding: 0 10px 6px;
        border-bottom: 1px solid rgba(176, 215, 255, .16);
      }
      .mobile-ai-cards {
        flex: 1;
        min-height: 0;
        padding: 10px;
        display: flex;
        gap: 10px;
        overflow-x: auto;
        overflow-y: hidden;
      }
      .mobile-ai-handle {
        position: absolute;
        left: -28px;
        top: 50%;
        transform: translateY(-50%);
        width: 28px;
        height: 88px;
        border-radius: 16px 0 0 16px;
        border: 1px solid rgba(172, 214, 255, .34);
        border-right: 0;
        background: linear-gradient(180deg, rgba(24,39,66,.92), rgba(15,27,49,.9));
        color: rgba(209, 234, 255, .88);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 0;
        touch-action: none;
        cursor: grab;
        box-shadow: -10px 12px 24px rgba(0,0,0,.35);
      }
      .mobile-ai-handle-dot {
        width: 4px;
        height: 24px;
        border-radius: 999px;
        background: linear-gradient(180deg, rgba(93, 220, 255, .95), rgba(116, 128, 255, .9));
      }
      .mobile-ai-handle-label {
        font-size: 10px;
        letter-spacing: .08em;
        writing-mode: vertical-rl;
        transform: rotate(180deg);
      }
      .msg-row { display: flex; }
      .msg-row.client { justify-content: flex-start; }
      .msg-row.brand { justify-content: flex-end; }
      .bubble {
        max-width: 82%; border-radius: 1.6rem; padding: 11px 14px;
        border: 1px solid rgba(255,255,255,.08); box-shadow: 0 10px 18px rgba(0,0,0,.32);
        animation: bubbleIn .2s ease-out;
      }
      .bubble.client { background: rgba(255,255,255,.07); color: #fff; }
      .bubble.brand {
        border-color: rgba(207,250,254,.55);
        background: linear-gradient(135deg, #67e8f9 0%, #a5f3fc 100%);
        color: #0f172a;
      }
      .bubble .text { font-size: 14px; line-height: 1.45; }
      .bubble .meta {
        margin-top: 6px; font-size: 11px; display: flex; gap: 4px;
      }
      .bubble.client .meta { color: rgba(255,255,255,.45); }
      .bubble.brand .meta { color: rgba(15,23,42,.68); justify-content: flex-end; }
      .composer {
        padding: 10px; border-top: 1px solid rgba(255,255,255,.1);
        background: rgba(0,0,0,.2); backdrop-filter: blur(18px);
      }
      .stats { margin-bottom: 8px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
      .stat {
        border-radius: 14px; border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.05); padding: 8px;
      }
      .stat .k { font-size: 10px; letter-spacing: .25em; text-transform: uppercase; color: rgba(255,255,255,.35); }
      .stat .v { margin-top: 5px; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .draft-stack { margin-bottom: 9px; display: grid; gap: 6px; }
      .draft-bubble {
        margin-left: auto; max-width: 82%; border-radius: 1.4rem;
        border: 1px solid rgba(207,250,254,.5);
        background: linear-gradient(135deg, #67e8f9 0%, #a5f3fc 100%);
        color: #0f172a; box-shadow: 0 10px 18px rgba(0,0,0,.28);
        padding: 8px 12px; font-size: 13px; line-height: 1.35;
      }
      .composer-row { display: flex; align-items: flex-end; gap: 8px; }
      .mini-btn {
        width: 44px; height: 44px; border-radius: 14px;
        border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.05); color: #fff; cursor: pointer; font-size: 16px;
      }
      .composer-pill {
        flex: 1; min-height: 44px; border-radius: 1.6rem;
        border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.07);
        padding: 11px 12px; font-size: 13px; color: rgba(255,255,255,.42);
      }
      .send-fab {
        width: 44px; height: 44px; border-radius: 14px;
        border: 1px solid rgba(207,250,254,.35);
        background: #67e8f9; color: #0f172a; cursor: pointer; font-size: 16px;
      }
      .hint {
        margin-top: 7px; display: flex; justify-content: space-between; gap: 8px;
        font-size: 11px; color: rgba(255,255,255,.36); padding: 0 2px;
      }
      .lab-link {
        position: fixed; top: 8px; left: 8px; z-index: 12;
        color: #d9e7fb; text-decoration: none; font-size: 12px;
        background: rgba(7,12,22,.72); border: 1px solid rgba(131,153,187,.45);
        border-radius: 999px; padding: 7px 10px;
      }
      @media (max-width: 768px) {
        .mode-switch {
          left: auto;
          right: 8px;
          transform: none;
          max-width: calc(100vw - 72px);
          overflow-x: auto;
          white-space: nowrap;
        }
        .mode-switch button {
          padding: 8px 10px;
          font-size: 11px;
        }
        .page { padding: 56px 0 0; }
        .preview-grid { width: 100%; }
        .device-label { display: none; }
        .shell {
          border-radius: 0; max-width: 100%; height: 100dvh; max-height: 100dvh; border: none;
        }
      }
    </style>
  </head>
  <body>
    <a class="lab-link" href="/admin/whatsapp-intelligence${navSuffix}">← Back</a>
    <div id="root"></div>
    <script type="text/babel">
      const MODE = ${JSON.stringify(mode)};
      const LEAD_ID = ${JSON.stringify(leadId)};
      const MAX_LEN = 120;
      const LIVE_MODE = String(MODE) !== "mock";
      const MOBILE_DRAWER_WIDTH = 318;
      const MOBILE_DRAWER_PEEK = 34;
      const MOBILE_DRAWER_CLOSED = MOBILE_DRAWER_WIDTH - MOBILE_DRAWER_PEEK;

      function clampText(value) {
        const raw = String(value || "").replace(/\\s+/g, " ").trim();
        if (!raw) return "";
        if (raw.length <= MAX_LEN) return raw;
        return raw.slice(0, MAX_LEN - 1).trimEnd() + "…";
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function initials(name) {
        const parts = String(name || "").trim().split(/\\s+/).filter(Boolean);
        if (!parts.length) return "WA";
        return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("");
      }

      function stageForUi(raw) {
        const value = String(raw || "").toUpperCase();
        if (value.includes("DEPOSIT")) return "DEPOSIT_PENDING";
        if (value.includes("PRICE")) return "PRICE_SENT";
        return "QUALIFICATION";
      }

      function urgencyForUi(raw) {
        const value = String(raw || "").toLowerCase();
        if (value === "high") return "High";
        if (value === "low") return "Low";
        return "Medium";
      }

      function formatTime(raw) {
        const d = new Date(String(raw || ""));
        if (Number.isNaN(d.getTime())) return "--:--";
        return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      }

      function relativeTime(raw) {
        const d = new Date(String(raw || ""));
        if (Number.isNaN(d.getTime())) return "Now";
        const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
        if (min < 1) return "Now";
        if (min < 60) return min + " min";
        const h = Math.floor(min / 60);
        if (h < 24) return h + " h";
        return Math.floor(h / 24) + " j";
      }

      function splitToBubbles(input) {
        const raw = String(input || "").replace(/\\s+/g, " ").trim();
        if (!raw) return [];
        const chunks = raw.split(/\\n\\s*\\n+/).map((x) => x.trim()).filter(Boolean);
        const source = chunks.length > 1 ? chunks : [raw];
        const out = [];
        for (const chunk of source) {
          if (chunk.length <= MAX_LEN) {
            out.push(chunk);
            continue;
          }
          const words = chunk.split(/\\s+/).filter(Boolean);
          let cursor = "";
          for (const word of words) {
            const next = cursor ? cursor + " " + word : word;
            if (next.length > MAX_LEN && cursor) {
              out.push(cursor);
              cursor = word;
            } else {
              cursor = next;
            }
          }
          if (cursor) out.push(cursor);
        }
        return out.map((x) => clampText(x)).filter(Boolean).slice(0, 4);
      }

      function ensureBubbleSet(messages) {
        const list = Array.isArray(messages) ? messages : [];
        const normalized = list.flatMap((text) => splitToBubbles(text)).slice(0, 4);
        if (normalized.length >= 2) return normalized;
        if (normalized.length === 1) {
          const split = splitToBubbles(normalized[0]);
          if (split.length >= 2) return split.slice(0, 4);
        }
        return ["Bonjour, merci pour votre message.", "Je vous partage une proposition adaptée dans un instant."];
      }

      function withNav(path) {
        const current = new URL(window.location.href);
        const url = new URL(path, window.location.origin);
        ["host", "shop", "embedded"].forEach((key) => {
          const value = current.searchParams.get(key);
          if (value && !url.searchParams.get(key)) url.searchParams.set(key, value);
        });
        return url.pathname + (url.search || "");
      }

      async function fetchJson(path, options) {
        const response = await fetch(withNav(path), options);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || ("http_" + response.status));
        }
        if (response.status === 204) return null;
        return response.json();
      }

      async function fetchJsonOptional(path) {
        const response = await fetch(withNav(path));
        if (response.status === 204) return null;
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || ("http_" + response.status));
        }
        return response.json();
      }

      const urgencyClass = { High: "urg-high", Medium: "urg-medium", Low: "urg-low" };
      const stageClass = { QUALIFICATION: "", PRICE_SENT: "price", DEPOSIT_PENDING: "deposit" };

      const leadsSeed = [
        {
          id: LEAD_ID ? 999 : 1,
          name: "Sara M.",
          stage: "QUALIFICATION",
          urgency: "High",
          unread: 2,
          lastAt: "Now",
          preview: "Bonjour, j’ai besoin d’une tenue pour un mariage...",
          avatar: "SM",
          suggestions: [
            { id: 11, title: "Qualifier l’événement", tag: "Priorité", messages: ["Bonjour Sara, merci pour votre message.", "Puis-je connaître la date de l’événement ?", "Et le pays de livraison pour vérifier les délais ?"] },
            { id: 12, title: "Proposer appel vidéo", tag: "Rapide", messages: ["Je peux aussi vous montrer plusieurs options.", "Nous pouvons organiser un appel vidéo rapide.", "Je vous présenterai les modèles disponibles."] },
            { id: 13, title: "Qualifier budget", tag: "Strategic", messages: ["Avant de vous partager une sélection précise,", "avez-vous une idée du budget souhaité ?"] }
          ],
          messages: [
            { id: 101, from: "client", text: "Bonjour, j’ai besoin d’une tenue pour un mariage en juin.", time: "10:12" },
            { id: 102, from: "brand", text: "Bonjour Sara, merci pour votre message. Je serais ravie de vous orienter.", time: "10:13", status: "read" },
            { id: 103, from: "client", text: "Je suis à Paris et j’aurais besoin d’une livraison avant le 18 juin.", time: "10:14" }
          ]
        },
        {
          id: 2,
          name: "Lina B.",
          stage: "PRICE_SENT",
          urgency: "Medium",
          unread: 0,
          lastAt: "4 min",
          preview: "Merci, pouvez-vous m’envoyer d’autres options en bleu ?",
          avatar: "LB",
          suggestions: [
            { id: 21, title: "Envoyer options", tag: "Send", messages: ["Bien sûr.", "Je vous partage une sélection raffinée en bleu.", "Je vous envoie cela dans un instant."] },
            { id: 22, title: "Confirmer délai", tag: "Info", messages: ["Selon le modèle retenu,", "nous pourrons confirmer immédiatement", "le délai de production et d’expédition."] }
          ],
          messages: [
            { id: 201, from: "brand", text: "Cette pièce est disponible avec ajustements, au prix de 4 800€.", time: "09:42", status: "read" },
            { id: 202, from: "client", text: "Merci, pouvez-vous m’envoyer d’autres options en bleu ?", time: "09:44" }
          ]
        },
        {
          id: 3,
          name: "Nadia K.",
          stage: "DEPOSIT_PENDING",
          urgency: "Low",
          unread: 1,
          lastAt: "18 min",
          preview: "Je peux faire le virement aujourd’hui.",
          avatar: "NK",
          suggestions: [
            { id: 31, title: "Coordonnées paiement", tag: "Hot", messages: ["Parfait.", "Je peux vous partager immédiatement", "les coordonnées de paiement.", "Cela nous permettra de lancer la production."] },
            { id: 32, title: "Confirmer lancement", tag: "Next", messages: ["Dès réception de l’acompte,", "nous pourrons confirmer", "le lancement de votre pièce."] }
          ],
          messages: [{ id: 301, from: "client", text: "Je peux faire le virement aujourd’hui.", time: "08:11" }]
        }
      ];

      function mapLeadFromApi(lead) {
        const stageRaw = String((lead && lead.stage) || "QUALIFICATION");
        return {
          id: String((lead && lead.id) || ""),
          name: String((lead && lead.client) || "Client"),
          stage: stageForUi(stageRaw),
          stageLabel: stageRaw,
          urgency: urgencyForUi(lead && lead.urgency),
          unread: 0,
          lastAt: relativeTime((lead && lead.last_activity_at) || (lead && lead.created_at)),
          preview: clampText((lead && lead.last_message_snippet) || "Conversation WhatsApp"),
          avatar: initials(lead && lead.client),
          suggestions: [],
          messages: []
        };
      }

      function mapMessagesFromApi(items) {
        return (Array.isArray(items) ? items : []).map((item, index) => {
          const isBrand = String((item && item.direction) || "").toUpperCase() === "OUT";
          return {
            id: String((item && item.id) || ("msg-" + index)),
            from: isBrand ? "brand" : "client",
            text: clampText((item && item.text) || ""),
            time: formatTime(item && item.created_at),
            status: isBrand ? "sent" : undefined
          };
        });
      }

      function fallbackSuggestionsFromMessages(messages) {
        const clientMessages = (Array.isArray(messages) ? messages : []).filter((msg) => msg && msg.from === "client");
        const latest = clientMessages.length ? clientMessages[clientMessages.length - 1].text : "";
        return [
          {
            id: "fallback-1",
            title: "Clarifier le besoin",
            tag: "FALLBACK",
            messages: ensureBubbleSet([
              "Merci pour votre message.",
              latest ? "J'ai bien noté: " + latest : "Pouvez-vous préciser la date de l'événement ?",
              "Je prépare les options les plus adaptées."
            ])
          },
          {
            id: "fallback-2",
            title: "Date et destination",
            tag: "FALLBACK",
            messages: ensureBubbleSet([
              "Pouvez-vous partager la date exacte de l'événement ?",
              "Et le pays de livraison pour confirmer les délais ?"
            ])
          }
        ];
      }

      function mapAiSuggestions(runPayload, provider) {
        const list = runPayload && Array.isArray(runPayload.suggestions) ? runPayload.suggestions : [];
        return list.slice(0, 3).map((entry, index) => {
          const rawMessages = Array.isArray(entry && entry.messages) && entry.messages.length
            ? entry.messages
            : splitToBubbles((entry && (entry.reply || entry.text)) || "");
          return {
            id: String((entry && entry.id) || ("ai-" + index)),
            title: clampText((entry && entry.title) || (entry && entry.goal) || ("Suggestion " + (index + 1))),
            tag: String(provider || "claude").toUpperCase(),
            messages: ensureBubbleSet(rawMessages)
          };
        });
      }

      function App() {
        const [leads, setLeads] = React.useState(leadsSeed);
        const [selectedLeadId, setSelectedLeadId] = React.useState(String(leadsSeed[0].id));
        const [draftMessages, setDraftMessages] = React.useState([]);
        const [filter, setFilter] = React.useState("All");
        const [query, setQuery] = React.useState("");
        const [sending, setSending] = React.useState(false);
        const [loadingLeads, setLoadingLeads] = React.useState(false);
        const [loadingMessages, setLoadingMessages] = React.useState(false);
        const [loadingSuggestions, setLoadingSuggestions] = React.useState(false);
        const [aiProvider, setAiProvider] = React.useState("claude");
        const [errorText, setErrorText] = React.useState("");
        const [mobileDrawerOffset, setMobileDrawerOffset] = React.useState(MOBILE_DRAWER_CLOSED);
        const [mobileDrawerDragging, setMobileDrawerDragging] = React.useState(false);
        const mobileDrawerOffsetRef = React.useRef(MOBILE_DRAWER_CLOSED);
        const mobileDrawerDragRef = React.useRef({
          active: false,
          moved: false,
          startX: 0,
          startOffset: MOBILE_DRAWER_CLOSED
        });
        const [viewMode, setViewMode] = React.useState("all");

        const deviceOrder = React.useMemo(() => ["mobile", "tablet", "desktop"], []);
        const visibleDevices = viewMode === "all" ? deviceOrder : [viewMode];

        function deviceLabel(device) {
          if (device === "mobile") return "Mobile";
          if (device === "tablet") return "Tablet / iPad";
          return "Desktop";
        }

        function titleForDevice(device) {
          if (device === "mobile") return "Mobile Inbox";
          if (device === "tablet") return "Tablet Workspace";
          return "Operator Workspace";
        }

        function clampDrawerOffset(value) {
          return Math.max(0, Math.min(MOBILE_DRAWER_CLOSED, Number(value) || 0));
        }

        function onMobileDrawerPointerDown(event) {
          const x = Number(event && event.clientX) || 0;
          mobileDrawerDragRef.current = {
            active: true,
            moved: false,
            startX: x,
            startOffset: mobileDrawerOffsetRef.current
          };
          setMobileDrawerDragging(true);
          if (event.currentTarget && event.currentTarget.setPointerCapture) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }

        function onMobileDrawerPointerMove(event) {
          if (!mobileDrawerDragRef.current.active) return;
          const x = Number(event && event.clientX) || 0;
          const delta = x - mobileDrawerDragRef.current.startX;
          if (Math.abs(delta) > 4) mobileDrawerDragRef.current.moved = true;
          setMobileDrawerOffset(clampDrawerOffset(mobileDrawerDragRef.current.startOffset + delta));
        }

        function onMobileDrawerPointerEnd() {
          if (!mobileDrawerDragRef.current.active) return;
          mobileDrawerDragRef.current.active = false;
          setMobileDrawerDragging(false);
          const current = mobileDrawerOffsetRef.current;
          const moved = mobileDrawerDragRef.current.moved;
          if (!moved) {
            setMobileDrawerOffset(current > MOBILE_DRAWER_CLOSED * 0.5 ? 0 : MOBILE_DRAWER_CLOSED);
            return;
          }
          setMobileDrawerOffset(current < MOBILE_DRAWER_CLOSED * 0.55 ? 0 : MOBILE_DRAWER_CLOSED);
        }

        const selectedLead = React.useMemo(
          () => leads.find((lead) => String(lead.id) === String(selectedLeadId)) || leads[0] || null,
          [leads, selectedLeadId]
        );

        const filteredLeads = React.useMemo(() => {
          return leads.filter((lead) => {
            const matchesFilter = filter === "All" ? true : lead.urgency === filter;
            const haystack = (lead.name + " " + lead.preview + " " + (lead.stageLabel || lead.stage)).toLowerCase();
            return matchesFilter && haystack.includes(String(query || "").toLowerCase());
          });
        }, [leads, filter, query]);

        const patchLead = React.useCallback((leadId, patch) => {
          setLeads((prev) => prev.map((lead) => (String(lead.id) === String(leadId) ? { ...lead, ...patch } : lead)));
        }, []);

        const loadLeads = React.useCallback(async () => {
          if (!LIVE_MODE) return;
          setLoadingLeads(true);
          setErrorText("");
          try {
            const payload = await fetchJson("/api/whatsapp/leads?range=30");
            const mapped = (Array.isArray(payload && payload.items) ? payload.items : [])
              .map(mapLeadFromApi)
              .filter((lead) => lead.id);
            if (!mapped.length) return;
            setLeads((prev) => {
              const prevMap = new Map((Array.isArray(prev) ? prev : []).map((lead) => [String(lead.id), lead]));
              return mapped.map((lead) => {
                const old = prevMap.get(String(lead.id));
                return old
                  ? { ...lead, messages: Array.isArray(old.messages) ? old.messages : [], suggestions: Array.isArray(old.suggestions) ? old.suggestions : [] }
                  : lead;
              });
            });
            setSelectedLeadId((current) => {
              if (LEAD_ID && mapped.some((lead) => String(lead.id) === LEAD_ID)) return LEAD_ID;
              if (current && mapped.some((lead) => String(lead.id) === String(current))) return current;
              return String(mapped[0].id);
            });
          } catch (error) {
            setErrorText("Impossible de charger les conversations WhatsApp.");
            console.error("[mobile-lab] load leads failed", error);
          } finally {
            setLoadingLeads(false);
          }
        }, []);

        const loadMessages = React.useCallback(async (leadId) => {
          if (!LIVE_MODE || !leadId) return;
          setLoadingMessages(true);
          try {
            const payload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/messages?limit=80");
            const messages = mapMessagesFromApi(payload && payload.items);
            const last = messages.length ? messages[messages.length - 1] : null;
            patchLead(leadId, {
              messages,
              preview: last ? clampText(last.text) : "Conversation WhatsApp",
              lastAt: "Now"
            });
          } catch (error) {
            setErrorText("Impossible de charger les messages.");
            console.error("[mobile-lab] load messages failed", { leadId, error });
          } finally {
            setLoadingMessages(false);
          }
        }, [patchLead]);

        const loadSuggestions = React.useCallback(async (leadId, forceRegenerate) => {
          if (!leadId) return;
          if (!LIVE_MODE) return;
          setLoadingSuggestions(true);
          const applySuggestions = (cards) => {
            setLeads((prev) =>
              prev.map((lead) => {
                if (String(lead.id) !== String(leadId)) return lead;
                const fallback = fallbackSuggestionsFromMessages(Array.isArray(lead.messages) ? lead.messages : []);
                return { ...lead, suggestions: Array.isArray(cards) && cards.length ? cards : fallback };
              })
            );
          };
          try {
            let runPayload = null;
            if (!forceRegenerate) {
              runPayload = await fetchJsonOptional("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-latest");
            }
            const hasSuggestions = Boolean(
              runPayload &&
                runPayload.status === "success" &&
                Array.isArray(runPayload.suggestions) &&
                runPayload.suggestions.length
            );
            if (!hasSuggestions) {
              runPayload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-regenerate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider: aiProvider })
              });
            }
            const mapped = mapAiSuggestions(runPayload, aiProvider);
            applySuggestions(mapped);
          } catch (error) {
            applySuggestions([]);
            console.error("[mobile-lab] load suggestions failed", { leadId, error });
          } finally {
            setLoadingSuggestions(false);
          }
        }, [aiProvider]);

        React.useEffect(() => {
          if (!LIVE_MODE) return;
          void loadLeads();
        }, [loadLeads]);

        React.useEffect(() => {
          if (!selectedLeadId) return;
          if (!LIVE_MODE) return;
          void loadMessages(selectedLeadId);
          void loadSuggestions(selectedLeadId, false);
        }, [selectedLeadId, loadMessages, loadSuggestions]);

        React.useEffect(() => {
          mobileDrawerOffsetRef.current = mobileDrawerOffset;
        }, [mobileDrawerOffset]);

        function insertSuggestion(messages) {
          setDraftMessages(ensureBubbleSet(messages));
        }

        async function sendMessages() {
          if (!draftMessages.length || sending || !selectedLead) return;
          setSending(true);
          try {
            const payload = ensureBubbleSet(draftMessages);
            if (!LIVE_MODE) {
              patchLead(selectedLead.id, {
                preview: payload[payload.length - 1] || selectedLead.preview,
                lastAt: "Now",
                messages: (selectedLead.messages || []).concat(
                  payload.map((msg, i) => ({
                    id: "draft-" + Date.now() + "-" + i,
                    from: "brand",
                    text: clampText(msg),
                    time: "Now",
                    status: "sent"
                  }))
                )
              });
              setDraftMessages([]);
              return;
            }
            for (let i = 0; i < payload.length; i += 1) {
              await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(selectedLead.id) + "/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  direction: "OUT",
                  text: payload[i],
                  provider: "system",
                  message_type: "text"
                })
              });
              await sleep(80);
            }
            setDraftMessages([]);
            await Promise.all([loadMessages(selectedLead.id), loadLeads()]);
          } catch (error) {
            setErrorText("Envoi impossible via WhatsApp API.");
            console.error("[mobile-lab] send failed", error);
          } finally {
            setSending(false);
          }
        }

        return (
          <div className="page">
            <div className="mode-switch">
              {[{ id: "all", label: "All" }, { id: "mobile", label: "Mobile" }, { id: "tablet", label: "Tablet" }, { id: "desktop", label: "Desktop" }].map((item) => (
                <button
                  key={item.id}
                  className={viewMode === item.id ? "active" : ""}
                  onClick={() => setViewMode(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className={"preview-grid " + (viewMode === "all" ? "all" : "single")}>
              {visibleDevices.map((device) => (
                <div key={device} className="device-wrap">
                  {viewMode === "all" ? <div className="device-label">{deviceLabel(device)}</div> : null}
                  <div className={"shell " + device}>
                    <div className="glow"><div className="a" /><div className="b" /><div className="c" /><div className="d" /></div>
                    {device === "desktop" ? (
                      <div className="app-desktop">
                        <div className="desk-col left">
                          <div className="section-head">
                            <div className="head-row">
                              <div>
                                <div className="kicker">WhatsApp Intelligence · Desktop</div>
                                <div className="title">{titleForDevice(device)}</div>
                              </div>
                              <div className="spark">✦</div>
                            </div>

                            <div className="search-wrap">
                              <span className="search-icon">⌕</span>
                              <input value={query} onChange={(e) => setQuery(e.target.value)} className="search" placeholder="Rechercher une conversation" />
                            </div>

                            <div className="filters">
                              {["All", "High", "Medium", "Low"].map((item) => (
                                <button key={item} onClick={() => setFilter(item)} className={"pill " + (filter === item ? "active" : "")}>
                                  {item === "All" ? "☰ " : ""}{item}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="lead-list">
                            {loadingLeads ? <div className="preview">Chargement conversations...</div> : null}
                            {filteredLeads.map((lead) => {
                              const active = String(lead.id) === String(selectedLeadId);
                              return (
                                <button key={lead.id} onClick={() => setSelectedLeadId(String(lead.id))} className={"lead-item " + (active ? "active" : "")}>
                                  <div className="lead-row">
                                    <div className="avatar">{lead.avatar}</div>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                      <div className="name-line">
                                        <span className="name">{lead.name}</span>
                                        <span className="at">{lead.lastAt}</span>
                                      </div>
                                      <div className="preview">{lead.preview}</div>
                                      <div className="lead-meta">
                                        <span className={"badge " + urgencyClass[lead.urgency]}>{lead.urgency}</span>
                                        <span className={"stage " + stageClass[lead.stage]}>{lead.stageLabel || lead.stage}</span>
                                        {lead.unread > 0 ? <span className="unread">{lead.unread}</span> : null}
                                      </div>
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="desk-col center">
                          <div className="suggestion-wrap">
                            <div className="chat-head">
                              <div>
                                <div className="n">{selectedLead ? selectedLead.name : "Lead"}</div>
                                <div className="sub">WhatsApp API · Suggestions {String(aiProvider).toUpperCase()} · {String(MODE).toUpperCase()}</div>
                              </div>
                              <button
                                className="icon-btn"
                                onClick={() => {
                                  if (!selectedLead) return;
                                  void loadSuggestions(selectedLead.id, true);
                                }}
                              >
                                {loadingSuggestions ? "…" : "✦"}
                              </button>
                            </div>
                            <div className="filters" style={{ marginBottom: "8px" }}>
                              {["claude", "gpt"].map((provider) => (
                                <button
                                  key={provider}
                                  className={"pill " + (aiProvider === provider ? "active" : "")}
                                  onClick={() => setAiProvider(provider)}
                                >
                                  {provider.toUpperCase()}
                                </button>
                              ))}
                            </div>
                            <div className="cards">
                              {selectedLead && Array.isArray(selectedLead.suggestions) && selectedLead.suggestions.length
                                ? selectedLead.suggestions.map((card) => (
                                  <div key={card.id} className="card">
                                    <div className="card-top">
                                      <div>
                                        <div className="card-title">{card.title}</div>
                                        <div className="card-tag">{card.tag}</div>
                                      </div>
                                      <div className="card-zap">⚡</div>
                                    </div>
                                    <div className="snips">
                                      {ensureBubbleSet(card.messages).map((msg, i) => <div key={i} className="snip">{clampText(msg)}</div>)}
                                    </div>
                                    <div className="card-actions">
                                      <button className="btn insert" disabled={sending} onClick={() => insertSuggestion(card.messages)}>Insérer</button>
                                      <button className="btn send" disabled={sending} onClick={() => { insertSuggestion(card.messages); setTimeout(() => { void sendMessages(); }, 80); }}>Envoyer</button>
                                    </div>
                                  </div>
                                ))
                                : <div className="preview">{loadingSuggestions ? "Génération suggestions..." : "Aucune suggestion disponible"}</div>}
                            </div>
                          </div>
                        </div>

                        <div className="desk-col right">
                          <div className="chat-panel">
                            <div className="chat-panel-head">
                              <div className="chat-panel-title">{selectedLead ? selectedLead.name : "Thread WhatsApp"}</div>
                              <div className="chat-panel-sub">{selectedLead ? (selectedLead.stageLabel || selectedLead.stage) : "Conversation"} · Live thread</div>
                            </div>

                            <div className="chat-messages">
                              {errorText ? <div className="preview">{errorText}</div> : null}
                              {loadingMessages ? <div className="preview">Chargement messages...</div> : null}
                              {selectedLead && Array.isArray(selectedLead.messages) && selectedLead.messages.map((message) => {
                                const own = message.from === "brand";
                                return (
                                  <div key={message.id} className={"msg-row " + (own ? "brand" : "client")}>
                                    <div className={"bubble " + (own ? "brand" : "client")}>
                                      <div className="text">{clampText(message.text)}</div>
                                      <div className="meta">
                                        <span>{message.time}</span>
                                        {own ? <span>{message.status === "read" ? "✓✓" : "✓"}</span> : null}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            <div className="chat-panel-foot">
                              <div className="stats">
                                <div className="stat"><div className="k">AI</div><div className="v">{selectedLead ? selectedLead.suggestions.length : 0} cartes</div></div>
                                <div className="stat"><div className="k">Stage</div><div className="v">{selectedLead ? (selectedLead.stageLabel || selectedLead.stage) : "-"}</div></div>
                                <div className="stat"><div className="k">Provider</div><div className="v">{String(aiProvider).toUpperCase()}</div></div>
                              </div>

                              {draftMessages.length ? (
                                <div className="draft-stack">
                                  {draftMessages.map((msg, i) => <div key={i} className="draft-bubble">{clampText(msg)}</div>)}
                                </div>
                              ) : null}

                              <div className="composer-row">
                                <button className="mini-btn" onClick={() => setDraftMessages([])}>＋</button>
                                <div className="composer-pill">
                                  {draftMessages.length ? String(draftMessages.length) + " messages prêts à être envoyés" : "Sélectionner une suggestion AI..."}
                                </div>
                                <button className="send-fab" disabled={sending} onClick={() => { void sendMessages(); }}>➤</button>
                              </div>

                              <div className="hint">
                                <span>✦ Suggestions 2–4 messages · ≤120 caractères</span>
                                <span>{LIVE_MODE ? "Live API" : "Mock mode"}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="app">
                        <div className="section-head">
                          <div className="head-row">
                            <div>
                              <div className="kicker">WhatsApp Intelligence · {deviceLabel(device)}</div>
                              <div className="title">{titleForDevice(device)}</div>
                            </div>
                            <div className="spark">✦</div>
                          </div>

                          <div className="search-wrap">
                            <span className="search-icon">⌕</span>
                            <input value={query} onChange={(e) => setQuery(e.target.value)} className="search" placeholder="Rechercher une conversation" />
                          </div>

                          <div className="filters">
                            {["All", "High", "Medium", "Low"].map((item) => (
                              <button key={item} onClick={() => setFilter(item)} className={"pill " + (filter === item ? "active" : "")}>
                                {item === "All" ? "☰ " : ""}{item}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="lead-list">
                          {loadingLeads ? <div className="preview">Chargement conversations...</div> : null}
                          {filteredLeads.map((lead) => {
                            const active = String(lead.id) === String(selectedLeadId);
                            return (
                              <button key={lead.id} onClick={() => setSelectedLeadId(String(lead.id))} className={"lead-item " + (active ? "active" : "")}>
                                <div className="lead-row">
                                  <div className="avatar">{lead.avatar}</div>
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div className="name-line">
                                      <span className="name">{lead.name}</span>
                                      <span className="at">{lead.lastAt}</span>
                                    </div>
                                    <div className="preview">{lead.preview}</div>
                                    <div className="lead-meta">
                                      <span className={"badge " + urgencyClass[lead.urgency]}>{lead.urgency}</span>
                                      <span className={"stage " + stageClass[lead.stage]}>{lead.stageLabel || lead.stage}</span>
                                      {lead.unread > 0 ? <span className="unread">{lead.unread}</span> : null}
                                    </div>
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        {device === "mobile" ? (
                          <div className="mobile-chat-stage">
                            <div className="chat-messages mobile-chat-messages">
                              <div className="chat-scroll-list">
                                {errorText ? <div className="preview">{errorText}</div> : null}
                                {loadingMessages ? <div className="preview">Chargement messages...</div> : null}
                                {selectedLead && Array.isArray(selectedLead.messages) && selectedLead.messages.map((message) => {
                                  const own = message.from === "brand";
                                  return (
                                    <div key={message.id} className={"msg-row " + (own ? "brand" : "client")}>
                                      <div className={"bubble " + (own ? "brand" : "client")}>
                                        <div className="text">{clampText(message.text)}</div>
                                        <div className="meta">
                                          <span>{message.time}</span>
                                          {own ? <span>{message.status === "read" ? "✓✓" : "✓"}</span> : null}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              <div
                                className="mobile-ai-drawer"
                                style={{
                                  transform: "translateX(" + mobileDrawerOffset + "px)",
                                  transition: mobileDrawerDragging ? "none" : "transform .32s cubic-bezier(.22,.74,.22,1)"
                                }}
                              >
                                <button
                                  type="button"
                                  className="mobile-ai-handle"
                                  onPointerDown={onMobileDrawerPointerDown}
                                  onPointerMove={onMobileDrawerPointerMove}
                                  onPointerUp={onMobileDrawerPointerEnd}
                                  onPointerCancel={onMobileDrawerPointerEnd}
                                  aria-label="Toggle AI drawer"
                                >
                                  <span className="mobile-ai-handle-dot" />
                                  <span className="mobile-ai-handle-label">AI</span>
                                </button>
                                <div
                                  className="mobile-ai-dragzone"
                                  onPointerDown={onMobileDrawerPointerDown}
                                  onPointerMove={onMobileDrawerPointerMove}
                                  onPointerUp={onMobileDrawerPointerEnd}
                                  onPointerCancel={onMobileDrawerPointerEnd}
                                >
                                  <span />
                                </div>
                                <div className="mobile-ai-head">
                                  <div className="chat-head">
                                    <div>
                                      <div className="n">{selectedLead ? selectedLead.name : "Lead"}</div>
                                      <div className="sub">WhatsApp API · Suggestions {String(aiProvider).toUpperCase()} · {String(MODE).toUpperCase()}</div>
                                    </div>
                                    <button
                                      className="icon-btn"
                                      onClick={() => {
                                        if (!selectedLead) return;
                                        void loadSuggestions(selectedLead.id, true);
                                      }}
                                    >
                                      {loadingSuggestions ? "…" : "✦"}
                                    </button>
                                  </div>
                                  <div className="filters" style={{ marginBottom: "8px" }}>
                                    {["claude", "gpt"].map((provider) => (
                                      <button
                                        key={provider}
                                        className={"pill " + (aiProvider === provider ? "active" : "")}
                                        onClick={() => setAiProvider(provider)}
                                      >
                                        {provider.toUpperCase()}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div className="mobile-ai-cards">
                                  {selectedLead && Array.isArray(selectedLead.suggestions) && selectedLead.suggestions.length
                                    ? selectedLead.suggestions.map((card) => (
                                      <div key={card.id} className="card">
                                        <div className="card-top">
                                          <div>
                                            <div className="card-title">{card.title}</div>
                                            <div className="card-tag">{card.tag}</div>
                                          </div>
                                          <div className="card-zap">⚡</div>
                                        </div>
                                        <div className="snips">
                                          {ensureBubbleSet(card.messages).map((msg, i) => <div key={i} className="snip">{clampText(msg)}</div>)}
                                        </div>
                                        <div className="card-actions">
                                          <button className="btn insert" disabled={sending} onClick={() => insertSuggestion(card.messages)}>Insérer</button>
                                          <button className="btn send" disabled={sending} onClick={() => { insertSuggestion(card.messages); setTimeout(() => { void sendMessages(); }, 80); }}>Envoyer</button>
                                        </div>
                                      </div>
                                    ))
                                    : <div className="preview">{loadingSuggestions ? "Génération suggestions..." : "Aucune suggestion disponible"}</div>}
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="suggestion-wrap">
                              <div className="chat-head">
                                <div>
                                  <div className="n">{selectedLead ? selectedLead.name : "Lead"}</div>
                                  <div className="sub">WhatsApp API · Suggestions {String(aiProvider).toUpperCase()} · {String(MODE).toUpperCase()}</div>
                                </div>
                                <button
                                  className="icon-btn"
                                  onClick={() => {
                                    if (!selectedLead) return;
                                    void loadSuggestions(selectedLead.id, true);
                                  }}
                                >
                                  {loadingSuggestions ? "…" : "✦"}
                                </button>
                              </div>
                              <div className="filters" style={{ marginBottom: "8px" }}>
                                {["claude", "gpt"].map((provider) => (
                                  <button
                                    key={provider}
                                    className={"pill " + (aiProvider === provider ? "active" : "")}
                                    onClick={() => setAiProvider(provider)}
                                  >
                                    {provider.toUpperCase()}
                                  </button>
                                ))}
                              </div>
                              <div className="cards">
                                {selectedLead && Array.isArray(selectedLead.suggestions) && selectedLead.suggestions.length
                                  ? selectedLead.suggestions.map((card) => (
                                    <div key={card.id} className="card">
                                      <div className="card-top">
                                        <div>
                                          <div className="card-title">{card.title}</div>
                                          <div className="card-tag">{card.tag}</div>
                                        </div>
                                        <div className="card-zap">⚡</div>
                                      </div>
                                      <div className="snips">
                                        {ensureBubbleSet(card.messages).map((msg, i) => <div key={i} className="snip">{clampText(msg)}</div>)}
                                      </div>
                                      <div className="card-actions">
                                        <button className="btn insert" disabled={sending} onClick={() => insertSuggestion(card.messages)}>Insérer</button>
                                        <button className="btn send" disabled={sending} onClick={() => { insertSuggestion(card.messages); setTimeout(() => { void sendMessages(); }, 80); }}>Envoyer</button>
                                      </div>
                                    </div>
                                  ))
                                  : <div className="preview">{loadingSuggestions ? "Génération suggestions..." : "Aucune suggestion disponible"}</div>}
                              </div>
                            </div>

                            <div className="chat-messages">
                              {errorText ? <div className="preview">{errorText}</div> : null}
                              {loadingMessages ? <div className="preview">Chargement messages...</div> : null}
                              {selectedLead && Array.isArray(selectedLead.messages) && selectedLead.messages.map((message) => {
                                const own = message.from === "brand";
                                return (
                                  <div key={message.id} className={"msg-row " + (own ? "brand" : "client")}>
                                    <div className={"bubble " + (own ? "brand" : "client")}>
                                      <div className="text">{clampText(message.text)}</div>
                                      <div className="meta">
                                        <span>{message.time}</span>
                                        {own ? <span>{message.status === "read" ? "✓✓" : "✓"}</span> : null}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}

                        <div className="composer">
                          <div className="stats">
                            <div className="stat"><div className="k">AI</div><div className="v">{selectedLead ? selectedLead.suggestions.length : 0} cartes</div></div>
                            <div className="stat"><div className="k">Stage</div><div className="v">{selectedLead ? (selectedLead.stageLabel || selectedLead.stage) : "-"}</div></div>
                            <div className="stat"><div className="k">Provider</div><div className="v">{String(aiProvider).toUpperCase()}</div></div>
                          </div>

                          {draftMessages.length ? (
                            <div className="draft-stack">
                              {draftMessages.map((msg, i) => <div key={i} className="draft-bubble">{clampText(msg)}</div>)}
                            </div>
                          ) : null}

                          <div className="composer-row">
                            <button className="mini-btn" onClick={() => setDraftMessages([])}>＋</button>
                            <div className="composer-pill">
                              {draftMessages.length ? String(draftMessages.length) + " messages prêts à être envoyés" : "Sélectionner une suggestion AI..."}
                            </div>
                            <button className="send-fab" disabled={sending} onClick={() => { void sendMessages(); }}>➤</button>
                          </div>

                          <div className="hint">
                            <span>✦ Suggestions 2–4 messages · ≤120 caractères</span>
                            <span>{LIVE_MODE ? "Live API" : "Mock mode"}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      }

      ReactDOM.createRoot(document.getElementById("root")).render(<App />);
    </script>
  </body>
</html>`;

  res.status(200).type("html").send(html);
});

whatsappRouter.get("/admin/whatsapp-intelligence/mobile-lab", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(`/whatsapp-intelligence/mobile-lab${query}`);
});

whatsappRouter.get("/admin/whatsapp-intelligence", (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
  <html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Intelligence WhatsApp</title>
  <style>
    :root {
      --bg:#0b0d12;
      --panel:#121722;
      --panel2:#0f1420;
      --line:#222b3a;
      --text:#ebeff7;
      --muted:#9ea8bc;
      --risk:#f2c2c2;
      --riskbg:rgba(208,101,101,.18);
    }
    * { box-sizing:border-box; }
    button, a, input, select, textarea { pointer-events:auto !important; }
    body {
      margin:0;
      font-family:"Avenir Next","Helvetica Neue",Arial,sans-serif;
      color:var(--text);
      background:radial-gradient(1000px 620px at -20% -10%, #1d2535, #0b0d12 55%);
    }
    .wrap { width:min(1600px,96vw); margin:20px auto; display:grid; grid-template-columns: 1fr 360px; gap:14px; }
    .card { background:linear-gradient(180deg, rgba(18,23,34,.98), rgba(13,17,25,.98)); border:1px solid var(--line); border-radius:14px; padding:14px; }
    .nav { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
    .nav a { text-decoration:none; color:#d5dced; border:1px solid var(--line); border-radius:999px; padding:8px 14px; font-size:13px; background:#0f1621; }
    .nav a.current { border-color:#546586; color:#fff; }
    h1 { margin:0; font-weight:500; font-size:34px; }
    .sub { margin:6px 0 14px; color:var(--muted); font-size:14px; }

    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .toolbar-left { display:flex; align-items:center; gap:10px; }
    .range { display:inline-flex; gap:6px; padding:4px; border:1px solid var(--line); border-radius:999px; background:#0f1520; }
    .range button { border:0; border-radius:999px; background:transparent; color:#cdd6e7; font-weight:700; font-size:13px; padding:7px 12px; cursor:pointer; }
    .range button.active { background:#233149; color:#fff; }

    .kpis { display:grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap:10px; }
    .kpi { border:1px solid var(--line); border-radius:12px; padding:12px; background:var(--panel2); }
    .kpi .k { font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--muted); }
    .kpi .v { margin-top:6px; font-size:30px; font-weight:500; }

    .pipeline { margin-top:12px; display:grid; grid-template-columns: repeat(9,minmax(0,1fr)); gap:8px; }
    .stage { border:1px solid var(--line); border-radius:12px; padding:10px; background:#101722; cursor:pointer; }
    .stage.active { border-color:#5f7399; box-shadow:inset 0 0 0 1px rgba(110,136,185,.3); }
    .stage .name { font-size:10px; color:#a9b4c9; letter-spacing:.06em; text-transform:uppercase; }
    .stage .count { margin-top:6px; font-size:28px; font-weight:500; }
    .stage .pct { margin-top:1px; font-size:12px; color:var(--muted); }

    .table-wrap { margin-top:12px; border:1px solid var(--line); border-radius:12px; overflow:auto; }
    .priorities { margin-top:12px; border:1px solid var(--line); border-radius:12px; padding:10px; background:#0f1521; }
    .priorities-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .priorities-title { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#aeb8cc; }
    .priority-grid { display:grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap:8px; }
    .priority-card { border:1px solid #2a3448; border-radius:10px; padding:8px; background:#0e1420; min-height:112px; }
    .priority-card .name { font-size:13px; font-weight:600; }
    .priority-card .meta { margin-top:4px; font-size:11px; color:#a8b1c5; }
    .priority-card .act { margin-top:7px; font-size:12px; color:#d9e5ff; line-height:1.35; min-height:32px; }
    .priority-card .score { margin-top:7px; font-size:11px; color:#9bb0d3; }
    .conversation {
      margin-top:12px;
      border:1px solid var(--line);
      border-radius:12px;
      background:#0e1420;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      max-height:min(86vh, 980px);
    }
    .conversation-head { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-bottom:1px solid #1d2736; }
    .conversation-head-rich { position:sticky; top:0; z-index:4; background:linear-gradient(180deg, #0f2c26 0%, #0b221d 100%); }
    .chat-topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .chat-left { display:flex; align-items:center; gap:10px; min-width:0; }
    .chat-avatar { width:36px; height:36px; border-radius:50%; border:1px solid rgba(255,255,255,.15); background:#2a4139; color:#f0f6f2; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; flex:0 0 auto; overflow:hidden; }
    .chat-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .conversation-id { min-width:220px; max-width:100%; }
    .conversation-title { font-size:16px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#f2f7f5; }
    .chat-inline-error { display:none; border:1px solid #8f4c4c; background:rgba(177,79,79,.16); color:#f6c6c6; border-radius:8px; padding:6px 8px; font-size:11px; }
    .chat-inline-error.show { display:block; }
    .chat-actions-icons { display:flex; align-items:center; gap:6px; }
    .chat-icon-btn { width:30px; height:30px; border-radius:999px; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.06); color:#eaf3ef; display:flex; align-items:center; justify-content:center; font-size:14px; cursor:pointer; }
    .conversation-stage-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .conversation-quick-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .conversation-stage-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .stage-msg-btn { border:1px solid #3a4f72; border-radius:999px; background:#0f1829; color:#dfe9fb; padding:6px 10px; font-size:12px; cursor:pointer; }
    .stage-msg-btn.active { border-color:#6b8fc7; background:#1a2b46; color:#fff; }
    .product-chips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; max-width:100%; }
    .product-chip { border:1px solid #355077; border-radius:999px; background:#0f1a2c; color:#dce8ff; padding:4px 9px; font-size:11px; cursor:pointer; max-width:320px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .product-chip:hover { border-color:#6b8fc7; background:#1a2b46; }
    .product-empty { font-size:11px; color:#93a3bf; }
    .product-context-grid { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .product-context-card { display:flex; align-items:flex-start; gap:8px; border:1px solid #2f405d; border-radius:10px; padding:6px; background:#0f1a2c; max-width:100%; min-width:200px; }
    .product-context-item { display:inline-flex; align-items:center; justify-content:center; border:1px solid #2f405d; border-radius:10px; padding:4px; background:#0f1a2c; text-decoration:none; color:#e7efff; width:44px; height:44px; flex:0 0 auto; }
    .product-context-item .product-thumb { width:34px; height:34px; border-radius:7px; }
    .product-context-meta { min-width:0; display:flex; flex-direction:column; gap:4px; }
    .product-context-title { font-size:12px; color:#e7efff; line-height:1.25; }
    .product-context-price { font-size:11px; color:#d7e5ff; }
    .product-context-price .k { color:#9fb2d1; margin-right:4px; }
    .quotes-block { border:1px solid #2b3950; border-radius:10px; background:#0f1727; padding:8px; display:flex; flex-direction:column; gap:6px; }
    .quotes-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11px; color:#9fb1cf; }
    .quotes-head strong { color:#e4edff; font-weight:700; }
    .quotes-list { display:flex; flex-direction:column; gap:6px; }
    .quote-line { width:100%; border:1px solid #314666; border-radius:8px; background:#101e32; color:#dfe9ff; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; text-align:left; cursor:pointer; }
    .quote-line:hover { border-color:#6a8fc6; background:#183051; }
    .quote-title { font-size:11px; color:#b9cae7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .quote-value { font-size:12px; color:#ffffff; flex:0 0 auto; }
    .conversation-grid {
      display:grid;
      grid-template-columns: 320px 1fr 350px;
      gap:10px;
      padding:10px;
      flex:1;
      min-height:0;
      overflow:hidden;
    }
    .wa-left {
      border:1px solid #27354a;
      border-radius:16px;
      background:
        linear-gradient(180deg, rgba(15,23,38,.92) 0%, rgba(10,16,27,.95) 100%),
        radial-gradient(120% 120% at 0% 0%, rgba(21,51,42,.18) 0%, transparent 65%);
      min-height:0;
      height:100%;
      display:flex;
      flex-direction:column;
      overflow:hidden;
      backdrop-filter: blur(10px);
    }
    .wa-left-top {
      padding:12px;
      border-bottom:1px solid #1e2a3d;
      display:flex;
      flex-direction:column;
      gap:8px;
    }
    .wa-left-title {
      font-size:12px;
      letter-spacing:.08em;
      text-transform:uppercase;
      color:#b4c3dc;
      font-weight:700;
    }
    .wa-search {
      width:100%;
      border:1px solid #324058;
      border-radius:10px;
      background:#0e1522;
      color:#e9eef8;
      padding:8px 10px;
      font-size:12px;
    }
    .wa-filters {
      display:flex;
      gap:6px;
      flex-wrap:wrap;
    }
    .wa-filters .chip {
      padding:4px 8px;
      font-size:11px;
    }
    .wa-filters .chip.is-active {
      border-color:#5c769f;
      background:#16253b;
      color:#fff;
    }
    .wa-lead-list {
      flex:1;
      min-height:0;
      overflow:auto;
      padding:6px;
      display:flex;
      flex-direction:column;
      gap:6px;
    }
    .wa-row {
      border:1px solid #2b3950;
      border-radius:12px;
      background:#0d1522;
      padding:8px;
      display:flex;
      align-items:flex-start;
      gap:9px;
      cursor:pointer;
      transition:border-color .16s ease, background .16s ease;
    }
    .wa-row:hover {
      background:#111c2d;
      border-color:#3a4d69;
    }
    .wa-row.is-active {
      border-color:#2f8f70;
      background:linear-gradient(90deg, rgba(19,52,45,.52) 0%, rgba(13,24,36,.95) 65%);
      box-shadow: inset 0 0 0 1px rgba(58,165,126,.2);
    }
    .wa-row.is-kbd {
      border-color:#6083bc;
      box-shadow: inset 0 0 0 1px rgba(96,131,188,.28);
    }
    .wa-avatar {
      width:38px;
      height:38px;
      border-radius:50%;
      border:1px solid rgba(255,255,255,.14);
      background:#213547;
      color:#e9f2ff;
      font-size:12px;
      font-weight:700;
      display:flex;
      align-items:center;
      justify-content:center;
      overflow:hidden;
      flex:0 0 auto;
    }
    .wa-avatar img {
      width:100%;
      height:100%;
      object-fit:cover;
      display:block;
    }
    .wa-meta {
      min-width:0;
      flex:1;
      display:flex;
      flex-direction:column;
      gap:4px;
    }
    .wa-line1 {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
      min-width:0;
    }
    .wa-name {
      font-size:13px;
      font-weight:700;
      color:#f2f6ff;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .wa-time {
      font-size:11px;
      color:#94a7c6;
      flex:0 0 auto;
    }
    .wa-line2 {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
      min-width:0;
    }
    .wa-snippet {
      font-size:11px;
      color:#a7b5cc;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      min-width:0;
    }
    .wa-flag {
      font-size:14px;
      line-height:1;
      margin-right:4px;
      vertical-align:-1px;
    }
    .wa-badges {
      display:flex;
      align-items:center;
      gap:4px;
      flex:0 0 auto;
    }
    .wa-badge {
      display:inline-flex;
      align-items:center;
      height:18px;
      border-radius:999px;
      border:1px solid #31435d;
      padding:0 7px;
      font-size:10px;
      letter-spacing:.04em;
      text-transform:uppercase;
      color:#d4e1f6;
      background:#0f1a2c;
    }
    .wa-badge.stage {
      border-color:#405a84;
      color:#dce8ff;
    }
    .wa-badge.risk {
      border-color:#7f4a4a;
      color:#f3cdcd;
      background:#24171b;
    }
    .wa-empty {
      border:1px dashed #2f3d53;
      border-radius:12px;
      padding:12px;
      color:#9fb0ca;
      font-size:12px;
    }
    .phone-shell {
      border:1px solid #29364b;
      border-radius:18px;
      background:
        radial-gradient(circle at 1px 1px, rgba(180,197,188,.10) 1px, transparent 0) 0 0/24px 24px,
        radial-gradient(circle at 12px 12px, rgba(132,154,145,.08) 1px, transparent 0) 0 0/24px 24px,
        linear-gradient(180deg, #0a0f11 0%, #070b0d 100%);
      min-height:0;
      height:100%;
      display:flex;
      flex-direction:column;
      overflow:hidden;
    }
    .phone-messages { flex:1; padding:14px 14px 10px; overflow:auto; display:flex; flex-direction:column; gap:8px; min-height:0; scroll-behavior:smooth; position:relative; }
    .phone-messages::before {
      content:"";
      position:absolute;
      inset:0;
      pointer-events:none;
      opacity:.18;
      background-image:
        linear-gradient(45deg, rgba(132,154,145,.16) 2px, transparent 2px),
        linear-gradient(-45deg, rgba(132,154,145,.10) 2px, transparent 2px);
      background-size:36px 36px, 54px 54px;
      mix-blend-mode:screen;
    }
    .msg-day { align-self:center; margin:10px 0 4px; border:1px solid rgba(122,148,136,.34); border-radius:999px; padding:3px 10px; color:#b5c6be; font-size:11px; background:rgba(19,33,29,.72); position:relative; z-index:1; }
    .msg-row { display:flex; width:100%; }
    .msg-row.in { justify-content:flex-start; }
    .msg-row.out { justify-content:flex-end; }
    .msg-bubble { max-width:65%; border-radius:11px; padding:10px 12px; font-size:15px; line-height:1.45; border:1px solid #2a3448; position:relative; transition:opacity .2s ease, transform .2s ease; animation:msgIn .18s ease; z-index:1; }
    .msg-bubble:hover { transform:translateY(-1px); }
    .msg-row.in .msg-bubble { background:#23292e; color:#f0f4f2; border-color:#394046; border-top-left-radius:4px; }
    .msg-row.out .msg-bubble { background:#0f5f47; color:#ecfff7; border-color:#1d7a5f; border-top-right-radius:4px; }
    .msg-row.in .msg-bubble::after {
      content:"";
      position:absolute;
      left:-6px;
      top:10px;
      width:0;height:0;
      border-top:6px solid transparent;
      border-bottom:6px solid transparent;
      border-right:6px solid #23292e;
    }
    .msg-row.out .msg-bubble::after {
      content:"";
      position:absolute;
      right:-6px;
      top:10px;
      width:0;height:0;
      border-top:6px solid transparent;
      border-bottom:6px solid transparent;
      border-left:6px solid #0f5f47;
    }
    .msg-menu { position:absolute; top:5px; right:6px; opacity:0; font-size:12px; color:#a7b6d0; transition:opacity .15s ease; pointer-events:none; }
    .msg-bubble:hover .msg-menu { opacity:.8; }
    .msg-reply {
      border-left:3px solid rgba(159,192,255,.75);
      background:rgba(255,255,255,.08);
      border-radius:8px;
      padding:6px 8px;
      margin:0 0 8px;
      cursor:default;
    }
    .msg-reply.is-link { cursor:pointer; }
    .msg-reply-label { font-size:11px; line-height:1.1; color:#b9d3ff; font-weight:600; margin-bottom:2px; }
    .msg-reply-text { font-size:12px; line-height:1.35; color:#dce8ff; opacity:.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .msg-row.out .msg-reply {
      background:rgba(4,35,28,.5);
      border-left-color:rgba(147,235,194,.85);
    }
    .msg-row.out .msg-reply-label { color:#b8f0d8; }
    .msg-row.out .msg-reply-text { color:#d9fff0; }
    .msg-meta { margin-top:5px; font-size:11px; color:#a9bbb3; display:flex; align-items:center; justify-content:flex-end; gap:7px; }
    .msg-template { display:flex; flex-direction:column; gap:8px; }
    .msg-template-header-label { font-size:11px; font-weight:600; letter-spacing:.02em; opacity:.84; text-transform:uppercase; }
    .msg-template-image { max-width:260px; width:100%; border-radius:10px; border:1px solid #30415b; display:block; }
    .msg-template-doc {
      display:flex;
      align-items:center;
      gap:8px;
      border:1px solid #395173;
      background:rgba(22,39,64,.45);
      border-radius:10px;
      padding:8px 9px;
    }
    .msg-row.out .msg-template-doc { background:rgba(4,35,28,.5); border-color:#2e7c63; }
    .msg-template-doc-icon {
      width:28px;
      height:28px;
      border-radius:8px;
      background:#d14f58;
      color:#fff;
      font-size:11px;
      font-weight:700;
      display:flex;
      align-items:center;
      justify-content:center;
      flex:0 0 auto;
    }
    .msg-template-doc-link {
      color:#cde0ff;
      text-decoration:underline;
      text-underline-offset:2px;
      font-size:12px;
      word-break:break-all;
    }
    .msg-template-body { white-space:normal; word-break:break-word; }
    .msg-template-footer { font-size:12px; opacity:.8; }
    .msg-template-cta { display:flex; flex-wrap:wrap; gap:6px; }
    .msg-template-cta-btn {
      border:1px solid rgba(136,167,255,.55);
      background:rgba(16,31,54,.5);
      color:#dce8ff;
      border-radius:999px;
      padding:4px 10px;
      font-size:12px;
      line-height:1.25;
      cursor:pointer;
    }
    .msg-row.out .msg-template-cta-btn {
      border-color:rgba(146,238,196,.52);
      background:rgba(5,57,42,.56);
      color:#ddfff2;
    }
    .msg-link-preview {
      border:1px solid #344760;
      background:rgba(17,29,44,.62);
      border-radius:12px;
      overflow:hidden;
      margin:0 0 8px;
    }
    .msg-row.out .msg-link-preview {
      border-color:#2f7f64;
      background:rgba(6,49,37,.52);
    }
    .msg-link-preview-img {
      display:block;
      width:100%;
      max-height:170px;
      object-fit:cover;
      background:#0e1522;
      border-bottom:1px solid rgba(64,87,121,.55);
    }
    .msg-link-preview-body { padding:8px 10px; display:flex; flex-direction:column; gap:5px; }
    .msg-link-preview-title { font-size:13px; font-weight:600; line-height:1.35; color:#e4eefc; }
    .msg-link-preview-meta { display:flex; align-items:center; gap:6px; font-size:11px; color:#9fb5d8; }
    .msg-link-preview-favicon { width:14px; height:14px; border-radius:4px; flex:0 0 auto; }
    .msg-link-preview-domain { opacity:.9; }
    .msg-status { display:inline-flex; align-items:center; gap:2px; font-size:11px; letter-spacing:-.02em; }
    .msg-status.read { color:#7fc4ff; }
    .msg-status.sent, .msg-status.delivered { color:#d6e1dc; }
    .msg-bubble.flash { box-shadow:0 0 0 2px rgba(122,185,255,.48); }
    .msg-provider { display:none; }
    .phone-composer-wrap { flex:0 0 auto; position:sticky; bottom:0; border-top:1px solid #1f272c; background:#0f1418; padding:8px 10px 10px; max-height:48vh; overflow:hidden; }
    .session-note { margin:0 0 6px; font-size:11px; color:#a3b5ae; }
    .session-note.closed { color:#f2c8c8; }
    .suggestion-note { margin:0 0 7px; font-size:11px; color:#a3b5ae; min-height:16px; }
    .suggestion-shell { margin:0 0 8px; border:0; border-radius:0; background:transparent; overflow:visible; }
    .sug-toggle {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      width:100%;
      margin:0 0 6px;
      border:1px solid #314766;
      border-radius:10px;
      background:#0d182a;
      color:#dfe9fb;
      font-size:12px;
      padding:6px 10px;
      cursor:pointer;
    }
    .sug-toggle .chev { transition:transform .18s ease; opacity:.8; }
    .sug-toggle.open .chev { transform:rotate(180deg); }
    .suggestion-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; margin:0 0 8px; padding:0; max-height:none; overflow:visible; opacity:1; transition:none; }
    .suggestion-shell.is-collapsed .suggestion-cards { display:none; }
    .suggestion-card{
      border: 1px solid rgba(148,163,184,.18);
      background: rgba(2,6,23,.55);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 12px;
      margin-bottom: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.18);
    }
    .suggestion-card .h{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:10px;
      margin-bottom:8px;
    }
    .suggestion-card .t{
      font-size: 12px;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: rgba(226,232,240,.8);
      font-weight: 600;
    }
    .suggestion-card .p {
      font-size:10px;
      color: rgba(148,163,184,.78);
      border:1px solid rgba(148,163,184,.20);
      border-radius:999px;
      padding:2px 7px;
      background: rgba(15,23,42,.45);
    }
    .suggestion-card .h-right{
      display:flex;
      align-items:center;
      gap:8px;
    }
    .suggestion-card .txt{
      font-size: 13px;
      line-height: 1.35;
      color: rgba(248,250,252,.92);
      margin-bottom: 8px;
      white-space:pre-wrap;
    }
    .suggestion-card .why{
      margin-top: 6px;
      font-size: 11px;
      color: rgba(148,163,184,.75);
    }
    .sug-timing{
      font-size: 11px;
      color: rgba(148,163,184,.85);
      border-top: 1px solid rgba(148,163,184,.10);
      padding-top: 8px;
      margin-top: 8px;
    }
    .sug-urgency{
      font-size: 10px;
      letter-spacing: .06em;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 4px 8px;
      border: 1px solid rgba(148,163,184,.18);
      background: rgba(15,23,42,.6);
      color: rgba(226,232,240,.85);
      user-select: none;
    }
    .sug-urgency--LOW{
      background: rgba(30,41,59,.55);
      border-color: rgba(148,163,184,.18);
      color: rgba(226,232,240,.75);
    }
    .sug-urgency--MEDIUM{
      background: rgba(120,53,15,.25);
      border-color: rgba(251,191,36,.22);
      color: rgba(253,230,138,.9);
    }
    .sug-urgency--HIGH{
      background: rgba(124,45,18,.28);
      border-color: rgba(251,113,133,.20);
      color: rgba(254,205,211,.92);
    }
    .sug-urgency--CRITICAL{
      background: rgba(127,29,29,.35);
      border-color: rgba(248,113,113,.28);
      color: rgba(254,226,226,.95);
    }
    .suggestion-card--critical {
      animation: criticalPulse 2.2s ease-in-out infinite;
      box-shadow: 0 0 0 1px rgba(248,113,113,.20), 0 10px 30px rgba(0,0,0,.18);
    }
    .sug-elapsed {}
    .sug-delay{
      margin-top:6px;
      font-size:11px;
      color: rgba(148,163,184,.85);
      border-left: 2px solid rgba(148,163,184,.22);
      padding-left:8px;
    }
    .sug-delay--warn{
      color: rgba(251,191,36,.88);
      border-left-color: rgba(251,191,36,.22);
    }
    .sug-metrics{
      margin-top:6px;
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .sug-metric-chip{
      display:inline-flex;
      align-items:center;
      border-radius:999px;
      padding:4px 9px;
      font-size:11px;
      color: rgba(226,232,240,.86);
      border:1px solid rgba(148,163,184,.20);
      background: rgba(15,23,42,.46);
      line-height:1.1;
    }
    .sug-metric-chip--warn{
      color: rgba(254,226,226,.95);
      border-color: rgba(248,113,113,.30);
      background: rgba(127,29,29,.22);
    }
    .suggestion-card .insert-btn{
      margin-top: 10px;
      width: 100%;
      border-radius: 12px;
      padding: 10px 12px;
      border: 1px solid rgba(16,185,129,.22);
      background: rgba(16,185,129,.10);
      color: rgba(236,253,245,.95);
      font-weight: 600;
      cursor: pointer;
      align-self:stretch;
    }
    .suggestion-card .insert-btn:hover{
      background: rgba(16,185,129,.14);
      border-color: rgba(16,185,129,.28);
    }
    .ai-cards-shell{
      margin:0 0 10px;
      border:1px solid rgba(148,163,184,.16);
      border-radius:14px;
      background:rgba(5,10,18,.52);
      box-shadow:0 10px 28px rgba(0,0,0,.16);
      padding:10px;
    }
    .ai-cards-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .ai-cards-head-right{ display:flex; align-items:center; gap:8px; }
    .ai-provider-select{
      border:1px solid rgba(148,163,184,.2);
      background:rgba(15,23,42,.38);
      color:rgba(226,232,240,.95);
      border-radius:10px;
      padding:6px 10px;
      font-size:11px;
      height:30px;
    }
    .ai-analyze-btn{
      border:1px solid rgba(16,185,129,.35);
      background:rgba(16,185,129,.14);
      color:rgba(236,253,245,.98);
      border-radius:10px;
      padding:6px 10px;
      font-size:11px;
      height:30px;
      cursor:pointer;
      font-weight:600;
    }
    .ai-analyze-btn:disabled{ opacity:.55; cursor:not-allowed; }
    .ai-toggle-btn{
      border:1px solid rgba(148,163,184,.2);
      background:rgba(15,23,42,.38);
      color:rgba(226,232,240,.9);
      border-radius:10px;
      padding:6px 10px;
      font-size:11px;
      cursor:pointer;
    }
    .ai-toggle-btn:disabled{ opacity:.55; cursor:not-allowed; }
    .ai-cards-title-wrap{ display:flex; align-items:center; gap:10px; min-width:0; }
    .ai-cards-title{ font-size:12px; letter-spacing:.07em; text-transform:uppercase; font-weight:600; color:rgba(232,239,250,.9); }
    .ai-cards-updated{ font-size:11px; color:rgba(156,174,204,.78); white-space:nowrap; }
    .ai-refresh-btn{
      width:28px; height:28px; border-radius:8px; border:1px solid rgba(148,163,184,.18);
      background:rgba(15,23,42,.38); color:rgba(226,232,240,.9); cursor:pointer; font-size:13px;
    }
    .ai-refresh-btn:disabled{ opacity:.55; cursor:not-allowed; }
    .ai-cards-list{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; }
    .ai-card{
      border:1px solid rgba(148,163,184,.16);
      background:rgba(7,12,22,.64);
      border-radius:12px;
      padding:10px;
      display:flex;
      flex-direction:column;
      gap:7px;
    }
    .ai-card-top{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .ai-goal{
      font-size:10px; letter-spacing:.07em; text-transform:uppercase;
      border:1px solid rgba(148,163,184,.18); border-radius:999px; padding:3px 8px;
      color:rgba(226,232,240,.82); background:rgba(15,23,42,.42);
    }
    .ai-conf{ font-size:10px; color:rgba(148,163,184,.82); }
    .ai-title{ font-size:13px; font-weight:600; color:rgba(242,247,255,.94); line-height:1.3; }
    .ai-text{
      font-size:12px; line-height:1.45; color:rgba(216,228,245,.9);
      white-space:pre-wrap;
      display:-webkit-box; -webkit-line-clamp:5; -webkit-box-orient:vertical;
      overflow:hidden;
    }
    .ai-text.expanded{ display:block; -webkit-line-clamp:unset; overflow:visible; }
    .ai-bubbles{ display:grid; gap:6px; }
    .ai-bubble-row{ display:flex; align-items:flex-end; gap:6px; }
    .ai-bubble-preview{
      border:1px solid rgba(16,185,129,.24);
      background:rgba(16,185,129,.10);
      color:rgba(228,244,238,.97);
      border-radius:12px 12px 12px 4px;
      padding:7px 9px;
      font-size:12px;
      line-height:1.4;
      white-space:pre-wrap;
    }
    .ai-bubble-insert{
      border:1px solid rgba(16,185,129,.24);
      background:rgba(16,185,129,.10);
      color:rgba(228,244,238,.97);
      border-radius:12px 12px 12px 4px;
      padding:7px 9px;
      font-size:12px;
      line-height:1.4;
      white-space:pre-wrap;
      cursor:pointer;
      max-width:92%;
      text-align:left;
    }
    .ai-bubble-insert:hover{
      border-color:rgba(16,185,129,.42);
      background:rgba(16,185,129,.18);
    }
    .ai-bubble-insert:disabled{ opacity:.6; cursor:not-allowed; }
    .ai-bubble-send-btn{
      border:1px solid rgba(16,185,129,.45);
      background:linear-gradient(180deg, rgba(22,163,74,.92), rgba(5,150,105,.92));
      color:#f0fdf4;
      border-radius:999px;
      width:28px;
      height:28px;
      padding:0;
      font-size:12px;
      font-weight:600;
      cursor:pointer;
      flex:0 0 auto;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      box-shadow:0 4px 10px rgba(16,185,129,.25);
      transition:transform .16s ease, box-shadow .16s ease, filter .16s ease;
      animation:aiBubblePulse 1.9s ease-in-out infinite;
    }
    .ai-bubble-send-btn:hover{
      transform:translateY(-1px) scale(1.04);
      box-shadow:0 8px 16px rgba(16,185,129,.35);
      filter:brightness(1.05);
    }
    .ai-bubble-send-btn:disabled{ opacity:.6; cursor:not-allowed; }
    .ai-bubble-send-btn:disabled{ animation:none; }
    @keyframes aiBubblePulse{
      0%,100%{ transform:scale(1); box-shadow:0 4px 10px rgba(16,185,129,.25); }
      50%{ transform:scale(1.06); box-shadow:0 8px 18px rgba(16,185,129,.34); }
    }
    .ai-send-failure{
      border:1px solid rgba(248,113,113,.28);
      background:rgba(127,29,29,.22);
      color:rgba(254,226,226,.95);
      border-radius:8px;
      padding:6px 8px;
      font-size:11px;
    }
    .ai-expand-btn{
      border:0; background:transparent; color:rgba(162,186,222,.92);
      font-size:11px; padding:0; text-align:left; cursor:pointer;
    }
    .ai-actions{ display:flex; gap:7px; margin-top:2px; }
    .ai-btn{
      border:1px solid rgba(148,163,184,.2); border-radius:10px; padding:7px 10px;
      font-size:12px; cursor:pointer; background:rgba(15,23,42,.45); color:rgba(226,232,240,.92);
    }
    .ai-btn.primary{
      border-color:rgba(16,185,129,.28);
      background:rgba(16,185,129,.12);
      color:rgba(236,253,245,.98);
      font-weight:600;
    }
    .ai-btn:disabled{ opacity:.55; cursor:not-allowed; }
    .ai-empty, .ai-error, .ai-loading{
      border:1px dashed rgba(148,163,184,.22);
      border-radius:10px;
      padding:10px;
      font-size:12px;
      color:rgba(166,184,214,.85);
      background:rgba(10,18,33,.38);
    }
    .ai-error{ color:rgba(246,201,201,.92); border-color:rgba(248,113,113,.28); }
    .ai-loading .skeleton{ margin:6px 0; }
    .agent-status-pill{
      display:inline-flex;
      align-items:center;
      border-radius:999px;
      padding:4px 10px;
      font-size:10px;
      letter-spacing:.06em;
      text-transform:uppercase;
      border:1px solid rgba(148,163,184,.20);
      background:rgba(15,23,42,.45);
      color:rgba(226,232,240,.86);
      white-space:nowrap;
      max-width:220px;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .agent-status-pill--running{
      border-color:rgba(251,191,36,.28);
      color:rgba(254,243,199,.95);
      background:rgba(113,63,18,.22);
    }
    .agent-status-pill--ok{
      border-color:rgba(16,185,129,.24);
      color:rgba(209,250,229,.95);
      background:rgba(6,78,59,.25);
    }
    .agent-status-pill--error{
      border-color:rgba(248,113,113,.30);
      color:rgba(254,226,226,.95);
      background:rgba(127,29,29,.24);
    }
    .ai-tabs{
      display:flex;
      gap:8px;
      margin:0 0 8px;
    }
    .ai-tab{
      border:1px solid rgba(148,163,184,.2);
      border-radius:999px;
      padding:6px 11px;
      font-size:11px;
      background:rgba(15,23,42,.42);
      color:rgba(211,225,244,.9);
      cursor:pointer;
    }
    .ai-tab.active{
      border-color:rgba(148,163,184,.34);
      background:rgba(30,41,59,.58);
      color:rgba(242,247,255,.96);
    }
    .ai-tab-panel{ display:none; }
    .ai-tab-panel.active{ display:block; }
    .agent-flow-head{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
      margin-bottom:8px;
    }
    .agent-flow-timeline{
      display:grid;
      gap:6px;
      margin-bottom:8px;
    }
    .agent-flow-step{
      border:1px solid rgba(148,163,184,.18);
      border-radius:10px;
      padding:8px 10px;
      background:rgba(7,12,22,.58);
      display:flex;
      justify-content:space-between;
      gap:10px;
      font-size:12px;
      color:rgba(220,230,245,.9);
    }
    .agent-flow-step .s{
      border-radius:999px;
      padding:2px 8px;
      font-size:10px;
      letter-spacing:.05em;
      text-transform:uppercase;
      border:1px solid rgba(148,163,184,.2);
      background:rgba(15,23,42,.45);
    }
    .agent-flow-step .s.success{ border-color:rgba(16,185,129,.25); color:rgba(209,250,229,.95); }
    .agent-flow-step .s.pending{ border-color:rgba(251,191,36,.28); color:rgba(254,243,199,.95); }
    .agent-flow-step .s.error{ border-color:rgba(248,113,113,.30); color:rgba(254,226,226,.95); }
    .agent-flow-step .s.warning{ border-color:rgba(245,158,11,.30); color:rgba(254,243,199,.95); }
    .agent-runs-list{
      border:1px solid rgba(148,163,184,.14);
      border-radius:10px;
      overflow:hidden;
      margin-bottom:8px;
      background:rgba(7,12,22,.44);
      max-height:220px;
      overflow:auto;
    }
    .agent-run-row{
      width:100%;
      border:0;
      border-bottom:1px solid rgba(148,163,184,.08);
      background:transparent;
      color:rgba(216,228,245,.92);
      cursor:pointer;
      text-align:left;
      padding:8px 10px;
      display:flex;
      justify-content:space-between;
      gap:8px;
      font-size:12px;
    }
    .agent-run-row:last-child{ border-bottom:0; }
    .agent-run-row.active{ background:rgba(30,41,59,.42); }
    .agent-run-meta{ font-size:11px; color:rgba(156,174,204,.85); }
    .agent-run-details{
      border:1px solid rgba(148,163,184,.14);
      border-radius:10px;
      background:rgba(7,12,22,.58);
      padding:10px;
      font-size:12px;
      color:rgba(216,228,245,.9);
    }
    .agent-run-details .row{
      display:flex;
      justify-content:space-between;
      gap:10px;
      margin:4px 0;
    }
    .ai-why-btn{
      border:0;
      background:transparent;
      color:rgba(160,182,213,.9);
      font-size:11px;
      padding:0;
      cursor:pointer;
      text-align:left;
    }
    .ai-why-btn:hover{ color:rgba(197,214,241,.96); }
    .ai-drawer-backdrop{
      position:fixed;
      inset:0;
      background:rgba(3,6,11,.38);
      display:none;
      justify-content:flex-end;
      z-index:65;
    }
    .ai-drawer-backdrop.open{ display:flex; }
    .ai-drawer{
      width:min(500px,100vw);
      height:100vh;
      background:linear-gradient(180deg, #0b1120 0%, #0a1222 100%);
      border-left:1px solid rgba(148,163,184,.22);
      box-shadow:-20px 0 50px rgba(2,8,20,.46);
      transform:translateX(20px);
      opacity:0;
      transition:transform .18s ease, opacity .18s ease;
      padding:14px 14px 18px;
      overflow:auto;
    }
    .ai-drawer-backdrop.open .ai-drawer{
      transform:translateX(0);
      opacity:1;
    }
    .ai-drawer-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .ai-drawer-title{ font-size:15px; font-weight:600; color:rgba(242,247,255,.94); margin:0; }
    .ai-drawer-updated{ font-size:11px; color:rgba(154,172,198,.82); margin-top:2px; }
    .ai-drawer-close{
      border:1px solid rgba(148,163,184,.24);
      border-radius:10px;
      height:30px;
      min-width:30px;
      background:rgba(15,23,42,.45);
      color:rgba(226,232,240,.92);
      cursor:pointer;
    }
    .ai-insight-sec{
      border:1px solid rgba(148,163,184,.16);
      border-radius:12px;
      background:rgba(7,12,22,.58);
      padding:10px;
      margin-bottom:8px;
    }
    .ai-insight-label{
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.06em;
      color:rgba(160,179,206,.84);
      margin-bottom:8px;
    }
    .ai-stage-top{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .ai-stage-pill{
      border:1px solid rgba(148,163,184,.22);
      border-radius:999px;
      padding:4px 10px;
      font-size:11px;
      color:rgba(232,239,250,.9);
      background:rgba(15,23,42,.44);
      text-transform:uppercase;
      letter-spacing:.05em;
    }
    .ai-stage-conf{ font-size:11px; color:rgba(170,189,216,.84); }
    .ai-stage-bar{
      height:6px;
      border-radius:999px;
      background:rgba(30,41,59,.9);
      overflow:hidden;
      border:1px solid rgba(71,85,105,.45);
    }
    .ai-stage-bar > span{
      display:block;
      height:100%;
      background:linear-gradient(90deg, rgba(51,65,85,.95), rgba(100,116,139,.95));
    }
    .ai-insight-list{
      margin:0;
      padding-left:18px;
      color:rgba(220,230,245,.9);
      font-size:13px;
      line-height:1.45;
    }
    .ai-signal-grid{ display:flex; flex-wrap:wrap; gap:6px; }
    .ai-signal-chip{
      border:1px solid rgba(148,163,184,.2);
      border-radius:999px;
      padding:4px 8px;
      font-size:11px;
      color:rgba(220,230,245,.9);
      background:rgba(15,23,42,.44);
      white-space:nowrap;
    }
    .ai-risk-item{
      display:flex;
      gap:8px;
      align-items:flex-start;
      font-size:12px;
      color:rgba(220,230,245,.9);
      margin-bottom:6px;
    }
    .ai-risk-tag{
      border:1px solid rgba(148,163,184,.24);
      border-radius:999px;
      padding:2px 7px;
      text-transform:uppercase;
      font-size:10px;
      letter-spacing:.05em;
      color:rgba(226,232,240,.9);
      min-width:44px;
      text-align:center;
      line-height:1.2;
      background:rgba(15,23,42,.48);
    }
    .ai-risk-tag.low{ border-color:rgba(148,163,184,.24); }
    .ai-risk-tag.medium{ border-color:rgba(245,158,11,.3); color:rgba(252,211,77,.95); }
    .ai-risk-tag.high{ border-color:rgba(248,113,113,.34); color:rgba(254,202,202,.95); }
    .ai-meta-row{
      display:flex;
      justify-content:space-between;
      gap:10px;
      padding:4px 0;
      border-bottom:1px solid rgba(148,163,184,.09);
      font-size:12px;
      color:rgba(197,214,241,.9);
    }
    .ai-meta-row:last-child{ border-bottom:0; }
    .ai-meta-key{ color:rgba(148,163,184,.9); }
    .ai-meta-actions{ margin-top:8px; display:flex; gap:8px; }
    .ai-meta-btn{
      border:1px solid rgba(148,163,184,.2);
      border-radius:10px;
      padding:7px 10px;
      background:rgba(15,23,42,.45);
      color:rgba(226,232,240,.92);
      font-size:12px;
      cursor:pointer;
    }
    .ai-control-badges{ display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
    .ai-control-badge{
      border:1px solid rgba(148,163,184,.22);
      border-radius:999px;
      padding:3px 8px;
      font-size:10px;
      color:rgba(208,223,246,.9);
      background:rgba(15,23,42,.44);
      text-transform:uppercase;
      letter-spacing:.05em;
    }
    .ai-drawer-empty,
    .ai-drawer-error,
    .ai-drawer-loading{
      border:1px dashed rgba(148,163,184,.22);
      border-radius:10px;
      padding:10px;
      font-size:12px;
      color:rgba(166,184,214,.85);
      background:rgba(10,18,33,.38);
    }
    .ai-drawer-error{
      color:rgba(246,201,201,.92);
      border-color:rgba(248,113,113,.28);
    }
    @media (max-width: 760px){
      .ai-drawer{ width:100vw; }
      .ai-actions{ flex-wrap:wrap; }
    }
    .sug-score{
      display:inline-flex;
      align-items:center;
      height:18px;
      padding:0 8px;
      border-radius:999px;
      font-size:10px;
      letter-spacing:.06em;
      text-transform:uppercase;
      border:1px solid rgba(148,163,184,.16);
      background:rgba(2,6,23,.35);
      color:rgba(226,232,240,.80);
      margin-left:6px;
    }
    .dbg-toggle{
      margin-top:8px;
      background:transparent;
      border:1px solid rgba(148,163,184,.14);
      color:rgba(226,232,240,.7);
      font-size:11px;
      padding:6px 10px;
      border-radius:10px;
      cursor:pointer;
    }
    .dbg-panel{
      margin-top:8px;
      border:1px solid rgba(148,163,184,.14);
      background:rgba(2,6,23,.35);
      border-radius:12px;
      padding:10px;
      font-size:11px;
      color:rgba(226,232,240,.78);
    }
    .dbg-row{
      display:flex;
      justify-content:space-between;
      gap:10px;
      padding:3px 0;
    }
    .dbg-row span:first-child{
      color:rgba(148,163,184,.85);
    }
    .dbg-sep{
      height:1px;
      background:rgba(148,163,184,.12);
      margin:8px 0;
    }
    .suggestion-template-options { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 8px; }
    .suggestion-template-pill { border:1px solid #39537d; border-radius:999px; padding:3px 8px; font-size:11px; color:#dce8ff; background:#10213d; }
    .wf-badge{
      display:inline-flex;
      align-items:center;
      height: 18px;
      padding: 0 8px;
      border-radius: 999px;
      font-size: 10px;
      letter-spacing: .08em;
      text-transform: uppercase;
      border: 1px solid rgba(148,163,184,.16);
      background: rgba(15,23,42,.35);
      color: rgba(226,232,240,.75);
      margin-left: 8px;
      white-space: nowrap;
    }
    .wf-us{
      border-color: rgba(96,165,250,.18);
      color: rgba(191,219,254,.85);
    }
    .wf-client{
      border-color: rgba(251,191,36,.16);
      color: rgba(253,230,138,.85);
    }
    .wf-row-pill{
      display:inline-flex;
      align-items:center;
      margin-top:6px;
      height:16px;
      padding:0 7px;
      border-radius:999px;
      font-size:10px;
      letter-spacing:.04em;
      border:1px solid rgba(148,163,184,.16);
      background: rgba(15,23,42,.35);
      color: rgba(226,232,240,.72);
      text-transform: uppercase;
      white-space: nowrap;
    }
    .audit-wrap{
      margin-top:12px;
      border:1px solid rgba(148,163,184,.16);
      background: rgba(2,6,23,.45);
      border-radius: 16px;
      padding: 12px;
      backdrop-filter: blur(10px);
    }
    .audit-head{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin-bottom:10px;
    }
    .audit-title{
      font-size:12px;
      letter-spacing:.06em;
      text-transform:uppercase;
      color: rgba(226,232,240,.82);
      font-weight:600;
    }
    .audit-copy{
      border-radius: 12px;
      padding: 8px 10px;
      border: 1px solid rgba(148,163,184,.18);
      background: rgba(15,23,42,.5);
      color: rgba(226,232,240,.85);
      font-weight:600;
      cursor:pointer;
    }
    .audit-copy:hover{ background: rgba(15,23,42,.65); }
    .audit-body{ display:flex; flex-direction:column; gap:8px; }
    .audit-item{
      border-radius: 12px;
      padding: 10px;
      border: 1px solid rgba(148,163,184,.14);
      background: rgba(15,23,42,.35);
    }
    .audit-item .audit-item-title{ font-size:12px; font-weight:700; color: rgba(248,250,252,.92); }
    .audit-item .audit-item-detail{ font-size:11px; margin-top:4px; color: rgba(148,163,184,.85); line-height:1.35; }
    .audit-item .audit-item-code{ font-size:10px; margin-top:6px; color: rgba(148,163,184,.65); letter-spacing:.06em; text-transform:uppercase; }
    .audit-error{ border-color: rgba(248,113,113,.22); }
    .audit-warn{ border-color: rgba(251,191,36,.18); }
    .audit-info{ border-color: rgba(96,165,250,.18); }
    .audit-ok{
      font-size: 11px;
      color: rgba(148,163,184,.85);
      padding: 6px 2px;
    }
    .composer-models { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 8px; }
    .model-btn { border:1px solid #324058; border-radius:999px; background:#0e1522; color:#dce7fb; padding:6px 10px; font-size:12px; cursor:pointer; }
    .model-btn:hover { border-color:#6282b4; background:#1a2a43; color:#fff; }
    .model-btn.recommended { border-color:#2ba172; color:#eafff5; background:linear-gradient(180deg,#144935,#103b2d); box-shadow:0 0 0 1px rgba(43,161,114,.35), 0 0 18px rgba(43,161,114,.25); animation:modelPulse 1.5s ease-in-out infinite; }
    @keyframes modelPulse {
      0%,100% { box-shadow:0 0 0 1px rgba(43,161,114,.30), 0 0 14px rgba(43,161,114,.18); }
      50% { box-shadow:0 0 0 1px rgba(43,161,114,.60), 0 0 22px rgba(43,161,114,.32); }
    }
    @keyframes criticalPulse {
      0%,100% { box-shadow: 0 0 0 1px rgba(248,113,113,.16), 0 10px 30px rgba(0,0,0,.18); }
      50% { box-shadow: 0 0 0 1px rgba(248,113,113,.30), 0 10px 30px rgba(0,0,0,.20); }
    }
    .composer-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:7px; }
    .composer-quick { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .composer-quick .small-btn { padding:6px 10px; font-size:11px; }
    .phone-input { display:grid; grid-template-columns: 64px 1fr 320px; gap:8px; align-items:end; }
    .phone-input select, .phone-input textarea, .phone-input button { border:1px solid #2e363b; border-radius:999px; background:#141a1e; color:#e9eef8; padding:10px; font-size:12px; }
    .phone-input select { border-radius:12px; }
    .phone-input textarea { min-height:48px; max-height:140px; resize:none; border-radius:18px; font-size:15px; padding:11px 14px; background:#1a2025; }
    .send-wrap { display:flex; align-items:center; gap:6px; }
    .phone-input .send-icon { width:40px; height:40px; border-radius:999px; border:1px solid #1d7a5f; background:linear-gradient(180deg,#11885f,#0f6a4d); color:#f5fff9; display:flex; align-items:center; justify-content:center; font-size:16px; cursor:pointer; transition:opacity .15s ease, filter .15s ease, transform .08s ease; padding:0; }
    .phone-input .send-icon:hover { filter:brightness(1.06); }
    .phone-input .send-icon:active { transform:scale(.98); }
    .phone-input .send-icon:disabled { opacity:.5; cursor:not-allowed; filter:none; }
    .phone-empty { margin:auto; padding:18px 14px; color:#9eadc6; font-size:13px; text-align:center; }
    .chat-skeleton { display:flex; flex-direction:column; gap:8px; }
    .chat-skel-bubble { height:34px; border-radius:12px; background:linear-gradient(90deg,#182233,#253149,#182233); background-size:220% 100%; animation:pulse 1.2s ease-in-out infinite; width:52%; }
    .chat-skel-bubble.out { margin-left:auto; width:44%; }
    .client-context { border:1px solid #27354a; border-radius:14px; background:#0b1321; padding:10px; display:flex; flex-direction:column; gap:10px; min-height:0; height:100%; overflow:auto; }
    .context-title { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#aeb8cc; }
    .context-kv { display:grid; grid-template-columns: 1fr; gap:7px; }
    .context-item { border:1px solid #26344b; border-radius:9px; padding:7px 8px; background:#0d1625; }
    .context-item .k { display:block; font-size:10px; color:#9eacc5; text-transform:uppercase; letter-spacing:.05em; }
    .context-item .v { margin-top:3px; font-size:12px; color:#e5edfc; word-break:break-word; }
    .event-date-line { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .event-date-main { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .conf-pill { border:1px solid #4a5f82; border-radius:999px; padding:2px 7px; font-size:11px; color:#d9e5ff; }
    .event-date-editor { margin-top:8px; display:none; align-items:center; gap:6px; flex-wrap:wrap; }
    .event-date-editor.open { display:flex; }
    .event-date-editor input[type='date'] { width:auto; min-width:150px; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:6px 8px; font-size:12px; }
    .destination-editor { margin-top:8px; display:none; gap:6px; }
    .destination-editor.open { display:grid; grid-template-columns:1fr 1fr; }
    .destination-editor input { width:100%; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:6px 8px; font-size:12px; }
    .destination-editor .span2 { grid-column:1 / -1; }
    .copyable { cursor:pointer; text-decoration:underline dotted; }
    .context-notes-wrap textarea { width:100%; min-height:84px; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:8px; font-size:12px; resize:vertical; }
    table { width:100%; min-width:1240px; border-collapse:collapse; }
    th,td { padding:10px; border-bottom:1px solid #1f2735; text-align:left; vertical-align:top; }
    th:nth-child(4), td:nth-child(4) { min-width:190px; }
    th { position:sticky; top:0; background:#111926; color:#b3bdd1; font-size:11px; text-transform:uppercase; letter-spacing:.07em; }
    td { font-size:13px; }
    select, textarea, button.action { width:100%; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:7px 9px; font-size:12px; }
    .stage-select { min-width:170px; color:#e9eef8 !important; -webkit-text-fill-color:#e9eef8; background:#0e1522; }
    .stage-select option { color:#e9eef8; background:#0e1522; }
    button.action { cursor:pointer; }
    textarea { min-height:56px; resize:vertical; }
    .risk { display:inline-block; border-radius:999px; padding:3px 9px; border:1px solid #3c4659; font-size:11px; text-transform:uppercase; }
    .risk.high { border-color:#a95c5c; background:var(--riskbg); color:var(--risk); }
    .rec { display:inline-block; border-radius:999px; padding:3px 9px; border:1px solid #4a5f82; color:#d9e5ff; font-size:11px; text-transform:uppercase; }
    .stage-next-wrap { display:inline-flex; align-items:center; gap:6px; }
    .stage-next-arrow { color:#8ea3c4; font-size:12px; line-height:1; }
    .rec.next { border-color:#3f587d; background:#13223a; color:#cfe0ff; }
    .auto-badge { display:inline-block; border-radius:999px; padding:3px 9px; border:1px solid #4e6b57; color:#cbf2d4; font-size:11px; text-transform:uppercase; }
    .detail-btn { width:auto; min-width:96px; }
    .tiny { font-size:11px; color:var(--muted); }

    .side {
      position:sticky;
      top:14px;
      align-self:start;
      max-height:calc(100vh - 28px);
      overflow:auto;
      padding-right:2px;
    }
    .side .card + .card { margin-top:12px; }
    .side .title { margin:0; font-size:16px; font-weight:500; }
    .muted { color:var(--muted); font-size:12px; }
    .box { margin-top:10px; border:1px solid var(--line); border-radius:12px; background:#0e1420; padding:12px; white-space:pre-wrap; min-height:140px; font-size:13px; line-height:1.5; }
    .btn { width:100%; margin-top:10px; border:1px solid #496185; border-radius:10px; background:linear-gradient(180deg,#2d405d,#1b273c); color:#f5f8ff; font-weight:700; padding:10px; cursor:pointer; }
    .btn:disabled, .small-btn:disabled, button.action:disabled { opacity:.5; cursor:not-allowed; filter:none; }
    .conv-badge { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border-radius:999px; border:1px solid #324058; font-size:12px; font-weight:700; }
    .conv-low { color:#c8d3e9; border-color:#3b4860; }
    .conv-medium { color:#dbe8ff; border-color:#4d6489; }
    .conv-high { color:#ebf3ff; border-color:#6a89bf; background:rgba(79,106,146,.22); }
    .lead-client { display:flex; align-items:center; gap:9px; min-height:28px; max-width:100%; }
    .lead-client-avatar { width:24px; height:24px; border-radius:50%; border:1px solid #3a4f72; background:#173329; color:#ebfff5; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; overflow:hidden; flex:0 0 auto; }
    .lead-client-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .lead-product-cell { min-width:140px; }
    .lead-product-grid { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .lead-product-thumb { display:inline-flex; align-items:center; justify-content:center; border:1px solid #2f405d; border-radius:10px; padding:4px; background:#0f1a2c; text-decoration:none; color:#e7efff; width:44px; height:44px; }
    .lead-product-thumb:hover { border-color:#6b8fc7; background:#1a2b46; }
    .product-card { display:flex; align-items:center; gap:8px; border:1px solid #2f405d; border-radius:10px; padding:6px; background:#0d1727; max-width:280px; cursor:pointer; }
    .product-thumb { width:40px; height:40px; border-radius:8px; object-fit:cover; border:1px solid #31445f; background:#101a2a; flex:0 0 auto; }
    .product-title { font-size:12px; color:#e6eeff; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .product-more { margin-left:6px; border:1px solid #3a4f72; border-radius:999px; background:#13213a; color:#dce8ff; padding:2px 7px; font-size:11px; cursor:pointer; }
    .product-none { color:#9aabc6; font-size:12px; }
    .signal-chip-wrap { display:flex; gap:4px; flex-wrap:wrap; margin-top:6px; }
    .signal-chip { border:1px solid #365078; border-radius:999px; padding:2px 8px; font-size:11px; color:#e4edff; background:#10203a; }
    .signal-chip.compact { font-size:10px; padding:2px 6px; margin-top:0; }
    .product-popover { position:fixed; z-index:96; display:none; border:1px solid #304562; border-radius:12px; background:#0d1524; width:min(360px, 92vw); max-height:55vh; overflow:auto; padding:8px; box-shadow:0 16px 40px rgba(0,0,0,.4); }
    .product-popover.open { display:block; }
    .product-pop-item { display:flex; align-items:center; gap:8px; border:1px solid #293d58; border-radius:10px; padding:6px; margin-bottom:6px; text-decoration:none; color:#e8f0ff; background:#0f1a2c; }
    .product-pop-item:last-child { margin-bottom:0; }
    .suggestion-review-list { display:flex; flex-direction:column; gap:10px; max-height:360px; overflow:auto; }
    .suggestion-review-item { border:1px solid #2d405f; border-radius:12px; padding:10px; background:linear-gradient(180deg,#0c172a,#0b1423); }
    .suggestion-review-meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
    .suggestion-pill { display:inline-flex; align-items:center; gap:4px; border:1px solid #324760; border-radius:999px; background:#0f1c31; color:#d7e6ff; padding:2px 8px; font-size:10px; letter-spacing:.02em; }
    .suggestion-pill.soft { color:#adc2e4; border-color:#2b3f5a; background:#0d1728; }
    .suggestion-pill.ok { color:#c7f1de; border-color:#3f6c59; background:#10231d; }
    .suggestion-pill.warn { color:#ffe1b8; border-color:#6d5a3a; background:#251d12; }
    .suggestion-pill.bad { color:#f7c8c8; border-color:#6b4141; background:#241414; }
    .suggestion-review-item .txt { font-size:13px; color:#e4efff; margin-bottom:8px; white-space:pre-wrap; line-height:1.45; border:1px solid #243852; border-radius:10px; background:#0a111e; padding:8px; }
    .suggestion-review-actions { display:flex; flex-direction:column; gap:6px; }
    .suggestion-review-actions-row { display:flex; gap:6px; flex-wrap:wrap; }
    .small-btn.review-active { border-color:#6f93c9; background:#1c2d48; color:#fff; }
    .funnel { display:inline-flex; align-items:center; gap:6px; min-height:28px; max-height:28px; max-width:180px; }
    .funnel-bar { display:grid; grid-template-columns: repeat(8,minmax(0,1fr)); gap:2px; width:88px; }
    .funnel-seg { height:5px; border-radius:999px; background:rgba(114,132,165,.20); border:1px solid rgba(114,132,165,.30); transition: opacity .2s ease, background-color .2s ease, border-color .2s ease; }
    .funnel-label { font-size:10px; color:#c9d4ea; letter-spacing:.03em; max-width:84px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .funnel-prob { font-size:10px; color:#dfe9ff; border:1px solid rgba(114,132,165,.48); border-radius:999px; padding:1px 6px; background:rgba(18,27,43,.88); min-width:34px; text-align:center; }
    .funnel-urgency { font-size:11px; line-height:1; }
    .settings-form { display:grid; gap:8px; margin-top:10px; }
    .settings-form label { display:grid; gap:5px; font-size:12px; color:#b8c4da; }
    .settings-form select, .settings-form input[type="text"] {
      width:100%; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:8px 9px; font-size:12px;
    }
    .settings-form .toggles { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .settings-form .check { display:flex; align-items:center; gap:6px; font-size:12px; color:#c9d6ee; }
    .followup-scenarios { margin-top:10px; display:grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap:6px; }
    .scenario-btn { border:1px solid #324058; border-radius:9px; background:#0e1522; color:#dfe8fa; padding:7px 8px; font-size:11px; cursor:pointer; }
    .scenario-btn.active { border-color:#5470a0; background:#152136; color:#fff; }
    .drawer-backdrop { position:fixed; inset:0; background:rgba(5,8,13,.72); display:none; align-items:stretch; justify-content:flex-end; z-index:50; }
    .drawer-backdrop.open { display:flex; }
    .drawer { width:min(560px,100vw); height:100vh; background:#0f1522; border-left:1px solid var(--line); padding:16px; overflow:auto; }
    .drawer-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .drawer h3 { margin:0; font-weight:500; }
    .x { border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:6px 10px; cursor:pointer; }
    .section { margin-top:12px; border-top:1px solid #202a3a; padding-top:12px; }
    .kv { display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:8px; }
    .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid #3a4c67; border-radius:999px; padding:3px 8px; font-size:11px; margin:2px 6px 2px 0; }
    .list { margin:0; padding-left:16px; color:#d9e2f2; }
    .list li { margin:5px 0; }
    .small-btn { width:auto; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:6px 10px; font-size:12px; cursor:pointer; position:relative; z-index:3; pointer-events:auto; }
    .small-btn.active { border-color:#6282b4; background:#1a2a43; color:#fff; }
    .quick-create { display:none; margin:10px 0 0; border:1px solid var(--line); border-radius:12px; padding:10px; background:#0d1420; }
    .quick-create.open { display:block; }
    .shared-import { display:none; margin:10px 0 0; border:1px dashed #506a3f; border-radius:12px; padding:10px; background:#131e14; }
    .shared-import.open { display:block; }
    .quick-grid { display:grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap:8px; }
    .shared-grid { display:grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap:8px; }
    .quick-grid input { width:100%; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:8px 9px; font-size:12px; }
    .shared-import textarea, .shared-import input, .shared-import select { width:100%; border:1px solid #324058; border-radius:9px; background:#0e1522; color:#e9eef8; padding:8px 9px; font-size:12px; }
    .shared-import .manual-row { display:grid; grid-template-columns:120px 1fr 120px; gap:8px; margin-top:8px; }
    .shared-import .small-note { margin-top:6px; font-size:11px; color:#c7d7b3; }
    .shared-badge { display:inline-flex; align-items:center; border:1px solid #6f7f4d; border-radius:999px; padding:2px 8px; background:#2c3a1b; color:#e6f4cf; font-size:10px; margin-left:6px; }
    .quick-actions { display:flex; gap:8px; margin-top:8px; }
    .btn:hover, .small-btn:hover, button.action:hover { filter:brightness(1.06); }
    .error-banner { display:none; margin:10px 0 0; border:1px solid #8f4c4c; background:rgba(177,79,79,.16); color:#f6c6c6; border-radius:10px; padding:8px 10px; font-size:12px; }
    .error-banner.show { display:block; }
    .debug-line { margin-top:6px; font-size:11px; color:#95a8c7; }
    .lead-debug-toggle { width:100%; margin-top:10px; }
    .lead-debug-panel { display:none; margin-top:8px; border:1px solid #2e4568; border-radius:10px; background:#0a1424; padding:8px; }
    .lead-debug-panel.open { display:block; }
    .lead-debug-panel pre { margin:0; white-space:pre-wrap; word-break:break-word; font-size:11px; color:#d7e5ff; max-height:280px; overflow:auto; }
    .filterbar { margin:10px 0 8px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .filter-chips { display:flex; gap:8px; flex-wrap:wrap; }
    .chip { border:1px solid #324058; border-radius:999px; background:#0e1522; color:#dce7fb; padding:6px 10px; font-size:12px; cursor:pointer; }
    .chip.active { border-color:#5c769f; background:#16253b; color:#ffffff; }
    .chip .count { opacity:.84; margin-left:4px; }
    .lead-search { min-width:250px; max-width:360px; width:100%; border:1px solid #324058; border-radius:10px; background:#0e1522; color:#e9eef8; padding:8px 10px; font-size:12px; }
    .empty-state { padding:16px; color:#a8b3c9; font-size:13px; text-align:left; }
    .empty-actions { margin-top:10px; display:flex; gap:8px; }
    tr.selected td { background:rgba(56,86,130,.18); }
    .skeleton { height:14px; border-radius:6px; background:linear-gradient(90deg,#182233,#253149,#182233); background-size:220% 100%; animation:pulse 1.2s ease-in-out infinite; }
    .template-modal-backdrop { position:fixed; inset:0; background:rgba(5,8,13,.74); display:none; align-items:center; justify-content:center; z-index:80; }
    .template-modal-backdrop.open { display:flex; }
    .template-modal { width:min(820px,94vw); max-height:86vh; overflow:auto; border:1px solid #273a56; border-radius:14px; background:#0d1524; padding:12px; }
    .template-tabs { display:flex; gap:8px; margin-bottom:8px; }
    .template-tab { border:1px solid #324058; border-radius:999px; background:#0f1624; color:#dbe5f8; padding:6px 12px; font-size:12px; cursor:pointer; }
    .template-tab.active { border-color:#6282b4; background:#1a2a43; color:#fff; }
    .template-toolbar { display:flex; gap:8px; align-items:center; justify-content:space-between; }
    .template-search, .template-filter, .template-var-input { border:1px solid #324058; border-radius:9px; background:#0b1220; color:#e9eef8; padding:8px; font-size:12px; }
    .template-search { flex:1; min-width:180px; }
    .template-grid { margin-top:10px; display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .template-list { border:1px solid #27354a; border-radius:10px; background:#0b1321; max-height:320px; overflow:auto; }
    .template-item { border-bottom:1px solid #1f2c40; padding:8px; cursor:pointer; display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
    .template-item:last-child { border-bottom:none; }
    .template-item.active { background:#16243a; }
    .template-item-main { min-width:0; }
    .template-fav { border:1px solid #31435f; border-radius:8px; background:#0f1828; color:#b9c8e6; min-width:34px; height:30px; cursor:pointer; }
    .template-fav.on { border-color:#8eaee3; color:#ffffff; background:#1b2d49; }
    .template-preview { border:1px solid #27354a; border-radius:10px; background:#0b1321; padding:10px; min-height:160px; }
    .template-vars { margin-top:8px; display:grid; gap:6px; }
    .template-optin-hint { margin-top:10px; color:#f4c7c7; }
    .template-actions { margin-top:10px; display:flex; gap:8px; justify-content:flex-end; }
    .spinner { width:14px; height:14px; border:2px solid rgba(150,170,201,.28); border-top-color:#9eb6da; border-radius:50%; animation:spin .7s linear infinite; display:inline-block; vertical-align:middle; margin-right:6px; }
    .product-modal-backdrop { position:fixed; inset:0; background:rgba(5,8,13,.74); display:none; align-items:center; justify-content:center; z-index:95; }
    .product-modal-backdrop.open { display:flex; }
    .product-modal { width:min(760px,94vw); max-height:88vh; overflow:auto; border:1px solid #273a56; border-radius:14px; background:#0d1524; padding:12px; }
    .product-preview-img { width:100%; max-height:68vh; object-fit:contain; border-radius:10px; border:1px solid #30415b; background:#0a1018; }
    .product-modal-actions { margin-top:10px; display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
    .toast { position:fixed; right:16px; bottom:16px; border:1px solid #385073; background:#15273f; color:#e8f0ff; border-radius:10px; padding:8px 10px; font-size:12px; display:none; z-index:90; }
    .toast.show { display:block; }
    .dev-tools-table{ width:100%; border-collapse:collapse; margin-top:8px; }
    .dev-tools-table th, .dev-tools-table td{ border-bottom:1px solid rgba(63,78,104,.4); padding:6px 4px; text-align:left; font-size:11px; color:#d7e2f5; }
    .dev-tools-table th{ color:#9eb1d2; font-weight:600; font-size:10px; letter-spacing:.04em; text-transform:uppercase; }
    .dev-tools-danger{ border-color:#7b3a3a !important; background:#2a1717 !important; color:#ffd6d6 !important; }
    .dev-tools-empty{ border:1px dashed rgba(110,129,159,.4); border-radius:10px; padding:8px; font-size:11px; color:#9eb1d2; }
    .danger-modal-backdrop{ position:fixed; inset:0; background:rgba(6,10,18,.74); display:none; align-items:center; justify-content:center; z-index:120; }
    .danger-modal-backdrop.open{ display:flex; }
    .danger-modal{ width:min(520px,94vw); border:1px solid #4b2a2a; border-radius:12px; background:#130f14; padding:12px; }
    .danger-modal h3{ margin:0 0 6px; font-size:15px; color:#ffe7e7; }
    .danger-modal .tiny{ color:#d7bcbc; }
    .danger-modal input{ width:100%; margin:8px 0; border:1px solid #5e3a3a; border-radius:9px; background:#0f0a0f; color:#ffe7e7; padding:8px; }
    .danger-modal-actions{ display:flex; justify-content:flex-end; gap:8px; margin-top:8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes msgIn { from { opacity:.4; transform:translateY(3px); } to { opacity:1; transform:translateY(0); } }
    @keyframes pulse { 0% { background-position:0% 50%; } 100% { background-position:100% 50%; } }

    @media (max-width: 1320px) {
      .wrap { grid-template-columns:1fr; }
      .side { position:static; top:auto; max-height:none; overflow:visible; padding-right:0; }
      .kpis { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .pipeline { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .priority-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .conversation { max-height:none; }
      .conversation-grid { grid-template-columns:1fr; overflow:visible; }
      .conversation-quick-actions { justify-content:flex-start; }
      .phone-input { grid-template-columns: 1fr; }
      .composer-actions { grid-template-columns:1fr 1fr; grid-template-rows:none; }
      .funnel-label { display:none; }
      .lead-search { max-width:none; min-width:0; }
      .wa-left { max-height:320px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <main>
      <nav class="nav">
        <a href="/admin${navSuffix}">Commandes</a>
        <a href="/admin/invoices${navSuffix}">Factures</a>
        <a href="/admin/insights${navSuffix}">Insights</a>
        <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
        <a href="/admin/forecast${navSuffix}">Forecast</a>
        <a href="/admin/forecast-v2${navSuffix}">Forecast V2</a>
        <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
        <a href="/blueprint${navSuffix}">Blueprint</a>
        <a href="/admin/spline${navSuffix}">Spline</a>
        <a class="current" href="/admin/whatsapp-intelligence${navSuffix}">Intelligence WhatsApp</a>
        <a href="/whatsapp/priority-inbox${navSuffix}">📥 Priority Inbox</a>
        <a href="/whatsapp-intelligence/workflow${navSuffix}">Manager Approval Flow</a>
        <a href="/whatsapp-intelligence/mobile-lab${navSuffix}">Mobile App</a>
        <a href="/whatsapp-lab${navSuffix}">WhatsApp Lab</a>
        <a href="/whatsapp-logic-diagram${navSuffix}">Logic Diagram</a>
      </nav>
      <h1>Intelligence WhatsApp</h1>
      <p class="sub">Module interne de pilotage de conversion pour les demandes WhatsApp.</p>

      <section class="card">
        <div class="toolbar">
          <div class="toolbar-left">
            <div class="range" id="rangeToggle">
              <button type="button" data-days="7">7j</button>
              <button type="button" data-days="30" class="active">30j</button>
            </div>
            <button id="syncWhatsappBtn" class="small-btn" type="button">Sync WhatsApp</button>
            <button id="importSharedBtn" class="small-btn" type="button">Import from WhatsApp Business</button>
            <button id="createLeadBtn" class="small-btn" type="button" disabled>Entrée via webhook Zoko</button>
          </div>
          <div class="muted" id="statusLine">Prêt</div>
        </div>
        <div id="quickCreatePanel" class="quick-create">
          <div class="quick-grid">
            <input id="newLeadClient" type="text" placeholder="Client" />
            <input id="newLeadPhone" type="text" placeholder="Téléphone WhatsApp" />
            <input id="newLeadCountry" type="text" placeholder="Pays" />
            <input id="newLeadProduct" type="text" placeholder="Produit" />
            <input id="newLeadSource" type="text" placeholder="Source (Manual)" value="Manual" />
          </div>
          <div class="quick-actions">
            <button id="saveLeadBtn" class="small-btn" type="button">Créer</button>
            <button id="cancelLeadBtn" class="small-btn" type="button">Annuler</button>
          </div>
        </div>
        <div id="sharedImportPanel" class="shared-import">
          <div class="shared-grid">
            <input id="sharedClient" type="text" placeholder="Client (optionnel)" />
            <input id="sharedPhone" type="text" placeholder="Téléphone WhatsApp (optionnel)" />
            <input id="sharedCountry" type="text" placeholder="Pays" />
            <input id="sharedProduct" type="text" placeholder="Produit (optionnel)" />
          </div>
          <div class="shared-grid" style="margin-top:8px;">
            <input id="sharedImportedBy" type="text" placeholder="Imported by" value="admin" />
            <input id="sharedOwnerLabels" type="text" placeholder="Owner labels (comma-separated)" value="you,moi,me,admin" />
            <input id="sharedFileInput" type="file" accept=".txt,text/plain" />
            <div class="small-note">Paste export, upload .txt, or add manual messages.</div>
          </div>
          <textarea id="sharedRawText" style="margin-top:8px; min-height:120px;" placeholder="Paste exported chat here..."></textarea>
          <div class="manual-row">
            <select id="sharedManualDirection">
              <option value="IN">IN (client)</option>
              <option value="OUT">OUT (business)</option>
            </select>
            <input id="sharedManualText" type="text" placeholder="Manual message text" />
            <button id="sharedAddManualBtn" class="small-btn" type="button">Add message</button>
          </div>
          <div id="sharedManualCount" class="small-note">Manual messages: 0</div>
          <div class="quick-actions">
            <button id="sharedImportSubmitBtn" class="small-btn" type="button">Import & Analyze</button>
            <button id="sharedImportCancelBtn" class="small-btn" type="button">Cancel</button>
          </div>
        </div>
        <div id="errorBanner" class="error-banner"></div>
        <div id="debugLine" class="debug-line"></div>
        <div class="kpis" id="kpiRow"></div>
        <div class="pipeline" id="pipeline"></div>
        <div id="prioritiesRow" class="priorities"></div>
        <div class="filterbar">
          <div id="quickFilterBar" class="filter-chips">
            <button class="chip active" type="button" data-filter="ALL">All <span class="count" data-count="all">(0)</span></button>
            <button class="chip" type="button" data-filter="URGENT">Urgents ⚠️ <span class="count" data-count="urgent">(0)</span></button>
            <button class="chip" type="button" data-filter="HIGH">High ≥70% <span class="count" data-count="high">(0)</span></button>
            <button class="chip" type="button" data-filter="RISK">At risk &gt;48h <span class="count" data-count="risk">(0)</span></button>
          </div>
          <input id="leadsSearchInput" class="lead-search" type="text" placeholder="Rechercher: nom / téléphone / produit" />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Pays</th>
                <th>Produit</th>
                <th>Stage</th>
                <th>Stage recommandé</th>
                <th>Conv. %</th>
                <th>Première réponse</th>
                <th>Dernière activité</th>
                <th>Risque</th>
                <th>Auto</th>
                <th>Détails</th>
                <th>Notes internes</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="leadRows"></tbody>
          </table>
        </div>
        <section class="conversation" id="conversationPanel">
          <div id="conversationHeader" class="conversation-head conversation-head-rich">
            <div class="chat-topbar">
              <div class="chat-left">
                <div id="conversationAvatar" class="chat-avatar">?</div>
                <div class="conversation-id">
                  <div id="conversationClientName" class="conversation-title">Conversation</div>
                  <div id="conversationHeaderMeta" class="tiny">Sélectionne un lead pour voir la conversation.</div>
                  <div class="tiny" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span id="clientLocalTime"></span>
                    <span id="waitingForBadge" class="wf-badge" style="display:none"></span>
                  </div>
                </div>
              </div>
              <div class="chat-actions-icons">
                <button class="chat-icon-btn" type="button" title="Rechercher">⌕</button>
                <button class="chat-icon-btn" type="button" title="Infos">i</button>
              </div>
            </div>
            <div id="conversationInlineError" class="chat-inline-error"></div>
            <div id="conversationStageMeta" class="conversation-stage-meta"></div>
            <div class="conversation-quick-actions">
              <button id="conversationReclassifyBtn" class="small-btn" type="button">Re-classifier</button>
              <button id="conversationCopyLeadIdBtn" class="small-btn" type="button">Copier ID</button>
              <button id="conversationToggleTestBtn" class="small-btn" type="button">Mark as test</button>
            </div>
          </div>
          <div class="conversation-grid">
            <aside class="wa-left">
              <div class="wa-left-top">
                <div class="wa-left-title">Chats</div>
                <input id="leadSearch" class="wa-search" placeholder="Search name / phone / product" />
                <div class="wa-filters" id="waLeadFilters">
                  <button class="chip is-active" type="button" data-wa-filter="all">All</button>
                  <button class="chip" type="button" data-wa-filter="urgent">Urgent</button>
                  <button class="chip" type="button" data-wa-filter="risk">At risk</button>
                  <button class="chip" type="button" data-wa-filter="high">High ≥70%</button>
                </div>
              </div>
              <div id="leadList" class="wa-lead-list"></div>
            </aside>
            <div class="phone-shell">
              <div id="conversationMessages" class="phone-messages messages-scroll">
                <div class="phone-empty">Sélectionnez une conversation pour commencer.</div>
              </div>
              <section id="aiCardsSection" class="ai-cards-shell">
                <div class="ai-cards-head">
                  <div class="ai-cards-title-wrap">
                    <div class="ai-cards-title">AI Suggestions</div>
                    <div id="aiCardsUpdatedAt" class="ai-cards-updated">—</div>
                  </div>
                  <div class="ai-cards-head-right">
                    <span id="agentStatusPill" class="agent-status-pill">Idle</span>
                    <select id="aiProviderSelect" class="ai-provider-select" aria-label="AI Provider">
                      <option value="claude">Claude</option>
                      <option value="gpt">GPT</option>
                    </select>
                    <button id="aiAnalyzeBtn" class="ai-analyze-btn" type="button">Analyze</button>
                    <button id="aiCardsToggleBtn" class="ai-toggle-btn" type="button">Hide</button>
                    <button id="aiCardsRefreshBtn" class="ai-refresh-btn" type="button" title="Refresh">↻</button>
                  </div>
                </div>
                <div id="aiCardsBody">
                  <div class="ai-tabs" id="aiTabs">
                    <button type="button" class="ai-tab active" data-ai-tab="cards">Suggestions</button>
                    <button type="button" class="ai-tab" data-ai-tab="flow">Agent Flow</button>
                  </div>
                  <div id="aiCardsPanel" class="ai-tab-panel active">
                    <div id="aiCardsList" class="ai-cards-list"></div>
                  </div>
                  <div id="agentFlowPanel" class="ai-tab-panel">
                    <div class="agent-flow-head">
                      <div class="tiny">Pipeline timeline + latest runs</div>
                      <button id="agentRetryBtn" type="button" class="ai-meta-btn">Retry run</button>
                    </div>
                    <div id="agentFlowTimeline" class="agent-flow-timeline"></div>
                    <div id="agentRunsList" class="agent-runs-list"></div>
                    <div id="agentRunDetails" class="agent-run-details"></div>
                  </div>
                </div>
              </section>
              <div class="phone-composer-wrap">
                <div id="sessionStatusNote" class="session-note">Session: vérification...</div>
                <div id="suggestionContextNote" class="suggestion-note">Suggestion basée sur: message entrant + stage.</div>
                <div id="suggestionShell" class="suggestion-shell">
                  <button id="sugToggle" class="sug-toggle" type="button">
                    <span>Suggestions (<span id="sugCount">0</span>)</span>
                    <span style="display:inline-flex;align-items:center;gap:8px;">
                      <span id="sugToggleAction">Hide</span>
                      <span class="chev">⌄</span>
                    </span>
                  </button>
                  <div id="suggestionCards" class="suggestion-cards sug-list"></div>
                </div>
                <div id="suggestionTemplateOptions" class="suggestion-template-options"></div>
                <div class="composer-toolbar">
                  <div class="composer-quick">
                    <button id="openTemplatesBtn" class="small-btn" type="button">Templates</button>
                    <button id="conversationGenerateAiSuggestionsBtn" class="small-btn" type="button">Generate suggestions</button>
                    <button id="conversationSuggestReplyBtn" class="small-btn" type="button">Suggérer</button>
                  </div>
                </div>
                <div id="composerModelButtons" class="composer-models"></div>
                <form id="conversationForm" class="phone-input">
                  <select id="conversationMessageType">
                    <option value="text">Texte</option>
                    <option value="template">Template</option>
                  </select>
                  <textarea id="conversationText" placeholder="Écrire un message…"></textarea>
                  <div class="send-wrap">
                    <button id="conversationSubmitIconBtn" class="send-icon" type="button" aria-label="Envoyer message">➤</button>
                  </div>
                </form>
                <div id="postConfirmQuickActions" class="conversation-stage-actions" style="margin-top:8px;"></div>
              </div>
            </div>
            <aside class="client-context">
              <div class="context-title">Contexte client</div>
              <div id="clientContextMeta" class="context-kv"></div>
              <div class="context-notes-wrap">
                <label for="clientContextNotes" class="tiny">Notes internes</label>
                <textarea id="clientContextNotes" placeholder="Ajouter une note interne"></textarea>
                <button id="saveClientContextNotesBtn" class="small-btn" type="button">Enregistrer notes</button>
              </div>
              <section id="auditPanelWrap" class="audit-wrap">
                <div class="audit-head">
                  <div class="audit-title">Conversation Audit</div>
                  <button type="button" id="auditCopyBtn" class="audit-copy">Copier debug</button>
                </div>
                <div id="auditPanel" class="audit-body"></div>
              </section>
              <div class="context-title">Timeline</div>
              <ul id="clientContextTimeline" class="list"></ul>
              <button id="leadDebugToggleBtn" class="small-btn lead-debug-toggle" type="button">Debug lead (toggle)</button>
              <div id="leadDebugPanel" class="lead-debug-panel"><pre>Debug panel ready.</pre></div>
            </aside>
          </div>
        </section>
      </section>
    </main>

    <aside class="side">
      <section class="card">
        <h2 class="title">Dev Tools</h2>
        <p class="muted">Test conversations cleanup (development only).</p>
        <div class="row" style="margin-bottom:8px;">
          <button id="refreshTestLeadsBtn" class="small-btn" type="button">Refresh test leads</button>
          <button id="deleteAllTestLeadsBtn" class="small-btn dev-tools-danger" type="button">Delete all test conversations</button>
        </div>
        <div id="testLeadsSummary" class="tiny">Loading…</div>
        <div id="testLeadsWrap" style="margin-top:8px;"></div>
      </section>

      <section class="card">
        <h2 class="title">Classification IA</h2>
        <p class="muted">Intention, confiance, raison et prochaine question suggérée.</p>
        <div id="classificationBox" class="box">Clique sur "Classifier avec l’IA" sur un lead.</div>
        <button id="classifySelectedBtn" class="btn" type="button">Classifier avec l'IA</button>
        <button id="applyClassificationBtn" class="btn" type="button">Appliquer le stage</button>
        <button id="copyNextQuestionBtn" class="btn" type="button">Copier la prochaine question</button>
        <button id="addClassificationDraftBtn" class="btn" type="button">Ajouter en brouillon OUT</button>
      </section>

      <section class="card">
        <h2 class="title">Strategic Advisor</h2>
        <p class="muted">Full advisory — readiness, decision, draft message, manager note.</p>
        <button id="strategicAdvisorBtn" class="btn" type="button">Run Strategic Advisor</button>
        <pre id="advisorBox" class="box" style="white-space:pre-wrap;font-size:12px;line-height:1.5;">Select a lead and press the button.</pre>
      </section>

      <section class="card">
        <h2 class="title">Brief business IA quotidien</h2>
        <button id="briefBtn" class="btn" type="button">Générer le brief du jour</button>
        <div id="briefBox" class="box">Aucun brief généré pour le moment.</div>
      </section>

      <section class="card">
        <h2 class="title">Review Suggestions</h2>
        <p class="muted">Valider les suggestions envoyées et labelliser les outcomes.</p>
        <div class="row" style="margin-bottom:8px;">
          <select id="suggestionReviewStatusFilter">
            <option value="OPEN">OPEN</option>
            <option value="REVIEWED">REVIEWED</option>
            <option value="ARCHIVED">ARCHIVED</option>
            <option value="ALL">ALL</option>
          </select>
          <button id="suggestionReviewRefreshBtn" class="small-btn" type="button">Refresh</button>
        </div>
        <div id="suggestionReviewList" class="suggestion-review-list"><div class="tiny">Aucune suggestion chargée.</div></div>
      </section>

      <section class="card">
        <h2 class="title">Learning Stats</h2>
        <p class="muted">Top suggestions by observed outcomes (rolling 90 days).</p>
        <div class="row" style="margin-bottom:8px; gap:6px; flex-wrap:wrap;">
          <input id="learningWindowDaysInput" type="number" min="7" max="365" placeholder="Window days" style="max-width:110px;" />
          <input id="learningMinSamplesInput" type="number" min="1" max="50" placeholder="Min samples" style="max-width:110px;" />
          <input id="learningSuccessWeightInput" type="number" min="0" max="100" placeholder="Success w" style="max-width:110px;" />
          <input id="learningAcceptedWeightInput" type="number" min="0" max="100" placeholder="Accepted w" style="max-width:110px;" />
          <input id="learningLostWeightInput" type="number" min="0" max="100" placeholder="Lost w" style="max-width:110px;" />
        </div>
        <div class="row" style="margin-bottom:8px; gap:6px; flex-wrap:wrap;">
          <input id="learningBoostMinInput" type="number" min="-100" max="0" placeholder="Boost min" style="max-width:110px;" />
          <input id="learningBoostMaxInput" type="number" min="0" max="100" placeholder="Boost max" style="max-width:110px;" />
          <input id="learningSuccessOutcomesInput" type="text" placeholder="Success outcomes (comma)" style="min-width:220px;" />
          <input id="learningFailureOutcomesInput" type="text" placeholder="Failure outcomes (comma)" style="min-width:220px;" />
        </div>
        <div class="row" style="margin-bottom:8px;">
          <button id="learningSettingsSaveBtn" class="small-btn" type="button">Save</button>
          <button id="learningSettingsResetBtn" class="small-btn" type="button">Reset defaults</button>
          <button id="learningSettingsRecomputeBtn" class="small-btn" type="button">Recompute now</button>
          <button id="learningStatsRefreshBtn" class="small-btn" type="button">Refresh</button>
        </div>
        <div id="learningStatsList" class="box">Aucune donnée de learning pour le moment.</div>
      </section>

    </aside>
  </div>

  <div id="leadDrawerBackdrop" class="drawer-backdrop">
    <aside class="drawer">
      <div class="drawer-head">
        <div>
          <h3 id="drawerTitle">Détails du lead</h3>
          <div id="drawerSubtitle" class="tiny"></div>
        </div>
        <button id="drawerCloseBtn" class="x" type="button">Fermer</button>
      </div>
      <section class="section">
        <h4>Résumé</h4>
        <div id="drawerSummary" class="kv"></div>
        <div id="drawerTags"></div>
      </section>
      <section class="section">
        <h4>Pourquoi ce stage est recommandé ?</h4>
        <div id="drawerRules"></div>
        <ul id="drawerEvidence" class="list"></ul>
      </section>
      <section class="section">
        <h4>Détail du score</h4>
        <ul id="drawerScore" class="list"></ul>
        <div id="drawerScoreTotal" class="tiny"></div>
      </section>
      <section class="section">
        <h4>Suggestion IA</h4>
        <div id="drawerAiReason" class="tiny"></div>
        <div id="drawerAiQuestion" class="box" style="min-height:80px;"></div>
        <button id="copyDrawerQuestionBtn" class="small-btn" type="button">Copier</button>
      </section>
      <section class="section">
        <button id="loadRecentMessagesBtn" class="small-btn" type="button">Voir derniers messages</button>
        <ul id="drawerRecentMessages" class="list"></ul>
      </section>
    </aside>
  </div>
  <div id="aiInsightDrawerBackdrop" class="ai-drawer-backdrop">
    <aside class="ai-drawer">
      <div class="ai-drawer-head">
        <div>
          <h3 class="ai-drawer-title">AI Insight</h3>
          <div id="aiInsightDrawerUpdatedAt" class="ai-drawer-updated">Updated —</div>
        </div>
        <button id="aiInsightDrawerCloseBtn" class="ai-drawer-close" type="button">×</button>
      </div>
      <div id="aiInsightDrawerContent"></div>
    </aside>
  </div>
  <div id="templateModalBackdrop" class="template-modal-backdrop">
    <div class="template-modal">
      <div class="drawer-head">
        <div>
          <h3>Templates WhatsApp</h3>
          <div class="tiny">Sélectionner un template approuvé puis envoyer au client.</div>
        </div>
        <button id="templateModalCloseBtn" class="x" type="button">Fermer</button>
      </div>
      <div id="templateTabs" class="template-tabs">
        <button type="button" class="template-tab active" data-tab-category="UTILITY">Utility</button>
        <button type="button" class="template-tab" data-tab-category="MARKETING">Marketing</button>
        <button type="button" class="template-tab" data-tab-category="ALL">All</button>
      </div>
      <div class="template-toolbar">
        <input id="templateSearchInput" class="template-search" type="text" placeholder="Rechercher template..." />
        <button id="templateFavoritesOnlyBtn" type="button" class="small-btn">★ Favoris</button>
      </div>
      <div class="template-grid">
        <div id="templateList" class="template-list"></div>
        <div class="template-preview">
          <div id="templatePreviewTitle"><strong>Aucun template sélectionné</strong></div>
          <div id="templatePreviewBody" class="tiny" style="margin-top:6px;">Choisir un template dans la liste.</div>
          <div id="templateVariables" class="template-vars"></div>
          <div id="templateOptInHint" class="tiny template-optin-hint" style="display:none;">Opt-in requis pour envoyer un message marketing.</div>
          <button id="templateMarkOptInBtn" class="small-btn" type="button" style="display:none;">Marquer opt-in</button>
        </div>
      </div>
      <div class="template-actions">
        <button id="templateSendBtn" class="btn" type="button">Envoyer template</button>
      </div>
    </div>
  </div>
  <div id="productModalBackdrop" class="product-modal-backdrop">
    <div class="product-modal">
      <div class="drawer-head">
        <div>
          <h3 id="productModalTitle">Produit</h3>
          <div id="productModalSubtitle" class="tiny"></div>
        </div>
        <button id="productModalCloseBtn" class="x" type="button">Fermer</button>
      </div>
      <div id="productModalBody" style="margin-top:10px;"></div>
      <div class="product-modal-actions">
        <a id="productModalOpenLink" class="small-btn" href="#" target="_blank" rel="noopener noreferrer">Ouvrir fiche produit</a>
      </div>
    </div>
  </div>
  <div id="productPopover" class="product-popover"></div>
  <div id="dangerConfirmBackdrop" class="danger-modal-backdrop">
    <div class="danger-modal">
      <h3>Confirm deletion</h3>
      <div id="dangerConfirmText" class="tiny">This action is irreversible.</div>
      <input id="dangerConfirmInput" type="text" placeholder="Type DELETE to confirm" />
      <div class="danger-modal-actions">
        <button id="dangerCancelBtn" class="small-btn" type="button">Cancel</button>
        <button id="dangerConfirmBtn" class="small-btn dev-tools-danger" type="button" disabled>Delete</button>
      </div>
    </div>
  </div>
  <div id="uiToast" class="toast"></div>

  <script>
    // App Bridge intentionally disabled on this page to avoid embedded click interception issues.
    const IS_DEV = ${JSON.stringify(env.NODE_ENV !== "production")};
    const TEST_DELETION_ENABLED = ${JSON.stringify(isTestDeletionEnabled())};

    const STAGES = ["NEW","PRODUCT_INTEREST","QUALIFICATION_PENDING","QUALIFIED","PRICE_SENT","VIDEO_PROPOSED","DEPOSIT_PENDING","CONFIRMED","CONVERTED","LOST"];
    const rawQ = new URLSearchParams(window.location.search);
    const q = new URLSearchParams();
    const queryAllowList = new Set(["tab"]);
    rawQ.forEach((value, key) => {
      if (queryAllowList.has(String(key || "").toLowerCase())) q.set(key, value);
    });
    const qs = q.toString() ? "?" + q.toString() : "";

    let selectedDays = 30;
    let selectedStage = "ALL";
    let leads = [];
    let allLeads = [];
    let leadMessages = [];
    let leadQuotes = [];
    let leadTimelineEvents = [];
    let selectedLeadId = "";
    let activeQuickFilter = "ALL";
    let searchQuery = "";
    let leadSidebarFilter = "all";
    let leadSidebarSearch = "";
    let leadSidebarKeyboardIndex = -1;
    let leadSidebarVisibleIds = [];
    let leadSidebarSearchTimer = null;
    let topLeadScoreMap = new Map();
    let topLeadItems = [];
    let activeDrawerLeadId = "";
    let selectedFollowUpType = "48H_PRICE";
    let sharedImportManualMessages = [];
    let latestLeadInsights = null;
    const REALTIME_POLL_MS = 2500;
    const REALTIME_LEADS_POLL_MS = 7000;
    let realtimePollTimer = null;
    let realtimePollInFlight = false;
    let realtimeLeadsPollTimer = null;
    let realtimeLeadsPollInFlight = false;
    let lastLeadsSignature = "";
    let lastLeadMessagesSignature = "";
    let lastLeadTimelineSignature = "";
    let productParsingOk = true;
    let productPreviewsMap = {};
    let pendingSuggestionFeedback = null;
    window.selectedLeadId = selectedLeadId;

    const statusLineEl = document.getElementById("statusLine");
    const errorBannerEl = document.getElementById("errorBanner");
    const debugLineEl = document.getElementById("debugLine");
    const productPopoverEl = document.getElementById("productPopover");
    const refreshTestLeadsBtnEl = document.getElementById("refreshTestLeadsBtn");
    const deleteAllTestLeadsBtnEl = document.getElementById("deleteAllTestLeadsBtn");
    const testLeadsSummaryEl = document.getElementById("testLeadsSummary");
    const testLeadsWrapEl = document.getElementById("testLeadsWrap");
    const dangerConfirmBackdropEl = document.getElementById("dangerConfirmBackdrop");
    const dangerConfirmTextEl = document.getElementById("dangerConfirmText");
    const dangerConfirmInputEl = document.getElementById("dangerConfirmInput");
    const dangerCancelBtnEl = document.getElementById("dangerCancelBtn");
    const dangerConfirmBtnEl = document.getElementById("dangerConfirmBtn");
    const kpiRowEl = document.getElementById("kpiRow");
    const pipelineEl = document.getElementById("pipeline");
    const leadRowsEl = document.getElementById("leadRows");
    const followupBoxEl = document.getElementById("followupBox");
    const briefBoxEl = document.getElementById("briefBox");
    const classificationBoxEl = document.getElementById("classificationBox");
    const advisorBoxEl = document.getElementById("advisorBox");
    const strategicAdvisorBtnEl = document.getElementById("strategicAdvisorBtn");
    const classifySelectedBtnEl = document.getElementById("classifySelectedBtn");
    const applyClassificationBtnEl = document.getElementById("applyClassificationBtn");
    const copyNextQuestionBtnEl = document.getElementById("copyNextQuestionBtn");
    const addClassificationDraftBtnEl = document.getElementById("addClassificationDraftBtn");
    const generateFollowupSelectedBtnEl = document.getElementById("generateFollowupSelectedBtn");
    const addFollowupDraftBtnEl = document.getElementById("addFollowupDraftBtn");
    const copyFollowupBtnEl = document.getElementById("copyFollowupBtn");
    const followupScenarioButtonsEl = document.getElementById("followupScenarioButtons");
    const createLeadBtnEl = document.getElementById("createLeadBtn");
    const importSharedBtnEl = document.getElementById("importSharedBtn");
    const syncWhatsappBtnEl = document.getElementById("syncWhatsappBtn");
    const quickCreatePanelEl = document.getElementById("quickCreatePanel");
    const sharedImportPanelEl = document.getElementById("sharedImportPanel");
    const saveLeadBtnEl = document.getElementById("saveLeadBtn");
    const cancelLeadBtnEl = document.getElementById("cancelLeadBtn");
    const sharedImportSubmitBtnEl = document.getElementById("sharedImportSubmitBtn");
    const sharedImportCancelBtnEl = document.getElementById("sharedImportCancelBtn");
    const sharedFileInputEl = document.getElementById("sharedFileInput");
    const sharedRawTextEl = document.getElementById("sharedRawText");
    const sharedClientEl = document.getElementById("sharedClient");
    const sharedPhoneEl = document.getElementById("sharedPhone");
    const sharedCountryEl = document.getElementById("sharedCountry");
    const sharedProductEl = document.getElementById("sharedProduct");
    const sharedImportedByEl = document.getElementById("sharedImportedBy");
    const sharedOwnerLabelsEl = document.getElementById("sharedOwnerLabels");
    const sharedManualDirectionEl = document.getElementById("sharedManualDirection");
    const sharedManualTextEl = document.getElementById("sharedManualText");
    const sharedAddManualBtnEl = document.getElementById("sharedAddManualBtn");
    const sharedManualCountEl = document.getElementById("sharedManualCount");
    const newLeadClientEl = document.getElementById("newLeadClient");
    const newLeadPhoneEl = document.getElementById("newLeadPhone");
    const newLeadCountryEl = document.getElementById("newLeadCountry");
    const newLeadProductEl = document.getElementById("newLeadProduct");
    const newLeadSourceEl = document.getElementById("newLeadSource");
    const drawerBackdropEl = document.getElementById("leadDrawerBackdrop");
    const drawerCloseBtnEl = document.getElementById("drawerCloseBtn");
    const drawerTitleEl = document.getElementById("drawerTitle");
    const drawerSubtitleEl = document.getElementById("drawerSubtitle");
    const drawerSummaryEl = document.getElementById("drawerSummary");
    const drawerTagsEl = document.getElementById("drawerTags");
    const drawerRulesEl = document.getElementById("drawerRules");
    const drawerEvidenceEl = document.getElementById("drawerEvidence");
    const drawerScoreEl = document.getElementById("drawerScore");
    const drawerScoreTotalEl = document.getElementById("drawerScoreTotal");
    const drawerAiReasonEl = document.getElementById("drawerAiReason");
    const drawerAiQuestionEl = document.getElementById("drawerAiQuestion");
    const copyDrawerQuestionBtnEl = document.getElementById("copyDrawerQuestionBtn");
    const loadRecentMessagesBtnEl = document.getElementById("loadRecentMessagesBtn");
    const drawerRecentMessagesEl = document.getElementById("drawerRecentMessages");
    const prioritiesRowEl = document.getElementById("prioritiesRow");
    const quickFilterBarEl = document.getElementById("quickFilterBar");
    const leadsSearchInputEl = document.getElementById("leadsSearchInput");
    const leadListEl = document.getElementById("leadList");
    const leadSearchEl = document.getElementById("leadSearch");
    const waLeadFiltersEl = document.getElementById("waLeadFilters");
    const conversationClientNameEl = document.getElementById("conversationClientName");
    const conversationAvatarEl = document.getElementById("conversationAvatar");
    const conversationStageMetaEl = document.getElementById("conversationStageMeta");
    const conversationPanelEl = document.getElementById("conversationPanel");
    const conversationMessagesEl = document.getElementById("conversationMessages");
    const conversationHeaderMetaEl = document.getElementById("conversationHeaderMeta");
    const clientLocalTimeEl = document.getElementById("clientLocalTime");
    const waitingForBadgeEl = document.getElementById("waitingForBadge");
    const conversationInlineErrorEl = document.getElementById("conversationInlineError");
    const conversationFormEl = document.getElementById("conversationForm");
    const conversationMessageTypeEl = document.getElementById("conversationMessageType");
    const conversationSuggestReplyBtnEl = document.getElementById("conversationSuggestReplyBtn");
    const conversationGenerateAiSuggestionsBtnEl = document.getElementById("conversationGenerateAiSuggestionsBtn");
    const conversationReclassifyBtnEl = document.getElementById("conversationReclassifyBtn");
    const conversationCopyLeadIdBtnEl = document.getElementById("conversationCopyLeadIdBtn");
    const conversationToggleTestBtnEl = document.getElementById("conversationToggleTestBtn");
    const openTemplatesBtnEl = document.getElementById("openTemplatesBtn");
    const conversationTextEl = document.getElementById("conversationText");
    const conversationSubmitIconBtnEl = document.getElementById("conversationSubmitIconBtn");
    const postConfirmQuickActionsEl = document.getElementById("postConfirmQuickActions");
    const sessionStatusNoteEl = document.getElementById("sessionStatusNote");
    const suggestionContextNoteEl = document.getElementById("suggestionContextNote");
    const suggestionShellEl = document.getElementById("suggestionShell");
    const sugToggleEl = document.getElementById("sugToggle");
    const sugToggleActionEl = document.getElementById("sugToggleAction");
    const sugCountEl = document.getElementById("sugCount");
    const suggestionCardsEl = document.getElementById("suggestionCards");
    const aiCardsSectionEl = document.getElementById("aiCardsSection");
    const aiCardsBodyEl = document.getElementById("aiCardsBody");
    const aiTabsEl = document.getElementById("aiTabs");
    const aiCardsPanelEl = document.getElementById("aiCardsPanel");
    const aiCardsListEl = document.getElementById("aiCardsList");
    const aiCardsUpdatedAtEl = document.getElementById("aiCardsUpdatedAt");
    const aiCardsToggleBtnEl = document.getElementById("aiCardsToggleBtn");
    const aiProviderSelectEl = document.getElementById("aiProviderSelect");
    const aiAnalyzeBtnEl = document.getElementById("aiAnalyzeBtn");
    const aiCardsRefreshBtnEl = document.getElementById("aiCardsRefreshBtn");
    const agentStatusPillEl = document.getElementById("agentStatusPill");
    const agentFlowPanelEl = document.getElementById("agentFlowPanel");
    const agentFlowTimelineEl = document.getElementById("agentFlowTimeline");
    const agentRunsListEl = document.getElementById("agentRunsList");
    const agentRunDetailsEl = document.getElementById("agentRunDetails");
    const agentRetryBtnEl = document.getElementById("agentRetryBtn");
    const aiInsightDrawerBackdropEl = document.getElementById("aiInsightDrawerBackdrop");
    const aiInsightDrawerCloseBtnEl = document.getElementById("aiInsightDrawerCloseBtn");
    const aiInsightDrawerUpdatedAtEl = document.getElementById("aiInsightDrawerUpdatedAt");
    const aiInsightDrawerContentEl = document.getElementById("aiInsightDrawerContent");
    const auditPanelEl = document.getElementById("auditPanel");
    const auditCopyBtnEl = document.getElementById("auditCopyBtn");
    const suggestionTemplateOptionsEl = document.getElementById("suggestionTemplateOptions");
    const quickMarkPriceBtnEl = document.getElementById("quickMarkPriceBtn");
    const conversationStageActionsEl = document.getElementById("conversationStageActions");
    const composerModelButtonsEl = document.getElementById("composerModelButtons");
    const clientContextMetaEl = document.getElementById("clientContextMeta");
    const clientContextTimelineEl = document.getElementById("clientContextTimeline");
    const clientContextNotesEl = document.getElementById("clientContextNotes");
    const leadDebugToggleBtnEl = document.getElementById("leadDebugToggleBtn");
    const leadDebugPanelEl = document.getElementById("leadDebugPanel");
    const saveClientContextNotesBtnEl = document.getElementById("saveClientContextNotesBtn");
    const aiSettingsFormEl = document.getElementById("aiSettingsForm");
    const aiDefaultLanguageEl = document.getElementById("aiDefaultLanguage");
    const aiToneEl = document.getElementById("aiTone");
    const aiMessageLengthEl = document.getElementById("aiMessageLength");
    const aiIncludePricePolicyEl = document.getElementById("aiIncludePricePolicy");
    const aiIncludeVideoCallEl = document.getElementById("aiIncludeVideoCall");
    const aiUrgencyStyleEl = document.getElementById("aiUrgencyStyle");
    const aiNoEmojisEl = document.getElementById("aiNoEmojis");
    const aiAvoidFollowUpPhraseEl = document.getElementById("aiAvoidFollowUpPhrase");
    const aiSignatureEnabledEl = document.getElementById("aiSignatureEnabled");
    const aiSignatureTextEl = document.getElementById("aiSignatureText");
    const suggestionReviewStatusFilterEl = document.getElementById("suggestionReviewStatusFilter");
    const suggestionReviewRefreshBtnEl = document.getElementById("suggestionReviewRefreshBtn");
    const suggestionReviewListEl = document.getElementById("suggestionReviewList");
    const learningStatsRefreshBtnEl = document.getElementById("learningStatsRefreshBtn");
    const learningStatsListEl = document.getElementById("learningStatsList");
    const learningWindowDaysInputEl = document.getElementById("learningWindowDaysInput");
    const learningMinSamplesInputEl = document.getElementById("learningMinSamplesInput");
    const learningSuccessWeightInputEl = document.getElementById("learningSuccessWeightInput");
    const learningAcceptedWeightInputEl = document.getElementById("learningAcceptedWeightInput");
    const learningLostWeightInputEl = document.getElementById("learningLostWeightInput");
    const learningBoostMinInputEl = document.getElementById("learningBoostMinInput");
    const learningBoostMaxInputEl = document.getElementById("learningBoostMaxInput");
    const learningSuccessOutcomesInputEl = document.getElementById("learningSuccessOutcomesInput");
    const learningFailureOutcomesInputEl = document.getElementById("learningFailureOutcomesInput");
    const learningSettingsSaveBtnEl = document.getElementById("learningSettingsSaveBtn");
    const learningSettingsResetBtnEl = document.getElementById("learningSettingsResetBtn");
    const learningSettingsRecomputeBtnEl = document.getElementById("learningSettingsRecomputeBtn");
    const templateModalBackdropEl = document.getElementById("templateModalBackdrop");
    const templateModalCloseBtnEl = document.getElementById("templateModalCloseBtn");
    const templateTabsEl = document.getElementById("templateTabs");
    const templateSearchInputEl = document.getElementById("templateSearchInput");
    const templateFavoritesOnlyBtnEl = document.getElementById("templateFavoritesOnlyBtn");
    const templateListEl = document.getElementById("templateList");
    const templatePreviewTitleEl = document.getElementById("templatePreviewTitle");
    const templatePreviewBodyEl = document.getElementById("templatePreviewBody");
    const templateVariablesEl = document.getElementById("templateVariables");
    const templateOptInHintEl = document.getElementById("templateOptInHint");
    const templateMarkOptInBtnEl = document.getElementById("templateMarkOptInBtn");
    const templateSendBtnEl = document.getElementById("templateSendBtn");
    const productModalBackdropEl = document.getElementById("productModalBackdrop");
    const productModalCloseBtnEl = document.getElementById("productModalCloseBtn");
    const productModalTitleEl = document.getElementById("productModalTitle");
    const productModalSubtitleEl = document.getElementById("productModalSubtitle");
    const productModalBodyEl = document.getElementById("productModalBody");
    const productModalOpenLinkEl = document.getElementById("productModalOpenLink");
    const uiToastEl = document.getElementById("uiToast");
    let lastClassification = null;
    let isSessionOpen = true;
    let sessionExpiresAt = null;
    let templatesCache = [];
    let filteredTemplates = [];
    let selectedTemplateId = "";
    let templateCategoryTab = "UTILITY";
    let templateFavoritesOnly = false;
    let templateFavorites = new Set();
    let composerStageTemplateButtons = [];
    let composerTemplateLoadToken = 0;
    let suggestionReviewItems = [];
    let learningSettings = null;
    let currentSuggestionCards = [];
    let currentSuggestionLeadId = "";
    let currentAiLatest = null;
    let aiActiveTab = "cards";
    let aiCardsLoading = false;
    let aiCardsError = "";
    let aiCardsOpen = true;
    let aiAdvisorProvider = "claude";
    let aiAnalyzeLoading = false;
    let aiCardSendingMap = {};
    let aiCardFailedIndexMap = {};
    let aiInsightDrawerOpen = false;
    const aiInsightSelectedByLead = {};
    let currentAiFlow = null;
    let aiRunsItems = [];
    let aiFlowLoading = false;
    let aiFlowError = "";
    let aiSelectedRunId = "";
    let aiQueuedPollTimer = null;
    let aiQueuedPollAttempts = 0;
    let suggestionExpandedIds = new Set();
    let suggestionShowAll = false;
    let suggestionPanelOpen = true;
    const sugAutoCollapsedMap = (() => {
      const root = window;
      if (!root.__sugAutoCollapsed || typeof root.__sugAutoCollapsed !== "object") {
        root.__sugAutoCollapsed = {};
      }
      return root.__sugAutoCollapsed;
    })();
    let suggestionElapsedTimer = null;
    let clientLocalTimeTicker = null;
    let latestAuditPayload = null;
    let auditCopyWired = false;
    let leadDebugOpen = false;
    let leadDebugData = null;
    const productPreviewCache = new Map();
    let testLeads = [];
    let pendingDangerAction = null;

    try {
      const storedProvider = window.localStorage.getItem("wa_ai_advisor_provider");
      aiAdvisorProvider = resolveAiAdvisorProvider(storedProvider || "claude");
    } catch {
      aiAdvisorProvider = "claude";
    }
    if (aiProviderSelectEl instanceof HTMLSelectElement) {
      aiProviderSelectEl.value = aiAdvisorProvider;
    }

    resetAiCardsState();
    renderAiCards();
    setAiActiveTab("cards");

    function esc(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function fmtPct(value) {
      const n = Number(value || 0);
      return n.toFixed(1).replace(/\\.0$/, "") + "%";
    }

    function fmtMinutes(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return "0m";
      const h = Math.floor(n / 60);
      const m = Math.round(n % 60);
      return h ? (String(h) + "h" + String(m).padStart(2, "0") + "m") : (String(m) + "m");
    }

    function fmtDate(value) {
      const d = new Date(String(value || ""));
      if (Number.isNaN(d.getTime())) return "-";
      return d.toLocaleString("fr-FR", { dateStyle:"short", timeStyle:"short" });
    }

    function fmtRelativeShort(value) {
      const d = new Date(String(value || ""));
      if (Number.isNaN(d.getTime())) return "—";
      const diffMs = Date.now() - d.getTime();
      if (!Number.isFinite(diffMs)) return fmtDate(value);
      const mins = Math.round(diffMs / 60000);
      if (mins < 1) return "updated now";
      if (mins < 60) return "updated " + String(mins) + "m ago";
      const hours = Math.round(mins / 60);
      if (hours < 24) return "updated " + String(hours) + "h ago";
      return "updated " + d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
    }

    function resetAiCardsState() {
      currentAiLatest = null;
      aiCardsLoading = false;
      aiCardsError = "";
      aiCardSendingMap = {};
      aiCardFailedIndexMap = {};
      currentAiFlow = null;
      aiRunsItems = [];
      aiFlowLoading = false;
      aiFlowError = "";
      aiSelectedRunId = "";
      if (aiQueuedPollTimer) {
        clearTimeout(aiQueuedPollTimer);
        aiQueuedPollTimer = null;
      }
      aiQueuedPollAttempts = 0;
      renderAgentFlow();
      renderAgentStatusPill();
    }

    function renderAgentStatusPill() {
      if (!agentStatusPillEl) return;
      const payload = currentAiLatest && typeof currentAiLatest === "object" ? currentAiLatest : null;
      const status = String(payload && payload.status ? payload.status : "").toLowerCase();
      agentStatusPillEl.classList.remove("agent-status-pill--running", "agent-status-pill--ok", "agent-status-pill--error");
      if (status === "queued") {
        agentStatusPillEl.classList.add("agent-status-pill--running");
        const model = String(payload && payload.model ? payload.model : "Claude");
        agentStatusPillEl.textContent = "Running · " + model;
        return;
      }
      if (status === "success") {
        agentStatusPillEl.classList.add("agent-status-pill--ok");
        const model = String(payload && payload.model ? payload.model : "Claude");
        const latency = payload && payload.latencyMs != null ? String(payload.latencyMs) + "ms" : "—";
        agentStatusPillEl.textContent = "Updated · " + model + " · " + latency;
        return;
      }
      if (status === "error" || aiCardsError) {
        agentStatusPillEl.classList.add("agent-status-pill--error");
        const model = String(payload && payload.model ? payload.model : "Claude");
        agentStatusPillEl.textContent = "Error · " + model;
        return;
      }
      agentStatusPillEl.textContent = "Idle";
    }

    function setAiActiveTab(tab) {
      aiActiveTab = tab === "flow" ? "flow" : "cards";
      if (aiCardsPanelEl) aiCardsPanelEl.classList.toggle("active", aiActiveTab === "cards");
      if (agentFlowPanelEl) agentFlowPanelEl.classList.toggle("active", aiActiveTab === "flow");
      if (aiTabsEl) {
        aiTabsEl.querySelectorAll("[data-ai-tab]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const val = String(node.getAttribute("data-ai-tab") || "");
          node.classList.toggle("active", val === aiActiveTab);
        });
      }
      if (aiActiveTab === "flow") {
        renderAgentFlow();
      }
    }

    function setAiCardsOpen(nextOpen) {
      aiCardsOpen = Boolean(nextOpen);
      if (aiCardsBodyEl instanceof HTMLElement) {
        aiCardsBodyEl.style.display = aiCardsOpen ? "" : "none";
      }
      if (aiCardsToggleBtnEl instanceof HTMLButtonElement) {
        aiCardsToggleBtnEl.textContent = aiCardsOpen ? "Hide" : "Show";
      }
    }

    function resolveAiAdvisorProvider(raw) {
      const normalized = String(raw || "").trim().toLowerCase();
      return normalized === "gpt" ? "gpt" : "claude";
    }

    function setAiAdvisorProvider(nextProvider) {
      aiAdvisorProvider = resolveAiAdvisorProvider(nextProvider);
      if (aiProviderSelectEl instanceof HTMLSelectElement) {
        aiProviderSelectEl.value = aiAdvisorProvider;
      }
      try {
        window.localStorage.setItem("wa_ai_advisor_provider", aiAdvisorProvider);
      } catch {
        // best effort
      }
    }

    function renderAgentFlow() {
      if (!agentFlowTimelineEl || !agentRunsListEl || !agentRunDetailsEl) return;
      if (aiFlowLoading) {
        agentFlowTimelineEl.innerHTML = '<div class="ai-loading">Loading agent flow...</div>';
      } else if (aiFlowError) {
        agentFlowTimelineEl.innerHTML = '<div class="ai-error">Agent flow unavailable — retry</div>';
      } else {
        const steps = currentAiFlow && Array.isArray(currentAiFlow.flowSteps) ? currentAiFlow.flowSteps : [];
        agentFlowTimelineEl.innerHTML = steps.length
          ? steps.map((step) => {
              const key = String(step && step.key ? step.key : "").replace(/_/g, " ");
              const status = String(step && step.status ? step.status : "pending").toLowerCase();
              const at = step && step.at ? fmtRelativeShort(step.at) : "—";
              return (
                '<div class="agent-flow-step">' +
                  '<div><strong>' + esc(key) + '</strong><div class="agent-run-meta">' + esc(at) + "</div></div>" +
                  '<span class="s ' + esc(status) + '">' + esc(status) + "</span>" +
                "</div>"
              );
            }).join("")
          : '<div class="ai-empty">No flow data yet.</div>';
      }

      agentRunsListEl.innerHTML = aiRunsItems.length
        ? aiRunsItems.map((run) => {
            const id = String(run && run.id ? run.id : "");
            const status = String(run && run.status ? run.status : "").toLowerCase();
            const trigger = String(run && run.trigger_source ? run.trigger_source : "message_persisted");
            const lat = run && run.latency_ms != null ? String(run.latency_ms) + "ms" : "—";
            const cost = String(run && run.estimated_cost_label ? run.estimated_cost_label : "—");
            const at = run && run.created_at ? fmtRelativeShort(run.created_at) : "—";
            return (
              '<button type="button" class="agent-run-row ' + (aiSelectedRunId === id ? "active" : "") + '" data-ai-run-id="' + esc(id) + '">' +
                '<div><div>' + esc(status.toUpperCase()) + '</div><div class="agent-run-meta">' + esc(trigger) + " · " + esc(at) + "</div></div>" +
                '<div class="agent-run-meta">' + esc(lat + " · " + cost) + "</div>" +
              "</button>"
            );
          }).join("")
        : '<div class="ai-empty" style="margin:8px;">No runs yet.</div>';

      const selected =
        aiRunsItems.find((run) => String(run && run.id ? run.id : "") === String(aiSelectedRunId || "")) ||
        (currentAiFlow && currentAiFlow.latestRun ? currentAiFlow.latestRun : null);
      if (!selected) {
        agentRunDetailsEl.innerHTML = '<div class="tiny">No run selected.</div>';
        return;
      }
      const stage = selected && selected.stage && typeof selected.stage === "object" ? selected.stage : {};
      const urgency = selected && selected.urgency && typeof selected.urgency === "object" ? selected.urgency : {};
      const stageValue = String(stage && stage.value ? stage.value : "UNKNOWN");
      const stageConf = Number(stage && stage.confidence != null ? stage.confidence : 0.5);
      const confPct = Math.round(Math.max(0, Math.min(1, stageConf)) * 100);
      agentRunDetailsEl.innerHTML =
        '<div class="row"><span class="tiny">Run</span><span>' + esc(String(selected.runId || selected.id || "—")) + "</span></div>" +
        '<div class="row"><span class="tiny">Status</span><span>' + esc(String(selected.status || "—")) + "</span></div>" +
        '<div class="row"><span class="tiny">Model</span><span>' + esc(String(selected.model || "—")) + "</span></div>" +
        '<div class="row"><span class="tiny">Latency</span><span>' + esc(selected.latencyMs == null && selected.latency_ms == null ? "—" : String(selected.latencyMs ?? selected.latency_ms) + " ms") + "</span></div>" +
        '<div class="row"><span class="tiny">Trigger</span><span>' + esc(String(selected.triggerSource || selected.trigger_source || "message_persisted")) + "</span></div>" +
        '<div class="row"><span class="tiny">Stage</span><span>' + esc(stageValue + " (" + confPct + "%)") + "</span></div>" +
        '<div class="row"><span class="tiny">Urgency</span><span>' + esc(String(urgency && urgency.level ? urgency.level : "low")) + "</span></div>" +
        '<div class="row"><span class="tiny">Tokens</span><span>' + esc(String(selected.tokensIn ?? selected.tokens_in ?? "—") + " / " + String(selected.tokensOut ?? selected.tokens_out ?? "—")) + "</span></div>" +
        '<div class="row"><span class="tiny">Cost (est.)</span><span>' + esc(String(selected.estimatedCostLabel || selected.estimated_cost_label || "—")) + "</span></div>";
    }

    function scheduleAiQueuedPoll(leadId) {
      if (aiQueuedPollTimer) {
        clearTimeout(aiQueuedPollTimer);
        aiQueuedPollTimer = null;
      }
      if (!leadId) return;
      if (aiQueuedPollAttempts >= 5) return;
      aiQueuedPollAttempts += 1;
      aiQueuedPollTimer = setTimeout(async () => {
        const current = currentLeadId();
        if (!current || String(current) !== String(leadId)) return;
        await loadAiLatestForLead(leadId, { silent: true });
        await loadAiFlowForLead(leadId, { silent: true });
      }, 2000);
    }

    async function loadAiFlowForLead(leadId, opts) {
      const options = opts && typeof opts === "object" ? opts : {};
      if (!leadId) {
        currentAiFlow = null;
        aiRunsItems = [];
        aiFlowLoading = false;
        aiFlowError = "";
        aiSelectedRunId = "";
        renderAgentFlow();
        return;
      }
      aiFlowLoading = !options.silent;
      aiFlowError = "";
      renderAgentFlow();
      try {
        const [latestResp, runsResp] = await Promise.all([
          fetch("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-flow-latest" + qs),
          fetch("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-runs?limit=20" + (qs ? "&" + q.toString() : ""))
        ]);

        let latestPayload = null;
        if (latestResp.status !== 204) {
          const lt = await latestResp.text();
          try { latestPayload = lt ? JSON.parse(lt) : null; } catch { latestPayload = null; }
        }
        const runsText = await runsResp.text();
        let runsPayload = null;
        try { runsPayload = runsText ? JSON.parse(runsText) : null; } catch { runsPayload = null; }

        if (!latestResp.ok && latestResp.status !== 204) {
          throw new Error((latestPayload && (latestPayload.error || latestPayload.message)) || "ai_flow_latest_failed");
        }
        if (!runsResp.ok) {
          throw new Error((runsPayload && (runsPayload.error || runsPayload.message)) || "ai_runs_failed");
        }
        currentAiFlow = latestPayload && typeof latestPayload === "object" ? latestPayload : null;
        aiRunsItems = runsPayload && Array.isArray(runsPayload.items) ? runsPayload.items : [];
        if (!aiSelectedRunId && aiRunsItems[0] && aiRunsItems[0].id) {
          aiSelectedRunId = String(aiRunsItems[0].id);
        }
        aiFlowError = "";
      } catch (error) {
        aiFlowError = String(error && error.message ? error.message : "agent_flow_failed");
        currentAiFlow = null;
        aiRunsItems = [];
      } finally {
        aiFlowLoading = false;
        renderAgentFlow();
      }
    }

    function renderAiCards() {
      if (!aiCardsSectionEl || !aiCardsListEl) return;
      renderAgentStatusPill();
      if (!selectedLead()) {
        aiCardsSectionEl.style.display = "none";
        return;
      }
      aiCardsSectionEl.style.display = "";
      setAiCardsOpen(aiCardsOpen);
      if (aiCardsRefreshBtnEl instanceof HTMLButtonElement) {
        aiCardsRefreshBtnEl.disabled = aiCardsLoading || aiAnalyzeLoading;
      }
      if (aiAnalyzeBtnEl instanceof HTMLButtonElement) {
        aiAnalyzeBtnEl.disabled = aiCardsLoading || aiAnalyzeLoading;
        aiAnalyzeBtnEl.textContent = aiAnalyzeLoading ? "Analyzing..." : "Analyze";
      }

      if (aiCardsLoading) {
        aiCardsListEl.innerHTML =
          '<div class="ai-loading">' +
            '<div>Loading latest AI suggestions...</div>' +
            '<div class="skeleton" style="height:12px"></div>' +
            '<div class="skeleton" style="height:12px; width:84%"></div>' +
          "</div>";
        return;
      }

      if (aiCardsError) {
        aiCardsListEl.innerHTML = '<div class="ai-error">AI unavailable — retry</div>';
        return;
      }

      const payload = currentAiLatest && typeof currentAiLatest === "object" ? currentAiLatest : null;
      const suggestionsRaw = payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
      const suggestions = suggestionsRaw.filter((item) => {
        const bubbles = getAiSuggestionMessages(item);
        return bubbles.length > 0;
      });
      const lead = selectedLead();
      if (lead && suggestions.length) {
        const selectedId = getAiInsightSelectedSuggestionId(lead.id);
        if (!selectedId || !suggestions.some((item) => String(item && item.id ? item.id : "") === selectedId)) {
          setAiInsightSelectedSuggestionId(lead.id, String(suggestions[0] && suggestions[0].id ? suggestions[0].id : ""));
        }
      }
      if (aiCardsUpdatedAtEl) {
        aiCardsUpdatedAtEl.textContent = payload && payload.createdAt ? fmtRelativeShort(payload.createdAt) : "—";
      }
      if (!suggestions.length) {
        aiCardsListEl.innerHTML = '<div class="ai-empty">AI suggestion unavailable</div>';
        return;
      }

      aiCardsListEl.innerHTML = suggestions.slice(0, 3).map((card) => {
        const id = String(card && card.id ? card.id : "");
        const bubbles = getAiSuggestionMessages(card);
        const sending = Boolean(aiCardSendingMap[id]);
        const failedIndex = Number(aiCardFailedIndexMap[id]);
        const hasFailedIndex = Number.isFinite(failedIndex) && failedIndex >= 0;
        const failureLabel = hasFailedIndex ? ("Message " + String(failedIndex + 1) + " failed") : "";
        return (
          '<article class="ai-card" data-ai-card-id="' + esc(id) + '">' +
            '<div class="ai-bubbles">' +
              bubbles.map((bubble, bubbleIndex) =>
                '<div class="ai-bubble-row">' +
                  '<button type="button" class="ai-bubble-insert" data-ai-bubble-insert="' + esc(id) + '" data-ai-bubble-index="' + String(bubbleIndex) + '"' + (sending ? " disabled" : "") + ">" + esc(String(bubble || "")) + "</button>" +
                  '<button type="button" class="ai-bubble-send-btn" title="Send bubble" aria-label="Send bubble" data-ai-bubble-send="' + esc(id) + '" data-ai-bubble-index="' + String(bubbleIndex) + '"' + (sending ? " disabled" : "") + ">▶</button>" +
                "</div>"
              ).join("") +
            "</div>" +
            (hasFailedIndex ? '<div class="ai-send-failure">' + esc(failureLabel) + "</div>" : "") +
            (hasFailedIndex
              ? '<div class="ai-actions"><button type="button" class="ai-btn" data-ai-retry-send="' + esc(id) + '"' + (sending ? " disabled" : "") + '>Retry from ' + esc(String(failedIndex + 1)) + "</button></div>"
              : "") +
            '<button type="button" class="ai-why-btn" data-ai-why="' + esc(id) + '"' + (sending ? " disabled" : "") + '>Why this?</button>' +
          "</article>"
        );
      }).join("");
    }

    async function logAiUsage(leadId, runId, suggestionId, action) {
      if (!leadId || !runId || !suggestionId || !action) return;
      try {
        await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-usage" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            suggestionId,
            action,
            createdAt: new Date().toISOString()
          })
        });
      } catch {
        // best effort
      }
    }

    function getAiSuggestionById(id) {
      const payload = currentAiLatest && typeof currentAiLatest === "object" ? currentAiLatest : null;
      const suggestionsRaw = payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
      const suggestions = suggestionsRaw.filter((item) => {
        const bubbles = getAiSuggestionMessages(item);
        return bubbles.length > 0;
      });
      const found = suggestions.find((s) => String(s && s.id ? s.id : "") === String(id || "")) || null;
      if (!found) return null;
      const bubbles = getAiSuggestionMessages(found);
      if (!bubbles.length) return null;
      return found;
    }

    function getAiSuggestionMessages(suggestion) {
      const raw = suggestion && Array.isArray(suggestion.messages) ? suggestion.messages : [];
      const cleaned = raw.map((x) => String(x || "").trim()).filter(Boolean);
      if (cleaned.length) return cleaned.slice(0, 4);
      const reply = String(suggestion && (suggestion.reply || suggestion.text) ? (suggestion.reply || suggestion.text) : "").trim();
      if (!reply) return [];
      const blocks = reply.split(/\\n\\s*\\n+/).map((x) => x.trim()).filter(Boolean);
      const sentenceMatches = reply.match(/[^.!?]+[.!?]?/g);
      const sentenceParts = sentenceMatches ? sentenceMatches.map((x) => x.trim()).filter(Boolean) : [];
      const parts = blocks.length > 1 ? blocks : sentenceParts;
      return (parts.length ? parts : [reply]).slice(0, 4);
    }

    function sleepMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getAiInsightSelectedSuggestionId(leadId) {
      return String(aiInsightSelectedByLead[String(leadId || "")] || "").trim();
    }

    function setAiInsightSelectedSuggestionId(leadId, suggestionId) {
      const key = String(leadId || "").trim();
      if (!key) return;
      aiInsightSelectedByLead[key] = String(suggestionId || "").trim();
    }

    function closeAiInsightDrawer() {
      aiInsightDrawerOpen = false;
      if (aiInsightDrawerBackdropEl) aiInsightDrawerBackdropEl.classList.remove("open");
    }

    function fmtAiConfidence(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "50%";
      const clamped = Math.max(0, Math.min(1, n));
      return String(Math.round(clamped * 100)) + "%";
    }

    function renderAiInsightDrawer() {
      if (!aiInsightDrawerContentEl || !aiInsightDrawerUpdatedAtEl) return;
      const payload = currentAiLatest && typeof currentAiLatest === "object" ? currentAiLatest : null;
      const suggestions = payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
      const leadId = currentLeadId();
      const selectedId = getAiInsightSelectedSuggestionId(leadId);
      const selectedSuggestion =
        suggestions.find((item) => String(item && item.id ? item.id : "") === selectedId) ||
        suggestions[0] ||
        null;
      const selectedMessages = selectedSuggestion ? getAiSuggestionMessages(selectedSuggestion) : [];
      const stage = payload && payload.stage && typeof payload.stage === "object" ? payload.stage : { value: "UNKNOWN", confidence: 0.5 };
      const analysisObj = payload && payload.analysis && typeof payload.analysis === "object" ? payload.analysis : null;
      const urgency = payload && payload.urgency && typeof payload.urgency === "object" ? payload.urgency : { level: "low" };
      const missingInfo = payload && Array.isArray(payload.missingInfo) ? payload.missingInfo : [];
      const signals = payload && Array.isArray(payload.detectedSignals) ? payload.detectedSignals : [];
      const riskFlags = payload && Array.isArray(payload.riskFlags) ? payload.riskFlags : [];
      const hasError = payload && payload.error && typeof payload.error === "object" ? payload.error : null;
      const reasoning = String(
        (analysisObj && analysisObj.reasoning) ||
        (payload && payload.explain && payload.explain.reasoning) ||
        ""
      ).trim();

      aiInsightDrawerUpdatedAtEl.textContent =
        payload && payload.createdAt ? fmtRelativeShort(payload.createdAt) : "Updated —";

      if (aiCardsLoading) {
        aiInsightDrawerContentEl.innerHTML = '<div class="ai-drawer-loading">Loading insight...</div>';
        return;
      }
      if (aiCardsError) {
        aiInsightDrawerContentEl.innerHTML = '<div class="ai-drawer-error">AI unavailable — retry</div>';
        return;
      }
      if (!payload || (!suggestions.length && !hasError)) {
        aiInsightDrawerContentEl.innerHTML = '<div class="ai-drawer-empty">No suggestions yet — new messages will trigger analysis.</div>';
        return;
      }
      if (hasError && !suggestions.length) {
        aiInsightDrawerContentEl.innerHTML =
          '<div class="ai-drawer-error">' +
            esc(String(hasError.message || "AI run unavailable")) +
          "</div>";
        return;
      }

      const stageConf = Math.max(0, Math.min(1, Number(stage && stage.confidence != null ? stage.confidence : 0.5)));
      const urgencyLevel = String(urgency && urgency.level ? urgency.level : "low").toLowerCase();
      const selectedControls = selectedSuggestion && selectedSuggestion.controls && typeof selectedSuggestion.controls === "object"
        ? selectedSuggestion.controls
        : {};
      const selectedBadges = [];
      if (selectedControls && selectedControls.requiresApproval) selectedBadges.push("Requires approval");
      if (selectedControls && selectedControls.replaceRecommended) selectedBadges.push("Replace recommended");
      if (selectedControls && selectedControls.sendAllowed === false) selectedBadges.push("Send restricted");

      aiInsightDrawerContentEl.innerHTML =
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Stage</div>' +
          '<div class="ai-stage-top">' +
            '<span class="ai-stage-pill">' + esc(String(stage && stage.value ? stage.value : "UNKNOWN")) + "</span>" +
            '<span class="ai-stage-conf">Confidence ' + esc(fmtAiConfidence(stageConf)) + "</span>" +
          "</div>" +
          '<div class="ai-stage-bar"><span style="width:' + esc(String(Math.round(stageConf * 100))) + '%"></span></div>' +
          '<div class="tiny" style="margin-top:8px;">Urgency: <strong>' + esc(urgencyLevel.toUpperCase()) + "</strong>" +
            (urgency && urgency.reason ? " · " + esc(String(urgency.reason)) : "") +
          "</div>" +
        "</section>" +
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Reasoning</div>' +
          '<div class="tiny">' + esc(reasoning || "No reasoning provided.") + "</div>" +
        "</section>" +
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Missing Information</div>' +
          (missingInfo.length
            ? '<ul class="ai-insight-list">' + missingInfo.map((item) => "<li>" + esc(String(item)) + "</li>").join("") + "</ul>"
            : '<div class="tiny">No missing information detected.</div>') +
        "</section>" +
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Detected Signals</div>' +
          (signals.length
            ? '<div class="ai-signal-grid">' +
                signals.slice(0, 12).map((item) => {
                  const key = String(item && item.key ? item.key : "").trim();
                  const value = String(item && item.value ? item.value : "").trim();
                  return '<span class="ai-signal-chip">' + esc(key + ": " + value) + "</span>";
                }).join("") +
              "</div>"
            : '<div class="tiny">No explicit signal extracted.</div>') +
        "</section>" +
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Risk Flags</div>' +
          (riskFlags.length
            ? riskFlags.map((item) => {
                const level = String(item && item.level ? item.level : "low").toLowerCase();
                const label = String(item && item.label ? item.label : "").trim();
                const detail = String(item && item.detail ? item.detail : "").trim();
                return (
                  '<div class="ai-risk-item">' +
                    '<span class="ai-risk-tag ' + esc(level) + '">' + esc(level) + "</span>" +
                    '<div>' + esc(label) + (detail ? '<div class="tiny">' + esc(detail) + "</div>" : "") + "</div>" +
                  "</div>"
                );
              }).join("")
            : '<div class="tiny">No critical risk detected.</div>') +
        "</section>" +
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Selected Suggestion</div>' +
          (selectedSuggestion
            ? (
                '<div style="font-size:13px; font-weight:600; color:rgba(242,247,255,.94);">' + esc(String(selectedSuggestion.title || "Suggestion")) + "</div>" +
                '<div class="tiny" style="margin-top:4px;">Goal: ' + esc(String(selectedSuggestion.goal || "FOLLOW_UP")) + "</div>" +
                '<div style="margin-top:8px; font-size:13px; line-height:1.45; color:rgba(216,228,245,.9); white-space:pre-wrap;">' + esc(String(selectedMessages.join("\\n\\n") || selectedSuggestion.reply || selectedSuggestion.text || "")) + "</div>" +
                (selectedSuggestion.rationale
                  ? '<div class="tiny" style="margin-top:8px;">Rationale: ' + esc(String(selectedSuggestion.rationale)) + "</div>"
                  : "") +
                (selectedBadges.length
                  ? '<div class="ai-control-badges">' + selectedBadges.map((x) => '<span class="ai-control-badge">' + esc(x) + "</span>").join("") + "</div>"
                  : "")
              )
            : '<div class="tiny">No suggestion selected.</div>') +
        "</section>" +
        '<section class="ai-insight-sec">' +
          '<div class="ai-insight-label">Run Metadata</div>' +
          '<div class="ai-meta-row"><span class="ai-meta-key">Model</span><span>' + esc(String(payload.model || "—")) + "</span></div>" +
          '<div class="ai-meta-row"><span class="ai-meta-key">Latency</span><span>' + esc(payload.latencyMs == null ? "—" : String(payload.latencyMs) + " ms") + "</span></div>" +
          '<div class="ai-meta-row"><span class="ai-meta-key">Cost (est.)</span><span>' + esc(String(payload.estimatedCostLabel || "—")) + "</span></div>" +
          '<div class="ai-meta-row"><span class="ai-meta-key">Run ID</span><span style="max-width:240px; overflow:hidden; text-overflow:ellipsis;">' + esc(String(payload.runId || "—")) + "</span></div>" +
          '<div class="ai-meta-actions">' +
            '<button type="button" class="ai-meta-btn" data-ai-copy-runid>Copy run id</button>' +
            '<button type="button" class="ai-meta-btn" data-ai-refresh-insight>Refresh</button>' +
          "</div>" +
        "</section>";
    }

    function openAiInsightDrawer(suggestionId) {
      const leadId = currentLeadId();
      if (!leadId || !aiInsightDrawerBackdropEl) return;
      if (suggestionId) setAiInsightSelectedSuggestionId(leadId, suggestionId);
      aiInsightDrawerOpen = true;
      renderAiInsightDrawer();
      aiInsightDrawerBackdropEl.classList.add("open");
    }

    function resolveDraftMergeMode() {
      const replace = window.confirm("Replace draft? Click Cancel to choose append.");
      if (replace) return "replace";
      const append = window.confirm("Append suggestion to draft? Click Cancel to keep current draft.");
      return append ? "append" : "cancel";
    }

    function applySuggestionToComposer(text, closeAfter) {
      if (!(conversationTextEl instanceof HTMLTextAreaElement)) return false;
      const clean = String(text || "").trim();
      if (!clean) return false;
      const current = String(conversationTextEl.value || "");
      if (!current.trim()) {
        conversationTextEl.value = clean;
      } else {
        const mode = resolveDraftMergeMode();
        if (mode === "cancel") return false;
        conversationTextEl.value = mode === "append" ? (current.trimEnd() + "\\n\\n" + clean) : clean;
      }
      conversationTextEl.focus();
      if (closeAfter && suggestionPanelOpen) setSugOpen(false, currentLeadId(), { userInitiatedOpen: true });
      return true;
    }

    async function loadAiLatestForLead(leadId, opts) {
      // Manual verification checklist:
      // 1) Open a lead, wait for AI cards, click "Why this?" and verify stage/signals/missing/risk/metadata render.
      // 2) Click "Refresh" in drawer and confirm cards + drawer update without closing.
      // 3) Trigger an advisor error run and confirm drawer shows safe error state (no crash).
      const options = opts && typeof opts === "object" ? opts : {};
      if (!leadId) {
        resetAiCardsState();
        renderAiCards();
        return;
      }
      aiCardsLoading = !options.silent;
      aiCardsError = "";
      renderAiCards();
      try {
        const response = await fetch("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-latest" + qs);
        if (response.status === 204) {
          currentAiLatest = { suggestions: [], createdAt: null, runId: null };
          aiCardsError = "";
          aiQueuedPollAttempts = 0;
          if (aiInsightDrawerOpen) renderAiInsightDrawer();
          renderAgentStatusPill();
          return;
        }
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
        if (!response.ok) {
          throw new Error((payload && (payload.error || payload.message)) || response.statusText || "ai_latest_failed");
        }
        currentAiLatest = payload && typeof payload === "object" ? payload : { suggestions: [] };
        aiCardsError = "";
        const status = String(currentAiLatest && currentAiLatest.status ? currentAiLatest.status : "").toLowerCase();
        if (status === "queued") scheduleAiQueuedPoll(leadId);
        else aiQueuedPollAttempts = 0;
        if (aiInsightDrawerOpen) renderAiInsightDrawer();
      } catch (error) {
        currentAiLatest = null;
        aiCardsError = String(error && error.message ? error.message : "ai_latest_failed");
        aiQueuedPollAttempts = 0;
        if (aiInsightDrawerOpen) renderAiInsightDrawer();
      } finally {
        aiCardsLoading = false;
        renderAiCards();
        renderAgentStatusPill();
        if (aiInsightDrawerOpen) renderAiInsightDrawer();
      }
    }

    async function sendAiSuggestionNow(cardId, startIndex, endIndex) {
      const lead = selectedLead();
      if (!lead) return;
      const suggestion = getAiSuggestionById(cardId);
      if (!suggestion) return;
      const bubbles = getAiSuggestionMessages(suggestion);
      if (!bubbles.length) return;
      const from = Math.max(0, Math.min(bubbles.length - 1, Math.round(Number(startIndex || 0))));
      const endIndexNumber = Number(endIndex);
      const to = Number.isFinite(endIndexNumber)
        ? Math.max(from, Math.min(bubbles.length - 1, Math.round(endIndexNumber)))
        : bubbles.length - 1;
      aiCardSendingMap[String(cardId)] = true;
      delete aiCardFailedIndexMap[String(cardId)];
      renderAiCards();
      try {
        for (let i = from; i <= to; i += 1) {
          const text = String(bubbles[i] || "").trim();
          if (!text) continue;
          try {
            await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/messages" + qs, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                direction: "OUT",
                text,
                provider: "manual",
                message_type: "text",
                send_whatsapp: true
              })
            });
          } catch (err) {
            aiCardFailedIndexMap[String(cardId)] = i;
            const reason = err instanceof Error ? err.message : String(err || "send_failed");
            throw new Error("Message " + String(i + 1) + " failed: " + reason);
          }
          if (i < to) {
            const delayMs = 500 + Math.floor(Math.random() * 401);
            await sleepMs(delayMs);
          }
        }
        if (conversationTextEl instanceof HTMLTextAreaElement && from === 0 && to === bubbles.length - 1) {
          const current = String(conversationTextEl.value || "").trim();
          const joined = bubbles.join("\\n\\n").trim();
          if (current === joined) conversationTextEl.value = "";
        }
        delete aiCardFailedIndexMap[String(cardId)];
        await logAiUsage(String(lead.id || ""), String(currentAiLatest && currentAiLatest.runId ? currentAiLatest.runId : ""), String(cardId), "send");
        await loadConversationForLead(lead.id);
      } catch (error) {
        const message = String(error && error.message ? error.message : "send_failed");
        const match = message.match(/Message\\s+(\\d+)\\s+failed/i);
        if (match && match[1]) {
          const failed = Math.max(0, Number(match[1]) - 1);
          aiCardFailedIndexMap[String(cardId)] = failed;
        }
        if (aiCardFailedIndexMap[String(cardId)] == null) {
          aiCardFailedIndexMap[String(cardId)] = from;
        }
        showErrorBanner(formatError(error));
      } finally {
        delete aiCardSendingMap[String(cardId)];
        renderAiCards();
      }
    }

    function fmtEventDate(value) {
      const raw = String(value || "").trim();
      if (!raw) return "Non renseignée";
      let d = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        d = new Date(raw + "T00:00:00Z");
      } else {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) d = parsed;
      }
      if (!d || Number.isNaN(d.getTime())) return raw;
      return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
    }

    function fmtDestination(lead) {
      if (!lead) return "Non renseignée";
      const city = String(lead.ship_city || "").trim();
      const region = String(lead.ship_region || "").trim();
      const country = String(lead.ship_country || "").trim();
      const chunks = [city, region, country].filter(Boolean);
      if (chunks.length) return chunks.join(", ");
      const raw = String(lead.ship_destination_text || "").trim();
      return raw || "Non renseignée";
    }

    function fmtTicketValue(value, currency) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return "—";
      const c = String(currency || "").toUpperCase();
      if (c === "USD") return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
      if (c === "EUR") return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/\u202f/g, " ") + "€";
      if (c === "MAD") return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/\u202f/g, " ") + " MAD";
      return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/\u202f/g, " ");
    }

    function renderLeadQuotesSection(lead) {
      const quotes = Array.isArray(leadQuotes) ? leadQuotes.slice(0, 12) : [];
      const estimated = fmtTicketValue(lead && lead.ticket_value, lead && lead.ticket_currency);
      if (!quotes.length) {
        return (
          '<div class="quotes-block">' +
            '<div class="quotes-head"><span>Quotes</span><strong>Estimated total: ' + esc(estimated) + "</strong></div>" +
            '<div class="tiny">Aucun prix détecté.</div>' +
          "</div>"
        );
      }
      return (
        '<div class="quotes-block">' +
          '<div class="quotes-head"><span>Quotes</span><strong>Estimated total: ' + esc(estimated) + "</strong></div>" +
          '<div class="quotes-list">' +
            quotes.map((quote) => {
              const title = String(quote && quote.product_title ? quote.product_title : quote && quote.product_handle ? quote.product_handle : "Produit");
              const line = String(quote && quote.formatted ? quote.formatted : "—");
              const qty = Math.max(1, Number(quote && quote.qty ? quote.qty : 1));
              const sourceId = String(quote && quote.message_id ? quote.message_id : "").trim();
              return (
                '<button type="button" class="quote-line"' + (sourceId ? ' data-scroll-source-message="' + esc(sourceId) + '"' : "") + ">" +
                  '<span class="quote-title">' + esc(title) + (qty > 1 ? " x" + esc(String(qty)) : "") + "</span>" +
                  '<strong class="quote-value">' + esc(line) + "</strong>" +
                "</button>"
              );
            }).join("") +
          "</div>" +
        "</div>"
      );
    }

    function fmtTime(value) {
      const d = new Date(String(value || ""));
      if (Number.isNaN(d.getTime())) return "--:--";
      return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    }

    function stageRankValue(stage) {
      const s = String(stage || "").trim().toUpperCase();
      const rank = {
        NEW: 0,
        PRODUCT_INTEREST: 1,
        QUALIFICATION_PENDING: 2,
        QUALIFIED: 3,
        PRICE_SENT: 4,
        VIDEO_PROPOSED: 4,
        DEPOSIT_PENDING: 5,
        CONFIRMED: 6,
        CONVERTED: 7,
        LOST: 8
      };
      return Number.isFinite(rank[s]) ? rank[s] : 0;
    }

    function initials(name) {
      const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "?";
      return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("");
    }

    function publicImageUrlFromLead(lead) {
      const raw = String(lead && lead.profile_image_url ? lead.profile_image_url : "").trim();
      if (!raw) return "";
      return /^https?:\/\//i.test(raw) ? raw : "";
    }

    function parseProductHandle(url) {
      try {
        const u = new URL(String(url || ""));
        const parts = String(u.pathname || "").split("/").filter(Boolean);
        const idx = parts.findIndex((p) => p === "products");
        if (idx === -1 || !parts[idx + 1]) return "";
        return String(parts[idx + 1]).split("?")[0].trim().toLowerCase();
      } catch {
        return "";
      }
    }

    function extractProductHandlesFromText(text) {
      try {
        const src = String(text || "");
        if (!src) return [];
        const normalized = src.split("*").join(" ");
        const out = [];
        const patterns = [
          /\/products\/([a-z0-9][a-z0-9\-]*)/gi,
          /\/collections\/[^\\s/]+\/products\/([a-z0-9][a-z0-9\-]*)/gi
        ];
        for (const re of patterns) {
          let m = re.exec(normalized);
          while (m) {
            const handle = String(m[1] || "").toLowerCase().trim();
            if (handle) out.push(handle);
            m = re.exec(normalized);
          }
        }
        return Array.from(new Set(out));
      } catch {
        return [];
      }
    }

    function extractProductLinksFromText(text) {
      try {
        const src = String(text || "");
        if (!src) return [];
        const links = [];
        const tokens = src.split("*").join(" ").split(/\s+/).filter(Boolean);
        for (const raw of tokens) {
          let token = String(raw || "").trim();
          while (/[),.;!?]$/.test(token)) token = token.slice(0, -1);
          const lower = token.toLowerCase();
          if ((lower.startsWith("http://") || lower.startsWith("https://")) && lower.includes("/products/")) {
            links.push(token);
          }
        }
        return Array.from(new Set(links));
      } catch {
        return [];
      }
    }

    function productLabelFromUrl(url) {
      const handle = parseProductHandle(url);
      return handle ? handle.replace(/[-_]+/g, " ") : String(url || "").replace("https://", "").replace("http://", "");
    }

    function hostFromUrl(raw) {
      try {
        const u = new URL(String(raw || ""));
        return String(u.hostname || "").trim().toLowerCase();
      } catch {
        return "";
      }
    }

    function productTitleHintFromText(text) {
      try {
        const src = String(text || "");
        const lower = src.toLowerCase();
        const markers = ["interested in this article:", "article:", "produit:"];
        for (const marker of markers) {
          const idx = lower.indexOf(marker);
          if (idx === -1) continue;
          let tail = src.slice(idx + marker.length).trim();
          if (!tail) continue;
          if (tail.startsWith("*")) tail = tail.slice(1);
          const line = (tail.split(String.fromCharCode(10))[0] || "").split("*").join("").trim();
          if (line) return line;
        }
        return "";
      } catch {
        return "";
      }
    }

    function dedupeProducts(items) {
      const seen = new Set();
      const out = [];
      for (const item of items) {
        const key = String(item && item.url ? item.url : "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out;
    }

    function deriveLeadProducts(lead) {
      try {
        if (!lead) return [];
        const products = [];
        const leadProduct = String(lead.product || "").trim();
        if (leadProduct && leadProduct !== "-") {
          const hint = productTitleHintFromText(leadProduct);
          const links = extractProductLinksFromText(leadProduct);
          const handles = extractProductHandlesFromText(leadProduct);
          links.forEach((url) => products.push({ url, title: hint || productLabelFromUrl(url), source: "lead" }));
          handles.forEach((h) => products.push({ url: "", title: h.replace(/[-_]+/g, " "), source: "lead" }));
        }
        if (Array.isArray(leadMessages)) {
          let lastInboundText = "";
          leadMessages.forEach((msg) => {
            const text = msg && msg.text ? String(msg.text) : "";
            if (String(msg && msg.direction ? msg.direction : "").toUpperCase() === "IN") lastInboundText = text;
            const hint = productTitleHintFromText(text);
            const links = extractProductLinksFromText(text);
            const handles = extractProductHandlesFromText(text);
            links.forEach((url) => products.push({ url, title: hint || productLabelFromUrl(url), source: "message" }));
            handles.forEach((h) => products.push({ url: "", title: hint || h.replace(/[-_]+/g, " "), source: "message" }));
          });
          if (lastInboundText) {
            console.debug("[whatsapp] last inbound text", lastInboundText);
            console.debug("[whatsapp] product handles", extractProductHandlesFromText(lastInboundText));
          }
        }
        if (!products.length && leadProduct && leadProduct !== "-") {
          products.push({ url: "", title: leadProduct, source: "lead" });
        }
        return dedupeProducts(products);
      } catch (error) {
        productParsingOk = false;
        console.debug("[whatsapp] deriveLeadProducts failed", error);
        return [];
      }
    }

    function renderProductChips(lead) {
      const products = deriveLeadProducts(lead);
      if (!products.length) return '<span class="product-empty">Produit: -</span>';
      return '<span class="tiny">Produit:</span><div class="product-chips">' +
        products.map((p, idx) =>
          '<button type="button" class="product-chip" data-product-idx="' + String(idx) + '" title="' + esc(p.url || p.title) + '">' +
            esc(p.title || "Produit") +
          "</button>"
        ).join("") +
      "</div>";
    }

    function renderSignalChips(lead, compact) {
      if (!lead) return "";
      const chips = [];
      if (lead.has_product_interest) chips.push("Produit");
      if (lead.has_price_sent) chips.push("Prix envoyé");
      if (lead.has_video_proposed) chips.push("Visio proposée");
      if (lead.has_payment_question) chips.push("Paiement ?");
      if (lead.has_deposit_link_sent) chips.push("Acompte");
      if (lead.chat_confirmed) chips.push("Confirmé");
      if (!chips.length) return compact ? '<span class="product-none">-</span>' : "";
      const cls = compact ? "signal-chip compact" : "signal-chip";
      return '<div class="signal-chip-wrap">' + chips.map((label) => '<span class="' + cls + '">' + esc(label) + "</span>").join("") + "</div>";
    }

    function inferNextStage(lead) {
      if (!lead) return "";
      const current = String(lead.stage || "").toUpperCase();
      const recommended = String(lead.recommended_stage || "").toUpperCase();
      if (recommended && recommended !== current) return recommended;
      const fallback = {
        NEW: "QUALIFICATION_PENDING",
        PRODUCT_INTEREST: "QUALIFICATION_PENDING",
        QUALIFICATION_PENDING: "QUALIFIED",
        QUALIFIED: "PRICE_SENT",
        PRICE_SENT: "DEPOSIT_PENDING",
        VIDEO_PROPOSED: "DEPOSIT_PENDING",
        DEPOSIT_PENDING: "CONFIRMED",
        CONFIRMED: "CONVERTED",
        CONVERTED: "",
        LOST: ""
      };
      return fallback[current] || "";
    }

    function renderStageFlow(lead) {
      const current = String((lead && lead.stage) || "-").toUpperCase() || "-";
      const next = inferNextStage(lead);
      if (!next) return '<span class="rec">' + esc(current) + "</span>";
      return (
        '<span class="stage-next-wrap">' +
          '<span class="rec">' + esc(current) + "</span>" +
          '<span class="stage-next-arrow">→</span>' +
          '<span class="rec next">' + esc(next) + "</span>" +
        "</span>"
      );
    }

    function inferLastFlagLabel(lead) {
      if (!lead) return "-";
      const candidates = [
        { key: "chat_confirmed", label: "Confirmé", source: lead.chat_confirmed_source_message_id },
        { key: "has_deposit_link_sent", label: "Acompte", source: lead.deposit_link_source_message_id },
        { key: "has_payment_question", label: "Paiement ?", source: lead.payment_question_source_message_id },
        { key: "has_video_proposed", label: "Visio proposée", source: lead.video_proposed_source_message_id },
        { key: "has_price_sent", label: "Prix envoyé", source: lead.price_sent_source_message_id },
        { key: "has_product_interest", label: "Produit", source: lead.product_interest_source_message_id },
        { key: "confirmation_intent", label: "Intent: confirmation", source: null },
        { key: "deposit_intent", label: "Intent: acompte", source: null },
        { key: "payment_intent", label: "Intent: paiement", source: null },
        { key: "video_intent", label: "Intent: visio", source: null },
        { key: "price_intent", label: "Intent: prix", source: null }
      ].filter((c) => Boolean(lead[c.key]));

      if (!candidates.length) return "-";

      const byId = new Map(
        (Array.isArray(leadMessages) ? leadMessages : [])
          .map((m) => [String(m && m.id ? m.id : ""), m])
          .filter((entry) => Boolean(entry[0]))
      );

      let best = null;
      for (const candidate of candidates) {
        const sourceId = String(candidate.source || "").trim();
        if (!sourceId) continue;
        const msg = byId.get(sourceId);
        if (!msg) continue;
        const ts = new Date(String(msg.created_at || msg.createdAt || "")).getTime();
        if (!Number.isFinite(ts)) continue;
        if (!best || ts > best.ts) best = { ts, label: candidate.label };
      }
      if (best && best.label) return best.label;
      return String(candidates[0].label || "-");
    }

    function renderLastFlagChip(lead) {
      const label = inferLastFlagLabel(lead);
      return '<span class="tiny">Last flag: <strong>' + esc(label) + "</strong></span>";
    }

    function renderProductContextGallery(lead) {
      try {
        const handles = handlesForLead(lead);
        if (!handles.length) return '<span class="product-empty">Produit: -</span>';
        const pricesByHandle = detectPricesByProductFromConversation(lead);
        return '<div class="product-context-grid">' +
          handles.map((handle) => {
            const preview = productPreviewsMap[handle] || {};
            const title = String(preview.title || handle.replace(/-/g, " "));
            const image = String(preview.image_url || PRODUCT_PLACEHOLDER_IMAGE);
            const url = String(preview.product_url || "#");
            const detected = pricesByHandle[handle] || null;
            const priceLine = detected && detected.price_text
              ? (
                '<div class="product-context-price">' +
                  '<span class="k">Prix détecté:</span><strong>' + esc(String(detected.price_text || "")) + "</strong>" +
                  (detected.source_message_id
                    ? '<button class="small-btn" type="button" data-scroll-source-message="' + esc(String(detected.source_message_id || "")) + '" style="margin-left:6px; padding:2px 8px; font-size:10px;">Source</button>'
                    : "") +
                "</div>"
              )
              : '<div class="product-context-price"><span class="k">Prix détecté:</span>-</div>';
            return (
              '<div class="product-context-card">' +
                '<a class="product-context-item" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(title) + '">' +
                  '<img class="product-thumb" src="' + esc(image) + '" alt="' + esc(title) + '" />' +
                "</a>" +
                '<div class="product-context-meta">' +
                  '<div class="product-context-title">' + esc(title) + "</div>" +
                  priceLine +
                "</div>" +
              "</div>"
            );
          }).join("") +
        "</div>";
      } catch {
        return '<span class="product-empty">Produit: -</span>';
      }
    }

    function extractPriceCandidates(text) {
      try {
        const src = String(text || "");
        if (!src) return [];
        const out = [];
        const normalizeCurrency = (token) => {
          const t = String(token || "").trim().toLowerCase();
          if (t === "$" || t === "usd") return "USD";
          if (t === "€" || t === "eur") return "EUR";
          if (t === "mad" || t === "dh" || t === "dhs") return "MAD";
          return "";
        };
        const parseAmount = (raw) => {
          const input = String(raw || "").trim();
          if (!input) return null;
          const k = input.match(/^([0-9]+(?:[.,][0-9]+)?)\s*[kK]$/);
          if (k) {
            const n = Number(String(k[1]).replace(",", "."));
            return Number.isFinite(n) ? Math.round(n * 1000) : null;
          }
          const cleaned = input.replace(/\s+/g, "").replace(/[^0-9.,]/g, "");
          if (!cleaned) return null;
          const lastDot = cleaned.lastIndexOf(".");
          const lastComma = cleaned.lastIndexOf(",");
          const lastSep = Math.max(lastDot, lastComma);
          const dotCount = (cleaned.match(/\./g) || []).length;
          const commaCount = (cleaned.match(/,/g) || []).length;
          let normalized = cleaned;
          if (lastSep >= 0) {
            const decimalDigits = cleaned.length - lastSep - 1;
            if (dotCount + commaCount > 1 || (dotCount > 0 && commaCount > 0) || decimalDigits === 3 || decimalDigits === 0) {
              normalized = cleaned.replace(/[.,]/g, "");
            } else if (decimalDigits > 0 && decimalDigits <= 2) {
              const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
              const fracPart = cleaned.slice(lastSep + 1).replace(/[.,]/g, "");
              normalized = intPart + "." + fracPart;
            } else {
              normalized = cleaned.replace(/[.,]/g, "");
            }
          }
          const n = Number(normalized);
          return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        };
        const formatPrice = (amount, currency) => {
          const n = Number(amount);
          if (!Number.isFinite(n)) return "";
          if (currency === "USD") return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
          if (currency === "EUR") return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\u202f/g, " ") + "€";
          if (currency === "MAD") return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\u202f/g, " ") + " MAD";
          return "";
        };
        const reA = /(?:\b(mad|dhs?|dh|eur|usd)\b|([€$]))\s*([0-9][0-9\s.,]*(?:\s*[kK])?)/gi;
        const reB = /([0-9][0-9\s.,]*(?:\s*[kK])?)\s*(?:\b(mad|dhs?|dh|eur|usd)\b|([€$]))/gi;
        let m = reA.exec(src);
        while (m) {
          const currency = normalizeCurrency(String(m[1] || m[2] || ""));
          const amount = parseAmount(String(m[3] || ""));
          if (currency && amount) {
            out.push({ price_text: formatPrice(amount, currency), amount: String(amount), currency });
          }
          m = reA.exec(src);
        }
        m = reB.exec(src);
        while (m) {
          const currency = normalizeCurrency(String(m[2] || m[3] || ""));
          const amount = parseAmount(String(m[1] || ""));
          if (currency && amount) {
            out.push({ price_text: formatPrice(amount, currency), amount: String(amount), currency });
          }
          m = reB.exec(src);
        }
        return out;
      } catch {
        return [];
      }
    }

    function detectPricesByProductFromStoredQuotes(lead) {
      try {
        const handles = handlesForLead(lead);
        if (!handles.length || !Array.isArray(leadQuotes) || !leadQuotes.length) return {};
        const known = new Set(handles);
        const byHandle = {};
        const sortedQuotes = leadQuotes
          .slice()
          .sort((a, b) => {
            const at = new Date(String(a && a.created_at ? a.created_at : "")).getTime();
            const bt = new Date(String(b && b.created_at ? b.created_at : "")).getTime();
            if (Number.isFinite(bt) && Number.isFinite(at)) return bt - at;
            return 0;
          });

        sortedQuotes.forEach((quote) => {
          const handle = String(quote && quote.product_handle ? quote.product_handle : "").trim().toLowerCase();
          if (!handle || !known.has(handle)) return;
          if (byHandle[handle]) return;
          const formatted = String(quote && quote.formatted ? quote.formatted : "").trim();
          const fallbackAmount = Number(quote && quote.amount ? quote.amount : 0);
          const currency = String(quote && quote.currency ? quote.currency : "").trim().toUpperCase();
          const priceText = formatted || (Number.isFinite(fallbackAmount) && fallbackAmount > 0
            ? (currency === "USD"
              ? "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(fallbackAmount))
              : currency === "EUR"
                ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(fallbackAmount)).replace(/\u202f/g, " ") + "€"
                : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(fallbackAmount)).replace(/\u202f/g, " ") + " MAD")
            : "");
          if (!priceText) return;
          byHandle[handle] = {
            price_text: priceText,
            source_message_id: String(quote && quote.message_id ? quote.message_id : "").trim() || null
          };
        });
        return byHandle;
      } catch {
        return {};
      }
    }

    function detectPricesByProductFromConversation(lead) {
      try {
        const handles = handlesForLead(lead);
        if (!handles.length || !Array.isArray(leadMessages) || !leadMessages.length) return {};
        const seenHandles = new Set(handles);
        const byHandle = {};
        let activeHandles = [];
        let allKnownFromConversation = [];
        leadMessages.forEach((msg) => {
          const text = String(msg && msg.text ? msg.text : "");
          const msgHandles = extractProductHandlesFromText(text).filter((h) => seenHandles.has(h));
          if (msgHandles.length) {
            activeHandles = msgHandles;
            allKnownFromConversation = Array.from(new Set([...(allKnownFromConversation || []), ...msgHandles]));
          }
          const prices = extractPriceCandidates(text);
          if (!prices.length) return;
          const pickForIndex = (idx) => prices[Math.min(Math.max(0, idx), prices.length - 1)];
          const targets = activeHandles.length ? activeHandles : (allKnownFromConversation.length ? allKnownFromConversation : handles);
          targets.forEach((handle, idx) => {
            const candidate = pickForIndex(idx);
            if (!candidate) return;
            byHandle[handle] = {
              price_text: String(candidate.price_text || "").trim(),
              source_message_id: String(msg && msg.id ? msg.id : "").trim() || null
            };
          });
        });
        const persisted = detectPricesByProductFromStoredQuotes(lead);
        return Object.assign({}, byHandle, persisted);
      } catch {
        return {};
      }
    }

    const PRODUCT_PLACEHOLDER_IMAGE =
      "data:image/svg+xml;utf8," +
      encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='100%' height='100%' fill='#0f1725'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#8fa6c9' font-size='10'>No image</text></svg>");

    function handlesForLead(lead) {
      try {
        const fromApi = Array.isArray(lead && lead.product_handles) ? lead.product_handles : [];
        const fromProduct = extractProductHandlesFromText(String(lead && lead.product ? lead.product : ""));
        return Array.from(new Set([...(fromApi || []), ...(fromProduct || [])].map((h) => String(h || "").trim().toLowerCase()).filter(Boolean)));
      } catch {
        return [];
      }
    }

    async function loadProductPreviewsForLeads(items) {
      try {
        const handles = Array.from(new Set((Array.isArray(items) ? items : []).flatMap((lead) => handlesForLead(lead))));
        const missing = handles.filter((h) => !productPreviewsMap[h]);
        if (!missing.length) return;
        const payload = await fetchJson("/api/products/previews" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handles: missing })
        });
        const previews = payload && payload.previews && typeof payload.previews === "object" ? payload.previews : {};
        productPreviewsMap = Object.assign({}, productPreviewsMap, previews);
      } catch (error) {
        console.debug("[whatsapp] product previews load failed", error);
      }
    }

    function renderLeadProductCell(lead) {
      const handles = handlesForLead(lead);
      if (!handles.length) return '<div class="lead-product-cell"><span class="product-none">-</span>' + renderSignalChips(lead, true) + "</div>";
      const thumbs = handles.slice(0, 2).map((handle) => {
        const preview = productPreviewsMap[handle] || {};
        const title = String(preview.title || handle.replace(/-/g, " ")).trim();
        const image = String(preview.image_url || PRODUCT_PLACEHOLDER_IMAGE).trim();
        const url = String(preview.product_url || "").trim();
        if (url) {
          return '<a class="lead-product-thumb" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" data-product-open="' + esc(handle) + '" title="' + esc(title || handle) + '">' +
              '<img class="product-thumb" src="' + esc(image) + '" alt="' + esc(title || "Produit") + '" />' +
            "</a>";
        }
        return '<span class="lead-product-thumb" title="' + esc(title || handle) + '">' +
            '<img class="product-thumb" src="' + esc(image) + '" alt="' + esc(title || "Produit") + '" />' +
          "</span>";
      }).join("");
      if (handles.length <= 2) return '<div class="lead-product-cell"><div class="lead-product-grid">' + thumbs + "</div>" + renderSignalChips(lead, true) + "</div>";
      return (
        '<div class="lead-product-cell">' +
          '<div class="lead-product-grid">' +
            thumbs +
          "</div>" +
          '<button type="button" class="product-more" data-product-more="' + esc(handles.join(",")) + '">+' + esc(handles.length - 1) + "</button>" +
          renderSignalChips(lead, true) +
        "</div>"
      );
    }

    function closeProductPopover() {
      if (!productPopoverEl) return;
      productPopoverEl.classList.remove("open");
      productPopoverEl.innerHTML = "";
    }

    function openProductPopover(handles, anchorEl) {
      if (!productPopoverEl) return;
      const list = (Array.isArray(handles) ? handles : [])
        .map((h) => String(h || "").trim().toLowerCase())
        .filter(Boolean);
      if (!list.length) return closeProductPopover();
      productPopoverEl.innerHTML = list.map((h) => {
        const preview = productPreviewsMap[h] || {};
        const title = String(preview.title || h.replace(/-/g, " "));
        const image = String(preview.image_url || PRODUCT_PLACEHOLDER_IMAGE);
        const url = String(preview.product_url || "#");
        return (
          '<a class="product-pop-item" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
            '<img class="product-thumb" src="' + esc(image) + '" alt="' + esc(title) + '" />' +
            '<span class="product-title">' + esc(title) + "</span>" +
          "</a>"
        );
      }).join("");
      const rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
      const top = rect ? Math.min(window.innerHeight - 20, rect.bottom + 6) : 80;
      const left = rect ? Math.min(window.innerWidth - 20, rect.left) : 80;
      productPopoverEl.style.top = String(top + window.scrollY) + "px";
      productPopoverEl.style.left = String(left + window.scrollX) + "px";
      productPopoverEl.classList.add("open");
    }

    async function fetchProductPreview(productUrl) {
      const key = String(productUrl || "").trim();
      if (!key) return { title: "", image: "", url: "" };
      if (productPreviewCache.has(key)) return productPreviewCache.get(key);
      const fallback = { title: productLabelFromUrl(key), image: "", url: key };
      try {
        const u = new URL(key);
        const handle = parseProductHandle(key);
        if (!handle) {
          productPreviewCache.set(key, fallback);
          return fallback;
        }
        let origin = String(u.origin || "");
        while (origin.endsWith("/")) origin = origin.slice(0, -1);
        const jsonUrl = origin + "/products/" + handle + ".js";
        const res = await fetch(jsonUrl);
        if (!res.ok) {
          productPreviewCache.set(key, fallback);
          return fallback;
        }
        const payload = await res.json();
        const title = String(payload && payload.title ? payload.title : fallback.title);
        const image =
          String(
            (payload && payload.featured_image) ||
            (Array.isArray(payload && payload.images) && payload.images[0]) ||
            ""
          );
        const data = { title, image, url: key };
        productPreviewCache.set(key, data);
        return data;
      } catch {
        productPreviewCache.set(key, fallback);
        return fallback;
      }
    }

    async function openProductModalByIndex(index) {
      const lead = selectedLead();
      if (!lead || !productModalBackdropEl) return;
      const products = deriveLeadProducts(lead);
      const picked = products[Number(index)];
      if (!picked) return;
      const detail = picked.url ? await fetchProductPreview(picked.url) : { title: picked.title, image: "", url: "" };
      if (productModalTitleEl) productModalTitleEl.textContent = detail.title || picked.title || "Produit";
      if (productModalSubtitleEl) productModalSubtitleEl.textContent = String(lead.client || "") + " · " + String(lead.country || "-");
      if (productModalBodyEl) {
        productModalBodyEl.innerHTML = detail.image
          ? '<img class="product-preview-img" src="' + esc(detail.image) + '" alt="' + esc(detail.title || "Produit") + '" />'
          : '<div class="phone-empty">Aucune photo trouvée pour ce produit.</div>';
      }
      if (productModalOpenLinkEl instanceof HTMLAnchorElement) {
        const href = detail.url || picked.url || "#";
        productModalOpenLinkEl.href = href;
        productModalOpenLinkEl.style.pointerEvents = href === "#" ? "none" : "auto";
        productModalOpenLinkEl.style.opacity = href === "#" ? ".6" : "1";
      }
      productModalBackdropEl.classList.add("open");
    }

    function closeProductModal() {
      if (!productModalBackdropEl) return;
      productModalBackdropEl.classList.remove("open");
    }

    function fmtHours(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return "0h";
      return n.toFixed(1).replace(/\\.0$/, "") + "h";
    }

    function fmtRelative(value) {
      const d = new Date(String(value || ""));
      if (Number.isNaN(d.getTime())) return "-";
      const diffMs = Date.now() - d.getTime();
      if (diffMs <= 60 * 1000) return "il y a < 1 min";
      const mins = Math.floor(diffMs / 60000);
      if (mins < 60) return "il y a " + mins + " min";
      const hours = Math.floor(mins / 60);
      if (hours < 24) return "il y a " + hours + " h";
      const days = Math.floor(hours / 24);
      return "il y a " + days + " j";
    }

    function dayLabel(value) {
      const d = new Date(String(value || ""));
      if (Number.isNaN(d.getTime())) return "";
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const messageDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const diff = Math.round((today - messageDay) / 86400000);
      if (diff === 0) return "Aujourd'hui";
      if (diff === 1) return "Hier";
      return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
    }

    function formatTimelineEvent(item) {
      const eventType = String(item && item.event_type ? item.event_type : "");
      const payload = item && item.payload && typeof item.payload === "object" ? item.payload : {};
      if (eventType === "STAGE_CHANGED") {
        const fromStage = String(payload.from_stage || "-");
        const toStage = String(payload.to_stage || "-");
        const source = String(payload.source || "system");
        return "Stage: " + fromStage + " → " + toStage + " · " + source + " · " + fmtDate(item.created_at);
      }
      if (eventType === "CONVERTED_BY_SHOPIFY_ORDER") {
        return "Converti via Shopify · " + fmtDate(item.created_at);
      }
      if (eventType === "OPERATOR_CONFIRMED") {
        return "Confirmé par opérateur (bouton UI) · " + fmtDate(item.created_at);
      }
      return eventType + " · " + fmtDate(item.created_at);
    }

    function renderClientTimeline(lead) {
      if (!clientContextTimelineEl) return;
      const events = [];
      if (lead && lead.created_at) events.push("Création lead · " + fmtDate(lead.created_at));
      if (Array.isArray(leadTimelineEvents) && leadTimelineEvents.length) {
        leadTimelineEvents.forEach((evt) => events.push(formatTimelineEvent(evt)));
      } else if (lead) {
        if (lead.has_product_interest) events.push("Produit détecté");
        if (lead.has_price_sent) events.push("Prix envoyé");
        if (lead.has_video_proposed) events.push("Visio proposée");
        if (lead.has_payment_question) events.push("Question paiement");
        if (lead.has_deposit_link_sent) events.push("Lien acompte envoyé");
        if (lead.stage === "DEPOSIT_PENDING") events.push("Acompte en attente");
        if (lead.chat_confirmed || lead.stage === "CONFIRMED") events.push("Confirmation client reçue");
        if (lead.stage === "CONVERTED") events.push("Converti");
      }
      clientContextTimelineEl.innerHTML = events.length
        ? events.map((event) => "<li>" + esc(event) + "</li>").join("")
        : "<li class='tiny'>Aucune transition de stage enregistrée.</li>";
    }

    function selectedLead() {
      if (!selectedLeadId) return null;
      return leads.find((item) => item.id === selectedLeadId) || null;
    }

    function isSharedLeadClient(lead) {
      return String(lead && lead.channel_type ? lead.channel_type : "").toUpperCase() === "SHARED";
    }

    function selectedLeadIsShared() {
      const lead = selectedLead();
      return Boolean(lead && isSharedLeadClient(lead));
    }

    function selectedLeadHasInboundMessage() {
      return Array.isArray(leadMessages) && leadMessages.some((msg) => String(msg.direction || "").toUpperCase() === "IN");
    }

    function leadIsReadyToSendApprovedQuote(lead) {
      if (!lead || typeof lead !== "object") return false;
      const stage = String(lead.stage || "").toUpperCase();
      if (stage === "LOST" || stage === "CONVERTED") return false;
      if (stage === "PRICE_APPROVED_READY_TO_SEND") return true;
      const detected = lead.detected_signals && typeof lead.detected_signals === "object" ? lead.detected_signals : {};
      const qa = detected.quote_approval && typeof detected.quote_approval === "object" ? detected.quote_approval : {};
      const price = qa.price && typeof qa.price === "object" ? qa.price : {};
      const approvedAmount = Number(price.approved_amount != null ? price.approved_amount : 0);
      const approved = price.approved === true || (Number.isFinite(approvedAmount) && approvedAmount > 0);
      const recommendation = String(qa.stage_recommendation || "").toUpperCase();
      const recommendedReady = recommendation === "PRICE_APPROVED_READY_TO_SEND" || String(lead.recommended_reason || "").toUpperCase() === "PRICE_APPROVED_READY_TO_SEND";
      return Boolean(approved || recommendedReady);
    }

    function stageActionsForLead(lead) {
      const s = String(lead && lead.stage ? lead.stage : "").toUpperCase();
      if (s === "NEW" || s === "QUALIFICATION_PENDING") {
        return [
          { label: "Msg qualification", stage: "QUALIFICATION_PENDING" },
          { label: "Msg prix", stage: "QUALIFIED" }
        ];
      }
      if (s === "QUALIFIED") {
        const hasPaymentSignal = Boolean(lead && (lead.has_payment_question || lead.has_deposit_link_sent));
        return [
          { label: "Msg prix", stage: "QUALIFIED" },
          { label: "Msg prix + visio", stage: "PRICE_SENT" },
          ...(hasPaymentSignal ? [{ label: "Msg acompte", stage: "DEPOSIT_PENDING" }] : [])
        ];
      }
      if (s === "PRICE_SENT") {
        const hasPaymentSignal = Boolean(lead && (lead.has_payment_question || lead.has_deposit_link_sent));
        return hasPaymentSignal
          ? [{ label: "Msg acompte", stage: "DEPOSIT_PENDING" }]
          : [{ label: "Msg visio", stage: "PRICE_SENT" }];
      }
      if (s === "DEPOSIT_PENDING") {
        return [{ label: "Msg acompte", stage: "DEPOSIT_PENDING" }];
      }
      if (s === "CONFIRMED") {
        return [{ label: "Msg confirmation", stage: "CONFIRMED" }];
      }
      return [];
    }

    function modelButtonsForLead(_lead) {
      const lead = _lead || {};
      const base = [
        { key: "qualification", label: "Msg qualification", type: "preset_qualification" },
        { key: "price", label: "Msg prix", type: "preset_price_only" },
        { key: "price_video", label: "Msg prix + visio", type: "preset_price_video" },
        { key: "video", label: "Proposer visio", type: "preset_video_slot" },
        { key: "followup_adapted", label: "Relance adaptée", type: "preset_followup_adapted" },
        { key: "deposit", label: "Msg acompte", type: "target", stage: "DEPOSIT_PENDING" },
        { key: "confirmation", label: "Msg confirmation", type: "target", stage: "CONFIRMED" }
      ];
      if (leadIsReadyToSendApprovedQuote(lead)) {
        return [{ key: "send_approved_quote", label: "Envoyer au client", type: "send_approved_quote" }, ...base];
      }
      return base;
    }

    async function loadComposerStageTemplateButtons(lead) {
      if (!lead) {
        composerStageTemplateButtons = [];
        renderComposerModelButtons();
        return;
      }
      const stage = String(lead.stage || "").toUpperCase();
      if (!stage) {
        composerStageTemplateButtons = [];
        renderComposerModelButtons();
        return;
      }
      const token = ++composerTemplateLoadToken;
      try {
        const payload = await fetchJson(
          "/api/whatsapp/stage-template-suggestions?enabled=true&stage=" + encodeURIComponent(stage) + (qs ? "&" + q.toString() : "")
        );
        if (token !== composerTemplateLoadToken) return;
        const items = Array.isArray(payload && payload.items) ? payload.items : [];
        composerStageTemplateButtons = items
          .filter((it) => it && it.template_name)
          .map((it) => ({
            key: "tpl_" + String(it.template_name),
            label: "Tpl: " + String(it.template_name),
            type: "template",
            templateName: String(it.template_name)
          }));
      } catch {
        if (token !== composerTemplateLoadToken) return;
        composerStageTemplateButtons = [];
      }
      renderComposerModelButtons();
    }

    function recommendedModelKey(lead) {
      if (!lead) return "";
      const stage = String(lead.stage || "").toUpperCase();
      const hasDate = Boolean(String(lead.event_date || "").trim());
      const hasDestination = Boolean(
        String(lead.ship_city || "").trim() ||
        String(lead.ship_country || "").trim() ||
        String(lead.ship_destination_text || "").trim()
      );
      const qualificationComplete = hasDate && hasDestination;
      if (!qualificationComplete || stage === "NEW" || stage === "QUALIFICATION_PENDING") return "qualification";
      if (stage === "QUALIFIED" && !lead.has_price_sent) return "price_video";
      if (stage === "QUALIFIED") return "price";
      if (stage === "PRICE_SENT" && (lead.has_payment_question || lead.has_deposit_link_sent)) return "deposit";
      if (stage === "PRICE_SENT" && !lead.has_video_proposed) return "video";
      if (stage === "PRICE_SENT" && lead.chat_confirmed) return "confirmation";
      if (stage === "DEPOSIT_PENDING") return "deposit";
      if (stage === "CONFIRMED") return "confirmation";
      return "price";
    }

    function renderComposerModelButtons() {
      if (!composerModelButtonsEl) return;
      const lead = selectedLead();
      if (!lead) {
        composerModelButtonsEl.innerHTML = "";
        return;
      }
      const hasInbound = selectedLeadHasInboundMessage();
      const recommended = recommendedModelKey(lead);
      const list = [...modelButtonsForLead(lead), ...composerStageTemplateButtons];
      composerModelButtonsEl.innerHTML = list
        .map((item) => {
          const isRecommended = item.key === recommended;
          return '<button type="button" class="model-btn' + (isRecommended ? " recommended" : "") + '" data-model-key="' + esc(item.key) + '"' +
            (item.type === "target"
              ? ' data-target-stage="' + esc(item.stage) + '"'
              : item.type === "template"
                ? ' data-model-type="template" data-template-name="' + esc(item.templateName || "") + '"'
                : ' data-model-type="' + esc(item.type) + '"') +
            ((hasInbound || item.type === "template" || item.type === "preset_qualification" || item.type === "preset_price_only" || item.type === "preset_price_video" || item.type === "preset_video_slot" || item.type === "preset_followup_adapted") ? "" : " disabled") + ">" + esc(item.label) + (isRecommended ? " ✨" : "") + "</button>";
        })
        .join("");
    }

    function renderConversationStageActions() {
      const lead = selectedLead();
      if (!lead) {
        if (conversationStageActionsEl) conversationStageActionsEl.innerHTML = "";
        composerStageTemplateButtons = [];
        renderComposerModelButtons();
        return;
      }
      if (conversationStageActionsEl) {
        const hasInbound = selectedLeadHasInboundMessage();
        const actions = stageActionsForLead(lead);
        conversationStageActionsEl.innerHTML = actions
          .map((a) => '<button type="button" class="stage-msg-btn" data-target-stage="' + esc(a.stage) + '"' + (hasInbound ? "" : " disabled") + ">" + esc(a.label) + "</button>")
          .join("");
      }
      renderComposerModelButtons();
      void loadComposerStageTemplateButtons(lead);
    }

    async function fetchJson(url, opts) {
      const res = await fetch(url, opts);
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!res.ok) {
        const error = new Error((body && (body.error || body.message)) || res.statusText || "Request failed");
        error.status = res.status;
        throw error;
      }
      return body;
    }

    function showToast(text) {
      if (!uiToastEl) return;
      uiToastEl.textContent = String(text || "");
      uiToastEl.classList.add("show");
      window.setTimeout(() => {
        if (uiToastEl) uiToastEl.classList.remove("show");
      }, 1800);
    }

    function setDebugLine(text) {
      if (!IS_DEV || !debugLineEl) return;
      debugLineEl.textContent = String(text || "");
    }

    function getDevToolsCardEl() {
      return refreshTestLeadsBtnEl ? refreshTestLeadsBtnEl.closest(".card") : null;
    }

    function setDangerConfirmEnabled() {
      if (!(dangerConfirmBtnEl instanceof HTMLButtonElement)) return;
      const value = dangerConfirmInputEl instanceof HTMLInputElement ? String(dangerConfirmInputEl.value || "").trim() : "";
      dangerConfirmBtnEl.disabled = value !== "DELETE";
    }

    function closeDangerModal() {
      pendingDangerAction = null;
      if (dangerConfirmBackdropEl) dangerConfirmBackdropEl.classList.remove("open");
      if (dangerConfirmInputEl instanceof HTMLInputElement) dangerConfirmInputEl.value = "";
      setDangerConfirmEnabled();
    }

    function renderTestLeadsTable() {
      if (!testLeadsWrapEl) return;
      const list = Array.isArray(testLeads) ? testLeads : [];
      if (!list.length) {
        testLeadsWrapEl.innerHTML = '<div class="dev-tools-empty">No test leads found.</div>';
        return;
      }
      testLeadsWrapEl.innerHTML =
        '<table class="dev-tools-table">' +
          "<thead><tr><th>Client</th><th>Phone</th><th>Stage</th><th>Tag</th><th></th></tr></thead>" +
          "<tbody>" +
            list.map((lead) => {
              const id = String(lead && lead.id ? lead.id : "");
              const client = String(lead && lead.client_name ? lead.client_name : "Client");
              const phone = String(lead && lead.phone_number ? lead.phone_number : "—");
              const stage = String(lead && lead.stage ? lead.stage : "—");
              const tag = String(lead && lead.test_tag ? lead.test_tag : "—");
              return (
                "<tr>" +
                  "<td>" + esc(client) + "</td>" +
                  "<td>" + esc(phone) + "</td>" +
                  "<td>" + esc(stage) + "</td>" +
                  "<td>" + esc(tag) + "</td>" +
                  '<td><button type="button" class="small-btn dev-tools-danger" data-delete-test-lead="' + esc(id) + '">Delete</button></td>' +
                "</tr>"
              );
            }).join("") +
          "</tbody>" +
        "</table>";
    }

    async function fetchTestLeadCounts(leadId) {
      const params = new URLSearchParams(q.toString());
      if (leadId) params.set("leadId", leadId);
      const query = params.toString();
      const payload = await fetchJson("/api/whatsapp/leads/test/counts" + (query ? ("?" + query) : ""));
      return {
        leads: Number(payload && payload.leads ? payload.leads : 0),
        messages: Number(payload && payload.messages ? payload.messages : 0),
        ai_runs: Number(payload && payload.ai_runs ? payload.ai_runs : 0),
        quotes: Number(payload && payload.quotes ? payload.quotes : 0)
      };
    }

    function openDangerModal(action, counts) {
      pendingDangerAction = action;
      const summary =
        "Delete " + String(counts && counts.leads ? counts.leads : 0) +
        " lead(s), " + String(counts && counts.messages ? counts.messages : 0) +
        " message(s), " + String(counts && counts.ai_runs ? counts.ai_runs : 0) +
        " AI run(s), " + String(counts && counts.quotes ? counts.quotes : 0) + " quote(s).";
      if (dangerConfirmTextEl) dangerConfirmTextEl.textContent = summary;
      if (dangerConfirmInputEl instanceof HTMLInputElement) {
        dangerConfirmInputEl.value = "";
        dangerConfirmInputEl.focus();
      }
      setDangerConfirmEnabled();
      if (dangerConfirmBackdropEl) dangerConfirmBackdropEl.classList.add("open");
    }

    async function executeDangerDelete() {
      if (!pendingDangerAction) return;
      if (!(dangerConfirmBtnEl instanceof HTMLButtonElement)) return;
      const action = pendingDangerAction;
      dangerConfirmBtnEl.disabled = true;
      const prevLabel = dangerConfirmBtnEl.textContent || "Delete";
      dangerConfirmBtnEl.textContent = "Deleting...";
      try {
        const body = action.mode === "all" ? { mode: "all" } : { leadId: action.leadId };
        const result = await fetchJson("/api/whatsapp/leads/test" + qs, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        closeDangerModal();
        showToast(
          "Deleted " + String(result && result.deleted_leads ? result.deleted_leads : 0) + " test lead(s)"
        );
        await loadTestLeadsDevTools();
        await loadAll();
      } catch (error) {
        showErrorBanner(formatError(error));
      } finally {
        dangerConfirmBtnEl.textContent = prevLabel;
        setDangerConfirmEnabled();
      }
    }

    async function promptDeleteSingleTestLead(leadId) {
      if (!leadId) return;
      try {
        const counts = await fetchTestLeadCounts(leadId);
        openDangerModal({ mode: "single", leadId }, counts);
      } catch (error) {
        showErrorBanner(formatError(error));
      }
    }

    async function promptDeleteAllTestLeads() {
      try {
        const counts = await fetchTestLeadCounts("");
        openDangerModal({ mode: "all" }, counts);
      } catch (error) {
        showErrorBanner(formatError(error));
      }
    }

    async function loadTestLeadsDevTools() {
      const devToolsCardEl = getDevToolsCardEl();
      if (!devToolsCardEl) return;
      if (!TEST_DELETION_ENABLED) {
        devToolsCardEl.style.display = "none";
        return;
      }
      devToolsCardEl.style.display = "";
      if (testLeadsSummaryEl) testLeadsSummaryEl.textContent = "Loading...";
      if (testLeadsWrapEl) testLeadsWrapEl.innerHTML = "";
      try {
        const payload = await fetchJson("/api/whatsapp/leads/test" + qs);
        testLeads = Array.isArray(payload && payload.items) ? payload.items : [];
        const counts = await fetchTestLeadCounts("");
        if (testLeadsSummaryEl) {
          testLeadsSummaryEl.textContent =
            String(testLeads.length) + " test lead(s) · " +
            String(counts.messages) + " messages · " +
            String(counts.ai_runs) + " AI runs · " +
            String(counts.quotes) + " quotes";
        }
        renderTestLeadsTable();
      } catch (error) {
        if (testLeadsSummaryEl) testLeadsSummaryEl.textContent = "Unable to load test leads.";
        if (testLeadsWrapEl) testLeadsWrapEl.innerHTML = '<div class="dev-tools-empty">API unavailable.</div>';
        console.error("[ui] load test leads failed", error);
      }
    }

    function renderLeadDebugPanel() {
      if (!leadDebugPanelEl) return;
      if (typeof window !== "undefined") {
        window.__debugLeadMode = Boolean(leadDebugOpen);
      }
      if (document && document.body) {
        document.body.classList.toggle("debug-on", Boolean(leadDebugOpen));
      }
      if (!leadDebugOpen) {
        leadDebugPanelEl.classList.remove("open");
        return;
      }
      leadDebugPanelEl.classList.add("open");
      if (!leadDebugData) {
        leadDebugPanelEl.innerHTML = "<pre>Chargement debug...</pre>";
        return;
      }
      const d = leadDebugData || {};
      const flags = d.flags || {};
      const lastIn = d.last_in_message || null;
      const suggestion = d.suggestion || null;
      const mergeOrder = Array.isArray(d.destination_merge_order) ? d.destination_merge_order : [];
      const lines = [
        "stage_current: " + String(d.stage_current || "-"),
        "stage_next: " + String(d.stage_next || "-"),
        "",
        "flags:",
        "  product_interest=" + String(Boolean(flags.product_interest)),
        "  price_sent=" + String(Boolean(flags.price_sent)),
        "  video_proposed=" + String(Boolean(flags.video_proposed)),
        "  payment_question=" + String(Boolean(flags.payment_question)),
        "  deposit_link_sent=" + String(Boolean(flags.deposit_link_sent)),
        "  deposit_pending=" + String(Boolean(flags.deposit_pending)),
        "  chat_confirmed=" + String(Boolean(flags.chat_confirmed)),
        "",
        "event_date: " + String(d.event_date || "-"),
        "ship_city: " + String(d.ship_city || "-"),
        "ship_country: " + String(d.ship_country || "-"),
        "",
        "last_in_message: " + (lastIn ? (String(lastIn.id || "-") + " | " + String(lastIn.text || "-")) : "-"),
        "rule_applied: " + String(d.rule_applied || "-"),
        "why: " + String(d.why || "-"),
        "suggestion: " + String(suggestion && suggestion.text ? suggestion.text : "-"),
        "suggestion_why: " + String(suggestion && suggestion.why ? suggestion.why : "-"),
        "",
        "destination_merge_order:",
        ...(mergeOrder.length ? mergeOrder.map((item) => "  - " + String(item)) : ["  - -"])
      ];
      leadDebugPanelEl.innerHTML = "<pre>" + esc(lines.join("\\n")) + "</pre>";
    }

    function isDebugMode() {
      return Boolean(window.__debugLeadMode) || document.body.classList.contains("debug-on");
    }

    async function loadLeadDebugProof(leadId) {
      if (!leadDebugOpen || !leadDebugPanelEl) return;
      leadDebugData = null;
      renderLeadDebugPanel();
      try {
        const payload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/debug-proof" + qs);
        leadDebugData = payload || null;
      } catch (error) {
        leadDebugData = { why: "debug_fetch_failed: " + formatError(error) };
      }
      renderLeadDebugPanel();
    }

    function renderSuggestionTemplateOptions(items) {
      if (!suggestionTemplateOptionsEl) return;
      const list = Array.isArray(items) ? items : [];
      if (!list.length) {
        suggestionTemplateOptionsEl.innerHTML = "";
        return;
      }
      suggestionTemplateOptionsEl.innerHTML =
        list
          .slice(0, 6)
          .map((tpl) => {
            const name = String(tpl && tpl.template_name ? tpl.template_name : "-");
            const category = String(tpl && tpl.category ? tpl.category : "");
            const language = String(tpl && tpl.language ? tpl.language : "fr");
            return '<button type="button" class="small-btn" data-template-name="' + esc(name) + '" data-template-language="' + esc(language) + '" title="Envoyer ce template via Zoko">' +
              "Tpl: " + esc(name) + (category ? " · " + esc(category) : "") +
              "</button>";
          })
          .join("");
    }

    function suggestionsUiLang() {
      const lead = selectedLead();
      if (!lead) return "FR";
      return String(lead.country || "").toUpperCase() === "US" ? "EN" : "FR";
    }

    function suggestionUiText(key) {
      const dict = {
        elapsed: "Écoulé",
        insert: "Insérer",
        copy: "Copier",
        sharedTitlePrefix: "Suggestion partagée",
        sharedReason: "Insight du canal partagé importé",
        sharedContext: "Numéro partagé: analyse uniquement. Copier les suggestions (pas d'envoi).",
        noLeadContext: "Suggestion basée sur: message entrant + stage.",
        noInboundContext: "Suggestion indisponible: aucun message entrant détecté.",
        defaultContext: "Suggestion basée sur: dernier message entrant + stage actuel."
      };
      return dict[key] || "";
    }

    function normalizeLocationToken(value) {
      return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .replace(/[^a-z\\s]/g, " ")
        .replace(/\\s+/g, " ")
        .trim();
    }

    function getClientTimeZone(facts) {
      const cityMap = {
        madrid: "Europe/Madrid",
        paris: "Europe/Paris",
        london: "Europe/London",
        dubai: "Asia/Dubai",
        casablanca: "Africa/Casablanca",
        rabat: "Africa/Casablanca",
        marrakech: "Africa/Casablanca",
        "new york": "America/New_York",
        miami: "America/New_York",
        columbus: "America/New_York",
        "los angeles": "America/Los_Angeles",
        "san francisco": "America/Los_Angeles",
        chicago: "America/Chicago"
      };
      const countryMap = {
        MA: "Africa/Casablanca",
        FR: "Europe/Paris",
        ES: "Europe/Madrid",
        UK: "Europe/London",
        AE: "Asia/Dubai",
        SA: "Asia/Riyadh",
        US: "America/New_York",
        CA: "America/Toronto"
      };

      const cityCandidates = [
        facts && facts.city,
        facts && facts.ship_city
      ]
        .filter(Boolean)
        .map((v) => normalizeLocationToken(v));

      const destination = String(facts && facts.destination ? facts.destination : "");
      if (destination) {
        destination
          .split(/[,-]/)
          .map((part) => normalizeLocationToken(part))
          .filter(Boolean)
          .forEach((part) => cityCandidates.push(part));
      }

      for (const city of cityCandidates) {
        if (cityMap[city]) return { tz: cityMap[city], label: city };
      }

      const countryRaw = String(facts && facts.country ? facts.country : "").trim().toUpperCase();
      if (countryRaw && countryMap[countryRaw]) return { tz: countryMap[countryRaw], label: countryRaw };
      if (countryRaw === "GB") return { tz: countryMap.UK, label: "UK" };
      if (countryRaw || cityCandidates.length) return { tz: "Africa/Casablanca", label: "Casablanca" };
      return { tz: null, label: "" };
    }

    function getClientLocalTimeContext(facts) {
      const zone = getClientTimeZone(facts);
      const tz = zone && zone.tz ? String(zone.tz) : null;
      if (!tz) {
        return {
          tz: null,
          time: "—",
          hour: -1,
          phase: "NIGHT",
          is_business_hours: false
        };
      }
      try {
        const hhmm = new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: tz
        }).format(new Date());
        const hour = Number(String(hhmm).slice(0, 2));
        let phase = "NIGHT";
        if (hour >= 6 && hour <= 8) phase = "EARLY";
        else if (hour >= 9 && hour <= 18) phase = "BUSINESS";
        else if (hour >= 19 && hour <= 22) phase = "EVENING";
        const isBusinessHours = hour >= 9 && hour <= 20;
        return {
          tz,
          time: hhmm,
          hour: Number.isFinite(hour) ? hour : -1,
          phase,
          is_business_hours: isBusinessHours
        };
      } catch {
        return {
          tz: null,
          time: "—",
          hour: -1,
          phase: "NIGHT",
          is_business_hours: false
        };
      }
    }

    function phaseLabel(phase) {
      const p = String(phase || "").toUpperCase();
      if (p === "EARLY") return "Early morning";
      if (p === "BUSINESS") return "Business hours";
      if (p === "EVENING") return "Evening";
      return "Night";
    }

    function deriveWaitingForFromMessages(messages) {
      const list = Array.isArray(messages) ? messages : [];
      if (!list.length) return null;
      const last = list[list.length - 1];
      const dir = String(last && last.direction ? last.direction : "").toUpperCase();
      if (dir === "IN") return "WAITING_FOR_US";
      if (dir === "OUT") return "WAITING_FOR_CLIENT";
      return null;
    }

    function renderWaitingForBadge(waitingFor) {
      if (!waitingForBadgeEl) return;
      const value = String(waitingFor || "").toUpperCase();
      const map = {
        WAITING_FOR_US: { text: "WAITING FOR US", cls: "wf-us" },
        WAITING_FOR_CLIENT: { text: "WAITING FOR CLIENT", cls: "wf-client" }
      };
      const cfg = map[value];
      if (!cfg) {
        waitingForBadgeEl.style.display = "none";
        waitingForBadgeEl.textContent = "";
        waitingForBadgeEl.className = "wf-badge";
        return;
      }
      waitingForBadgeEl.className = "wf-badge " + cfg.cls;
      waitingForBadgeEl.textContent = cfg.text;
      waitingForBadgeEl.style.display = "inline-flex";
    }

    function startClientLocalTimeTicker(facts) {
      if (clientLocalTimeTicker != null) {
        clearInterval(clientLocalTimeTicker);
        clientLocalTimeTicker = null;
      }
      if (!clientLocalTimeEl) return;
      const render = () => {
        const ctx = getClientLocalTimeContext(facts);
        clientLocalTimeEl.textContent = !ctx.tz
          ? "• Local time: —"
          : ("• Local time: " + ctx.time + " • " + phaseLabel(ctx.phase));
      };
      render();
      clientLocalTimeTicker = setInterval(render, 60000);
    }

    function inferEventMonthFromFacts(facts) {
      const direct = Number(facts && facts.event_month != null ? facts.event_month : NaN);
      if (Number.isFinite(direct) && direct >= 1 && direct <= 12) return direct;
      const text = String((facts && (facts.event_date_text || facts.event_date || "")) || "").toLowerCase();
      const tokens = {
        january: 1, jan: 1, janvier: 1,
        february: 2, feb: 2, fevrier: 2, "février": 2,
        march: 3, mar: 3, mars: 3,
        april: 4, apr: 4, avril: 4,
        may: 5, mai: 5,
        june: 6, jun: 6, juin: 6,
        july: 7, jul: 7, juillet: 7,
        august: 8, aug: 8, aout: 8, "août": 8,
        september: 9, sep: 9, sept: 9, septembre: 9,
        october: 10, oct: 10, octobre: 10,
        november: 11, nov: 11, novembre: 11,
        december: 12, dec: 12, decembre: 12, "décembre": 12
      };
      for (const [token, month] of Object.entries(tokens)) {
        if (text.includes(token)) return month;
      }
      return null;
    }

    function runConversationAudit(input) {
      const flags = [];
      const facts = input && input.facts ? input.facts : {};
      const messages = Array.isArray(input && input.messages) ? input.messages : [];
      const stage = String(input && input.stage ? input.stage : "").toUpperCase();
      const suggestions = Array.isArray(input && input.suggestions) ? input.suggestions : [];
      const timing = input && input.timing ? input.timing : null;
      const smartDelay = input && input.smart_delay ? input.smart_delay : null;
      const hasDestination = Boolean(String(facts.destination || "").trim());
      const hasEventDate = Boolean(String(facts.event_date || "").trim());
      const hasEventMonth = Boolean(inferEventMonthFromFacts(facts));
      const hasAnyDate = hasEventDate || hasEventMonth;
      const lastInbound = messages.slice().reverse().find((m) => String(m && m.direction ? m.direction : "").toLowerCase() === "in");

      if (stage === "QUALIFICATION_PENDING" && hasDestination && hasAnyDate) {
        flags.push({
          level: "WARN",
          code: "STAGE_MISMATCH",
          title: "Incohérence de stage",
          detail: "Le stage est QUALIFICATION_PENDING alors que destination + mois/date d’événement sont présents. Envisager QUALIFIED."
        });
      }

      const asksForEventDate = suggestions.some((s) => {
        const t = String(s && s.text ? s.text : "").toLowerCase();
        const id = String(s && s.id ? s.id : "").toLowerCase();
        return id.includes("complete_qualification") || id.includes("qual_missing_fields") || t.includes("event date") || t.includes("date de votre");
      });
      if (asksForEventDate && hasAnyDate) {
        flags.push({
          level: "WARN",
          code: "SUGGESTION_CONFLICT_DATE",
          title: "Conflit de suggestion",
          detail: "Une suggestion demande la date d’événement alors que le mois/date est déjà connu."
        });
      }

      if (Boolean(facts && facts.intents && facts.intents.deposit_intent) && (stage === "NEW" || stage === "PRODUCT_INTEREST" || stage === "QUALIFICATION_PENDING")) {
        flags.push({
          level: "WARN",
          code: "INTENT_STAGE_GAP",
          title: "Écart intention/stage",
          detail: "Intention d’acompte détectée mais le stage reste trop tôt. Envisager d’avancer le stage."
        });
      }
      if (Boolean(facts && facts.intents && facts.intents.payment_intent) && (stage === "NEW" || stage === "PRODUCT_INTEREST")) {
        flags.push({
          level: "INFO",
          code: "PAYMENT_EARLY",
          title: "Intention de paiement détectée",
          detail: "Une intention de paiement existe. Finaliser la qualification rapidement puis passer à l’acompte/paiement."
        });
      }

      if (timing && Number(timing.overdue_minutes || 0) > 0 && lastInbound && lastInbound.ts) {
        const mins = (Date.now() - new Date(lastInbound.ts).getTime()) / 60000;
        if (Number.isFinite(mins) && mins < 5) {
          flags.push({
            level: "ERROR",
            code: "TIMING_INCONSISTENT",
            title: "Timing incohérent",
            detail: "La carte indique du retard alors que le dernier entrant date de < 5 minutes. Vérifier les entrées de calcul."
          });
        }
      }

      const hasProductLink = messages.some((m) =>
        String(m && m.text ? m.text : "").toLowerCase().includes("/products/")
      );
      const hasResolvedProduct = Boolean(
        String(facts && facts.product_id ? facts.product_id : "").trim() ||
        (Array.isArray(facts && facts.product_handles) && facts.product_handles.length)
      );
      if (hasProductLink && !hasResolvedProduct) {
        flags.push({
          level: "INFO",
          code: "PRODUCT_NOT_RESOLVED",
          title: "Produit non résolu",
          detail: "La conversation contient un lien /products/ mais product_id est vide. Améliorer la détection produit."
        });
      }

      if (smartDelay && smartDelay.should_delay) {
        flags.push({
          level: "INFO",
          code: "SMART_DELAY_ACTIVE",
          title: "Relance intelligente différée",
          detail:
            "Relance différée jusqu’à " +
            String(smartDelay.delay_until_label || "prochaine fenêtre optimale") +
            " (heure locale). " +
            String(smartDelay.delay_reason || "")
        });
      }

      return flags;
    }

    function computeReplyWindowScore(input) {
      let score = 50;
      const phase = String(input && input.phase ? input.phase : "").toUpperCase();
      const elapsed = Number(input && input.elapsed_minutes != null ? input.elapsed_minutes : 0);
      const stage = String(input && input.stage ? input.stage : "").toUpperCase();
      if (phase === "BUSINESS") score += 25;
      else if (phase === "EVENING") score += 15;
      else if (phase === "EARLY") score += 5;
      else if (phase === "NIGHT") score -= 30;
      if (elapsed < 10) score += 15;
      if (elapsed > 60) score -= 10;
      if (stage === "PRICE_SENT" && phase === "BUSINESS") score += 10;
      score = Math.max(0, Math.min(100, Math.round(score)));
      let label = "Client probablement hors ligne";
      if (score >= 75) label = "Moment idéal pour répondre";
      else if (score >= 50) label = "Bonne fenêtre";
      else if (score >= 25) label = "Urgence faible";
      return { reply_window_score: score, label };
    }

    function renderAudit(flags, replyWindow, smartDelay) {
      if (!auditPanelEl) return;
      const list = Array.isArray(flags) ? flags : [];
      const smartDelayHtml = smartDelay
        ? (
            '<div class="audit-item audit-info">' +
              '<div class="audit-item-title">Relance intelligente</div>' +
              '<div class="audit-item-detail">' +
                (
                  smartDelay.should_delay
                    ? "DIFFÉRÉE jusqu’à " + esc(String(smartDelay.delay_until_label || "prochaine fenêtre optimale")) + " (heure locale)"
                    : "OK maintenant"
                ) +
              "</div>" +
              '<div class="audit-item-code">SMART_DELAY</div>' +
            "</div>"
          )
        : "";
      const replyHtml = replyWindow
        ? (
            '<div class="audit-item audit-info">' +
              '<div class="audit-item-title">Fenêtre de réponse</div>' +
              '<div class="audit-item-detail">Score: ' + esc(String(replyWindow.reply_window_score)) + "</div>" +
              '<div class="audit-item-detail">' + esc(String(replyWindow.label || "")) + "</div>" +
              '<div class="audit-item-code">REPLY_WINDOW</div>' +
            "</div>"
          )
        : "";
      if (!list.length) {
        auditPanelEl.innerHTML = smartDelayHtml + replyHtml + '<div class="audit-ok">Aucune incohérence détectée.</div>';
        return;
      }
      auditPanelEl.innerHTML = smartDelayHtml + replyHtml + list.map((f) => {
        const level = String(f && f.level ? f.level : "INFO").toUpperCase();
        const cls = level === "ERROR" ? "audit-item audit-error"
          : level === "WARN" ? "audit-item audit-warn"
          : "audit-item audit-info";
        return (
          '<div class="' + cls + '">' +
            '<div class="audit-item-title">' + esc(String(f && f.title ? f.title : "Audit flag")) + "</div>" +
            '<div class="audit-item-detail">' + esc(String(f && f.detail ? f.detail : "")) + "</div>" +
            '<div class="audit-item-code">' + esc(String(f && f.code ? f.code : "INFO")) + "</div>" +
          "</div>"
        );
      }).join("");
    }

    function wireAuditCopyButton(getPayload) {
      if (auditCopyWired || !(auditCopyBtnEl instanceof HTMLButtonElement)) return;
      auditCopyWired = true;
      auditCopyBtnEl.onclick = async () => {
        try {
          const payload = typeof getPayload === "function" ? getPayload() : null;
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          auditCopyBtnEl.textContent = "Copié";
          setTimeout(() => {
            if (auditCopyBtnEl) auditCopyBtnEl.textContent = "Copier debug";
          }, 900);
        } catch (e) {
          console.error("Copie debug échouée", e);
        }
      };
    }

    function refreshAuditState(input) {
      try {
        const leadId = String(input && input.leadId ? input.leadId : "");
        const stage = String(input && input.stage ? input.stage : "");
        const facts = input && input.facts ? input.facts : {};
        const messages = Array.isArray(input && input.messages) ? input.messages : [];
        const suggestions = Array.isArray(input && input.suggestions) ? input.suggestions : [];
        const timing = input && input.timing ? input.timing : null;
        const smartDelay = input && input.smart_delay ? input.smart_delay : null;
        const riskScore = Number(input && input.risk_score != null ? input.risk_score : 0);
        const localContext = getClientLocalTimeContext(facts);
        const replyWindow = computeReplyWindowScore({
          phase: localContext.phase,
          elapsed_minutes: timing && timing.since_inbound_minutes != null ? timing.since_inbound_minutes : 0,
          stage,
          risk_score: riskScore
        });
        const auditFlags = runConversationAudit({
          leadId,
          facts,
          messages,
          stage,
          suggestions,
          timing,
          smart_delay: smartDelay,
          risk_score: riskScore
        });
        renderAudit(auditFlags, replyWindow, smartDelay);
        latestAuditPayload = {
          leadId,
          stage,
          facts,
          timing,
          smart_delay: smartDelay,
          risk_score: riskScore,
          local_time_context: localContext,
          reply_window: replyWindow,
          topSuggestions: suggestions.slice(0, 3),
          auditFlags
        };
      } catch (error) {
        console.warn("[audit] refresh state failed", error);
        renderAudit([], null, null);
        latestAuditPayload = null;
      }
    }

    function getSugStorageKey(leadId) {
      return "sug_open_" + String(leadId || "");
    }

    function currentLeadId() {
      const lead = selectedLead();
      return String(lead && lead.id ? lead.id : selectedLeadId || "");
    }

    function readSuggestionOpenState(leadId) {
      if (!leadId) return null;
      try {
        const raw = localStorage.getItem(getSugStorageKey(leadId));
        if (raw === "1") return true;
        if (raw === "0") return false;
        return null;
      } catch {
        return null;
      }
    }

    function writeSuggestionOpenState(leadId, open) {
      if (!leadId) return;
      try {
        localStorage.setItem(getSugStorageKey(leadId), open ? "1" : "0");
      } catch {}
    }

    function loadSugOpenDefault(leadId, hasCritical, waitingFor) {
      const saved = readSuggestionOpenState(leadId);
      if (saved === true) return true;
      if (saved === false) return false;
      return Boolean(hasCritical || String(waitingFor || "").toUpperCase() === "WAITING_FOR_US");
    }

    function applySuggestionShellState() {
      if (!(sugToggleEl instanceof HTMLButtonElement) || !suggestionCardsEl) return;
      sugToggleEl.classList.toggle("open", suggestionPanelOpen);
      sugToggleEl.setAttribute("aria-expanded", String(suggestionPanelOpen));
      if (suggestionShellEl) suggestionShellEl.classList.toggle("is-collapsed", !suggestionPanelOpen);
      if (sugToggleActionEl) sugToggleActionEl.textContent = suggestionPanelOpen ? "Hide" : "Show";
    }

    function setSugOpen(isOpen, leadId, options) {
      suggestionPanelOpen = Boolean(isOpen);
      applySuggestionShellState();
      const targetLeadId = String(leadId || currentLeadId());
      if (targetLeadId) writeSuggestionOpenState(targetLeadId, suggestionPanelOpen);
      if (options && options.userInitiatedOpen && suggestionPanelOpen && targetLeadId) {
        sugAutoCollapsedMap[targetLeadId] = false;
      }
    }

    function startSuggestionElapsedTicker() {
      if (suggestionElapsedTimer != null) {
        clearInterval(suggestionElapsedTimer);
        suggestionElapsedTimer = null;
      }
      if (!suggestionCardsEl) return;
      suggestionElapsedTimer = setInterval(() => {
        const elapsedEls = suggestionCardsEl.querySelectorAll(".sug-elapsed[data-elapsed-min]");
        elapsedEls.forEach((el) => {
          const value = Number(el.getAttribute("data-elapsed-min") || "0");
          const nextValue = Number.isFinite(value) ? value + 1 : 1;
          el.setAttribute("data-elapsed-min", String(nextValue));
          el.textContent = suggestionUiText("elapsed") + ": " + String(nextValue) + " min";
        });
      }, 60000);
    }

    function renderSuggestionCards(items) {
      if (!suggestionCardsEl) return;
      const list = Array.isArray(items) ? items : [];
      const lead = selectedLead();
      const detectedSignals = lead && lead.detected_signals && typeof lead.detected_signals === "object" ? lead.detected_signals : {};
      const quoteApproval = detectedSignals && detectedSignals.quote_approval && typeof detectedSignals.quote_approval === "object"
        ? detectedSignals.quote_approval
        : {};
      const quotePrice = quoteApproval && quoteApproval.price && typeof quoteApproval.price === "object" ? quoteApproval.price : {};
      const quoteAmount = Number(quotePrice && quotePrice.approved_amount != null ? quotePrice.approved_amount : 0);
      const quoteCurrency = String(quotePrice && quotePrice.approved_currency ? quotePrice.approved_currency : "MAD").toUpperCase();
      const quoteFormatted = Number.isFinite(quoteAmount) && quoteAmount > 0
        ? (quoteCurrency === "USD"
            ? "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(quoteAmount))
            : quoteCurrency === "EUR"
              ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(quoteAmount)).replace(/\u202f/g, " ") + "€"
              : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(quoteAmount)).replace(/\u202f/g, " ") + " MAD")
        : null;
      const quoteReadyRecommendation = String(quoteApproval && quoteApproval.stage_recommendation ? quoteApproval.stage_recommendation : "").toUpperCase() === "PRICE_APPROVED_READY_TO_SEND";
      const quoteReadyStage = String(lead && lead.stage ? lead.stage : "").toUpperCase() === "PRICE_APPROVED_READY_TO_SEND";
      const quoteReady = Boolean((quotePrice && quotePrice.approved === true) || quoteReadyRecommendation || quoteReadyStage);
      const sendApprovedCard = quoteReady
        ? {
            id: "__send_approved_quote__",
            title: "Envoyer au client",
            text: "Devis approuvé — prêt à envoyer" + (quoteFormatted ? " (" + quoteFormatted + ")" : ""),
            reason: "Validation manager confirmée",
            priority: 999,
            pinned_action: true
          }
        : null;
      const leadId = String(lead && lead.id ? lead.id : "");
      if (leadId !== currentSuggestionLeadId) {
        currentSuggestionLeadId = leadId;
        suggestionExpandedIds = new Set();
        suggestionShowAll = false;
      }
      const sortedCards = list
        .slice()
        .sort((a, b) => {
          const aUnified = Number(a && a.priority_unified && a.priority_unified.score != null ? a.priority_unified.score : 0);
          const bUnified = Number(b && b.priority_unified && b.priority_unified.score != null ? b.priority_unified.score : 0);
          if (bUnified !== aUnified) return bUnified - aUnified;
          const aTiming = Number(a && a.timing && a.timing.pressure_score != null ? a.timing.pressure_score : 0);
          const bTiming = Number(b && b.timing && b.timing.pressure_score != null ? b.timing.pressure_score : 0);
          if (bTiming !== aTiming) return bTiming - aTiming;
          return Number(b && b.priority != null ? b.priority : 0) - Number(a && a.priority != null ? a.priority : 0);
        })
        .slice(0, quoteReady ? 4 : 3);
      currentSuggestionCards = sendApprovedCard ? [sendApprovedCard].concat(sortedCards) : sortedCards;

      if (sugCountEl) sugCountEl.textContent = String(currentSuggestionCards.length);
      if (suggestionShellEl) suggestionShellEl.style.display = currentSuggestionCards.length ? "" : "none";

      if (!currentSuggestionCards.length) {
        suggestionCardsEl.innerHTML = "";
        if (suggestionElapsedTimer != null) {
          clearInterval(suggestionElapsedTimer);
          suggestionElapsedTimer = null;
        }
        renderAudit([], null, null);
        latestAuditPayload = null;
        return;
      }

      suggestionCardsEl.innerHTML = currentSuggestionCards
        .map((card) => {
          if (card && card.pinned_action) {
            return (
              '<article class="suggestion-card suggestion-card--critical" data-suggestion-card-id="__send_approved_quote__">' +
                '<div class="h">' +
                  '<div class="t">Envoyer au client</div>' +
                  '<div class="h-right"><span class="sug-urgency sug-urgency--CRITICAL">READY</span></div>' +
                "</div>" +
                '<div class="txt">Devis approuvé — prêt à envoyer' + (quoteFormatted ? " (" + esc(quoteFormatted) + ")" : "") + "</div>" +
                '<div class="why">Produit: ' + esc(String(quoteApproval && quoteApproval.product && quoteApproval.product.title ? quoteApproval.product.title : (lead && (lead.product || lead.product_reference) || "Pièce"))) + "</div>" +
                '<div class="sug-metrics">' +
                  '<button type="button" class="insert-btn" data-send-approved-quote="1">Envoyer</button>' +
                "</div>" +
                '<div class="sug-metrics" style="margin-top:8px">' +
                  '<button type="button" class="small-btn" data-send-approved-quote-edit="1">Modifier</button>' +
                "</div>" +
              "</article>"
            );
          }
          const id = String(card && card.id ? card.id : "");
          const title = String(card && card.title ? card.title : "Suggestion");
          const text = String(card && card.text ? card.text : "");
          const reason = String(card && card.reason ? card.reason : "");
          const priority = Number(card && card.priority != null ? card.priority : 0);

          const timing = card && card.timing ? card.timing : null;
          const smartDelay = card && card.smart_delay ? card.smart_delay : null;
          const urgency = timing && timing.urgency ? String(timing.urgency).toUpperCase() : "";
          const timingLabel = timing && timing.label ? String(timing.label) : "";
          const timingExplanation = timing && timing.explanation ? String(timing.explanation) : "";
          const elapsedMinutes = timing && timing.since_minutes != null
            ? Number(timing.since_minutes)
            : timing && timing.since_inbound_minutes != null
              ? Number(timing.since_inbound_minutes)
              : null;
          const targetMinutes = timing && timing.target_minutes != null ? Number(timing.target_minutes) : null;
          const overdueMinutes = timing && timing.overdue_minutes != null ? Number(timing.overdue_minutes) : null;

          const urgencyClass = urgency ? " sug-urgency--" + urgency : "";
          const urgencyTitle = timingExplanation || (timingLabel ? timingLabel : "");

          const urgencyHtml = urgency
            ? '<span class="sug-urgency' +
              esc(urgencyClass) +
              '" title="' +
              esc(urgencyTitle) +
              '" aria-label="' +
              esc(urgencyTitle) +
              '">' +
              esc(urgency) +
              "</span>"
            : "";

          const timingHtml = timingLabel ? '<div class="sug-timing" title="' + esc(urgencyTitle) + '">' + esc(timingLabel) + "</div>" : "";
          const metricsHtml = (
            (elapsedMinutes != null && Number.isFinite(elapsedMinutes)) ||
            (targetMinutes != null && Number.isFinite(targetMinutes)) ||
            (overdueMinutes != null && Number.isFinite(overdueMinutes))
          )
            ? (
                '<div class="sug-metrics">' +
                  (elapsedMinutes != null && Number.isFinite(elapsedMinutes)
                    ? '<span class="sug-metric-chip sug-elapsed" data-elapsed-min="' + esc(String(elapsedMinutes)) + '">' + esc(suggestionUiText("elapsed")) + ': ' + esc(String(elapsedMinutes)) + " min</span>"
                    : "") +
                  (targetMinutes != null && Number.isFinite(targetMinutes)
                    ? '<span class="sug-metric-chip">Cible: ' + esc(String(targetMinutes)) + " min</span>"
                    : "") +
                  (overdueMinutes != null && Number.isFinite(overdueMinutes) && overdueMinutes > 0
                    ? '<span class="sug-metric-chip sug-metric-chip--warn">Retard: ' + esc(String(overdueMinutes)) + " min</span>"
                    : "") +
                "</div>"
              )
            : "";
          const smartDelayHtml = smartDelay && smartDelay.should_delay
            ? (
                '<div class="sug-delay" title="' + esc(String(smartDelay.delay_reason || "")) + '">' +
                "Reporter jusqu’à: " + esc(String(smartDelay.delay_until_label || "prochaine fenêtre optimale")) + " (heure locale)" +
                "</div>"
              )
            : smartDelay && smartDelay.override_allowed_now
              ? '<div class="sug-delay sug-delay--warn">Heures creuses • envoi possible maintenant</div>'
              : "";

          const actionLabel = selectedLeadIsShared() ? suggestionUiText("copy") : suggestionUiText("insert");
          const priorityHtml = '<span class="p" title="priority">' + esc(String(priority)) + "</span>";
          const unifiedLevel = card && card.priority_unified && card.priority_unified.level
            ? String(card.priority_unified.level).toUpperCase()
            : "";
          const criticalClass = urgency === "CRITICAL" || unifiedLevel === "CRITICAL" ? " suggestion-card--critical" : "";
          const finalScore = card && card.final_score != null ? Number(card.final_score) : null;
          const dbg = card && card.score_debug ? card.score_debug : null;
          const scoreHtml = (isDebugMode() && finalScore != null && Number.isFinite(finalScore))
            ? '<span class="sug-score" title="Unified rank score">Score ' + esc(finalScore.toFixed(1)) + "</span>"
            : "";
          const dbgHtml = (isDebugMode() && dbg)
            ? (
                '<button type="button" class="dbg-toggle" data-dbg-toggle="' + esc(id) + '">Details</button>' +
                '<div class="dbg-panel" id="dbg-' + esc(id) + '" style="display:none">' +
                  '<div class="dbg-row"><span>priority</span><span>' + esc(String(dbg.priority)) + "</span></div>" +
                  '<div class="dbg-row"><span>pressure</span><span>' + esc(String(dbg.pressure_score)) + "</span></div>" +
                  '<div class="dbg-row"><span>risk</span><span>' + esc(String(dbg.risk_score)) + "</span></div>" +
                  '<div class="dbg-row"><span>boost</span><span>' + esc(String(dbg.boost)) + "</span></div>" +
                  '<div class="dbg-row"><span>intentMatch</span><span>' + esc(String(dbg.intentMatch)) + "</span></div>" +
                  '<div class="dbg-sep"></div>' +
                  '<div class="dbg-row"><span>priority*w</span><span>' + esc(String(Number(dbg.components && dbg.components.basePriorityWeight != null ? dbg.components.basePriorityWeight : 0).toFixed(1))) + "</span></div>" +
                  '<div class="dbg-row"><span>timing*w</span><span>' + esc(String(Number(dbg.components && dbg.components.timingWeight != null ? dbg.components.timingWeight : 0).toFixed(1))) + "</span></div>" +
                  '<div class="dbg-row"><span>risk*w</span><span>' + esc(String(Number(dbg.components && dbg.components.riskWeight != null ? dbg.components.riskWeight : 0).toFixed(1))) + "</span></div>" +
                  '<div class="dbg-row"><span>boost*w</span><span>' + esc(String(Number(dbg.components && dbg.components.learningWeight != null ? dbg.components.learningWeight : 0).toFixed(1))) + "</span></div>" +
                  '<div class="dbg-row"><span>intent bonus</span><span>' + esc(String(Number(dbg.components && dbg.components.intentWeight != null ? dbg.components.intentWeight : 0).toFixed(1))) + "</span></div>" +
                "</div>"
              )
            : "";

          return (
            '<article class="suggestion-card' + criticalClass + '" data-suggestion-card-id="' + esc(id) + '">' +
              '<div class="h">' +
                '<div class="t">' + esc(title) + "</div>" +
                '<div class="h-right">' +
                  priorityHtml +
                  scoreHtml +
                  urgencyHtml +
                "</div>" +
              "</div>" +
              '<div class="txt">' + esc(text) + "</div>" +
              timingHtml +
              metricsHtml +
              smartDelayHtml +
              (reason ? '<div class="why">' + esc(reason) + "</div>" : "") +
              dbgHtml +
              '<button type="button" class="insert-btn" data-suggestion-insert="' + esc(id) + '">' + esc(actionLabel) + "</button>" +
            "</article>"
          );
        })
        .join("");
    }

    async function sendApprovedQuoteForLead(lead) {
      if (!lead || !lead.id) return;
      try {
        statusLineEl.textContent = "Envoi du devis approuvé...";
        await fetchJson("/api/leads/" + encodeURIComponent(lead.id) + "/send-approved-quote" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: "whatsapp",
            mode: "text"
          })
        });
        showToast("Devis envoyé au client.");
        await loadConversationForLead(lead.id);
        await refreshSuggestionCardsForSelectedLead();
      } catch (error) {
        showErrorBanner(formatError(error));
      }
    }

    async function insertSuggestionCardById(cardId) {
      const id = String(cardId || "").trim();
      if (!id) return;
      const card = currentSuggestionCards.find((item) => String(item && item.id ? item.id : "") === id);
      if (!card) return;
      const text = String(card.text || "").trim();
      if (!text) return;
      if (selectedLeadIsShared()) {
        navigator.clipboard.writeText(text).then(
          () => {
            statusLineEl.textContent = "Suggestion copiée";
          },
          () => {
            statusLineEl.textContent = "Clipboard unavailable";
          }
        );
        return;
      }
      if (!(conversationTextEl instanceof HTMLTextAreaElement)) return;
      const lead = selectedLead();
      let feedbackToken = "";
      if (lead && lead.id) {
        try {
          const payload = await fetchJson("/api/whatsapp/suggestions/cards/feedback-draft" + qs, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              leadId: lead.id,
              cardId: id,
              cardText: text
            })
          });
          feedbackToken = payload && payload.feedback_token ? String(payload.feedback_token) : "";
        } catch {
          feedbackToken = "";
        }
      }
      conversationTextEl.value = text;
      conversationTextEl.focus();
      pendingSuggestionFeedback = {
        id: feedbackToken,
        source: "manual",
        suggestion_type: id,
        suggested_text: text
      };
      statusLineEl.textContent = "Suggestion insérée";
    }

    async function refreshSuggestionCardsForSelectedLead() {
      const lead = selectedLead();
      wireAuditCopyButton(() => latestAuditPayload);
      if (!lead) {
        renderSuggestionCards([]);
        renderWaitingForBadge(null);
        renderAudit([], null, null);
        latestAuditPayload = null;
        latestLeadInsights = null;
        return;
      }
      const stage = String(lead && lead.stage ? lead.stage : "").toUpperCase();
      const destinationParts = [lead && lead.ship_city, lead && lead.ship_region, lead && lead.ship_country].filter((v) => String(v || "").trim());
      const destination = destinationParts.length ? destinationParts.join(", ") : String((lead && lead.ship_destination_text) || "").trim();
      const leadHandles = Array.isArray(lead && lead.product_handles)
        ? lead.product_handles.map((h) => String(h || "").trim().toLowerCase()).filter(Boolean)
        : [];
      const inferredHandles = Array.from(new Set([
        ...leadHandles,
        ...extractProductHandlesFromText(String((lead && (lead.product || lead.product_reference)) || "")),
        ...((Array.isArray(leadMessages) ? leadMessages.slice(-20) : [])
          .flatMap((m) => extractProductHandlesFromText(String(m && m.text ? m.text : ""))))
      ]));
      const resolvedProductId = String((lead && (lead.product_id || lead.product_reference)) || "").trim() || (inferredHandles[0] || "");
      const facts = {
        stage,
        event_date: lead && lead.event_date ? lead.event_date : null,
        event_month: inferEventMonthFromFacts({ event_date_text: lead && lead.event_date_text }),
        event_date_text: lead && lead.event_date_text ? lead.event_date_text : null,
        destination,
        product_id: resolvedProductId,
        product_handles: inferredHandles,
        intents: {
          price_intent: Boolean(lead && (lead.price_intent || lead.priceIntent)),
          video_intent: Boolean(lead && (lead.video_intent || lead.videoIntent)),
          payment_intent: Boolean(lead && (lead.payment_intent || lead.paymentIntent)),
          deposit_intent: Boolean(lead && (lead.deposit_intent || lead.depositIntent)),
          confirmation_intent: Boolean(lead && (lead.confirmation_intent || lead.confirmationIntent))
        },
        risk_score: Number(lead && lead.risk && lead.risk.risk_score != null ? lead.risk.risk_score : 0)
      };
      const last20Messages = (Array.isArray(leadMessages) ? leadMessages.slice(-20) : []).map((m) => ({
        direction: String(m && m.direction ? m.direction : "").toUpperCase() === "OUT" ? "out" : "in",
        text: String(m && m.text ? m.text : ""),
        ts: String(m && m.created_at ? m.created_at : "")
      }));
      if (isSharedLeadClient(lead)) {
        try {
          const payload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/insights" + qs);
          latestLeadInsights = payload && payload.insight ? payload.insight : null;
          const replies = latestLeadInsights && Array.isArray(latestLeadInsights.suggested_replies)
            ? latestLeadInsights.suggested_replies
            : [];
          const cards = replies.slice(0, 4).map((reply, idx) => ({
            id: "shared_" + String(idx + 1),
            title: suggestionUiText("sharedTitlePrefix") + " " + String(idx + 1),
            text: String(reply || ""),
            reason: suggestionUiText("sharedReason"),
            priority: 90 - idx
          }));
          renderSuggestionCards(cards);
          renderWaitingForBadge(
            cards && cards[0] && cards[0].timing && cards[0].timing.waiting_for
              ? cards[0].timing.waiting_for
              : deriveWaitingForFromMessages(last20Messages)
          );
          startSuggestionElapsedTicker();
          refreshAuditState({
            leadId: lead.id,
            stage,
            facts,
            messages: last20Messages,
            suggestions: cards,
            timing: cards && cards[0] ? cards[0].timing : null,
            smart_delay: cards && cards[0] ? cards[0].smart_delay : null,
            risk_score: facts.risk_score
          });
          if (suggestionContextNoteEl) {
            suggestionContextNoteEl.textContent = suggestionUiText("sharedContext");
          }
        } catch {
          latestLeadInsights = null;
          renderSuggestionCards([]);
          renderAudit([], null, null);
        }
        return;
      }
      if (!selectedLeadHasInboundMessage()) {
        renderSuggestionCards([]);
        renderWaitingForBadge(deriveWaitingForFromMessages(last20Messages));
        refreshAuditState({
          leadId: lead.id,
          stage,
          facts,
          messages: last20Messages,
          suggestions: [],
          timing: null,
          smart_delay: null,
          risk_score: facts.risk_score
        });
        latestLeadInsights = null;
        return;
      }
      try {
        const payload = await fetchJson("/api/whatsapp/suggestions/cards" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: lead.id })
        });
        const cards = payload && Array.isArray(payload.cards) ? payload.cards : [];
        if (cards.length) {
          console.log("[whatsapp] suggestions timing check", {
            hasTiming: Boolean(cards[0] && cards[0].timing),
            urgency: cards[0] && cards[0].timing ? cards[0].timing.urgency : null,
            label: cards[0] && cards[0].timing ? cards[0].timing.label : null
          });
        }
        renderSuggestionCards(cards);
        renderWaitingForBadge(
          cards && cards[0] && cards[0].timing && cards[0].timing.waiting_for
            ? cards[0].timing.waiting_for
            : deriveWaitingForFromMessages(last20Messages)
        );
        startSuggestionElapsedTicker();
        refreshAuditState({
          leadId: lead.id,
          stage,
          facts,
          messages: last20Messages,
          suggestions: cards,
          timing: cards && cards[0] ? cards[0].timing : null,
          smart_delay: cards && cards[0] ? cards[0].smart_delay : null,
          risk_score: facts.risk_score
        });
        latestLeadInsights = null;
        if (suggestionContextNoteEl) {
          suggestionContextNoteEl.textContent =
            "Suggestions: intention du dernier message entrant (70%) + mémoire courte/facts (30%) · max 3 cartes.";
        }
      } catch {
        renderSuggestionCards([]);
        renderWaitingForBadge(deriveWaitingForFromMessages(last20Messages));
        renderAudit([], null, null);
        latestLeadInsights = null;
      }
    }

    async function sendTemplateForLead(lead, templateName, language, variables) {
      if (isSharedLeadClient(lead)) {
        showErrorBanner("Shared number (no API): template sending is disabled.");
        return;
      }
      const safeTemplate = String(templateName || "").trim();
      if (!safeTemplate) {
        showErrorBanner("Template manquant.");
        return;
      }
      const payload = await fetchJson("/api/whatsapp/send-template" + qs, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: lead.id,
          templateName: safeTemplate,
          language: String(language || "fr"),
          variables: Array.isArray(variables) ? variables : []
        })
      });
      console.log("[whatsapp] send-template", payload);
      showToast("Template envoyé.");
      await loadConversationForLead(lead.id);
      void loadAll();
    }

    function renderSuggestionReviewItems(items) {
      if (!suggestionReviewListEl) return;
      suggestionReviewItems = Array.isArray(items) ? items : [];
      if (!suggestionReviewItems.length) {
        suggestionReviewListEl.innerHTML = "<div class='tiny'>Aucune suggestion dans cette vue.</div>";
        return;
      }
      suggestionReviewListEl.innerHTML = suggestionReviewItems
        .map((item) => {
          const id = String(item.id || "");
          const clientName = String(item.client_name || "").trim() || "Client inconnu";
          const source = String(item.source || "-");
          const stype = String(item.suggestion_type || "-");
          const status = String(item.review_status || "OPEN").toUpperCase();
          const outcome = String(item.outcome_label || "-").toUpperCase();
          const accepted = item.accepted == null ? "-" : (item.accepted ? "YES" : "NO");
          const txt = String(item.suggestion_text || "");
          const statusPillClass = status === "REVIEWED" ? "ok" : status === "ARCHIVED" ? "warn" : "soft";
          const outcomePillClass = outcome === "CONVERTED" || outcome === "CONFIRMED"
            ? "ok"
            : outcome === "LOST"
              ? "bad"
              : "soft";
          const acceptedPillClass = accepted === "YES" ? "ok" : accepted === "NO" ? "bad" : "soft";
          const outcomeBtnClass = function (label) {
            return label === outcome ? "small-btn review-active" : "small-btn";
          };
          const statusBtnClass = function (label) {
            return label === status ? "small-btn review-active" : "small-btn";
          };
          return (
            '<article class="suggestion-review-item" data-suggestion-id="' + esc(id) + '">' +
              '<div class="suggestion-review-meta">' +
                '<span class="suggestion-pill">' + esc(clientName) + "</span>" +
                '<span class="suggestion-pill soft">' + esc(source) + "</span>" +
                '<span class="suggestion-pill soft">' + esc(stype) + "</span>" +
                '<span class="suggestion-pill ' + esc(statusPillClass) + '">status: ' + esc(status) + "</span>" +
                '<span class="suggestion-pill ' + esc(outcomePillClass) + '">outcome: ' + esc(outcome) + "</span>" +
                '<span class="suggestion-pill ' + esc(acceptedPillClass) + '">accepted: ' + esc(accepted) + "</span>" +
              "</div>" +
              '<div class="txt">' + esc(txt) + "</div>" +
              '<div class="suggestion-review-actions">' +
                '<div class="suggestion-review-actions-row">' +
                  '<button type="button" class="' + esc(outcomeBtnClass("REPLIED")) + '" data-suggestion-outcome="REPLIED">Replied</button>' +
                  '<button type="button" class="' + esc(outcomeBtnClass("PAYMENT_QUESTION")) + '" data-suggestion-outcome="PAYMENT_QUESTION">Payment?</button>' +
                  '<button type="button" class="' + esc(outcomeBtnClass("CONFIRMED")) + '" data-suggestion-outcome="CONFIRMED">Confirmed</button>' +
                  '<button type="button" class="' + esc(outcomeBtnClass("CONVERTED")) + '" data-suggestion-outcome="CONVERTED">Converted</button>' +
                  '<button type="button" class="' + esc(outcomeBtnClass("LOST")) + '" data-suggestion-outcome="LOST">Lost</button>' +
                "</div>" +
                '<div class="suggestion-review-actions-row">' +
                  '<button type="button" class="' + esc(statusBtnClass("REVIEWED")) + '" data-suggestion-review="REVIEWED">Mark reviewed</button>' +
                  '<button type="button" class="' + esc(statusBtnClass("ARCHIVED")) + '" data-suggestion-review="ARCHIVED">Archive</button>' +
                "</div>" +
              "</div>" +
            "</article>"
          );
        })
        .join("");
    }

    async function loadSuggestionReviewItems() {
      if (!suggestionReviewListEl) return;
      const status = suggestionReviewStatusFilterEl instanceof HTMLSelectElement ? String(suggestionReviewStatusFilterEl.value || "OPEN") : "OPEN";
      suggestionReviewListEl.innerHTML = "<div class='tiny'>Chargement suggestions...</div>";
      try {
        const payload = await fetchJson("/api/whatsapp/suggestions/review?status=" + encodeURIComponent(status) + "&limit=40" + (qs ? "&" + q.toString() : ""));
        renderSuggestionReviewItems(payload && Array.isArray(payload.items) ? payload.items : []);
      } catch (error) {
        suggestionReviewListEl.innerHTML = "<div class='tiny'>Impossible de charger la queue.</div>";
        showErrorBanner(formatError(error));
      } finally {
        void loadLearningStats();
      }
    }

    function applyLearningSettingsToForm(settings) {
      learningSettings = settings || null;
      if (!settings || typeof settings !== "object") return;
      if (learningWindowDaysInputEl instanceof HTMLInputElement) learningWindowDaysInputEl.value = String(settings.learning_window_days || 90);
      if (learningMinSamplesInputEl instanceof HTMLInputElement) learningMinSamplesInputEl.value = String(settings.min_samples || 3);
      if (learningSuccessWeightInputEl instanceof HTMLInputElement) learningSuccessWeightInputEl.value = String(settings.success_weight || 20);
      if (learningAcceptedWeightInputEl instanceof HTMLInputElement) learningAcceptedWeightInputEl.value = String(settings.accepted_weight || 10);
      if (learningLostWeightInputEl instanceof HTMLInputElement) learningLostWeightInputEl.value = String(settings.lost_weight || 14);
      if (learningBoostMinInputEl instanceof HTMLInputElement) learningBoostMinInputEl.value = String(settings.boost_min != null ? settings.boost_min : -15);
      if (learningBoostMaxInputEl instanceof HTMLInputElement) learningBoostMaxInputEl.value = String(settings.boost_max != null ? settings.boost_max : 20);
      if (learningSuccessOutcomesInputEl instanceof HTMLInputElement) {
        const list = Array.isArray(settings.success_outcomes) ? settings.success_outcomes : ["CONFIRMED", "CONVERTED"];
        learningSuccessOutcomesInputEl.value = list.join(", ");
      }
      if (learningFailureOutcomesInputEl instanceof HTMLInputElement) {
        const list = Array.isArray(settings.failure_outcomes) ? settings.failure_outcomes : ["LOST"];
        learningFailureOutcomesInputEl.value = list.join(", ");
      }
    }

    async function loadLearningSettings() {
      try {
        const payload = await fetchJson("/api/whatsapp/suggestions/learning-settings" + qs);
        applyLearningSettingsToForm(payload || null);
      } catch {
        learningSettings = null;
      }
    }

    async function loadLearningStats() {
      if (!learningStatsListEl) return;
      learningStatsListEl.textContent = "Chargement learning stats...";
      try {
        const payload = await fetchJson("/api/whatsapp/suggestions/performance?limit=10" + (qs ? "&" + q.toString() : ""));
        const items = payload && Array.isArray(payload.items) ? payload.items : [];
        if (!items.length) {
          learningStatsListEl.textContent = "Aucune donnée de learning pour le moment.";
          return;
        }
        const labelDays = Number(payload && payload.days != null ? payload.days : 90);
        learningStatsListEl.innerHTML = items
          .map((item) => {
            const key = String(item.suggestion_type || "-");
            const total = Number(item.total || 0);
            const accepted = Math.round(Number(item.accepted_rate || 0) * 100);
            const success = Math.round(Number(item.success_rate || 0) * 100);
            const lost = Math.round(Number(item.lost_rate || 0) * 100);
            const boost = Number(item.boost || 0);
            const sign = boost >= 0 ? "+" : "";
            return "<div style='padding:6px 0;border-bottom:1px solid #223248;'>" +
              "<strong>" + esc(key) + "</strong> · " +
              "<span class='tiny'>n=" + esc(total) + " · accepted=" + esc(accepted) + "% · success=" + esc(success) + "% · lost=" + esc(lost) + "% · boost=" + esc(sign + boost) + "</span>" +
              "</div>";
          })
          .join("") +
          "<div class='tiny' style='margin-top:8px;opacity:.85;'>Window: " + esc(labelDays) + " days</div>";
      } catch {
        learningStatsListEl.textContent = "Impossible de charger les learning stats.";
      }
    }

    function readLearningSettingsFromForm() {
      const parseList = (value) =>
        String(value || "")
          .split(",")
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean);
      return {
        learning_window_days: learningWindowDaysInputEl instanceof HTMLInputElement ? Number(learningWindowDaysInputEl.value || 90) : 90,
        min_samples: learningMinSamplesInputEl instanceof HTMLInputElement ? Number(learningMinSamplesInputEl.value || 3) : 3,
        success_weight: learningSuccessWeightInputEl instanceof HTMLInputElement ? Number(learningSuccessWeightInputEl.value || 20) : 20,
        accepted_weight: learningAcceptedWeightInputEl instanceof HTMLInputElement ? Number(learningAcceptedWeightInputEl.value || 10) : 10,
        lost_weight: learningLostWeightInputEl instanceof HTMLInputElement ? Number(learningLostWeightInputEl.value || 14) : 14,
        boost_min: learningBoostMinInputEl instanceof HTMLInputElement ? Number(learningBoostMinInputEl.value || -15) : -15,
        boost_max: learningBoostMaxInputEl instanceof HTMLInputElement ? Number(learningBoostMaxInputEl.value || 20) : 20,
        success_outcomes: learningSuccessOutcomesInputEl instanceof HTMLInputElement ? parseList(learningSuccessOutcomesInputEl.value) : ["CONFIRMED", "CONVERTED"],
        failure_outcomes: learningFailureOutcomesInputEl instanceof HTMLInputElement ? parseList(learningFailureOutcomesInputEl.value) : ["LOST"]
      };
    }

    function openTemplateModal() {
      if (!templateModalBackdropEl) return;
      templateModalBackdropEl.classList.add("open");
    }

    function closeTemplateModal() {
      if (!templateModalBackdropEl) return;
      templateModalBackdropEl.classList.remove("open");
    }

    function selectedTemplate() {
      return templatesCache.find((item) => String(item.id) === String(selectedTemplateId)) || null;
    }

    function normalizeTemplateText(components) {
      if (!Array.isArray(components) || !components.length) return "";
      return components
        .map((c) => {
          if (!c || typeof c !== "object") return "";
          return String(c.text || c.body || c.example || c.type || "").trim();
        })
        .filter(Boolean)
        .join("\\n");
    }

    function renderTemplateVarsForm(template) {
      if (!templateVariablesEl) return;
      const total = Number(template && template.variables_count != null ? template.variables_count : 0);
      if (!template || !total) {
        templateVariablesEl.innerHTML = "";
        return;
      }
      templateVariablesEl.innerHTML = Array.from({ length: total })
        .map((_, i) => '<input class="template-var-input" data-var-index="' + String(i + 1) + '" type="text" placeholder="{{' + String(i + 1) + '}}" />')
        .join("");
    }

    function renderTemplatesList(items) {
      if (!templateListEl) return;
      filteredTemplates = Array.isArray(items) ? items : [];
      templateListEl.innerHTML = filteredTemplates.length
        ? filteredTemplates
            .map((tpl) =>
              '<div class="template-item ' + (String(tpl.id) === String(selectedTemplateId) ? "active" : "") + '" data-template-id="' + esc(tpl.id) + '">' +
                '<div class="template-item-main">' +
                  "<strong>" + esc(tpl.name || "-") + "</strong>" +
                  "<div class='tiny'>" + esc(tpl.category || "UTILITY") + " · " + esc(tpl.language || "fr") + " · vars: " + esc(String(tpl.variables_count || 0)) + "</div>" +
                "</div>" +
                '<button type="button" class="template-fav ' + (templateFavorites.has(String(tpl.name || "")) ? "on" : "") + '" data-template-favorite="' + esc(tpl.name || "") + '" title="Favori">★</button>' +
              "</div>"
            )
            .join("")
        : "<div class='tiny' style='padding:10px;'>Aucun template trouvé.</div>";
      const tpl = selectedTemplate();
      if (!tpl) {
        if (templatePreviewTitleEl) templatePreviewTitleEl.innerHTML = "<strong>Aucun template sélectionné</strong>";
        if (templatePreviewBodyEl) templatePreviewBodyEl.textContent = "Choisir un template dans la liste.";
        renderTemplateVarsForm(null);
        return;
      }
      if (templatePreviewTitleEl) templatePreviewTitleEl.innerHTML = "<strong>" + esc(tpl.name || "-") + "</strong>";
      if (templatePreviewBodyEl) templatePreviewBodyEl.textContent = String(tpl.preview_text || normalizeTemplateText(tpl.components) || "Aperçu indisponible.");
      renderTemplateVarsForm(tpl);
      const lead = selectedLead();
      const isMarketing = String(tpl.category || "").toUpperCase() === "MARKETING";
      const hasOptIn = Boolean(lead && lead.marketing_opt_in === true);
      if (templateOptInHintEl) {
        templateOptInHintEl.style.display = isMarketing && !hasOptIn ? "" : "none";
      }
      if (templateMarkOptInBtnEl) {
        templateMarkOptInBtnEl.style.display = isMarketing && !hasOptIn ? "" : "none";
      }
      if (templateSendBtnEl instanceof HTMLButtonElement) {
        templateSendBtnEl.disabled = !lead || (isMarketing && !hasOptIn);
      }
    }

    function applyTemplateFilters() {
      const search = templateSearchInputEl instanceof HTMLInputElement ? templateSearchInputEl.value.trim().toLowerCase() : "";
      const subset = templatesCache.filter((tpl) => {
        const name = String(tpl.name || "").toLowerCase();
        const cat = String(tpl.category || "UTILITY").toUpperCase();
        const favoriteOk = !templateFavoritesOnly || templateFavorites.has(String(tpl.name || ""));
        return (!search || name.includes(search)) && favoriteOk && (templateCategoryTab === "ALL" || cat === templateCategoryTab);
      });
      if (!subset.some((tpl) => String(tpl.id) === String(selectedTemplateId))) {
        selectedTemplateId = subset[0] ? String(subset[0].id) : "";
      }
      renderTemplatesList(subset);
    }

    async function loadTemplatesForModal() {
      if (!templateListEl) return;
      templateListEl.innerHTML = "<div class='tiny' style='padding:10px;'><span class='spinner'></span>Chargement templates...</div>";
      try {
        const params = new URLSearchParams();
        params.set("category", templateCategoryTab || "ALL");
        if (templateSearchInputEl instanceof HTMLInputElement && templateSearchInputEl.value.trim()) {
          params.set("search", templateSearchInputEl.value.trim());
        }
        const payload = await fetchJson("/api/whatsapp/templates?" + params.toString() + (qs ? "&" + qs.slice(1) : ""));
        templatesCache = Array.isArray(payload) ? payload : [];
        const favPayload = await fetchJson("/api/whatsapp/templates/favorites" + qs);
        templateFavorites = new Set(Array.isArray(favPayload && favPayload.items) ? favPayload.items.map((v) => String(v || "")) : []);
        templatesCache.forEach((tpl) => {
          if (tpl && tpl.favorite) templateFavorites.add(String(tpl.name || ""));
        });
        selectedTemplateId = templatesCache[0] ? String(templatesCache[0].id) : "";
        applyTemplateFilters();
      } catch (error) {
        templateListEl.innerHTML = "<div class='tiny' style='padding:10px;'>Impossible de charger les templates.</div>";
        showErrorBanner(formatError(error));
      }
    }

    async function loadSessionStatus(leadId) {
      if (!leadId) {
        isSessionOpen = false;
        sessionExpiresAt = null;
        updateSidePanelState();
        return;
      }
      const lead = leads.find((item) => item.id === leadId);
      if (lead && isSharedLeadClient(lead)) {
        isSessionOpen = false;
        sessionExpiresAt = null;
        updateSidePanelState();
        return;
      }
      try {
        const payload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/session-status" + qs);
        isSessionOpen = Boolean(payload && payload.isSessionOpen);
        sessionExpiresAt = payload && payload.expiresAt ? String(payload.expiresAt) : null;
      } catch {
        isSessionOpen = true;
        sessionExpiresAt = null;
      }
      updateSidePanelState();
    }

    function kpi(label, value) {
      return '<article class="kpi"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + "</div></article>";
    }

    function convBandClass(band) {
      const upper = String(band || "").toUpperCase();
      if (upper === "HIGH") return "conv-high";
      if (upper === "MEDIUM") return "conv-medium";
      return "conv-low";
    }

    function convBadge(probability, band, reasons) {
      const title = Array.isArray(reasons) && reasons.length ? reasons.join(" | ") : "Probabilité estimée";
      const pct = Number.isFinite(Number(probability)) ? Number(probability) : 0;
      return '<span class="conv-badge ' + convBandClass(band) + '" title="' + esc(title) + '">' + esc(String(Math.round(pct)) + "%") + "</span>";
    }

    const FUNNEL_STAGE_ORDER = ["NEW","QUALIFICATION_PENDING","QUALIFIED","PRICE_SENT","DEPOSIT_PENDING","CONFIRMED","CONVERTED"];
    const STAGE_STEP_INDEX = {
      NEW: 0,
      PRODUCT_INTEREST: 1,
      QUALIFICATION_PENDING: 1,
      QUALIFIED: 2,
      PRICE_SENT: 2,
      VIDEO_PROPOSED: 3,
      DEPOSIT_PENDING: 4,
      CONFIRMED: 5,
      CONVERTED: 6
    };
    const FUNNEL_ACTIVE_COLORS = ["#4d5a70","#5e6d88","#6d82a6","#7893bb","#82a2ca","#8caed6","#96b8e6"];

    function stageSegmentsFilled(stage) {
      const safeStage = String(stage || "NEW").toUpperCase();
      if (safeStage === "LOST") return 0;
      const idx = Number(STAGE_STEP_INDEX[safeStage]);
      return Number.isFinite(idx) ? Math.max(1, Math.min(7, idx + 1)) : 1;
    }

    function leadUrgencyHigh(lead) {
      if (lead && lead.urgency === true) return true;
      const detected = lead && lead.detected_signals && typeof lead.detected_signals === "object" ? lead.detected_signals : {};
      const tags = new Set(Array.isArray(detected.tags) ? detected.tags.map((tag) => String(tag || "").toUpperCase()) : []);
      if (tags.has("SHORT_TIMELINE") || tags.has("URGENT_TIMELINE")) return true;
      const stage = String(lead && lead.stage ? lead.stage : "").toUpperCase();
      const hotStages = new Set(["QUALIFIED", "PRICE_SENT", "VIDEO_PROPOSED", "DEPOSIT_PENDING", "CONFIRMED"]);
      const probability = Number(lead && lead.conversion_probability != null ? lead.conversion_probability : 0);
      const country = String(lead && lead.country ? lead.country : "").toUpperCase();
      const lastTs = new Date(String(lead && lead.last_activity_at ? lead.last_activity_at : "")).getTime();
      const hours = Number.isFinite(lastTs) ? ((Date.now() - lastTs) / 3600000) : Infinity;
      return probability >= 70 && hotStages.has(stage) && hours <= 24 && country !== "MA";
    }

    function leadIsHighProbability(lead) {
      return Number(lead && lead.conversion_probability != null ? lead.conversion_probability : 0) >= 70;
    }

    function leadIsAtRiskFilter(lead) {
      const stage = String(lead && lead.stage ? lead.stage : "").toUpperCase();
      const tracked = new Set(["PRODUCT_INTEREST","QUALIFICATION_PENDING","QUALIFIED","PRICE_SENT","VIDEO_PROPOSED","DEPOSIT_PENDING","CONFIRMED"]);
      if (!tracked.has(stage)) return false;
      const lastTs = new Date(String(lead && lead.last_activity_at ? lead.last_activity_at : "")).getTime();
      if (!Number.isFinite(lastTs)) return false;
      const hours = (Date.now() - lastTs) / 3600000;
      return hours > 48;
    }

    function updateQuickFilterCounts(source) {
      const items = Array.isArray(source) ? source : [];
      const counts = {
        all: items.length,
        urgent: items.filter((lead) => leadUrgencyHigh(lead)).length,
        high: items.filter((lead) => leadIsHighProbability(lead)).length,
        risk: items.filter((lead) => leadIsAtRiskFilter(lead)).length
      };
      if (!quickFilterBarEl) return;
      const allCount = quickFilterBarEl.querySelector("[data-count='all']");
      const urgentCount = quickFilterBarEl.querySelector("[data-count='urgent']");
      const highCount = quickFilterBarEl.querySelector("[data-count='high']");
      const riskCount = quickFilterBarEl.querySelector("[data-count='risk']");
      if (allCount) allCount.textContent = "(" + counts.all + ")";
      if (urgentCount) urgentCount.textContent = "(" + counts.urgent + ")";
      if (highCount) highCount.textContent = "(" + counts.high + ")";
      if (riskCount) riskCount.textContent = "(" + counts.risk + ")";
    }

    function applyLeadFiltersAndRender(opts) {
      const options = opts && typeof opts === "object" ? opts : {};
      const source = Array.isArray(allLeads) ? allLeads.slice() : [];
      updateQuickFilterCounts(source);
      const query = String(searchQuery || "").trim().toLowerCase();
      const filtered = source.filter((lead) => {
        const quickOk =
          activeQuickFilter === "ALL" ? true :
          activeQuickFilter === "URGENT" ? leadUrgencyHigh(lead) :
          activeQuickFilter === "HIGH" ? leadIsHighProbability(lead) :
          activeQuickFilter === "RISK" ? leadIsAtRiskFilter(lead) : true;
        if (!quickOk) return false;
        if (!query) return true;
        const hay = [
          String(lead.client || ""),
          String(lead.phone || ""),
          String(lead.product || "")
        ].join(" ").toLowerCase();
        return hay.includes(query);
      });
      renderLeads(filtered, { skipConversationLoad: Boolean(options.skipConversationLoad) });
    }

    function renderFunnelIndicator(lead) {
      const stage = String(lead && lead.stage ? lead.stage : "NEW").toUpperCase();
      const filled = stageSegmentsFilled(stage);
      const probability = Number.isFinite(Number(lead && lead.conversion_probability != null ? lead.conversion_probability : 0))
        ? Math.round(Number(lead.conversion_probability || 0))
        : 0;
      const urgencyHigh = leadUrgencyHigh(lead);
      const title = [
        "Stage: " + stage,
        "Probabilité de conversion: " + probability + "%",
        "Urgence: " + (urgencyHigh ? "Oui" : "Non")
      ].join(" · ");
      const converted = stage === "CONVERTED";
      const lost = stage === "LOST";
      const activeColor = FUNNEL_ACTIVE_COLORS[Math.max(0, Math.min(FUNNEL_ACTIVE_COLORS.length - 1, filled - 1))];
      const segments = Array.from({ length: 7 }).map((_, index) => {
        if (lost) {
          return '<span class="funnel-seg" style="background:rgba(111,120,136,.18); border-color:rgba(111,120,136,.35);"></span>';
        }
        const on = index < filled;
        const bg = on ? activeColor : "rgba(114,132,165,.15)";
        const border = on ? "rgba(130,160,204,.46)" : "rgba(114,132,165,.28)";
        const opacity = on ? "1" : "0.68";
        return '<span class="funnel-seg" style="background:' + bg + '; border-color:' + border + '; opacity:' + opacity + ';"></span>';
      })
        .join("");
      return (
        '<span class="funnel" title="' + esc(title) + '">' +
          '<span class="funnel-bar">' + segments + "</span>" +
          '<span class="funnel-label">' + esc(stage) + (lost ? " ×" : converted ? " ✓" : "") + "</span>" +
          '<span class="funnel-prob">' + esc(String(probability) + "%") + "</span>" +
          (urgencyHigh ? '<span class="funnel-urgency" title="Urgence haute">⚠️</span>' : "") +
        "</span>"
      );
    }

    function recommendActionForLead(lead) {
      const recommended = String(lead.recommended_stage || "").toUpperCase();
      const stage = String(lead.stage || "").toUpperCase();
      const target = recommended || stage;
      if (target === "QUALIFICATION_PENDING") return "Poser questions date + pays";
      if (target === "QUALIFIED") return "Qualifier besoin + date événement";
      if (target === "PRICE_SENT") return "Prix envoyé, proposer visio ou prochaine étape";
      if (target === "DEPOSIT_PENDING") return "Confirmer acompte et planning";
      if (target === "CONFIRMED") return "Client confirmé, préparer passage paiement";
      if (target === "CONVERTED") return "Finaliser production";
      if (target === "LOST") return "Archiver et noter cause";
      return "Premier contact structuré";
    }

    function applyAiSettingsToForm(settings) {
      if (!settings) return;
      if (aiDefaultLanguageEl instanceof HTMLSelectElement) aiDefaultLanguageEl.value = String(settings.default_language || "AUTO");
      if (aiToneEl instanceof HTMLSelectElement) aiToneEl.value = String(settings.tone || "QUIET_LUXURY");
      if (aiMessageLengthEl instanceof HTMLSelectElement) aiMessageLengthEl.value = String(settings.message_length || "SHORT");
      if (aiIncludePricePolicyEl instanceof HTMLSelectElement) aiIncludePricePolicyEl.value = String(settings.include_price_policy || "AFTER_QUALIFIED");
      if (aiIncludeVideoCallEl instanceof HTMLSelectElement) aiIncludeVideoCallEl.value = String(settings.include_video_call || "WHEN_HIGH_INTENT");
      if (aiUrgencyStyleEl instanceof HTMLSelectElement) aiUrgencyStyleEl.value = String(settings.urgency_style || "SUBTLE");
      if (aiNoEmojisEl instanceof HTMLInputElement) aiNoEmojisEl.checked = Boolean(settings.no_emojis);
      if (aiAvoidFollowUpPhraseEl instanceof HTMLInputElement) aiAvoidFollowUpPhraseEl.checked = Boolean(settings.avoid_follow_up_phrase);
      if (aiSignatureEnabledEl instanceof HTMLInputElement) aiSignatureEnabledEl.checked = Boolean(settings.signature_enabled);
      if (aiSignatureTextEl instanceof HTMLInputElement) aiSignatureTextEl.value = String(settings.signature_text || "");
    }

    async function loadAiSettings() {
      try {
        const settings = await fetchJson("/api/ai/settings" + qs);
        console.log("[ai-settings] response", settings);
        applyAiSettingsToForm(settings);
      } catch (error) {
        console.warn("[ai-settings] load failed", error);
      }
    }

    function renderPriorities(items) {
      if (!prioritiesRowEl) return;
      const list = Array.isArray(items) ? items.slice(0, 5) : [];
      if (!list.length) {
        prioritiesRowEl.innerHTML = '<div class="priorities-head"><div class="priorities-title">Priorités du jour (Top 5)</div></div><div class="tiny">Aucune priorité calculée.</div>';
        return;
      }
      prioritiesRowEl.innerHTML =
        '<div class="priorities-head"><div class="priorities-title">Priorités du jour (Top 5)</div><div class="tiny">' + esc(list.length) + " lead(s)</div></div>" +
        '<div class="priority-grid">' +
        list
          .map((item) => {
            const action = String(item.recommended_reason || recommendActionForLead(item));
            return (
              '<article class="priority-card">' +
              '<div class="name">' + esc(item.client || "-") + "</div>" +
              '<div class="meta">' + esc(item.country || "-") + " · " + esc(item.stage || "-") + "</div>" +
              '<div class="act">' + esc(action) + "</div>" +
              '<div class="score">Score: ' + esc(Number(item.score || 0)) + " · Conv: " + esc(Math.round(Number(item.conversion_probability || 0))) + "%</div>" +
              "</article>"
            );
          })
          .join("") +
        "</div>";
    }

    function updateSidePanelState() {
      const lead = selectedLead();
      const hasLead = Boolean(lead);
      const hasInbound = hasLead && selectedLeadHasInboundMessage();
      const isShared = hasLead && isSharedLeadClient(lead);
      if (classifySelectedBtnEl) classifySelectedBtnEl.disabled = !hasLead;
      if (applyClassificationBtnEl) applyClassificationBtnEl.disabled = !hasLead || !lastClassification || !lastClassification.recommendedStage;
      if (copyNextQuestionBtnEl) copyNextQuestionBtnEl.disabled = !lastClassification || !lastClassification.nextQuestion;
      if (addClassificationDraftBtnEl) addClassificationDraftBtnEl.disabled = !hasLead || !lastClassification || !lastClassification.nextQuestion;
      if (generateFollowupSelectedBtnEl) generateFollowupSelectedBtnEl.disabled = !hasLead;
      if (addFollowupDraftBtnEl) {
        const fText = String(followupBoxEl && followupBoxEl.textContent ? followupBoxEl.textContent : "").trim();
        addFollowupDraftBtnEl.disabled = !hasLead || !fText || fText.startsWith("Sélectionne") || fText.startsWith("Unable");
      }
      const copyFollowupBtn = document.getElementById("copyFollowupBtn");
      if (copyFollowupBtn instanceof HTMLButtonElement) {
        const text = String(followupBoxEl && followupBoxEl.textContent ? followupBoxEl.textContent : "").trim();
        copyFollowupBtn.disabled = !text || text.startsWith("Sélectionne") || text.startsWith("Impossible");
      }
      if (conversationSubmitIconBtnEl instanceof HTMLButtonElement) conversationSubmitIconBtnEl.disabled = !hasLead || !isSessionOpen || isShared;
      if (conversationMessageTypeEl instanceof HTMLSelectElement) conversationMessageTypeEl.disabled = !hasLead;
      if (conversationTextEl instanceof HTMLTextAreaElement) conversationTextEl.disabled = !hasLead || !isSessionOpen || isShared;
      if (conversationSuggestReplyBtnEl instanceof HTMLButtonElement) conversationSuggestReplyBtnEl.disabled = !hasInbound;
      if (conversationGenerateAiSuggestionsBtnEl instanceof HTMLButtonElement) {
        conversationGenerateAiSuggestionsBtnEl.disabled = !hasLead || isShared || !hasInbound;
      }
      if (conversationReclassifyBtnEl instanceof HTMLButtonElement) conversationReclassifyBtnEl.disabled = !hasLead;
      if (conversationCopyLeadIdBtnEl instanceof HTMLButtonElement) conversationCopyLeadIdBtnEl.disabled = !hasLead;
      if (conversationToggleTestBtnEl instanceof HTMLButtonElement) {
        conversationToggleTestBtnEl.disabled = !hasLead;
        conversationToggleTestBtnEl.textContent = hasLead && Boolean(lead.is_test) ? "Unmark test" : "Mark as test";
      }
      if (openTemplatesBtnEl instanceof HTMLButtonElement) openTemplatesBtnEl.disabled = !hasLead || isShared;
      if (quickMarkPriceBtnEl instanceof HTMLButtonElement) quickMarkPriceBtnEl.disabled = !hasLead;
      if (saveClientContextNotesBtnEl instanceof HTMLButtonElement) saveClientContextNotesBtnEl.disabled = !hasLead;
      if (clientContextNotesEl instanceof HTMLTextAreaElement) clientContextNotesEl.disabled = !hasLead;
      if (sessionStatusNoteEl) {
        if (!hasLead) {
          sessionStatusNoteEl.textContent = "Session: sélectionne un lead.";
          sessionStatusNoteEl.classList.remove("closed");
        } else if (isShared) {
          sessionStatusNoteEl.textContent = "Numéro partagé (sans API) — analyse uniquement. Copier les suggestions, sans envoi.";
          sessionStatusNoteEl.classList.add("closed");
        } else if (!isSessionOpen) {
          sessionStatusNoteEl.textContent = "Session expirée — utilisez un template.";
          sessionStatusNoteEl.classList.add("closed");
        } else {
          sessionStatusNoteEl.textContent = "Session ouverte jusqu’à " + (sessionExpiresAt ? fmtDate(sessionExpiresAt) : "-");
          sessionStatusNoteEl.classList.remove("closed");
        }
      }
      if (suggestionContextNoteEl) {
        if (!hasLead) {
          suggestionContextNoteEl.textContent = suggestionUiText("noLeadContext");
          renderSuggestionTemplateOptions([]);
          renderSuggestionCards([]);
        } else if (isShared) {
          suggestionContextNoteEl.textContent = suggestionUiText("sharedContext");
          renderSuggestionTemplateOptions([]);
        } else if (!hasInbound) {
          suggestionContextNoteEl.textContent = suggestionUiText("noInboundContext");
          renderSuggestionTemplateOptions([]);
          renderSuggestionCards([]);
        } else {
          suggestionContextNoteEl.textContent = suggestionUiText("defaultContext");
        }
      }
      renderConversationStageActions();
    }

    function showErrorBanner(message) {
      if (!errorBannerEl) return;
      errorBannerEl.textContent = String(message || "");
      errorBannerEl.classList.add("show");
      if (conversationInlineErrorEl) {
        conversationInlineErrorEl.textContent = String(message || "");
        conversationInlineErrorEl.classList.add("show");
      }
    }

    function formatError(error) {
      const status = error && error.status ? Number(error.status) : 0;
      const message = error && error.message ? String(error.message) : "Request failed";
      return status ? (status + " - " + message) : message;
    }

    function logClicked(buttonName) {
      console.log("clicked", buttonName);
    }

    function hideErrorBanner() {
      if (!errorBannerEl) return;
      errorBannerEl.textContent = "";
      errorBannerEl.classList.remove("show");
      if (conversationInlineErrorEl) {
        conversationInlineErrorEl.textContent = "";
        conversationInlineErrorEl.classList.remove("show");
      }
    }

    function renderSkeletonRows() {
      leadRowsEl.innerHTML = Array.from({ length: 5 })
        .map(() =>
          "<tr>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
            "<td><div class='skeleton'></div></td>" +
          "</tr>"
        )
        .join("");
    }

    function updateConversationHeader(lead) {
      if (!conversationHeaderMetaEl || !conversationClientNameEl || !conversationStageMetaEl) return;
      if (!lead) {
        conversationClientNameEl.textContent = "Conversation";
        conversationHeaderMetaEl.textContent = "Sélectionne un lead pour voir la conversation.";
        if (clientLocalTimeEl) clientLocalTimeEl.textContent = "";
        renderWaitingForBadge(null);
        if (clientLocalTimeTicker != null) {
          clearInterval(clientLocalTimeTicker);
          clientLocalTimeTicker = null;
        }
        if (conversationAvatarEl) conversationAvatarEl.textContent = "?";
        conversationStageMetaEl.innerHTML = "";
        renderSuggestionCards([]);
        if (clientContextMetaEl) clientContextMetaEl.innerHTML = "<div class='tiny'>Aucun lead sélectionné.</div>";
        if (clientContextTimelineEl) clientContextTimelineEl.innerHTML = "<li class='tiny'>Timeline indisponible.</li>";
        if (clientContextNotesEl instanceof HTMLTextAreaElement) clientContextNotesEl.value = "";
        renderPostConfirmQuickActions(null);
        leadDebugData = null;
        renderLeadDebugPanel();
        return;
      }
      const risk = lead.risk || {};
      const riskText = risk.is_at_risk ? "À risque" : "Normal";
      conversationClientNameEl.textContent = String(lead.client || "Client");
      if (conversationAvatarEl) {
        const avatarUrl = publicImageUrlFromLead(lead);
        if (avatarUrl) {
          conversationAvatarEl.innerHTML = '<img src="' + esc(avatarUrl) + '" alt="' + esc(String(lead.client || "Client")) + '" />';
        } else {
          conversationAvatarEl.textContent = initials(lead.client || "Client");
        }
      }
      conversationHeaderMetaEl.textContent =
        String(lead.client || "-") +
        " · " +
        String(lead.country || "-") +
        " · " + String(lead.phone || "-") +
        " · " + fmtRelative(lead.last_activity_at) +
        " · id: " + String(lead.id || "-");
      startClientLocalTimeTicker({
        city: lead.ship_city,
        ship_city: lead.ship_city,
        country: lead.country,
        destination: [
          String(lead.ship_city || "").trim(),
          String(lead.ship_region || "").trim(),
          String(lead.ship_country || "").trim(),
          String(lead.ship_destination_text || "").trim()
        ].filter(Boolean).join(", ")
      });
      renderWaitingForBadge(lead.waiting_for || null);
      conversationStageMetaEl.innerHTML =
        renderStageFlow(lead) +
        '<span class="risk ' + (risk.is_at_risk ? "high" : "") + '">' + esc(riskText) + "</span>" +
        (Boolean(lead.is_test) ? '<span class="signal-chip">TEST</span>' : "") +
        renderSignalChips(lead, false) +
        renderLastFlagChip(lead) +
        renderProductChips(lead) +
        (isSharedLeadClient(lead) ? '<span class="shared-badge">Shared number (no API) — analysis only</span>' : "") +
        '<span class="tiny">Source: ' + esc(lead.source || "-") + "</span>";
      if (suggestionTemplateOptionsEl) suggestionTemplateOptionsEl.innerHTML = "";

      if (clientContextMetaEl) {
        const eventDateConfidence = Number(lead.event_date_confidence || 0);
        const eventDateSourceId = String(lead.event_date_source_message_id || "").trim();
        const eventDateValue = String(lead.event_date || "");
        const eventDateText = String(lead.event_date_text || "");
        const destinationConfidence = Number(lead.ship_destination_confidence || 0);
        const destinationSourceId = String(lead.ship_destination_source_message_id || "").trim();
        const destinationRaw = String(lead.ship_destination_text || "");
        const hasDestinationValue = Boolean(
          String(lead.ship_city || "").trim() ||
          String(lead.ship_region || "").trim() ||
          String(lead.ship_country || "").trim() ||
          destinationRaw
        );
        clientContextMetaEl.innerHTML = [
          "<div class='context-item'><span class='k'>Funnel</span><span class='v'>" + renderFunnelIndicator(lead) + "</span></div>",
          "<div class='context-item'><span class='k'>Téléphone</span><span class='v copyable' data-copy-phone>" + esc(lead.phone || "-") + "</span></div>",
          "<div class='context-item'><span class='k'>Pays</span><span class='v'>" + esc(lead.country || "-") + "</span></div>",
          "<div class='context-item'><span class='k'>Source</span><span class='v'>" + esc(lead.source || "-") + "</span></div>",
          "<div class='context-item'><span class='k'>Signaux</span><span class='v'>" + renderSignalChips(lead, false) + "</span></div>",
          "<div class='context-item'><span class='v'>" + renderProductContextGallery(lead) + "</span></div>",
          "<div class='context-item'><span class='v'>" + renderLeadQuotesSection(lead) + "</span></div>",
          "<div class='context-item'>" +
            "<span class='k'>Date souhaitée</span>" +
            "<div class='v'>" +
              "<div class='event-date-line'>" +
                "<div class='event-date-main'>" +
                  "<strong>" + esc(fmtEventDate(eventDateValue)) + "</strong>" +
                  (eventDateValue ? "<span class='conf-pill'>" + esc(String(Math.max(0, Math.min(100, Math.round(eventDateConfidence || 0))))) + "%</span>" : "") +
                "</div>" +
                "<button class='small-btn' type='button' data-edit-event-date>" + (lead.event_date_manual ? "Manuel" : "✎") + "</button>" +
              "</div>" +
              (eventDateText ? "<div class='tiny'>Texte détecté: " + esc(eventDateText) + "</div>" : "") +
              (eventDateSourceId ? "<button class='small-btn' type='button' data-scroll-source-message='" + esc(eventDateSourceId) + "' style='margin-top:6px;'>Source</button>" : "") +
              "<div class='event-date-editor'>" +
                "<input type='date' data-event-date-input value='" + esc(eventDateValue) + "' />" +
                "<button class='small-btn' type='button' data-save-event-date>Enregistrer</button>" +
                "<button class='small-btn' type='button' data-clear-event-date>Effacer</button>" +
                "<button class='small-btn' type='button' data-recalc-event-date>Recalculer</button>" +
              "</div>" +
            "</div>" +
          "</div>",
          "<div class='context-item'>" +
            "<span class='k'>Ville / Destination livraison</span>" +
            "<div class='v'>" +
              "<div class='event-date-line'>" +
                "<div class='event-date-main'>" +
                  "<strong>" + esc(fmtDestination(lead)) + "</strong>" +
                  (hasDestinationValue ? "<span class='conf-pill'>" + esc(String(Math.max(0, Math.min(100, Math.round(destinationConfidence || 0))))) + "%</span>" : "") +
                "</div>" +
                "<button class='small-btn' type='button' data-edit-destination>" + (lead.ship_destination_manual ? "Manuel" : "✎") + "</button>" +
              "</div>" +
              (destinationRaw ? "<div class='tiny'>Texte détecté: " + esc(destinationRaw) + "</div>" : "") +
              (destinationSourceId ? "<button class='small-btn' type='button' data-scroll-source-message='" + esc(destinationSourceId) + "' style='margin-top:6px;'>Source</button>" : "") +
              "<div class='destination-editor'>" +
                "<input type='text' data-destination-city placeholder='City' value='" + esc(String(lead.ship_city || "")) + "' />" +
                "<input type='text' data-destination-region placeholder='Region' value='" + esc(String(lead.ship_region || "")) + "' />" +
                "<input type='text' data-destination-country placeholder='Country' value='" + esc(String(lead.ship_country || "")) + "' />" +
                "<input class='span2' type='text' data-destination-raw placeholder='Texte brut détecté' value='" + esc(destinationRaw) + "' />" +
                "<div class='span2' style='display:flex; gap:6px; flex-wrap:wrap;'>" +
                  "<button class='small-btn' type='button' data-save-destination>Enregistrer</button>" +
                  "<button class='small-btn' type='button' data-clear-destination>Effacer</button>" +
                "</div>" +
              "</div>" +
            "</div>" +
          "</div>",
          "<div class='context-item'><span class='k'>Opt-in marketing</span><span class='v'>" + esc(lead.marketing_opt_in ? "Oui" : "Non") + "</span></div>",
          "<div class='context-item'><span class='k'>Dernière activité</span><span class='v'>" + esc(fmtRelative(lead.last_activity_at)) + "</span></div>"
        ].join("");
      }
      renderClientTimeline(lead);
      if (clientContextNotesEl instanceof HTMLTextAreaElement) {
        clientContextNotesEl.value = String(lead.internal_notes || "");
      }
      renderPostConfirmQuickActions(lead);
      renderLeadDebugPanel();
    }

    function isNearConversationBottom(thresholdPx) {
      if (!conversationMessagesEl) return true;
      const threshold = Number.isFinite(Number(thresholdPx)) ? Number(thresholdPx) : 72;
      const remaining = conversationMessagesEl.scrollHeight - conversationMessagesEl.scrollTop - conversationMessagesEl.clientHeight;
      return remaining <= threshold;
    }

    function signatureForConversationItems(items) {
      if (!Array.isArray(items) || !items.length) return "";
      return items
        .map((item) =>
          [
            String(item && item.id ? item.id : ""),
            String(item && item.created_at ? item.created_at : ""),
            String(item && item.direction ? item.direction : ""),
            String(item && item.text ? item.text : "")
          ].join("::")
        )
        .join("|");
    }

    function cleanReplyPreviewText(raw) {
      const value = String(raw || "")
        .replace(/^\\[(Image|Document)\\]\\s*/i, "")
        .replace(/https?:\\/\\/\\S+/gi, "")
        .replace(/\\s+/g, " ")
        .trim();
      if (!value) return "";
      return value.length > 150 ? value.slice(0, 147) + "..." : value;
    }

    function messageTextToHtml(raw) {
      const text = String(raw || "");
      return esc(text).replace(/\\n/g, "<br>");
    }

    function normalizeMediaUrl(raw) {
      const value = String(raw || "").trim();
      if (!value) return "";
      if (/^https?:\\/\\//i.test(value)) return value;
      return "";
    }

    function fileNameFromUrl(raw) {
      const url = normalizeMediaUrl(raw);
      if (!url) return "";
      try {
        const parsed = new URL(url);
        const parts = String(parsed.pathname || "").split("/").filter(Boolean);
        const last = parts.length ? parts[parts.length - 1] : "";
        return decodeURIComponent(last || "document");
      } catch {
        return "document";
      }
    }

    function parseTemplateButtons(raw) {
      const text = String(raw || "").trim();
      if (!text) return [];
      const out = [];
      const byBracket = /\\[([^\\]]+)\\]\\s*([^,\\n]+)/g;
      let match = byBracket.exec(text);
      while (match) {
        const label = String(match[1] || "").trim();
        const payload = String(match[2] || "").trim();
        if (label) out.push({ label, payload });
        match = byBracket.exec(text);
      }
      if (out.length) return out;
      return text
        .split(/[|,]/g)
        .map((chunk) => String(chunk || "").trim())
        .filter(Boolean)
        .map((label) => ({ label, payload: "" }));
    }

    function parseTemplateEnvelope(raw) {
      const text = String(raw || "");
      if (!text) return null;
      const hasTemplateMarkers = /\\bHeader\\s*:|\\bBody\\s*:|\\bFooter\\s*:|\\bButtons\\s*:/i.test(text);
      if (!hasTemplateMarkers) return null;
      const normalized = text.replace(/\\r\\n/g, "\\n");
      const idxBody = normalized.search(/\\bBody\\s*:/i);
      const idxFooter = normalized.search(/\\bFooter\\s*:/i);
      const idxButtons = normalized.search(/\\bButtons\\s*:/i);

      const headerMatch = normalized.match(/\\bHeader\\s*:\\s*(Image|Document)?\\s*(https?:\\/\\/\\S+)?/i);
      const headerType = String((headerMatch && headerMatch[1]) || "").trim().toLowerCase();
      const headerUrl = normalizeMediaUrl((headerMatch && headerMatch[2]) || "");

      const bounds = [idxFooter, idxButtons, normalized.length].filter((n) => Number.isFinite(n) && n >= 0);
      const bodyEnd = bounds.length ? Math.min.apply(null, bounds) : normalized.length;
      const body = idxBody >= 0 ? normalized.slice(idxBody + normalized.slice(idxBody).indexOf(":") + 1, bodyEnd).trim() : "";

      const footerEnd = [idxButtons, normalized.length].filter((n) => Number.isFinite(n) && n >= 0);
      const footer = idxFooter >= 0
        ? normalized.slice(idxFooter + normalized.slice(idxFooter).indexOf(":") + 1, footerEnd.length ? Math.min.apply(null, footerEnd) : normalized.length).trim()
        : "";

      const buttonsRaw = idxButtons >= 0
        ? normalized.slice(idxButtons + normalized.slice(idxButtons).indexOf(":") + 1).trim()
        : "";
      const buttons = parseTemplateButtons(buttonsRaw);

      if (!body && !footer && !headerUrl && !buttons.length) return null;
      return {
        headerType: headerType || "",
        headerUrl,
        body,
        footer,
        buttons
      };
    }

    function renderInboundProductLinkPreview(rawText, explicitLink) {
      const text = String(rawText || "");
      const explicit = String(explicitLink || "").trim();
      const links = [
        ...(Array.isArray(extractProductLinksFromText(text)) ? extractProductLinksFromText(text) : []),
        explicit
      ]
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      const link = String(links.find((item) => item.toLowerCase().includes("/products/")) || links[0] || "").trim();
      if (!link) return "";
      const handle = parseProductHandle(link);
      const preview = handle ? (productPreviewsMap[handle] || {}) : {};
      const hintedTitle = productTitleHintFromText(text);
      const title = String(hintedTitle || preview.title || productLabelFromUrl(link) || "Product").trim();
      const image = String(preview.image_url || PRODUCT_PLACEHOLDER_IMAGE).trim();
      const domain = hostFromUrl(link);
      const favicon = domain ? ("https://www.google.com/s2/favicons?domain=" + encodeURIComponent(domain) + "&sz=32") : "";
      return (
        '<a class="msg-link-preview" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' +
          '<img class="msg-link-preview-img" src="' + esc(image) + '" alt="' + esc(title || "Product preview") + '" loading="lazy" />' +
          '<div class="msg-link-preview-body">' +
            '<div class="msg-link-preview-title">' + esc(title || "Product") + "</div>" +
            '<div class="msg-link-preview-meta">' +
              (favicon ? '<img class="msg-link-preview-favicon" src="' + esc(favicon) + '" alt="" />' : "") +
              '<span class="msg-link-preview-domain">' + esc(domain || link) + "</span>" +
            "</div>" +
          "</div>" +
        "</a>"
      );
    }

    function renderTemplateEnvelopeHtml(parsed) {
      if (!parsed) return "";
      let headerHtml = "";
      const headerType = String(parsed.headerType || "").toLowerCase();
      const headerUrl = normalizeMediaUrl(parsed.headerUrl || "");
      if (headerType === "image" && headerUrl) {
        headerHtml =
          '<div class="msg-template-header-label">Header Image</div>' +
          '<img class="msg-template-image" src="' + esc(headerUrl) + '" alt="Template header image" loading="lazy" />';
      } else if ((headerType === "document" || /\\.pdf($|[?#])/i.test(headerUrl)) && headerUrl) {
        const fileName = fileNameFromUrl(headerUrl);
        headerHtml =
          '<div class="msg-template-header-label">Header Document</div>' +
          '<div class="msg-template-doc">' +
            '<span class="msg-template-doc-icon">PDF</span>' +
            '<a class="msg-template-doc-link" href="' + esc(headerUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(fileName || "Open PDF") + "</a>" +
          "</div>";
      } else if (headerUrl) {
        headerHtml =
          '<div class="msg-template-header-label">Header Media</div>' +
          '<div class="tiny"><a href="' + esc(headerUrl) + '" target="_blank" rel="noopener noreferrer" style="color:#9fc0ff;">Ouvrir média</a></div>';
      }

      const bodyHtml = parsed.body ? '<div class="msg-template-body">' + messageTextToHtml(parsed.body) + "</div>" : "";
      const footerHtml = parsed.footer ? '<div class="msg-template-footer">' + messageTextToHtml(parsed.footer) + "</div>" : "";
      const ctaHtml = Array.isArray(parsed.buttons) && parsed.buttons.length
        ? '<div class="msg-template-cta">' +
            parsed.buttons
              .map((btn) =>
                '<button type="button" class="msg-template-cta-btn"' +
                (btn && btn.payload ? ' data-cta-payload="' + esc(String(btn.payload)) + '"' : "") +
                ">" + esc(String((btn && btn.label) || "Action")) + "</button>"
              )
              .join("") +
          "</div>"
        : "";

      return '<div class="msg-template">' + headerHtml + bodyHtml + footerHtml + ctaHtml + "</div>";
    }

    function normalizeReplySenderName(raw) {
      const value = String(raw || "").trim();
      if (!value) return "";
      const lower = value.toLowerCase();
      if (["you", "me", "moi"].includes(lower)) return "You";
      if (["client", "customer"].includes(lower)) return "Client";
      return value.length > 36 ? value.slice(0, 33) + "..." : value;
    }

    function findReplyTarget(item, metadata, byId, byExternalId) {
      const directId = String(
        (metadata && (metadata.reply_to_message_id || metadata.reply_message_id || metadata.parent_message_id)) || ""
      ).trim();
      const externalId = String(
        (metadata && (metadata.reply_to_external_id || metadata.reply_external_id || metadata.reply_to)) || ""
      ).trim();
      let target = null;
      if (directId && byId.has(directId)) target = byId.get(directId) || null;
      if (!target && externalId && byExternalId.has(externalId)) target = byExternalId.get(externalId) || null;
      if (target) return target;
      const fallbackExternalId = String((item && item.reply_to_external_id) || "").trim();
      if (fallbackExternalId && byExternalId.has(fallbackExternalId)) return byExternalId.get(fallbackExternalId) || null;
      return null;
    }

    function renderReplyBlock(item, metadata, byId, byExternalId) {
      const target = findReplyTarget(item, metadata, byId, byExternalId);
      const replyToRecord =
        (item && item.reply_to && typeof item.reply_to === "object" ? item.reply_to : null) ||
        (metadata && metadata.reply_to && typeof metadata.reply_to === "object" ? metadata.reply_to : null) ||
        null;
      const quotedRecord =
        metadata && metadata.quoted_message && typeof metadata.quoted_message === "object"
          ? metadata.quoted_message
          : null;
      const fallbackText = String(
        (replyToRecord && (replyToRecord.text || replyToRecord.body)) ||
          (quotedRecord && (quotedRecord.text || quotedRecord.body)) ||
          (metadata && (metadata.reply_to_text || metadata.reply_text || metadata.quoted_text)) ||
          ""
      ).trim();
      const fallbackExternalId = String(
        (metadata && (metadata.reply_to_external_id || metadata.reply_external_id || metadata.reply_to)) ||
          (item && item.reply_to_external_id) ||
          ""
      ).trim();
      const previewText = cleanReplyPreviewText(target ? target.text : fallbackText);
      if (!target && !previewText && !fallbackExternalId) return "";
      const targetDirection = target && String(target.direction || "").toUpperCase() === "OUT" ? "OUT" : "IN";
      const fallbackSender = normalizeReplySenderName(
        (replyToRecord && (replyToRecord.sender_name || replyToRecord.sender || replyToRecord.author)) ||
          (quotedRecord && (quotedRecord.sender_name || quotedRecord.sender || quotedRecord.author || quotedRecord.from)) ||
          (metadata && (metadata.reply_to_sender_name || metadata.reply_sender_name || metadata.reply_author || metadata.reply_from)) ||
          ""
      );
      const replyLabel = fallbackSender || (target ? (targetDirection === "OUT" ? "You" : "Client") : "Reply");
      const replyToId = String((replyToRecord && (replyToRecord.id || replyToRecord.message_id || replyToRecord.messageId)) || "").trim();
      const targetId = target && target.id ? String(target.id) : replyToId;
      const attr = targetId ? ' data-scroll-source-message="' + esc(targetId) + '"' : "";
      const cls = targetId ? "msg-reply is-link" : "msg-reply";
      return (
        '<div class="' + cls + '"' + attr + '>' +
          '<div class="msg-reply-label">' + esc(replyLabel) + "</div>" +
          '<div class="msg-reply-text">' + esc(previewText || "Original message") + "</div>" +
        "</div>"
      );
    }

    function renderConversationMessages(items, opts) {
      const options = opts && typeof opts === "object" ? opts : {};
      const preserveScroll = Boolean(options.preserveScroll);
      if (!conversationMessagesEl) return;
      const shouldStickToBottom = preserveScroll ? isNearConversationBottom(84) : true;
      if (!selectedLead()) {
        conversationMessagesEl.innerHTML = '<div class="phone-empty">Sélectionnez une conversation pour commencer.</div>';
        return;
      }
      if (!Array.isArray(items) || !items.length) {
        conversationMessagesEl.innerHTML = '<div class="phone-empty">Aucun message — synchroniser via Zoko ou ajouter un message.</div>';
        return;
      }
      const byId = new Map();
      const byExternalId = new Map();
      items.forEach((msg) => {
        const id = String(msg && msg.id ? msg.id : "").trim();
        if (id) byId.set(id, msg);
        const externalId = String(msg && msg.external_id ? msg.external_id : "").trim();
        if (externalId) byExternalId.set(externalId, msg);
      });
      let lastDay = "";
      const rows = [];
      items.forEach((item) => {
        const metadata = item && item.metadata && typeof item.metadata === "object" ? item.metadata : {};
        const type = String(item.message_type || "text");
        const isReplyContextOnly =
          type === "reply_context" ||
          type === "reply_preview" ||
          Boolean(metadata.reply_context) ||
          Boolean(metadata.is_reply_context) ||
          Boolean(metadata.is_quoted_context);
        if (isReplyContextOnly) return;

        const label = dayLabel(item.created_at);
        if (label && label !== lastDay) {
          rows.push('<div class="msg-day">' + esc(label) + "</div>");
          lastDay = label;
        }
          const dir = String(item.direction || "IN").toUpperCase() === "OUT" ? "out" : "in";
          const provider = String(item.provider || "manual");
          const deliveryStatus = String(
            (metadata && (metadata.delivery_status || metadata.status || metadata.deliveryStatus)) || ""
          ).trim().toUpperCase();
        const messageText = String(item.text || "");
        const templateEnvelope = type === "template" ? parseTemplateEnvelope(messageText) : null;
        const mediaUrlMatch = messageText.match(/https?:\\/\\/\\S+/i);
        const mediaUrl = mediaUrlMatch ? mediaUrlMatch[0] : "";
        const isImage = type === "image";
        const isDocument = type === "document";
        const metadataMediaUrl = String(
          (metadata && (metadata.media_url || metadata.file_url || metadata.image_url || metadata.url || metadata.link)) || ""
        ).trim();
        const productLinkFromMeta = metadataMediaUrl && metadataMediaUrl.toLowerCase().includes("/products/") ? metadataMediaUrl : "";
        const productLinkFromText = mediaUrl && mediaUrl.toLowerCase().includes("/products/") ? mediaUrl : "";
        const inboundProductLinkPreview = dir === "in"
          ? renderInboundProductLinkPreview(messageText, productLinkFromText || productLinkFromMeta)
          : "";
        const lowerUrl = String(mediaUrl || "").toLowerCase();
        const hasPreviewableImage = isImage && mediaUrl && (lowerUrl.startsWith("https://") || lowerUrl.startsWith("http://"));
        const cleanMessageText = messageText
          .replace(mediaUrl, "")
          .replace(/^\\[(Image|Document)\\]\\s*/i, "")
          .trim();
        const bodyHtml = templateEnvelope
          ? renderTemplateEnvelopeHtml(templateEnvelope)
          : inboundProductLinkPreview
          ? inboundProductLinkPreview + (cleanMessageText ? '<div>' + esc(cleanMessageText) + "</div>" : "")
          : hasPreviewableImage
          ? '<div><img src="' + esc(mediaUrl) + '" alt="Image WhatsApp" style="max-width:240px;border-radius:10px;border:1px solid #30415b;display:block;margin-bottom:6px;" /></div>' +
            (cleanMessageText ? '<div>' + esc(cleanMessageText) + "</div>" : "")
          : isDocument && mediaUrl
            ? '<div class="msg-template-doc">' +
                '<span class="msg-template-doc-icon">PDF</span>' +
                '<a class="msg-template-doc-link" href="' + esc(mediaUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(fileNameFromUrl(mediaUrl) || "Open document") + "</a>" +
              "</div>" +
              (cleanMessageText ? '<div style="margin-top:6px;">' + esc(cleanMessageText) + "</div>" : "")
          : mediaUrl
            ? '<div>' + esc(cleanMessageText) + '</div><div class="tiny"><a href="' + esc(mediaUrl) + '" target="_blank" rel="noopener noreferrer" style="color:#9fc0ff;">Ouvrir média</a></div>'
            : '<div>' + esc(cleanMessageText || (isImage ? "Image reçue" : "")) + "</div>";
        const replyHtml = renderReplyBlock(item, metadata, byId, byExternalId);

        const outStatus = (() => {
          if (dir !== "out") return "";
          if (deliveryStatus === "READ" || deliveryStatus === "SEEN") return '<span class="msg-status read" title="Lu">✓✓</span>';
          if (deliveryStatus === "DELIVERED" || deliveryStatus === "SUBMITTED" || deliveryStatus === "SUCCESS") {
            return '<span class="msg-status delivered" title="Livré">✓✓</span>';
          }
          if (deliveryStatus === "SENT" || deliveryStatus === "QUEUED" || deliveryStatus === "PENDING") {
            return '<span class="msg-status sent" title="Envoyé">✓</span>';
          }
          if (provider === "zoko") return '<span class="msg-status delivered" title="Livré">✓✓</span>';
          return '<span class="msg-status sent" title="Envoyé">✓</span>';
        })();

        rows.push(
          '<div class="msg-row ' + dir + '">' +
            '<div class="msg-bubble" data-message-id="' + esc(item.id || "") + '" title="' + esc(provider + " · " + type) + '">' +
              '<span class="msg-menu">⋮</span>' +
              replyHtml +
              bodyHtml +
              '<div class="msg-meta"><span>' + esc(fmtTime(item.created_at)) + '</span><span>' + outStatus + "</span></div>" +
            "</div>" +
          "</div>"
        );
      });
      conversationMessagesEl.innerHTML = rows.join("");
      if (shouldStickToBottom) {
        requestAnimationFrame(() => {
          if (!conversationMessagesEl) return;
          conversationMessagesEl.scrollTop = conversationMessagesEl.scrollHeight;
        });
      }
    }

    function renderConversationLoading() {
      if (!conversationMessagesEl) return;
      conversationMessagesEl.innerHTML =
        '<div class="chat-skeleton">' +
          '<div class="chat-skel-bubble"></div>' +
          '<div class="chat-skel-bubble out"></div>' +
          '<div class="chat-skel-bubble"></div>' +
          '<div class="chat-skel-bubble out"></div>' +
        "</div>";
    }

    async function loadConversationForLead(leadId, opts) {
      const options = opts && typeof opts === "object" ? opts : {};
      const silent = Boolean(options.silent);
      const skipDebug = Boolean(options.skipDebug);
      const lead = leads.find((item) => item.id === leadId) || null;
      updateConversationHeader(lead);
      if (!leadId) {
        leadMessages = [];
        leadQuotes = [];
        leadTimelineEvents = [];
        lastLeadMessagesSignature = "";
        lastLeadTimelineSignature = "";
        renderConversationMessages([]);
        renderClientTimeline(null);
        await loadAiLatestForLead("");
        await loadAiFlowForLead("");
        await loadSessionStatus("");
        return;
      }
      if (!silent) renderConversationLoading();
      try {
        const messagesPayload = await fetchJson(
          "/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/messages?limit=50" + (qs ? "&" + q.toString() : "")
        );
        let timelinePayload = { items: [] };
        try {
          const tl = await fetchJson(
            "/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/timeline?limit=80" + (qs ? "&" + q.toString() : "")
          );
          timelinePayload = tl && typeof tl === "object" ? tl : { items: [] };
        } catch (error) {
          console.warn("[whatsapp] timeline load failed", { leadId, error });
        }
        const nextMessages = Array.isArray(messagesPayload.items) ? messagesPayload.items : [];
        const nextQuotes = Array.isArray(messagesPayload.quotes) ? messagesPayload.quotes : [];
        const nextTimeline = Array.isArray(timelinePayload.items) ? timelinePayload.items : [];
        const nextMessagesSig = signatureForConversationItems(nextMessages);
        const nextTimelineSig = signatureForConversationItems(nextTimeline);
        const unchanged = nextMessagesSig === lastLeadMessagesSignature && nextTimelineSig === lastLeadTimelineSignature;
        if (silent && unchanged) return;
        leadMessages = nextMessages;
        leadQuotes = nextQuotes;
        leadTimelineEvents = nextTimeline;
        lastLeadMessagesSignature = nextMessagesSig;
        lastLeadTimelineSignature = nextTimelineSig;
        updateConversationHeader(lead);
        renderConversationMessages(leadMessages, { preserveScroll: silent });
        renderClientTimeline(lead);
        try {
          await refreshSuggestionCardsForSelectedLead();
        } catch (error) {
          console.warn("[whatsapp] suggestions refresh failed", { leadId, error });
        }
        try {
          await loadAiLatestForLead(leadId, { silent });
        } catch (error) {
          console.warn("[whatsapp] ai latest load failed", { leadId, error });
        }
        try {
          await loadAiFlowForLead(leadId, { silent });
        } catch (error) {
          console.warn("[whatsapp] ai flow load failed", { leadId, error });
        }
        try {
          await loadSessionStatus(leadId);
        } catch (error) {
          console.warn("[whatsapp] session status load failed", { leadId, error });
        }
        if (!skipDebug) {
          try {
            await loadLeadDebugProof(leadId);
          } catch (error) {
            console.warn("[whatsapp] debug proof load failed", { leadId, error });
          }
        }
      } catch (error) {
        leadMessages = [];
        leadQuotes = [];
        leadTimelineEvents = [];
        lastLeadMessagesSignature = "";
        lastLeadTimelineSignature = "";
        renderConversationMessages([]);
        renderClientTimeline(lead);
        renderSuggestionCards([]);
        await loadAiLatestForLead(leadId, { silent: true });
        await loadAiFlowForLead(leadId, { silent: true });
        await loadSessionStatus(leadId);
        if (!skipDebug) await loadLeadDebugProof(leadId);
        if (!silent) showErrorBanner(formatError(error));
      }
    }

    async function pollConversationTick() {
      if (realtimePollInFlight) return;
      if (document.hidden) return;
      if (!selectedLeadId) return;
      realtimePollInFlight = true;
      try {
        await loadConversationForLead(selectedLeadId, { silent: true, skipDebug: true });
      } finally {
        realtimePollInFlight = false;
      }
    }

    function signatureForLeadItems(items) {
      const list = Array.isArray(items) ? items : [];
      return list
        .map((lead) => {
          const id = String(lead && lead.id ? lead.id : "");
          const updatedAt = String(lead && lead.updated_at ? lead.updated_at : "");
          const stage = String(lead && lead.stage ? lead.stage : "");
          const lastActivityAt = String(lead && lead.last_activity_at ? lead.last_activity_at : "");
          return id + "|" + updatedAt + "|" + stage + "|" + lastActivityAt;
        })
        .join("||");
    }

    async function pollLeadsTick() {
      if (realtimeLeadsPollInFlight) return;
      if (document.hidden) return;
      realtimeLeadsPollInFlight = true;
      try {
        const leadsUrl = "/api/whatsapp/leads?range=" + selectedDays +
          (selectedStage !== "ALL" ? ("&stage=" + encodeURIComponent(selectedStage)) : "") +
          (qs ? "&" + q.toString() : "");
        const payload = await fetchJson(leadsUrl);
        const nextLeads = Array.isArray(payload && payload.items) ? payload.items : [];
        const nextSig = signatureForLeadItems(nextLeads);
        if (nextSig === lastLeadsSignature) return;
        lastLeadsSignature = nextSig;
        allLeads = nextLeads;
        await loadProductPreviewsForLeads(allLeads);
        applyLeadFiltersAndRender({ skipConversationLoad: true });
      } catch (error) {
        console.debug("[whatsapp] leads realtime poll failed", error);
      } finally {
        realtimeLeadsPollInFlight = false;
      }
    }

    function stopRealtimeConversationPolling() {
      if (realtimePollTimer) {
        clearInterval(realtimePollTimer);
        realtimePollTimer = null;
      }
      if (realtimeLeadsPollTimer) {
        clearInterval(realtimeLeadsPollTimer);
        realtimeLeadsPollTimer = null;
      }
    }

    function startRealtimeConversationPolling() {
      stopRealtimeConversationPolling();
      realtimePollTimer = setInterval(() => {
        void pollConversationTick();
      }, REALTIME_POLL_MS);
      realtimeLeadsPollTimer = setInterval(() => {
        void pollLeadsTick();
      }, REALTIME_LEADS_POLL_MS);
    }

    async function appendConversationDraft(text) {
      const lead = selectedLead();
      const value = String(text || "").trim();
      if (!lead || !value) return;
      if (isSharedLeadClient(lead)) {
        showErrorBanner("Shared number (no API): drafts are copy-only.");
        return;
      }
      await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/messages" + qs, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction: "OUT",
          text: value,
          provider: "system",
          message_type: "text"
        })
      });
      pendingSuggestionFeedback = null;
      await loadConversationForLead(lead.id);
      void loadAll();
    }

    function scrollToMessageById(messageId) {
      if (!conversationMessagesEl || !messageId) return;
      const selector = '.msg-bubble[data-message-id=\"' + String(messageId).replace(/\"/g, '\\"') + '\"]';
      const node = conversationMessagesEl.querySelector(selector);
      if (!(node instanceof HTMLElement)) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("flash");
      window.setTimeout(() => node.classList.remove("flash"), 800);
    }

    function openLeadDrawer(lead) {
      if (!lead || !drawerBackdropEl) return;
      activeDrawerLeadId = String(lead.id || "");
      drawerTitleEl.textContent = "Détails du lead";
      drawerSubtitleEl.textContent = String(lead.client || "") + " · " + String(lead.country || "-");
      const risk = lead.risk || {};
      const autoStage = lead.auto_stage_progression && typeof lead.auto_stage_progression === "object" ? lead.auto_stage_progression : null;
      const autoSignals = autoStage && autoStage.signals && typeof autoStage.signals === "object" ? autoStage.signals : {};
      const autoLastTrigger = autoStage && autoStage.last_trigger && typeof autoStage.last_trigger === "object" ? autoStage.last_trigger : null;
      drawerSummaryEl.innerHTML = [
        "<div><span class='tiny'>Stage actuel</span><div>" + esc(lead.stage || "-") + "</div></div>",
        "<div><span class='tiny'>Stage recommandé</span><div>" + esc(lead.recommended_stage || "-") + "</div></div>",
        "<div><span class='tiny'>Confiance reco</span><div>" + esc(lead.recommended_stage_confidence != null ? fmtPct(Number(lead.recommended_stage_confidence) * 100) : "-") + "</div></div>",
        "<div><span class='tiny'>Auto stage progression</span><div>" + esc(autoStage && autoStage.enabled ? "YES" : "NO") + "</div></div>",
        "<div><span class='tiny'>Last trigger</span><div>" + esc(autoLastTrigger ? String(autoLastTrigger.reason || "-") : "-") + "</div></div>",
        "<div><span class='tiny'>Signals</span><div>" + esc(
          "product_interest=" + Boolean(autoSignals.product_interest) +
          ", price_sent=" + Boolean(autoSignals.price_sent) +
          ", video_proposed=" + Boolean(autoSignals.video_proposed) +
          ", payment_question=" + Boolean(autoSignals.payment_question) +
          ", deposit_link_sent=" + Boolean(autoSignals.deposit_link_sent) +
          ", deposit_pending=" + Boolean(autoSignals.deposit_pending) +
          ", chat_confirmed=" + Boolean(autoSignals.chat_confirmed)
        ) + "</div></div>",
        "<div><span class='tiny'>Inactivité</span><div>" + esc(fmtHours(risk.hours_since_last_activity || 0)) + " / " + esc(String(risk.threshold_hours || 48)) + "h</div></div>",
        "<div><span class='tiny'>Dernière activité</span><div>" + esc(fmtDate(lead.last_activity_at)) + "</div></div>",
        "<div><span class='tiny'>Statut risque</span><div>" + esc(risk.is_at_risk ? "À risque" : "Normal") + "</div></div>"
      ].join("");

      const tags = Array.isArray(lead.qualification_tags) ? lead.qualification_tags : [];
      drawerTagsEl.innerHTML = tags.length
        ? tags.map((tag) => "<span class='pill'>" + esc(tag) + "</span>").join("")
        : "<span class='tiny'>Aucun tag détecté.</span>";

      const signals = lead.detected_signals || {};
      const rules = Array.isArray(signals.rules_triggered) ? signals.rules_triggered : [];
      drawerRulesEl.innerHTML = rules.length
        ? "<ul class='list'>" + rules.map((rule) => "<li><strong>" + esc(rule.rule || "-") + "</strong> · " + esc(rule.details || "-") + "</li>").join("") + "</ul>"
        : "<div class='tiny'>Aucune règle déclenchée.</div>";

      const evidence = Array.isArray(signals.evidence) ? signals.evidence : [];
      drawerEvidenceEl.innerHTML = evidence.length
        ? evidence
            .map((entry) => "<li><strong>" + esc(entry.tag || "-") + "</strong> · “" + esc(entry.match || "") + "” · " + esc(fmtDate(entry.created_at)) + "</li>")
            .join("")
        : "<li class='tiny'>Aucune preuve stockée.</li>";

      const scoring = lead.score_breakdown ? { score: lead.score, score_breakdown: lead.score_breakdown } : topLeadScoreMap.get(lead.id);
      const breakdown = scoring && Array.isArray(scoring.score_breakdown) ? scoring.score_breakdown : [];
      drawerScoreEl.innerHTML = breakdown.length
        ? breakdown.map((item) => "<li>" + esc(item.label || "-") + " : +" + esc(item.points || 0) + "</li>").join("")
        : "<li class='tiny'>Score non calculé pour ce lead dans la fenêtre actuelle.</li>";
      drawerScoreTotalEl.textContent = "Total: " + String(scoring && Number.isFinite(Number(scoring.score)) ? Number(scoring.score) : "-");

      const aiSuggestion = signals.ai_suggestion || {};
      drawerAiReasonEl.textContent = "Reason IA: " + String(aiSuggestion.reason || lead.stage_auto_reason || "Aucune");
      drawerAiQuestionEl.textContent = String(aiSuggestion.next_question || "Aucune suggestion IA disponible.");
      drawerRecentMessagesEl.innerHTML = "";
      drawerBackdropEl.classList.add("open");
    }

    function closeLeadDrawer() {
      if (!drawerBackdropEl) return;
      drawerBackdropEl.classList.remove("open");
      activeDrawerLeadId = "";
    }

    function renderKpis(metrics) {
      kpiRowEl.innerHTML = [
        kpi("Demandes", metrics.total_inquiries || 0),
        kpi("Conversion", fmtPct(metrics.conversion_rate || 0)),
        kpi("Temps réponse moyen", fmtMinutes(metrics.avg_response_time || 0)),
        kpi("Leads actifs", metrics.active_leads || 0),
        kpi("Leads à risque", metrics.leads_at_risk || 0),
        kpi("% < 15 min", fmtPct(metrics.fast_response_pct || 0)),
        kpi("% > 1h", fmtPct(metrics.slow_response_pct || 0)),
        kpi("Conv <15 vs >1h", fmtPct(metrics.conversion_fast_pct || 0) + " vs " + fmtPct(metrics.conversion_slow_pct || 0))
      ].join("");
    }

    function renderPipeline(metrics) {
      const stageDist = metrics.stage_distribution || {};
      const total = Number(metrics.total_inquiries || 0);
      pipelineEl.innerHTML = STAGES.map((stage) => {
        const count = Number(stageDist[stage] || 0);
        const pct = total > 0 ? (count / total) * 100 : 0;
        const isActive = selectedStage === stage;
        return '<article class="stage ' + (isActive ? "active" : "") + '" data-stage="' + esc(stage) + '">' +
          '<div class="name">' + esc(stage) + "</div>" +
          '<div class="count">' + esc(count) + "</div>" +
          '<div class="pct">' + esc(fmtPct(pct)) + "</div>" +
        "</article>";
      }).join("");
    }

    function deriveFollowUpType(lead) {
      const stage = String(lead.stage || "").toUpperCase();
      const last = new Date(String(lead.last_activity_at || "")).getTime();
      const idleHours = Number.isFinite(last) ? (Date.now() - last) / 3600000 : 0;
      if (lead && lead.has_price_sent && idleHours >= 72) return "72H_PRICE";
      if (lead && lead.has_price_sent) return "48H_PRICE";
      if (stage === "QUALIFIED" || (lead && lead.has_video_proposed)) return "72H_QUALIFIED_VIDEO";
      return "48H_PRICE";
    }

    function eventDateLabelFromLead(lead) {
      if (!lead || typeof lead !== "object") return "[date événement]";
      const rawText = String(lead.event_date_text || "").trim();
      if (rawText) return rawText;
      const rawIso = String(lead.event_date || "").trim();
      if (!rawIso) return "[date événement]";
      const d = new Date(rawIso);
      if (Number.isNaN(d.getTime())) return "[date événement]";
      return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    }

    function eventDateLabelFromLeadByLanguage(lead, language) {
      const lang = String(language || "FR").toUpperCase();
      if (!lead || typeof lead !== "object") return lang === "EN" ? "[event date]" : "[date événement]";
      const rawText = String(lead.event_date_text || "").trim();
      if (rawText) return rawText;
      const rawIso = String(lead.event_date || "").trim();
      if (!rawIso) return lang === "EN" ? "[event date]" : "[date événement]";
      const d = new Date(rawIso);
      if (Number.isNaN(d.getTime())) return lang === "EN" ? "[event date]" : "[date événement]";
      return d.toLocaleDateString(lang === "EN" ? "en-US" : "fr-FR", { day: "numeric", month: "long", year: "numeric" });
    }

    function replaceEventDatePlaceholder(text, lead) {
      const label = eventDateLabelFromLead(lead);
      let out = String(text || "");
      out = out.split("[date événement]").join(label);
      out = out.split("[date evenement]").join(label);
      out = out.split("[DATE ÉVÉNEMENT]").join(label);
      out = out.split("[DATE EVENEMENT]").join(label);
      out = out.split("{event_date}").join(label);
      out = out.split("{EVENT_DATE}").join(label);
      return out;
    }

    function countryGroupForLead(lead) {
      const c = String((lead && lead.country) || "").trim().toUpperCase();
      if (c === "MA" || c === "MAROC" || c === "MOROCCO") return "MA";
      if (c === "FR" || c === "FRANCE") return "FR";
      return "INTL";
    }

    function detectMessageLanguage(text) {
      const value = String(text || "").toLowerCase();
      if (!value) return "";
      const enHints = ["hello", "hi", "interested", "price", "delivery", "event", "confirm", "how can i pay", "payment", "thanks"];
      const frHints = ["bonjour", "salut", "intéress", "prix", "livraison", "événement", "je confirme", "comment je paie", "paiement", "merci"];
      const enScore = enHints.reduce((acc, hint) => acc + (value.includes(hint) ? 1 : 0), 0);
      const frScore = frHints.reduce((acc, hint) => acc + (value.includes(hint) ? 1 : 0), 0);
      if (enScore === frScore) return "";
      return enScore > frScore ? "EN" : "FR";
    }

    function previousClientMessageText() {
      const msgs = Array.isArray(leadMessages) ? leadMessages.slice() : [];
      if (!msgs.length) return "";
      msgs.sort((a, b) => {
        const ta = new Date(String(a && a.created_at ? a.created_at : "")).getTime();
        const tb = new Date(String(b && b.created_at ? b.created_at : "")).getTime();
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return 0;
      });
      const last = msgs[msgs.length - 1];
      if (String(last && last.direction ? last.direction : "").toUpperCase() === "IN") {
        return String(last && last.text ? last.text : "");
      }
      for (let i = msgs.length - 2; i >= 0; i -= 1) {
        const msg = msgs[i];
        if (String(msg && msg.direction ? msg.direction : "").toUpperCase() === "IN") {
          return String(msg && msg.text ? msg.text : "");
        }
      }
      return "";
    }

    function preferredComposerLanguage(lead) {
      const detected = detectMessageLanguage(previousClientMessageText());
      if (detected) return detected;
      return countryGroupForLead(lead) === "INTL" ? "EN" : "FR";
    }

    function priceSentTemplateForLead(lead, language) {
      const lang = String(language || "FR").toUpperCase();
      const group = countryGroupForLead(lead);
      const eventDate = eventDateLabelFromLeadByLanguage(lead, lang);
      const currency = group === "MA" ? "DHS" : group === "FR" ? "EUR" : "USD";
      const productionTime = group === "MA" ? "3 semaines" : group === "FR" ? "4 semaines" : "4 weeks";
      if (lang === "EN") {
        return "Perfect, we are on schedule for " + eventDate + ". The price is [price] " + currency + ", with an estimated production time of " + productionTime + ". If you wish, I can arrange a short private video call.";
      }
      return "Parfait, nous sommes dans les délais pour " + eventDate + ". Le prix est de [prix] " + currency + ", avec un délai de confection d’environ " + productionTime + ". Si vous le souhaitez, je peux organiser une courte visio privée.";
    }

    function renderPostConfirmQuickActions(lead) {
      if (!postConfirmQuickActionsEl) return;
      const stage = String((lead && lead.stage) || "").toUpperCase();
      if (stage !== "CONFIRMED") {
        postConfirmQuickActionsEl.innerHTML = "";
        return;
      }
      postConfirmQuickActionsEl.innerHTML = [
        '<button type="button" class="stage-msg-btn" data-post-confirm="deposit_link">Envoyer lien acompte</button>',
        '<button type="button" class="stage-msg-btn" data-post-confirm="rib">Envoyer RIB / virement</button>',
        '<button type="button" class="stage-msg-btn" data-post-confirm="measures">Demander mesures</button>'
      ].join("");
    }

    async function suggestReplyForSelectedLead() {
      const lead = selectedLead();
      if (!lead) {
        showErrorBanner("Aucun lead sélectionné.");
        return;
      }
      if (!selectedLeadHasInboundMessage()) {
        showErrorBanner("Aucun message entrant. La suggestion exige au moins un message client.");
        return;
      }
      statusLineEl.textContent = "Génération des suggestions...";
      try {
        await refreshSuggestionCardsForSelectedLead();
        statusLineEl.textContent = "Suggestions prêtes (cartes Insérer)";
        if (leadDebugOpen && lead && lead.id) await loadLeadDebugProof(String(lead.id));
      } catch (error) {
        showErrorBanner(formatError(error));
        statusLineEl.textContent = "Suggestion indisponible";
      }
    }

    async function suggestReplyForTargetStage(targetStage) {
      const lead = selectedLead();
      if (!lead) {
        showErrorBanner("Aucun lead sélectionné.");
        return;
      }
      if (!selectedLeadHasInboundMessage()) {
        showErrorBanner("Aucun message entrant. La suggestion exige au moins un message client.");
        return;
      }
      statusLineEl.textContent = "Génération message stage " + String(targetStage) + "...";
      try {
        const payload = await fetchJson("/api/whatsapp/suggest-reply" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: lead.id, targetStage })
        });
        const text = replaceEventDatePlaceholder(
          String(payload && (payload.suggested_message || payload.text) ? (payload.suggested_message || payload.text) : "").trim(),
          lead
        );
        renderSuggestionTemplateOptions(payload && Array.isArray(payload.template_options) ? payload.template_options : []);
        pendingSuggestionFeedback = {
          id: payload && payload.feedback_token ? String(payload.feedback_token) : "",
          source: "rules_suggest_reply",
          suggestion_type: String(payload && payload.suggestion_type ? payload.suggestion_type : ""),
          suggested_text: text
        };
        if (conversationTextEl instanceof HTMLTextAreaElement && text) {
          conversationTextEl.value = text;
          conversationTextEl.focus();
        }
        if (suggestionContextNoteEl) {
          suggestionContextNoteEl.textContent =
            "Suggestion based on: last inbound message + stage · Stage: " +
            String(payload && payload.stage_used ? payload.stage_used : targetStage) +
            " · Rule: " + String(payload && payload.rule_applied ? payload.rule_applied : "-");
        }
        statusLineEl.textContent = "Message stage prêt (" + String(payload && payload.suggestion_type ? payload.suggestion_type : "AUTO") + ")";
        if (leadDebugOpen && lead && lead.id) await loadLeadDebugProof(String(lead.id));
      } catch (error) {
        showErrorBanner(formatError(error));
        statusLineEl.textContent = "Suggestion stage indisponible";
      }
    }

    async function classifyLeadById(leadId) {
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) return;
      selectedLeadId = leadId;
      classificationBoxEl.textContent = "Running AI classification...";
      try {
        const payload = await fetchJson("/api/whatsapp/ai/classify" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId })
        });
        console.log("[whatsapp] classification result", payload);
        const confidenceRatio = Number(
          payload && payload.confidence_ratio != null
            ? payload.confidence_ratio
            : (Number(payload && payload.confidence ? payload.confidence : 0) / 100)
        );
        const recommendedStage = payload.recommended_stage || payload.detected_stage || null;
        const reasonText = payload.reason || payload.explanation || "";
        const suggestedMessage = payload.next_question || payload.suggested_message || "";
        pendingSuggestionFeedback = suggestedMessage
          ? {
              id: payload && payload.feedback_token ? String(payload.feedback_token) : "",
              source: "ai_classify",
              suggestion_type: String(payload && payload.suggestion_type ? payload.suggestion_type : "CLASSIFY"),
              suggested_text: String(suggestedMessage || "")
            }
          : null;
        const qualificationComplete = Boolean(payload.qualification_complete);
        const missingFields = Array.isArray(payload.missing_fields) ? payload.missing_fields : [];
        lastClassification = {
          leadId,
          recommendedStage,
          nextQuestion: suggestedMessage
        };
        lead.recommended_stage = recommendedStage || lead.recommended_stage;
        lead.recommended_reason = reasonText || lead.recommended_reason;
        lead.recommended_stage_confidence = confidenceRatio;
        const currentSignals = lead.detected_signals && typeof lead.detected_signals === "object" ? lead.detected_signals : {};
        lead.detected_signals = Object.assign({}, currentSignals, {
          ai_suggestion: {
            reason: reasonText,
            next_question: suggestedMessage,
            confidence: confidenceRatio,
            recommended_stage: recommendedStage,
            qualification_complete: qualificationComplete,
            missing_fields: missingFields,
            evaluated_at: new Date().toISOString()
          }
        });
        lead.intent_level = payload.intent_level || lead.intent_level;
        lead.stage_confidence = confidenceRatio;
        if (payload.auto_applied && recommendedStage) {
          lead.stage = recommendedStage;
          lead.stage_auto = true;
        }
        const stageAutoReason = String(lead.stage_auto_reason || payload.reason || "-");
        const progressionSignals = {
          product_interest: Boolean(lead.has_product_interest),
          price_sent: Boolean(lead.has_price_sent),
          video_proposed: Boolean(lead.has_video_proposed),
          payment_question: Boolean(lead.has_payment_question),
          deposit_link_sent: Boolean(lead.has_deposit_link_sent),
          deposit_pending: Boolean(lead.has_payment_question || lead.has_deposit_link_sent),
          chat_confirmed: Boolean(lead.chat_confirmed)
        };
        renderLeads(leads);
        classificationBoxEl.textContent = [
          "Stage détecté: " + String(payload.detected_stage || recommendedStage || "-"),
          "Urgence: " + String(payload.urgency || "-"),
          "Intent: " + String(payload.intent_level || "-"),
          "Stage auto: " + String(lead.stage || "-"),
          "Auto stage progression: " + (lead.stage_auto ? "YES" : "NO"),
          "Last trigger: " + stageAutoReason + " (source " + String(lead.stage_auto_source_message_id || "-") + ", confidence " + String(lead.stage_auto_confidence != null ? lead.stage_auto_confidence : "-") + ")",
          "Signals: product_interest=" + String(progressionSignals.product_interest) +
            ", price_sent=" + String(progressionSignals.price_sent) +
            ", video_proposed=" + String(progressionSignals.video_proposed) +
            ", payment_question=" + String(progressionSignals.payment_question) +
            ", deposit_link_sent=" + String(progressionSignals.deposit_link_sent) +
            ", deposit_pending=" + String(progressionSignals.deposit_pending) +
            ", chat_confirmed=" + String(progressionSignals.chat_confirmed),
          "Confiance: " + fmtPct((Number(confidenceRatio || 0) * 100)),
          "Score: " + String(payload.score != null ? payload.score : "-"),
          "Qualification complete: " + (qualificationComplete ? "Yes" : "No"),
          "Missing: " + (missingFields.length ? missingFields.join(", ") : "-"),
          "Pourquoi: " + String(reasonText || "-"),
          "",
          "Réponse suggérée:",
          String(suggestedMessage || "-"),
          "",
          "Prochaine action:",
          String(payload.recommended_next_action || "-"),
          "",
          payload.auto_applied ? "Stage appliqué automatiquement (confiance >= 85%)." : "Recommandation prête pour application manuelle."
        ].join("\\n");
        if (payload.auto_applied) {
          statusLineEl.textContent = "AI classification auto-applied";
          void loadAll();
        } else {
          statusLineEl.textContent = "AI recommendation ready";
        }
      } catch (error) {
        classificationBoxEl.textContent = "Unable to classify right now.";
        showErrorBanner(formatError(error));
      }
    }

    async function generateFollowUpByLeadId(leadId) {
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) return;
      selectedLeadId = leadId;
      if (followupBoxEl) followupBoxEl.textContent = "Generating suggestion...";
      updateSidePanelState();
      const type = selectedFollowUpType || deriveFollowUpType(lead);
      try {
        const payload = await fetchJson("/api/whatsapp/ai/followup" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId, type })
        });
        console.log("[whatsapp] followup result", payload);
        if (followupBoxEl) followupBoxEl.textContent = String(payload.text || "No suggestion");
        pendingSuggestionFeedback = payload && payload.text
          ? {
              id: payload.feedback_token ? String(payload.feedback_token) : "",
              source: "ai_followup",
              suggestion_type: String(type || "FOLLOWUP"),
              suggested_text: String(payload.text || "")
            }
          : null;
        updateSidePanelState();
      } catch (error) {
        if (followupBoxEl) followupBoxEl.textContent = "Unable to generate suggestion right now.";
        showErrorBanner(formatError(error));
        updateSidePanelState();
      }
    }

    function renderRowWaitingForPill(waitingFor) {
      const value = String(waitingFor || "").toUpperCase();
      if (!value) return "";
      if (value === "WAITING_FOR_US") {
        return '<div class="wf-row-pill wf-us">WF: US</div>';
      }
      if (value === "WAITING_FOR_CLIENT") {
        return '<div class="wf-row-pill wf-client">WF: CLIENT</div>';
      }
      return "";
    }

    function selectedLeadStorageKey() {
      return "selectedLeadId";
    }

    function readPersistedSelectedLeadId() {
      try {
        return String(localStorage.getItem(selectedLeadStorageKey()) || "").trim();
      } catch {
        return "";
      }
    }

    function persistSelectedLeadId(leadId) {
      try {
        if (!leadId) {
          localStorage.removeItem(selectedLeadStorageKey());
        } else {
          localStorage.setItem(selectedLeadStorageKey(), String(leadId));
        }
      } catch {
        // ignore storage failures
      }
    }

    function leadListSnippet(lead) {
      const rawSnippet = String(lead && lead.last_message_snippet ? lead.last_message_snippet : "").trim();
      if (rawSnippet) return rawSnippet;
      const product = String(lead && lead.product ? lead.product : "").trim();
      if (product && product !== "-") return "Produit: " + product;
      return String(lead && lead.phone ? lead.phone : "No recent message");
    }

    const COUNTRY_NAME_TO_ISO2 = {
      MOROCCO: "MA", MAROC: "MA",
      FRANCE: "FR",
      SPAIN: "ES", ESPANA: "ES", ESPAGNE: "ES",
      PORTUGAL: "PT",
      UNITEDSTATES: "US", UNITEDSTATESOFAMERICA: "US", USA: "US", ETATSUNIS: "US",
      CANADA: "CA",
      UNITEDKINGDOM: "GB", UK: "GB", GREATBRITAIN: "GB", ENGLAND: "GB", ROYAUMEUNI: "GB",
      GERMANY: "DE", ALLEMAGNE: "DE",
      ITALY: "IT", ITALIE: "IT",
      NETHERLANDS: "NL", PAYSBAS: "NL", HOLLAND: "NL",
      BELGIUM: "BE", BELGIQUE: "BE",
      SWITZERLAND: "CH", SUISSE: "CH",
      AUSTRIA: "AT", AUTRICHE: "AT",
      SWEDEN: "SE", SUEDE: "SE",
      NORWAY: "NO", NORVEGE: "NO",
      DENMARK: "DK", DANEMARK: "DK",
      FINLAND: "FI", FINLANDE: "FI",
      POLAND: "PL", POLOGNE: "PL",
      TURKEY: "TR", TURQUIE: "TR",
      GREECE: "GR", GRECE: "GR",
      ROMANIA: "RO", ROUMANIE: "RO",
      BULGARIA: "BG", BULGARIE: "BG",
      CROATIA: "HR", CROATIE: "HR",
      SERBIA: "RS", SERBIE: "RS",
      BOSNIA: "BA", BOSNIAANDHERZEGOVINA: "BA",
      MONTENEGRO: "ME",
      ALBANIA: "AL", ALBANIE: "AL",
      SLOVENIA: "SI", SLOVENIE: "SI",
      SLOVAKIA: "SK", SLOVAQUIE: "SK",
      CZECHREPUBLIC: "CZ", CZECHIA: "CZ", TCHEQUIE: "CZ",
      HUNGARY: "HU", HONGRIE: "HU",
      IRELAND: "IE", IRLANDE: "IE",
      ICELAND: "IS", ISLANDE: "IS",
      LUXEMBOURG: "LU",
      MALTA: "MT",
      CYPRUS: "CY", CHYPRE: "CY",
      UKRAINE: "UA",
      RUSSIA: "RU", RUSSIE: "RU",
      GEORGIA: "GE",
      ARMENIA: "AM", ARMENIE: "AM",
      AZERBAIJAN: "AZ",
      KAZAKHSTAN: "KZ",
      UZBEKISTAN: "UZ",
      INDIA: "IN", INDE: "IN",
      PAKISTAN: "PK",
      BANGLADESH: "BD",
      "SRI LANKA": "LK", SRILANKA: "LK",
      NEPAL: "NP",
      CHINA: "CN", CHINE: "CN",
      JAPAN: "JP", JAPON: "JP",
      SOUTHKOREA: "KR", KOREADUSUD: "KR", KOREA: "KR",
      THAILAND: "TH", THAILANDE: "TH",
      VIETNAM: "VN",
      PHILIPPINES: "PH",
      INDONESIA: "ID", INDONESIE: "ID",
      MALAYSIA: "MY",
      SINGAPORE: "SG",
      HONGKONG: "HK",
      TAIWAN: "TW",
      AUSTRALIA: "AU", AUSTRALIE: "AU",
      NEWZEALAND: "NZ", NOUVELLEZELANDE: "NZ",
      UNITEDARABEMIRATES: "AE", UAE: "AE", EMIRATSARABESUNIS: "AE",
      SAUDIARABIA: "SA", ARABIESAOUDITE: "SA",
      QATAR: "QA",
      BAHRAIN: "BH",
      KUWAIT: "KW",
      OMAN: "OM",
      JORDAN: "JO", JORDANIE: "JO",
      LEBANON: "LB", LIBAN: "LB",
      ISRAEL: "IL",
      EGYPT: "EG", EGYPTE: "EG",
      ALGERIA: "DZ", ALGERIE: "DZ",
      TUNISIA: "TN", TUNISIE: "TN",
      LIBYA: "LY", LIBYE: "LY",
      SENEGAL: "SN",
      IVORYCOAST: "CI", COTEDIVOIRE: "CI",
      GHANA: "GH",
      NIGERIA: "NG",
      CAMEROON: "CM", CAMEROUN: "CM",
      ETHIOPIA: "ET", ETHIOPIE: "ET",
      KENYA: "KE",
      TANZANIA: "TZ",
      SOUTHAFRICA: "ZA", AFRIQUEDUSUD: "ZA",
      BRAZIL: "BR", BRESIL: "BR",
      ARGENTINA: "AR", ARGENTINE: "AR",
      MEXICO: "MX", MEXIQUE: "MX",
      CHILE: "CL", CHILI: "CL",
      COLOMBIA: "CO", COLOMBIE: "CO",
      PERU: "PE", PEROU: "PE",
      ECUADOR: "EC", EQUATEUR: "EC",
      URUGUAY: "UY",
      PARAGUAY: "PY",
      BOLIVIA: "BO", BOLIVIE: "BO",
      VENEZUELA: "VE"
    };

    const DIAL_PREFIX_TO_ISO2 = {
      "+1": "US", "+7": "RU", "+20": "EG", "+27": "ZA", "+30": "GR", "+31": "NL", "+32": "BE",
      "+33": "FR", "+34": "ES", "+36": "HU", "+39": "IT", "+40": "RO", "+41": "CH", "+43": "AT",
      "+44": "GB", "+45": "DK", "+46": "SE", "+47": "NO", "+48": "PL", "+49": "DE", "+51": "PE",
      "+52": "MX", "+53": "CU", "+54": "AR", "+55": "BR", "+56": "CL", "+57": "CO", "+58": "VE",
      "+60": "MY", "+61": "AU", "+62": "ID", "+63": "PH", "+64": "NZ", "+65": "SG", "+66": "TH",
      "+81": "JP", "+82": "KR", "+84": "VN", "+86": "CN", "+90": "TR", "+91": "IN", "+92": "PK",
      "+93": "AF", "+94": "LK", "+95": "MM", "+98": "IR", "+212": "MA", "+213": "DZ", "+216": "TN",
      "+218": "LY", "+220": "GM", "+221": "SN", "+222": "MR", "+223": "ML", "+224": "GN", "+225": "CI",
      "+226": "BF", "+227": "NE", "+228": "TG", "+229": "BJ", "+230": "MU", "+231": "LR", "+232": "SL",
      "+233": "GH", "+234": "NG", "+235": "TD", "+236": "CF", "+237": "CM", "+238": "CV", "+239": "ST",
      "+240": "GQ", "+241": "GA", "+242": "CG", "+243": "CD", "+244": "AO", "+245": "GW", "+246": "IO",
      "+248": "SC", "+249": "SD", "+250": "RW", "+251": "ET", "+252": "SO", "+253": "DJ", "+254": "KE",
      "+255": "TZ", "+256": "UG", "+257": "BI", "+258": "MZ", "+260": "ZM", "+261": "MG", "+262": "RE",
      "+263": "ZW", "+264": "NA", "+265": "MW", "+266": "LS", "+267": "BW", "+268": "SZ", "+269": "KM",
      "+290": "SH", "+297": "AW", "+298": "FO", "+299": "GL", "+350": "GI", "+351": "PT", "+352": "LU",
      "+353": "IE", "+354": "IS", "+355": "AL", "+356": "MT", "+357": "CY", "+358": "FI", "+359": "BG",
      "+370": "LT", "+371": "LV", "+372": "EE", "+373": "MD", "+374": "AM", "+375": "BY", "+376": "AD",
      "+377": "MC", "+378": "SM", "+380": "UA", "+381": "RS", "+382": "ME", "+383": "XK", "+385": "HR",
      "+386": "SI", "+387": "BA", "+389": "MK", "+420": "CZ", "+421": "SK", "+423": "LI", "+500": "FK",
      "+501": "BZ", "+502": "GT", "+503": "SV", "+504": "HN", "+505": "NI", "+506": "CR", "+507": "PA",
      "+508": "PM", "+509": "HT", "+590": "GP", "+591": "BO", "+592": "GY", "+593": "EC", "+594": "GF",
      "+595": "PY", "+596": "MQ", "+597": "SR", "+598": "UY", "+599": "CW", "+670": "TL", "+672": "NF",
      "+673": "BN", "+674": "NR", "+675": "PG", "+676": "TO", "+677": "SB", "+678": "VU", "+679": "FJ",
      "+680": "PW", "+681": "WF", "+682": "CK", "+683": "NU", "+685": "WS", "+686": "KI", "+687": "NC",
      "+688": "TV", "+689": "PF", "+690": "TK", "+691": "FM", "+692": "MH", "+852": "HK", "+853": "MO",
      "+855": "KH", "+856": "LA", "+880": "BD", "+886": "TW", "+960": "MV", "+961": "LB", "+962": "JO",
      "+963": "SY", "+964": "IQ", "+965": "KW", "+966": "SA", "+967": "YE", "+968": "OM", "+970": "PS",
      "+971": "AE", "+972": "IL", "+973": "BH", "+974": "QA", "+975": "BT", "+976": "MN", "+977": "NP",
      "+992": "TJ", "+993": "TM", "+994": "AZ", "+995": "GE", "+996": "KG", "+998": "UZ"
    };

    function normalizeCountryIso2(raw) {
      const value = String(raw || "").trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(value)) return value;
      const compact = value.replace(/[^A-Z]/g, "");
      if (compact && COUNTRY_NAME_TO_ISO2[compact]) return COUNTRY_NAME_TO_ISO2[compact];
      if (compact === "UK") return "GB";
      return "";
    }

    function extractDialIso2(phoneRaw) {
      const input = String(phoneRaw || "").trim();
      if (!input) return "";
      const digitsOnly = input.replace(/[^0-9]/g, "");
      if (!digitsOnly) return "";
      const normalized = "+" + digitsOnly;
      for (let len = Math.min(5, normalized.length); len >= 2; len -= 1) {
        const prefix = normalized.slice(0, len);
        if (DIAL_PREFIX_TO_ISO2[prefix]) return DIAL_PREFIX_TO_ISO2[prefix];
      }
      return "";
    }

    function countryCodeToFlag(iso2) {
      const code = String(iso2 || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) return "";
      return String.fromCodePoint(code.charCodeAt(0) + 127397) + String.fromCodePoint(code.charCodeAt(1) + 127397);
    }

    function resolveLeadCountryIso2(lead) {
      const fromCountry = normalizeCountryIso2(lead && lead.country ? lead.country : "");
      if (fromCountry) return fromCountry;
      const fromShip = normalizeCountryIso2(lead && lead.ship_country ? lead.ship_country : "");
      if (fromShip) return fromShip;
      return extractDialIso2(lead && lead.phone ? lead.phone : "");
    }

    function sidebarLeadMatchesFilter(lead) {
      const mode = String(leadSidebarFilter || "all").toLowerCase();
      if (mode === "urgent") return leadUrgencyHigh(lead);
      if (mode === "risk") return Number(lead && lead.risk && lead.risk.risk_score != null ? lead.risk.risk_score : 0) >= 70;
      if (mode === "high") return leadIsHighProbability(lead);
      return true;
    }

    function renderLeadList(items) {
      if (!leadListEl) return;
      const source = Array.isArray(items) ? items : [];
      const sorted = source.slice().sort((a, b) => {
        const ta = new Date(String(a && a.last_activity_at ? a.last_activity_at : "")).getTime();
        const tb = new Date(String(b && b.last_activity_at ? b.last_activity_at : "")).getTime();
        const av = Number.isFinite(ta) ? ta : 0;
        const bv = Number.isFinite(tb) ? tb : 0;
        return bv - av;
      });
      const query = String(leadSidebarSearch || "").trim().toLowerCase();
      const visible = sorted.filter((lead) => {
        if (!sidebarLeadMatchesFilter(lead)) return false;
        if (!query) return true;
        const hay = [
          String(lead && lead.client ? lead.client : ""),
          String(lead && lead.phone ? lead.phone : ""),
          String(lead && lead.product ? lead.product : ""),
          String(lead && lead.country ? lead.country : ""),
          String(lead && lead.last_message_snippet ? lead.last_message_snippet : "")
        ].join(" ").toLowerCase();
        return hay.includes(query);
      });
      leadSidebarVisibleIds = visible.map((lead) => String(lead && lead.id ? lead.id : "")).filter(Boolean);
      if (leadSidebarKeyboardIndex < 0 || leadSidebarKeyboardIndex >= leadSidebarVisibleIds.length) {
        leadSidebarKeyboardIndex = leadSidebarVisibleIds.length ? 0 : -1;
      }
      if (!visible.length) {
        leadListEl.innerHTML = '<div class="wa-empty">No chats match the current filter.</div>';
        return;
      }
      leadListEl.innerHTML = visible.map((lead, index) => {
        const id = String(lead && lead.id ? lead.id : "");
        const avatarUrl = publicImageUrlFromLead(lead);
        const selected = id && id === selectedLeadId;
        const kbdActive = index === leadSidebarKeyboardIndex;
        const riskScore = Number(lead && lead.risk && lead.risk.risk_score != null ? lead.risk.risk_score : 0);
        const showRiskBadge = riskScore >= 70;
        const showUrgentBadge = leadUrgencyHigh(lead);
        const stage = String(lead && lead.stage ? lead.stage : "-").toUpperCase();
        const snippet = leadListSnippet(lead);
        const countryIso2 = resolveLeadCountryIso2(lead);
        const countryFlag = countryCodeToFlag(countryIso2);
        const locationPrefix = countryFlag
          ? ('<span class="wa-flag" title="' + esc(countryIso2) + '">' + countryFlag + "</span>")
          : '<span class="wa-flag" title="Unknown">🌐</span>';
        const avatarHtml = avatarUrl
          ? '<span class="wa-avatar"><img src="' + esc(avatarUrl) + '" alt="' + esc(String(lead && lead.client ? lead.client : "Client")) + '" /></span>'
          : '<span class="wa-avatar">' + esc(initials(lead && lead.client ? lead.client : "Client")) + "</span>";
        return (
          '<div class="wa-row' + (selected ? " is-active" : "") + (kbdActive ? " is-kbd" : "") + '" data-lead-id="' + esc(id) + '" tabindex="0">' +
            avatarHtml +
            '<div class="wa-meta">' +
              '<div class="wa-line1">' +
                '<div class="wa-name">' + esc(String(lead && lead.client ? lead.client : "Client")) + "</div>" +
                '<div class="wa-time">' + esc(fmtTime(lead && lead.last_activity_at ? lead.last_activity_at : "")) + "</div>" +
              "</div>" +
              '<div class="wa-line2">' +
                '<div class="wa-snippet">' + locationPrefix + esc(snippet) + "</div>" +
                '<div class="wa-badges">' +
                  '<span class="wa-badge stage">' + esc(stage) + "</span>" +
                  (showUrgentBadge ? '<span class="wa-badge">URGENT</span>' : "") +
                  (showRiskBadge ? '<span class="wa-badge risk">RISK</span>' : "") +
                "</div>" +
              "</div>" +
            "</div>" +
          "</div>"
        );
      }).join("");
      if (selectedLeadId) {
        const activeRow = leadListEl.querySelector('.wa-row[data-lead-id="' + String(selectedLeadId).replace(/"/g, '\\"') + '"]');
        if (activeRow instanceof HTMLElement) {
          activeRow.scrollIntoView({ block: "nearest" });
        }
      }
    }

    function sidebarLeadSource() {
      return Array.isArray(leads) && leads.length
        ? leads
        : (Array.isArray(allLeads) ? allLeads : []);
    }

    async function selectLead(leadId, opts) {
      const options = opts && typeof opts === "object" ? opts : {};
      const id = String(leadId || "").trim();
      if (!id) return;
      const source = sidebarLeadSource();
      const exists = source.some((item) => String(item && item.id ? item.id : "") === id);
      if (!exists) return;
      const changed = selectedLeadId !== id;
      selectedLeadId = id;
      window.selectedLeadId = id;
      persistSelectedLeadId(id);
      renderLeads(leads, { skipConversationLoad: true });
      renderLeadList(source);
      if (changed || options.forceReload) {
        await loadConversationForLead(selectedLeadId, { silent: Boolean(options.silent) });
      }
      updateSidePanelState();
    }

    function renderLeads(items, opts) {
      const options = opts && typeof opts === "object" ? opts : {};
      const skipConversationLoad = Boolean(options.skipConversationLoad);
      leads = items || [];
      if (!leads.length) {
        selectedLeadId = "";
        window.selectedLeadId = "";
        persistSelectedLeadId("");
        leadRowsEl.innerHTML = '<tr><td colspan="13"><div class="empty-state">Aucun lead WhatsApp reçu depuis Zoko pour le moment.</div></td></tr>';
        leadMessages = [];
        leadQuotes = [];
        leadTimelineEvents = [];
        leadDebugData = null;
        updateConversationHeader(null);
        renderConversationMessages([]);
        renderLeadList([]);
        updateSidePanelState();
        return;
      }
      if (!selectedLeadId || !leads.some((lead) => lead.id === selectedLeadId)) {
        const persisted = readPersistedSelectedLeadId();
        const restored = persisted && leads.some((lead) => lead.id === persisted) ? persisted : "";
        selectedLeadId = restored || leads[0].id;
      }
      window.selectedLeadId = selectedLeadId;
      persistSelectedLeadId(selectedLeadId);
      leadRowsEl.innerHTML = leads.map((lead) => {
        const risk = lead.risk || {};
        const riskClass = risk.is_at_risk ? "high" : "";
        const selected = lead.id === selectedLeadId ? "selected" : "";
        const currentStage = String(lead.stage || "").toUpperCase();
        const stageOptions = Array.from(new Set([...STAGES, currentStage].filter(Boolean)));
        const avatarUrl = publicImageUrlFromLead(lead);
        const leadAvatar = avatarUrl
          ? '<span class="lead-client-avatar"><img src="' + esc(avatarUrl) + '" alt="' + esc(String(lead.client || "Client")) + '" /></span>'
          : '<span class="lead-client-avatar">' + esc(initials(lead.client || "Client")) + "</span>";
        return '<tr data-id="' + esc(lead.id) + '" class="' + selected + '">' +
          '<td><div class="lead-client">' + leadAvatar + renderFunnelIndicator(lead) + "<strong>" + esc(lead.client) + "</strong>" + (isSharedLeadClient(lead) ? '<span class="shared-badge">Shared</span>' : "") + "</div></td>" +
          "<td>" + esc(lead.country) + "</td>" +
          "<td>" + renderLeadProductCell(lead) + "</td>" +
          "<td><select class='stage-select' data-stage-select>" +
            stageOptions.map((s) => '<option value="' + esc(s) + '" ' + (s === currentStage ? "selected" : "") + ">" + esc(s) + "</option>").join("") +
          "</select>" + renderRowWaitingForPill(lead.waiting_for) + "</td>" +
          "<td>" + (lead.recommended_stage ? '<span class="rec">' + esc(lead.recommended_stage) + "</span>" : "-") + "</td>" +
          "<td>" + convBadge(lead.conversion_probability, lead.conversion_band, lead.conversion_reasons) + "</td>" +
          "<td>" + esc(fmtMinutes(lead.first_response_time_minutes)) + "</td>" +
          "<td>" + esc(fmtDate(lead.last_activity_at)) + "</td>" +
          '<td><span class="risk ' + riskClass + '">' + (risk.is_at_risk ? "à risque" : "normal") + "</span><div class='tiny'>" + esc(fmtHours(risk.hours_since_last_activity || 0)) + "</div></td>" +
          "<td>" + (lead.stage_auto ? '<span class="auto-badge">Auto-qualifié</span>' : "-") + "</td>" +
          '<td><button class="action detail-btn" type="button" data-show-details>Détails</button></td>' +
          "<td><textarea data-notes>" + esc(lead.internal_notes || "") + "</textarea></td>" +
          "<td>" +
            (lead.recommended_stage ? '<button class="action" type="button" data-apply-reco>Appliquer</button>' : "") +
            '<button class="action" type="button" data-classify style="margin-top:6px;">Classifier avec IA</button>' +
            
          "</td>" +
        "</tr>";
      }).join("");
      closeProductPopover();
      renderLeadList(sidebarLeadSource());
      if (!skipConversationLoad) void loadConversationForLead(selectedLeadId);
      updateSidePanelState();
    }

    async function loadAll() {
      statusLineEl.textContent = "Loading...";
      productParsingOk = true;
      setDebugLine("Loaded leads: ... | parsing products pending");
      hideErrorBanner();
      renderSkeletonRows();
      try {
        const leadsUrl = "/api/whatsapp/leads?range=" + selectedDays +
          (selectedStage !== "ALL" ? ("&stage=" + encodeURIComponent(selectedStage)) : "") +
          (qs ? "&" + q.toString() : "");
        const [leadsRes, metricsRes, topLeadsRes] = await Promise.allSettled([
          fetchJson(leadsUrl),
          fetchJson("/api/whatsapp/metrics?range=" + selectedDays + (qs ? "&" + q.toString() : "")),
          fetchJson("/api/whatsapp/top-leads?range=" + selectedDays + "&limit=40" + (qs ? "&" + q.toString() : ""))
        ]);

        if (leadsRes.status !== "fulfilled") {
          throw leadsRes.reason;
        }

        const leadsData = leadsRes.value;
        const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : null;
        const topLeads = topLeadsRes.status === "fulfilled" ? topLeadsRes.value : null;

        console.log("[whatsapp] leads response", leadsData);
        if (metricsRes.status === "fulfilled") {
          console.log("[whatsapp] metrics response", metrics);
        } else {
          console.warn("[whatsapp] metrics load failed", metricsRes.reason);
        }
        if (topLeadsRes.status === "fulfilled") {
          console.log("[whatsapp] top-leads response", topLeads);
        } else {
          console.warn("[whatsapp] top-leads load failed", topLeadsRes.reason);
        }

        topLeadScoreMap = new Map((Array.isArray(topLeads && topLeads.items) ? topLeads.items : []).map((item) => [item.id, item]));
        topLeadItems = Array.isArray(topLeads && topLeads.items) ? topLeads.items : [];
        if (metrics) {
          renderKpis(metrics);
          renderPipeline(metrics);
        } else {
          renderKpis({});
          renderPipeline({});
        }
        renderPriorities(topLeadItems);
        allLeads = Array.isArray(leadsData.items) ? leadsData.items : [];
        lastLeadsSignature = signatureForLeadItems(allLeads);
        await loadProductPreviewsForLeads(allLeads);
        applyLeadFiltersAndRender();
        setDebugLine("Loaded leads: " + allLeads.length + " | parsing products " + (productParsingOk ? "ok" : "failed"));
        if (metricsRes.status !== "fulfilled" || topLeadsRes.status !== "fulfilled") {
          const softFailures = [];
          if (metricsRes.status !== "fulfilled") softFailures.push("metrics");
          if (topLeadsRes.status !== "fulfilled") softFailures.push("top-leads");
          showErrorBanner("Partial load: " + softFailures.join(", ") + " failed, leads still displayed.");
        }
        if (!Array.isArray(leadsData.items) || !leadsData.items.length) {
	          statusLineEl.textContent = "Aucun lead reçu pour la période.";
	        } else {
	          statusLineEl.textContent = "Chargé: " + leadsData.items.length + " lead(s)";
	        }
	      } catch (_error) {
	        const err = _error;
          setDebugLine("Loaded leads: 0 | parsing products " + (productParsingOk ? "ok" : "failed") + " | api error");
	        statusLineEl.textContent = "Erreur API. Vérifie le backend/DB.";
	        showErrorBanner(formatError(err));
        leadRowsEl.innerHTML = '<tr><td colspan="13"><div class="empty-state">Données indisponibles.</div></td></tr>';
          allLeads = [];
          lastLeadsSignature = "";
          leadMessages = [];
          leadQuotes = [];
          leadTimelineEvents = [];
          renderLeadList([]);
          updateConversationHeader(null);
          renderConversationMessages([]);
          renderPriorities([]);
          updateSidePanelState();
	      }
	    }

    if (quickFilterBarEl) {
      quickFilterBarEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("button[data-filter]");
        if (!(btn instanceof HTMLButtonElement)) return;
        activeQuickFilter = String(btn.getAttribute("data-filter") || "ALL").toUpperCase();
        quickFilterBarEl.querySelectorAll("button[data-filter]").forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        applyLeadFiltersAndRender();
      });
    }

    if (leadsSearchInputEl instanceof HTMLInputElement) {
      leadsSearchInputEl.addEventListener("input", () => {
        searchQuery = leadsSearchInputEl.value || "";
        applyLeadFiltersAndRender();
      });
    }

    function rerenderLeadSidebar() {
      const source = sidebarLeadSource();
      renderLeadList(source);
    }

    if (waLeadFiltersEl) {
      waLeadFiltersEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("button[data-wa-filter]");
        if (!(btn instanceof HTMLButtonElement)) return;
        leadSidebarFilter = String(btn.getAttribute("data-wa-filter") || "all").toLowerCase();
        waLeadFiltersEl.querySelectorAll("button[data-wa-filter]").forEach((el) => {
          if (!(el instanceof HTMLElement)) return;
          el.classList.toggle("is-active", el === btn);
        });
        leadSidebarKeyboardIndex = 0;
        rerenderLeadSidebar();
      });
    }

    if (leadSearchEl instanceof HTMLInputElement) {
      leadSearchEl.addEventListener("input", () => {
        if (leadSidebarSearchTimer != null) {
          clearTimeout(leadSidebarSearchTimer);
          leadSidebarSearchTimer = null;
        }
        leadSidebarSearchTimer = setTimeout(() => {
          leadSidebarSearch = leadSearchEl.value || "";
          leadSidebarKeyboardIndex = 0;
          rerenderLeadSidebar();
        }, 150);
      });
    }

    if (leadListEl) {
      leadListEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const row = target.closest(".wa-row[data-lead-id]");
        if (!(row instanceof HTMLElement)) return;
        const leadId = String(row.getAttribute("data-lead-id") || "");
        if (!leadId) return;
        void selectLead(leadId);
      });
    }

    function handleSidebarKeyboard(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const insideSidebar = target.closest(".wa-left");
      if (!insideSidebar) return;
      if (!leadSidebarVisibleIds.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        leadSidebarKeyboardIndex = Math.min(leadSidebarVisibleIds.length - 1, leadSidebarKeyboardIndex + 1);
        rerenderLeadSidebar();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        leadSidebarKeyboardIndex = Math.max(0, leadSidebarKeyboardIndex - 1);
        rerenderLeadSidebar();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const idx = leadSidebarKeyboardIndex >= 0 ? leadSidebarKeyboardIndex : 0;
        const leadId = leadSidebarVisibleIds[idx] || "";
        if (leadId) void selectLead(leadId);
      }
    }

    if (leadSearchEl instanceof HTMLInputElement) {
      leadSearchEl.addEventListener("keydown", handleSidebarKeyboard);
    }
    if (leadListEl) {
      leadListEl.addEventListener("keydown", handleSidebarKeyboard);
    }

    document.getElementById("rangeToggle").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest("button[data-days]");
      if (!(btn instanceof HTMLElement)) return;
      const days = Number(btn.getAttribute("data-days") || "30");
      selectedDays = days === 7 ? 7 : 30;
      document.querySelectorAll("#rangeToggle button").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
      void loadAll();
    });

    pipelineEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const card = target.closest(".stage[data-stage]");
      if (!(card instanceof HTMLElement)) return;
      const stage = card.getAttribute("data-stage") || "ALL";
      selectedStage = selectedStage === stage ? "ALL" : stage;
      void loadAll();
    });

    leadRowsEl.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest("tr[data-id]");
      if (!(row instanceof HTMLElement)) return;
      const leadId = row.getAttribute("data-id") || "";
      if (!leadId) return;

      if (target.matches("select[data-stage-select]")) {
        const stage = target.value;
        const notesEl = row.querySelector("textarea[data-notes]");
        const internalNotes = notesEl instanceof HTMLTextAreaElement ? notesEl.value : "";
        await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + qs, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, internalNotes })
        });
        statusLineEl.textContent = "Lead updated";
        void loadAll();
      }
    });

    leadRowsEl.addEventListener("blur", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches("textarea[data-notes]")) return;
      const row = target.closest("tr[data-id]");
      if (!(row instanceof HTMLElement)) return;
      const leadId = row.getAttribute("data-id") || "";
      const stageEl = row.querySelector("select[data-stage-select]");
      const stage = stageEl instanceof HTMLSelectElement ? stageEl.value : "NEW";
      await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + qs, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, internalNotes: target.value })
      });
      statusLineEl.textContent = "Notes saved";
    }, true);

    leadRowsEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const productMoreBtn = target.closest("[data-product-more]");
      if (productMoreBtn instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const raw = String(productMoreBtn.getAttribute("data-product-more") || "");
        const handles = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
        openProductPopover(handles, productMoreBtn);
        return;
      }
      const productLink = target.closest("[data-product-open]");
      if (productLink instanceof HTMLAnchorElement) {
        closeProductPopover();
        return;
      }
      const clickedRow = target.closest("tr[data-id]");
      if (clickedRow instanceof HTMLElement) {
        const clickedLeadId = clickedRow.getAttribute("data-id") || "";
        if (clickedLeadId && selectedLeadId !== clickedLeadId) {
          void selectLead(clickedLeadId);
          console.log("[whatsapp] selected lead id", clickedLeadId);
        }
      }
      const emptyNewBtn = target.closest("button[data-empty-new]");
      const emptySeedBtn = target.closest("button[data-empty-seed]");
      if (emptyNewBtn instanceof HTMLElement) {
        logClicked("Empty New Lead");
        if (quickCreatePanelEl) quickCreatePanelEl.classList.add("open");
        return;
      }
      if (emptySeedBtn instanceof HTMLElement) {
        logClicked("Seed demo leads");
        try {
          const seeded = await fetchJson("/api/whatsapp/dev/seed" + qs, { method: "POST" });
          console.log("[whatsapp] seed result", seeded);
          statusLineEl.textContent = "Demo leads seeded";
          void loadAll();
        } catch (error) {
          showErrorBanner(formatError(error));
        }
        return;
      }
      const btn = target.closest("button[data-followup]");
      const applyRecoBtn = target.closest("button[data-apply-reco]");
      const classifyBtn = target.closest("button[data-classify]");
      const detailBtn = target.closest("button[data-show-details]");
      if (!(btn instanceof HTMLElement) && !(applyRecoBtn instanceof HTMLElement) && !(classifyBtn instanceof HTMLElement) && !(detailBtn instanceof HTMLElement)) return;
      const actionEl = (btn || applyRecoBtn || classifyBtn || detailBtn);
      if (!(actionEl instanceof HTMLElement)) return;
      const row = actionEl.closest("tr[data-id]");
      if (!(row instanceof HTMLElement)) return;
      const leadId = row.getAttribute("data-id") || "";
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) return;
      console.log("[whatsapp] selected lead id", leadId);

      if (detailBtn instanceof HTMLElement) {
        logClicked("Details");
        openLeadDrawer(lead);
        return;
      }

      if (applyRecoBtn instanceof HTMLElement) {
        logClicked("Apply Stage");
        if (!lead.recommended_stage) return;
        await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + qs, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: lead.recommended_stage,
            internalNotes: lead.internal_notes || "",
            stageAuto: false,
            stageAutoReason: lead.recommended_reason || "Manual apply from recommendation"
          })
        });
        statusLineEl.textContent = "Recommended stage applied";
        void loadAll();
        return;
      }

      if (classifyBtn instanceof HTMLElement) {
        logClicked("Classify with AI");
        await classifyLeadById(leadId);
        updateSidePanelState();
        return;
      }

      logClicked("Generate Follow-Up");
      await generateFollowUpByLeadId(leadId);
      updateSidePanelState();
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (productPopoverEl && productPopoverEl.contains(target)) return;
      if (target instanceof Element && target.closest("[data-product-more]")) return;
      closeProductPopover();
    });
    window.addEventListener("resize", () => closeProductPopover());
    window.addEventListener("scroll", () => closeProductPopover(), { passive: true });

    applyClassificationBtnEl.addEventListener("click", async () => {
      logClicked("Apply Stage (Panel)");
      if (!lastClassification || !lastClassification.leadId || !lastClassification.recommendedStage) return;
      const lead = leads.find((item) => item.id === lastClassification.leadId);
      const notes = lead ? (lead.internal_notes || "") : "";
      try {
        await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lastClassification.leadId) + qs, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: lastClassification.recommendedStage,
            internalNotes: notes,
            stageAuto: false,
            stageAutoReason: "Manual apply from AI classification"
          })
        });
        statusLineEl.textContent = "AI recommended stage applied";
        void loadAll();
        updateSidePanelState();
      } catch (error) {
        showErrorBanner(formatError(error));
        updateSidePanelState();
      }
    });

    classifySelectedBtnEl.addEventListener("click", async () => {
      logClicked("Classify with AI (Panel)");
      const lead = selectedLead();
      if (!lead) {
        showErrorBanner("Aucun lead sélectionné.");
        return;
      }
      await classifyLeadById(lead.id);
      updateSidePanelState();
    });

    if (strategicAdvisorBtnEl instanceof HTMLElement) {
      strategicAdvisorBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        if (!lead) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        advisorBoxEl.textContent = "Running Strategic Advisor...";
        statusLineEl.textContent = "Strategic Advisor running...";
        try {
          const payload = await fetchJson(
            "/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/strategic-advisor" + qs,
            { method: "POST" }
          );
          advisorBoxEl.textContent = String(payload.advisory || "No advisory returned.");
          statusLineEl.textContent = "Strategic Advisor ready (" + String(payload.provider || "-") + ")";
        } catch (error) {
          advisorBoxEl.textContent = "Unable to generate advisory right now.";
          showErrorBanner(formatError(error));
          statusLineEl.textContent = "Strategic Advisor unavailable";
        }
      });
    }

    if (conversationReclassifyBtnEl instanceof HTMLButtonElement) {
      conversationReclassifyBtnEl.addEventListener("click", async () => {
        logClicked("Re-classify (Conversation Header)");
        const lead = selectedLead();
        if (!lead) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        await classifyLeadById(lead.id);
        updateSidePanelState();
      });
    }

    if (conversationCopyLeadIdBtnEl instanceof HTMLButtonElement) {
      conversationCopyLeadIdBtnEl.addEventListener("click", async () => {
        logClicked("Copy Lead ID (Conversation Header)");
        const lead = selectedLead();
        if (!lead || !lead.id) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        try {
          await navigator.clipboard.writeText(String(lead.id));
          statusLineEl.textContent = "Lead ID copied";
        } catch {
          statusLineEl.textContent = "Clipboard unavailable";
        }
      });
    }

    if (conversationToggleTestBtnEl instanceof HTMLButtonElement) {
      conversationToggleTestBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        if (!lead || !lead.id) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        const nextIsTest = !Boolean(lead.is_test);
        const nextTag = nextIsTest ? "manual_ui" : null;
        const prevLabel = conversationToggleTestBtnEl.textContent || "Mark as test";
        conversationToggleTestBtnEl.disabled = true;
        conversationToggleTestBtnEl.textContent = "Saving...";
        try {
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/test-flag" + qs, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_test: nextIsTest, test_tag: nextTag })
          });
          lead.is_test = nextIsTest;
          lead.test_tag = nextTag;
          statusLineEl.textContent = nextIsTest ? "Lead marqué en test" : "Lead retiré des tests";
          updateConversationHeader(lead);
          updateSidePanelState();
          await loadTestLeadsDevTools();
        } catch (error) {
          showErrorBanner(formatError(error));
        } finally {
          conversationToggleTestBtnEl.disabled = false;
          if (conversationToggleTestBtnEl.textContent === "Saving...") {
            conversationToggleTestBtnEl.textContent = prevLabel;
          }
          updateSidePanelState();
        }
      });
    }

    if (generateFollowupSelectedBtnEl) {
      generateFollowupSelectedBtnEl.addEventListener("click", async () => {
        logClicked("Generate Follow-Up (Panel)");
        const lead = selectedLead();
        if (!lead) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        await generateFollowUpByLeadId(lead.id);
        updateSidePanelState();
      });
    }

    copyNextQuestionBtnEl.addEventListener("click", async () => {
      logClicked("Copy Next Question");
      if (!lastClassification || !lastClassification.nextQuestion) return;
      try {
        await navigator.clipboard.writeText(String(lastClassification.nextQuestion));
        statusLineEl.textContent = "Next question copied";
      } catch {
        statusLineEl.textContent = "Clipboard unavailable";
      }
      updateSidePanelState();
    });

    if (copyFollowupBtnEl && followupBoxEl) {
      copyFollowupBtnEl.addEventListener("click", async () => {
        logClicked("Copy Follow-Up");
        try {
          await navigator.clipboard.writeText(followupBoxEl.textContent || "");
          statusLineEl.textContent = "Follow-up copied";
        } catch {
          statusLineEl.textContent = "Clipboard unavailable";
        }
        updateSidePanelState();
      });
    }

    if (quickMarkPriceBtnEl) {
      quickMarkPriceBtnEl.addEventListener("click", async () => {
        logClicked("Quick Mark Price Sent");
        const lead = selectedLead();
        if (!lead) return;
        try {
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + qs, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              stage: lead.stage || "NEW",
              internalNotes: lead.internal_notes || "",
              priceSent: true
            })
          });
          statusLineEl.textContent = "Prix marqué comme envoyé";
          await loadAll();
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (postConfirmQuickActionsEl) {
      postConfirmQuickActionsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("[data-post-confirm]");
        if (!(btn instanceof HTMLElement)) return;
        const lead = selectedLead();
        if (!lead || !(conversationTextEl instanceof HTMLTextAreaElement)) return;
        const action = String(btn.getAttribute("data-post-confirm") || "");
        const messageByAction = {
          deposit_link: "Parfait. Je peux vous envoyer le lien d’acompte sécurisé pour bloquer votre créneau: [lien acompte]",
          rib: "Très bien. Voici les coordonnées RIB/virement pour l’acompte: [RIB / IBAN].",
          measures: "Parfait. Pour finaliser, pourriez-vous me partager vos mesures (taille, poitrine, taille, hanches) ?"
        };
        const text = messageByAction[action] || "";
        if (!text) return;
        conversationTextEl.value = text;
        conversationTextEl.focus();
        statusLineEl.textContent = "Action prête: " + action;
      });
    }

    if (conversationStageActionsEl) {
      conversationStageActionsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("[data-target-stage]");
        if (!(btn instanceof HTMLElement)) return;
        const stage = String(btn.getAttribute("data-target-stage") || "").toUpperCase();
        if (!stage) return;
        logClicked("Stage Message " + stage);
        await suggestReplyForTargetStage(stage);
      });
    }

    if (composerModelButtonsEl) {
      composerModelButtonsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("[data-model-key]");
        if (!(btn instanceof HTMLElement)) return;
        const lead = selectedLead();
        if (!lead) return;
        const lang = preferredComposerLanguage(lead);
        const modelType = String(btn.getAttribute("data-model-type") || "");
        if (modelType === "preset_qualification") {
          if (conversationTextEl instanceof HTMLTextAreaElement) {
            conversationTextEl.value = lang === "EN"
              ? "Thank you for your message. To guide you precisely, could you confirm the date of your event and the delivery city/country?"
              : "Merci pour votre message. Pour vous guider précisément, pourriez-vous me confirmer la date de votre événement et la ville/pays de livraison ?";
            conversationTextEl.focus();
            statusLineEl.textContent = "Modèle qualification prêt";
          }
          return;
        }
        if (modelType === "send_approved_quote") {
          await sendApprovedQuoteForLead(lead);
          return;
        }
        if (modelType === "preset_video_slot") {
          if (conversationTextEl instanceof HTMLTextAreaElement) {
            conversationTextEl.value = lang === "EN"
              ? "Perfect. I can offer you a private video call tomorrow at 11:00 or 16:30. Which time works best for you?"
              : "Parfait. Je peux vous proposer une visio privée demain à 11h00 ou 16h30, quel créneau vous convient ?";
            conversationTextEl.focus();
            statusLineEl.textContent = "Modèle visio prêt";
          }
          return;
        }
        if (modelType === "preset_followup_adapted") {
          if (conversationTextEl instanceof HTMLTextAreaElement) {
            const stage = String(lead && lead.stage ? lead.stage : "").toUpperCase();
            const eventDate = eventDateLabelFromLeadByLanguage(lead, lang);
            let text = "";
            if (lang === "EN") {
              if (stage === "NEW" || stage === "QUALIFICATION_PENDING") {
                text = "Just following up on your request. To move forward smoothly, could you confirm your event date?";
              } else if (stage === "QUALIFIED" || stage === "PRICE_SENT" || stage === "VIDEO_PROPOSED") {
                text = "Quick follow-up on your request for " + eventDate + ". If you'd like, I can send the next step now and secure your slot.";
              } else if (stage === "DEPOSIT_PENDING") {
                text = "Friendly reminder: once the deposit is completed, I can confirm everything immediately and lock your production slot.";
              } else if (stage === "CONFIRMED") {
                text = "Quick check-in: would you like me to send the payment finalization and measurement steps now?";
              } else {
                text = "Quick follow-up on your request. I’m available to confirm the next step whenever you’re ready.";
              }
            } else {
              if (stage === "NEW" || stage === "QUALIFICATION_PENDING") {
                text = "Petite relance sur votre demande. Pour avancer correctement, pouvez-vous me confirmer la date de votre événement ?";
              } else if (stage === "QUALIFIED" || stage === "PRICE_SENT" || stage === "VIDEO_PROPOSED") {
                text = "Petite relance concernant votre demande pour " + eventDate + ". Si vous souhaitez, je peux vous envoyer la prochaine étape maintenant et bloquer votre créneau.";
              } else if (stage === "DEPOSIT_PENDING") {
                text = "Petit rappel: dès validation de l’acompte, je vous confirme immédiatement la suite et je sécurise votre créneau de confection.";
              } else if (stage === "CONFIRMED") {
                text = "Petite relance: souhaitez-vous que je vous envoie maintenant la finalisation du paiement et les étapes de prise de mesures ?";
              } else {
                text = "Petite relance sur votre demande. Je reste disponible pour confirmer la prochaine étape dès que vous êtes prêt(e).";
              }
            }
            conversationTextEl.value = text;
            conversationTextEl.focus();
            statusLineEl.textContent = "Relance adaptée prête";
          }
          return;
        }
        if (modelType === "preset_price_only") {
          if (conversationTextEl instanceof HTMLTextAreaElement) {
            const eventDate = eventDateLabelFromLeadByLanguage(lead, lang);
            conversationTextEl.value = lang === "EN"
              ? "Perfect, we are on schedule for " + eventDate + ". The price is [price], with an estimated production time of [production time]."
              : "Parfait, nous sommes dans les délais pour " + eventDate + ". Le prix est de [prix] avec un délai de confection de [délai].";
            conversationTextEl.focus();
            statusLineEl.textContent = "Modèle prix prêt";
          }
          return;
        }
        if (modelType === "template") {
          const templateName = String(btn.getAttribute("data-template-name") || "").trim();
          if (!templateName) return;
          try {
            await sendTemplateForLead(lead, templateName, lang === "EN" ? "en" : "fr", []);
            statusLineEl.textContent = "Template envoyé: " + templateName;
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }
        if (modelType === "preset_price_video") {
          const templateText = priceSentTemplateForLead(lead, lang);
          if (conversationTextEl instanceof HTMLTextAreaElement) {
            conversationTextEl.value = templateText;
            conversationTextEl.focus();
            statusLineEl.textContent = "Modèle prix + visio prêt";
          }
          return;
        }
        const stage = String(btn.getAttribute("data-target-stage") || "").toUpperCase();
        if (!stage) return;
        await suggestReplyForTargetStage(stage);
      });
    }

    if (conversationPanelEl) {
      conversationPanelEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const productBtn = target.closest("[data-product-idx]");
        if (!(productBtn instanceof HTMLElement)) return;
        const idx = Number(productBtn.getAttribute("data-product-idx") || "-1");
        if (!Number.isFinite(idx) || idx < 0) return;
        await openProductModalByIndex(idx);
      });
    }

    if (productModalCloseBtnEl) {
      productModalCloseBtnEl.addEventListener("click", () => closeProductModal());
    }
    if (productModalBackdropEl) {
      productModalBackdropEl.addEventListener("click", (event) => {
        if (event.target === productModalBackdropEl) closeProductModal();
      });
    }

    if (conversationSuggestReplyBtnEl) {
      conversationSuggestReplyBtnEl.addEventListener("click", async () => {
        logClicked("Suggest Reply");
        const leadId = currentLeadId();
        setSugOpen(true, leadId, { userInitiatedOpen: true });
        await suggestReplyForSelectedLead();
      });
    }

    if (conversationGenerateAiSuggestionsBtnEl) {
      conversationGenerateAiSuggestionsBtnEl.addEventListener("click", async () => {
        logClicked("Generate AI Suggestions");
        const lead = selectedLead();
        if (!lead || !lead.id) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        if (isSharedLeadClient(lead)) {
          showErrorBanner("Numéro partagé: génération IA indisponible.");
          return;
        }
        if (!selectedLeadHasInboundMessage()) {
          showErrorBanner("Aucun message entrant. La suggestion exige au moins un message client.");
          return;
        }
        setSugOpen(true, lead.id, { userInitiatedOpen: true });
        statusLineEl.textContent = "Génération IA de 3 suggestions...";
        try {
          const payload = await fetchJson("/api/ai/suggestions" + qs, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leadId: lead.id, maxMessages: 20 })
          });
          const list = Array.isArray(payload && payload.suggestions) ? payload.suggestions : [];
          const cards = list.slice(0, 3).map((item, idx) => {
            const id = String(item && item.id ? item.id : "ai_" + String(idx + 1));
            const goal = String(item && item.goal ? item.goal : "QUALIFY");
            const text = String(item && item.text ? item.text : "");
            const rationale = String(item && item.rationale ? item.rationale : "");
            const confidence = Number(item && item.confidence != null ? item.confidence : 0);
            const lang = String(item && item.language ? item.language : "fr").toUpperCase();
            const stageTarget = String(
              item && item.metadata && item.metadata.stage_target ? item.metadata.stage_target : (lead.stage || "NEW")
            );
            const fieldsToCapture = Array.isArray(item && item.metadata && item.metadata.fields_to_capture)
              ? item.metadata.fields_to_capture.map((x) => String(x || "").trim()).filter(Boolean)
              : [];
            return {
              id,
              title: goal + " · AI/" + lang,
              text,
              reason: rationale,
              priority: confidence,
              debug: {
                source: "ai_personal_suggestions",
                stage_target: stageTarget,
                should_send_price: Boolean(item && item.should_send_price),
                requires_human_review: Boolean(item && item.requires_human_review),
                fields_to_capture: fieldsToCapture
              }
            };
          });
          renderSuggestionCards(cards);
          if (suggestionContextNoteEl) {
            suggestionContextNoteEl.textContent = "Suggestions IA personnalisées générées via contexte lead + messages.";
          }
          statusLineEl.textContent = "3 suggestions IA prêtes";
        } catch (error) {
          showErrorBanner(formatError(error));
          statusLineEl.textContent = "Échec génération suggestions IA";
        }
      });
    }

    if (suggestionTemplateOptionsEl) {
      suggestionTemplateOptionsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const templateBtn = target.closest("[data-template-name]");
        if (templateBtn instanceof HTMLElement) {
          const lead = selectedLead();
          if (!lead) return;
          const templateName = String(templateBtn.getAttribute("data-template-name") || "").trim();
          const templateLanguage = String(templateBtn.getAttribute("data-template-language") || "fr").trim();
          if (!templateName) return;
          try {
            await sendTemplateForLead(lead, templateName, templateLanguage, []);
            statusLineEl.textContent = "Template " + templateName + " envoyé";
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }
        const quick = target.closest("[data-quick-template]");
        if (!(quick instanceof HTMLElement)) return;
        const key = String(quick.getAttribute("data-quick-template") || "");
        const lead = selectedLead();
        if (!lead || !(conversationTextEl instanceof HTMLTextAreaElement)) return;
        if (key === "price_sent") return;
      });
    }

    if (suggestionCardsEl) {
      suggestionCardsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const dbgBtn = target.closest("[data-dbg-toggle]");
        if (dbgBtn instanceof HTMLElement) {
          const id = String(dbgBtn.getAttribute("data-dbg-toggle") || "").trim();
          if (!id) return;
          const panel = document.getElementById("dbg-" + id);
          if (!panel) return;
          const open = panel.style.display !== "none";
          panel.style.display = open ? "none" : "block";
          return;
        }
        const showAllBtn = target.closest("[data-sug-show-all]");
        if (showAllBtn instanceof HTMLElement) {
          suggestionShowAll = true;
          renderSuggestionCards(currentSuggestionCards);
          return;
        }
        const expandBtn = target.closest("[data-expand]");
        if (expandBtn instanceof HTMLElement) {
          const cardId = String(expandBtn.getAttribute("data-expand") || "").trim();
          if (!cardId) return;
          if (suggestionExpandedIds.has(cardId)) suggestionExpandedIds.delete(cardId);
          else suggestionExpandedIds.add(cardId);
          renderSuggestionCards(currentSuggestionCards);
          return;
        }
        const sendApprovedBtn = target.closest("[data-send-approved-quote]");
        if (sendApprovedBtn instanceof HTMLElement) {
          const lead = selectedLead();
          if (!lead) return;
          await sendApprovedQuoteForLead(lead);
          return;
        }
        const sendApprovedEditBtn = target.closest("[data-send-approved-quote-edit]");
        if (sendApprovedEditBtn instanceof HTMLElement) {
          if (!(conversationTextEl instanceof HTMLTextAreaElement)) return;
          const lead = selectedLead();
          const detected = lead && lead.detected_signals && typeof lead.detected_signals === "object" ? lead.detected_signals : {};
          const qa = detected && detected.quote_approval && typeof detected.quote_approval === "object" ? detected.quote_approval : {};
          const price = qa && qa.price && typeof qa.price === "object" ? qa.price : {};
          const amt = Number(price && price.approved_amount != null ? price.approved_amount : 0);
          const curr = String(price && price.approved_currency ? price.approved_currency : "MAD").toUpperCase();
          if (Number.isFinite(amt) && amt > 0) {
            conversationTextEl.value = "Prix validé: " + String(Math.round(amt)) + " " + curr;
            conversationTextEl.focus();
            statusLineEl.textContent = "Modifiez puis envoyez manuellement.";
          }
          return;
        }
        const insertBtn = target.closest("[data-suggestion-insert]");
        if (!(insertBtn instanceof HTMLElement)) return;
        const cardId = String(insertBtn.getAttribute("data-suggestion-insert") || "").trim();
        if (!cardId) return;
        await insertSuggestionCardById(cardId);
      });
    }

    if (aiCardsRefreshBtnEl instanceof HTMLButtonElement) {
      aiCardsRefreshBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        if (!lead) return;
        await loadAiLatestForLead(lead.id);
        await loadAiFlowForLead(lead.id, { silent: true });
      });
    }

    if (aiCardsToggleBtnEl instanceof HTMLButtonElement) {
      aiCardsToggleBtnEl.addEventListener("click", () => {
        setAiCardsOpen(!aiCardsOpen);
      });
    }

    if (aiProviderSelectEl instanceof HTMLSelectElement) {
      aiProviderSelectEl.addEventListener("change", () => {
        setAiAdvisorProvider(aiProviderSelectEl.value);
      });
    }

    if (aiAnalyzeBtnEl instanceof HTMLButtonElement) {
      aiAnalyzeBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        if (!lead) return;
        const leadId = String(lead.id || "").trim();
        if (!leadId) return;
        const provider = resolveAiAdvisorProvider(aiAdvisorProvider);
        aiAnalyzeLoading = true;
        renderAiCards();
        try {
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-regenerate" + qs, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider })
          });
          await loadAiLatestForLead(leadId, { silent: true });
          await loadAiFlowForLead(leadId, { silent: true });
          showToast("AI analyzed (" + provider.toUpperCase() + ")");
        } catch (error) {
          showErrorBanner(formatError(error));
        } finally {
          aiAnalyzeLoading = false;
          renderAiCards();
        }
      });
    }

    if (aiTabsEl) {
      aiTabsEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const tabBtn = target.closest("[data-ai-tab]");
        if (!(tabBtn instanceof HTMLElement)) return;
        const tab = String(tabBtn.getAttribute("data-ai-tab") || "cards");
        setAiActiveTab(tab);
      });
    }

    if (aiCardsListEl) {
      aiCardsListEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const lead = selectedLead();
        if (!lead) return;

        const expandBtn = target.closest("[data-ai-expand]");
        if (expandBtn instanceof HTMLElement) {
          const id = String(expandBtn.getAttribute("data-ai-expand") || "").trim();
          if (!id) return;
          const textEl = aiCardsListEl.querySelector('[data-ai-text="' + id.replace(/"/g, '\\"') + '"]');
          if (!(textEl instanceof HTMLElement)) return;
          const expanded = textEl.classList.toggle("expanded");
          expandBtn.textContent = expanded ? "Collapse" : "Expand";
          return;
        }

        const whyBtn = target.closest("[data-ai-why]");
        if (whyBtn instanceof HTMLElement) {
          const id = String(whyBtn.getAttribute("data-ai-why") || "").trim();
          if (!id) return;
          setAiInsightSelectedSuggestionId(lead.id, id);
          openAiInsightDrawer(id);
          return;
        }

        const insertBtn = target.closest("[data-ai-insert]");
        if (insertBtn instanceof HTMLElement) {
          const id = String(insertBtn.getAttribute("data-ai-insert") || "").trim();
          const suggestion = getAiSuggestionById(id);
          if (!suggestion) return;
          const merged = getAiSuggestionMessages(suggestion).join("\\n\\n");
          const applied = applySuggestionToComposer(merged, false);
          if (applied) {
            statusLineEl.textContent = "Suggestion inserted";
            await logAiUsage(String(lead.id || ""), String(currentAiLatest && currentAiLatest.runId ? currentAiLatest.runId : ""), id, "insert");
          }
          return;
        }

        const bubbleInsertBtn = target.closest("[data-ai-bubble-insert]");
        if (bubbleInsertBtn instanceof HTMLElement) {
          const id = String(bubbleInsertBtn.getAttribute("data-ai-bubble-insert") || "").trim();
          const index = Math.round(Number(bubbleInsertBtn.getAttribute("data-ai-bubble-index")));
          const suggestion = getAiSuggestionById(id);
          if (!suggestion || !Number.isFinite(index)) return;
          const bubbles = getAiSuggestionMessages(suggestion);
          const text = String(bubbles[index] || "").trim();
          if (!text) return;
          const applied = applySuggestionToComposer(text, false);
          if (applied) {
            statusLineEl.textContent = "Bubble inserted";
            await logAiUsage(String(lead.id || ""), String(currentAiLatest && currentAiLatest.runId ? currentAiLatest.runId : ""), id, "insert");
          }
          return;
        }

        const useCloseBtn = target.closest("[data-ai-use-close]");
        if (useCloseBtn instanceof HTMLElement) {
          const id = String(useCloseBtn.getAttribute("data-ai-use-close") || "").trim();
          const suggestion = getAiSuggestionById(id);
          if (!suggestion) return;
          const merged = getAiSuggestionMessages(suggestion).join("\\n\\n");
          const applied = applySuggestionToComposer(merged, true);
          if (applied) {
            statusLineEl.textContent = "Suggestion inserted";
            await logAiUsage(String(lead.id || ""), String(currentAiLatest && currentAiLatest.runId ? currentAiLatest.runId : ""), id, "insert");
          }
          return;
        }

        const retrySendBtn = target.closest("[data-ai-retry-send]");
        if (retrySendBtn instanceof HTMLElement) {
          const id = String(retrySendBtn.getAttribute("data-ai-retry-send") || "").trim();
          const failedIndex = Math.max(0, Math.round(Number(aiCardFailedIndexMap[id] || 0)));
          await sendAiSuggestionNow(id, failedIndex, undefined);
          return;
        }

        const bubbleSendBtn = target.closest("[data-ai-bubble-send]");
        if (bubbleSendBtn instanceof HTMLElement) {
          const id = String(bubbleSendBtn.getAttribute("data-ai-bubble-send") || "").trim();
          const index = Math.round(Number(bubbleSendBtn.getAttribute("data-ai-bubble-index")));
          if (!Number.isFinite(index) || index < 0) return;
          await sendAiSuggestionNow(id, index, index);
          return;
        }

        const sendBtn = target.closest("[data-ai-send]");
        if (sendBtn instanceof HTMLElement) {
          const id = String(sendBtn.getAttribute("data-ai-send") || "").trim();
          await sendAiSuggestionNow(id, 0, undefined);
        }
      });
    }

    if (aiInsightDrawerContentEl) {
      aiInsightDrawerContentEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const copyBtn = target.closest("[data-ai-copy-runid]");
        if (copyBtn instanceof HTMLElement) {
          const runId = String(currentAiLatest && currentAiLatest.runId ? currentAiLatest.runId : "").trim();
          if (!runId) return;
          try {
            await navigator.clipboard.writeText(runId);
            showToast("Run ID copied");
          } catch {
            showToast(runId);
          }
          return;
        }
        const refreshBtn = target.closest("[data-ai-refresh-insight]");
        if (refreshBtn instanceof HTMLElement) {
          const lead = selectedLead();
          if (!lead) return;
          await loadAiLatestForLead(String(lead.id || ""));
        }
      });
    }

    if (aiInsightDrawerCloseBtnEl) {
      aiInsightDrawerCloseBtnEl.addEventListener("click", () => closeAiInsightDrawer());
    }
    if (aiInsightDrawerBackdropEl) {
      aiInsightDrawerBackdropEl.addEventListener("click", (event) => {
        if (event.target === aiInsightDrawerBackdropEl) closeAiInsightDrawer();
      });
    }

    if (agentRunsListEl) {
      agentRunsListEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const row = target.closest("[data-ai-run-id]");
        if (!(row instanceof HTMLElement)) return;
        aiSelectedRunId = String(row.getAttribute("data-ai-run-id") || "").trim();
        renderAgentFlow();
      });
    }

    if (agentRetryBtnEl instanceof HTMLButtonElement) {
      agentRetryBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        if (!lead) return;
        const leadId = String(lead.id || "").trim();
        if (!leadId) return;
        const provider = resolveAiAdvisorProvider(aiAdvisorProvider);
        agentRetryBtnEl.disabled = true;
        agentRetryBtnEl.textContent = "Retrying...";
        try {
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(leadId) + "/ai-retry" + qs, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider })
          });
          await loadAiLatestForLead(leadId, { silent: true });
          await loadAiFlowForLead(leadId, { silent: true });
          showToast("Agent run retriggered (" + provider.toUpperCase() + ")");
        } catch (error) {
          showErrorBanner(formatError(error));
        } finally {
          agentRetryBtnEl.disabled = false;
          agentRetryBtnEl.textContent = "Retry run";
        }
      });
    }

    if (sugToggleEl instanceof HTMLButtonElement) {
      sugToggleEl.addEventListener("click", () => {
        const leadId = currentLeadId();
        setSugOpen(!suggestionPanelOpen, leadId, { userInitiatedOpen: true });
      });
    }

    if (conversationMessagesEl) {
      let lastScrollTop = conversationMessagesEl.scrollTop;
      conversationMessagesEl.addEventListener("scroll", () => {
        const leadId = currentLeadId();
        if (!leadId) return;
        const dy = Math.abs(conversationMessagesEl.scrollTop - lastScrollTop);
        lastScrollTop = conversationMessagesEl.scrollTop;
        if (dy < 10) return;
        if (!suggestionPanelOpen) return;
        if (sugAutoCollapsedMap[leadId]) return;
        setSugOpen(false, leadId);
        sugAutoCollapsedMap[leadId] = true;
      }, { passive: true });
      conversationMessagesEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const ctaBtn = target.closest(".msg-template-cta-btn");
        if (ctaBtn instanceof HTMLElement) {
          const payload = String(ctaBtn.getAttribute("data-cta-payload") || "").trim();
          if (payload) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(payload).then(() => showToast("CTA copié")).catch(() => showToast("CTA: " + payload));
            } else {
              showToast("CTA: " + payload);
            }
          }
          return;
        }
        const sourceBtn = target.closest("[data-scroll-source-message]");
        if (!(sourceBtn instanceof HTMLElement)) return;
        const messageId = String(sourceBtn.getAttribute("data-scroll-source-message") || "").trim();
        if (messageId) scrollToMessageById(messageId);
      });
    }

    if (leadDebugToggleBtnEl) {
      leadDebugToggleBtnEl.addEventListener("click", async () => {
        leadDebugOpen = !leadDebugOpen;
        renderLeadDebugPanel();
        const lead = selectedLead();
        if (leadDebugOpen && lead && lead.id) {
          await loadLeadDebugProof(String(lead.id));
        }
      });
    }

    if (openTemplatesBtnEl) {
      openTemplatesBtnEl.addEventListener("click", async () => {
        logClicked("Open Templates");
        const leadId = currentLeadId();
        setSugOpen(true, leadId, { userInitiatedOpen: true });
        if (!selectedLead()) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        openTemplateModal();
        await loadTemplatesForModal();
      });
    }

    if (templateModalCloseBtnEl) {
      templateModalCloseBtnEl.addEventListener("click", () => closeTemplateModal());
    }
    if (templateModalBackdropEl) {
      templateModalBackdropEl.addEventListener("click", (event) => {
        if (event.target === templateModalBackdropEl) closeTemplateModal();
      });
    }
    if (templateSearchInputEl instanceof HTMLInputElement) {
      templateSearchInputEl.addEventListener("input", () => applyTemplateFilters());
    }
    if (templateTabsEl) {
      templateTabsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const tab = target.closest("[data-tab-category]");
        if (!(tab instanceof HTMLElement)) return;
        templateCategoryTab = String(tab.getAttribute("data-tab-category") || "UTILITY").toUpperCase();
        Array.from(templateTabsEl.querySelectorAll(".template-tab")).forEach((node) => {
          node.classList.toggle("active", node === tab);
        });
        await loadTemplatesForModal();
      });
    }
    if (templateFavoritesOnlyBtnEl instanceof HTMLButtonElement) {
      templateFavoritesOnlyBtnEl.addEventListener("click", () => {
        templateFavoritesOnly = !templateFavoritesOnly;
        templateFavoritesOnlyBtnEl.classList.toggle("active", templateFavoritesOnly);
        templateFavoritesOnlyBtnEl.textContent = templateFavoritesOnly ? "★ Favoris only" : "★ Favoris";
        applyTemplateFilters();
      });
    }
    if (templateListEl) {
      templateListEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const favBtn = target.closest("[data-template-favorite]");
        if (favBtn instanceof HTMLElement) {
          event.stopPropagation();
          const tplName = String(favBtn.getAttribute("data-template-favorite") || "");
          if (!tplName) return;
          const isFav = templateFavorites.has(tplName);
          try {
            if (isFav) {
              await fetchJson("/api/whatsapp/templates/favorites/" + encodeURIComponent(tplName) + qs, { method: "DELETE" });
              templateFavorites.delete(tplName);
            } else {
              await fetchJson("/api/whatsapp/templates/favorites" + qs, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateName: tplName })
              });
              templateFavorites.add(tplName);
            }
            applyTemplateFilters();
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }
        const item = target.closest("[data-template-id]");
        if (!(item instanceof HTMLElement)) return;
        selectedTemplateId = String(item.getAttribute("data-template-id") || "");
        renderTemplatesList(filteredTemplates);
      });
    }
    if (templateMarkOptInBtnEl instanceof HTMLButtonElement) {
      templateMarkOptInBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        if (!lead) return;
        try {
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/marketing-opt-in" + qs, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ marketing_opt_in: true, source: "manual" })
          });
          lead.marketing_opt_in = true;
          lead.marketing_opt_in_source = "manual";
          lead.marketing_opt_in_at = new Date().toISOString();
          showToast("Opt-in marketing activé.");
          renderTemplatesList(filteredTemplates);
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }
    if (templateSendBtnEl) {
      templateSendBtnEl.addEventListener("click", async () => {
        const lead = selectedLead();
        const template = selectedTemplate();
        if (!lead || !template) {
          showErrorBanner("Template ou lead manquant.");
          return;
        }
        if (String(template.category || "").toUpperCase() === "MARKETING" && !lead.marketing_opt_in) {
          showErrorBanner("Opt-in requis pour envoyer un message marketing.");
          return;
        }
        const varInputs = templateVariablesEl
          ? Array.from(templateVariablesEl.querySelectorAll("input[data-var-index]"))
          : [];
        const variables = varInputs.map((input) => String(input.value || "").trim());
        templateSendBtnEl.disabled = true;
        templateSendBtnEl.innerHTML = "<span class='spinner'></span>Envoi...";
        try {
          await sendTemplateForLead(lead, String(template.name || ""), String(template.language || "fr"), variables);
          closeTemplateModal();
        } catch (error) {
          showErrorBanner(formatError(error));
        } finally {
          templateSendBtnEl.disabled = false;
          templateSendBtnEl.textContent = "Envoyer template";
        }
      });
    }

    if (saveClientContextNotesBtnEl) {
      saveClientContextNotesBtnEl.addEventListener("click", async () => {
        logClicked("Save Context Notes");
        const lead = selectedLead();
        if (!lead) return;
        const notes = clientContextNotesEl instanceof HTMLTextAreaElement ? clientContextNotesEl.value : "";
        try {
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + qs, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              stage: lead.stage || "NEW",
              internalNotes: notes
            })
          });
          statusLineEl.textContent = "Notes enregistrées";
          lead.internal_notes = notes;
          updateConversationHeader(lead);
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (clientContextMetaEl) {
      clientContextMetaEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const lead = selectedLead();
        if (!lead) return;

        const copyPhone = target.closest("[data-copy-phone]");
        if (copyPhone instanceof HTMLElement) {
          const phone = String(lead.phone || "").trim();
          if (!phone) return;
          try {
            await navigator.clipboard.writeText(phone);
            statusLineEl.textContent = "Téléphone copié";
          } catch {
            statusLineEl.textContent = "Clipboard unavailable";
          }
          return;
        }

        const sourceBtn = target.closest("[data-scroll-source-message]");
        if (sourceBtn instanceof HTMLElement) {
          const messageId = String(sourceBtn.getAttribute("data-scroll-source-message") || "").trim();
          if (messageId) scrollToMessageById(messageId);
          return;
        }

        const editBtn = target.closest("[data-edit-event-date]");
        if (editBtn instanceof HTMLElement) {
          const card = editBtn.closest(".context-item");
          if (!(card instanceof HTMLElement)) return;
          const editor = card.querySelector(".event-date-editor");
          if (editor instanceof HTMLElement) editor.classList.toggle("open");
          return;
        }

        const editDestinationBtn = target.closest("[data-edit-destination]");
        if (editDestinationBtn instanceof HTMLElement) {
          const card = editDestinationBtn.closest(".context-item");
          if (!(card instanceof HTMLElement)) return;
          const editor = card.querySelector(".destination-editor");
          if (editor instanceof HTMLElement) editor.classList.toggle("open");
          return;
        }

        const saveBtn = target.closest("[data-save-event-date]");
        if (saveBtn instanceof HTMLElement) {
          const card = saveBtn.closest(".context-item");
          const input = card ? card.querySelector("[data-event-date-input]") : null;
          const value = input instanceof HTMLInputElement ? (input.value || null) : null;
          try {
            await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/event-date" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event_date: value })
            });
            lead.event_date = value;
            lead.event_date_manual = true;
            lead.event_date_updated_at = new Date().toISOString();
            if (value && !lead.event_date_confidence) lead.event_date_confidence = 95;
            updateConversationHeader(lead);
            statusLineEl.textContent = "Date souhaitée enregistrée";
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }

        const clearBtn = target.closest("[data-clear-event-date]");
        if (clearBtn instanceof HTMLElement) {
          try {
            await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/event-date" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event_date: null })
            });
            lead.event_date = null;
            lead.event_date_manual = true;
            lead.event_date_confidence = null;
            lead.event_date_text = null;
            lead.event_date_source_message_id = null;
            updateConversationHeader(lead);
            statusLineEl.textContent = "Date souhaitée effacée";
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }

        const recalcBtn = target.closest("[data-recalc-event-date]");
        if (recalcBtn instanceof HTMLElement) {
          try {
            const payload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/recalculate-signals" + qs, {
              method: "POST"
            });
            if (payload && payload.extracted && payload.extracted.event_date && payload.extracted.event_date.date) {
              lead.event_date = payload.extracted.event_date.date;
              lead.event_date_text = payload.extracted.event_date.raw;
              lead.event_date_confidence = payload.extracted.event_date.confidence;
              lead.event_date_source_message_id = payload.extracted.event_date.sourceMessageId;
              lead.event_date_manual = false;
              lead.event_date_updated_at = new Date().toISOString();
            } else {
              lead.event_date_manual = false;
            }
            if (payload && payload.extracted && payload.extracted.destination) {
              const dst = payload.extracted.destination;
              lead.ship_city = dst.ship_city;
              lead.ship_region = dst.ship_region;
              lead.ship_country = dst.ship_country;
              lead.ship_destination_text = dst.raw;
              lead.ship_destination_confidence = dst.confidence;
              lead.ship_destination_source_message_id = dst.sourceMessageId;
              lead.ship_destination_manual = false;
              lead.ship_destination_updated_at = new Date().toISOString();
            }
            updateConversationHeader(lead);
            statusLineEl.textContent = "Recalcul signaux terminé";
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }

        const saveDestinationBtn = target.closest("[data-save-destination]");
        if (saveDestinationBtn instanceof HTMLElement) {
          const card = saveDestinationBtn.closest(".context-item");
          if (!(card instanceof HTMLElement)) return;
          const cityInput = card.querySelector("[data-destination-city]");
          const regionInput = card.querySelector("[data-destination-region]");
          const countryInput = card.querySelector("[data-destination-country]");
          const rawInput = card.querySelector("[data-destination-raw]");
          const ship_city = cityInput instanceof HTMLInputElement ? cityInput.value.trim() : "";
          const ship_region = regionInput instanceof HTMLInputElement ? regionInput.value.trim() : "";
          const ship_country = countryInput instanceof HTMLInputElement ? countryInput.value.trim() : "";
          const ship_destination_text = rawInput instanceof HTMLInputElement ? rawInput.value.trim() : "";
          try {
            await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/destination" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ship_city: ship_city || null,
                ship_region: ship_region || null,
                ship_country: ship_country || null,
                ship_destination_text: ship_destination_text || null
              })
            });
            lead.ship_city = ship_city || null;
            lead.ship_region = ship_region || null;
            lead.ship_country = ship_country || null;
            lead.ship_destination_text = ship_destination_text || null;
            lead.ship_destination_manual = true;
            lead.ship_destination_updated_at = new Date().toISOString();
            if ((ship_city || ship_region || ship_country || ship_destination_text) && !lead.ship_destination_confidence) {
              lead.ship_destination_confidence = 95;
            }
            updateConversationHeader(lead);
            showToast("Destination enregistrée.");
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }

        const clearDestinationBtn = target.closest("[data-clear-destination]");
        if (clearDestinationBtn instanceof HTMLElement) {
          try {
            await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/destination" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ship_city: null,
                ship_region: null,
                ship_country: null,
                ship_destination_text: null
              })
            });
            lead.ship_city = null;
            lead.ship_region = null;
            lead.ship_country = null;
            lead.ship_destination_text = null;
            lead.ship_destination_confidence = null;
            lead.ship_destination_source_message_id = null;
            lead.ship_destination_manual = true;
            lead.ship_destination_updated_at = new Date().toISOString();
            updateConversationHeader(lead);
            showToast("Destination effacée.");
          } catch (error) {
            showErrorBanner(formatError(error));
          }
        }
      });
    }

    if (addClassificationDraftBtnEl) {
      addClassificationDraftBtnEl.addEventListener("click", async () => {
        logClicked("Add Classification Draft");
        if (!lastClassification || !lastClassification.nextQuestion) return;
        try {
          await appendConversationDraft(String(lastClassification.nextQuestion || ""));
          statusLineEl.textContent = "Brouillon classification ajouté à la conversation";
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (addFollowupDraftBtnEl) {
      addFollowupDraftBtnEl.addEventListener("click", async () => {
        logClicked("Add Follow-Up Draft");
        const text = String(followupBoxEl && followupBoxEl.textContent ? followupBoxEl.textContent : "").trim();
        if (!text || text.startsWith("Sélectionne") || text.startsWith("Unable")) return;
        try {
          await appendConversationDraft(text);
          statusLineEl.textContent = "Relance ajoutée à la conversation (brouillon OUT)";
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (conversationFormEl) {
      conversationFormEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        const lead = selectedLead();
        if (!lead) {
          showErrorBanner("Aucun lead sélectionné.");
          return;
        }
        if (isSharedLeadClient(lead)) {
          showErrorBanner("Shared number (no API): sending is disabled. Use copy suggestion.");
          return;
        }
        if (!isSessionOpen) {
          showErrorBanner("Session expirée — utilisez un template.");
          return;
        }
        const text = conversationTextEl instanceof HTMLTextAreaElement ? conversationTextEl.value.trim() : "";
        const messageType =
          conversationMessageTypeEl instanceof HTMLSelectElement
            ? (String(conversationMessageTypeEl.value || "text").toLowerCase() === "template" ? "template" : "text")
            : "text";
        if (!text) return;
        try {
          const feedback = pendingSuggestionFeedback && pendingSuggestionFeedback.id
            ? {
                id: String(pendingSuggestionFeedback.id),
                source: String(pendingSuggestionFeedback.source || "manual"),
                suggestion_type: String(pendingSuggestionFeedback.suggestion_type || ""),
                suggested_text: String(pendingSuggestionFeedback.suggested_text || ""),
                accepted:
                  String((pendingSuggestionFeedback.suggested_text || "").trim()).toLowerCase() ===
                  String((text || "").trim()).toLowerCase()
              }
            : undefined;
          await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(lead.id) + "/messages" + qs, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              direction: "OUT",
              text,
              provider: "manual",
              message_type: messageType,
              send_whatsapp: true,
              suggestion_feedback: feedback
            })
          });
          if (conversationTextEl instanceof HTMLTextAreaElement) conversationTextEl.value = "";
          pendingSuggestionFeedback = null;
          await loadConversationForLead(lead.id);
          void loadSuggestionReviewItems();
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (conversationTextEl instanceof HTMLTextAreaElement) {
      conversationTextEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (conversationFormEl instanceof HTMLFormElement) {
            conversationFormEl.requestSubmit();
          }
        }
      });
    }

    if (conversationSubmitIconBtnEl instanceof HTMLButtonElement) {
      conversationSubmitIconBtnEl.addEventListener("click", () => {
        if (conversationSubmitIconBtnEl.disabled) return;
        if (conversationFormEl instanceof HTMLFormElement) conversationFormEl.requestSubmit();
      });
    }

    drawerCloseBtnEl.addEventListener("click", () => closeLeadDrawer());
    drawerBackdropEl.addEventListener("click", (event) => {
      if (event.target === drawerBackdropEl) closeLeadDrawer();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (aiInsightDrawerOpen) {
        closeAiInsightDrawer();
        return;
      }
      if (drawerBackdropEl && drawerBackdropEl.classList.contains("open")) {
        closeLeadDrawer();
      }
    });
    copyDrawerQuestionBtnEl.addEventListener("click", async () => {
      logClicked("Copy Drawer Question");
      const text = String(drawerAiQuestionEl.textContent || "").trim();
      if (!text || text === "Aucune suggestion IA disponible.") return;
      try {
        await navigator.clipboard.writeText(text);
        statusLineEl.textContent = "Question IA copiée";
      } catch {
        statusLineEl.textContent = "Clipboard unavailable";
      }
    });
    loadRecentMessagesBtnEl.addEventListener("click", async () => {
      logClicked("Load Recent Messages");
      if (!activeDrawerLeadId) return;
      drawerRecentMessagesEl.innerHTML = "<li class='tiny'>Chargement...</li>";
      try {
        const payload = await fetchJson("/api/whatsapp/leads/" + encodeURIComponent(activeDrawerLeadId) + "/messages?limit=8" + (qs ? "&" + q.toString() : ""));
        const items = (Array.isArray(payload.items) ? payload.items : [])
          .slice()
          .sort((a, b) => new Date(String(b.created_at || "")).getTime() - new Date(String(a.created_at || "")).getTime());
        drawerRecentMessagesEl.innerHTML = items.length
          ? items
              .map((item) => "<li><strong>" + esc(item.direction || "-") + "</strong> · " + esc(fmtDate(item.created_at)) + "<br/>" + esc(item.text || "") + "</li>")
              .join("")
          : "<li class='tiny'>Aucun message récent.</li>";
      } catch (_error) {
        drawerRecentMessagesEl.innerHTML = "<li class='tiny'>Impossible de charger les messages.</li>";
      }
    });

    async function runCreateLeadFlow() {
      const client = newLeadClientEl instanceof HTMLInputElement ? newLeadClientEl.value.trim() : "";
      const phone = newLeadPhoneEl instanceof HTMLInputElement ? newLeadPhoneEl.value.trim() : "";
      const country = newLeadCountryEl instanceof HTMLInputElement ? newLeadCountryEl.value.trim() : "";
      const product = newLeadProductEl instanceof HTMLInputElement ? newLeadProductEl.value.trim() : "";
      const inquirySource = newLeadSourceEl instanceof HTMLInputElement ? (newLeadSourceEl.value.trim() || "Manual") : "Manual";
      if (!client || !phone) {
        statusLineEl.textContent = "Client et téléphone sont requis.";
        return;
      }
      try {
        await fetchJson("/api/whatsapp/leads" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client, phone, country, product, inquiry_source: inquirySource })
        });
        statusLineEl.textContent = "Lead créé";
        if (newLeadClientEl instanceof HTMLInputElement) newLeadClientEl.value = "";
        if (newLeadPhoneEl instanceof HTMLInputElement) newLeadPhoneEl.value = "";
        if (newLeadCountryEl instanceof HTMLInputElement) newLeadCountryEl.value = "";
        if (newLeadProductEl instanceof HTMLInputElement) newLeadProductEl.value = "";
        if (quickCreatePanelEl) quickCreatePanelEl.classList.remove("open");
        void loadAll();
      } catch (_error) {
        statusLineEl.textContent = "Impossible de créer le lead.";
      }
    }

    function updateSharedManualCount() {
      if (!sharedManualCountEl) return;
      sharedManualCountEl.textContent = "Manual messages: " + String(sharedImportManualMessages.length);
    }

    function resetSharedImportForm() {
      sharedImportManualMessages = [];
      updateSharedManualCount();
      if (sharedClientEl instanceof HTMLInputElement) sharedClientEl.value = "";
      if (sharedPhoneEl instanceof HTMLInputElement) sharedPhoneEl.value = "";
      if (sharedCountryEl instanceof HTMLInputElement) sharedCountryEl.value = "";
      if (sharedProductEl instanceof HTMLInputElement) sharedProductEl.value = "";
      if (sharedRawTextEl instanceof HTMLTextAreaElement) sharedRawTextEl.value = "";
      if (sharedManualTextEl instanceof HTMLInputElement) sharedManualTextEl.value = "";
      if (sharedFileInputEl instanceof HTMLInputElement) sharedFileInputEl.value = "";
    }

    async function runSharedImportFlow() {
      const clientName = sharedClientEl instanceof HTMLInputElement ? sharedClientEl.value.trim() : "";
      const phoneNumber = sharedPhoneEl instanceof HTMLInputElement ? sharedPhoneEl.value.trim() : "";
      const body = {
        client_name: clientName,
        phone_number: phoneNumber,
        country: sharedCountryEl instanceof HTMLInputElement ? (sharedCountryEl.value.trim() || null) : null,
        product_reference: sharedProductEl instanceof HTMLInputElement ? (sharedProductEl.value.trim() || null) : null,
        raw_text: sharedRawTextEl instanceof HTMLTextAreaElement ? sharedRawTextEl.value : "",
        imported_by: sharedImportedByEl instanceof HTMLInputElement ? (sharedImportedByEl.value.trim() || "admin") : "admin",
        owner_labels:
          sharedOwnerLabelsEl instanceof HTMLInputElement
            ? sharedOwnerLabelsEl.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : [],
        messages: sharedImportManualMessages
      };
      if (!body.raw_text.trim() && !body.messages.length) {
        showErrorBanner("Ajoute du texte exporté ou au moins un message manuel.");
        return;
      }
      if (sharedImportSubmitBtnEl instanceof HTMLButtonElement) {
        sharedImportSubmitBtnEl.disabled = true;
        sharedImportSubmitBtnEl.textContent = "Import...";
      }
      try {
        const payload = await fetchJson("/api/whatsapp/shared-import" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        statusLineEl.textContent = "Import partagé terminé (" + String(payload.imported_messages || 0) + " messages).";
        if (sharedImportPanelEl) sharedImportPanelEl.classList.remove("open");
        resetSharedImportForm();
        await loadAll();
        if (payload && payload.conversation_id) {
          selectedLeadId = String(payload.conversation_id);
          applyLeadFiltersAndRender();
          await loadConversationForLead(selectedLeadId);
        }
      } catch (error) {
        showErrorBanner(formatError(error));
      } finally {
        if (sharedImportSubmitBtnEl instanceof HTMLButtonElement) {
          sharedImportSubmitBtnEl.disabled = false;
          sharedImportSubmitBtnEl.textContent = "Import & Analyze";
        }
      }
    }

    if (createLeadBtnEl) {
      createLeadBtnEl.addEventListener("click", () => {
        logClicked("New Lead");
        if (!quickCreatePanelEl) return;
        quickCreatePanelEl.classList.toggle("open");
      });
    }

    if (importSharedBtnEl) {
      importSharedBtnEl.addEventListener("click", () => {
        if (!sharedImportPanelEl) return;
        sharedImportPanelEl.classList.toggle("open");
        updateSharedManualCount();
      });
    }

    if (sharedImportCancelBtnEl) {
      sharedImportCancelBtnEl.addEventListener("click", () => {
        if (sharedImportPanelEl) sharedImportPanelEl.classList.remove("open");
      });
    }

    if (sharedAddManualBtnEl) {
      sharedAddManualBtnEl.addEventListener("click", () => {
        const text = sharedManualTextEl instanceof HTMLInputElement ? sharedManualTextEl.value.trim() : "";
        if (!text) return;
        const direction =
          sharedManualDirectionEl instanceof HTMLSelectElement && String(sharedManualDirectionEl.value).toUpperCase() === "OUT"
            ? "OUT"
            : "IN";
        sharedImportManualMessages.push({
          direction,
          text,
          created_at: new Date().toISOString()
        });
        if (sharedManualTextEl instanceof HTMLInputElement) sharedManualTextEl.value = "";
        updateSharedManualCount();
      });
    }

    if (sharedImportSubmitBtnEl) {
      sharedImportSubmitBtnEl.addEventListener("click", async () => {
        await runSharedImportFlow();
      });
    }

    if (sharedFileInputEl instanceof HTMLInputElement) {
      sharedFileInputEl.addEventListener("change", async () => {
        const file = sharedFileInputEl.files && sharedFileInputEl.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          if (sharedRawTextEl instanceof HTMLTextAreaElement) {
            sharedRawTextEl.value = text;
          }
          statusLineEl.textContent = "Fichier importé: " + file.name;
        } catch {
          showErrorBanner("Impossible de lire le fichier importé.");
        }
      });
    }

    if (syncWhatsappBtnEl) {
      syncWhatsappBtnEl.addEventListener("click", async () => {
        logClicked("Sync WhatsApp");
        const prev = syncWhatsappBtnEl.textContent || "Sync WhatsApp";
        syncWhatsappBtnEl.disabled = true;
        syncWhatsappBtnEl.textContent = "Sync...";
        try {
          const payload = await fetchJson("/api/whatsapp/sync" + qs, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ max_pages: 5 })
          });
          if (payload && payload.skipped && payload.reason === "history_url_missing") {
            statusLineEl.textContent = "Sync historique indisponible (ZOKO_HISTORY_API_URL manquant). Webhook temps réel actif.";
          } else {
            statusLineEl.textContent =
              "Sync OK · messages: " + String(payload.messagesImported || 0) +
              " · leads: " + String(payload.leadsUpserted || 0);
          }
          await loadAll();
          if (selectedLeadId) await loadConversationForLead(selectedLeadId);
        } catch (error) {
          showErrorBanner(formatError(error));
          statusLineEl.textContent = "Sync échouée";
        } finally {
          syncWhatsappBtnEl.disabled = false;
          syncWhatsappBtnEl.textContent = prev;
        }
      });
    }

    if (refreshTestLeadsBtnEl instanceof HTMLButtonElement) {
      refreshTestLeadsBtnEl.addEventListener("click", async () => {
        await loadTestLeadsDevTools();
      });
    }

    if (deleteAllTestLeadsBtnEl instanceof HTMLButtonElement) {
      deleteAllTestLeadsBtnEl.addEventListener("click", async () => {
        await promptDeleteAllTestLeads();
      });
    }

    if (testLeadsWrapEl) {
      testLeadsWrapEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("[data-delete-test-lead]");
        if (!(btn instanceof HTMLElement)) return;
        const leadId = String(btn.getAttribute("data-delete-test-lead") || "").trim();
        if (!leadId) return;
        await promptDeleteSingleTestLead(leadId);
      });
    }

    if (dangerCancelBtnEl instanceof HTMLButtonElement) {
      dangerCancelBtnEl.addEventListener("click", () => closeDangerModal());
    }
    if (dangerConfirmBackdropEl) {
      dangerConfirmBackdropEl.addEventListener("click", (event) => {
        if (event.target === dangerConfirmBackdropEl) closeDangerModal();
      });
    }
    if (dangerConfirmInputEl instanceof HTMLInputElement) {
      dangerConfirmInputEl.addEventListener("input", () => setDangerConfirmEnabled());
      dangerConfirmInputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !dangerConfirmBtnEl.disabled) {
          event.preventDefault();
          void executeDangerDelete();
        }
      });
    }
    if (dangerConfirmBtnEl instanceof HTMLButtonElement) {
      dangerConfirmBtnEl.addEventListener("click", async () => {
        await executeDangerDelete();
      });
    }

    if (saveLeadBtnEl) saveLeadBtnEl.addEventListener("click", () => { logClicked("Create Lead"); void runCreateLeadFlow(); });
    if (cancelLeadBtnEl) {
      cancelLeadBtnEl.addEventListener("click", () => {
        logClicked("Cancel New Lead");
        if (quickCreatePanelEl) quickCreatePanelEl.classList.remove("open");
      });
    }

    if (followupScenarioButtonsEl) {
      followupScenarioButtonsEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest("button[data-followup-type]");
        if (!(btn instanceof HTMLButtonElement)) return;
        const nextType = String(btn.getAttribute("data-followup-type") || "").trim();
        if (!nextType) return;
        selectedFollowUpType = nextType;
        followupScenarioButtonsEl
          .querySelectorAll("button[data-followup-type]")
          .forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        logClicked("Follow-Up Scenario: " + selectedFollowUpType);
      });
    }

    if (suggestionReviewRefreshBtnEl instanceof HTMLButtonElement) {
      suggestionReviewRefreshBtnEl.addEventListener("click", async () => {
        logClicked("Refresh Suggestion Review Queue");
        await loadSuggestionReviewItems();
      });
    }

    if (learningStatsRefreshBtnEl instanceof HTMLButtonElement) {
      learningStatsRefreshBtnEl.addEventListener("click", async () => {
        logClicked("Refresh Learning Stats");
        await loadLearningStats();
      });
    }

    if (learningSettingsSaveBtnEl instanceof HTMLButtonElement) {
      learningSettingsSaveBtnEl.addEventListener("click", async () => {
        logClicked("Save Learning Settings");
        try {
          const payload = readLearningSettingsFromForm();
          const saved = await fetchJson("/api/whatsapp/suggestions/learning-settings" + qs, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          applyLearningSettingsToForm(saved || null);
          statusLineEl.textContent = "Learning settings saved";
          await loadLearningStats();
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (learningSettingsResetBtnEl instanceof HTMLButtonElement) {
      learningSettingsResetBtnEl.addEventListener("click", async () => {
        logClicked("Reset Learning Settings");
        try {
          const payload = await fetchJson("/api/whatsapp/suggestions/learning-settings/reset" + qs, {
            method: "POST"
          });
          applyLearningSettingsToForm(payload || null);
          statusLineEl.textContent = "Learning settings reset";
          await loadLearningStats();
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

    if (learningSettingsRecomputeBtnEl instanceof HTMLButtonElement) {
      learningSettingsRecomputeBtnEl.addEventListener("click", async () => {
        logClicked("Recompute Learning");
        try {
          const payload = await fetchJson("/api/whatsapp/suggestions/learning-settings/recompute" + qs, {
            method: "POST"
          });
          statusLineEl.textContent = "Learning recompute done · types: " + String(payload && payload.recomputed_types ? payload.recomputed_types : 0);
          await loadLearningStats();
        } catch (error) {
          showErrorBanner(formatError(error));
        }
      });
    }

      if (suggestionReviewStatusFilterEl instanceof HTMLSelectElement) {
        suggestionReviewStatusFilterEl.addEventListener("change", async () => {
          await loadSuggestionReviewItems();
        });
      }

      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          void pollConversationTick();
          void pollLeadsTick();
        }
      });
      window.addEventListener("beforeunload", () => stopRealtimeConversationPolling());

    if (suggestionReviewListEl) {
      suggestionReviewListEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const card = target.closest("[data-suggestion-id]");
        if (!(card instanceof HTMLElement)) return;
        const id = String(card.getAttribute("data-suggestion-id") || "").trim();
        if (!id) return;

        const outcomeBtn = target.closest("[data-suggestion-outcome]");
        if (outcomeBtn instanceof HTMLElement) {
          const outcome = String(outcomeBtn.getAttribute("data-suggestion-outcome") || "").trim().toUpperCase();
          if (!outcome) return;
          try {
            await fetchJson("/api/whatsapp/suggestions/" + encodeURIComponent(id) + "/outcome" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ outcome })
            });
            showToast("Outcome enregistré");
            await loadSuggestionReviewItems();
          } catch (error) {
            showErrorBanner(formatError(error));
          }
          return;
        }

        const reviewBtn = target.closest("[data-suggestion-review]");
        if (reviewBtn instanceof HTMLElement) {
          const status = String(reviewBtn.getAttribute("data-suggestion-review") || "").trim().toUpperCase();
          if (!status) return;
          try {
            await fetchJson("/api/whatsapp/suggestions/" + encodeURIComponent(id) + "/review" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status })
            });
            showToast("Statut review mis à jour");
            await loadSuggestionReviewItems();
          } catch (error) {
            showErrorBanner(formatError(error));
          }
        }
      });
    }

	    document.getElementById("briefBtn").addEventListener("click", async () => {
	      logClicked("Generate Today's Brief");
	      briefBoxEl.textContent = "Génération du brief...";
      try {
        const brief = await fetchJson("/api/whatsapp/ai/brief" + qs, { method: "POST" });
        console.log("[whatsapp] brief result", brief);
        const actionItems = Array.isArray(brief.action_items) ? brief.action_items : [];
        briefBoxEl.textContent = [
          brief.summary || "",
          "",
	          "Insight:",
	          brief.insights || "",
	          "",
	          "Actions prioritaires:",
	          ...actionItems.map((item) => "- " + item)
	        ].join("\\n");
	      } catch (_error) {
	        briefBoxEl.textContent = "Impossible de générer le brief maintenant.";
	        showErrorBanner(formatError(_error));
	      }
        updateSidePanelState();
	    });

      if (aiSettingsFormEl instanceof HTMLFormElement) {
        aiSettingsFormEl.addEventListener("submit", async (event) => {
          event.preventDefault();
          const payload = {
            default_language: aiDefaultLanguageEl instanceof HTMLSelectElement ? aiDefaultLanguageEl.value : "AUTO",
            tone: aiToneEl instanceof HTMLSelectElement ? aiToneEl.value : "QUIET_LUXURY",
            message_length: aiMessageLengthEl instanceof HTMLSelectElement ? aiMessageLengthEl.value : "SHORT",
            include_price_policy: aiIncludePricePolicyEl instanceof HTMLSelectElement ? aiIncludePricePolicyEl.value : "AFTER_QUALIFIED",
            include_video_call: aiIncludeVideoCallEl instanceof HTMLSelectElement ? aiIncludeVideoCallEl.value : "WHEN_HIGH_INTENT",
            urgency_style: aiUrgencyStyleEl instanceof HTMLSelectElement ? aiUrgencyStyleEl.value : "SUBTLE",
            no_emojis: aiNoEmojisEl instanceof HTMLInputElement ? aiNoEmojisEl.checked : true,
            avoid_follow_up_phrase: aiAvoidFollowUpPhraseEl instanceof HTMLInputElement ? aiAvoidFollowUpPhraseEl.checked : true,
            signature_enabled: aiSignatureEnabledEl instanceof HTMLInputElement ? aiSignatureEnabledEl.checked : false,
            signature_text: aiSignatureTextEl instanceof HTMLInputElement ? aiSignatureTextEl.value : ""
          };
          try {
            const saved = await fetchJson("/api/ai/settings" + qs, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            console.log("[ai-settings] saved", saved);
            applyAiSettingsToForm(saved);
            statusLineEl.textContent = "Réglages IA enregistrés";
          } catch (error) {
            showErrorBanner(formatError(error));
            statusLineEl.textContent = "Impossible d'enregistrer les réglages IA";
          }
        });
      }

      updateSharedManualCount();
      updateSidePanelState();
      void loadTestLeadsDevTools();
      startRealtimeConversationPolling();
      void loadLearningSettings();
      void loadSuggestionReviewItems();
	    void loadAll();
  </script>
</body>
</html>`);
});

whatsappRouter.get("/whatsapp-intelligence/workflow", (req, res) => {
  const q = new URLSearchParams();
  const shop = String(req.query.shop || "").trim();
  const host = String(req.query.host || "").trim();
  if (shop) q.set("shop", shop);
  if (host) q.set("host", host);
  const navSuffix = q.toString() ? `?${q.toString()}` : "";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Intelligence – Manager Approval Flow</title>
  <style>
    :root{
      --bg:#05070b; --panel:#0f172a; --line:rgba(148,163,184,.18); --muted:#94a3b8; --text:#e2e8f0;
      --auto:#22c55e; --mgr:#f59e0b; --active:#60a5fa;
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text);
      background:radial-gradient(1200px 520px at -10% -20%, rgba(59,130,246,.18), transparent 55%),
      radial-gradient(800px 480px at 120% -20%, rgba(34,197,94,.12), transparent 58%),var(--bg);}
    .wrap{max-width:1380px;margin:0 auto;padding:22px 18px 70px}
    .nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
    .nav a{text-decoration:none;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:8px 10px;background:rgba(15,23,42,.56);font-size:12px}
    .nav a.current{color:#fff;border-color:rgba(96,165,250,.38);background:rgba(30,41,59,.85)}
    .title{font-size:30px;font-weight:700;letter-spacing:-.02em}
    .sub{margin-top:6px;color:var(--muted)}
    .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}
    .kpi{border:1px solid var(--line);background:linear-gradient(180deg,rgba(15,23,42,.78),rgba(2,6,23,.58));border-radius:14px;padding:12px}
    .kpi .label{font-size:12px;color:var(--muted);display:flex;justify-content:space-between}
    .live{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid rgba(96,165,250,.33);color:#bfdbfe}
    .kpi .value{margin-top:8px;font-size:34px;font-weight:700}
    .main{display:grid;grid-template-columns:minmax(0,7fr) minmax(300px,3fr);gap:14px;margin-top:14px}
    .panel{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(15,23,42,.8),rgba(2,6,23,.6));padding:14px}
    .stage-strip{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
    .stage-pill{font-size:10px;letter-spacing:.05em;padding:5px 8px;border-radius:999px;border:1px solid rgba(148,163,184,.2);color:var(--muted);background:rgba(2,6,23,.3)}
    .stage-pill.active{border-color:rgba(96,165,250,.52);color:#dbeafe;background:rgba(30,58,138,.32)}
    .canvas-wrap{overflow:auto;padding-bottom:8px}
    .flow-row{display:flex;align-items:stretch;min-width:1120px;gap:8px}
    .node{width:178px;flex:0 0 178px;border:1px solid rgba(148,163,184,.18);border-radius:14px;padding:10px;cursor:pointer;transition:.2s;background:rgba(15,23,42,.42);opacity:.62}
    .node:hover{opacity:.95}
    .node.active{opacity:1;border-color:rgba(96,165,250,.5);box-shadow:0 0 0 1px rgba(96,165,250,.38),0 8px 24px rgba(2,6,23,.45);animation:pulse 1.4s ease-in-out infinite}
    @keyframes pulse{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
    .node-ico{font-size:16px}
    .node h4{margin:7px 0 6px;font-size:12px;line-height:1.28}
    .badge{display:inline-flex;height:19px;align-items:center;padding:0 7px;border-radius:999px;font-size:10px;letter-spacing:.06em;border:1px solid var(--line)}
    .badge.auto{color:#bbf7d0;border-color:rgba(34,197,94,.35);background:rgba(22,101,52,.2)}
    .badge.mgr{color:#fde68a;border-color:rgba(245,158,11,.35);background:rgba(120,53,15,.22)}
    .node-out{margin-top:8px;font-size:11px;color:var(--muted);line-height:1.3}
    .arrow{width:26px;flex:0 0 26px;position:relative}
    .arrow:before{content:"";position:absolute;left:3px;right:10px;top:50%;height:2px;background:linear-gradient(90deg,rgba(96,165,250,.45),rgba(96,165,250,.12));transform:translateY(-1px)}
    .arrow:after{content:"";position:absolute;right:3px;top:50%;width:8px;height:8px;border-top:2px solid rgba(96,165,250,.5);border-right:2px solid rgba(96,165,250,.5);transform:translateY(-4px) rotate(45deg)}
    .inspector{position:sticky;top:14px}
    .inspector h3{margin:0;font-size:15px}
    .meta{margin-top:7px;color:var(--muted);font-size:12px}
    .kv{margin-top:10px;border:1px solid rgba(148,163,184,.16);border-radius:11px;padding:9px;background:rgba(2,6,23,.4)}
    .kv .k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
    .kv .v{font-size:13px;line-height:1.35;margin-top:4px}
    .tabs{display:flex;gap:6px;margin-top:12px}
    .tab{border:1px solid rgba(148,163,184,.2);background:rgba(15,23,42,.46);color:var(--muted);padding:7px 9px;border-radius:9px;font-size:12px;cursor:pointer}
    .tab.active{color:#fff;border-color:rgba(96,165,250,.45)}
    .tab-body{margin-top:9px}
    .stage-map{display:grid;grid-template-columns:1fr;gap:7px}
    .stage-row{border:1px solid rgba(148,163,184,.16);border-radius:10px;padding:8px;background:rgba(15,23,42,.35)}
    .stage-row .s{font-size:11px;font-weight:700}
    .stage-row .d{font-size:12px;color:var(--muted);margin-top:4px}
    .guarantees{margin-top:10px;display:grid;gap:7px}
    .g{font-size:12px;border:1px solid rgba(96,165,250,.2);color:#dbeafe;border-radius:10px;padding:8px;background:rgba(2,6,23,.4)}
    .links{margin-top:10px;display:flex;flex-wrap:wrap;gap:6px}
    .links a{text-decoration:none;color:#bfdbfe;border:1px solid rgba(96,165,250,.3);padding:6px 9px;border-radius:9px;font-size:12px}
    @media (max-width: 1080px){
      .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
      .main{grid-template-columns:1fr}
      .flow-row{min-width:0;flex-direction:column}
      .node{width:100%;flex:1}
      .arrow{width:100%;height:20px}
      .arrow:before{left:50%;right:auto;top:4px;width:2px;height:12px;transform:none}
      .arrow:after{left:50%;top:13px;right:auto;transform:translateX(-4px) rotate(135deg)}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <nav class="nav">
      <a href="/admin/whatsapp-intelligence${navSuffix}">Intelligence WhatsApp</a>
      <a href="/whatsapp/priority-inbox${navSuffix}">Priority Inbox</a>
      <a href="/admin/whatsapp-intelligence/settings${navSuffix}">Réglages</a>
      <a href="/whatsapp-intelligence/mobile-lab${navSuffix}">Mobile App</a>
      <a href="/whatsapp-logic-diagram${navSuffix}">Logic Diagram</a>
      <a class="current" href="/whatsapp-intelligence/workflow${navSuffix}">Manager Approval Flow</a>
    </nav>
    <div class="title">WhatsApp Intelligence – Manager Approval Flow</div>
    <div class="sub">Manager-in-the-loop pricing validation and controlled stage progression</div>

    <section class="kpis">
      <article class="kpi"><div class="label">Quote requests (7d) <span class="live">Live</span></div><div class="value" id="kpiQuoteReq">0</div></article>
      <article class="kpi"><div class="label">Pending manager <span class="live">Live</span></div><div class="value" id="kpiPending">0</div></article>
      <article class="kpi"><div class="label">Ready to send <span class="live">Live</span></div><div class="value" id="kpiReady">0</div></article>
      <article class="kpi"><div class="label">Sent today <span class="live">Live</span></div><div class="value" id="kpiSentToday">0</div></article>
    </section>

    <section class="main">
      <section class="panel">
        <div class="stage-strip" id="stageStrip"></div>
        <div class="canvas-wrap">
          <div class="flow-row" id="flowRow"></div>
        </div>
        <div class="guarantees">
          <div class="g">No client price auto-send.</div>
          <div class="g">Sur mesure default unless READY_PIECE.</div>
          <div class="g">Idempotency blocks duplicate send in 2 minutes.</div>
        </div>
      </section>

      <aside class="panel inspector">
        <h3 id="inspTitle">Step</h3>
        <div class="meta" id="inspMeta">Select a node to inspect details.</div>
        <div class="kv"><div class="k">Trigger</div><div class="v" id="inspTrigger"></div></div>
        <div class="kv"><div class="k">DB writes</div><div class="v" id="inspDb"></div></div>
        <div class="kv"><div class="k">Stage impact</div><div class="v" id="inspStage"></div></div>
        <div class="kv"><div class="k">Relevant code</div><div class="v" id="inspCode"></div></div>
        <div class="kv" id="inspButtonsWrap" style="display:none"><div class="k">Buttons</div><div class="v" id="inspButtons"></div></div>

        <div class="tabs">
          <button class="tab active" data-tab="details">Details</button>
          <button class="tab" data-tab="stages">Stage Mapping</button>
        </div>
        <div class="tab-body" id="tabDetails">
          <div class="meta">Automation vs manager gates reflected directly in node badges and stage strip highlight.</div>
        </div>
        <div class="tab-body" id="tabStages" style="display:none">
          <div class="stage-map">
            <div class="stage-row"><div class="s">NEW</div><div class="d">Incoming lead detected. System.</div></div>
            <div class="stage-row"><div class="s">QUALIFICATION_PENDING</div><div class="d">Missing date/destination/sizing. System.</div></div>
            <div class="stage-row"><div class="s">QUALIFIED</div><div class="d">Core qualification complete. System.</div></div>
            <div class="stage-row"><div class="s">PRICE_EDIT_REQUIRED</div><div class="d">Manager asked to edit price.</div></div>
            <div class="stage-row"><div class="s">PRICE_APPROVED_READY_TO_SEND</div><div class="d">Approved internally; waiting send.</div></div>
            <div class="stage-row"><div class="s">PRICE_SENT</div><div class="d">Client received price outbound.</div></div>
            <div class="stage-row"><div class="s">DEPOSIT_PENDING</div><div class="d">Deposit discussion/payment intent.</div></div>
            <div class="stage-row"><div class="s">CONFIRMED</div><div class="d">Client confirmation/payment checkpoint.</div></div>
            <div class="stage-row"><div class="s">CONVERTED</div><div class="d">Conversion completed.</div></div>
            <div class="stage-row"><div class="s">LOST</div><div class="d">Lead closed without conversion.</div></div>
          </div>
        </div>
        <div class="links">
          <a href="/admin/whatsapp-intelligence${navSuffix}">Open WA Intelligence</a>
          <a href="/whatsapp/priority-inbox${navSuffix}">Open Priority Inbox</a>
        </div>
      </aside>
    </section>
  </div>

  <script>
    const STAGES = ["NEW","QUALIFICATION_PENDING","QUALIFIED","PRICE_EDIT_REQUIRED","PRICE_APPROVED_READY_TO_SEND","PRICE_SENT","DEPOSIT_PENDING","CONFIRMED","CONVERTED","LOST"];
    const NODES = [
      { id:"n1", icon:"📩", title:"Inbound Persisted", gate:"AUTOMATED", output:"messages insert + lead upsert", trigger:"Zoko webhook -> persist inbound message", db:"whatsapp_lead_messages insert; lead existence ensured", stageImpact:"No forced stage change; analyzer recompute runs", code:"zokoWebhook.ts", stages:[] },
      { id:"n2", icon:"🔎", title:"Product Detected + Quote Request Created", gate:"AUTOMATED", output:"quote_requests insert (dedupe)", trigger:"Analyzer/post-persist hook", db:"quote_requests insert", stageImpact:"Still no PRICE_SENT", code:"quoteRequestService.ts", stages:[] },
      { id:"n3", icon:"🧮", title:"Suggested Price + Default Mode", gate:"AUTOMATED", output:"price options computed", trigger:"Product snapshot + pricing logic", db:"quote_requests.price_options updated", stageImpact:"No forced stage change", code:"quoteRequestService.ts", stages:[] },
      { id:"n4", icon:"📤", title:"Team Approval Request Sent", gate:"AUTOMATED", output:"internal team WhatsApp request", trigger:"quote_request created", db:"Outbound team message payload generated", stageImpact:"Waiting manager action", code:"quoteRequestService.ts", buttons:"💰 Valider prix suggéré · ✏️ Modifier prix · ⚡ Pièce prête", stages:[] },
      { id:"n5", icon:"🛡️", title:"Manager Decision", gate:"MANAGER GATE", output:"facts + quote_actions updated", trigger:"qa:<quoteRequestId>:APPROVE|EDIT|READY", db:"quote_actions insert + detected_signals.quote_approval update", stageImpact:"APPROVE -> PRICE_APPROVED_READY_TO_SEND; EDIT -> PRICE_EDIT_REQUIRED; READY -> production_mode READY_PIECE", code:"zokoWebhook.ts / quoteApprovalRepo.ts", buttons:"APPROVE · EDIT · READY", stages:["PRICE_EDIT_REQUIRED","PRICE_APPROVED_READY_TO_SEND"] },
      { id:"n6", icon:"✅", title:"Send To Client", gate:"MANAGER GATE", output:"outbound approved quote sent", trigger:"POST /api/leads/:leadId/send-approved-quote", db:"outbound message persisted + quote_actions SEND_TO_CLIENT audit", stageImpact:"Now stage progression can move to PRICE_SENT", code:"whatsappIntelligence.ts / mlMessageTracking.ts", stages:["PRICE_SENT"] },
      { id:"n7", icon:"📈", title:"Stage Progression Allowed", gate:"AUTOMATED", output:"PRICE_SENT path unlocked", trigger:"analyzer recompute after send", db:"lead flags + stage update logic", stageImpact:"PRICE_SENT and next stages follow normal rules", code:"conversationStageProgression.ts", stages:["PRICE_SENT"] }
    ];
    let selected = NODES[0].id;

    function renderStages(activeStages) {
      const el = document.getElementById("stageStrip");
      el.innerHTML = STAGES.map((s) => '<span class="stage-pill' + (activeStages.includes(s) ? ' active' : '') + '">' + s + '</span>').join("");
    }

    function renderInspector(node) {
      document.getElementById("inspTitle").textContent = node.title;
      document.getElementById("inspMeta").textContent = node.gate;
      document.getElementById("inspTrigger").textContent = node.trigger;
      document.getElementById("inspDb").textContent = node.db;
      document.getElementById("inspStage").textContent = node.stageImpact;
      document.getElementById("inspCode").textContent = node.code;
      const w = document.getElementById("inspButtonsWrap");
      const b = document.getElementById("inspButtons");
      if (node.buttons) { w.style.display = ""; b.textContent = node.buttons; } else { w.style.display = "none"; b.textContent = ""; }
      renderStages(node.stages || []);
    }

    function renderFlow() {
      const row = document.getElementById("flowRow");
      row.innerHTML = NODES.map((node, i) => {
        const badgeCls = node.gate === "MANAGER GATE" ? "mgr" : "auto";
        const nodeHtml =
          '<article class="node' + (selected === node.id ? ' active' : '') + '" data-node-id="' + node.id + '">' +
            '<div class="node-ico">' + node.icon + '</div>' +
            '<h4>' + node.title + '</h4>' +
            '<span class="badge ' + badgeCls + '">' + node.gate + '</span>' +
            '<div class="node-out">' + node.output + '</div>' +
          '</article>';
        if (i === NODES.length - 1) return nodeHtml;
        return nodeHtml + '<div class="arrow"></div>';
      }).join("");

      row.querySelectorAll("[data-node-id]").forEach((item) => {
        item.addEventListener("click", () => {
          selected = item.getAttribute("data-node-id");
          const node = NODES.find((n) => n.id === selected) || NODES[0];
          renderFlow();
          renderInspector(node);
        });
      });
    }

    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.getAttribute("data-tab");
        document.getElementById("tabDetails").style.display = tab === "details" ? "" : "none";
        document.getElementById("tabStages").style.display = tab === "stages" ? "" : "none";
      });
    });

    async function loadMetrics() {
      try {
        const res = await fetch("/api/workflow/quote-approval/metrics");
        if (!res.ok) throw new Error("metrics_fetch_failed");
        const data = await res.json();
        document.getElementById("kpiQuoteReq").textContent = String(data.quoteRequests7d || 0);
        document.getElementById("kpiPending").textContent = String(data.pendingManager || 0);
        document.getElementById("kpiReady").textContent = String(data.readyToSend || 0);
        document.getElementById("kpiSentToday").textContent = String(data.sentToday || 0);
      } catch (error) {
        console.warn("[workflow-page] metrics unavailable", error);
      }
    }

    renderFlow();
    renderInspector(NODES[0]);
    loadMetrics();
    setInterval(loadMetrics, 30000);
  </script>
</body>
</html>`);
});

whatsappRouter.get("/whatsapp/priority-inbox", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Priority Inbox – WhatsApp Intelligence</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    :root {
      --bg-primary: #000000;
      --bg-secondary: #0a0a0a;
      --bg-card: rgba(18, 18, 18, 0.85);
      --bg-card-hover: rgba(25, 25, 25, 0.95);
      --border-subtle: rgba(255, 255, 255, 0.06);
      --border-medium: rgba(255, 255, 255, 0.1);
      --text-primary: rgba(255, 255, 255, 0.95);
      --text-secondary: rgba(255, 255, 255, 0.6);
      --text-tertiary: rgba(255, 255, 255, 0.4);
      --accent-p0: #ff3b30;
      --accent-p1: #ff9500;
      --accent-p2: #ffcc00;
      --accent-success: #34c759;
      --glass-bg: rgba(18, 18, 18, 0.7);
      --glass-border: rgba(255, 255, 255, 0.08);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      overflow-x: hidden;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 24px;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-bottom: 1px solid var(--border-subtle);
      padding: 20px 0;
    }
    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .back-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      text-decoration: none;
    }
    .back-btn:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-medium);
      color: var(--text-primary);
      transform: translateX(-2px);
    }
    .title-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .page-title {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .page-subtitle {
      font-size: 13px;
      color: var(--text-tertiary);
      font-weight: 400;
    }
    .count-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 28px;
      padding: 0 10px;
      border-radius: 8px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .search-bar {
      flex: 1;
      max-width: 400px;
      position: relative;
    }
    .search-input {
      width: 100%;
      height: 40px;
      padding: 0 16px 0 40px;
      border-radius: 12px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      color: var(--text-primary);
      font-size: 14px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .search-input:focus {
      outline: none;
      background: var(--bg-card);
      border-color: var(--border-medium);
    }
    .search-input::placeholder {
      color: var(--text-tertiary);
    }
    .search-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-tertiary);
      pointer-events: none;
    }
    .filters-bar {
      padding: 16px 0;
      display: flex;
      gap: 8px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .filters-bar::-webkit-scrollbar {
      display: none;
    }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 14px;
      border-radius: 8px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      user-select: none;
    }
    .filter-chip:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-medium);
      color: var(--text-primary);
    }
    .filter-chip.active {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
      color: var(--text-primary);
    }
    .cards-grid {
      padding: 24px 0 80px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .priority-card {
      position: relative;
      background: var(--glass-bg);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      padding: 20px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      overflow: hidden;
    }
    .priority-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-medium);
      transform: translateY(-2px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    }
    .priority-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--card-accent);
      opacity: 0.8;
    }
    .priority-card.p0 {
      --card-accent: var(--accent-p0);
    }
    .priority-card.p1 {
      --card-accent: var(--accent-p1);
    }
    .priority-card.p2 {
      --card-accent: var(--accent-p2);
    }
    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }
    .card-lead-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }
    .lead-name {
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lead-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 22px;
      padding: 0 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .badge.stage {
      background: rgba(94, 92, 230, 0.15);
      color: #a5a3ff;
      border: 1px solid rgba(94, 92, 230, 0.3);
    }
    .badge.priority {
      border: 1px solid currentColor;
    }
    .badge.p0 {
      background: rgba(255, 59, 48, 0.15);
      color: var(--accent-p0);
    }
    .badge.p1 {
      background: rgba(255, 149, 0, 0.15);
      color: var(--accent-p1);
    }
    .badge.p2 {
      background: rgba(255, 204, 0, 0.15);
      color: var(--accent-p2);
    }
    .badge.country {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
    }
    .time-info {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      font-size: 11px;
      color: var(--text-tertiary);
      text-align: right;
    }
    .time-urgent {
      color: var(--accent-p0);
      font-weight: 600;
    }
    .suggestion-preview {
      margin: 16px 0;
      padding: 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-secondary);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .suggestion-preview.expanded {
      -webkit-line-clamp: unset;
    }
    .expand-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      padding: 4px 10px;
      border-radius: 6px;
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-tertiary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .expand-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: var(--border-medium);
      color: var(--text-secondary);
    }
    .card-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    .btn {
      flex: 1;
      height: 44px;
      padding: 0 20px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      border: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn-primary {
      background: linear-gradient(135deg, #007aff 0%, #0051d5 100%);
      color: white;
      box-shadow: 0 4px 16px rgba(0, 122, 255, 0.3);
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 24px rgba(0, 122, 255, 0.4);
    }
    .btn-primary:active {
      transform: translateY(0);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: var(--border-medium);
    }
    .btn-tertiary {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      flex: 0 0 auto;
      min-width: 44px;
      padding: 0;
    }
    .btn-tertiary:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: var(--border-medium);
      color: var(--text-primary);
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 80px 24px;
      text-align: center;
    }
    .empty-icon {
      width: 80px;
      height: 80px;
      margin-bottom: 24px;
      border-radius: 20px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
    }
    .empty-title {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 8px;
    }
    .empty-subtitle {
      font-size: 14px;
      color: var(--text-tertiary);
      max-width: 400px;
    }
    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 80px 24px;
      gap: 16px;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255, 255, 255, 0.1);
      border-top-color: var(--text-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .skeleton-card {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      padding: 20px;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .skeleton-line {
      height: 16px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .skeleton-line.short {
      width: 60%;
    }
    @media (max-width: 768px) {
      .container {
        padding: 0 16px;
      }
      .header-inner {
        flex-direction: column;
        align-items: stretch;
      }
      .search-bar {
        max-width: none;
      }
      .card-actions {
        flex-direction: column;
      }
      .btn {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="container">
      <div class="header-inner">
        <div class="header-left">
          <a href="/whatsapp" class="back-btn">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>
          <div class="title-group">
            <h1 class="page-title">Priority Inbox</h1>
            <p class="page-subtitle">Ready-to-send suggestions</p>
          </div>
          <div class="count-badge" id="cardCount">0</div>
        </div>
        <div class="search-bar">
          <svg class="search-icon" width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
            <path d="M12.5 12.5L16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input type="text" class="search-input" id="searchInput" placeholder="Search leads...">
        </div>
      </div>
      <div class="filters-bar" id="filtersBar">
        <button class="filter-chip active" data-filter="all">All</button>
        <button class="filter-chip" data-filter="p0">P0 Critical</button>
        <button class="filter-chip" data-filter="p1">P1 High</button>
        <button class="filter-chip" data-filter="p2">P2 Medium</button>
        <button class="filter-chip" data-filter="expiring">Expiring Soon</button>
        <button class="filter-chip" data-filter="review">Needs Review</button>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="cards-grid" id="cardsGrid">
      <div class="loading-state">
        <div class="spinner"></div>
        <p style="color: var(--text-tertiary); font-size: 14px;">Loading priority inbox...</p>
      </div>
    </div>
  </div>

  <script>
    let allCards = [];
    let filteredCards = [];
    let activeFilter = 'all';
    let searchQuery = '';

    async function fetchPriorityInbox() {
      try {
        const response = await fetch('/api/whatsapp/priority-inbox');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        allCards = data.cards || [];
        applyFiltersAndRender();
      } catch (error) {
        console.error('Error fetching priority inbox:', error);
        renderError();
      }
    }

    function applyFiltersAndRender() {
      const ranked = allCards.slice().sort((a, b) => {
        if (Boolean(a.readyToSend) !== Boolean(b.readyToSend)) return a.readyToSend ? -1 : 1;
        return 0;
      });
      filteredCards = ranked.filter(card => {
        const matchesFilter = 
          activeFilter === 'all' ||
          (activeFilter === 'p0' && card.priorityLevel === 'CRITICAL') ||
          (activeFilter === 'p1' && card.priorityLevel === 'HIGH') ||
          (activeFilter === 'p2' && card.priorityLevel === 'MEDIUM') ||
          (activeFilter === 'expiring' && card.sessionTimeLeft && card.sessionTimeLeft < 120) ||
          (activeFilter === 'review' && card.suggestion.requiresReview);

        const matchesSearch = !searchQuery || 
          card.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          card.country.toLowerCase().includes(searchQuery.toLowerCase());

        return matchesFilter && matchesSearch;
      });

      renderCards();
    }

    function renderCards() {
      const grid = document.getElementById('cardsGrid');
      const countBadge = document.getElementById('cardCount');
      
      countBadge.textContent = filteredCards.length;

      if (filteredCards.length === 0) {
        grid.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">✨</div>
            <h2 class="empty-title">All caught up!</h2>
            <p class="empty-subtitle">No urgent messages waiting for your reply right now.</p>
          </div>
        \`;
        return;
      }

      grid.innerHTML = filteredCards.map(card => {
        const priorityClass = card.priorityLevel === 'CRITICAL' ? 'p0' : 
                             card.priorityLevel === 'HIGH' ? 'p1' : 'p2';
        const priorityLabel = card.priorityLevel === 'CRITICAL' ? 'P0' : 
                             card.priorityLevel === 'HIGH' ? 'P1' : 'P2';

        const timeSince = formatTimeSince(card.timeSinceLastInbound);
        const timeLeft = card.sessionTimeLeft ? formatTimeLeft(card.sessionTimeLeft) : null;
        const isUrgent = card.sessionTimeLeft && card.sessionTimeLeft < 120;
        const readyBadge = card.readyToSend ? '<span class="badge stage" style="background:rgba(52,199,89,0.16);color:#7ff0a6;border-color:rgba(52,199,89,0.36);">Prêt à envoyer</span>' : '';
        const primaryLabel = card.readyToSend ? 'Envoyer au client' : 'Confirm & Send';
        const primaryHandler = card.readyToSend
          ? \`sendApprovedQuote('\${card.leadId}', '\${(card.approvedQuote && card.approvedQuote.quoteRequestId) ? card.approvedQuote.quoteRequestId : ''}')\`
          : \`confirmAndSend('\${card.leadId}', '\${card.suggestion.id}')\`;

        return \`
          <div class="priority-card \${priorityClass}" data-lead-id="\${card.leadId}">
            <div class="card-header">
              <div class="card-lead-info">
                <div class="lead-name">\${escapeHtml(card.displayName)}</div>
                <div class="lead-meta">
                  <span class="badge stage">\${card.stageMain}</span>
                  \${readyBadge}
                  <span class="badge priority \${priorityClass}">\${priorityLabel}</span>
                  <span class="badge country">\${card.country}</span>
                </div>
              </div>
              <div class="time-info">
                <span>\${timeSince}</span>
                \${timeLeft ? \`<span class="\${isUrgent ? 'time-urgent' : ''}">\${timeLeft}</span>\` : ''}
              </div>
            </div>

            <div class="suggestion-preview" data-suggestion-id="\${card.suggestion.id}">
              \${escapeHtml(card.suggestion.text)}
            </div>

            <div class="card-actions">
              <button class="btn btn-primary" onclick="\${primaryHandler}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M14 2L6 10L2 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                \${primaryLabel}
              </button>
              <button class="btn btn-secondary" onclick="editSuggestion('\${card.leadId}', '\${card.suggestion.id}')">
                Edit
              </button>
              <button class="btn btn-tertiary" onclick="openContext('\${card.leadId}')">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 4V16M16 10H4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderError() {
      const grid = document.getElementById('cardsGrid');
      grid.innerHTML = \`
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h2 class="empty-title">Unable to load</h2>
          <p class="empty-subtitle">Please try refreshing the page.</p>
        </div>
      \`;
    }

    function formatTimeSince(minutes) {
      if (!minutes) return 'Just now';
      if (minutes < 60) return \`\${minutes}m ago\`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return \`\${hours}h ago\`;
      const days = Math.floor(hours / 24);
      return \`\${days}d ago\`;
    }

    function formatTimeLeft(minutes) {
      if (minutes < 0) return 'Expired';
      if (minutes < 60) return \`\${minutes}m left\`;
      const hours = Math.floor(minutes / 60);
      return \`\${hours}h left\`;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    async function confirmAndSend(leadId, suggestionId) {
      if (!confirm('Send this message now?')) return;
      
      try {
        // Navigate to conversation page with action
        window.location.href = \`/whatsapp?lead=\${leadId}&action=send&suggestion=\${suggestionId}\`;
      } catch (error) {
        console.error('Error:', error);
        alert('Failed to send message');
      }
    }

    async function sendApprovedQuote(leadId, quoteRequestId) {
      try {
        const response = await fetch('/api/leads/' + encodeURIComponent(leadId) + '/send-approved-quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: 'whatsapp',
            mode: 'text',
            ...(quoteRequestId ? { quoteRequestId } : {})
          })
        });
        if (!response.ok) {
          let err = 'Failed to send approved quote';
          try {
            const payload = await response.json();
            err = payload && payload.error ? String(payload.error) : err;
          } catch {}
          alert(err);
          return;
        }
        allCards = allCards.map((card) => {
          if (String(card.leadId) !== String(leadId)) return card;
          return {
            ...card,
            readyToSend: false,
            readyBadge: null,
            stageMain: 'PRICE_SENT'
          };
        });
        applyFiltersAndRender();
      } catch (error) {
        console.error('Error sending approved quote:', error);
        alert('Failed to send approved quote');
      }
    }

    function editSuggestion(leadId, suggestionId) {
      window.location.href = \`/whatsapp?lead=\${leadId}&action=edit&suggestion=\${suggestionId}\`;
    }

    function openContext(leadId) {
      window.location.href = \`/whatsapp?lead=\${leadId}\`;
    }

    document.getElementById('searchInput').addEventListener('input', (e) => {
      searchQuery = e.target.value;
      applyFiltersAndRender();
    });

    document.getElementById('filtersBar').addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;

      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      
      activeFilter = chip.dataset.filter;
      applyFiltersAndRender();
    });

    fetchPriorityInbox();
    setInterval(fetchPriorityInbox, 30000);
  </script>
</body>
</html>`);
});
