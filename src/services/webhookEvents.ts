import crypto from "node:crypto";

export type WebhookEvent = {
  id: string;
  topic: string;
  receivedAt: string;
  orderId?: string;
  summary: string;
};

const events: WebhookEvent[] = [];

export function addWebhookEvent(input: Omit<WebhookEvent, "id" | "receivedAt">): WebhookEvent {
  const event: WebhookEvent = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ...input
  };

  events.unshift(event);
  if (events.length > 100) {
    events.pop();
  }

  return event;
}

export function listWebhookEvents(): WebhookEvent[] {
  return [...events];
}
