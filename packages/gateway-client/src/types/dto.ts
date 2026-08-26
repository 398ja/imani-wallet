/**
 * Data Transfer Objects matching the backend gateway API
 */

/**
 * Quote state enumeration matching QuoteEntity.QuoteState
 */
export type QuoteState = 'PENDING' | 'PAID' | 'ISSUED' | 'EXPIRED' | 'FAILED';

/**
 * Payment method types
 */
export type PaymentMethod = 'bolt11' | 'cash';

/**
 * Event sent when payment is confirmed via SSE or synthesized from polling
 * Matches backend PaymentConfirmedEvent
 */
export interface PaymentConfirmedEvent {
  /** Quote ID */
  quote_id: string;

  /** Payment method used */
  payment_method: PaymentMethod;

  /** Amount paid */
  amount: number;

  /** Currency unit (e.g., 'sat', 'usd') */
  unit: string;

  /** Lightning payment preimage (present for bolt11 payments) */
  preimage?: string;

  /** Receipt ID (present for cash payments) */
  receipt_id?: string;

  /** ISO 8601 timestamp of payment confirmation */
  paid_at: string;
}

/**
 * Webhook payload from payment-adapter to gateway
 * Matches backend PaymentWebhookPayload
 */
export interface PaymentWebhookPayload {
  quote_id: string;
  payment_method: PaymentMethod;
  amount: number;
  unit: string;
  preimage?: string;
  receipt_id?: string;
  paid_at: string;
}

/**
 * Response from creating a mint quote
 * Matches backend MintQuoteResponse
 */
export interface MintQuoteResponse {
  /** Quote ID */
  quote: string;

  /** Lightning invoice (bolt11) or payment URI */
  request: string;

  /** Current quote state */
  state: QuoteState;

  /** Expiry timestamp (Unix seconds) */
  expiry: number;

  /** Amount to pay */
  amount?: number;

  /** Currency unit */
  unit?: string;
}

/**
 * SSE connected event sent when subscription is established
 */
export interface ConnectedEvent {
  status: 'subscribed';
  quote_id: string;
}

/**
 * SSE diagnostics event for monitoring connection health
 */
export interface DiagnosticsEvent {
  quote_id: string;
  subscribers: number;
  reconnects: number;
  last_error: string | null;
  last_broadcast_at: string | null;
}
