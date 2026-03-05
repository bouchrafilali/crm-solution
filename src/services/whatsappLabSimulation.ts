import { applyStageProgression, detectConversationEvents, detectSignalsFromMessages } from "./conversationStageProgression.js";
import { extractDestinationFromMessages } from "./destinationExtractor.js";
import { extractEventDateFromMessages } from "./eventDateExtractor.js";
import { detectQualificationTags } from "./leadQualificationService.js";

export type LabDirection = "IN" | "OUT";

export type LabMessage = {
  direction: LabDirection;
  text: string;
  created_at: string;
};

export type LabSimulationInput = {
  messages: LabMessage[];
  mode?: "basic" | "strict";
  language?: "FR" | "EN";
};

type NormalizedLabMessage = { id: string; direction: LabDirection; text: string; createdAt: string };

function inferLanguage(messages: NormalizedLabMessage[]): "FR" | "EN" {
  const lastInbound = messages
    .slice()
    .reverse()
    .find((m) => m.direction === "IN");
  const text = String(lastInbound?.text || "").toLowerCase();
  if (/\b(price|payment|shipping|date|destination|confirm)\b/.test(text)) return "EN";
  return "FR";
}

function normalizeMessages(messages: LabMessage[]): NormalizedLabMessage[] {
  return (Array.isArray(messages) ? messages : [])
    .map((m, index) => {
      const direction: LabDirection = String(m?.direction || "").toUpperCase() === "OUT" ? "OUT" : "IN";
      const text = String(m?.text || "").trim();
      const createdAtRaw = String(m?.created_at || "").trim();
      const parsed = createdAtRaw ? new Date(createdAtRaw).getTime() : NaN;
      const createdAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(Date.now() + index * 1000).toISOString();
      return { id: `lab-${index + 1}`, direction, text, createdAt };
    })
    .filter((m) => m.text.length > 0);
}

function hasSilent48hAfterPrice(messages: NormalizedLabMessage[]): boolean {
  const ordered = messages.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let lastPriceOutTs: number | null = null;
  for (const msg of ordered) {
    if (msg.direction !== "OUT") continue;
    if (/\b(le\s+prix\s+est|price\s+is|priced\s+at|prix)\b/i.test(msg.text) || /\b(?:mad|dhs?|dh|€|\$|eur|usd)\s*[0-9]/i.test(msg.text)) {
      lastPriceOutTs = new Date(msg.createdAt).getTime();
    }
  }
  if (!Number.isFinite(Number(lastPriceOutTs))) return false;
  for (const msg of ordered) {
    const ts = new Date(msg.createdAt).getTime();
    if (ts <= Number(lastPriceOutTs)) continue;
    if (msg.direction === "IN") return false;
  }
  return (Date.now() - Number(lastPriceOutTs)) >= 48 * 3600000;
}

function suggestionFor(input: {
  stage: string;
  missing: string[];
  lastInbound: string;
  language: "FR" | "EN";
  signals: {
    hasPriceSent: boolean;
    hasPaymentQuestion: boolean;
    hasDepositLinkSent: boolean;
    chatConfirmed: boolean;
    silent48hAfterPrice: boolean;
  };
}): { type: "QUALIFICATION" | "PRICE_CONTEXTUALIZED" | "DEPOSIT_STEP" | "CONFIRMATION_STEP" | "FOLLOW_UP"; text: string; reasoning: string; confidence: number } {
  const fr = input.language === "FR";
  const stage = String(input.stage || "NEW").toUpperCase();
  const missing = new Set((input.missing || []).map((m) => String(m).toUpperCase()));

  if (stage === "CONFIRMED") {
    return {
      type: "CONFIRMATION_STEP",
      text: fr
        ? "Parfait, merci pour votre confirmation. Je vous envoie la prochaine étape pour finaliser sereinement."
        : "Perfect, thank you for confirming. I will share the final next step to proceed smoothly.",
      reasoning: "Lead is confirmed after deposit/payment phase.",
      confidence: 90
    };
  }
  if (stage === "DEPOSIT_PENDING") {
    return {
      type: "DEPOSIT_STEP",
      text: fr
        ? "Très bien. Je peux vous partager le lien d’acompte pour bloquer votre créneau de confection."
        : "Great. I can share the deposit link to secure your production slot.",
      reasoning: "Payment signal detected and stage is deposit pending.",
      confidence: 88
    };
  }
  if (stage === "QUALIFIED") {
    if (!input.signals.hasPriceSent) {
      return {
        type: "PRICE_CONTEXTUALIZED",
        text: fr
          ? "Parfait, nous sommes dans les délais. Le prix est de [prix] avec un délai de confection de [délai]. Si vous le souhaitez, je peux vous proposer une courte visio privée."
          : "Perfect, timelines work. I can now share the contextualized price and production timeline.",
        reasoning: "Qualification complete and no price sent yet.",
        confidence: 84
      };
    }
    if (!input.signals.hasPaymentQuestion && !input.signals.hasDepositLinkSent) {
      return {
        type: "FOLLOW_UP",
        text: fr
          ? "Parfait. Je peux vous proposer une visio privée demain à 11h00 ou 16h30, quel créneau vous convient ?"
          : "Would you like me to guide you to the next step (video call or deposit), based on your preference?",
        reasoning: "Qualified with price already sent, waiting for next-step intent.",
        confidence: 78
      };
    }
  }
  if (stage === "PRICE_SENT") {
    if (input.signals.hasPaymentQuestion || input.signals.hasDepositLinkSent) {
      return {
        type: "DEPOSIT_STEP",
        text: fr
          ? "Parfait, c'est noté. Souhaitez-vous que je vous envoie le lien d’acompte pour bloquer votre créneau de confection ?"
          : "Perfect, noted. Would you like me to send the deposit link to secure your production slot?",
        reasoning: "Price sent and payment/deposit intent detected; move to deposit step.",
        confidence: 86
      };
    }
    return {
      type: "FOLLOW_UP",
      text: fr
        ? (input.signals.silent48hAfterPrice
          ? "Je me permets un petit suivi. Si vous le souhaitez, je peux réserver votre créneau de confection et vous guider sur la prochaine étape, à votre rythme."
          : "Parfait. Je peux vous proposer une visio privée demain à 11h00 ou 16h30, quel créneau vous convient ?")
        : "Perfect. I can offer a private video call tomorrow at 11:00 or 16:30, which slot works best for you?",
      reasoning: input.signals.silent48hAfterPrice
        ? "Price sent with no inbound reply for 48h; elegant reactivation follow-up."
        : "Price sent without payment signal; propose scheduling step.",
      confidence: input.signals.silent48hAfterPrice ? 88 : 85
    };
  }

  const askEvent = missing.has("EVENT_DATE");
  const askDestination = missing.has("DESTINATION");
  const askSizing = missing.has("SIZING");
  const text = fr
    ? askEvent && askDestination
      ? "Merci. Pour avancer, pouvez-vous me confirmer la date de l’événement et la ville/pays de livraison ?"
      : askEvent
        ? "Merci. Pouvez-vous me confirmer la date de l’événement ?"
        : askDestination
          ? "Merci. Pouvez-vous me confirmer la ville/pays de livraison ?"
          : askSizing
            ? "Merci. En mode strict, j’ai aussi besoin des mesures/taille pour finaliser la qualification."
            : "Merci pour votre message. Je vous accompagne sur la suite."
    : askEvent && askDestination
      ? "Thanks. To proceed, could you confirm your event date and delivery city/country?"
      : askEvent
        ? "Thanks. Could you confirm the event date?"
        : askDestination
          ? "Thanks. Could you confirm delivery city/country?"
          : askSizing
            ? "Thanks. In strict mode I also need sizing/measurements to complete qualification."
            : "Thanks for your message. I will guide you through the next step.";

  return {
    type: "QUALIFICATION",
    text,
    reasoning: `Qualification is incomplete. Missing: ${(Array.from(missing).join(", ") || "none")}. Last inbound: ${input.lastInbound.slice(0, 80)}`,
    confidence: missing.size > 0 ? 86 : 70
  };
}

export function runWhatsAppLabSimulation(input: LabSimulationInput): {
  signals: {
    product_interest: boolean;
    price_sent: boolean;
    video_proposed: boolean;
    payment_question: boolean;
    deposit_link_sent: boolean;
    chat_confirmed: boolean;
  };
  qualification: {
    event_date: string | null;
    destination: { city: string | null; country: string | null; label: string | null };
    complete: boolean;
    missing: string[];
  };
  stage: {
    main: string;
    reasoning: string;
    confidence: number;
  };
  suggestion: {
    type: "QUALIFICATION" | "PRICE_CONTEXTUALIZED" | "DEPOSIT_STEP" | "CONFIRMATION_STEP" | "FOLLOW_UP";
    text: string;
    reasoning: string;
    confidence: number;
  };
} {
  const mode = String(input.mode || "basic").toLowerCase() === "strict" ? "strict" : "basic";
  const messages = normalizeMessages(input.messages || []);
  const language = input.language === "EN" || input.language === "FR" ? input.language : inferLanguage(messages);
  const inbound = messages.filter((m) => m.direction === "IN");
  const lastInboundText = String(inbound[inbound.length - 1]?.text || "");

  const eventDate = extractEventDateFromMessages(
    inbound.map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt })),
    new Date(),
    "UTC"
  );
  const destination = extractDestinationFromMessages(
    messages.map((m) => ({ id: m.id, direction: m.direction, text: m.text, createdAt: m.createdAt })),
    { country: null, shipCountry: null },
    new Date()
  );

  const tags = new Set<string>();
  for (const msg of inbound) {
    for (const tag of detectQualificationTags(msg.text)) tags.add(String(tag).toUpperCase());
  }

  const simulatedLead = {
    id: "lab",
    clientName: "Lab Client",
    phoneNumber: "+0000000000",
    country: "MA",
    inquirySource: "LAB",
    productReference: null,
    priceSent: false,
    productionTimeSent: false,
    stage: "NEW",
    firstResponseTimeMinutes: null,
    lastActivityAt: null,
    internalNotes: null,
    qualificationTags: Array.from(tags),
    intentLevel: null,
    stageConfidence: null,
    stageAuto: false,
    stageAutoReason: null,
    stageAutoSourceMessageId: null,
    stageAutoConfidence: null,
    stageAutoUpdatedAt: null,
    recommendedStage: null,
    recommendedStageReason: null,
    recommendedStageConfidence: null,
    detectedSignals: { tags: [], rules_triggered: [], evidence: [] },
    conversionValue: null,
    convertedAt: null,
    conversionSource: null,
    shopifyOrderId: null,
    shopifyFinancialStatus: null,
    paymentReceived: false,
    depositPaid: false,
    marketingOptIn: false,
    marketingOptInSource: null,
    marketingOptInAt: null,
    eventDate: eventDate.date,
    eventDateText: eventDate.raw,
    eventDateConfidence: eventDate.confidence,
    eventDateSourceMessageId: eventDate.sourceMessageId,
    eventDateUpdatedAt: null,
    eventDateManual: false,
    shipCity: destination.ship_city,
    shipRegion: destination.ship_region,
    shipCountry: destination.ship_country,
    shipDestinationText: destination.raw,
    shipDestinationConfidence: destination.confidence,
    shipDestinationSourceMessageId: destination.sourceMessageId,
    shipDestinationUpdatedAt: null,
    shipDestinationManual: false,
    hasProductInterest: false,
    hasPriceSent: false,
    hasVideoProposed: false,
    hasPaymentQuestion: false,
    hasDepositLinkSent: false,
    chatConfirmed: false,
    priceIntent: false,
    videoIntent: false,
    paymentIntent: false,
    depositIntent: false,
    confirmationIntent: false,
    lastSignalAt: null,
    productInterestSourceMessageId: null,
    priceSentSourceMessageId: null,
    videoProposedSourceMessageId: null,
    paymentQuestionSourceMessageId: null,
    depositLinkSourceMessageId: null,
    chatConfirmedSourceMessageId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as const;

  const signalDetection = detectSignalsFromMessages(messages, simulatedLead as any);
  const leadWithSignals = {
    ...(simulatedLead as any),
    hasProductInterest: signalDetection.hasProductInterest,
    hasPriceSent: signalDetection.hasPriceSent,
    hasVideoProposed: signalDetection.hasVideoProposed,
    hasPaymentQuestion: signalDetection.hasPaymentQuestion,
    hasDepositLinkSent: signalDetection.hasDepositLinkSent,
    chatConfirmed: signalDetection.chatConfirmed,
    priceIntent: signalDetection.priceIntent,
    videoIntent: signalDetection.videoIntent,
    paymentIntent: signalDetection.paymentIntent,
    depositIntent: signalDetection.depositIntent,
    confirmationIntent: signalDetection.confirmationIntent
  };

  const events = detectConversationEvents(messages, leadWithSignals);
  const progression = applyStageProgression(leadWithSignals, events, {
    paymentReceived: false,
    depositPaid: false,
    hasPaidShopifyOrder: false
  });

  const missing: string[] = [];
  if (!eventDate.date) missing.push("EVENT_DATE");
  const destinationValue =
    destination.ship_city ||
    destination.ship_region ||
    destination.raw;
  if (mode === "strict" && !tags.has("SIZING")) missing.push("SIZING");

  const suggestion = suggestionFor({
    stage: progression.nextStage,
    missing,
    lastInbound: lastInboundText,
    language,
    signals: {
      hasPriceSent: signalDetection.hasPriceSent,
      hasPaymentQuestion: signalDetection.hasPaymentQuestion,
      hasDepositLinkSent: signalDetection.hasDepositLinkSent,
      chatConfirmed: signalDetection.chatConfirmed,
      silent48hAfterPrice: hasSilent48hAfterPrice(messages)
    }
  });

  const stageReasoning = progression.reason ||
    (progression.nextStage === "QUALIFIED"
      ? "Moved to QUALIFIED because event_date is present."
      : progression.nextStage === "QUALIFICATION_PENDING"
        ? "Stayed QUALIFICATION_PENDING because event_date is missing."
        : `Moved to ${progression.nextStage} based on detected conversation signals.`);

  return {
    signals: {
      product_interest: signalDetection.hasProductInterest,
      price_sent: signalDetection.hasPriceSent,
      video_proposed: signalDetection.hasVideoProposed,
      payment_question: signalDetection.hasPaymentQuestion,
      deposit_link_sent: signalDetection.hasDepositLinkSent,
      chat_confirmed: signalDetection.chatConfirmed
    },
    qualification: {
      event_date: eventDate.date,
      destination: {
        city: destination.destination?.city || destination.ship_city || null,
        country: destination.destination?.country || destination.ship_country || null,
        label: destinationValue ? String(destinationValue) : null
      },
      complete: missing.length === 0,
      missing
    },
    stage: {
      main: progression.nextStage,
      reasoning: stageReasoning,
      confidence: Number(progression.confidence ?? 85)
    },
    suggestion
  };
}
