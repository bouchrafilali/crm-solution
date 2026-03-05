import { env } from "../config/env.js";
import type { WhatsAppBriefStats, WhatsAppFollowUpCandidate, WhatsAppMetrics } from "../db/whatsappLeadsRepo.js";
import { generateAiText, sanitizeForPrompt } from "./aiTextService.js";

export type WhatsAppPromptKey = "follow_up_48" | "follow_up_72" | "daily_brief";

export type PromptTemplate = {
  system: string;
  user: string;
};

const DEFAULT_PROMPTS: Record<WhatsAppPromptKey, PromptTemplate> = {
  follow_up_48: {
    system:
      "You are a luxury WhatsApp sales strategist for Maison BFL. Write concise, warm, premium follow-up messages with clear next step.",
    user:
      "Create a 1-2 sentence follow-up for a lead after 48h of silence. Include a gentle private presentation offer. Lead context:\n{{lead_context}}"
  },
  follow_up_72: {
    system:
      "You are a luxury conversion strategist for Maison BFL. Keep tone elegant and urgency subtle.",
    user:
      "Create a 1-2 sentence follow-up for 72h no-reply. Mention production planning and availability window. Lead context:\n{{lead_context}}"
  },
  daily_brief: {
    system:
      "You are an executive business analyst for WhatsApp conversion performance. Be concise and actionable.",
    user:
      "Generate today's WhatsApp business brief using this JSON context:\n{{brief_context}}\nFormat as: headline + bullet metrics + one AI insight + one action recommendation."
  }
};

function parseCustomPrompts(): Partial<Record<WhatsAppPromptKey, PromptTemplate>> {
  const raw = String(env.WHATSAPP_AI_PROMPTS_JSON || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<Record<WhatsAppPromptKey, Partial<PromptTemplate>>>;
    const merged: Partial<Record<WhatsAppPromptKey, PromptTemplate>> = {};
    for (const key of Object.keys(DEFAULT_PROMPTS) as WhatsAppPromptKey[]) {
      const custom = parsed[key];
      if (!custom) continue;
      merged[key] = {
        system: String(custom.system || DEFAULT_PROMPTS[key].system),
        user: String(custom.user || DEFAULT_PROMPTS[key].user)
      };
    }
    return merged;
  } catch {
    return {};
  }
}

function resolvePrompt(key: WhatsAppPromptKey): PromptTemplate {
  const custom = parseCustomPrompts();
  return custom[key] || DEFAULT_PROMPTS[key];
}

function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) => vars[key] || "");
}

function defaultFollowUpText(kind: "48h" | "72h"): string {
  if (kind === "48h") {
    return "Just checking in regarding the piece you loved — I would be happy to arrange a short private presentation if helpful.";
  }
  return "As we are scheduling production for the coming weeks, I wanted to ensure availability remains open for your date.";
}

function leadContextSummary(lead: WhatsAppFollowUpCandidate): string {
  return JSON.stringify(
    {
      client_name: sanitizeForPrompt(lead.clientName, 80),
      phone_number: sanitizeForPrompt(lead.phoneNumber, 20),
      country: sanitizeForPrompt(lead.country, 40),
      product_reference: sanitizeForPrompt(lead.productReference, 100),
      stage: sanitizeForPrompt(lead.stage, 40),
      last_message_at: lead.lastMessageAt
    },
    null,
    2
  );
}

export async function generateFollowUpMessage(
  lead: WhatsAppFollowUpCandidate,
  kind: "48h" | "72h"
): Promise<{ text: string; provider: "openai" | "fallback"; model: string; promptKey: WhatsAppPromptKey }> {
  const promptKey: WhatsAppPromptKey = kind === "48h" ? "follow_up_48" : "follow_up_72";
  const prompt = resolvePrompt(promptKey);
  const result = await generateAiText({
    systemPrompt: prompt.system,
    userPrompt: applyVars(prompt.user, { lead_context: leadContextSummary(lead) }),
    maxOutputTokens: 140,
    temperature: 0.35,
    fallbackText: defaultFollowUpText(kind)
  });
  return { ...result, promptKey };
}

function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function defaultBriefText(stats: WhatsAppBriefStats, metrics: WhatsAppMetrics): string {
  return [
    "WhatsApp Performance Yesterday",
    `- ${stats.yesterdayInquiries} new inquiries`,
    `- Avg response time: ${formatMinutes(stats.avgResponseTimeMinutes)}`,
    `- ${stats.priceSentCount} price sent`,
    `- ${stats.noResponseCount} no response`,
    `- ${stats.conversions} conversion(s)`,
    "",
    "AI Insight:",
    stats.avgResponseTimeMinutes > 60
      ? "Response time above 1 hour is correlated with weaker stage progression."
      : "Response time under 1 hour is supporting healthier conversion momentum.",
    `Suggested action: Prioritize at-risk leads (${metrics.leadsAtRisk}) with immediate personalized follow-ups.`
  ].join("\n");
}

export async function generateDailyWhatsAppBrief(input: {
  stats: WhatsAppBriefStats;
  metrics: WhatsAppMetrics;
}): Promise<{ text: string; provider: "openai" | "fallback"; model: string; promptKey: WhatsAppPromptKey }> {
  const promptKey: WhatsAppPromptKey = "daily_brief";
  const prompt = resolvePrompt(promptKey);
  const briefContext = JSON.stringify(
    {
      yesterday: input.stats,
      current_window: {
        total_inquiries: input.metrics.totalInquiries,
        conversion_rate: input.metrics.conversionRate,
        avg_response_time_minutes: input.metrics.avgResponseTimeMinutes,
        leads_at_risk: input.metrics.leadsAtRisk,
        stage_distribution: input.metrics.stageDistribution
      }
    },
    null,
    2
  );

  const result = await generateAiText({
    systemPrompt: prompt.system,
    userPrompt: applyVars(prompt.user, { brief_context: briefContext }),
    maxOutputTokens: 360,
    temperature: 0.25,
    fallbackText: defaultBriefText(input.stats, input.metrics)
  });

  return { ...result, promptKey };
}
