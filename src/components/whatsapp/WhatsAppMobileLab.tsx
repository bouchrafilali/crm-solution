import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
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

type DevicePreset = "mobile" | "tablet" | "desktop";
type PreviewMode = "all" | DevicePreset;

const DEVICE_ORDER: DevicePreset[] = ["mobile", "tablet", "desktop"];

function toTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function deviceTitle(device: DevicePreset): string {
  if (device === "mobile") return "Mobile";
  if (device === "tablet") return "Tablet / iPad";
  return "Desktop";
}

export function WhatsAppMobileLab({ thread, mode }: Props) {
  const [chat, setChat] = useState<MobileChatMessage[]>(thread.messages);
  const [draftSequence, setDraftSequence] = useState<string[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string>("");
  const [isSending, setIsSending] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("all");
  const [isSmallViewport, setIsSmallViewport] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 768px)").matches : true
  );

  const mobileChatRef = useRef<HTMLDivElement | null>(null);
  const tabletChatRef = useRef<HTMLDivElement | null>(null);
  const desktopChatRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(() => thread.suggestions || [], [thread.suggestions]);

  useEffect(() => {
    const refs = [mobileChatRef.current, tabletChatRef.current, desktopChatRef.current];
    refs.forEach((el) => {
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [chat.length]);

  function chatRefFor(device: DevicePreset) {
    if (device === "mobile") return mobileChatRef;
    if (device === "tablet") return tabletChatRef;
    return desktopChatRef;
  }

  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const onChange = () => setIsSmallViewport(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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

  function renderHeader(device: DevicePreset) {
    const titleFont = device === "desktop" ? "16px" : "15px";
    const subtitleFont = device === "desktop" ? "12px" : "11px";
    return (
      <header style={styles.header}>
        <div style={styles.avatarWrap}>
          <div style={styles.avatar} />
        </div>
        <div style={styles.headerMeta}>
          <div style={{ ...styles.title, fontSize: titleFont }}>{thread.name}</div>
          <div style={{ ...styles.subtitle, fontSize: subtitleFont }}>
            {thread.stage} · {thread.urgency} priority · {mode.toUpperCase()} · {deviceTitle(device).toUpperCase()}
          </div>
        </div>
        <div style={styles.leadIdPill}>ID {thread.leadId.slice(0, 8)}</div>
      </header>
    );
  }

  function renderChat(device: DevicePreset) {
    const bubbleFont = device === "desktop" ? "13px" : "12px";
    return (
      <section ref={chatRefFor(device)} style={styles.chatArea}>
        <AnimatePresence initial={false}>
          {chat.map((msg) => {
            const isOut = msg.from === "brand";
            return (
              <motion.div
                key={msg.id + "_" + device}
                initial={{ opacity: 0, y: 12, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.2, 0.72, 0.2, 1] }}
                style={{
                  ...styles.row,
                  justifyContent: isOut ? "flex-end" : "flex-start"
                }}
              >
                <div
                  style={{
                    ...styles.bubble,
                    maxWidth: device === "desktop" ? "78%" : "84%",
                    ...(isOut ? styles.bubbleOut : styles.bubbleIn)
                  }}
                >
                  <div style={{ ...styles.bubbleText, fontSize: bubbleFont }}>{msg.text}</div>
                  <div style={styles.bubbleTimeRow}>
                    <span style={styles.bubbleTime}>{toTime(msg.time)}</span>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </section>
    );
  }

  function renderSuggestions(device: DevicePreset) {
    const isHorizontal = device === "mobile";
    return (
      <section style={styles.suggestionsWrap}>
        <div style={styles.sectionTitle}>AI Suggestions · 2-4 messages</div>
        <div
          style={
            isHorizontal
              ? styles.suggestionScroller
              : { ...styles.suggestionStack, maxHeight: device === "desktop" ? "100%" : "340px" }
          }
          aria-label="AI suggestions list"
        >
          {suggestions.length === 0 ? (
            <div style={styles.emptyState}>
              No suggestion yet. Switch to mock mode or connect live suggestion source.
            </div>
          ) : null}
          {suggestions.map((s, idx) => {
            const active = s.id === activeSuggestionId;
            return (
              <motion.article
                key={s.id + "_" + device}
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.18, delay: idx * 0.05 }}
                whileTap={{ scale: 0.985 }}
                style={{
                  ...styles.suggestionCard,
                  ...(isHorizontal ? styles.suggestionCardHorizontal : styles.suggestionCardVertical),
                  ...(active ? styles.suggestionCardActive : null)
                }}
              >
                <div style={styles.suggestionTitle}>{s.title}</div>
                <div style={styles.suggestionRationale}>{s.rationale}</div>
                <div style={styles.previewList}>
                  {s.messages.map((line, lineIdx) => (
                    <div key={s.id + "_line_" + lineIdx + "_" + device} style={styles.previewLineWrap}>
                      <span style={styles.previewLineDot} />
                      <div style={styles.previewLine}>{line}</div>
                    </div>
                  ))}
                </div>
                <div style={styles.suggestionActions}>
                  <motion.button
                    type="button"
                    style={styles.btnGhost}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => onInsertSuggestion(s)}
                    disabled={isSending}
                  >
                    Insert
                  </motion.button>
                  <motion.button
                    type="button"
                    style={styles.btnPrimary}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => onSendSuggestion(s)}
                    disabled={isSending}
                  >
                    {isSending && active ? "Sending..." : "Send"}
                  </motion.button>
                </div>
              </motion.article>
            );
          })}
        </div>
      </section>
    );
  }

  function renderComposer(compact = false) {
    return (
      <footer style={styles.composer}>
        <div style={styles.composerLabel}>Insert + Send Sequence</div>
        <div style={{ ...styles.draftWrap, ...(compact ? styles.draftWrapCompact : null) }}>
          {draftSequence.length === 0 ? (
            <div style={styles.draftEmpty}>Select an AI card to preview your outgoing sequence.</div>
          ) : (
            draftSequence.map((line, idx) => (
              <motion.div
                key={"draft_" + idx}
                initial={{ opacity: 0, x: 10, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                transition={{ duration: 0.16, delay: idx * 0.03 }}
                style={styles.draftBubble}
              >
                <span style={styles.draftBubbleIndex}>{idx + 1}</span>
                <span style={styles.draftLine}>{line}</span>
              </motion.div>
            ))
          )}
        </div>
        <motion.button
          type="button"
          style={styles.btnPrimaryWide}
          whileTap={{ scale: 0.985 }}
          disabled={isSending || draftSequence.length < 2}
          onClick={() => void sendSequence(draftSequence)}
        >
          {isSending ? "Sending sequence..." : "Send Inserted Sequence"}
        </motion.button>
      </footer>
    );
  }

  function renderDevice(device: DevicePreset) {
    const standaloneMobile = previewMode === "mobile";
    if (device === "mobile") {
      return (
        <div
          style={{
            ...styles.phoneShell,
            ...(standaloneMobile && isSmallViewport ? styles.phoneShellMobile : styles.phoneShellDesktop)
          }}
        >
          {renderHeader("mobile")}
          {renderChat("mobile")}
          {renderSuggestions("mobile")}
          {renderComposer()}
        </div>
      );
    }

    if (device === "tablet") {
      return (
        <div style={styles.tabletShell}>
          {renderHeader("tablet")}
          <div style={styles.tabletBody}>
            <div style={styles.tabletChatPane}>{renderChat("tablet")}</div>
            <div style={styles.tabletSidePane}>
              {renderSuggestions("tablet")}
              {renderComposer(true)}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div style={styles.desktopShell}>
        {renderHeader("desktop")}
        <div style={styles.desktopBody}>
          <section style={styles.desktopCol}>{renderChat("desktop")}</section>
          <section style={styles.desktopCol}>{renderSuggestions("desktop")}</section>
          <section style={styles.desktopCol}>{renderComposer(true)}</section>
        </div>
      </div>
    );
  }

  const visibleDevices = previewMode === "all" ? DEVICE_ORDER : [previewMode];

  return (
    <div style={styles.page}>
      <div style={styles.bgGlowTop} />
      <div style={styles.bgBlobCyan} />
      <div style={styles.bgBlobViolet} />

      <div style={styles.previewContainer}>
        <div style={styles.topControls}>
          <a href="/admin/whatsapp-intelligence" style={styles.backLink}>
            Back to WhatsApp Intelligence
          </a>
          <div style={styles.toggleWrap}>
            {(["all", "mobile", "tablet", "desktop"] as PreviewMode[]).map((opt) => {
              const active = previewMode === opt;
              const label = opt === "all" ? "All" : deviceTitle(opt as DevicePreset);
              return (
                <button
                  key={opt}
                  type="button"
                  style={{ ...styles.toggleBtn, ...(active ? styles.toggleBtnActive : null) }}
                  onClick={() => setPreviewMode(opt)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={previewMode === "all" ? styles.allGrid : styles.singleGrid}>
          {visibleDevices.map((device) => (
            <div key={device} style={styles.previewItem}>
              {previewMode === "all" ? <div style={styles.previewLabel}>{deviceTitle(device)}</div> : null}
              {renderDevice(device)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100dvh",
    background:
      "radial-gradient(120% 70% at 50% -10%, rgba(61,147,255,.28) 0%, rgba(10,16,31,0) 58%), linear-gradient(180deg, #050912 0%, #080f1d 45%, #070b14 100%)",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "14px",
    position: "relative",
    overflowX: "hidden",
    overflowY: "auto"
  },
  bgGlowTop: {
    position: "absolute",
    top: "-220px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "700px",
    height: "700px",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(60,153,255,.22) 0%, rgba(30,56,103,.12) 28%, rgba(4,8,16,0) 72%)",
    pointerEvents: "none",
    filter: "blur(8px)"
  },
  bgBlobCyan: {
    position: "absolute",
    top: "12%",
    right: "-80px",
    width: "280px",
    height: "280px",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(39,240,255,.2) 0%, rgba(0,0,0,0) 70%)",
    filter: "blur(34px)",
    pointerEvents: "none"
  },
  bgBlobViolet: {
    position: "absolute",
    bottom: "14%",
    left: "-100px",
    width: "300px",
    height: "300px",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(120,109,255,.16) 0%, rgba(0,0,0,0) 70%)",
    filter: "blur(42px)",
    pointerEvents: "none"
  },
  previewContainer: {
    width: "min(1500px, 100%)",
    display: "grid",
    gap: "14px",
    position: "relative",
    zIndex: 2,
    alignContent: "start"
  },
  topControls: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap"
  },
  backLink: {
    display: "inline-block",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    fontSize: "12px",
    color: "#e8f5ff",
    background: "linear-gradient(180deg, rgba(20,36,60,.82) 0%, rgba(14,26,44,.75) 100%)",
    textDecoration: "none",
    border: "1px solid rgba(173, 209, 246, 0.35)",
    borderRadius: "999px",
    padding: "7px 11px",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)"
  },
  toggleWrap: {
    display: "inline-flex",
    flexWrap: "wrap",
    gap: "8px",
    border: "1px solid rgba(173, 209, 246, 0.3)",
    borderRadius: "999px",
    padding: "6px",
    background: "linear-gradient(180deg, rgba(15,28,48,.78) 0%, rgba(12,21,38,.74) 100%)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)"
  },
  toggleBtn: {
    borderRadius: "999px",
    border: "1px solid rgba(185,216,252,.2)",
    background: "rgba(18,33,56,.58)",
    color: "#d9ebff",
    fontSize: "12px",
    padding: "8px 12px",
    cursor: "pointer"
  },
  toggleBtnActive: {
    border: "1px solid rgba(201,234,255,.35)",
    background:
      "linear-gradient(135deg, rgba(79,201,255,.98) 0%, rgba(36,140,255,.95) 62%, rgba(91,109,255,.95) 100%)",
    color: "#ffffff",
    boxShadow: "0 10px 20px rgba(40,125,255,.32)"
  },
  allGrid: {
    display: "grid",
    gap: "16px",
    gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
    alignItems: "start"
  },
  singleGrid: {
    display: "grid",
    justifyItems: "center"
  },
  previewItem: {
    display: "grid",
    gap: "8px",
    justifyItems: "center"
  },
  previewLabel: {
    fontSize: "12px",
    letterSpacing: ".08em",
    textTransform: "uppercase",
    color: "rgba(200,225,250,.9)"
  },

  phoneShell: {
    width: "100%",
    maxWidth: "430px",
    height: "min(860px, calc(100dvh - 190px))",
    minHeight: "620px",
    borderRadius: "32px",
    overflow: "hidden",
    background: "linear-gradient(180deg, rgba(13,22,39,.88) 0%, rgba(10,18,33,.94) 100%)",
    border: "1px solid rgba(223, 240, 255, 0.16)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    display: "grid",
    gridTemplateRows: "76px 1fr auto auto",
    position: "relative"
  },
  phoneShellDesktop: {
    boxShadow: "0 30px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(169, 212, 255, 0.05) inset"
  },
  phoneShellMobile: {
    borderRadius: "0",
    maxWidth: "100%",
    width: "100vw",
    height: "100dvh",
    minHeight: "100dvh",
    border: "none",
    boxShadow: "none"
  },

  tabletShell: {
    width: "min(900px, 100%)",
    height: "min(860px, calc(100dvh - 190px))",
    minHeight: "640px",
    borderRadius: "34px",
    overflow: "hidden",
    background: "linear-gradient(180deg, rgba(13,22,39,.9) 0%, rgba(10,18,33,.95) 100%)",
    border: "1px solid rgba(223, 240, 255, 0.16)",
    boxShadow: "0 34px 94px rgba(0,0,0,.55), 0 0 0 1px rgba(169,212,255,.06) inset",
    display: "grid",
    gridTemplateRows: "76px 1fr"
  },
  tabletBody: {
    display: "grid",
    gridTemplateColumns: "1.2fr .9fr",
    gap: "0",
    minHeight: 0
  },
  tabletChatPane: {
    minHeight: 0,
    borderRight: "1px solid rgba(164,205,255,.14)",
    display: "grid"
  },
  tabletSidePane: {
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "1fr auto"
  },

  desktopShell: {
    width: "min(1260px, 100%)",
    height: "min(860px, calc(100dvh - 190px))",
    minHeight: "660px",
    borderRadius: "34px",
    overflow: "hidden",
    background: "linear-gradient(180deg, rgba(13,22,39,.92) 0%, rgba(10,18,33,.95) 100%)",
    border: "1px solid rgba(223, 240, 255, 0.16)",
    boxShadow: "0 38px 100px rgba(0,0,0,.58), 0 0 0 1px rgba(169,212,255,.06) inset",
    display: "grid",
    gridTemplateRows: "76px 1fr"
  },
  desktopBody: {
    display: "grid",
    gridTemplateColumns: "1.15fr .95fr .85fr",
    minHeight: 0
  },
  desktopCol: {
    minHeight: 0,
    borderRight: "1px solid rgba(164,205,255,.14)",
    display: "grid"
  },

  header: {
    background: "linear-gradient(180deg, rgba(21,35,57,.84) 0%, rgba(17,29,47,.62) 100%)",
    borderBottom: "1px solid rgba(170, 208, 255, 0.17)",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "14px 14px 12px",
    position: "relative"
  },
  avatarWrap: {
    width: "42px",
    height: "42px",
    borderRadius: "50%",
    background: "linear-gradient(160deg, rgba(103,211,255,.75), rgba(114,128,255,.65))",
    padding: "1.5px",
    boxShadow: "0 8px 24px rgba(41,144,255,.35)"
  },
  avatar: {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    background: "radial-gradient(120% 100% at 50% 0%, #7ad9ff 0%, #3f7aff 65%, #2a3870 100%)"
  },
  headerMeta: {
    minWidth: 0,
    flex: 1
  },
  title: {
    color: "#f4f8ff",
    fontWeight: 700,
    letterSpacing: ".01em"
  },
  subtitle: {
    color: "rgba(205,224,246,.78)",
    marginTop: "2px"
  },
  leadIdPill: {
    border: "1px solid rgba(190, 225, 255, 0.22)",
    background: "linear-gradient(180deg, rgba(29,46,74,.9) 0%, rgba(19,31,51,.78) 100%)",
    borderRadius: "999px",
    padding: "6px 10px",
    color: "#d7eafd",
    fontSize: "11px",
    whiteSpace: "nowrap",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.08)"
  },

  chatArea: {
    overflowY: "auto",
    padding: "12px 12px 14px",
    background:
      "radial-gradient(140% 120% at 50% -20%, rgba(52,129,255,.12) 0%, rgba(8,14,24,0) 55%), linear-gradient(180deg, #0a1222 0%, #0a1324 100%)"
  },
  row: {
    display: "flex",
    marginBottom: "10px"
  },
  bubble: {
    borderRadius: "22px",
    padding: "10px 12px 8px",
    boxShadow: "0 14px 28px rgba(0,0,0,.28)"
  },
  bubbleIn: {
    background: "linear-gradient(180deg, rgba(33,47,74,.72) 0%, rgba(20,32,53,.82) 100%)",
    color: "#edf4ff",
    border: "1px solid rgba(201,223,255,.15)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)"
  },
  bubbleOut: {
    background:
      "linear-gradient(135deg, rgba(69,188,255,.96) 0%, rgba(42,126,255,.95) 55%, rgba(94,112,255,.92) 100%)",
    color: "#fff",
    border: "1px solid rgba(208,239,255,.28)",
    boxShadow: "0 16px 30px rgba(45,130,255,.32)"
  },
  bubbleText: {
    lineHeight: 1.42,
    wordBreak: "break-word"
  },
  bubbleTimeRow: {
    marginTop: "4px",
    display: "flex",
    justifyContent: "flex-end"
  },
  bubbleTime: {
    fontSize: "10px",
    opacity: 0.78
  },

  suggestionsWrap: {
    borderTop: "1px solid rgba(164, 205, 255, 0.16)",
    background: "linear-gradient(180deg, rgba(16,28,46,.82) 0%, rgba(13,24,40,.76) 100%)",
    padding: "11px 10px 10px",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    display: "grid",
    alignContent: "start",
    minHeight: 0
  },
  sectionTitle: {
    color: "#d6e8ff",
    fontSize: "11px",
    letterSpacing: ".05em",
    textTransform: "uppercase",
    marginBottom: "9px",
    paddingLeft: "2px"
  },
  suggestionScroller: {
    display: "flex",
    overflowX: "auto",
    gap: "12px",
    scrollSnapType: "x mandatory",
    paddingBottom: "2px"
  },
  suggestionStack: {
    display: "grid",
    gap: "10px",
    overflowY: "auto",
    alignContent: "start"
  },
  emptyState: {
    minWidth: "84%",
    border: "1px dashed rgba(170,205,255,.26)",
    borderRadius: "20px",
    color: "#aac3df",
    background: "linear-gradient(180deg, rgba(20,36,60,.9) 0%, rgba(15,27,46,.86) 100%)",
    padding: "14px",
    fontSize: "12px"
  },
  suggestionCard: {
    background: "linear-gradient(180deg, rgba(19,35,58,.86) 0%, rgba(16,29,49,.9) 100%)",
    border: "1px solid rgba(174, 214, 255, 0.18)",
    borderRadius: "24px",
    padding: "12px",
    color: "#ecf5ff",
    boxShadow: "0 16px 40px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.06)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)"
  },
  suggestionCardHorizontal: {
    minWidth: "84%",
    scrollSnapAlign: "start"
  },
  suggestionCardVertical: {
    minWidth: "100%"
  },
  suggestionCardActive: {
    borderColor: "rgba(101,199,255,.72)",
    boxShadow: "0 18px 44px rgba(20, 114, 255,.25), 0 0 0 1px rgba(96,198,255,.45) inset"
  },
  suggestionTitle: {
    fontSize: "14px",
    fontWeight: 700,
    marginBottom: "4px",
    letterSpacing: ".01em"
  },
  suggestionRationale: {
    fontSize: "11px",
    color: "#a9c4e4",
    marginBottom: "9px",
    lineHeight: 1.35
  },
  previewList: {
    display: "grid",
    gap: "6px",
    marginBottom: "11px"
  },
  previewLineWrap: {
    display: "flex",
    alignItems: "flex-start",
    gap: "7px"
  },
  previewLineDot: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    marginTop: "7px",
    background: "linear-gradient(180deg, #6ed4ff, #5d82ff)",
    boxShadow: "0 0 10px rgba(103,202,255,.65)"
  },
  previewLine: {
    fontSize: "11px",
    color: "#deecfb",
    background: "linear-gradient(180deg, rgba(28,49,79,.92) 0%, rgba(22,40,65,.9) 100%)",
    borderRadius: "14px",
    padding: "8px 10px",
    border: "1px solid rgba(175,213,255,.12)",
    flex: 1
  },
  suggestionActions: {
    display: "flex",
    gap: "8px"
  },
  btnGhost: {
    flex: 1,
    borderRadius: "14px",
    border: "1px solid rgba(176,209,243,.24)",
    background: "linear-gradient(180deg, rgba(30,46,72,.6) 0%, rgba(20,33,54,.72) 100%)",
    color: "#d8e8fb",
    padding: "10px 12px",
    fontSize: "12px",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)"
  },
  btnPrimary: {
    flex: 1,
    borderRadius: "14px",
    border: "1px solid rgba(208,240,255,.28)",
    background:
      "linear-gradient(135deg, rgba(79,201,255,.98) 0%, rgba(36,140,255,.95) 62%, rgba(91,109,255,.95) 100%)",
    color: "#fff",
    padding: "10px 12px",
    fontSize: "12px",
    fontWeight: 700,
    boxShadow: "0 12px 24px rgba(43,134,255,.35)"
  },

  composer: {
    borderTop: "1px solid rgba(172,205,242,.17)",
    padding: "10px 12px 12px",
    background: "linear-gradient(180deg, rgba(19,32,53,.86) 0%, rgba(16,28,47,.92) 100%)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    position: "sticky",
    bottom: 0,
    alignContent: "start"
  },
  composerLabel: {
    fontSize: "11px",
    color: "#b2cae6",
    marginBottom: "7px",
    letterSpacing: ".03em"
  },
  draftWrap: {
    minHeight: "58px",
    maxHeight: "136px",
    overflowY: "auto",
    border: "1px solid rgba(173,209,248,.18)",
    borderRadius: "18px",
    background: "linear-gradient(180deg, rgba(16,28,47,.9) 0%, rgba(13,24,41,.95) 100%)",
    padding: "8px",
    marginBottom: "10px"
  },
  draftWrapCompact: {
    maxHeight: "220px"
  },
  draftEmpty: {
    color: "#89a5c7",
    fontSize: "12px",
    lineHeight: 1.35
  },
  draftBubble: {
    marginBottom: "7px",
    borderRadius: "16px",
    padding: "8px 10px",
    background: "linear-gradient(135deg, rgba(66,190,255,.88) 0%, rgba(39,132,255,.88) 65%, rgba(86,110,255,.86) 100%)",
    color: "#fff",
    border: "1px solid rgba(208,239,255,.32)",
    boxShadow: "0 10px 20px rgba(42,123,247,.28)",
    display: "flex",
    alignItems: "flex-start",
    gap: "8px"
  },
  draftBubbleIndex: {
    minWidth: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "rgba(10,26,48,.35)",
    border: "1px solid rgba(224,245,255,.35)",
    fontSize: "11px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center"
  },
  draftLine: {
    color: "#f4fbff",
    fontSize: "12px",
    lineHeight: 1.36
  },
  btnPrimaryWide: {
    width: "100%",
    borderRadius: "16px",
    border: "1px solid rgba(208,241,255,.28)",
    background:
      "linear-gradient(135deg, rgba(82,201,255,.98) 0%, rgba(37,143,255,.95) 62%, rgba(93,111,255,.95) 100%)",
    color: "#fff",
    padding: "13px 14px",
    fontSize: "13px",
    fontWeight: 700,
    boxShadow: "0 18px 30px rgba(46,137,255,.32)"
  }
};
