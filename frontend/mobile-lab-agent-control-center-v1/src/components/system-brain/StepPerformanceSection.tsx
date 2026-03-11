import { StepPerformanceRow, TokenEconomyPoint } from "../../system-brain-types.js";
import { SectionHeader } from "../SectionHeader.js";

function asPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function StepPerformanceSection({
  rows,
  tokenEconomy
}: {
  rows: StepPerformanceRow[];
  tokenEconomy: TokenEconomyPoint[];
}) {
  const maxTokens = Math.max(...tokenEconomy.map((point) => point.totalTokens), 1);

  return (
    <section className="ml-panel rounded-2xl p-4">
      <SectionHeader
        title="Step Performance + Token Economy"
        subtitle="Latency, reliability, cache efficiency, single-flight join rates, and token/cost footprint."
      />

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <div className="ml-table-shell overflow-x-auto rounded-xl">
          <table className="ml-table w-full min-w-[1120px] text-left text-xs">
            <thead>
              <tr>
                <th className="px-3 py-3">Step</th>
                <th className="px-3 py-3">Provider / Model</th>
                <th className="px-3 py-3">Avg Tokens</th>
                <th className="px-3 py-3">Cost / Run</th>
                <th className="px-3 py-3">Latency p50 / p95</th>
                <th className="px-3 py-3">Success</th>
                <th className="px-3 py-3">Fallback</th>
                <th className="px-3 py-3">Cache Hit</th>
                <th className="px-3 py-3">In-flight Join</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.step}-${row.provider}-${row.model}`}>
                  <td className="px-3 py-3 font-semibold text-slate-100">{row.step}</td>
                  <td className="px-3 py-3 text-slate-300">{row.provider} · {row.model}</td>
                  <td className="px-3 py-3 text-slate-300">in {row.avgInputTokens} / out {row.avgOutputTokens}</td>
                  <td className="px-3 py-3 text-slate-300">${row.avgCostUsd.toFixed(4)}</td>
                  <td className="px-3 py-3 text-slate-300">{row.p50LatencyMs} / {row.p95LatencyMs} ms</td>
                  <td className="px-3 py-3 text-emerald-300">{asPercent(row.successRate)}</td>
                  <td className="px-3 py-3 text-amber-300">{asPercent(row.fallbackRate)}</td>
                  <td className="px-3 py-3 text-cyan-300">{asPercent(row.cacheHitRate)}</td>
                  <td className="px-3 py-3 text-indigo-300">{asPercent(row.inflightJoinRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="ml-panel-soft rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Token Usage Trend</p>
          <div className="mt-3 space-y-2">
            {tokenEconomy.map((point) => (
              <div key={point.day}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300">{point.day}</span>
                  <span className="text-slate-500">{point.totalTokens.toLocaleString()} · ${point.totalCostUsd.toFixed(1)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-gradient-to-r from-cyan-400/70 to-teal-300/70" style={{ width: `${Math.max(8, (point.totalTokens / maxTokens) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
