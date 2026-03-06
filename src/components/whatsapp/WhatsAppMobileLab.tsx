import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  MobileChatMessage,
  MobileLeadThread,
  MobileSuggestionCard
} from "../../modules/whatsapp/mobileLabAdapter.js";

type Props = {
  thread: MobileLeadThread;
  mode: "mock" | "live";
};

function toTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function WhatsAppMobileLab({ thread, mode }: Props) {
  const [chat, setChat] = useState<MobileChatMessage[]>(thread.messages);
  const [draftSequence, setDraftSequence] = useState<string[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string>("");
  const [isSending, setIsSending] = useState(false);
  const [isMobileViewport] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 768px)").matches : true
  );

  const suggestions = useMemo(() => thread.suggestions || [], [thread.suggestions]);

  async function sendSequence(messages: string[]) {
    if (!messages.length || isSending) return;
    setIsSending(true);
    try {
      for (let i = 0; i < messages.length; i += 1) {
        const text = String(messages[i] || "").trim();
        if (!text) continue;
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 380 + i * 120);
        });
        setChat((prev) => [
          ...prev,
          {
            id: "lab_out_" + Date.now() + "_" + i,
            from: "brand",
            text,
            time: new Date().toISOString(),
            status: "sent"
          }
        ]);
      }
    } finally {
      setIsSending(false);
      setDraftSequence([]);
      setActiveSuggestionId("");
    }
  }

  function onInsertSuggestion(suggestion: MobileSuggestionCard) {
    setDraftSequence(suggestion.messages.slice(0, 4));
    setActiveSuggestionId(suggestion.id);
  }

  function onSendSuggestion(suggestion: MobileSuggestionCard) {
    setActiveSuggestionId(suggestion.id);
    void sendSequence(suggestion.messages.slice(0, 4));
  }

  return (
    <div style={styles.page}>
      <div style={{ ...styles.phoneShell, ...(isMobileViewport ? styles.phoneShellMobile : styles.phoneShellDesktop) }}>
        <header style={styles.header}>
          <div style={styles.avatar} />
          <div>
            <div style={styles.title}>{thread.name}</div>
            <div style={styles.subtitle}>Mobile Lab · {thread.stage} · {thread.urgency} · {mode.toUpperCase()}</div>
          </div>
        </header>

        <section style={styles.chatArea}>
          <AnimatePresence initial={false}>
            {chat.map((msg) => {
              const isOut = msg.from === "brand";
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  style={{
                    ...styles.row,
                    justifyContent: isOut ? "flex-end" : "flex-start"
                  }}
                >
                  <div
                    style={{
                      ...styles.bubble,
                      ...(isOut ? styles.bubbleOut : styles.bubbleIn)
                    }}
                  >
                    <div style={styles.bubbleText}>{msg.text}</div>
                    <div style={styles.bubbleTime}>{toTime(msg.time)}</div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </section>

        <section style={styles.suggestionsWrap}>
          <div style={styles.sectionTitle}>AI Suggestions</div>
          <div style={styles.suggestionScroller} aria-label="AI suggestions horizontal list">
            {suggestions.length === 0 ? (
              <div style={styles.emptyState}>
                No suggestion yet. Switch to mock mode or connect live suggestion source.
              </div>
            ) : null}
            {suggestions.map((s) => {
              const active = s.id === activeSuggestionId;
              return (
                <motion.article
                  key={s.id}
                  whileTap={{ scale: 0.98 }}
                  style={{
                    ...styles.suggestionCard,
                    ...(active ? styles.suggestionCardActive : null)
                  }}
                >
                  <div style={styles.suggestionTitle}>{s.title}</div>
                  <div style={styles.suggestionRationale}>{s.rationale}</div>
                  <div style={styles.previewList}>
                    {s.messages.map((line, idx) => (
                      <div key={s.id + "_line_" + idx} style={styles.previewLine}>
                        {idx + 1}. {line}
                      </div>
                    ))}
                  </div>
                  <div style={styles.suggestionActions}>
                    <button
                      type="button"
                      style={styles.btnGhost}
                      onClick={() => onInsertSuggestion(s)}
                      disabled={isSending}
                    >
                      Insert
                    </button>
                    <button
                      type="button"
                      style={styles.btnPrimary}
                      onClick={() => onSendSuggestion(s)}
                      disabled={isSending}
                    >
                      {isSending && active ? "Sending…" : "Send"}
                    </button>
                  </div>
                </motion.article>
              );
            })}
          </div>
        </section>

        <footer style={styles.composer}>
          <div style={styles.composerLabel}>Insert + Send Sequence</div>
          <div style={styles.draftWrap}>
            {draftSequence.length === 0 ? (
              <div style={styles.draftEmpty}>No inserted sequence</div>
            ) : (
              draftSequence.map((line, idx) => (
                <div key={"draft_" + idx} style={styles.draftLine}>
                  {idx + 1}. {line}
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            style={styles.btnPrimaryWide}
            disabled={isSending || draftSequence.length < 2}
            onClick={() => void sendSequence(draftSequence)}
          >
            {isSending ? "Sending sequence…" : "Send Inserted Sequence"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100dvh",
    background: "linear-gradient(180deg, #0a101f 0%, #10192b 100%)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "10px"
  },
  phoneShell: {
    width: "100%",
    maxWidth: "430px",
    height: "100dvh",
    maxHeight: "900px",
    borderRadius: "24px",
    overflow: "hidden",
    background: "#0e1627",
    border: "1px solid #1c2b44",
    display: "grid",
    gridTemplateRows: "64px 1fr auto auto"
  },
  phoneShellDesktop: {
    boxShadow: "0 26px 80px rgba(0,0,0,.45)"
  },
  phoneShellMobile: {
    borderRadius: "0",
    maxWidth: "100%",
    maxHeight: "100dvh",
    border: "none"
  },
  header: {
    background: "#121f35",
    borderBottom: "1px solid #213452",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 12px"
  },
  avatar: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "linear-gradient(180deg, #42c4ff, #2e7cff)"
  },
  title: {
    color: "#f4f8ff",
    fontSize: "14px",
    fontWeight: 700
  },
  subtitle: {
    color: "#93abc9",
    fontSize: "11px"
  },
  chatArea: {
    overflowY: "auto",
    padding: "10px",
    background: "radial-gradient(120% 120% at 50% 0%, #0f1d35 0%, #0c1424 70%)"
  },
  row: {
    display: "flex",
    marginBottom: "8px"
  },
  bubble: {
    maxWidth: "84%",
    borderRadius: "14px",
    padding: "8px 10px",
    boxShadow: "0 6px 22px rgba(0,0,0,.22)"
  },
  bubbleIn: {
    background: "#1b2a42",
    color: "#e8f0ff"
  },
  bubbleOut: {
    background: "#1f7bf5",
    color: "#fff"
  },
  bubbleText: {
    fontSize: "13px",
    lineHeight: 1.35,
    wordBreak: "break-word"
  },
  bubbleTime: {
    marginTop: "3px",
    fontSize: "10px",
    opacity: 0.75,
    textAlign: "right"
  },
  suggestionsWrap: {
    borderTop: "1px solid #213452",
    background: "#0f1b2f",
    padding: "10px 8px 8px"
  },
  sectionTitle: {
    color: "#bdd2ed",
    fontSize: "11px",
    marginBottom: "8px",
    paddingLeft: "4px"
  },
  suggestionScroller: {
    display: "flex",
    overflowX: "auto",
    gap: "10px",
    scrollSnapType: "x mandatory",
    paddingBottom: "2px"
  },
  emptyState: {
    minWidth: "84%",
    border: "1px dashed #33517a",
    borderRadius: "12px",
    color: "#9ab5d4",
    background: "#11213a",
    padding: "12px",
    fontSize: "12px"
  },
  suggestionCard: {
    minWidth: "84%",
    scrollSnapAlign: "start",
    background: "#142741",
    border: "1px solid #223b5f",
    borderRadius: "14px",
    padding: "10px",
    color: "#ecf5ff"
  },
  suggestionCardActive: {
    borderColor: "#4ca4ff",
    boxShadow: "0 0 0 1px #4ca4ff inset"
  },
  suggestionTitle: {
    fontSize: "13px",
    fontWeight: 700,
    marginBottom: "4px"
  },
  suggestionRationale: {
    fontSize: "11px",
    color: "#98b5d6",
    marginBottom: "8px"
  },
  previewList: {
    display: "grid",
    gap: "4px",
    marginBottom: "10px"
  },
  previewLine: {
    fontSize: "11px",
    color: "#d8e8fb",
    background: "#1a314f",
    borderRadius: "8px",
    padding: "6px"
  },
  suggestionActions: {
    display: "flex",
    gap: "8px"
  },
  btnGhost: {
    flex: 1,
    borderRadius: "9px",
    border: "1px solid #34537b",
    background: "transparent",
    color: "#d8e8fb",
    padding: "8px 10px",
    fontSize: "12px"
  },
  btnPrimary: {
    flex: 1,
    borderRadius: "9px",
    border: "none",
    background: "#2a8cff",
    color: "#fff",
    padding: "8px 10px",
    fontSize: "12px",
    fontWeight: 700
  },
  composer: {
    borderTop: "1px solid #213452",
    padding: "10px",
    background: "#121f35"
  },
  composerLabel: {
    fontSize: "11px",
    color: "#98b5d6",
    marginBottom: "6px"
  },
  draftWrap: {
    minHeight: "44px",
    maxHeight: "104px",
    overflowY: "auto",
    border: "1px solid #294366",
    borderRadius: "10px",
    background: "#0f1b2f",
    padding: "6px",
    marginBottom: "8px"
  },
  draftEmpty: {
    color: "#6f8fb2",
    fontSize: "12px"
  },
  draftLine: {
    color: "#d7e8fc",
    fontSize: "12px",
    marginBottom: "4px"
  },
  btnPrimaryWide: {
    width: "100%",
    borderRadius: "10px",
    border: "none",
    background: "#2a8cff",
    color: "#fff",
    padding: "10px 12px",
    fontSize: "13px",
    fontWeight: 700
  }
};
