import { env } from "../config/env.js";

type GcpServiceAccount = {
  client_email?: string;
  private_key?: string;
  project_id?: string;
};

function parseInlineCredentials(raw: string): GcpServiceAccount | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  const attempts = [trimmed];
  try {
    attempts.push(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    // Ignore invalid base64 input and keep trying raw JSON only.
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as GcpServiceAccount;
      if (parsed && typeof parsed === "object" && parsed.client_email && parsed.private_key) {
        return parsed;
      }
    } catch {
      // Ignore and continue to next parse attempt.
    }
  }

  return null;
}

export function getInlineGcpCredentials(): GcpServiceAccount | undefined {
  const inline = parseInlineCredentials(String(env.GOOGLE_APPLICATION_CREDENTIALS_JSON || ""));
  return inline || undefined;
}
