import type { WhatsAppLeadRecord } from "../db/whatsappLeadsRepo.js";

export type WhatsAppLeadScore = {
  score: number;
  tier: "standard" | "high_value" | "vip";
  reasons: string[];
};

export type ConversionCorrelationPoint = {
  responseTimeBucketMinutes: number;
  leads: number;
  converted: number;
  conversionRate: number;
};

export async function classifyVipLead(_lead: WhatsAppLeadRecord): Promise<{ isVip: boolean; reason: string }> {
  // Future hook: connect CRM/Shopify lifetime value and tags.
  return { isVip: false, reason: "vip_hook_not_configured" };
}

export async function scoreLead(_lead: WhatsAppLeadRecord): Promise<WhatsAppLeadScore> {
  // Future hook: plug ML model / rules engine.
  return {
    score: 50,
    tier: "standard",
    reasons: ["lead_scoring_hook_not_configured"]
  };
}

export async function computeResponseConversionCorrelation(
  _shop?: string | null
): Promise<ConversionCorrelationPoint[]> {
  // Future hook: aggregate historical rows for advanced analytics.
  return [];
}
