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
        "cursor-pointer rounded-2xl border bg-zinc-900/80 p-4 transition",
        selected ? "border-cyan-400/50 shadow-[0_10px_32px_-14px_rgba(45,212,191,0.45)]" : "border-zinc-800 hover:border-zinc-700"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-zinc-100">{reply.label}</p>
        <span className="rounded-md border border-zinc-700 bg-zinc-800/70 px-2 py-0.5 text-[11px] text-zinc-300">{reply.language}</span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {reply.intent} • {reply.tone}
      </p>
      <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm leading-relaxed text-zinc-200">{reply.content}</p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-200">Approve</button>
        <button className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-zinc-200">Edit</button>
        <button className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-200">Reject</button>
        <button className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-cyan-200">Insert</button>
      </div>
    </motion.article>
  );
}
