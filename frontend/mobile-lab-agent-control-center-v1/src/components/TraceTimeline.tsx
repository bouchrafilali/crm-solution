import { RunRecord } from "../types.js";
import { StatusBadge } from "./StatusBadge.js";

interface TraceTimelineProps {
  timeline: RunRecord["trace"]["timeline"];
}

export function TraceTimeline({ timeline }: TraceTimelineProps) {
  return (
    <div className="relative space-y-3">
      <div className="absolute bottom-2 left-2 top-2 w-px bg-zinc-800" />
      {timeline.map((item) => (
        <div key={item.id} className="relative ml-0 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 pl-8">
          <span className="absolute left-[5px] top-4 h-3 w-3 rounded-full border border-zinc-600 bg-zinc-950" />
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-zinc-100">{item.title}</p>
              <p className="mt-0.5 text-xs text-zinc-400">{item.detail}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-500">{item.time}</span>
              <StatusBadge value={item.status} className="!px-2 !py-0.5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
