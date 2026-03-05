import { getDbPool } from "./client.js";

export type SuggestionLearningSettings = {
  id: number;
  learning_window_days: number;
  min_samples: number;
  success_weight: number;
  accepted_weight: number;
  lost_weight: number;
  boost_min: number;
  boost_max: number;
  success_outcomes: string[];
  failure_outcomes: string[];
  updated_at: string;
};

const DEFAULT_SETTINGS: Omit<SuggestionLearningSettings, "updated_at"> = {
  id: 1,
  learning_window_days: 90,
  min_samples: 3,
  success_weight: 20,
  accepted_weight: 10,
  lost_weight: 14,
  boost_min: -15,
  boost_max: 20,
  success_outcomes: ["CONFIRMED", "CONVERTED"],
  failure_outcomes: ["LOST"]
};

function dbOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("db_unavailable");
  return db;
}

function mapRow(row: Record<string, unknown> | undefined): SuggestionLearningSettings {
  if (!row) {
    return {
      ...DEFAULT_SETTINGS,
      updated_at: new Date().toISOString()
    };
  }
  return {
    id: Number(row.id || 1),
    learning_window_days: Number(row.learning_window_days || DEFAULT_SETTINGS.learning_window_days),
    min_samples: Number(row.min_samples || DEFAULT_SETTINGS.min_samples),
    success_weight: Number(row.success_weight || DEFAULT_SETTINGS.success_weight),
    accepted_weight: Number(row.accepted_weight || DEFAULT_SETTINGS.accepted_weight),
    lost_weight: Number(row.lost_weight || DEFAULT_SETTINGS.lost_weight),
    boost_min: Number(row.boost_min ?? DEFAULT_SETTINGS.boost_min),
    boost_max: Number(row.boost_max ?? DEFAULT_SETTINGS.boost_max),
    success_outcomes: Array.isArray(row.success_outcomes)
      ? row.success_outcomes.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
      : DEFAULT_SETTINGS.success_outcomes,
    failure_outcomes: Array.isArray(row.failure_outcomes)
      ? row.failure_outcomes.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
      : DEFAULT_SETTINGS.failure_outcomes,
    updated_at: String(row.updated_at || new Date().toISOString())
  };
}

async function ensureRow() {
  const db = dbOrThrow();
  await db.query(
    `
      insert into suggestion_learning_settings (
        id, learning_window_days, min_samples, success_weight, accepted_weight, lost_weight,
        boost_min, boost_max, success_outcomes, failure_outcomes
      )
      values ($1::int, $2::int, $3::int, $4::int, $5::int, $6::int, $7::int, $8::int, $9::text[], $10::text[])
      on conflict (id) do nothing
    `,
    [
      1,
      DEFAULT_SETTINGS.learning_window_days,
      DEFAULT_SETTINGS.min_samples,
      DEFAULT_SETTINGS.success_weight,
      DEFAULT_SETTINGS.accepted_weight,
      DEFAULT_SETTINGS.lost_weight,
      DEFAULT_SETTINGS.boost_min,
      DEFAULT_SETTINGS.boost_max,
      DEFAULT_SETTINGS.success_outcomes,
      DEFAULT_SETTINGS.failure_outcomes
    ]
  );
}

export async function getSuggestionLearningSettings(): Promise<SuggestionLearningSettings> {
  await ensureRow();
  const db = dbOrThrow();
  const q = await db.query<Record<string, unknown>>("select * from suggestion_learning_settings where id = 1");
  return mapRow(q.rows[0]);
}

export async function updateSuggestionLearningSettings(
  patch: Partial<Omit<SuggestionLearningSettings, "id" | "updated_at">>
): Promise<SuggestionLearningSettings> {
  await ensureRow();
  const db = dbOrThrow();
  const q = await db.query<Record<string, unknown>>(
    `
      update suggestion_learning_settings
      set
        learning_window_days = coalesce($1::int, learning_window_days),
        min_samples = coalesce($2::int, min_samples),
        success_weight = coalesce($3::int, success_weight),
        accepted_weight = coalesce($4::int, accepted_weight),
        lost_weight = coalesce($5::int, lost_weight),
        boost_min = coalesce($6::int, boost_min),
        boost_max = coalesce($7::int, boost_max),
        success_outcomes = coalesce($8::text[], success_outcomes),
        failure_outcomes = coalesce($9::text[], failure_outcomes),
        updated_at = now()
      where id = 1
      returning *
    `,
    [
      patch.learning_window_days ?? null,
      patch.min_samples ?? null,
      patch.success_weight ?? null,
      patch.accepted_weight ?? null,
      patch.lost_weight ?? null,
      patch.boost_min ?? null,
      patch.boost_max ?? null,
      patch.success_outcomes ?? null,
      patch.failure_outcomes ?? null
    ]
  );
  return mapRow(q.rows[0]);
}

export async function resetSuggestionLearningSettings(): Promise<SuggestionLearningSettings> {
  const db = dbOrThrow();
  await ensureRow();
  const q = await db.query<Record<string, unknown>>(
    `
      update suggestion_learning_settings
      set
        learning_window_days = $1::int,
        min_samples = $2::int,
        success_weight = $3::int,
        accepted_weight = $4::int,
        lost_weight = $5::int,
        boost_min = $6::int,
        boost_max = $7::int,
        success_outcomes = $8::text[],
        failure_outcomes = $9::text[],
        updated_at = now()
      where id = 1
      returning *
    `,
    [
      DEFAULT_SETTINGS.learning_window_days,
      DEFAULT_SETTINGS.min_samples,
      DEFAULT_SETTINGS.success_weight,
      DEFAULT_SETTINGS.accepted_weight,
      DEFAULT_SETTINGS.lost_weight,
      DEFAULT_SETTINGS.boost_min,
      DEFAULT_SETTINGS.boost_max,
      DEFAULT_SETTINGS.success_outcomes,
      DEFAULT_SETTINGS.failure_outcomes
    ]
  );
  return mapRow(q.rows[0]);
}
