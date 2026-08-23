/**
 * Incoming-payment notification envelope — ported from imani-apps'
 * `@imani/incoming-notifications` package (spec 018).
 *
 * Why this exists: settlement (the on-chain / mint redemption of a coupon) can
 * lag behind the moment a payer decides to pay. imani-apps closes that gap with
 * an Artemis (JMS) message queue: the gateway enqueues a small, token-free
 * "a payment is on its way" envelope the instant the send saga starts, and the
 * recipient drains the queue every few seconds. The envelope carries who paid,
 * how much, and a stable id — never any token material — so the wallet can show
 * an instant toast while the real redemption catches up through dm-poll.
 *
 * This file is the consumer half: the wire types plus the 7-step validator that
 * gates every drained envelope before it is allowed to raise a toast. It is a
 * faithful port of the package's `types.ts`, `envelope.ts`, and `redactor.ts`,
 * trimmed to what the wallet consumes (the metrics emitter, state machine, and
 * outbox retry loop are server/observability concerns the wallet does not need
 * to raise a toast). Kept as a local copy rather than aliased to the imani-apps
 * package because that package is not in this repo's Vite alias map and the
 * consumer surface is small and stable.
 */

import { sha256 } from '@noble/hashes/sha256'

// ---------------------------------------------------------------------------
// Wire types (v1). Mirror the canonical JSON schema; the schema is the source
// of truth in imani-apps and these must stay in lock-step with it.
// ---------------------------------------------------------------------------

export type NotificationState =
  | 'pending'
  | 'redeeming'
  | 'redeemed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'expired'
  | 'attention'

export type FailureReason =
  | 'network'
  | 'mint_unavailable'
  | 'already_spent'
  | 'expired'
  | 'invalid_token'
  | 'unknown'

export interface EnvelopeSender {
  pubkeyHex: string
  npub: string
  displayName?: string | null
  picture?: string | null
}

export interface EnvelopeRecipient {
  pubkeyHex: string
  npub: string
}

export interface Currency {
  unit: string
  decimals: number
}

export interface MoneyAmount {
  minorUnits: number
  display: string
}

export interface EnvelopeCorrelation {
  bundleId?: string | null
  deliveryEventId?: string | null
  fallbackWindowId?: string | null
}

export interface NotificationPart {
  partId: string
  deliveryEventId?: string | null
  bundlePartIndex?: number | null
  amount: MoneyAmount
  state: NotificationState
  failureReason?: FailureReason | null
  detectedAt?: string | null
  redeemedAt?: string | null
}

export interface EnvelopeToast {
  titleKey?: string
  fallbackTitle?: string
  showEventReference?: boolean
}

export interface IncomingPaymentNotificationEnvelope {
  v: 1
  kind: 'incoming_payment_notification'
  notificationId: string
  state: NotificationState
  sender: EnvelopeSender
  recipient: EnvelopeRecipient
  currency: Currency
  total: MoneyAmount
  parts: NotificationPart[]
  correlation?: EnvelopeCorrelation | null
  toast?: EnvelopeToast
  createdAt: string
  updatedAt: string
  detectedAt?: string | null
  redeemedAt?: string | null
  supportRef?: string | null
}

// ---------------------------------------------------------------------------
// Redactor — forbidden-field sweep (spec 018 FR-008).
//
// A valid envelope MUST NOT carry cashu token material, proofs, private keys,
// or decrypted DM bodies. This is the authoritative gate and runs as step 6 of
// validation: an envelope that smuggles any token-shaped key or value is a
// spoof or a backend bug, and either way must never reach the toast.
// ---------------------------------------------------------------------------

// Substrings in NORMALIZED form (lowercase, `_`/`-` stripped). The comparison
// side normalizes the candidate key the same way, so `private_key`,
// `private-key`, `privateKey`, `PRIVATE_KEY` all collapse to one match.
const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = [
  'token',
  'proof',
  'secret',
  'blinding',
  'nsec',
  'privatekey',
  'decrypted',
  'plaintextbody',
]

const FORBIDDEN_VALUE_PREFIXES: readonly string[] = ['cashua', 'cashub']

const SAFE_KEY_NAMES: ReadonlySet<string> = new Set([])

/** Deep-scan an arbitrary value for token material. Cycle-safe. */
export function containsTokenMaterial(value: unknown): boolean {
  return scan(value, new WeakSet())
}

function scan(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return matchesForbiddenValue(value)
  if (typeof value !== 'object') return false

  if (seen.has(value as object)) return false
  seen.add(value as object)

  if (Array.isArray(value)) {
    for (const item of value) {
      if (scan(item, seen)) return true
    }
    return false
  }

  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (matchesForbiddenKey(key)) return true
    if (scan(v, seen)) return true
  }
  return false
}

function matchesForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (SAFE_KEY_NAMES.has(lower)) return false
  const normalized = lower.replace(/[_-]/g, '')
  for (const needle of FORBIDDEN_KEY_SUBSTRINGS) {
    if (normalized.includes(needle)) return true
  }
  return false
}

function matchesForbiddenValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 6) return false
  const head = trimmed.slice(0, 6).toLowerCase()
  for (const prefix of FORBIDDEN_VALUE_PREFIXES) {
    if (head === prefix) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// notificationId derivation + validation.
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/
const NPUB = /^npub1[023456789acdefghjklmnpqrstuvwxyzq]+$/

const ALLOWED_STATES: ReadonlySet<NotificationState> = new Set<NotificationState>([
  'pending',
  'redeeming',
  'redeemed',
  'failed_retryable',
  'failed_terminal',
  'expired',
  'attention',
])

const ALLOWED_FAILURE_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'network',
  'mint_unavailable',
  'already_spent',
  'expired',
  'invalid_token',
  'unknown',
])

/**
 * Canonical notificationId:
 *   sha256(recipientPubkeyHex || senderPubkeyHex || correlationId || currencyUnit)
 * The caller resolves `correlationId` via `pickCorrelationId` first.
 */
export function computeNotificationId(args: {
  recipientPubkeyHex: string
  senderPubkeyHex: string
  correlationId: string
  currencyUnit: string
}): string {
  const input =
    args.recipientPubkeyHex + args.senderPubkeyHex + args.correlationId + args.currencyUnit
  const digest = sha256(new TextEncoder().encode(input))
  let hex = ''
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * The digest input must be a PER-ENVELOPE-UNIQUE field. deliveryEventId is
 * per-part and preferred; bundleId is per-bundle and only a last resort (using
 * it first would collide every part of a multi-part bundle onto one id, and the
 * broker's _AMQ_DUPL_ID dedup would drop all but the first). Returns null when
 * no correlation source exists — a hard validation failure.
 */
export function pickCorrelationId(
  correlation: IncomingPaymentNotificationEnvelope['correlation'],
): string | null {
  if (!correlation) return null
  if (correlation.deliveryEventId) return correlation.deliveryEventId
  if (correlation.bundleId) return correlation.bundleId
  if (correlation.fallbackWindowId) return correlation.fallbackWindowId
  return null
}

export interface ValidateOk {
  ok: true
  envelope: IncomingPaymentNotificationEnvelope
}
export interface ValidateFail {
  ok: false
  reason: string
}
export type ValidateResult = ValidateOk | ValidateFail

function fail(reason: string): ValidateFail {
  return { ok: false, reason }
}

/**
 * Validate an unknown JSON value against the v1 envelope contract, in the
 * canonical 7-step order:
 *   1. shape  2. notificationId integrity  3. supportRef shape
 *   4. recipient match  5. amount integrity  6. forbidden-field sweep
 *   7. timestamp sanity
 *
 * Returns a typed envelope on success or a short, contents-free reason on
 * failure. `expectedRecipientPubkeyHex` is the wallet's own identity — an
 * envelope addressed to anyone else is rejected at step 4.
 */
export function validateEnvelope(
  value: unknown,
  expectedRecipientPubkeyHex: string,
  nowMs: number = Date.now(),
): ValidateResult {
  // ---- step 1: shape ----
  if (typeof value !== 'object' || value === null) return fail('not_object')
  const e = value as Record<string, unknown>

  if (e['v'] !== 1) return fail('bad_v')
  if (e['kind'] !== 'incoming_payment_notification') return fail('bad_kind')

  if (typeof e['notificationId'] !== 'string') return fail('bad_notificationId_type')
  const notificationId = e['notificationId'] as string
  if (notificationId.length < 16 || notificationId.length > 128) {
    return fail('bad_notificationId_length')
  }

  if (typeof e['state'] !== 'string' || !ALLOWED_STATES.has(e['state'] as NotificationState)) {
    return fail('bad_state')
  }

  if (typeof e['sender'] !== 'object' || e['sender'] === null) return fail('bad_sender')
  const sender = e['sender'] as Record<string, unknown>
  if (typeof sender['pubkeyHex'] !== 'string' || !HEX_64.test(sender['pubkeyHex'])) {
    return fail('bad_sender_pubkeyHex')
  }
  if (typeof sender['npub'] !== 'string' || !NPUB.test(sender['npub'])) {
    return fail('bad_sender_npub')
  }

  if (typeof e['recipient'] !== 'object' || e['recipient'] === null) return fail('bad_recipient')
  const recipient = e['recipient'] as Record<string, unknown>
  if (typeof recipient['pubkeyHex'] !== 'string' || !HEX_64.test(recipient['pubkeyHex'])) {
    return fail('bad_recipient_pubkeyHex')
  }
  if (typeof recipient['npub'] !== 'string' || !NPUB.test(recipient['npub'])) {
    return fail('bad_recipient_npub')
  }

  if (typeof e['currency'] !== 'object' || e['currency'] === null) return fail('bad_currency')
  const currency = e['currency'] as Record<string, unknown>
  if (
    typeof currency['unit'] !== 'string' ||
    currency['unit'].length < 1 ||
    currency['unit'].length > 16
  ) {
    return fail('bad_currency_unit')
  }
  if (
    typeof currency['decimals'] !== 'number' ||
    !Number.isInteger(currency['decimals']) ||
    currency['decimals'] < 0 ||
    currency['decimals'] > 18
  ) {
    return fail('bad_currency_decimals')
  }

  if (typeof e['total'] !== 'object' || e['total'] === null) return fail('bad_total')
  const total = e['total'] as Record<string, unknown>
  if (
    typeof total['minorUnits'] !== 'number' ||
    !Number.isInteger(total['minorUnits']) ||
    total['minorUnits'] < 0
  ) {
    return fail('bad_total_minorUnits')
  }
  if (
    typeof total['display'] !== 'string' ||
    total['display'].length < 1 ||
    total['display'].length > 64
  ) {
    return fail('bad_total_display')
  }

  if (!Array.isArray(e['parts']) || e['parts'].length < 1 || e['parts'].length > 100) {
    return fail('bad_parts_array')
  }
  for (const p of e['parts'] as unknown[]) {
    const partFail = validatePart(p)
    if (partFail) return fail(partFail)
  }

  if (typeof e['createdAt'] !== 'string') return fail('bad_createdAt')
  if (typeof e['updatedAt'] !== 'string') return fail('bad_updatedAt')

  const correlationOk =
    e['correlation'] === undefined ||
    e['correlation'] === null ||
    typeof e['correlation'] === 'object'
  if (!correlationOk) return fail('bad_correlation')

  if (e['supportRef'] !== undefined && e['supportRef'] !== null) {
    if (typeof e['supportRef'] !== 'string' || e['supportRef'].length > 64) {
      return fail('bad_supportRef')
    }
  }

  const env = value as IncomingPaymentNotificationEnvelope

  // ---- step 2: notificationId integrity ----
  const correlationId = pickCorrelationId(env.correlation)
  if (!correlationId) return fail('no_correlation')
  const expectedId = computeNotificationId({
    recipientPubkeyHex: env.recipient.pubkeyHex,
    senderPubkeyHex: env.sender.pubkeyHex,
    correlationId,
    currencyUnit: env.currency.unit,
  })
  // Backends MAY prepend a tracking prefix (e.g. "ipn-<digest>"), so the
  // recomputed digest need only appear at the END of the id.
  if (!env.notificationId.endsWith(expectedId) && env.notificationId !== expectedId) {
    return fail('notificationId_mismatch')
  }

  // ---- step 3: supportRef shape (already checked in step 1) ----

  // ---- step 4: recipient match ----
  if (env.recipient.pubkeyHex !== expectedRecipientPubkeyHex) {
    return fail('recipient_mismatch')
  }

  // ---- step 5: amount integrity ----
  let sum = 0
  for (const p of env.parts) sum += p.amount.minorUnits
  if (sum !== env.total.minorUnits) return fail('amount_mismatch')

  // ---- step 6: forbidden-field sweep ----
  if (containsTokenMaterial(env)) return fail('forbidden_field')

  // ---- step 7: timestamp sanity ----
  // createdAt in [now - 7d, now + 60s]; skew tolerance matches spec 014.
  const createdMs = Date.parse(env.createdAt)
  if (!Number.isFinite(createdMs)) return fail('bad_createdAt_format')
  if (createdMs > nowMs + 60_000) return fail('createdAt_future')
  if (createdMs < nowMs - 7 * 24 * 60 * 60 * 1000) return fail('createdAt_stale')
  const updatedMs = Date.parse(env.updatedAt)
  if (!Number.isFinite(updatedMs)) return fail('bad_updatedAt_format')
  if (updatedMs > nowMs + 60_000) return fail('updatedAt_future')

  return { ok: true, envelope: env }
}

function validatePart(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'bad_part'
  const part = p as Record<string, unknown>

  if (
    typeof part['partId'] !== 'string' ||
    part['partId'].length < 1 ||
    part['partId'].length > 128
  ) {
    return 'bad_part_partId'
  }
  if (typeof part['state'] !== 'string' || !ALLOWED_STATES.has(part['state'] as NotificationState)) {
    return 'bad_part_state'
  }
  if (typeof part['amount'] !== 'object' || part['amount'] === null) return 'bad_part_amount'
  const amount = part['amount'] as Record<string, unknown>
  if (
    typeof amount['minorUnits'] !== 'number' ||
    !Number.isInteger(amount['minorUnits']) ||
    amount['minorUnits'] < 0
  ) {
    return 'bad_part_amount_minorUnits'
  }
  if (
    typeof amount['display'] !== 'string' ||
    amount['display'].length < 1 ||
    amount['display'].length > 64
  ) {
    return 'bad_part_amount_display'
  }
  if (part['failureReason'] !== undefined && part['failureReason'] !== null) {
    if (
      typeof part['failureReason'] !== 'string' ||
      !ALLOWED_FAILURE_REASONS.has(part['failureReason'] as FailureReason)
    ) {
      return 'bad_part_failureReason'
    }
  }
  return null
}

/**
 * Customer-friendly sender label: "Name" is preferred, then a truncated npub.
 * The wallet has no synchronous kind-0 profile cache the way imani-apps does,
 * so this is the envelope-only subset of imani-apps' `_formatSenderLabel`.
 */
export function formatSenderLabel(sender: EnvelopeSender): string {
  if (sender.displayName && sender.displayName.trim()) return sender.displayName.trim()
  const npub = sender.npub
  if (typeof npub === 'string' && npub.length >= 16) {
    return npub.slice(0, 12) + '…' + npub.slice(-4)
  }
  return npub || sender.pubkeyHex.slice(0, 8)
}
