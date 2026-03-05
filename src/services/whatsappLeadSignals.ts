import type { WhatsAppInboundMessageSnippet, WhatsAppLeadRecord } from "../db/whatsappLeadsRepo.js";
import { updateWhatsAppLeadDestination, updateWhatsAppLeadEventDate } from "../db/whatsappLeadsRepo.js";
import { extractDestinationFromMessages } from "./destinationExtractor.js";
import { extractEventDateFromMessages } from "./eventDateExtractor.js";

function isDestinationEmpty(lead: WhatsAppLeadRecord): boolean {
  return !lead.shipCity && !lead.shipRegion && !lead.shipCountry && !lead.shipDestinationText;
}

function normIso(value: string | null | undefined): string {
  const v = String(value || "").trim().toUpperCase();
  return v || "";
}

export async function applyInboundSignalExtraction(
  lead: WhatsAppLeadRecord,
  inboundMessages: WhatsAppInboundMessageSnippet[],
  recentMessages?: Array<{ id: string; text: string; createdAt: string; direction: "IN" | "OUT" }>
): Promise<{ eventDateUpdated: boolean; destinationUpdated: boolean }> {
  const safeInbound = Array.isArray(inboundMessages) ? inboundMessages : [];
  const safeRecent = Array.isArray(recentMessages) ? recentMessages : [];
  let eventDateUpdated = false;
  let destinationUpdated = false;

  if (!lead.eventDateManual) {
    const extractedDate = extractEventDateFromMessages(safeInbound, new Date(), "UTC");
    const currentConfidence = Number(lead.eventDateConfidence || 0);
    const hasMonthPrecision = extractedDate.eventDatePrecision === "MONTH" && Number.isFinite(Number(extractedDate.eventMonth));
    if (
      extractedDate.confidence >= 70 &&
      (
        (
          extractedDate.date &&
          (!lead.eventDate || extractedDate.confidence > currentConfidence)
        ) ||
        (
          hasMonthPrecision &&
          (!String(lead.eventDateText || "").trim() || extractedDate.confidence > currentConfidence)
        )
      )
    ) {
      await updateWhatsAppLeadEventDate({
        id: lead.id,
        // Keep existing exact day when extractor only has month-level precision.
        eventDate: extractedDate.date || lead.eventDate || null,
        eventDateText: extractedDate.raw,
        eventDateConfidence: extractedDate.confidence,
        sourceMessageId: extractedDate.sourceMessageId,
        manual: false
      });
      eventDateUpdated = true;
    }
  }

  if (!lead.shipDestinationManual) {
    const destinationMessages = safeRecent.length
      ? safeRecent.map((msg) => ({
          id: String(msg.id || ""),
          text: String(msg.text || ""),
          createdAt: String(msg.createdAt || ""),
          direction: msg.direction
        }))
      : safeInbound;
    const extractedDestination = extractDestinationFromMessages(
      destinationMessages,
      { country: lead.country, shipCountry: lead.shipCountry },
      new Date()
    );
    const currentConfidence = Number(lead.shipDestinationConfidence || 0);
    const hasAnyExtracted = Boolean(
      extractedDestination.ship_city ||
      extractedDestination.ship_region ||
      extractedDestination.ship_country ||
      extractedDestination.raw
    );
    const extractedCountry = normIso(extractedDestination.destination?.country || extractedDestination.ship_country);
    const currentCountry = normIso(lead.shipCountry);
    const cityCountryConflict = Boolean(
      extractedDestination.ship_city &&
      extractedCountry &&
      currentCountry &&
      extractedCountry !== currentCountry
    );
    if (
      hasAnyExtracted &&
      extractedDestination.confidence >= 70 &&
      (isDestinationEmpty(lead) || extractedDestination.confidence > currentConfidence || cityCountryConflict)
    ) {
      await updateWhatsAppLeadDestination({
        id: lead.id,
        shipCity: extractedDestination.ship_city,
        shipRegion: extractedDestination.ship_region,
        shipCountry: extractedDestination.destination?.country || extractedDestination.ship_country,
        shipDestinationText: extractedDestination.raw,
        shipDestinationConfidence: extractedDestination.confidence,
        sourceMessageId: extractedDestination.sourceMessageId,
        manual: false
      });
      destinationUpdated = true;
    }
  }

  return { eventDateUpdated, destinationUpdated };
}
