import React from "react";
import { motion } from "framer-motion";
import { SuggestedReply } from "../types.js";
import { cn } from "../utils.js";

interface SuggestedReplyCardProps {
  reply: SuggestedReply;
  selected: boolean;
  onSelect: (id: string) => void;
  confidence?: number;
  recommendation?: "primary" | "secondary";
  onAction?: (action: "approve" | "edit" | "reject" | "insert", replyId: string) => void;
}

export function SuggestedReplyCard({
  reply,
  selected,
  onSelect,
  confidence,
  recommendation = "secondary",
  onAction
}: SuggestedReplyCardProps) {
  const safeConfidence = typeof confidence === "number" ? Math.max(0, Math.min(100, Math.round(confidence))) : null;
  const reasonShort = String(reply.reason_short || "").trim();

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
        <div className="flex items-center gap-1.5">
          {recommendation === "primary" ? (
            <span className="rounded-md border border-sky-300/30 bg-sky-500/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-sky-100">
              Recommended
            </span>
          ) : null}
          <span className="ml-chip rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">{reply.language}</span>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {reply.intent} • {reply.tone}
      </p>
      {reasonShort ? (
        <div className="mt-2 rounded-lg border border-slate-700/40 bg-slate-900/45 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Why</p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{reasonShort}</p>
        </div>
      ) : null}
      <p className="ml-panel-soft mt-3 rounded-xl px-3 py-2.5 text-sm leading-relaxed text-slate-200">{reply.content}</p>

      {safeConfidence !== null ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Confidence</span>
            <span className="ml-code text-[11px] text-slate-300">{safeConfidence}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${safeConfidence}%` }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="h-full rounded-full bg-gradient-to-r from-sky-400/75 to-emerald-300/75"
            />
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onAction?.("approve", reply.id);
          }}
          className="ml-button ml-button-primary rounded-lg px-2.5 py-1 font-medium"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onAction?.("edit", reply.id);
          }}
          className="ml-button rounded-lg px-2.5 py-1 font-medium"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onAction?.("reject", reply.id);
          }}
          className="ml-button ml-button-danger rounded-lg px-2.5 py-1 font-medium"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onAction?.("insert", reply.id);
          }}
          className="ml-button rounded-lg px-2.5 py-1 font-medium"
        >
          Insert
        </button>
      </div>
    </motion.article>
  );
}
