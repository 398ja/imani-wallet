/**
 * Closed sets for every enum-shaped field that can reach data/ (#589 review). A value outside its set
 * becomes 'other'. Shape is not enough: a person's name typed in lowercase is a valid lowercase token,
 * so only values the code itself writes are kept. Lists come from the writers (wallet-storage types,
 * dmPoll, pay.ts, cashlink, checkout, terminal roster, notifications); a new value the code starts
 * writing shows up as 'other' in a snapshot until it is added here, which loses detail but never leaks.
 */

const set = (...v: string[]) => new Set(v)

export const ENUMS = {
  voucherStatus: set('active', 'pending', 'spent', 'redeemed', 'fully_redeemed', 'reserved', 'outstanding', 'claimed',
    'cancelled', 'expired', 'swapped_to_sats', 'reclaimed', 'minting', 'locking', 'returning', 'returned', 'blocked',
    'waiting', 'failed', 'abandoned', 'unknown', 'gone', 'in-service', 'fulfilled', 'done', 'restricted'),
  backingStrategy: set('ledger', 'sats', 'proof', 'escrow', 'mint', 'v2', 'legacy'),
  sourceTransport: set('sse', 'catchup', 'manual', 'cashback', 'escrow_recovery', 'client_mint', 'gateway_mint', 'gift_link', 'gift_link_reclaim'),
  txType: set('sent', 'received', 'payment', 'issued', 'cashback', 'send', 'receive', 'bundle-receive', 'redeemed', 'swap', 'refund', 'gift', 'cashlink', 'checkout'),
  direction: set('in', 'out'),
  deliveryState: set('pending', 'partial', 'confirmed', 'unconfirmed'),
  redemptionStatus: set('pending', 'redeemed', 'failed', 'refused', 'held', 'active', 'spent'),
  sendState: set('pending', 'settled', 'failed', 'reclaimed', 'confirmed', 'sending', 'splitting', 'token_held', 'dm_error', 'split_error', 'unknown'),
  terminalRole: set('till', 'shop', 'owner', 'cashier', 'terminal', 'manager'),
  terminalState: set('enrolled', 'waiting', 'revoked', 'active', 'forgotten', 'pending'),
  notificationType: set('received', 'sent', 'payment', 'cashback', 'cashlink_expired', 'voucher_claimed', 'voucher_expiring',
    'voucher_received', 'generic', 'currency', 'ready', 'issued', 'refused', 'held'),
  backupKind: set('drive', 'file', 'key', 'passphrase', 'local'),
  recordState: set('open', 'pending', 'paid', 'used', 'expired', 'cancelled', 'claiming', 'claimed', 'moving', 'locked', 'done',
    'refunded', 'active', 'failed', 'settled', 'redeemed', 'issued', 'unknown'),
  errorName: set('Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
    'DOMException', 'AbortError', 'NetworkError', 'TimeoutError', 'QuotaExceededError', 'NotFoundError', 'InvalidStateError',
    'DataError', 'NotAllowedError', 'SecurityError', 'OperationError', 'SessionLockedError', 'GatewayUnreachableError',
    'BlossomUploadError', 'SnapshotLeakError', 'SnapshotCodeError', 'SnapshotUploadError', 'ChannelError', 'NoRelayAcceptedError'),
  errorCode: set('CRC_MISMATCH', 'IMPORT_ERROR', 'INTERNAL', 'INVALID_UR_FRAGMENT', 'MISSING_FACE_UNIT', 'PARSE_ERROR',
    'PUBLISH_ERROR', 'RECEIVE_DEFERRED', 'RECEIVE_HELD', 'RELAY_REJECT', 'SALES_LIMIT_REACHED', 'UNKNOWN', 'AUTH_001', 'AUTH_002',
    'nip98_auth_required', 'voucher_not_accepted', 'mint_fetch', 'rate_limited', 'invalid_or_expired', 'timeout', 'offline'),
  /** ISO-4217 codes the wallet handles, plus its own units. */
  unit: set('sat', 'msat', 'sats', 'btc', 'eur', 'usd', 'gbp', 'chf', 'jpy', 'aud', 'cad', 'brl', 'mxn', 'krw', 'vnd', 'zar',
    'ngn', 'kes', 'ghs', 'tzs', 'ugx', 'xof', 'xaf', 'cfa', 'fcfa'),
} as const

export type EnumName = keyof typeof ENUMS

/** The value if it is in the set, 'other' if it is a string outside it, undefined if absent. */
export function closed(name: EnumName, v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') return 'other'
  const s = name === 'errorName' || name === 'errorCode' ? v : v.toLowerCase()
  return (ENUMS[name] as Set<string>).has(s) ? s : 'other'
}

/**
 * Error message templates the wallet's own code writes. The ring records whatever message an Error
 * had, which may include something a person typed; a message that matches no registered template
 * becomes '<message>'. Templates are compared after the ring's own normalisation (placeholders, <n>).
 */
export const ERROR_TEMPLATES: RegExp[] = [
  /^Failed to fetch( active keysets)?(: mintUrl=<[a-z#0-9]+>, status=<[a-z0-9 ]+>)?$/,
  /^Failed to fetch keysets( status <n>)?$/,
  /^NetworkError when attempting to fetch resource\.$/,
  /^The wallet is locked\.$/,
  /^No signer .*the wallet has not been unlocked\.$/,
  /^Load failed$/,
  /^The operation was aborted\.?$/,
  /^signal is aborted without reason$/,
  /^Mint <url> rejected swap: [a-z_]+ \(<n>\)$/,
  /^Coupon \(unknown\) carries no usable authorisation from the stall$/,
  /^Request failed with status <n>$/,
  /^QuotaExceededError$/,
  /^Unexpected end of JSON input$/,
  /^Unexpected token .{1,3} in JSON at position <n>$/,
  /^Cannot read properties of (undefined|null)$/,
]

export function knownTemplate(t: unknown): string {
  if (typeof t !== 'string') return '<message>'
  return ERROR_TEMPLATES.some((re) => re.test(t)) ? t : '<message>'
}

/**
 * Module files that exist in this build, for stack frames: the list is baked in by vite.config.ts
 * (`__SNAPSHOT_MODULES__`, from src/ and packages/ at build time). A production frame names a hashed
 * asset instead, whose name Vite derives from a module name, so that shape is accepted too.
 * A frame matching neither is dropped.
 */
declare const __SNAPSHOT_MODULES__: string[] | undefined
const modules = new Set<string>(typeof __SNAPSHOT_MODULES__ !== 'undefined' ? __SNAPSHOT_MODULES__ : [])
const ASSET = /^assets\/[A-Za-z0-9_-]{1,60}-[A-Za-z0-9_-]{8}\.js$/

export function knownFrame(f: unknown): string | undefined {
  if (typeof f !== 'string') return undefined
  const m = /^([\w./-]{1,120}):(\d{1,6})(?::(\d{1,6}))?$/.exec(f)
  if (!m || !(modules.has(m[1]) || ASSET.test(m[1]))) return undefined
  return f
}
