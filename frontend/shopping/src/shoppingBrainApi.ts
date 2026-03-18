import type { ShoppingBrainRequest, ShoppingBrainResponse } from "./types.js";

export async function queryShoppingBrain(
  message: string
): Promise<ShoppingBrainResponse> {
  const body: ShoppingBrainRequest = { message };

  const res = await fetch("/api/shopping-brain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(text || `Request failed: ${res.status}`);
  }

  return res.json() as Promise<ShoppingBrainResponse>;
}
