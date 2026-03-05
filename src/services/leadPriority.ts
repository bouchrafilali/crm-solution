export type LeadPriorityUrgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type LeadPriorityInput = {
  risk_score: number;
  timing_score: number;
  timing_urgency?: LeadPriorityUrgency;
};

export type LeadPriorityResult = {
  priority_score: number;
  priority_level: LeadPriorityUrgency;
  explanation: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toPriorityLevel(score: number): LeadPriorityUrgency {
  if (score >= 85) return "CRITICAL";
  if (score >= 70) return "HIGH";
  if (score >= 50) return "MEDIUM";
  return "LOW";
}

export function computeLeadPriorityScore(input: LeadPriorityInput): LeadPriorityResult {
  const safeRisk = clamp(Number(input.risk_score || 0), 0, 100);
  const safeTiming = clamp(Number(input.timing_score || 0), 0, 100);
  const criticalBoost = input.timing_urgency === "CRITICAL" ? 10 : 0;
  const raw = 0.45 * safeRisk + 0.55 * safeTiming + criticalBoost;
  const priorityScore = Math.round(clamp(raw, 0, 100));
  const priorityLevel = toPriorityLevel(priorityScore);

  return {
    priority_score: priorityScore,
    priority_level: priorityLevel,
    explanation:
      "risk=" + String(safeRisk) +
      " • timing=" + String(safeTiming) +
      " • critical_boost=" + String(criticalBoost) +
      " • formula=0.45*risk+0.55*timing"
  };
}
