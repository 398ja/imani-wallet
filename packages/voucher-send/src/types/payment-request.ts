/**
 * Payment Request Types
 *
 * Types for NUT-18 payment request handling.
 */

/**
 * Transport type for payment delivery
 */
export type TransportType = 'nostr' | 'post' | 'http';

/**
 * Payment transport configuration
 */
export interface PaymentTransport {
  /** Transport type */
  type: TransportType;

  /** Target (npub for nostr, URL for post/http) */
  target: string;

  /** Optional relay hints for nostr transport */
  relays?: string[];
}

/**
 * Parsed payment request (NUT-18/vreqA format)
 */
export interface PaymentRequest {
  /** Payment request ID */
  paymentId: string;

  /** Issuer/merchant public key (hex) */
  issuerId: string;

  /** Requested amount (face value in minor units) */
  amount: number;

  /** Currency unit */
  unit: string;

  /** Number of decimals */
  decimals?: number;

  /** Payment description/memo */
  description?: string;

  /** Expiry timestamp (Unix seconds) */
  expiry?: number;

  /** Transport options for payment delivery */
  transports: PaymentTransport[];

  /** Original raw request string */
  raw?: string;

  /** Single-use flag */
  singleUse?: boolean;

  /** Mints allowed for payment */
  mints?: string[];
}

/**
 * Payment request validation result
 */
export interface PaymentRequestValidation {
  /** Whether the request is valid */
  valid: boolean;

  /** Whether the request has expired */
  expired: boolean;

  /** Whether we have a matching voucher */
  hasMatchingVoucher: boolean;

  /** Whether we have sufficient balance */
  hasSufficientBalance: boolean;

  /** Available balance for this merchant */
  availableBalance?: number;

  /** Error message if invalid */
  error?: string;
}

/**
 * Payment request match result
 */
export interface PaymentRequestMatch {
  /** The payment request */
  paymentRequest: PaymentRequest;

  /** Matched merchant group */
  merchantId: string;

  /** Merchant name */
  merchantName?: string;

  /** Available voucher for payment */
  voucher?: {
    voucher_id: string;
    face_value: number;
    face_unit: string;
  };

  /** Resolved recipient from transport */
  recipient?: {
    npub: string;
    pubkeyHex: string;
    relays: string[];
  };
}
