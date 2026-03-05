import test from "node:test";
import assert from "node:assert/strict";
import { applySimulation, aggregateMonthly, deriveCapacityLimitOrdersPerDay, type BaselineDailyPoint } from "./forecastSimulation.js";

function baseline(days = 120): BaselineDailyPoint[] {
  const rows: BaselineDailyPoint[] = [];
  const start = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + (i * 86400000));
    const orders = i % 11 === 0 ? 0 : 10 + (i % 5);
    const revenue = orders * 1000;
    rows.push({
      date: d.toISOString().slice(0, 10),
      orders,
      revenue_mad: revenue
    });
  }
  return rows;
}

test("aggregateMonthly aggregates by month", () => {
  const rows = baseline(62);
  const monthly = aggregateMonthly(rows);
  assert.ok(monthly.length >= 2);
  assert.equal(monthly[0].month, "2026-01");
  assert.equal(monthly[1].month, "2026-02");
});

test("applySimulation applies deterministic driver factors", () => {
  const rows = baseline(30);
  const result = applySimulation(rows, {
    trafficPct: 10,
    conversionPct: 5,
    aovPct: 8,
    showroomEnabled: false,
    showroomStartMonth: null,
    capacityEnabled: false
  });
  assert.ok(result.totals.revenue_365 > result.totals.baseline_revenue_365);
  assert.ok(result.totals.orders_365 > result.totals.baseline_orders_365);
  assert.equal(result.constraints.capped_days, 0);
});

test("applySimulation preserves zero-order days", () => {
  const rows = baseline(40);
  const result = applySimulation(rows, {
    trafficPct: 50,
    conversionPct: 30,
    aovPct: 10,
    showroomEnabled: true,
    showroomStartMonth: "2026-02",
    capacityEnabled: false
  });
  const baselineZeroDays = rows.filter((r) => r.orders === 0).length;
  const simulatedZeroDays = result.simulatedDaily.filter((r) => r.orders === 0).length;
  assert.equal(simulatedZeroDays, baselineZeroDays);
});

test("capacity constraint caps orders and raises warning when frequent", () => {
  const rows = baseline(100);
  const result = applySimulation(rows, {
    trafficPct: 40,
    conversionPct: 20,
    aovPct: 0,
    showroomEnabled: false,
    showroomStartMonth: null,
    capacityEnabled: true,
    capacityLimitOrdersPerDay: 8
  });
  assert.ok(result.constraints.capped_days > 0);
  assert.equal(result.constraints.warning, true);
});

test("deriveCapacityLimitOrdersPerDay returns p90-based positive integer", () => {
  const limit = deriveCapacityLimitOrdersPerDay(baseline(90));
  assert.ok(Number.isInteger(limit));
  assert.ok(limit >= 1);
});
