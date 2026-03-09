import { ConversationMessage } from "../types.js";

interface ConversationPanelProps {
  messages: ConversationMessage[];
}

function bubbleClass(actor: ConversationMessage["actor"]): string {
  if (actor === "client") return "ml-0 mr-8 bg-zinc-800 text-zinc-100 border-zinc-700";
  if (actor === "operator") return "ml-8 mr-0 bg-cyan-500/12 text-cyan-100 border-cyan-500/30";
  return "ml-8 mr-0 bg-emerald-500/12 text-emerald-100 border-emerald-500/30";
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

export function ConversationPanel({ messages }: ConversationPanelProps) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-100">Conversation</h3>
        <span className="text-xs text-zinc-500">WhatsApp thread</span>
      </div>

      <div className="scroll-dark max-h-[560px] space-y-3 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
        {messages.map((message) => (
          <div key={message.id} className={`rounded-2xl border p-3 ${bubbleClass(message.actor)}`}>
            <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-400">{actorLabel(message.actor)}</p>

            {message.replyTo ? (
              <div className="mb-2 rounded-lg border border-zinc-700/80 bg-zinc-900/70 px-2 py-1">
                <p className="text-[11px] text-zinc-500">Replying to {message.replyTo.actor}</p>
                <p className="line-clamp-1 text-xs text-zinc-400">{message.replyTo.text}</p>
              </div>
            ) : null}

            <p className="text-sm leading-relaxed">{message.text}</p>

            <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-zinc-500">
              <span>{message.timestamp}</span>
              <span className={message.state === "read" ? "text-cyan-300" : "text-zinc-500"}>{stateIcon(message.state)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <button className="rounded-xl border border-zinc-700 bg-zinc-800/70 px-2 py-2 text-zinc-200 transition hover:border-zinc-600">Analyze Now</button>
        <button className="rounded-xl border border-zinc-700 bg-zinc-800/70 px-2 py-2 text-zinc-200 transition hover:border-zinc-600">Generate Replies</button>
        <button className="rounded-xl border border-zinc-700 bg-zinc-800/70 px-2 py-2 text-zinc-200 transition hover:border-zinc-600">Request Missing Info</button>
        <button className="rounded-xl border border-zinc-700 bg-zinc-800/70 px-2 py-2 text-zinc-200 transition hover:border-zinc-600">Create Task</button>
      </div>
    </div>
  );
}
