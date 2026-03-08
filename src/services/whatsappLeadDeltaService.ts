import type { WhatsAppDirection } from "../db/whatsappLeadsRepo.js";
import {
  EMPTY_STRUCTURED_LEAD_STATE,
  normalizeStructuredLeadState,
  type WhatsAppStructuredLeadState
} from "./whatsappLeadStateModel.js";

export type DeltaMessage = {
  id: string;
  direction: WhatsAppDirection;
  createdAt: string;
  text: string;
  metadata?: Record<string, unknown> | null;
};

export type LeadDeltaContext = {
  mode: "state_delta" | "transcript_fallback";
  hasChanges: boolean;
  latestMessageDelta: {
    id: string | null;
    direction: WhatsAppDirection | null;
    createdAt: string | null;
    text: string;
    isMeaningful: boolean;
  };
  recentMinimalContext: Array<{
    id: string;
    direction: WhatsAppDirection;
    createdAt: string;
    text: string;
  }>;
  currentState: WhatsAppStructuredLeadState;
};

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function isMeaningfulText(text: string): boolean {
  return String(text || "").trim().length >= 2;
}

function truncateText(text: string, max = 360): string {
  const safe = String(text || "").trim();
  if (safe.length <= max) return safe;
  return `${safe.slice(0, max - 1)}…`;
}

export function buildLeadDeltaContext(input: {
  messages: DeltaMessage[];
  persistedState?: unknown;
  forceTranscriptFallback?: boolean;
}): LeadDeltaContext {
  const state = normalizeStructuredLeadState(input.persistedState || EMPTY_STRUCTURED_LEAD_STATE);
  const sorted = (Array.isArray(input.messages) ? input.messages : [])
    .slice()
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));

  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const latestInbound = [...sorted].reverse().find((msg) => msg.direction === "IN") || null;
  const latestOutbound = [...sorted].reverse().find((msg) => msg.direction === "OUT") || null;

  const latestDelta = {
    id: latest ? String(latest.id || "").trim() : null,
    direction: latest ? latest.direction : null,
    createdAt: latest ? String(latest.createdAt || "").trim() : null,
    text: truncateText(latest ? latest.text : "", 420),
    isMeaningful: latest ? isMeaningfulText(latest.text) : false
  };

  const hasInboundChanged =
    Boolean(latestInbound?.id) && String(latestInbound?.id || "") !== String(state.lastMeaningfulInboundMessageId || "");
  const hasOutboundChanged =
    Boolean(latestOutbound?.id) && String(latestOutbound?.id || "") !== String(state.lastMeaningfulOutboundMessageId || "");
  const hasChanges = Boolean(latestDelta.id && (hasInboundChanged || hasOutboundChanged));

  const recentMinimalContext = sorted.slice(-6).map((msg) => ({
    id: String(msg.id || "").trim(),
    direction: msg.direction,
    createdAt: String(msg.createdAt || "").trim(),
    text: truncateText(msg.text, 220)
  }));

  const mode: "state_delta" | "transcript_fallback" = input.forceTranscriptFallback ? "transcript_fallback" : "state_delta";

  return {
    mode,
    hasChanges,
    latestMessageDelta: latestDelta,
    recentMinimalContext,
    currentState: state
  };
}

export function mergeStructuredState(input: {
  previousState?: unknown;
  stageAnalysis: Record<string, unknown> | null;
  latestInboundMessageId: string | null;
  latestOutboundMessageId: string | null;
  runId: string;
  nowIso: string;
}): WhatsAppStructuredLeadState {
  const previous = normalizeStructuredLeadState(input.previousState || EMPTY_STRUCTURED_LEAD_STATE);
  const stage = input.stageAnalysis && typeof input.stageAnalysis === "object" ? input.stageAnalysis : {};
  const factsRaw = stage.facts && typeof stage.facts === "object" && !Array.isArray(stage.facts) ? (stage.facts as Record<string, unknown>) : {};
  const objectionsRaw = Array.isArray(stage.objections) ? stage.objections : [];

  const objections = objectionsRaw
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const item = row as Record<string, unknown>;
      const evidence = String(item.evidence || "").trim();
      if (!evidence) return null;
      return {
        type: String(item.type || "other").trim().toLowerCase(),
        evidence
      };
    })
    .filter(Boolean);

  return normalizeStructuredLeadState({
    ...previous,
    stage: String(stage.stage || previous.stage || "NEW").trim().toUpperCase(),
    productsOfInterest: Array.isArray(factsRaw.products_of_interest) ? factsRaw.products_of_interest : previous.productsOfInterest,
    eventDate: String(factsRaw.event_date || previous.eventDate || "").trim() || null,
    deliveryDeadline: String(factsRaw.delivery_deadline || previous.deliveryDeadline || "").trim() || null,
    destinationCountry: String(factsRaw.destination_country || previous.destinationCountry || "").trim() || null,
    budget: String(factsRaw.budget || previous.budget || "").trim() || null,
    pricePointsDetected: Array.isArray(factsRaw.price_points_detected) ? factsRaw.price_points_detected : previous.pricePointsDetected,
    customizationRequests: Array.isArray(factsRaw.customization_requests) ? factsRaw.customization_requests : previous.customizationRequests,
    preferredColors: Array.isArray(factsRaw.preferred_colors) ? factsRaw.preferred_colors : previous.preferredColors,
    preferredFabrics: Array.isArray(factsRaw.preferred_fabrics) ? factsRaw.preferred_fabrics : previous.preferredFabrics,
    paymentIntent: Boolean(stage.payment_intent ?? previous.paymentIntent),
    depositIntent: previous.depositIntent || String(stage.stage || "").trim().toUpperCase() === "DEPOSIT_PENDING",
    objections,
    lastMeaningfulInboundMessageId: input.latestInboundMessageId || previous.lastMeaningfulInboundMessageId,
    lastMeaningfulOutboundMessageId: input.latestOutboundMessageId || previous.lastMeaningfulOutboundMessageId,
    latestAgentRunId: input.runId,
    lastStateUpdatedAt: input.nowIso
  });
}
