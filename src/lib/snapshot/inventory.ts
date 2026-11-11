/**
 * The storage inventory (#589 section 3): deny by default.
 *
 * Every localStorage key the wallet writes has a rule here, matched by prefix. A key with no rule is
 * excluded and reported in `manifest.redaction.unknown_keys` by its prefix and byte length only. A
 * key with a rule is either excluded outright, or passed to a `reduce` function that builds a NEW
 * object from the fields it names; nothing is ever copied through by default, so a field added to a
 * stored record later cannot slip into a snapshot without someone writing it here.
 *
 * `__tests__/inventory.test.ts` scans src/ and packages/ for key literals and IndexedDB stores and
 * fails when one has no rule (criterion 2).
 */
import type { PseudonymType } from './ids'
import { closed } from './enums'

/** What a reducer may use: pseudonyms, the salted hash, and the free-text scrubber. */
export interface ReduceContext {
  /** Collect pass: register a real id. Name pass: return its pseudonym. */
  id(type: PseudonymType, real: unknown): string | undefined
  hash(real: unknown): string | undefined
  memo(text: unknown): string | undefined
  stall: boolean
}

export interface InventoryRule {
  prefix: string
  action: 'exclude' | 'reduce'
  /** Only on a Stall wallet (Terminals, Takings). */
  stallOnly?: boolean
  /** Ledger-shaped: trimmed by whole days when the size budget is exceeded. */
  ledger?: boolean
  reduce?: (value: unknown, ctx: ReduceContext) => unknown
  why: string
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : isRec(v) ? Object.values(v) : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** Closed-set values only (enums.ts): anything the code does not write becomes 'other'. */
const st = (r: Rec) => closed('recordState', r.state ?? r.status)
const unit = (v: unknown) => closed('unit', v)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
const time = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v) ? v : undefined)

/** Count, total amount and age range of a list of money-ish records. */
function moneyList(v: unknown) {
  const rows = arr(v).filter(isRec)
  const times = rows.map((r) => num(r.createdAt) ?? num(r.created_at) ?? num(r.at)).filter((t): t is number => t !== undefined)
  return {
    count: rows.length,
    amounts: rows.map((r) => num(r.amount) ?? 0),
    states: rows.map((r) => st(r) ?? null),
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
  }
}

function counted(v: unknown) {
  const rows = arr(v)
  return { count: rows.length }
}

/** Presence and serialised size only: nothing of the value. */
function present(v: unknown) {
  return { present: v !== null && v !== undefined, length: v === null || v === undefined ? 0 : JSON.stringify(v).length }
}

function pendingSends(v: unknown, ctx: ReduceContext) {
  return arr(v).filter(isRec).map((r) => ({
    send: ctx.id('send', r.sendId),
    token: ctx.hash(r.tokenId),
    amount: num(r.amount),
    unit: unit(r.unit),
    decimals: num(r.decimals),
    issuer: ctx.id(r.merchantPubkey === undefined ? 'party' : 'stall', r.merchantPubkey),
    recipient: ctx.id('customer', r.recipientPubkey),
    request: ctx.id('request', r.paymentRequestId),
    voucher: ctx.id('voucher', r.voucherId),
    state: closed('sendState', r.state ?? r.status),
    attempts: num(r.attempts),
    created_at: time(r.createdAt),
  }))
}

function terminals(v: unknown, ctx: ReduceContext) {
  return arr(v).filter(isRec).map((r) => ({
    terminal: ctx.id('terminal', r.terminalPubkey),
    role: closed('terminalRole', r.role),
    state: closed('terminalState', r.state ?? (r.revokedAt ? 'revoked' : r.waitingUntil ? 'waiting' : 'enrolled')),
    enrolled_at: time(r.enrolledAt),
    last_used_at: time(r.lastUsedAt),
    revoked_at: time(r.revokedAt),
    shop: bool(r.shop),
    has_credential: typeof r.token === 'string',
  }))
}

function paymentRequests(v: unknown, ctx: ReduceContext) {
  return arr(v).filter(isRec).map((r) => ({
    request: ctx.id('request', r.id),
    amount: num(r.amount),
    unit: unit(r.unit),
    state: st(r),
    created_at: time(r.createdAt),
    payment: ctx.id('payment', r.stripe ?? r.paymentIntentId),
  }))
}

function notifications(v: unknown, ctx: ReduceContext) {
  return arr(v).filter(isRec).map((r) => ({
    type: closed('notificationType', r.type),
    at: time(r.at) ?? time(r.timestamp),
    read: bool(r.read),
    event: ctx.id('event', r.eventId),
    voucher: ctx.id('voucher', r.voucherId),
  }))
}

function idSet(v: unknown, ctx: ReduceContext) {
  const rows = arr(v)
  return { count: rows.length, events: rows.slice(-50).map((x) => (typeof x === 'string' ? ctx.id('event', x) : undefined)) }
}

function profile(v: unknown) {
  const r = isRec(v) ? v : {}
  return {
    has_name: typeof r.name === 'string' && r.name !== '',
    has_nip05: typeof r.nip05 === 'string' && r.nip05 !== '',
    has_picture: typeof r.picture === 'string' && r.picture !== '',
    has_about: typeof r.about === 'string' && r.about !== '',
    backups: arr(r.backups).filter(isRec).map((b) => ({ kind: closed('backupKind', b.kind), at: time(b.at) })),
  }
}

function merchantFlags(v: unknown) {
  const r = isRec(v) ? v : {}
  return {
    open: bool(r.open),
    accepts_cards: bool(r.acceptsCards),
    has_shop: bool(r.hasShop) ?? bool(r.onlineShop),
    categories: arr(r.categories).length,
    currency: unit(r.currency),
  }
}

/**
 * Setting names the wallet writes. A key outside this list is counted, never named: a key can be
 * typed text too (a review probe used one), and data/ holds only closed-set words.
 */
export const SETTING_KEYS = new Set(['haptics', 'sound', 'theme_dark', 'compact', 'sort', 'reduced_motion', 'notifications',
  'expiry_reminders', 'use_profile_service', 'consent', 'nap_consent', 'show_sats'])

/** Settings: booleans and numbers under known names only; strings are dropped, unknown names counted. */
function flags(v: unknown) {
  if (!isRec(v)) return typeof v === 'boolean' || typeof v === 'number' ? v : null
  const out: Rec = {}
  for (const [k, x] of Object.entries(v)) {
    if (!SETTING_KEYS.has(k)) {
      out.other_settings = (typeof out.other_settings === 'number' ? out.other_settings : 0) + 1
      continue
    }
    // Booleans and numbers only: a string setting may be something the person typed.
    if (typeof x === 'boolean' || typeof x === 'number') out[k] = x
  }
  return out
}

function stateOnly(v: unknown) {
  if (isRec(v)) return { state: st(v), at: time(v.at) ?? time(v.createdAt), expires_at: time(v.expiresAt) ?? time(v.expires_at) }
  return { present: v !== null && v !== undefined }
}

function codes(v: unknown, ctx: ReduceContext) {
  return arr(v).map((r) =>
    isRec(r)
      ? { code: ctx.hash(r.code), amount: num(r.amount), state: st(r), created_at: time(r.createdAt) }
      : { code: ctx.hash(r) },
  )
}

function secretsRecords(v: unknown, ctx: ReduceContext) {
  return arr(v).filter(isRec).map((r) => ({
    id: ctx.hash(r.id ?? r.ref),
    amount: num(r.amount),
    state: st(r),
    created_at: time(r.createdAt),
    expires_at: time(r.expiresAt),
  }))
}

const X = (prefix: string, why: string): InventoryRule => ({ prefix, action: 'exclude', why })
const R = (prefix: string, reduce: InventoryRule['reduce'], why: string, extra: Partial<InventoryRule> = {}): InventoryRule => ({
  prefix,
  action: 'reduce',
  reduce,
  why,
  ...extra,
})

/** Longest matching prefix wins, so order here is for reading only. */
export const RULES: InventoryRule[] = [
  // Keys, sessions, credentials: never.
  X('imani-wallet-key', 'nap encrypted key envelope'),
  X('imani-wallet:onboarding-nsec', 'an nsec'),
  X('imani-wallet:resume', 'resume wrap pointer'),
  X('imani-wallet:identity:', 'identity material'),
  X('imani:issuer-delegation', 'issuer delegation signature'),
  X('imani-terminal-attestation', 'terminal attestation secret'),
  X('imani-terminal-enrolment', 'terminal enrolment secret'),
  X('imani-terminal-credential', 'terminal credential token'),
  X('imani-wallet:fcm-token', 'push token'),
  X('imani-wallet:terminal:sale-outbox', 'unsent till sales carry tokens'),
  X('imani-wallet:terminal', 'this device as a terminal: credentials'),
  X('imani-wallet:gift-link-next:', 'gift link secrets, refund key, recipient email'),
  X('imani-wallet:gift-restore-scan:', 'gift restore scan cursor with secrets'),
  X('imani-wallet:cashlink-locks:', 'lock secrets'),
  X('imani-wallet:unsaved-receipts:', 'receipts carry tokens'),
  X('imani-wallet:voucher-splits:', 'split intents carry blinding factors'),
  X('imani-wallet:swap-intents:', 'blinding factors'),
  X('imani-wallet:send-intents:', 'idempotency keys'),
  X('imani-wallet:pending-claim', 'a claim link secret'),
  X('imani:afterLogin', 'navigation intent with link secrets'),
  X('imani:pendingPurchase', 'checkout session'),
  X('imani_dm_held', 'held DMs: encrypted payloads'),
  X('imani_pending_bundle_sends', 'bundle sends carry tokens'),
  X('imani-terminal-renew-request', 'renewal request secret'),

  // Money in flight: shape only.
  R('imani-wallet:pending-sends:', pendingSends, 'sends whose outcome is not known yet'),
  R('imani:cashback:pending', moneyList, 'cashback not yet claimed, tokens excluded'),
  R('imani:cashback-stash', moneyList, 'cashback stash, tokens excluded'),
  R('imani-wallet:cashlink-claims:', secretsRecords, 'Cashlink claims, secrets excluded'),
  R('imani-wallet:cashlink-moving:', secretsRecords, 'Cashlinks moving, secrets excluded'),
  R('imani-wallet:cashlink-intents:', secretsRecords, 'Cashlink intents, secrets excluded'),
  R('imani-wallet:cashlink-expired:', counted, 'expired Cashlinks'),
  R('imani-wallet:checkout-codes:', codes, 'checkout code ledger, codes hashed'),
  R('imani:checkout-codes', codes, 'checkout codes, hashed'),
  R('imani-wallet:checkout-refund-next:', counted, 'refund counter'),
  R('imani-wallet:settled-sends:', counted, 'settled send ids'),
  R('imani-wallet:delete-pending', stateOnly, 'account deletion in progress'),
  R('imani-wallet:logout', stateOnly, 'logout in progress'),

  // Stall: Terminals and Takings by default (owner decision 7).
  R('imani-wallet:terminals:', terminals, 'Terminals', { stallOnly: true }),
  R('imani-wallet:terminals-forgotten:', counted, 'forgotten Terminals', { stallOnly: true }),
  R('imani-wallet:terminals-synced:', stateOnly, 'roster sync state', { stallOnly: true }),
  R('imani:terminals', counted, 'legacy roster', { stallOnly: true }),
  R('imani-wallet:till-sales-cursor:', stateOnly, 'Takings cursor', { stallOnly: true }),
  R('imani-wallet:payment-requests:', paymentRequests, 'payment requests', { stallOnly: true, ledger: true }),
  R('imani-wallet:merchant:', merchantFlags, 'Stall flags only, no name/picture/location/redeemKey', { stallOnly: true }),
  R('imani:merchant', merchantFlags, 'Stall flags only', { stallOnly: true }),
  R('imani-wallet:online-shop-published:', stateOnly, 'online shop state', { stallOnly: true }),

  // Profile and records.
  R('imani-wallet:profile:', profile, 'booleans and backup dates only'),
  R('imani-wallet:backup-record:', stateOnly, 'backup kind and time'),
  R('imani-wallet:notifications:', notifications, 'type, time, read flag', { ledger: true }),
  R('imani-wallet:notification-prefs:', flags, 'notification preferences'),

  // DM poll bookkeeping: counts and event pseudonyms.
  R('imani-wallet:dm-poll:processed', idSet, 'processed DM ids', { ledger: true }),
  R('imani-wallet:dm-poll:received', idSet, 'received DM ids', { ledger: true }),
  R('imani-wallet:dm-poll:chunk-amnesty', counted, 'chunk amnesty'),
  R('imani-wallet:dm-chunks:completed', counted, 'completed chunk sets'),
  R('imani-wallet:incoming-seen:', counted, 'incoming seen'),
  R('imani-wallet:bundle-arrivals:', counted, 'bundle arrivals'),
  R('imani_dm_processed_events', counted, 'dm-poll processed'),
  R('imani_dm_watermark', stateOnly, 'dm-poll watermark'),
  R('imani_dm_', counted, 'dm-poll bookkeeping'),

  // Settings and statuses.
  R('imani:settings', flags, 'settings'),
  R('imani-wallet:coupon-sort', flags, 'sort order'),
  R('imani_use_profile_service', flags, 'flag'),
  R('imani-wallet:nap-consent', flags, 'consent flag'),
  R('imani-wallet:expiry-reminders:', counted, 'expiry reminders'),
  R('imani-wallet:expiry-banner-dismissed:', stateOnly, 'banner dismissed'),
  R('imani-wallet:finish-profile-dismissed:', stateOnly, 'prompt dismissed'),
  R('imani-subscription-status', stateOnly, 'subscription status'),
  R('imani:subscription-status', stateOnly, 'subscription status'),
  R('imani-subscription', stateOnly, 'subscription'),
  R('imani:verification:', stateOnly, 'verification status'),
  R('imani:issued:', counted, 'issued records'),
  R('imani-wallet:snapshots', counted, 'support snapshot records'),
  // #591: the fleet opt-in record (install nonce), a held request (its code) and fleet history.
  // Reported by family and size only: never a value, so neither the nonce nor a code reaches data/.
  R('imani-wallet:fleet:', present, 'fleet opt-in state: presence only'),
  X('imani-wallet:error-ring', 'read through errorRing.ts into data/errors.json, not as storage'),
  X('imani-wallet:console-ring', 'read through consoleRing.ts into data/console.json, not as storage'),
  // accountStore.ts stores, keyed `imani-wallet:<name>:<pubkey>`.
  X('imani-wallet:held-coupons:', 'held coupons carry tokens'),
  X('imani-wallet:refused-coupons:', 'refused coupons carry tokens'),
  X('imani-wallet:bundle-claims:', 'bundle claims carry tokens'),
  X('imani-wallet:pending-bundles:', 'pending bundles carry tokens'),
  R('imani-wallet:receive-trouble:', counted, 'receive trouble entries'),
]

/** IndexedDB stores: what the snapshot does with each (criterion 2 covers this table too). */
export const IDB_STORES: Record<string, 'vouchers' | 'transactions' | 'cursor' | 'exclude'> = {
  wallet_vouchers: 'vouchers',
  wallet_transactions: 'transactions',
  vouchers: 'vouchers',
  transactions: 'transactions',
  sync_metadata: 'cursor',
  pending_receipts: 'exclude',
  wrap: 'exclude',
  cache: 'exclude',
  follows: 'exclude',
  // The "Not now" ciphertext itself (collect.ts, DB imani-wallet-snapshots): never re-snapshotted.
  kept: 'exclude',
}

export function ruleFor(key: string): InventoryRule | undefined {
  let best: InventoryRule | undefined
  for (const r of RULES) {
    if ((key === r.prefix || key.startsWith(r.prefix)) && (!best || r.prefix.length > best.prefix.length)) best = r
  }
  return best
}

/** Placeholders a key suffix may become in data/: never the suffix itself (#589 review). */
export const KEY_SUFFIX_RE = /^<(self|pubkey|id|[a-z_]+)(#\d{1,6})?>$/

/**
 * The name a kept key is shown under in data/: its rule's prefix, then a typed placeholder for any
 * suffix. A suffix is this wallet's pubkey (`<self>`), another 64-hex key (its pseudonym, or
 * `<pubkey>`), or anything else (`<id>`). The suffix's text never appears.
 */
export function reportableKeyName(key: string, rule: InventoryRule, self: string, pseudonymOf: (pk: string) => string | undefined): string {
  const suffix = key.slice(rule.prefix.length)
  if (suffix === '') return rule.prefix
  if (suffix.toLowerCase() === self.toLowerCase()) return rule.prefix + '<self>'
  if (/^[0-9a-f]{64}$/i.test(suffix)) {
    const p = pseudonymOf(suffix.toLowerCase())
    return rule.prefix + (p ? `<${p}>` : '<pubkey>')
  }
  return rule.prefix + '<id>'
}

/** An unknown key, reported by namespace family only: `imani-wallet:<unknown>`, `imani:<unknown>`, or `<unknown>`. */
export function unknownKeyFamily(key: string): string {
  const m = /^(imani-wallet|imani|imani_dm|imani)([:_-])/.exec(key)
  return m ? `${m[1]}${m[2]}<unknown>` : '<unknown>'
}

/** Whether a data/ key name is exactly a known prefix plus at most one placeholder. */
export function isInventoryKeyName(s: string): boolean {
  return RULES.some((r) => s === r.prefix || (s.startsWith(r.prefix) && KEY_SUFFIX_RE.test(s.slice(r.prefix.length))))
}
