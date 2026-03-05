import type { Pool } from "pg";
import { getDbPool } from "./client.js";

export type AiSettingsLanguage = "AUTO" | "FR" | "EN";
export type AiSettingsTone = "FORMEL" | "QUIET_LUXURY" | "DIRECT";
export type AiSettingsMessageLength = "SHORT" | "MEDIUM";
export type AiSettingsIncludePricePolicy = "NEVER_FIRST" | "AFTER_QUALIFIED";
export type AiSettingsIncludeVideoCall = "NEVER" | "WHEN_HIGH_INTENT" | "ALWAYS";
export type AiSettingsUrgencyStyle = "SUBTLE" | "NEUTRAL";

export type AiSettings = {
  id: number;
  defaultLanguage: AiSettingsLanguage;
  tone: AiSettingsTone;
  messageLength: AiSettingsMessageLength;
  includePricePolicy: AiSettingsIncludePricePolicy;
  includeVideoCall: AiSettingsIncludeVideoCall;
  urgencyStyle: AiSettingsUrgencyStyle;
  noEmojis: boolean;
  avoidFollowUpPhrase: boolean;
  signatureEnabled: boolean;
  signatureText: string | null;
  updatedAt: string;
};

export type AiSettingsPatch = Partial<{
  defaultLanguage: AiSettingsLanguage;
  tone: AiSettingsTone;
  messageLength: AiSettingsMessageLength;
  includePricePolicy: AiSettingsIncludePricePolicy;
  includeVideoCall: AiSettingsIncludeVideoCall;
  urgencyStyle: AiSettingsUrgencyStyle;
  noEmojis: boolean;
  avoidFollowUpPhrase: boolean;
  signatureEnabled: boolean;
  signatureText: string | null;
}>;

const DEFAULT_SETTINGS: Omit<AiSettings, "updatedAt"> = {
  id: 1,
  defaultLanguage: "AUTO",
  tone: "QUIET_LUXURY",
  messageLength: "SHORT",
  includePricePolicy: "AFTER_QUALIFIED",
  includeVideoCall: "WHEN_HIGH_INTENT",
  urgencyStyle: "SUBTLE",
  noEmojis: true,
  avoidFollowUpPhrase: true,
  signatureEnabled: false,
  signatureText: null
};

function getPoolOrThrow(): Pool {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function mapRow(row: Record<string, unknown> | undefined): AiSettings {
  if (!row) {
    return {
      ...DEFAULT_SETTINGS,
      updatedAt: new Date().toISOString()
    };
  }
  return {
    id: Number(row.id || 1),
    defaultLanguage: (String(row.default_language || DEFAULT_SETTINGS.defaultLanguage).toUpperCase() as AiSettingsLanguage),
    tone: (String(row.tone || DEFAULT_SETTINGS.tone).toUpperCase() as AiSettingsTone),
    messageLength: (String(row.message_length || DEFAULT_SETTINGS.messageLength).toUpperCase() as AiSettingsMessageLength),
    includePricePolicy: (String(row.include_price_policy || DEFAULT_SETTINGS.includePricePolicy).toUpperCase() as AiSettingsIncludePricePolicy),
    includeVideoCall: (() => {
      const raw = String(row.include_video_call || DEFAULT_SETTINGS.includeVideoCall).toUpperCase();
      return (raw === "DEFAULT_ON" ? "ALWAYS" : raw) as AiSettingsIncludeVideoCall;
    })(),
    urgencyStyle: (String(row.urgency_style || DEFAULT_SETTINGS.urgencyStyle).toUpperCase() as AiSettingsUrgencyStyle),
    noEmojis: Boolean(row.no_emojis ?? DEFAULT_SETTINGS.noEmojis),
    avoidFollowUpPhrase: Boolean(row.avoid_follow_up_phrase ?? DEFAULT_SETTINGS.avoidFollowUpPhrase),
    signatureEnabled: Boolean(row.signature_enabled ?? DEFAULT_SETTINGS.signatureEnabled),
    signatureText: row.signature_text == null ? null : String(row.signature_text),
    updatedAt: String(row.updated_at || new Date().toISOString())
  };
}

export async function getSettings(): Promise<AiSettings> {
  const db = getPoolOrThrow();
  await db.query(
    `
      insert into ai_settings (id)
      values (1)
      on conflict (id) do nothing
    `
  );
  const q = await db.query<Record<string, unknown>>("select * from ai_settings where id = 1 limit 1");
  return mapRow(q.rows[0]);
}

export async function updateSettings(patch: AiSettingsPatch): Promise<AiSettings> {
  const db = getPoolOrThrow();
  await db.query(
    `
      insert into ai_settings (id)
      values (1)
      on conflict (id) do nothing
    `
  );
  const q = await db.query<Record<string, unknown>>(
    `
      update ai_settings
      set
        default_language = coalesce($1::text, default_language),
        tone = coalesce($2::text, tone),
        message_length = coalesce($3::text, message_length),
        include_price_policy = coalesce($4::text, include_price_policy),
        include_video_call = coalesce($5::text, include_video_call),
        urgency_style = coalesce($6::text, urgency_style),
        no_emojis = coalesce($7::boolean, no_emojis),
        avoid_follow_up_phrase = coalesce($8::boolean, avoid_follow_up_phrase),
        signature_enabled = coalesce($9::boolean, signature_enabled),
        signature_text = case
          when $10::text is null then signature_text
          else nullif(trim($10::text), '')
        end,
        updated_at = now()
      where id = 1
      returning *
    `,
    [
      patch.defaultLanguage ?? null,
      patch.tone ?? null,
      patch.messageLength ?? null,
      patch.includePricePolicy ?? null,
      patch.includeVideoCall ?? null,
      patch.urgencyStyle ?? null,
      patch.noEmojis ?? null,
      patch.avoidFollowUpPhrase ?? null,
      patch.signatureEnabled ?? null,
      patch.signatureText === undefined ? null : patch.signatureText
    ]
  );
  return mapRow(q.rows[0]);
}
