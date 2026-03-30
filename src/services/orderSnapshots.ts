export type ShippingStatus = "in_progress" | "ready" | "shipped";
export type ArticleStatus = "pending" | "in_progress" | "prepared" | "shipped";

export type OrderArticle = {
  id: string;
  title: string;
  quantity: number;
  unitPrice: number;
  status: ArticleStatus;
};

export type OrderSnapshot = {
  id: string;
  name: string;
  customerLabel: string;
  customerPhone: string;
  customerEmail?: string;
  shippingAddress?: string;
  billingAddress?: string;
  paymentGateway?: string;
  paymentBreakdown?: Array<{
    gateway: string;
    amount: number;
    currency: string;
  }>;
  paymentTransactions?: Array<{
    gateway: string;
    amount: number;
    currency: string;
    occurredAt?: string;
  }>;
  bankDetails?: {
    bankName?: string;
    swiftBic?: string;
    routingNumber?: string;
    beneficiaryName?: string;
    accountNumber?: string;
    bankAddress?: string;
    paymentReference?: string;
  };
  orderLocation: string;
  createdAt: string;
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  outstandingAmount: number;
  currency: string;
  financialStatus: string;
  shippingStatus: ShippingStatus;
  shippingDate?: string;
  articles: OrderArticle[];
};

type ShopifyLineItem = {
  id?: string | number;
  title?: string;
  quantity?: string | number;
  price?: string | number;
  fulfillment_status?: string | null;
};

type ShopifyTransaction = {
  gateway?: string;
  kind?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
  processed_at?: string;
  created_at?: string;
};

export type ShopifyOrderPayload = {
  id?: string | number;
  name?: string;
  created_at?: string;
  subtotal_price?: string | number;
  total_price?: string | number;
  total_discounts?: string | number;
  current_subtotal_price?: string | number;
  current_total_discounts?: string | number;
  total_outstanding?: string | number;
  currency?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  source_name?: string;
  location_id?: string | number;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  shipping_address?: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    country?: string;
    zip?: string;
    phone?: string;
  };
  billing_address?: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    country?: string;
    zip?: string;
    phone?: string;
  };
  payment_gateway_names?: string[];
  transactions?: ShopifyTransaction[];
  line_items?: ShopifyLineItem[];
};

type OrderUpdate = {
  shippingStatus?: ShippingStatus;
  shippingDate?: string | null;
  orderLocation?: string;
  bankDetails?: {
    bankName?: string;
    swiftBic?: string;
    routingNumber?: string;
    beneficiaryName?: string;
    accountNumber?: string;
    bankAddress?: string;
    paymentReference?: string;
  };
  articles?: Array<{ id: string; status: ArticleStatus }>;
};

const ordersById = new Map<string, OrderSnapshot>();

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferOutstandingAmount(payload: ShopifyOrderPayload, totalAmount: number, existing?: OrderSnapshot): number {
  if (payload.total_outstanding !== undefined) {
    return Math.max(0, toNumber(payload.total_outstanding));
  }

  const financialStatus = String(payload.financial_status ?? existing?.financialStatus ?? "").toLowerCase();
  if (financialStatus === "paid") return 0;
  if (financialStatus === "partially_paid") return Math.max(0, totalAmount * 0.5);

  return existing?.outstandingAmount ?? totalAmount;
}

function inferSubtotalAmount(payload: ShopifyOrderPayload, totalAmount: number, existing?: OrderSnapshot): number {
  const preferred = payload.current_subtotal_price ?? payload.subtotal_price;
  if (preferred !== undefined) {
    return Math.max(0, toNumber(preferred));
  }
  if (existing && Number.isFinite(Number(existing.subtotalAmount))) {
    return Math.max(0, Number(existing.subtotalAmount));
  }
  return Math.max(0, totalAmount);
}

function inferDiscountAmount(
  payload: ShopifyOrderPayload,
  subtotalAmount: number,
  totalAmount: number,
  existing?: OrderSnapshot
): number {
  const preferred = payload.current_total_discounts ?? payload.total_discounts;
  if (preferred !== undefined) {
    return Math.max(0, toNumber(preferred));
  }
  if (existing && Number.isFinite(Number(existing.discountAmount))) {
    return Math.max(0, Number(existing.discountAmount));
  }
  return Math.max(0, subtotalAmount - totalAmount);
}

function inferShippingStatus(payload: ShopifyOrderPayload): ShippingStatus {
  const fulfillment = String(payload.fulfillment_status ?? "").toLowerCase();
  if (fulfillment === "fulfilled") return "shipped";
  return "in_progress";
}

function inferArticleStatus(item: ShopifyLineItem): ArticleStatus {
  const fulfillment = String(item.fulfillment_status ?? "").toLowerCase();
  if (fulfillment === "fulfilled") return "shipped";
  return "pending";
}

function toArticles(payload: ShopifyOrderPayload, existing?: OrderSnapshot): OrderArticle[] {
  const incoming = (payload.line_items ?? []).map((item, index) => {
    const id = item.id ? String(item.id) : `line-${index}-${String(item.title ?? "item")}`;
    const existingStatus =
      existing?.articles.find((article) => article.id === id)?.status ?? inferArticleStatus(item);

    return {
      id,
      title: String(item.title ?? "Untitled article"),
      quantity: Math.max(1, toNumber(item.quantity)),
      unitPrice:
        item.price !== undefined
          ? Math.max(0, toNumber(item.price))
          : existing?.articles.find((article) => article.id === id)?.unitPrice ?? 0,
      status: existingStatus
    };
  });

  return incoming;
}

function customerFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string {
  const first = String(payload.customer?.first_name ?? "").trim();
  const last = String(payload.customer?.last_name ?? "").trim();
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;

  const email = String(payload.customer?.email ?? "").trim();
  if (email) return email;

  return existing?.customerLabel ?? "Unknown customer";
}

function customerPhoneFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string {
  const phone = String(payload.customer?.phone ?? "").trim();
  if (phone) return phone;
  return existing?.customerPhone ?? "Non renseigné";
}

function customerEmailFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string | undefined {
  const email = String(payload.customer?.email ?? "").trim();
  return email || existing?.customerEmail;
}

function formatAddress(
  input:
    | {
        name?: string;
        address1?: string;
        address2?: string;
        city?: string;
        country?: string;
        zip?: string;
      }
    | undefined
): string | undefined {
  if (!input) return undefined;
  const parts = [
    String(input.name ?? "").trim(),
    String(input.address1 ?? "").trim(),
    String(input.address2 ?? "").trim(),
    String(input.city ?? "").trim(),
    String(input.zip ?? "").trim(),
    String(input.country ?? "").trim()
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

function shippingAddressFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string | undefined {
  return formatAddress(payload.shipping_address) ?? existing?.shippingAddress;
}

function billingAddressFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string | undefined {
  return formatAddress(payload.billing_address) ?? existing?.billingAddress;
}

function paymentGatewayFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string | undefined {
  const gateways = Array.isArray(payload.payment_gateway_names) ? payload.payment_gateway_names : [];
  const normalized = gateways.map((name) => String(name ?? "").trim()).filter(Boolean);
  return normalized.length ? normalized.join(", ") : existing?.paymentGateway;
}

function paymentBreakdownFromPayload(
  payload: ShopifyOrderPayload,
  paidAmount: number,
  fallbackCurrency: string,
  existing?: OrderSnapshot
): Array<{ gateway: string; amount: number; currency: string }> | undefined {
  const details = paymentTransactionsFromPayload(payload, fallbackCurrency, existing);
  if (details && details.length > 0) {
    const grouped = new Map<string, { gateway: string; amount: number; currency: string }>();
    details.forEach((entry) => {
      const key = `${entry.gateway}__${entry.currency}`;
      const current = grouped.get(key);
      if (current) {
        current.amount += entry.amount;
      } else {
        grouped.set(key, { ...entry });
      }
    });
    return Array.from(grouped.values()).filter((item) => item.amount > 0);
  }

  const gatewayNames = (payload.payment_gateway_names ?? [])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  if (gatewayNames.length === 1 && paidAmount > 0) {
    return [
      {
        gateway: gatewayNames[0],
        amount: paidAmount,
        currency: String(fallbackCurrency || "MAD").toUpperCase()
      }
    ];
  }

  return existing?.paymentBreakdown;
}

function paymentTransactionsFromPayload(
  payload: ShopifyOrderPayload,
  fallbackCurrency: string,
  existing?: OrderSnapshot
): Array<{ gateway: string; amount: number; currency: string; occurredAt?: string }> | undefined {
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  if (transactions.length > 0) {
    const entries: Array<{ gateway: string; amount: number; currency: string; occurredAt?: string }> = [];
    transactions.forEach((tx) => {
      const status = String(tx.status ?? "").toLowerCase();
      const kind = String(tx.kind ?? "").toLowerCase();
      if (status && status !== "success") return;
      if (kind === "refund" || kind === "void" || kind === "authorization") return;
      const amount = Math.max(0, toNumber(tx.amount));
      if (amount <= 0) return;
      const gateway = String(tx.gateway || "Autre").trim() || "Autre";
      const currency = String(tx.currency || fallbackCurrency || "MAD").toUpperCase();
      const occurredAtRaw = String(tx.processed_at ?? tx.created_at ?? "").trim();
      entries.push({ gateway, amount, currency, occurredAt: occurredAtRaw || undefined });
    });
    if (entries.length > 0) return entries;
  }
  return existing?.paymentTransactions;
}

function locationFromPayload(payload: ShopifyOrderPayload, existing?: OrderSnapshot): string {
  const source = String(payload.source_name ?? "").trim();
  if (source) return source;

  if (payload.location_id !== undefined && payload.location_id !== null) {
    return `Location #${String(payload.location_id)}`;
  }

  return existing?.orderLocation ?? "Non renseigné";
}

function upsertOrder(payload: ShopifyOrderPayload): OrderSnapshot {
  const id = payload.id ? String(payload.id) : `unknown-${Date.now()}-${Math.random()}`;
  const existing = ordersById.get(id);
  const totalAmount = payload.total_price !== undefined ? toNumber(payload.total_price) : existing?.totalAmount ?? 0;
  const subtotalAmount = inferSubtotalAmount(payload, totalAmount, existing);
  const discountAmount = inferDiscountAmount(payload, subtotalAmount, totalAmount, existing);
  const outstandingAmount = inferOutstandingAmount(payload, totalAmount, existing);

  const next: OrderSnapshot = {
    id,
    name: payload.name ? String(payload.name) : existing?.name ?? `Order #${id}`,
    customerLabel: customerFromPayload(payload, existing),
    customerPhone: customerPhoneFromPayload(payload, existing),
    customerEmail: customerEmailFromPayload(payload, existing),
    shippingAddress: shippingAddressFromPayload(payload, existing),
    billingAddress: billingAddressFromPayload(payload, existing),
    paymentGateway: paymentGatewayFromPayload(payload, existing),
    paymentBreakdown: paymentBreakdownFromPayload(
      payload,
      Math.max(0, totalAmount - outstandingAmount),
      payload.currency ? String(payload.currency) : existing?.currency ?? "USD",
      existing
    ),
    paymentTransactions: paymentTransactionsFromPayload(
      payload,
      payload.currency ? String(payload.currency) : existing?.currency ?? "USD",
      existing
    ),
    bankDetails: existing?.bankDetails,
    orderLocation: locationFromPayload(payload, existing),
    createdAt: payload.created_at ? String(payload.created_at) : existing?.createdAt ?? new Date().toISOString(),
    subtotalAmount,
    discountAmount,
    totalAmount,
    outstandingAmount,
    currency: payload.currency ? String(payload.currency) : existing?.currency ?? "USD",
    financialStatus: payload.financial_status
      ? String(payload.financial_status)
      : existing?.financialStatus ?? "unknown",
    shippingStatus: existing?.shippingStatus ?? inferShippingStatus(payload),
    shippingDate: existing?.shippingDate,
    articles: toArticles(payload, existing)
  };

  ordersById.set(id, next);
  return next;
}

export function addOrderSnapshot(order: ShopifyOrderPayload): OrderSnapshot {
  return upsertOrder(order);
}

export function addManyOrderSnapshots(
  input: ShopifyOrderPayload[],
  options?: { pruneMissing?: boolean }
): { inserted: number } {
  const keepIds = new Set<string>();
  input.forEach((order) => {
    const snapshot = upsertOrder(order);
    keepIds.add(snapshot.id);
  });

  if (options?.pruneMissing) {
    Array.from(ordersById.keys()).forEach((id) => {
      if (!keepIds.has(id)) {
        ordersById.delete(id);
      }
    });
  }

  return { inserted: input.length };
}

function sortOrdersForQueue(a: OrderSnapshot, b: OrderSnapshot): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export function listOrdersForQueue(): Array<OrderSnapshot & { rank: number }> {
  const sorted = Array.from(ordersById.values()).sort(sortOrdersForQueue);
  return sorted.map((order, index) => ({
    ...order,
    rank: index + 1
  }));
}

export function getOrderById(orderId: string): OrderSnapshot | null {
  return ordersById.get(orderId) ?? null;
}

export function removeOrderSnapshot(orderId: string): boolean {
  const normalizedId = String(orderId || "").trim();
  if (!normalizedId) return false;
  return ordersById.delete(normalizedId);
}

export function updateOrder(orderId: string, input: OrderUpdate): OrderSnapshot | null {
  const current = ordersById.get(orderId);
  if (!current) return null;

  const articleUpdates = new Map((input.articles ?? []).map((entry) => [entry.id, entry.status]));
  const nextArticles = current.articles.map((article) => {
    const nextStatus = articleUpdates.get(article.id);
    return nextStatus ? { ...article, status: nextStatus } : article;
  });

  const next: OrderSnapshot = {
    ...current,
    shippingStatus: input.shippingStatus ?? current.shippingStatus,
    shippingDate:
      input.shippingDate === undefined
        ? current.shippingDate
        : input.shippingDate === null || input.shippingDate.trim() === ""
          ? undefined
          : input.shippingDate,
    orderLocation:
      input.orderLocation === undefined
        ? current.orderLocation
        : input.orderLocation.trim() || "Non renseigné",
    bankDetails:
      input.bankDetails === undefined
        ? current.bankDetails
        : {
            bankName: input.bankDetails.bankName?.trim() || undefined,
            swiftBic: input.bankDetails.swiftBic?.trim() || undefined,
            routingNumber: input.bankDetails.routingNumber?.trim() || undefined,
            beneficiaryName: input.bankDetails.beneficiaryName?.trim() || undefined,
            accountNumber: input.bankDetails.accountNumber?.trim() || undefined,
            bankAddress: input.bankDetails.bankAddress?.trim() || undefined,
            paymentReference: input.bankDetails.paymentReference?.trim() || undefined
          },
    articles: nextArticles
  };

  ordersById.set(orderId, next);
  return next;
}
