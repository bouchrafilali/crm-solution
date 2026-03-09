import { LearningEvent } from "../types.js";
import { byId } from "../mock-data.js";

interface LearningEventCardProps {
  event: LearningEvent;
  onOpenLead: (leadId: string) => void;
}

export function LearningEventCard({ event, onOpenLead }: LearningEventCardProps) {
  return (
    <button
      type="button"
      onClick={() => onOpenLead(event.leadId)}
      className="ml-panel-soft ml-interactive w-full rounded-xl p-3 text-left"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">{byId.lead[event.leadId]?.name ?? event.leadId}</p>
        <span className="ml-code text-[11px] text-slate-500">{event.timestamp}</span>
      </div>

      <div className="mt-2 space-y-1.5 text-xs">
        <p className="line-clamp-2 text-slate-400">
          <span className="font-semibold text-slate-300">AI:</span> {event.aiSuggestion}
        </p>
        <p className="line-clamp-2 text-slate-300">
          <span className="font-semibold text-slate-200">Human:</span> {event.finalHumanVersion}
        </p>
        <p className="text-slate-500">{event.deltaSummary}</p>
      </div>
    </button>
  );
}
