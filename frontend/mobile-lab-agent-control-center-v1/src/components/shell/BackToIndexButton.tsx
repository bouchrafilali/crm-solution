import { ArrowLeft } from "lucide-react";

export function BackToIndexButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-cyan-200/45 hover:bg-cyan-300/10"
    >
      <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
      Back to Index
    </button>
  );
}
