export type LeadObjectionType =
  | "price"
  | "timing"
  | "trust"
  | "fit"
  | "fabric"
  | "uncertainty"
  | "external_approval"
  | "other";

export type LeadObjection = {
  type: LeadObjectionType;
  evidence: string;
};

export type WhatsAppStructuredLeadState = {
  stage: string;
  productsOfInterest: string[];
  eventDate: string | null;
  deliveryDeadline: string | null;
  destinationCountry: string | null;
  budget: string | null;
  pricePointsDetected: Array<string | number>;
  customizationRequests: string[];
  preferredColors: string[];
  preferredFabrics: string[];
  paymentIntent: boolean;
  depositIntent: boolean;
  objections: LeadObjection[];
  lastMeaningfulInboundMessageId: string | null;
  lastMeaningfulOutboundMessageId: string | null;
  latestAgentRunId: string | null;
  lastStateUpdatedAt: string | null;
};

export const EMPTY_STRUCTURED_LEAD_STATE: WhatsAppStructuredLeadState = {
  stage: "NEW",
  productsOfInterest: [],
  eventDate: null,
  deliveryDeadline: null,
  destinationCountry: null,
  budget: null,
  pricePointsDetected: [],
  customizationRequests: [],
  preferredColors: [],
  preferredFabrics: [],
  paymentIntent: false,
  depositIntent: false,
  objections: [],
  lastMeaningfulInboundMessageId: null,
  lastMeaningfulOutboundMessageId: null,
  latestAgentRunId: null,
  lastStateUpdatedAt: null
};

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((v) => String(v || "").trim()).filter(Boolean);
}

function normalizeMixedArray(input: unknown): Array<string | number> {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : String(v || "").trim()))
    .filter((v) => (typeof v === "number" ? true : v.length > 0));
}

function normalizeNullableString(input: unknown): string | null {
  const value = String(input || "").trim();
  return value || null;
}

export function normalizeStructuredLeadState(input: unknown): WhatsAppStructuredLeadState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...EMPTY_STRUCTURED_LEAD_STATE };
  }
  const row = input as Record<string, unknown>;
  const objections = Array.isArray(row.objections)
    ? row.objections
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const obj = item as Record<string, unknown>;
          const type = String(obj.type || "other").trim().toLowerCase() as LeadObjectionType;
          const evidence = String(obj.evidence || "").trim();
          if (!evidence) return null;
          return {
            type:
              type === "price" ||
              type === "timing" ||
              type === "trust" ||
              type === "fit" ||
              type === "fabric" ||
              type === "uncertainty" ||
              type === "external_approval"
                ? type
                : "other",
            evidence
          };
        })
        .filter(Boolean) as LeadObjection[]
    : [];

  return {
    stage: String(row.stage || EMPTY_STRUCTURED_LEAD_STATE.stage).trim().toUpperCase() || "NEW",
    productsOfInterest: normalizeStringArray(row.productsOfInterest),
    eventDate: normalizeNullableString(row.eventDate),
    deliveryDeadline: normalizeNullableString(row.deliveryDeadline),
    destinationCountry: normalizeNullableString(row.destinationCountry),
    budget: normalizeNullableString(row.budget),
    pricePointsDetected: normalizeMixedArray(row.pricePointsDetected),
    customizationRequests: normalizeStringArray(row.customizationRequests),
    preferredColors: normalizeStringArray(row.preferredColors),
    preferredFabrics: normalizeStringArray(row.preferredFabrics),
    paymentIntent: Boolean(row.paymentIntent),
    depositIntent: Boolean(row.depositIntent),
    objections,
    lastMeaningfulInboundMessageId: normalizeNullableString(row.lastMeaningfulInboundMessageId),
    lastMeaningfulOutboundMessageId: normalizeNullableString(row.lastMeaningfulOutboundMessageId),
    latestAgentRunId: normalizeNullableString(row.latestAgentRunId),
    lastStateUpdatedAt: normalizeNullableString(row.lastStateUpdatedAt)
  };
}

export function isStructuredStateComplete(input: WhatsAppStructuredLeadState | null | undefined): boolean {
  if (!input) return false;
  const hasStage = Boolean(String(input.stage || "").trim());
  const hasStateTimestamp = Boolean(String(input.lastStateUpdatedAt || "").trim());
  const hasMeaningfulMessageAnchor = Boolean(
    String(input.lastMeaningfulInboundMessageId || "").trim() || String(input.lastMeaningfulOutboundMessageId || "").trim()
  );
  return hasStage && hasStateTimestamp && hasMeaningfulMessageAnchor;
}
