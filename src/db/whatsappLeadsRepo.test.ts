import { strict as assert } from "node:assert";
import { test } from "node:test";
import { filterLeadRowsByRecentActivity, type LeadActivityWindowRow } from "./whatsappLeadsRepo.js";

function row(input: {
  id: string;
  createdAt: string;
  lastActivityAt?: string | null;
  stage?: string;
}): LeadActivityWindowRow {
  return {
    id: input.id,
    created_at: input.createdAt,
    last_activity_at: input.lastActivityAt ?? null,
    stage: input.stage ?? "NEW"
  };
}

test("old lead with new inbound activity is included", () => {
  const rows = [
    row({
      id: "lead-old-active",
      createdAt: "2025-01-01T00:00:00.000Z",
      lastActivityAt: "2026-03-07T10:00:00.000Z",
      stage: "QUALIFIED"
    })
  ];

  const out = filterLeadRowsByRecentActivity(rows, {
    days: 30,
    stage: "ALL",
    nowIso: "2026-03-07T12:00:00.000Z"
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].id, "lead-old-active");
});

test("new lead is included", () => {
  const rows = [
    row({
      id: "lead-new",
      createdAt: "2026-03-06T09:00:00.000Z",
      stage: "NEW"
    })
  ];

  const out = filterLeadRowsByRecentActivity(rows, {
    days: 30,
    stage: "ALL",
    nowIso: "2026-03-07T12:00:00.000Z"
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].id, "lead-new");
});

test("inactive old lead outside range is excluded", () => {
  const rows = [
    row({
      id: "lead-old-inactive",
      createdAt: "2025-01-01T00:00:00.000Z",
      lastActivityAt: "2025-01-10T00:00:00.000Z",
      stage: "PRICE_SENT"
    })
  ];

  const out = filterLeadRowsByRecentActivity(rows, {
    days: 30,
    stage: "ALL",
    nowIso: "2026-03-07T12:00:00.000Z"
  });

  assert.equal(out.length, 0);
});

test("ordering by recent activity works", () => {
  const rows = [
    row({
      id: "lead-a",
      createdAt: "2025-01-01T00:00:00.000Z",
      lastActivityAt: "2026-03-07T08:00:00.000Z",
      stage: "QUALIFIED"
    }),
    row({
      id: "lead-b",
      createdAt: "2026-03-07T09:00:00.000Z",
      lastActivityAt: null,
      stage: "NEW"
    }),
    row({
      id: "lead-c",
      createdAt: "2025-11-20T00:00:00.000Z",
      lastActivityAt: "2026-03-07T11:00:00.000Z",
      stage: "DEPOSIT_PENDING"
    })
  ];

  const out = filterLeadRowsByRecentActivity(rows, {
    days: 30,
    stage: "ALL",
    nowIso: "2026-03-07T12:00:00.000Z"
  });

  assert.deepEqual(
    out.map((item) => item.id),
    ["lead-c", "lead-b", "lead-a"]
  );
});

