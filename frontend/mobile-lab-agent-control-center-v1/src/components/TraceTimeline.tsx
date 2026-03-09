import { RunRecord } from "../types.js";
import { StatusBadge } from "./StatusBadge.js";

interface TraceTimelineProps {
  timeline: RunRecord["trace"]["timeline"];
}

export function TraceTimeline({ timeline }: TraceTimelineProps) {
  return (
    <div className="relative space-y-3">
      <div className="absolute bottom-2 left-2 top-2 w-px bg-slate-700/60" />
      {timeline.map((item) => (
        <div key={item.id} className="ml-panel-soft relative ml-0 rounded-xl p-3 pl-8">
          <span className="absolute left-[5px] top-4 h-3 w-3 rounded-full border border-slate-500 bg-slate-900" />
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-slate-100">{item.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{item.detail}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="ml-code text-[11px] text-slate-500">{item.time}</span>
              <StatusBadge value={item.status} className="!px-2 !py-0.5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
