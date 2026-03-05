import { randomUUID } from "node:crypto";
import { getDbPool } from "./client.js";

export type CountryGroup = "MA" | "FR" | "INTL";
export type RuleLanguage = "FR" | "EN";
export type RuleTag =
  | "PRICE_REQUEST"
  | "EVENT_DATE"
  | "SHIPPING"
  | "SIZING"
  | "RESERVATION_INTENT"
  | "PAYMENT"
  | "VIDEO_INTEREST"
  | "URGENCY"
  | "PRODUCT_LINK"
  | "INTEREST";

export type GlobalSettings = {
  id: number;
  tone: "FORMEL" | "QUIET_LUXURY" | "DIRECT";
  message_length: "SHORT" | "MEDIUM";
  no_emojis: boolean;
  avoid_follow_up_phrase: boolean;
  signature_enabled: boolean;
  signature_text: string | null;
  updated_at: string;
};

export type CountrySettings = {
  country_group: CountryGroup;
  language: "AUTO" | "FR" | "EN";
  price_policy: "NEVER_FIRST" | "AFTER_QUALIFIED";
  video_policy: "NEVER" | "WHEN_HIGH_INTENT" | "ALWAYS";
  urgency_style: "SUBTLE" | "NEUTRAL";
  followup_delay_hours: number;
  updated_at: string;
};

export type KeywordRule = {
  id: string;
  language: RuleLanguage;
  tag: RuleTag;
  keywords: string[];
  patterns: string[];
  enabled: boolean;
  updated_at: string;
};

export type StageRule = {
  id: string;
  rule_name: string;
  required_tags: string[];
  forbidden_tags: string[];
  recommended_stage: string;
  priority: number;
  enabled: boolean;
};

export type ReplyTemplate = {
  id: string;
  stage: string;
  language: RuleLanguage;
  country_group: CountryGroup | null;
  template_name: string;
  text: string;
  enabled: boolean;
  updated_at: string;
};

export type StageTemplateSuggestion = {
  id: string;
  stage: string;
  template_name: string;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

function dbOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("db_unavailable");
  return db;
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  const db = dbOrThrow();
  const q = await db.query<GlobalSettings>("select * from ai_settings_global where id = 1");
  return q.rows[0];
}

export async function patchGlobalSettings(input: Partial<Omit<GlobalSettings, "id" | "updated_at">>): Promise<GlobalSettings> {
  const db = dbOrThrow();
  const q = await db.query<GlobalSettings>(
    `
      update ai_settings_global
      set
        tone = coalesce($1::text, tone),
        message_length = coalesce($2::text, message_length),
        no_emojis = coalesce($3::boolean, no_emojis),
        avoid_follow_up_phrase = coalesce($4::boolean, avoid_follow_up_phrase),
        signature_enabled = coalesce($5::boolean, signature_enabled),
        signature_text = coalesce($6::text, signature_text),
        updated_at = now()
      where id = 1
      returning *
    `,
    [
      input.tone ?? null,
      input.message_length ?? null,
      input.no_emojis ?? null,
      input.avoid_follow_up_phrase ?? null,
      input.signature_enabled ?? null,
      input.signature_text ?? null
    ]
  );
  return q.rows[0];
}

export async function getCountrySettings(group: CountryGroup): Promise<CountrySettings | null> {
  const db = dbOrThrow();
  const q = await db.query<CountrySettings>("select * from ai_settings_by_country_group where country_group = $1::text", [group]);
  return q.rows[0] || null;
}

export async function patchCountrySettings(group: CountryGroup, input: Partial<Omit<CountrySettings, "country_group" | "updated_at">>): Promise<CountrySettings> {
  const db = dbOrThrow();
  const q = await db.query<CountrySettings>(
    `
      insert into ai_settings_by_country_group (country_group, language, price_policy, video_policy, urgency_style, followup_delay_hours, updated_at)
      values ($1::text, coalesce($2::text, 'AUTO'), coalesce($3::text, 'AFTER_QUALIFIED'), coalesce($4::text, 'WHEN_HIGH_INTENT'), coalesce($5::text, 'SUBTLE'), coalesce($6::int, 48), now())
      on conflict (country_group)
      do update set
        language = coalesce($2::text, ai_settings_by_country_group.language),
        price_policy = coalesce($3::text, ai_settings_by_country_group.price_policy),
        video_policy = coalesce($4::text, ai_settings_by_country_group.video_policy),
        urgency_style = coalesce($5::text, ai_settings_by_country_group.urgency_style),
        followup_delay_hours = coalesce($6::int, ai_settings_by_country_group.followup_delay_hours),
        updated_at = now()
      returning *
    `,
    [group, input.language ?? null, input.price_policy ?? null, input.video_policy ?? null, input.urgency_style ?? null, input.followup_delay_hours ?? null]
  );
  return q.rows[0];
}

export async function listKeywordRules(language?: RuleLanguage): Promise<KeywordRule[]> {
  const db = dbOrThrow();
  const q = await db.query<KeywordRule>(
    `
      select *
      from keyword_rules
      where ($1::text is null or language = $1::text)
      order by language asc, tag asc, updated_at desc
    `,
    [language ?? null]
  );
  return q.rows;
}

export async function createKeywordRule(input: Omit<KeywordRule, "id" | "updated_at">): Promise<KeywordRule> {
  const db = dbOrThrow();
  const id = randomUUID();
  const q = await db.query<KeywordRule>(
    `
      insert into keyword_rules (id, language, tag, keywords, patterns, enabled, updated_at)
      values ($1::uuid, $2::text, $3::text, $4::text[], $5::text[], $6::boolean, now())
      returning *
    `,
    [id, input.language, input.tag, input.keywords || [], input.patterns || [], input.enabled]
  );
  return q.rows[0];
}

export async function patchKeywordRule(id: string, input: Partial<Omit<KeywordRule, "id" | "updated_at">>): Promise<KeywordRule | null> {
  const db = dbOrThrow();
  const q = await db.query<KeywordRule>(
    `
      update keyword_rules
      set
        language = coalesce($2::text, language),
        tag = coalesce($3::text, tag),
        keywords = coalesce($4::text[], keywords),
        patterns = coalesce($5::text[], patterns),
        enabled = coalesce($6::boolean, enabled),
        updated_at = now()
      where id = $1::uuid
      returning *
    `,
    [id, input.language ?? null, input.tag ?? null, input.keywords ?? null, input.patterns ?? null, input.enabled ?? null]
  );
  return q.rows[0] || null;
}

export async function listStageRules(): Promise<StageRule[]> {
  const db = dbOrThrow();
  const q = await db.query<StageRule>("select * from stage_rules order by priority asc, rule_name asc");
  return q.rows;
}

export async function createStageRule(input: Omit<StageRule, "id">): Promise<StageRule> {
  const db = dbOrThrow();
  const id = randomUUID();
  const q = await db.query<StageRule>(
    `
      insert into stage_rules (id, rule_name, required_tags, forbidden_tags, recommended_stage, priority, enabled)
      values ($1::uuid, $2::text, $3::text[], $4::text[], $5::text, $6::int, $7::boolean)
      returning *
    `,
    [id, input.rule_name, input.required_tags || [], input.forbidden_tags || [], input.recommended_stage, input.priority, input.enabled]
  );
  return q.rows[0];
}

export async function patchStageRule(id: string, input: Partial<Omit<StageRule, "id">>): Promise<StageRule | null> {
  const db = dbOrThrow();
  const q = await db.query<StageRule>(
    `
      update stage_rules
      set
        rule_name = coalesce($2::text, rule_name),
        required_tags = coalesce($3::text[], required_tags),
        forbidden_tags = coalesce($4::text[], forbidden_tags),
        recommended_stage = coalesce($5::text, recommended_stage),
        priority = coalesce($6::int, priority),
        enabled = coalesce($7::boolean, enabled)
      where id = $1::uuid
      returning *
    `,
    [id, input.rule_name ?? null, input.required_tags ?? null, input.forbidden_tags ?? null, input.recommended_stage ?? null, input.priority ?? null, input.enabled ?? null]
  );
  return q.rows[0] || null;
}

export async function listReplyTemplates(filters?: { stage?: string; language?: RuleLanguage; country_group?: CountryGroup | "GLOBAL" }): Promise<ReplyTemplate[]> {
  const db = dbOrThrow();
  const q = await db.query<ReplyTemplate>(
    `
      select *
      from reply_templates
      where ($1::text is null or stage = $1::text)
        and ($2::text is null or language = $2::text)
        and (
          $3::text is null
          or ($3::text = 'GLOBAL' and country_group is null)
          or country_group = $3::text
        )
      order by stage asc, language asc, country_group asc nulls first, template_name asc
    `,
    [filters?.stage ?? null, filters?.language ?? null, filters?.country_group ?? null]
  );
  return q.rows;
}

export async function createReplyTemplate(input: Omit<ReplyTemplate, "id" | "updated_at">): Promise<ReplyTemplate> {
  const db = dbOrThrow();
  const id = randomUUID();
  const q = await db.query<ReplyTemplate>(
    `
      insert into reply_templates (id, stage, language, country_group, template_name, text, enabled, updated_at)
      values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean, now())
      returning *
    `,
    [id, input.stage, input.language, input.country_group ?? null, input.template_name, input.text, input.enabled]
  );
  return q.rows[0];
}

export async function patchReplyTemplate(id: string, input: Partial<Omit<ReplyTemplate, "id" | "updated_at">>): Promise<ReplyTemplate | null> {
  const db = dbOrThrow();
  const q = await db.query<ReplyTemplate>(
    `
      update reply_templates
      set
        stage = coalesce($2::text, stage),
        language = coalesce($3::text, language),
        country_group = case when $4::text = '__KEEP__' then country_group else $4::text end,
        template_name = coalesce($5::text, template_name),
        text = coalesce($6::text, text),
        enabled = coalesce($7::boolean, enabled),
        updated_at = now()
      where id = $1::uuid
      returning *
    `,
    [id, input.stage ?? null, input.language ?? null, input.country_group === undefined ? "__KEEP__" : (input.country_group ?? null), input.template_name ?? null, input.text ?? null, input.enabled ?? null]
  );
  return q.rows[0] || null;
}

export async function listStageTemplateSuggestions(filters?: {
  stage?: string;
  enabled?: boolean;
  limit?: number;
}): Promise<StageTemplateSuggestion[]> {
  const db = dbOrThrow();
  const limit = Math.max(1, Math.min(100, Math.round(filters?.limit || 20)));
  const q = await db.query<StageTemplateSuggestion>(
    `
      select *
      from stage_template_suggestions
      where ($1::text is null or stage = $1::text)
        and ($2::boolean is null or enabled = $2::boolean)
      order by stage asc, priority asc, template_name asc
      limit $3::int
    `,
    [filters?.stage ?? null, filters?.enabled == null ? null : Boolean(filters.enabled), limit]
  );
  return q.rows;
}

export async function createStageTemplateSuggestion(input: {
  stage: string;
  template_name: string;
  priority?: number;
  enabled?: boolean;
}): Promise<StageTemplateSuggestion> {
  const db = dbOrThrow();
  const id = randomUUID();
  const q = await db.query<StageTemplateSuggestion>(
    `
      insert into stage_template_suggestions (id, stage, template_name, priority, enabled, created_at, updated_at)
      values ($1::uuid, $2::text, $3::text, $4::int, $5::boolean, now(), now())
      on conflict (stage, template_name)
      do update set
        priority = excluded.priority,
        enabled = excluded.enabled,
        updated_at = now()
      returning *
    `,
    [
      id,
      input.stage,
      String(input.template_name || "").trim(),
      input.priority == null ? 100 : Math.max(1, Math.min(1000, Math.round(input.priority))),
      input.enabled == null ? true : Boolean(input.enabled)
    ]
  );
  return q.rows[0];
}

export async function patchStageTemplateSuggestion(
  id: string,
  input: Partial<Pick<StageTemplateSuggestion, "priority" | "enabled">>
): Promise<StageTemplateSuggestion | null> {
  const db = dbOrThrow();
  const q = await db.query<StageTemplateSuggestion>(
    `
      update stage_template_suggestions
      set
        priority = coalesce($2::int, priority),
        enabled = coalesce($3::boolean, enabled),
        updated_at = now()
      where id = $1::uuid
      returning *
    `,
    [
      id,
      input.priority == null ? null : Math.max(1, Math.min(1000, Math.round(input.priority))),
      input.enabled == null ? null : Boolean(input.enabled)
    ]
  );
  return q.rows[0] || null;
}

export async function deleteStageTemplateSuggestion(id: string): Promise<boolean> {
  const db = dbOrThrow();
  const q = await db.query("delete from stage_template_suggestions where id = $1::uuid", [id]);
  return (q.rowCount || 0) > 0;
}
