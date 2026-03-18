export interface ShoppingBrainRequest {
  message: string;
}

export interface Recommendation {
  id: string;
  title: string;
  merchant: string;
  reason: string;
  price: string;
  image?: string;
  productUrl?: string;
}

export type NextAction =
  | "explore_more"
  | "ask_size_or_details"
  | "move_toward_checkout"
  | "suggest_consultation";

export interface ShoppingBrainResponse {
  assistantSummary: string;
  recommendations: Recommendation[];
  suggestedNextQuestion?: string;
  nextQuestion?: string;
  nextAction: NextAction;
}

export interface ShoppingBrainError {
  error: string;
}
