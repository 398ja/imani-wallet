/**
 * LegacyApiAdapter - Interface for backward compatibility with old DM API
 *
 * Optional adapter for legacy API mode (listTokenDms/claimTokenDm).
 */

/**
 * Legacy DM structure from old API
 */
export interface LegacyDm {
  /** Event ID */
  eventId: string;

  /** Sender's public key */
  senderPubkey: string;

  /** DM content */
  content: string;

  /** Creation timestamp */
  createdAt: number;

  /** Status */
  status: 'pending' | 'claimed' | 'failed';
}

/**
 * Response from claiming a token DM
 */
export interface ClaimResponse {
  /** Whether claim was successful */
  success: boolean;

  /** Token if successfully claimed */
  token?: string;

  /** Error message if claim failed */
  error?: string;
}

/**
 * Response from receiving/redeeming a token
 */
export interface ReceiveResponse {
  /** Whether receive was successful */
  success: boolean;

  /** Amount received in sats */
  amount?: number;

  /** Error message if receive failed */
  error?: string;
}

/**
 * Adapter for legacy DM API operations
 */
export interface LegacyApiAdapter {
  /**
   * List pending token DMs
   *
   * @param filter - Filter options
   * @returns List of pending DMs
   */
  listTokenDms(filter: {
    status: string;
    limit: number;
  }): Promise<{ items: LegacyDm[] }>;

  /**
   * Claim a token DM
   *
   * @param eventId - Event ID to claim
   * @returns Claim response
   */
  claimTokenDm(eventId: string): Promise<ClaimResponse>;

  /**
   * Receive/redeem a token to sats
   *
   * @param token - Cashu token string
   * @returns Receive response
   */
  receive(token: string): Promise<ReceiveResponse>;
}

/**
 * Type guard to check if an object implements LegacyApiAdapter
 */
export function isLegacyApiAdapter(obj: unknown): obj is LegacyApiAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as LegacyApiAdapter;
  return (
    typeof adapter.listTokenDms === 'function' &&
    typeof adapter.claimTokenDm === 'function' &&
    typeof adapter.receive === 'function'
  );
}
