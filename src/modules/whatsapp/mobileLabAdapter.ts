export type MobileSuggestionCard = {
  id: string;
  title: string;
  tag?: string;
  priority?: number;
  rationale: string;
  messages: string[];
};

export type MobileChatMessage = {
  id: string;
  from: "client" | "brand";
  text: string;
  time: string;
  status?: "sent" | "delivered" | "read";
};

export type MobileLeadThread = {
  leadId: string;
  name: string;
  avatar?: string;
  stage: string;
  urgency: "High" | "Medium" | "Low";
  unread: number;
  lastAt: string;
  preview: string;
  messages: MobileChatMessage[];
  suggestions: MobileSuggestionCard[];
};

const MAX_MESSAGE_CHARS = 120;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureMaxLength(text: string, max = MAX_MESSAGE_CHARS): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, max - 1).trimEnd() + "…" : normalized;
}

function toSuggestion(
  id: string,
  title: string,
  rationale: string,
  messages: string[],
  options?: { tag?: string; priority?: number }
): MobileSuggestionCard {
  const sanitized = messages
    .map((item) => ensureMaxLength(item))
    .filter(Boolean)
    .slice(0, 4);

  return {
    id,
    title,
    tag: options?.tag,
    priority: options?.priority,
    rationale: ensureMaxLength(rationale),
    messages: sanitized.length >= 2 ? sanitized : [ensureMaxLength("Bonjour, merci pour votre message."), ensureMaxLength("Je peux vous guider rapidement pour la suite.")].slice(0, 2)
  };
}

export function getMockMobileLeadThread(leadId?: string): MobileLeadThread {
  const id = String(leadId || "lead_mobile_lab_001").trim() || "lead_mobile_lab_001";
  return {
    leadId: id,
    name: "Sara El Idrissi",
    stage: "QUALIFIED",
    urgency: "High",
    unread: 2,
    lastAt: nowIso(),
    preview: "Parfait, mariage le 28. Quel est le prix et le délai ?",
    messages: [
      {
        id: "m_1",
        from: "client",
        text: "Bonjour, je suis intéressée par le kaftan vert Swarovski. C'est disponible pour fin du mois ?",
        time: nowIso(),
        status: "read"
      },
      {
        id: "m_2",
        from: "brand",
        text: "Bonjour Sara, oui il est disponible. Je peux vous confirmer prix et délai exact selon votre date.",
        time: nowIso(),
        status: "delivered"
      },
      {
        id: "m_3",
        from: "client",
        text: "Parfait, mariage le 28. Quel est le prix et le délai ?",
        time: nowIso(),
        status: "read"
      }
    ],
    suggestions: [
      toSuggestion(
        "s_1",
        "Prix + délai",
        "Réponse directe et premium pour garder la dynamique d'achat.",
        [
          "Parfait pour le 28. Le prix est de 4 300 USD pour ce modèle.",
          "Le délai de confection est de 2 à 3 semaines selon finitions.",
          "Si vous souhaitez, je réserve votre créneau de production aujourd'hui."
        ],
        { tag: "pricing", priority: 100 }
      ),
      toSuggestion(
        "s_2",
        "Qualif finale",
        "Sécurise les infos nécessaires avant envoi final.",
        [
          "Merci, je vous confirme tout de suite.",
          "Pouvez-vous partager votre taille et la ville de livraison ?",
          "Dès réception, je vous envoie la confirmation complète."
        ],
        { tag: "qualification", priority: 80 }
      ),
      toSuggestion(
        "s_3",
        "Conversion douce",
        "Ton luxe discret avec appel à l'action léger.",
        [
          "Très bon timing pour votre date.",
          "Je peux finaliser votre pièce et bloquer l'atelier maintenant.",
          "Souhaitez-vous que je prépare l'étape de validation ?"
        ],
        { tag: "conversion", priority: 70 }
      )
    ]
  };
}

export type MobileLabDataSource = {
  getThread: (input?: { leadId?: string }) => Promise<MobileLeadThread>;
};

export function createMockMobileLabDataSource(): MobileLabDataSource {
  return {
    async getThread(input) {
      return getMockMobileLeadThread(input?.leadId);
    }
  };
}

export function createLiveMobileLabDataSource(): MobileLabDataSource {
  return {
    async getThread(input) {
      const query = new URLSearchParams();
      query.set("mode", "active_first");
      query.set("limit", "50");
      query.set("days", "30");
      const feedRes = await fetch(`/api/whatsapp/mobile-lab/feed?${query.toString()}`);
      if (!feedRes.ok) {
        throw new Error("mobile_lab_feed_unavailable");
      }
      const feedPayload = (await feedRes.json()) as {
        items?: Array<{
          leadId: string;
          clientName: string | null;
          stage: string | null;
          urgency: string | null;
          lastMessageAt: string | null;
          lastMessagePreview: string | null;
          topReplyCard: { label: string; intent: string; messages: string[] } | null;
        }>;
      };
      const items = Array.isArray(feedPayload?.items) ? feedPayload.items : [];
      const target =
        (input?.leadId
          ? items.find((item) => String(item?.leadId || "") === String(input.leadId || ""))
          : null) ||
        items[0];
      if (!target || !target.leadId) {
        return getMockMobileLeadThread(input?.leadId);
      }

      const messagesRes = await fetch(
        `/api/whatsapp/leads/${encodeURIComponent(String(target.leadId))}/messages?limit=80`
      );
      if (!messagesRes.ok) {
        throw new Error("mobile_lab_messages_unavailable");
      }
      const messagesPayload = (await messagesRes.json()) as {
        items?: Array<{
          id: string;
          direction: "IN" | "OUT";
          text: string;
          created_at: string;
        }>;
      };
      const rawMessages = Array.isArray(messagesPayload?.items) ? messagesPayload.items : [];
      const mappedMessages: MobileChatMessage[] = rawMessages.map((item) => ({
        id: String(item?.id || ""),
        from: String(item?.direction || "").toUpperCase() === "OUT" ? "brand" : "client",
        text: String(item?.text || "").trim(),
        time: String(item?.created_at || new Date().toISOString()),
        status: String(item?.direction || "").toUpperCase() === "OUT" ? "sent" : undefined
      }));
      const topCard = target.topReplyCard;
      const suggestions: MobileSuggestionCard[] =
        topCard && Array.isArray(topCard.messages) && topCard.messages.length
          ? [
              toSuggestion(
                `${target.leadId}-top-reply-card`,
                String(topCard.label || "Option 1"),
                String(topCard.intent || "Top recommended reply"),
                topCard.messages.map((msg) => String(msg || "")),
                { tag: "TOP_CARD", priority: 100 }
              )
            ]
          : [];

      return {
        leadId: String(target.leadId),
        name: String(target.clientName || "Client"),
        stage: String(target.stage || "NEW"),
        urgency: String(target.urgency || "").toLowerCase() === "high"
          ? "High"
          : String(target.urgency || "").toLowerCase() === "low"
            ? "Low"
            : "Medium",
        unread: 0,
        lastAt: String(target.lastMessageAt || new Date().toISOString()),
        preview: String(target.lastMessagePreview || "Conversation WhatsApp"),
        messages: mappedMessages,
        suggestions
      };
    }
  };
}
