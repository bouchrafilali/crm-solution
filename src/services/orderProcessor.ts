import { getBusinessProfile } from "../config/business.js";

type ShopifyOrder = {
  id: number;
  total_price: string;
  customer?: {
    id: number;
    email?: string;
  };
};

export type OrderActions = {
  shouldMarkVip: boolean;
  shouldQueueReviewRequest: boolean;
};

export function evaluateOrderActions(order: ShopifyOrder): OrderActions {
  const businessProfile = getBusinessProfile();
  const total = Number(order.total_price);
  const shouldMarkVip = total >= businessProfile.highValueOrderThreshold;

  return {
    shouldMarkVip,
    shouldQueueReviewRequest: Boolean(order.customer?.email)
  };
}
