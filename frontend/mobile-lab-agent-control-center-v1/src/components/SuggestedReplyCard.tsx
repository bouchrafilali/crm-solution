import { motion } from "framer-motion";
import { SuggestedReply } from "../types.js";
import { cn } from "../utils.js";

interface SuggestedReplyCardProps {
  reply: SuggestedReply;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function SuggestedReplyCard({ reply, selected, onSelect }: SuggestedReplyCardProps) {
  return (
    <motion.article
      layout
      whileHover={{ y: -2 }}
      onClick={() => onSelect(reply.id)}
      className={cn(
        "ml-panel ml-interactive cursor-pointer rounded-2xl p-4 transition",
        selected ? "border-sky-300/45 shadow-[0_16px_36px_-24px_rgba(69,193,255,0.45)]" : ""
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">{reply.label}</p>
        <span className="ml-chip rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">{reply.language}</span>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {reply.intent} • {reply.tone}
      </p>
      <p className="ml-panel-soft mt-3 rounded-xl px-3 py-2.5 text-sm leading-relaxed text-slate-200">{reply.content}</p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button className="ml-button ml-button-primary rounded-lg px-2.5 py-1 font-medium">Approve</button>
        <button className="ml-button rounded-lg px-2.5 py-1 font-medium">Edit</button>
        <button className="ml-button ml-button-danger rounded-lg px-2.5 py-1 font-medium">Reject</button>
        <button className="ml-button rounded-lg px-2.5 py-1 font-medium">Insert</button>
      </div>
    </motion.article>
  );
}
