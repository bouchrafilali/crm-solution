import type { WhatsAppFollowUpKind } from "../db/whatsappLeadsRepo.js";
import { env } from "../config/env.js";

export type WhatsAppOutboundMessage = {
  leadId: string;
  phoneNumber: string;
  text: string;
  shop?: string | null;
  metadata?: Record<string, unknown>;
};

export type WhatsAppDispatchResult = {
  ok: boolean;
  provider: "placeholder" | "zoko";
  messageId?: string;
  error?: string;
  payload?: unknown;
};

function zokoAuthHeader(): { key: string; value: string } {
  const authHeader = String(env.ZOKO_AUTH_HEADER || "apikey").trim();
  const authPrefix = String(env.ZOKO_AUTH_PREFIX || "").trim();
  const token = String(env.ZOKO_AUTH_TOKEN || "").trim();
  return {
    key: authHeader,
    value: authPrefix ? `${authPrefix} ${token}` : token
  };
}

async function dispatchWhatsAppText(message: WhatsAppOutboundMessage): Promise<WhatsAppDispatchResult> {
  const apiUrl = String(env.ZOKO_API_URL || "").trim();
  const auth = zokoAuthHeader();
  if (!apiUrl || !auth.value) {
    return {
      ok: false,
      provider: "placeholder",
      error: "zoko_not_configured"
    };
  }

  const channel = String(env.ZOKO_CHANNEL || "whatsapp").trim();
  const payloadVariants: Array<Record<string, unknown>> = [
    { channel, recipient: message.phoneNumber, type: "text", message: message.text },
    { channel, recipient: message.phoneNumber, type: "text", text: message.text },
    { channel, recipient: message.phoneNumber, text: message.text }
  ];

  for (const payload of payloadVariants) {
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [auth.key]: auth.value
        },
        body: JSON.stringify(payload)
      });
      const raw = await res.text();
      let json: unknown = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = raw;
      }
      if (res.ok) {
        return {
          ok: true,
          provider: "zoko",
          messageId: `zoko_${Date.now()}_${message.leadId.slice(0, 8)}`,
          payload: json
        };
      }
    } catch {
      // Try next payload variant
    }
  }

  return {
    ok: false,
    provider: "zoko",
    error: "zoko_send_failed"
  };
}

export async function dispatchWhatsAppFollowUp(
  kind: WhatsAppFollowUpKind,
  message: WhatsAppOutboundMessage
): Promise<WhatsAppDispatchResult> {
  const zokoResult = await dispatchWhatsAppText(message);
  if (zokoResult.ok) {
    console.log("[whatsapp] zoko dispatch", {
      kind,
      leadId: message.leadId,
      phoneNumber: message.phoneNumber,
      shop: message.shop || null
    });
    return zokoResult;
  }

  const syntheticMessageId = `wa_${kind}_${Date.now()}_${message.leadId.slice(0, 8)}`;
  console.log("[whatsapp] placeholder dispatch", {
    kind,
    leadId: message.leadId,
    phoneNumber: message.phoneNumber,
    shop: message.shop || null,
    message: message.text
  });

  return {
    ok: true,
    provider: "placeholder",
    messageId: syntheticMessageId,
    payload: {
      channel: "whatsapp-placeholder",
      metadata: message.metadata || null
    }
  };
}
