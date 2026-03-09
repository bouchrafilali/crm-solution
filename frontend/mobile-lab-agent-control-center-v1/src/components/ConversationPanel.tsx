import { ConversationMessage } from "../types.js";
import { cn } from "../utils.js";

interface ConversationPanelProps {
  messages: ConversationMessage[];
  leadName?: string;
  leadStage?: string;
  language?: string;
}

function bubbleClass(actor: ConversationMessage["actor"]): string {
  if (actor === "client") return "border-slate-600/55 bg-slate-800/90 text-slate-100";
  if (actor === "operator") return "border-sky-300/35 bg-sky-500/14 text-sky-100";
  return "border-emerald-300/35 bg-emerald-500/14 text-emerald-100";
}

function actorLabel(actor: ConversationMessage["actor"]): string {
  if (actor === "client") return "Client";
  if (actor === "operator") return "Operator";
  return "Brand";
}

function stateIcon(state: ConversationMessage["state"]): string {
  if (state === "sent") return "✓";
  if (state === "delivered") return "✓✓";
  return "✓✓";
}

export function ConversationPanel({ messages, leadName = "Lead", leadStage = "Conversation active", language = "FR" }: ConversationPanelProps) {
  return (
    <div className="ml-panel rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-600/55 bg-slate-800 text-xs font-semibold text-slate-100">
            {leadName
              .split(/\s+/)
              .slice(0, 2)
              .map((chunk) => chunk[0]?.toUpperCase() ?? "")
              .join("")}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-100">{leadName}</h3>
            <p className="text-[11px] text-slate-400">
              {leadStage} • {language}
            </p>
          </div>
        </div>
        <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-200">
          WhatsApp Live
        </span>
      </div>

      <div className="ml-panel-soft scroll-dark relative max-h-[560px] space-y-3 overflow-y-auto rounded-xl p-3.5">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(56,189,248,0.08),transparent_35%),radial-gradient(circle_at_100%_100%,rgba(16,185,129,0.08),transparent_32%)]" />
        {messages.map((message) => (
          <div key={message.id} className={cn("relative flex", message.actor === "client" ? "justify-start" : "justify-end")}>
            <div className={cn("max-w-[82%] rounded-2xl border p-3.5", bubbleClass(message.actor))}>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{actorLabel(message.actor)}</p>

              {message.replyTo ? (
                <div className="mb-2 rounded-lg border border-slate-500/35 bg-black/18 px-2.5 py-1.5">
                  <p className="text-[10px] uppercase tracking-[0.1em] text-slate-400">Replying to {message.replyTo.actor}</p>
                  <p className="line-clamp-1 text-xs text-slate-300">{message.replyTo.text}</p>
                </div>
              ) : null}

              <p className="text-[13px] leading-relaxed">{message.text}</p>

              <div className="mt-2.5 flex items-center justify-end gap-2 text-[11px] text-slate-400">
                <span>{message.timestamp}</span>
                <span className={message.state === "read" ? "text-sky-300" : "text-slate-500"}>{stateIcon(message.state)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <button className="ml-button ml-button-primary rounded-xl px-2 py-2 font-medium">Analyze Now</button>
        <button className="ml-button rounded-xl px-2 py-2 font-medium">Generate Replies</button>
        <button className="ml-button rounded-xl px-2 py-2 font-medium">Request Missing Info</button>
        <button className="ml-button rounded-xl px-2 py-2 font-medium">Create Task</button>
      </div>
    </div>
  );
}
