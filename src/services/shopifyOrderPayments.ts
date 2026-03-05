export type ManualPaymentMethodCode = "cash" | "cheque" | "bank_transfer" | "card" | string;

export type ManualTransactionResult = {
  ok: boolean;
  error?: string;
  gateway?: string;
};

type CreateManualTransactionInput = {
  shop: string;
  token: string;
  orderId: string;
  amount: number;
  currency?: string;
  methodCode?: ManualPaymentMethodCode;
  methodLabel?: string;
  fetchImpl?: typeof fetch;
  apiVersion?: string;
};

function normalizeRestOrderId(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const gidMatch = raw.match(/(\d+)(?:\D*)$/);
  if (gidMatch && gidMatch[1]) return gidMatch[1];
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return String(Math.floor(numeric));
  return "";
}

export function parseShopifyErrorMessage(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { errors?: unknown; error?: unknown; message?: unknown; userErrors?: unknown };
    const flatten = (value: unknown): string[] => {
      if (value == null) return [];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const v = String(value).trim();
        return v ? [v] : [];
      }
      if (Array.isArray(value)) return value.flatMap((entry) => flatten(entry));
      if (typeof value === "object") {
        return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
          flatten(nested).map((msg) => `${key}: ${msg}`)
        );
      }
      return [];
    };
    const err = flatten(parsed.errors);
    if (err.length) return err.join(" | ");
    const userErr = flatten(parsed.userErrors);
    if (userErr.length) return userErr.join(" | ");
    const one = flatten(parsed.error);
    if (one.length) return one.join(" | ");
    const msg = flatten(parsed.message);
    if (msg.length) return msg.join(" | ");
  } catch {
    // fall back to raw text
  }
  return text.slice(0, 500);
}

export function manualGatewayCandidates(methodCode?: ManualPaymentMethodCode, methodLabel?: string): string[] {
  const code = String(methodCode || "").trim().toLowerCase();
  if (code === "cash") return ["Cash", "manual"];
  if (code === "bank_transfer" || code === "cheque" || code === "card") return ["manual"];
  const label = String(methodLabel || "").trim();
  return label ? ["manual", label] : ["manual"];
}

function normalizeAmount(value: number): string {
  return Number(Math.max(0, Number(value || 0))).toFixed(2);
}

export function buildManualTransactionPayload(
  amount: number,
  gateway: string,
  currency?: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: "sale",
    status: "success",
    amount: normalizeAmount(amount),
    gateway: String(gateway || "manual"),
    source_name: "external"
  };
  const c = String(currency || "").trim().toUpperCase();
  if (c) payload.currency = c;
  return payload;
}

export async function createManualOrderTransaction(input: CreateManualTransactionInput): Promise<ManualTransactionResult> {
  const shop = String(input.shop || "").trim();
  const token = String(input.token || "").trim();
  const orderId = normalizeRestOrderId(input.orderId);
  const amount = Number(input.amount || 0);
  if (!shop || !token || !orderId || !(amount > 0)) {
    return { ok: false, error: "Paramètres de transaction invalides." };
  }

  const fetchFn = input.fetchImpl || fetch;
  const version = String(input.apiVersion || "2024-10").trim();
  const txBaseUrl = `https://${shop}/admin/api/${version}/orders/${encodeURIComponent(orderId)}/transactions.json`;
  const gateways = manualGatewayCandidates(input.methodCode, input.methodLabel);
  const currency = String(input.currency || "").trim().toUpperCase();
  let lastError = "";
  console.info(`[shopify-payment] begin endpoint=${txBaseUrl} orderId=${orderId} amount=${normalizeAmount(amount)} gateways=${gateways.join(",")}`);

  const postTransaction = async (transaction: Record<string, unknown>) => {
    const txRes = await fetchFn(txBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ transaction })
    });
    const txRaw = await txRes.text();
    return { ok: txRes.ok, status: txRes.status, raw: txRaw };
  };

  const captureFromAuthorization = async (gateway: string): Promise<ManualTransactionResult> => {
    try {
      const listRes = await fetchFn(txBaseUrl, {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token
        }
      });
      const listRaw = await listRes.text();
      if (!listRes.ok) {
        const detail = parseShopifyErrorMessage(listRaw);
        return { ok: false, error: detail || `HTTP ${listRes.status}` };
      }
      let parsed: { transactions?: Array<{ id?: number; kind?: string; status?: string }> } | null = null;
      try {
        parsed = JSON.parse(listRaw) as { transactions?: Array<{ id?: number; kind?: string; status?: string }> };
      } catch {
        parsed = null;
      }
      const txs = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
      const auth = [...txs].reverse().find((tx) => {
        const kind = String(tx?.kind || "").toLowerCase();
        const status = String(tx?.status || "").toLowerCase();
        return kind === "authorization" && (status === "success" || status === "pending");
      });
      const authId = Number(auth?.id || 0);
      if (!(authId > 0)) {
      return { ok: false, error: "Aucune authorization trouvée pour capture." };
      }
      const capturePayload: Record<string, unknown> = {
        kind: "capture",
        parent_id: authId,
        amount: normalizeAmount(amount)
      };
      if (currency) capturePayload.currency = currency;
      const capture = await postTransaction(capturePayload);
      if (capture.ok) {
        console.info(
          `[shopify-payment] capture ok status=${capture.status} orderId=${orderId} parent_id=${authId} gateway=${gateway} amount=${normalizeAmount(amount)} response=${capture.raw.slice(0, 500)}`
        );
        return { ok: true, gateway };
      }
      const detail = parseShopifyErrorMessage(capture.raw);
      return { ok: false, error: detail || `HTTP ${capture.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Erreur capture Shopify." };
    }
  };

  const authorizeThenCapture = async (gateway: string): Promise<ManualTransactionResult> => {
    try {
      const authPayload: Record<string, unknown> = {
        kind: "authorization",
        amount: normalizeAmount(amount),
        gateway,
        source_name: "external"
      };
      if (currency) authPayload.currency = currency;
      const auth = await postTransaction(authPayload);
      if (!auth.ok) {
        const authDetail = parseShopifyErrorMessage(auth.raw);
        return { ok: false, error: authDetail || `HTTP ${auth.status}` };
      }
      let authId = 0;
      try {
        const parsed = JSON.parse(auth.raw) as { transaction?: { id?: number } };
        authId = Number(parsed?.transaction?.id || 0);
      } catch {
        authId = 0;
      }
      if (!(authId > 0)) {
        return { ok: false, error: "Authorization créée sans id transaction." };
      }
      const capturePayload: Record<string, unknown> = {
        kind: "capture",
        parent_id: authId,
        amount: normalizeAmount(amount)
      };
      if (currency) capturePayload.currency = currency;
      const capture = await postTransaction(capturePayload);
      if (capture.ok) {
        console.info(
          `[shopify-payment] auth->capture ok status=${capture.status} orderId=${orderId} parent_id=${authId} gateway=${gateway} amount=${normalizeAmount(amount)} response=${capture.raw.slice(0, 500)}`
        );
        return { ok: true, gateway };
      }
      const captureDetail = parseShopifyErrorMessage(capture.raw);
      return { ok: false, error: captureDetail || `HTTP ${capture.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Erreur authorization/capture Shopify." };
    }
  };

  for (const gateway of gateways) {
    const variants = [
      {
        transaction: {
          kind: "sale",
          status: "success",
          amount: normalizeAmount(amount),
          gateway,
          source_name: "external"
        }
      },
      {
        transaction: {
          kind: "sale",
          status: "success",
          amount: normalizeAmount(amount),
          gateway,
          source_name: "external",
          currency: currency || "MAD"
        }
      }
    ];

    for (const body of variants) {
      try {
        const tx = await postTransaction(body.transaction as Record<string, unknown>);
        if (tx.ok) {
          console.info(
            `[shopify-payment] transaction ok status=${tx.status} orderId=${orderId} gateway=${gateway} amount=${normalizeAmount(amount)} response=${tx.raw.slice(0, 500)}`
          );
          return { ok: true, gateway };
        }
        const detail = parseShopifyErrorMessage(tx.raw);
        console.warn(
          `[shopify-payment] transaction rejected status=${tx.status} orderId=${orderId} gateway=${gateway} payload=${JSON.stringify(body)} detail=${detail}`
        );
        lastError = detail || `HTTP ${tx.status}`;
        const saleInvalid = /sale/i.test(lastError) && /not valid transaction|is not valid transaction|is not a valid transaction/i.test(lastError);
        if (saleInvalid) {
          const captured = await captureFromAuthorization(gateway);
          if (captured.ok) return captured;
          if (captured.error) lastError = captured.error;
          const authCapture = await authorizeThenCapture(gateway);
          if (authCapture.ok) return authCapture;
          if (authCapture.error) lastError = authCapture.error;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Erreur transaction Shopify.";
        console.error(`[shopify-payment] transaction request failed orderId=${orderId} gateway=${gateway}`, error);
        lastError = detail;
      }
    }
  }

  return { ok: false, error: lastError || "Transaction refusée par Shopify." };
}
