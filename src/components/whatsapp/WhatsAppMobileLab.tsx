import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  MobileChatMessage,
  MobileLeadSummary,
  MobileLeadThread,
  MobileSuggestionCard
} from "../../modules/whatsapp/mobileLabAdapter.js";

type Props = {
  thread: MobileLeadThread;
  mode: "mock" | "live";
};

type StageFilter = "all" | "new" | "active" | "pending" | "converted";
type UrgencyFilter = "all" | "high" | "medium" | "low";

function toTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function toDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function stageBucket(stage: string): Exclude<StageFilter, "all"> {
  const value = String(stage || "").toUpperCase();
  if (["NEW", "PRODUCT_INTEREST"].includes(value)) return "new";
  if (["QUALIFICATION_PENDING", "PRICE_SENT", "VIDEO_PROPOSED", "DEPOSIT_PENDING"].includes(value)) return "pending";
  if (["QUALIFIED", "CONFIRMED"].includes(value)) return "active";
  if (["CONVERTED"].includes(value)) return "converted";
  return "active";
}

function urgencyTone(urgency: MobileLeadSummary["urgency"]): CSSProperties {
  if (urgency === "High") return { color: "#8a2c0d", background: "#fff3e8", borderColor: "#f7d4b5" };
  if (urgency === "Low") return { color: "#2b5b4b", background: "#ecf9f1", borderColor: "#c4ebd4" };
  return { color: "#5c4d1f", background: "#fff8e6", borderColor: "#f1e1a8" };
}

function statusTone(status?: MobileChatMessage["status"]): CSSProperties {
  if (status === "read") return { color: "#2f6f4f" };
  if (status === "delivered") return { color: "#6f7f8e" };
  return { color: "#8c9196" };
}

function buildSummary(thread: MobileLeadThread): MobileLeadSummary {
  return {
    leadId: thread.leadId,
    name: thread.name,
    stage: thread.stage,
    urgency: thread.urgency,
    unread: thread.unread,
    lastAt: thread.lastAt,
    preview: thread.preview
  };
}

function buildFallbackMessages(summary: MobileLeadSummary): MobileChatMessage[] {
  return [
    {
      id: `${summary.leadId}-inbound-fallback`,
      from: "client",
      text: summary.preview || "Client asked for details.",
      time: summary.lastAt || new Date().toISOString(),
      status: "read"
    }
  ];
}

function buildFallbackSuggestions(summary: MobileLeadSummary): MobileSuggestionCard[] {
  return [
    {
      id: `${summary.leadId}-suggestion-1`,
      title: "Reply with qualification + next step",
      tag: "recommended",
      priority: 90,
      rationale: "Lead context is incomplete; asking for missing details improves conversion quality.",
      messages: [
        `Thank you ${summary.name.split(" ")[0] || "for your message"}.`,
        "Could you confirm the event date and delivery city so I can provide an exact recommendation?"
      ]
    },
    {
      id: `${summary.leadId}-suggestion-2`,
      title: "Share concise pricing orientation",
      tag: "pricing",
      priority: 70,
      rationale: "A short pricing anchor keeps momentum while preserving premium tone.",
      messages: [
        "I can guide you with the best option based on your date and style preferences.",
        "Once you confirm those two details, I will send the most accurate range and timeline."
      ]
    }
  ];
}

function matchesThreadFilter(item: MobileLeadSummary, stage: StageFilter, urgency: UrgencyFilter, query: string): boolean {
  if (stage !== "all" && stageBucket(item.stage) !== stage) return false;
  if (urgency !== "all" && item.urgency.toLowerCase() !== urgency) return false;
  if (!query.trim()) return true;
  const source = `${item.name} ${item.stage} ${item.preview}`.toLowerCase();
  return source.includes(query.toLowerCase().trim());
}

export function WhatsAppMobileLab({ thread, mode }: Props) {
  const allThreads = useMemo(() => {
    const fromPayload = Array.isArray(thread.relatedThreads) ? thread.relatedThreads : [];
    const merged = [buildSummary(thread), ...fromPayload.filter((item) => item.leadId !== thread.leadId)];
    const deduped = new Map<string, MobileLeadSummary>();
    for (const item of merged) deduped.set(item.leadId, item);
    return Array.from(deduped.values()).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }, [thread]);

  const [selectedLeadId, setSelectedLeadId] = useState<string>(thread.leadId);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("all");
  const [draftSequence, setDraftSequence] = useState<string[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 1100px)").matches : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 1100px)");
    const onChange = () => setIsNarrow(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const filteredThreads = useMemo(
    () => allThreads.filter((item) => matchesThreadFilter(item, stageFilter, urgencyFilter, query)),
    [allThreads, stageFilter, urgencyFilter, query]
  );

  const selectedSummary = useMemo(() => {
    const fromFiltered = filteredThreads.find((item) => item.leadId === selectedLeadId);
    if (fromFiltered) return fromFiltered;
    return allThreads.find((item) => item.leadId === selectedLeadId) || allThreads[0] || buildSummary(thread);
  }, [filteredThreads, allThreads, selectedLeadId, thread]);

  const selectedMessages = useMemo(() => {
    if (selectedSummary.leadId === thread.leadId) return thread.messages;
    return buildFallbackMessages(selectedSummary);
  }, [selectedSummary, thread]);

  const selectedSuggestions = useMemo(() => {
    if (selectedSummary.leadId === thread.leadId && thread.suggestions.length) return thread.suggestions;
    return buildFallbackSuggestions(selectedSummary);
  }, [selectedSummary, thread]);

  const kpis = useMemo(() => {
    const conversations = filteredThreads.length;
    const pendingReplies = filteredThreads.filter((item) => item.unread > 0).length;
    const aiSuggestions = selectedSuggestions.length;
    const conversionSignals = filteredThreads.filter((item) => ["active", "converted", "pending"].includes(stageBucket(item.stage))).length;
    return { conversations, pendingReplies, aiSuggestions, conversionSignals };
  }, [filteredThreads, selectedSuggestions.length]);

  async function sendSequence(lines: string[]) {
    if (!lines.length || isSending) return;
    setIsSending(true);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    } finally {
      setIsSending(false);
      setDraftSequence([]);
      setActiveSuggestionId("");
    }
  }

  return (
    <div style={styles.pageContainer}>
      <div style={styles.innerContainer}>
        <header style={styles.pageHeader}>
          <div>
            <h1 style={styles.pageTitle}>Mobile Lab</h1>
            <p style={styles.pageSubtitle}>Operational conversation workspace for AI-assisted WhatsApp execution.</p>
          </div>
          <div style={styles.quickPills}>
            <span style={{ ...styles.statusPill, ...styles.statusPillNeutral }}>Mode: {mode.toUpperCase()}</span>
            <span style={{ ...styles.statusPill, ...styles.statusPillGood }}>System healthy</span>
            <span style={{ ...styles.statusPill, ...styles.statusPillNeutral }}>SLA window active</span>
          </div>
        </header>

        <section style={styles.adminCard}>
          <div style={{ ...styles.toolbarRow, ...(isNarrow ? styles.toolbarRowNarrow : null) }}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations"
              style={styles.searchInput}
            />
            <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as StageFilter)} style={styles.selectInput}>
              <option value="all">All stages</option>
              <option value="new">New</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="converted">Converted</option>
            </select>
            <div style={styles.segmentedControl}>
              {(["all", "high", "medium", "low"] as UrgencyFilter[]).map((value) => {
                const active = urgencyFilter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setUrgencyFilter(value)}
                    style={{ ...styles.filterChip, ...(active ? styles.filterChipActive : null) }}
                  >
                    {value === "all" ? "All priority" : `${value[0].toUpperCase()}${value.slice(1)}`}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section style={{ ...styles.kpiGrid, ...(isNarrow ? styles.kpiGridNarrow : null) }}>
          <KpiStatCard label="Conversations" value={kpis.conversations} helper="Visible in current filter" />
          <KpiStatCard label="Pending replies" value={kpis.pendingReplies} helper="Unread or waiting operator" />
          <KpiStatCard label="AI suggestions" value={kpis.aiSuggestions} helper="Available for selected conversation" />
          <KpiStatCard label="Conversion signals" value={kpis.conversionSignals} helper="Active commercial momentum" />
        </section>

        <section style={{ ...styles.mainGrid, ...(isNarrow ? styles.mainGridNarrow : null) }}>
          <article style={styles.adminCard}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Conversations</h2>
              <p style={styles.sectionHelper}>{filteredThreads.length} items</p>
            </div>
            <div style={styles.conversationList}>
              {filteredThreads.map((item) => {
                const selected = item.leadId === selectedSummary.leadId;
                return (
                  <button
                    key={item.leadId}
                    type="button"
                    onClick={() => setSelectedLeadId(item.leadId)}
                    style={{ ...styles.conversationRow, ...(selected ? styles.conversationRowActive : null) }}
                  >
                    <div style={styles.rowHead}>
                      <span style={styles.rowName}>{item.name}</span>
                      <span style={styles.rowMeta}>{toDateLabel(item.lastAt)}</span>
                    </div>
                    <div style={styles.rowHead}>
                      <span style={styles.rowStage}>{item.stage}</span>
                      <span style={{ ...styles.rowUrgency, ...urgencyTone(item.urgency) }}>{item.urgency}</span>
                    </div>
                    <p style={styles.rowPreview}>{item.preview}</p>
                    {item.unread > 0 ? <span style={styles.unreadBadge}>{item.unread}</span> : null}
                  </button>
                );
              })}
              {filteredThreads.length === 0 ? <EmptyState title="No conversations" subtitle="Adjust filters or search to find a lead." /> : null}
            </div>
          </article>

          <div style={styles.rightColumn}>
            <article style={styles.adminCard}>
              <div style={styles.sectionHeader}>
                <div>
                  <h2 style={styles.sectionTitle}>{selectedSummary.name}</h2>
                  <p style={styles.sectionHelper}>Lead #{selectedSummary.leadId.slice(0, 8)} • {selectedSummary.stage}</p>
                </div>
                <span style={{ ...styles.statusPill, ...styles.statusPillNeutral }}>{selectedSummary.urgency} priority</span>
              </div>

              <div style={styles.messagesPane}>
                {selectedMessages.map((msg) => {
                  const outgoing = msg.from === "brand";
                  return (
                    <div key={msg.id} style={{ ...styles.messageRow, justifyContent: outgoing ? "flex-end" : "flex-start" }}>
                      <div style={{ ...styles.messageBubble, ...(outgoing ? styles.messageBubbleOutgoing : styles.messageBubbleIncoming) }}>
                        <p style={styles.messageText}>{msg.text}</p>
                        <div style={styles.messageMetaRow}>
                          <span style={styles.messageMeta}>{toTime(msg.time)}</span>
                          {msg.status ? <span style={{ ...styles.messageMeta, ...statusTone(msg.status) }}>{msg.status}</span> : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={styles.composerRow}>
                <input
                  style={styles.replyInput}
                  placeholder="Write a reply or insert an AI suggestion"
                  value={draftSequence[0] || ""}
                  onChange={(event) => setDraftSequence(event.target.value ? [event.target.value] : [])}
                />
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={() => setDraftSequence([])}
                >
                  Clear
                </button>
                <button
                  type="button"
                  style={styles.primaryButton}
                  disabled={isSending || draftSequence.length === 0}
                  onClick={() => void sendSequence(draftSequence)}
                >
                  {isSending ? "Sending..." : "Send"}
                </button>
              </div>
            </article>

            <article style={styles.adminCard}>
              <div style={styles.sectionHeader}>
                <h2 style={styles.sectionTitle}>AI Suggested Replies</h2>
                <p style={styles.sectionHelper}>Operational recommendations</p>
              </div>
              <div style={{ ...styles.suggestionGrid, ...(isNarrow ? styles.suggestionGridNarrow : null) }}>
                {selectedSuggestions.map((suggestion) => {
                  const active = suggestion.id === activeSuggestionId;
                  return (
                    <div key={suggestion.id} style={{ ...styles.suggestionPanel, ...(active ? styles.suggestionPanelActive : null) }}>
                      <div style={styles.rowHead}>
                        <h3 style={styles.suggestionTitle}>{suggestion.title}</h3>
                        <span style={styles.suggestionBadge}>AI suggestion</span>
                      </div>
                      <p style={styles.suggestionReply}>{suggestion.messages[0] || "No reply preview"}</p>
                      <p style={styles.suggestionReason}>{suggestion.rationale}</p>
                      <div style={styles.suggestionActions}>
                        <button
                          type="button"
                          style={styles.primaryButton}
                          onClick={() => {
                            setActiveSuggestionId(suggestion.id);
                            setDraftSequence(suggestion.messages.slice(0, 4));
                          }}
                        >
                          Insert
                        </button>
                        <button
                          type="button"
                          style={styles.secondaryButton}
                          onClick={() => {
                            setActiveSuggestionId(suggestion.id);
                            void sendSequence(suggestion.messages.slice(0, 4));
                          }}
                        >
                          Send now
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>
          </div>
        </section>

        <section style={{ ...styles.actionCardGrid, ...(isNarrow ? styles.actionCardGridNarrow : null) }}>
          <article style={styles.adminCard}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Approvals</h2>
              <span style={{ ...styles.statusPill, ...styles.statusPillNeutral }}>Queue</span>
            </div>
            <p style={styles.sectionHelper}>Keep human approval items visible before sensitive sends.</p>
          </article>
          <article style={styles.adminCard}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Operator Focus</h2>
              <span style={{ ...styles.statusPill, ...styles.statusPillGood }}>On track</span>
            </div>
            <p style={styles.sectionHelper}>Use concise replies, preserve tone, and close missing qualification quickly.</p>
          </article>
          <article style={styles.adminCard}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Learning Loop</h2>
              <span style={{ ...styles.statusPill, ...styles.statusPillNeutral }}>Active</span>
            </div>
            <p style={styles.sectionHelper}>Capture edited AI replies to improve future recommendation quality.</p>
          </article>
        </section>
      </div>
    </div>
  );
}

function KpiStatCard({ label, value, helper }: { label: string; value: number; helper: string }) {
  return (
    <article style={styles.kpiCard}>
      <p style={styles.kpiLabel}>{label}</p>
      <p style={styles.kpiValue}>{value.toLocaleString()}</p>
      <p style={styles.kpiHelper}>{helper}</p>
    </article>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={styles.emptyState}>
      <p style={styles.emptyTitle}>{title}</p>
      <p style={styles.emptySubtitle}>{subtitle}</p>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  pageContainer: {
    minHeight: "100dvh",
    background: "#f6f6f7",
    color: "#202223",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    padding: "24px"
  },
  innerContainer: {
    maxWidth: "1440px",
    margin: "0 auto",
    display: "grid",
    gap: "16px"
  },
  pageHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
    flexWrap: "wrap"
  },
  pageTitle: {
    margin: 0,
    fontSize: "28px",
    lineHeight: "32px",
    fontWeight: 650,
    color: "#202223"
  },
  pageSubtitle: {
    margin: "6px 0 0",
    fontSize: "13px",
    lineHeight: "18px",
    color: "#6d7175"
  },
  quickPills: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px"
  },
  statusPill: {
    border: "1px solid #d2d5d8",
    borderRadius: "999px",
    padding: "4px 10px",
    fontSize: "12px",
    fontWeight: 500
  },
  statusPillNeutral: {
    color: "#4a4f55",
    background: "#ffffff"
  },
  statusPillGood: {
    color: "#116149",
    background: "#e9f7ef",
    borderColor: "#c3e9d2"
  },
  adminCard: {
    background: "#ffffff",
    border: "1px solid #e3e5e7",
    borderRadius: "12px",
    padding: "16px"
  },
  toolbarRow: {
    display: "grid",
    gridTemplateColumns: "minmax(220px, 1fr) 180px auto",
    gap: "8px",
    alignItems: "center"
  },
  toolbarRowNarrow: {
    gridTemplateColumns: "1fr",
    alignItems: "stretch"
  },
  searchInput: {
    height: "36px",
    border: "1px solid #c9cccf",
    borderRadius: "10px",
    padding: "0 12px",
    fontSize: "13px",
    color: "#202223",
    background: "#fff"
  },
  selectInput: {
    height: "36px",
    border: "1px solid #c9cccf",
    borderRadius: "10px",
    padding: "0 10px",
    fontSize: "13px",
    color: "#202223",
    background: "#fff"
  },
  segmentedControl: {
    display: "flex",
    gap: "8px",
    justifyContent: "flex-end",
    flexWrap: "wrap"
  },
  filterChip: {
    height: "32px",
    border: "1px solid #d2d5d8",
    borderRadius: "10px",
    background: "#fff",
    color: "#4a4f55",
    fontSize: "12px",
    padding: "0 10px",
    cursor: "pointer"
  },
  filterChipActive: {
    borderColor: "#babfc3",
    background: "#f1f2f3",
    color: "#202223"
  },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "12px"
  },
  kpiGridNarrow: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
  },
  kpiCard: {
    background: "#ffffff",
    border: "1px solid #e3e5e7",
    borderRadius: "12px",
    padding: "16px"
  },
  kpiLabel: {
    margin: 0,
    fontSize: "12px",
    color: "#6d7175"
  },
  kpiValue: {
    margin: "8px 0 0",
    fontSize: "24px",
    lineHeight: "28px",
    fontWeight: 650,
    color: "#202223"
  },
  kpiHelper: {
    margin: "6px 0 0",
    fontSize: "12px",
    color: "#8c9196"
  },
  mainGrid: {
    display: "grid",
    gridTemplateColumns: "340px minmax(0, 1fr)",
    gap: "12px",
    alignItems: "start"
  },
  mainGridNarrow: {
    gridTemplateColumns: "1fr"
  },
  rightColumn: {
    display: "grid",
    gap: "12px"
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
    marginBottom: "12px"
  },
  sectionTitle: {
    margin: 0,
    fontSize: "15px",
    lineHeight: "20px",
    fontWeight: 600,
    color: "#202223"
  },
  sectionHelper: {
    margin: "2px 0 0",
    fontSize: "12px",
    color: "#8c9196"
  },
  conversationList: {
    display: "grid",
    gap: "8px",
    maxHeight: "740px",
    overflowY: "auto"
  },
  conversationRow: {
    position: "relative",
    textAlign: "left",
    border: "1px solid #e3e5e7",
    borderRadius: "10px",
    padding: "10px",
    background: "#fff",
    cursor: "pointer"
  },
  conversationRowActive: {
    borderColor: "#b7bcc1",
    background: "#f6f6f7"
  },
  rowHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px"
  },
  rowName: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#202223"
  },
  rowMeta: {
    fontSize: "11px",
    color: "#8c9196"
  },
  rowStage: {
    fontSize: "11px",
    color: "#6d7175",
    textTransform: "uppercase",
    letterSpacing: ".02em"
  },
  rowUrgency: {
    border: "1px solid #e3e5e7",
    borderRadius: "999px",
    padding: "2px 8px",
    fontSize: "10px",
    fontWeight: 600
  },
  rowPreview: {
    margin: "8px 0 0",
    fontSize: "12px",
    color: "#6d7175",
    lineHeight: "17px"
  },
  unreadBadge: {
    position: "absolute",
    top: "10px",
    right: "10px",
    minWidth: "20px",
    height: "20px",
    borderRadius: "10px",
    background: "#008060",
    color: "#fff",
    fontSize: "11px",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 6px"
  },
  messagesPane: {
    border: "1px solid #e3e5e7",
    borderRadius: "10px",
    background: "#fbfbfb",
    padding: "12px",
    maxHeight: "420px",
    overflowY: "auto",
    display: "grid",
    gap: "8px"
  },
  messageRow: {
    display: "flex"
  },
  messageBubble: {
    maxWidth: "76%",
    borderRadius: "10px",
    border: "1px solid #e3e5e7",
    padding: "8px 10px"
  },
  messageBubbleIncoming: {
    background: "#ffffff"
  },
  messageBubbleOutgoing: {
    background: "#f1f2f3"
  },
  messageText: {
    margin: 0,
    fontSize: "13px",
    lineHeight: "18px",
    color: "#202223"
  },
  messageMetaRow: {
    marginTop: "6px",
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px"
  },
  messageMeta: {
    fontSize: "11px",
    color: "#8c9196"
  },
  composerRow: {
    marginTop: "12px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto auto",
    gap: "8px"
  },
  replyInput: {
    height: "36px",
    border: "1px solid #c9cccf",
    borderRadius: "10px",
    padding: "0 12px",
    fontSize: "13px",
    color: "#202223"
  },
  primaryButton: {
    height: "36px",
    border: "1px solid #008060",
    borderRadius: "10px",
    padding: "0 12px",
    background: "#008060",
    color: "#fff",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer"
  },
  secondaryButton: {
    height: "36px",
    border: "1px solid #c9cccf",
    borderRadius: "10px",
    padding: "0 12px",
    background: "#fff",
    color: "#202223",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer"
  },
  suggestionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px"
  },
  suggestionGridNarrow: {
    gridTemplateColumns: "1fr"
  },
  suggestionPanel: {
    border: "1px solid #e3e5e7",
    borderRadius: "10px",
    background: "#fff",
    padding: "12px",
    display: "grid",
    gap: "8px"
  },
  suggestionPanelActive: {
    borderColor: "#b7bcc1",
    background: "#f6f6f7"
  },
  suggestionTitle: {
    margin: 0,
    fontSize: "13px",
    fontWeight: 600,
    color: "#202223"
  },
  suggestionBadge: {
    border: "1px solid #cdd1d5",
    borderRadius: "999px",
    padding: "2px 8px",
    fontSize: "10px",
    color: "#5c6065",
    background: "#f6f6f7"
  },
  suggestionReply: {
    margin: 0,
    fontSize: "12px",
    lineHeight: "17px",
    color: "#202223"
  },
  suggestionReason: {
    margin: 0,
    fontSize: "12px",
    lineHeight: "17px",
    color: "#6d7175"
  },
  suggestionActions: {
    display: "flex",
    gap: "8px"
  },
  actionCardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "12px"
  },
  actionCardGridNarrow: {
    gridTemplateColumns: "1fr"
  },
  emptyState: {
    border: "1px dashed #d2d5d8",
    borderRadius: "10px",
    background: "#fafbfb",
    padding: "16px"
  },
  emptyTitle: {
    margin: 0,
    fontSize: "13px",
    fontWeight: 600,
    color: "#202223"
  },
  emptySubtitle: {
    margin: "4px 0 0",
    fontSize: "12px",
    color: "#6d7175"
  }
};
