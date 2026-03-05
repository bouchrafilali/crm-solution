import { env } from "../config/env.js";
import { getDbPool } from "../db/client.js";

export type WhatsAppTemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export type WhatsAppTemplateItem = {
  id: string;
  name: string;
  category: WhatsAppTemplateCategory;
  language: string;
  components: unknown[];
  variables_count: number;
  preview_text: string;
};

function zokoAuthHeader(): { key: string; value: string } {
  const authHeader = String(env.ZOKO_AUTH_HEADER || "apikey").trim();
  const authPrefix = String(env.ZOKO_AUTH_PREFIX || "").trim();
  const token = String(env.ZOKO_AUTH_TOKEN || "").trim();
  return {
    key: authHeader,
    value: authPrefix ? `${authPrefix} ${token}` : token
  };
}

function buildLanguageVariants(raw: string): string[] {
  const value = String(raw || "").trim();
  if (!value) return ["fr", "French", "fr_FR"];
  const lower = value.toLowerCase();
  const out: string[] = [];
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };
  push(value);
  if (lower.startsWith("fr")) {
    push("fr");
    push("French");
    push("fr_FR");
  } else if (lower.startsWith("en")) {
    push("en");
    push("English");
    push("en_US");
  }
  return out;
}

function asArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.templates)) return obj.templates;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

function toTemplateCategory(input: unknown): WhatsAppTemplateCategory {
  const raw = String(input || "UTILITY")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z_]/g, "");
  if (raw.includes("MARKETING")) return "MARKETING";
  if (raw.includes("AUTH")) return "AUTHENTICATION";
  return "UTILITY";
}

function countVariables(components: unknown[]): number {
  const textBlob = JSON.stringify(components || []);
  const matches = textBlob.match(/\{\{\s*\d+\s*\}\}/g);
  if (!matches) return 0;
  return new Set(matches).size;
}

function extractPreviewText(components: unknown[]): string {
  if (!Array.isArray(components) || !components.length) return "";
  const chunk = components
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const obj = entry as Record<string, unknown>;
      return String(obj.text || obj.body || obj.example || obj.type || "").trim();
    })
    .filter(Boolean)
    .join(" ");
  return chunk.slice(0, 280);
}

function normalizeTemplate(raw: unknown, index: number): WhatsAppTemplateItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const name = String(row.name || row.templateName || row.template_id || row.id || "").trim();
  if (!name) return null;
  const id = String(row.id || row.template_id || name || `template_${index + 1}`).trim();
  const category = toTemplateCategory(row.category || row.type);
  const language = String(row.language || row.locale || "fr").trim();
  const components = Array.isArray(row.components) ? row.components : [];
  return {
    id,
    name,
    category,
    language,
    components,
    variables_count: countVariables(components),
    preview_text: extractPreviewText(components)
  };
}

async function cacheTemplates(items: WhatsAppTemplateItem[]): Promise<void> {
  const db = getDbPool();
  if (!db || !items.length) return;
  for (const item of items) {
    await db.query(
      `
        insert into whatsapp_templates_cache (name, category, language, components, variables_count, updated_at)
        values ($1::text, $2::text, $3::text, $4::jsonb, $5::int, now())
        on conflict (name, language)
        do update set
          category = excluded.category,
          components = excluded.components,
          variables_count = excluded.variables_count,
          updated_at = now()
      `,
      [item.name, item.category, item.language, JSON.stringify(item.components), item.variables_count]
    );
  }
}

async function isTemplateCacheFresh(maxAgeHours = 6): Promise<boolean> {
  const db = getDbPool();
  if (!db) return false;
  const q = await db.query<{ has_data: boolean; max_updated_at: string | null }>(
    `
      select
        exists(select 1 from whatsapp_templates_cache) as has_data,
        max(updated_at) as max_updated_at
      from whatsapp_templates_cache
    `
  );
  const row = q.rows[0];
  if (!row?.has_data || !row.max_updated_at) return false;
  const ageHours = (Date.now() - new Date(row.max_updated_at).getTime()) / 3600000;
  return Number.isFinite(ageHours) && ageHours <= maxAgeHours;
}

function mapCachedTemplate(row: {
  id: string;
  name: string;
  category: string | null;
  language: string | null;
  components: unknown;
  variables_count: number | string | null;
}): WhatsAppTemplateItem {
  const components = Array.isArray(row.components) ? row.components : [];
  const category = toTemplateCategory(row.category);
  return {
    id: row.id,
    name: row.name,
    category,
    language: String(row.language || "fr"),
    components,
    variables_count: Number(row.variables_count || 0),
    preview_text: extractPreviewText(components)
  };
}

export async function listCachedTemplates(filters?: {
  category?: "UTILITY" | "MARKETING" | "ALL";
  search?: string;
}): Promise<WhatsAppTemplateItem[]> {
  const db = getDbPool();
  if (!db) return [];
  const category = String(filters?.category || "ALL").trim().toUpperCase();
  const search = String(filters?.search || "").trim().toLowerCase();
  const q = await db.query<{
    id: string;
    name: string;
    category: string | null;
    language: string | null;
    components: unknown;
    variables_count: number | string | null;
  }>(
    `
      select id, name, category, language, components, variables_count
      from whatsapp_templates_cache
      where ($1::text = 'ALL' or category = $1::text)
        and ($2::text = '' or lower(name) like '%' || $2::text || '%')
      order by category asc, name asc
    `,
    [category, search]
  );
  return q.rows.map(mapCachedTemplate);
}

async function listFallbackTemplatesFromDb(filters?: {
  category?: "UTILITY" | "MARKETING" | "ALL";
  search?: string;
}): Promise<WhatsAppTemplateItem[]> {
  const db = getDbPool();
  if (!db) return [];
  const category = String(filters?.category || "ALL").trim().toUpperCase();
  const search = String(filters?.search || "").trim().toLowerCase();
  if (category !== "ALL" && category !== "UTILITY") {
    // Without Zoko template API data, we cannot reliably classify to marketing/auth.
    return [];
  }
  const q = await db.query<{ name: string }>(
    `
      with names as (
        select distinct nullif(trim(template_name), '') as name
        from whatsapp_lead_messages
        where nullif(trim(template_name), '') is not null
        union
        select distinct nullif(trim(template_name), '') as name
        from stage_template_suggestions
        where nullif(trim(template_name), '') is not null
        union
        select distinct nullif(trim(template_name), '') as name
        from whatsapp_template_favorites
        where nullif(trim(template_name), '') is not null
      )
      select name
      from names
      where ($1::text = '' or lower(name) like '%' || $1::text || '%')
      order by name asc
    `,
    [search]
  );
  return q.rows.map((row, index) => ({
    id: `fallback_${index + 1}_${row.name}`,
    name: row.name,
    category: "UTILITY",
    language: "fr",
    components: [],
    variables_count: 0,
    preview_text: ""
  }));
}

async function fetchZokoTemplatesFromApi(): Promise<WhatsAppTemplateItem[]> {
  const auth = zokoAuthHeader();
  const templatesUrl = String(env.ZOKO_TEMPLATES_API_URL || "").trim();
  if (!templatesUrl || !auth.value) return [];
  const res = await fetch(templatesUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      [auth.key]: auth.value
    }
  });
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok || !parsed) return [];
  return asArray(parsed)
    .map((item, index) => normalizeTemplate(item, index))
    .filter(Boolean) as WhatsAppTemplateItem[];
}

export async function fetchZokoTemplates(filters?: {
  category?: "UTILITY" | "MARKETING" | "ALL";
  search?: string;
  forceRefresh?: boolean;
}): Promise<WhatsAppTemplateItem[]> {
  const shouldRefresh = Boolean(filters?.forceRefresh);
  try {
    const fresh = !shouldRefresh && (await isTemplateCacheFresh(6));
    if (!fresh) {
      const fromApi = await fetchZokoTemplatesFromApi();
      if (fromApi.length) {
        await cacheTemplates(fromApi);
      }
    }
  } catch {
    // fallback on cached rows
  }
  const cached = await listCachedTemplates(filters);
  if (cached.length > 0) return cached;
  return listFallbackTemplatesFromDb(filters);
}

export async function getTemplateCategoryByName(templateName: string): Promise<WhatsAppTemplateCategory | null> {
  const db = getDbPool();
  if (!db) return null;
  const name = String(templateName || "").trim();
  if (!name) return null;
  const q = await db.query<{ category: string | null }>(
    `
      select category
      from whatsapp_templates_cache
      where lower(name) = lower($1::text)
      order by updated_at desc
      limit 1
    `,
    [name]
  );
  const category = q.rows[0]?.category;
  if (!category) return null;
  return toTemplateCategory(category);
}

export async function getTemplateByName(templateName: string): Promise<WhatsAppTemplateItem | null> {
  const db = getDbPool();
  if (!db) return null;
  const name = String(templateName || "").trim();
  if (!name) return null;
  const q = await db.query<{
    id: string;
    name: string;
    category: string | null;
    language: string | null;
    components: unknown;
    variables_count: number | string | null;
  }>(
    `
      select id, name, category, language, components, variables_count
      from whatsapp_templates_cache
      where lower(name) = lower($1::text)
      order by updated_at desc
      limit 1
    `,
    [name]
  );
  const row = q.rows[0];
  return row ? mapCachedTemplate(row) : null;
}

export async function listTemplateFavorites(): Promise<string[]> {
  const db = getDbPool();
  if (!db) return [];
  const q = await db.query<{ template_name: string }>(
    `
      select template_name
      from whatsapp_template_favorites
      order by created_at desc
    `
  );
  return q.rows.map((row) => row.template_name);
}

export async function addTemplateFavorite(templateName: string): Promise<boolean> {
  const db = getDbPool();
  if (!db) return false;
  const name = String(templateName || "").trim();
  if (!name) return false;
  const q = await db.query(
    `
      insert into whatsapp_template_favorites (template_name)
      values ($1::text)
      on conflict (template_name) do nothing
    `,
    [name]
  );
  return (q.rowCount || 0) > 0;
}

export async function removeTemplateFavorite(templateName: string): Promise<boolean> {
  const db = getDbPool();
  if (!db) return false;
  const name = String(templateName || "").trim();
  if (!name) return false;
  const q = await db.query("delete from whatsapp_template_favorites where template_name = $1::text", [name]);
  return (q.rowCount || 0) > 0;
}

export async function sendZokoTemplateMessage(input: {
  phoneNumber: string;
  templateName: string;
  language?: string;
  variables?: string[];
}): Promise<{
  ok: boolean;
  externalId?: string;
  error?: string;
  payload?: unknown;
  status?: number | null;
  responseBody?: unknown;
  attempted?: Array<{ type: string; language: string; status: number | null }>;
}> {
  const auth = zokoAuthHeader();
  const apiUrl = String(env.ZOKO_SEND_TEMPLATE_API_URL || env.ZOKO_API_URL || "").trim();
  if (!apiUrl || !auth.value) return { ok: false, error: "zoko_not_configured", status: null };
  const channel = String(env.ZOKO_CHANNEL || "whatsapp").trim();
  const language = String(input.language || env.ZOKO_TEMPLATE_LANGUAGE || "fr").trim();
  const languageVariants = buildLanguageVariants(language);
  const variables = Array.isArray(input.variables) ? input.variables.map((v) => String(v || "")) : [];

  const payloadVariants: Array<{ type: string; language: string; payload: Record<string, unknown> }> = [];
  for (const lang of languageVariants) {
    payloadVariants.push({
      type: "template",
      language: lang,
      payload: {
        channel,
        recipient: input.phoneNumber,
        type: "template",
        templateId: input.templateName,
        templateLanguage: lang,
        templateArgs: variables
      }
    });
    payloadVariants.push({
      type: "buttonTemplate",
      language: lang,
      payload: {
        channel,
        recipient: input.phoneNumber,
        type: "buttonTemplate",
        templateId: input.templateName,
        templateLanguage: lang,
        templateArgs: variables
      }
    });
    payloadVariants.push({
      type: "richTemplate",
      language: lang,
      payload: {
        channel,
        recipient: input.phoneNumber,
        type: "richTemplate",
        templateId: input.templateName,
        templateLanguage: lang,
        templateArgs: variables,
        templateName: input.templateName,
        language: lang,
        variables
      }
    });
  }

  let lastStatus: number | null = null;
  let lastBody: unknown = null;
  const attempted: Array<{ type: string; language: string; status: number | null }> = [];
  for (const variant of payloadVariants) {
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [auth.key]: auth.value
        },
        body: JSON.stringify(variant.payload)
      });
      const raw = await res.text();
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      lastStatus = res.status;
      lastBody = parsed;
      attempted.push({ type: variant.type, language: variant.language, status: res.status });
      if (res.ok) {
        const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        const externalId = String(obj.id || obj.messageId || obj.external_id || "").trim() || undefined;
        return { ok: true, externalId, payload: parsed, status: res.status, responseBody: parsed, attempted };
      }
    } catch {
      // continue variants
      attempted.push({ type: variant.type, language: variant.language, status: null });
    }
  }
  return {
    ok: false,
    error: "zoko_template_send_failed",
    status: lastStatus,
    responseBody: lastBody,
    attempted
  };
}
