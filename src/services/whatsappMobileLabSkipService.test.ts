import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MobileLabSkipError,
  clearSkippedMobileLabItem,
  listActiveSkippedItems,
  skipMobileLabItem
} from "./whatsappMobileLabSkipService.js";
import type { MobileLabFeedType, MobileLabSkipRecord } from "../db/whatsappMobileLabSkipRepo.js";

function createInMemorySkipDeps(nowIso = "2026-03-07T12:00:00.000Z") {
  const store = new Map<string, MobileLabSkipRecord>();
  const key = (leadId: string, feedType: MobileLabFeedType) => `${feedType}:${leadId}`;

  return {
    deps: {
      saveSkip: async (input: { leadId: string; feedType: MobileLabFeedType; skippedUntil: string; reason?: string | null }) => {
        const existing = store.get(key(input.leadId, input.feedType));
        const row: MobileLabSkipRecord = {
          leadId: input.leadId,
          feedType: input.feedType,
          skippedUntil: input.skippedUntil,
          reason: input.reason ?? null,
          createdAt: existing?.createdAt || nowIso,
          updatedAt: nowIso
        };
        store.set(key(input.leadId, input.feedType), row);
        return row;
      },
      clearSkip: async (input: { leadId: string; feedType: MobileLabFeedType }) => {
        return store.delete(key(input.leadId, input.feedType));
      },
      listActive: async (queryNowIso?: string) => {
        const nowMs = new Date(queryNowIso || nowIso).getTime();
        return Array.from(store.values()).filter((row) => new Date(row.skippedUntil).getTime() > nowMs);
      },
      now: () => new Date(nowIso)
    }
  };
}

test("invalid custom timestamp rejected", async () => {
  const { deps } = createInMemorySkipDeps();
  await assert.rejects(
    () =>
      skipMobileLabItem(
        {
          leadId: "11111111-1111-1111-1111-111111111111",
          feedType: "active",
          mode: "custom",
          customUntil: "not-a-date"
        },
        deps
      ),
    (error: unknown) => error instanceof MobileLabSkipError && error.code === "mobile_lab_skip_invalid_custom_until"
  );
});

test("unskip restores item", async () => {
  const mem = createInMemorySkipDeps();
  await skipMobileLabItem(
    {
      leadId: "11111111-1111-1111-1111-111111111111",
      feedType: "active",
      mode: "1_hour",
      reason: "later"
    },
    mem.deps
  );

  let active = await listActiveSkippedItems(mem.deps);
  assert.equal(active.length, 1);

  await clearSkippedMobileLabItem(
    {
      leadId: "11111111-1111-1111-1111-111111111111",
      feedType: "active"
    },
    mem.deps
  );

  active = await listActiveSkippedItems(mem.deps);
  assert.equal(active.length, 0);
});
