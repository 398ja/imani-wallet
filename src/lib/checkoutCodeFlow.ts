/**
 * Making a checkout code, and getting its value back (#402), the customer's whole side.
 *
 * A code is 1..20 parts, one coupon each, every proof locked to the shop key `S` until `x` with the
 * part's own refund key `R` (contract §2). Each part is armed EXACTLY as a Cashlink is
 * (`cashlinkFlow.armGift`, with `S` in place of the link key): burn into outputs derived from `R`,
 * the gateway's `/cashlink/lock` signs the `S`-locked successor (`checkoutLockProposal`'s bytes),
 * mint it, and deposit each proof's pre-signed refund with the relay, NIP-98 signed by `R`. So a page
 * that dies anywhere resumes from `R` and the proof alone, and `R` comes from the identity key and a
 * persisted wallet-wide counter (`deriveCheckoutRefundSecret`), never from anything the shop knows.
 *
 * ## All or nothing
 *
 * Every part is checked BEFORE the first burn (`armPreflight`): one that cannot be locked stops the
 * code while every coupon is still the coupon it was. A part that still fails after its burn (the
 * lock refused, the mint refusing the burn) ends the attempt: no code is deposited, the parts already
 * locked come back at `x` (the relay, or this wallet posting the same refund), and the rest are kept
 * as they came back. The deposit itself is all or nothing on the store's side (R8).
 *
 * ## After the code
 *
 * - `redeemed`: the shop spent the parts. The record is finished; any change arrives as `change`.
 * - `change` / `cancelled`: coupons locked to `R` with no locktime. Each is burnt by `R` and re-signed
 *   unlocked by gateway-customer `POST /checkout/unlock` (contract §5), then kept.
 * - `expired`, or `x` passed: each part comes back through the Cashlink refund path
 *   (`settleLockedGift` with only the refund key).
 *
 * Notifications arrive as NIP-17 DMs from the store (`imani-checkout-code/1`); `GET /mine` is the
 * fallback when one is lost.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import {
  CHECKOUT_UNLOCK_TAG,
  cashlinkAuthorization,
  deriveCheckoutRefundSecret,
  derivedNonce,
  derivedOutputs,
  unlockedProposal,
  xOnlyPub,
  isTheSuccessorAskedFor,
  randomRefundSecret,
} from './cashlinkLock'
import { armGift, armPreflight, cashlinkSteps, inParallel, retryDeposit, settleLockedGift, type ArmOutcome, type CashlinkPorts, type GatewayAnswer } from './cashlinkFlow'
import { normalise } from './checkoutCode'
import { checkoutTxId } from './checkoutCodeHistory'
import type { OnlineShop } from './onlineShop'
import { checkLockedGift } from './lockedGifts'
import {
  loadCheckoutCodes,
  remainingOf,
  reserveCheckoutRefundIndices,
  saveCheckoutCode,
  type CheckoutCodeRecord,
  type CheckoutCodeStatus,
  type CheckoutPartRecord,
} from './checkoutCodeRecords'
import { creditableFaceValue, parseVoucherToken, tokenProofs, voucherOfProof, type TokenProof } from './voucherToken'
import { withQueuedLock } from './webLock'

const { mintOf, proofBody, burnOutputsBody, restoreMine, swapOrRestore, signRoute, notYet, tokenOf, mintCarrier } = cashlinkSteps

export const CHECKOUT_CODES_PATH = '/v1/checkout-codes'
export const UNLOCK_PATH = '/api/v1/wallet/vouchers/checkout/unlock'
export const CHECKOUT_NOTICE_TYPE = 'imani-checkout-code/1'

// --- Ports ------------------------------------------------------------------

export interface CheckoutStore {
  /** A NIP-98 call signed by the customer. Throws only when unreachable. */
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<GatewayAnswer>
}

/** One movement for the History list. */
export interface CheckoutActivity {
  id: string
  at: number
  stall: string
  unit: string
  decimals: number
  /** Minor units. */
  amount: number
  memo: string
}

export interface CheckoutPorts extends CashlinkPorts {
  store: CheckoutStore
  /** A COPY of the identity key, which the caller zeroes; null when this wallet cannot read it. */
  identitySecret(): Uint8Array | null
  /** A bearer token worth exactly `amount` carved off the coupon row `tokenId`, its change kept. */
  carve(tokenId: string, amount: number): Promise<string>
  /** The coupon row a part was made from is spent (its proofs were burnt into the lock). */
  consume(tokenId: string): Promise<void>
  /** Write a History row. */
  activity(row: CheckoutActivity): Promise<void>
  /**
   * The change a shop gave back, as its OWN incoming history row (never the code's memo): value
   * arrived in the wallet. Optional so test worlds without it fall back to `activity`.
   */
  changeActivity?(row: CheckoutActivity): Promise<void>
  /**
   * #472: one order used part of a code and the rest stays on it: its OWN outgoing history row
   * (`checkout:<id>:used:<n>`). Optional so test worlds without it fall back to `activity`.
   */
  usedActivity?(row: CheckoutActivity): Promise<void>
}

// --- Making a code ----------------------------------------------------------

export interface CheckoutPlanPart {
  tokenId: string
  token: string
  /** What this part draws, minor units. */
  amount: number
  /** The coupon's whole credited face value. */
  faceValue: number
}

export interface StartCheckoutCode {
  ports: CheckoutPorts
  pubkey: string
  stall: string
  shop: OnlineShop
  unit: string
  decimals: number
  amount: number
  x: number
  parts: CheckoutPlanPart[]
  id?: string
}

export type CheckoutOutcome =
  | { kind: 'issued'; record: CheckoutCodeRecord }
  /** Nothing was burnt: every coupon is as it was. */
  | { kind: 'refused'; why: string; record: CheckoutCodeRecord }
  /** Something moved and no code was issued. Locked parts come back at `x`. */
  | { kind: 'abandoned'; why: string; record: CheckoutCodeRecord }
  /** Part way; the next run carries on. Nothing is lost. */
  | { kind: 'pending'; why: string; record: CheckoutCodeRecord }

/** Plan a code, write it down (reserving each part's `R` first), then run it. */
export async function startCheckoutCode(req: StartCheckoutCode): Promise<CheckoutOutcome> {
  if (req.parts.length < 1 || req.parts.length > 20) throw new Error('A checkout code takes 1 to 20 coupons.')
  if (req.parts.reduce((n, p) => n + p.amount, 0) !== req.amount) throw new Error('The coupons do not add up to the amount.')
  const id = req.id ?? crypto.randomUUID()
  const indices = reserveCheckoutRefundIndices(req.pubkey, req.parts.length)
  const record: CheckoutCodeRecord = {
    id,
    stall: req.stall.toLowerCase(),
    shopKey: req.shop.redeemKey,
    shopUrl: req.shop.url,
    platform: req.shop.platform,
    unit: req.unit,
    decimals: req.decimals,
    amount: req.amount,
    x: req.x,
    createdAt: req.ports.now(),
    status: 'locking',
    parts: req.parts.map((p, n) => ({
      i: indices[n],
      amount: p.amount,
      sourceTokenId: p.tokenId,
      ...(p.amount === p.faceValue ? { token: p.token } : { split: true }),
      state: 'new' as const,
    })),
  }
  saveCheckoutCode(req.pubkey, record)
  return runCheckoutCode(req.ports, req.pubkey, id)
}

const find = (pubkey: string, id: string) => loadCheckoutCodes(pubkey).find((r) => r.id === id)

/**
 * One run per code at a time, across this tab and every other tab of the origin.
 *
 * The page making a code and the catch-up pass (`reconcileCheckoutCodes`, from dm-poll) both run a
 * `locking` record. Each holds its own copy of the record, so two at once lock every proof twice,
 * deposit twice, and the LAST save wins: on 2026-11-02 the store issued the code to one run and
 * refused the other `DUPLICATE_PART`, and the refused run's `abandoned` save overwrote the issued
 * one. The code worked at the shop while the wallet said "No code was made".
 *
 * So every step that reads a record, awaits, and writes it back runs under this, keyed by the code,
 * and re-reads the record once it holds it. In-tab calls queue on a promise chain (this also covers
 * a page without the Locks API); across tabs, a Web Lock. Not re-entrant: nothing called under it
 * takes it again.
 */
export function withCheckoutCodeLock<T>(pubkey: string, id: string, fn: () => Promise<T>): Promise<T> {
  return withQueuedLock(`imani-checkout-code:${pubkey}:${id}`, fn)
}

/** Run (or resume) one code. Never throws once the record exists. */
export function runCheckoutCode(ports: CheckoutPorts, pubkey: string, id: string): Promise<CheckoutOutcome> {
  return withCheckoutCodeLock(pubkey, id, () => runCheckoutCodeLocked(ports, pubkey, id))
}

async function runCheckoutCodeLocked(ports: CheckoutPorts, pubkey: string, id: string): Promise<CheckoutOutcome> {
  const record = find(pubkey, id)
  if (!record) throw new Error('No such checkout code.')
  const identity = ports.identitySecret()
  if (!identity) return { kind: 'pending', why: 'the wallet key is locked', record }
  try {
    if (record.status === 'locking') {
      const locked = await lockParts(ports, pubkey, record, identity)
      if (locked) return locked
    }
    if (record.status === 'depositing') return await deposit(ports, pubkey, record)
    return record.status === 'abandoned'
      ? { kind: 'abandoned', why: record.refusal ?? 'not issued', record }
      : { kind: 'issued', record }
  } catch (error) {
    return { kind: 'pending', why: error instanceof Error ? error.message : String(error), record }
  } finally {
    identity.fill(0)
  }
}

const save = (pubkey: string, record: CheckoutCodeRecord) => saveCheckoutCode(pubkey, record)

function armContext(
  ports: CheckoutPorts,
  pubkey: string,
  record: CheckoutCodeRecord,
  part: CheckoutPartRecord,
  R: Uint8Array,
  identity?: Uint8Array,
  onDelivered?: () => void,
) {
  return {
    // The locked token is "delivered" into the record: it is the store's to receive, at deposit.
    ports: {
      ...ports,
      deliver: async (_key: Uint8Array, token: string) => {
        part.lockedToken = token
        save(pubkey, record)
        return true
      },
    },
    ...(onDelivered ? { onDelivered } : {}),
    linkSecret: R,
    refundSecret: R,
    lockPub: record.shopKey,
    x: record.x,
    gifts: [{ token: part.token ?? '', sentAt: 0 }],
    merchant: false,
    onArming: async (keyset: string) => {
      part.state = 'arming'
      part.burnKeyset = keyset
      save(pubkey, record)
    },
    onLocked: async (secret: string, signed: string) => {
      part.locks = { ...(part.locks ?? {}), [secret]: signed }
      save(pubkey, record)
    },
    knownLocks: new Map(Object.entries(part.locks ?? {})),
    // #402: a part locked to the wallet's own key (a split voucher's part) is burnt and locked by it.
    ...(identity ? { selfSecret: identity } : {}),
    ...(part.state === 'arming' ? { resuming: true, ...(part.burnKeyset ? { burnKeyset: part.burnKeyset } : {}) } : {}),
  }
}

export interface CheckoutSourceCheck {
  ports: CheckoutPorts
  stall: string
  shop: OnlineShop
  unit: string
  x: number
  /** The whole voucher that would be split. */
  token: string
}

/** Why a voucher cannot be locked to the shop, or null when it can. */
export type CheckoutSourceRefusal = { why: string; detail?: string }

/**
 * #644: the lock check, on the voucher a split would carve, BEFORE the split. Read-only: the same
 * checks `lockParts` runs on each part (lockable, window, amount proof, unspent, a dry run of the
 * lock to `S`, the relay), against a throwaway refund key, so a refusal it can see changes nothing.
 * A part that passes here can still be refused after the split; `lockParts` checks again.
 */
export async function checkCheckoutSource(req: CheckoutSourceCheck): Promise<CheckoutSourceRefusal | null> {
  const record = { stall: req.stall.toLowerCase(), unit: req.unit } as CheckoutCodeRecord
  if (!sameStallAndUnit(req.token, record)) return { why: 'not_this_stall' }
  const identity = req.ports.identitySecret()
  const R = randomRefundSecret()
  try {
    const out = await armPreflight({
      ports: req.ports,
      linkSecret: R,
      refundSecret: R,
      lockPub: req.shop.redeemKey,
      x: req.x,
      gifts: [{ token: req.token, sentAt: 0 }],
      merchant: false,
      onArming: async () => {},
      onLocked: async () => {},
      ...(identity ? { selfSecret: identity } : {}),
    })
    if (!out) return null
    if (out.kind === 'unarmed') return { why: out.why, ...(out.detail ? { detail: out.detail } : {}) }
    return { why: out.kind }
  } finally {
    R.fill(0)
    identity?.fill(0)
  }
}

/** Null when every part is locked and the record moved on to `depositing`. */
async function lockParts(ports: CheckoutPorts, pubkey: string, record: CheckoutCodeRecord, identity: Uint8Array): Promise<CheckoutOutcome | null> {
  const R = (part: CheckoutPartRecord) => deriveCheckoutRefundSecret(identity, part.i)

  // 0. Before anything is burnt, every part: carved to its amount, then checked whole. Carving
  // writes the wallet's coupon rows, so one at a time; the checks are read-only, so side by side
  // (#477), and the first refusal in the parts' order decides, as before.
  // #477: parts this run's pre-check just found unspent: their arm need not ask the mint again.
  const checkedNow = new Set<CheckoutPartRecord>()
  if (record.parts.every((p) => p.state === 'new')) {
    for (const part of record.parts) {
      if (!part.token) {
        try {
          part.token = await ports.carve(part.sourceTokenId ?? '', part.amount)
        } catch (error) {
          return refuse(pubkey, record, `split: ${error instanceof Error ? error.message : String(error)}`)
        }
        save(pubkey, record)
      }
      if (!sameStallAndUnit(part.token, record)) return refuse(pubkey, record, 'not_this_stall')
    }
    const checks = await inParallel(
      record.parts.map((part) => () => armPreflight(armContext(ports, pubkey, record, part, R(part), identity))),
      PART_CONCURRENCY,
    )
    for (const c of checks) {
      const refusal: ArmOutcome | null = c.ok ? c.value : { kind: 'unarmed', why: 'unreachable' }
      if (refusal) return refuse(pubkey, record, refusal.kind === 'unarmed' ? refusal.why : refusal.kind, refusal.kind === 'unarmed' ? refusal.detail : undefined)
    }
    for (const part of record.parts) checkedNow.add(part)
  }

  // 1-4 for each part, as a Cashlink. #477: parts side by side. Every step of a part is derived
  // from its own R, and every write is to this one record object and saved whole and synchronously,
  // so two parts finishing together cannot lose each other's state. All parts are waited for
  // before the outcome is decided, so nothing is left running behind an answer.
  //
  // #477: the store needs only the locked tokens, not the relay's take-backs, so the deposit goes
  // as soon as EVERY part's locked token is in the record, beside the last refund deposits. From
  // that point no part can be refused (only `armed` / `not_armed` follow a delivery), so the code
  // would be issued either way; a part the relay does not take is taken back by this wallet at
  // `x`, as before. The body is the same one the sequential path sends, so it replays by key.
  let early: Promise<CheckoutOutcome> | undefined
  const allDelivered = () => record.parts.every((p) => !!p.lockedToken && p.state !== 'kept' && p.state !== 'settled' && p.state !== 'unarmed')
  const onDelivered = () => {
    if (early || !allDelivered()) return
    early = deposit(ports, pubkey, record).catch((error: unknown) => ({
      kind: 'pending' as const,
      why: error instanceof Error ? error.message : String(error),
      record,
    }))
  }
  const finish = async (out: CheckoutOutcome | null): Promise<CheckoutOutcome | null> => {
    if (!early) return out
    const deposited = await early
    if (out) return out
    // A deposit that did not answer leaves the record ready for the next run's deposit.
    if (deposited.kind === 'pending' && record.status === 'locking') {
      record.status = 'depositing'
      save(pubkey, record)
    }
    return deposited
  }
  const armOne = async (part: CheckoutPartRecord): Promise<{ part: CheckoutPartRecord; out: ArmOutcome } | null> => {
    if (part.state === 'locked' || part.state === 'kept' || part.state === 'unarmed' || part.state === 'settled') return null
    // Checked above, with every other part: recorded as arming BEFORE its burn, and armed as a
    // resume, so the pre-check is not run twice (and cannot read our own burn as a claim).
    if (part.state === 'new') {
      part.state = 'arming'
      save(pubkey, record)
    }
    const out: ArmOutcome = await armGift({
      ...armContext(ports, pubkey, record, part, R(part), identity, onDelivered),
      ...(checkedNow.has(part) ? { preChecked: true } : {}),
    })
    if (out.kind === 'armed' || out.kind === 'not_armed') {
      // Not armed: the relay did not take a take-back. Still locked, and this wallet posts the same
      // refund itself after `x`, as for a Cashlink. The code is still worth issuing.
      part.state = 'locked'
      part.armed = out.kind === 'armed'
      part.depositKeyset = out.keyset
      delete part.token
      save(pubkey, record)
      if (part.sourceTokenId && !part.split) await ports.consume(part.sourceTokenId)
    }
    return { part, out }
  }
  const order = record.parts.map((part) => () => armOne(part))
  // The first part alone: a refusal or a failure there still leaves every other coupon untouched.
  // #477: then the rest side by side.
  const head = await inParallel(order.slice(0, 1), 1)
  const headStopped = head[0] !== undefined && (!head[0].ok || (head[0].value !== null && !['armed', 'not_armed'].includes(head[0].value.out.kind)))
  const armed = headStopped ? head : [...head, ...(await inParallel(order.slice(1), PART_CONCURRENCY))]
  // A refusal is recorded on its part at once (state and reason), so no later run repeats it. A
  // part still part way (its burn may have happened) is resumed by the next run, so while one is,
  // the code is pending, not abandoned: abandoning would leave that part `arming` in a record no
  // run picks up again. Once none is, a refused part ends the attempt (all or nothing).
  let pending: string | undefined
  for (const a of armed) {
    if (!a.ok) {
      pending ??= a.error instanceof Error ? a.error.message : String(a.error)
      continue
    }
    if (!a.value) continue
    const { part, out } = a.value
    if (out.kind === 'armed' || out.kind === 'not_armed') continue
    if (out.kind === 'arming') {
      pending ??= out.why
      continue
    }
    // Refused after the burn (the value came back as sats, kept) or before it (the coupon is as it
    // was), or gone. Whatever is locked comes back at `x`.
    part.state = out.kind === 'kept_as_sats' ? 'kept' : out.kind === 'claimed' ? 'settled' : 'unarmed'
    record.refusal ??= out.kind === 'unarmed' ? out.why : out.kind
    if (out.kind === 'unarmed' && out.detail) record.refusalDetail ??= out.detail
    save(pubkey, record)
    if (part.state !== 'unarmed' && part.sourceTokenId && !part.split) await ports.consume(part.sourceTokenId)
  }
  if (pending !== undefined) return finish({ kind: 'pending', why: pending, record })
  if (record.parts.some((p) => p.state === 'kept' || p.state === 'settled' || p.state === 'unarmed')) {
    return finish(abandon(pubkey, record, record.refusal ?? 'not issued'))
  }
  if (early) return finish(null)
  record.status = 'depositing'
  save(pubkey, record)
  return null
}

/** Parts of one code armed at once (#477); each part runs its own proofs side by side too. */
const PART_CONCURRENCY = 3

function sameStallAndUnit(token: string, record: CheckoutCodeRecord): boolean {
  try {
    const v = parseVoucherToken(token).voucher
    return v.issuerId.toLowerCase() === record.stall && v.unit.toUpperCase() === record.unit.toUpperCase()
  } catch {
    return false
  }
}

function refuse(pubkey: string, record: CheckoutCodeRecord, why: string, detail?: string): CheckoutOutcome {
  record.status = 'abandoned'
  record.refusal = why
  if (detail) record.refusalDetail = detail
  record.done = true
  for (const p of record.parts) {
    p.state = 'unarmed'
    delete p.token
  }
  save(pubkey, record)
  return { kind: 'refused', why, record }
}

function abandon(pubkey: string, record: CheckoutCodeRecord, why: string): CheckoutOutcome {
  record.status = 'abandoned'
  record.refusal = why
  for (const p of record.parts) if (p.state === 'new') p.state = 'unarmed'
  record.done = isFinished(record)
  save(pubkey, record)
  return { kind: 'abandoned', why, record }
}

/** Every part's value is spent, kept, or never moved. */
const isFinished = (record: CheckoutCodeRecord) => record.parts.every((p) => p.state !== 'locked' && p.state !== 'arming' && p.state !== 'new')

/** The part's amount, as the store checks it: the credited face value of its proofs. */
function partAmount(token: string): number {
  return creditableFaceValue(parseVoucherToken(token)).faceValue
}

async function deposit(ports: CheckoutPorts, pubkey: string, record: CheckoutCodeRecord): Promise<CheckoutOutcome> {
  const parts = record.parts.map((p) => ({ token: p.lockedToken ?? '', amount: p.lockedToken ? partAmount(p.lockedToken) : 0 }))
  const amount = parts.reduce((n, p) => n + p.amount, 0)
  const body = {
    idempotency_key: record.id,
    stall_pubkey: record.stall,
    shop_key: record.shopKey,
    unit: record.unit.toLowerCase(),
    amount,
    expires_at: record.x,
    parts,
    // #405: the shop creates the code on its own platform first (a Shopify gift card).
    ...(record.platform === 'shopify' ? { provision: true } : {}),
  }
  let answer: GatewayAnswer
  try {
    answer = await ports.store.call('POST', CHECKOUT_CODES_PATH, body)
  } catch {
    return { kind: 'pending', why: 'the code store is unreachable', record }
  }
  const code = typeof answer.body?.code === 'string' ? normalise(answer.body.code) : null
  if ((answer.status === 201 || answer.status === 200) && code?.ok) {
    record.status = 'reserved'
    record.code = code.canonical
    record.codeHash = codeHashOf(code.canonical)
    record.amount = amount
    record.remaining = amount
    record.redemptions = []
    // #405: hidden until the shop says its gift card exists (`shop_ready` on `/mine`).
    if (record.platform === 'shopify') record.shopReady = answer.body?.shop_ready === true
    save(pubkey, record)
    return { kind: 'issued', record }
  }
  if (answer.status === 409 || answer.status === 429 || answer.status >= 500 || answer.status === 0) {
    return { kind: 'pending', why: `the code store said ${refusalName(answer)}`, record }
  }
  // These very proofs already back a code. They are locked to `S` with refunds to OUR `R`, derived
  // from this record, so that code is this deposit's own (another run of it got there first, or an
  // answer was lost). Never "no code": the same body again replays the code by its idempotency key,
  // here or on the next pass.
  if (refusalName(answer) === 'DUPLICATE_PART') {
    return { kind: 'pending', why: 'the code store already holds these parts', record }
  }
  // A definite refusal: no code. Every part is locked and comes back at `x`.
  return abandon(pubkey, record, refusalName(answer))
}

const refusalName = (a: GatewayAnswer) => (typeof a.body?.refusal === 'string' ? a.body.refusal : `HTTP_${a.status}`)

export const codeHashOf = (canonical: string): string => bytesToHex(sha256(new TextEncoder().encode(canonical)))

// --- Cancelling -------------------------------------------------------------

/**
 * Ask the store to cancel a `reserved` code. True once it is `cancelling` (or already further on).
 *
 * @deprecated #472: a code is a bearer instrument and the store answers `NOT_CANCELLABLE`. Not
 * offered in the app any more; kept for the staging e2e against stores from before #472. Codes
 * already `cancelling` still finish through the `cancelled` notice.
 */
export async function cancelCheckoutCode(ports: CheckoutPorts, pubkey: string, id: string): Promise<{ ok: boolean; why?: string }> {
  const record = find(pubkey, id)
  if (!record?.code) return { ok: false, why: 'no code' }
  let answer: GatewayAnswer
  try {
    answer = await ports.store.call('POST', `${CHECKOUT_CODES_PATH}/${record.code}/cancel`, {})
  } catch {
    return { ok: false, why: 'unreachable' }
  }
  if (answer.status === 200 || answer.status === 202) {
    record.status = 'cancelling'
    save(pubkey, record)
    return { ok: true }
  }
  return { ok: false, why: refusalName(answer) }
}

// --- Getting the value back -------------------------------------------------

/** Every refund key this wallet has used for checkout parts, by x-only public key. */
function refundKeys(pubkey: string, identity: Uint8Array): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>()
  for (const r of loadCheckoutCodes(pubkey)) {
    for (const p of r.parts) {
      const R = deriveCheckoutRefundSecret(identity, p.i)
      keys.set(xOnlyPub(R), R)
    }
  }
  return keys
}

/** `P2PK_VOUCHER(data = 02‖K)` with no locktime and no refund: a coupon returned to `K`. */
function returnedTo(secret: string): string | null {
  try {
    const [kind, body] = JSON.parse(secret) as [string, { data?: string; tags?: string[][] }]
    if (kind !== 'P2PK_VOUCHER' || !/^0[23][0-9a-f]{64}$/i.test(body.data ?? '')) return null
    if ((body.tags ?? []).some((t) => t[0] === 'locktime' || t[0] === 'refund')) return null
    return body.data!.slice(2).toLowerCase()
  } catch {
    return null
  }
}

/** A NUT-11 SIG_INPUTS witness: BIP-340 by `key` over the secret. */
function inputWitness(key: Uint8Array, secret: string): string {
  return JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), key))] })
}

export type UnlockOutcome = { kind: 'kept'; count: number; face: number } | { kind: 'pending'; why: string } | { kind: 'not_ours' }

/**
 * Turn coupons returned locked to one of our `R` back into ordinary coupons (contract §5): burn each
 * proof with `R` into derived outputs, have gateway-customer re-sign it unlocked, mint it, keep it.
 * Derived throughout, so a page that dies resumes. A definite refusal after the burn keeps the sats.
 */
export async function unlockReturned(ports: CheckoutPorts, pubkey: string, tokens: string[]): Promise<UnlockOutcome> {
  const identity = ports.identitySecret()
  if (!identity) return { kind: 'pending', why: 'the wallet key is locked' }
  try {
    const keys = refundKeys(pubkey, identity)
    let count = 0
    let ours = 0
    let face = 0
    for (const token of tokens) {
      const mintUrl = mintOf(token)
      for (const proof of tokenProofs(token)) {
        const K = returnedTo(proof.secret)
        const R = K ? keys.get(K) : undefined
        if (!R) continue
        ours += 1
        const done = await unlockOne(ports, mintUrl, proof, R)
        if (done === 'pending') return { kind: 'pending', why: 'part way' }
        if (done === 'kept') count += 1
        // What came back, whether kept now or by an earlier run that died before it was recorded.
        face += partFace(mintUrl, proof)
      }
    }
    return ours === 0 ? { kind: 'not_ours' } : { kind: 'kept', count, face }
  } catch (error) {
    return { kind: 'pending', why: error instanceof Error ? error.message : String(error) }
  } finally {
    identity.fill(0)
  }
}

/** One returned proof's credited face, minor units (0 when unreadable). */
function partFace(mintUrl: string, proof: TokenProof): number {
  try {
    return creditableFaceValue(parseVoucherToken(tokenOf(mintUrl, [proof as never]))).faceValue
  } catch {
    return 0
  }
}

async function unlockOne(ports: CheckoutPorts, mintUrl: string, proof: TokenProof, R: Uint8Array): Promise<'kept' | 'gone' | 'pending'> {
  const keyset = await ports.mint.activeKeysetId(mintUrl)
  let outs = derivedOutputs(R, 'unlock-burn', proof.secret, proof.amount, proof.id)
  const [state] = await ports.mint.states(mintUrl, [proof.secret])
  let plain
  if (state === 'UNSPENT') {
    outs = derivedOutputs(R, 'unlock-burn', proof.secret, proof.amount, keyset)
    const done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness: inputWitness(R, proof.secret) }], outs)
    if (done.kind === 'gone') return 'gone'
    if (done.kind === 'refused') return 'pending'
    plain = done.proofs
  } else if (state === 'SPENT') {
    plain = await restoreMine(ports.mint, mintUrl, outs)
    if (plain.length === 0) plain = await restoreMine(ports.mint, mintUrl, (outs = derivedOutputs(R, 'unlock-burn', proof.secret, proof.amount, keyset)))
    if (plain.length === 0) return 'gone'
    outs = outs.map((o, n) => ({ ...o, id: plain![n].id }))
    // Spent plain outputs: an earlier run already minted the coupon and kept it.
    const [plainState] = await ports.mint.states(mintUrl, [plain[0].secret])
    if (plainState === 'SPENT') return 'gone'
  } else {
    return 'pending'
  }
  const proposed = unlockedProposal(proof.secret, derivedNonce(R, 'unlock', proof.secret))
  const answer = await signRoute(ports, UNLOCK_PATH, {
    predecessor_secret: proof.secret,
    proposed_secret: proposed,
    authorization: cashlinkAuthorization(R, CHECKOUT_UNLOCK_TAG, proof.secret, proposed),
    predecessor_proof: proofBody(proof),
    burn_outputs: burnOutputsBody(outs),
  })
  const signed = answer.body?.signed_secret
  const locked = voucherOfProof(proof)!
  if (answer.status === 200 && typeof signed === 'string' && isTheSuccessorAskedFor(signed, locked)) {
    const coupon = await mintCarrier(ports, mintUrl, plain, signed, R, 'mint-unlock', proof)
    if (!coupon) return 'pending'
    await ports.keep({ token: tokenOf(mintUrl, [coupon]), why: 'returned' })
    return 'kept'
  }
  if (notYet(answer.status) || answer.status === 404) return 'pending'
  await cashlinkSteps.keepAsSats(ports, mintUrl, proof, plain, 'returned')
  return 'kept'
}

/**
 * The locked parts of a code whose `x` has passed (expired, or never issued): each comes back by the
 * Cashlink refund path, with only `R`. A part the shop spent reads as claimed: settled too.
 */
export async function settleLockedParts(
  ports: CheckoutPorts,
  pubkey: string,
  id: string,
  /**
   * #472: parts whose old token must NOT be read as "spent by the shop, so finished": the store lists
   * a successor for them (or could not be asked). Their value may be on a successor locked to `S`.
   * `'all'` when `/parts` could not be read for a code that has one.
   */
  suspect: ReadonlySet<number> | 'all' = new Set(),
): Promise<CheckoutCodeRecord | undefined> {
  const record = find(pubkey, id)
  if (!record) return undefined
  const identity = ports.identitySecret()
  if (!identity) return record
  try {
    for (const [idx, part] of record.parts.entries()) {
      if (part.state !== 'locked' || !part.lockedToken) continue
      const out = await settleLockedGift({
        ports,
        refundSecret: deriveCheckoutRefundSecret(identity, part.i),
        noRelay: part.armed === false,
        lockedToken: part.lockedToken,
        ...(part.depositKeyset ? { depositKeyset: part.depositKeyset } : {}),
        // #643: each coupon back gets its own incoming History row, linked to the code's row.
        returnOf: checkoutTxId(record.id),
        returnMemo: CHECKOUT_CODE_RETURNED_MEMO,
        onReturning: async () => {},
      })
      const doubted = suspect === 'all' || suspect.has(idx)
      if (out.kind === 'returned' || (out.kind === 'claimed' && !doubted)) {
        part.state = 'settled'
        save(pubkey, record)
      }
    }
    if (isFinished(record)) {
      record.done = true
      save(pubkey, record)
    }
    return record
  } finally {
    identity.fill(0)
  }
}

/** #643: the memo on a coupon's own row when it comes back off a checkout code. */
export const CHECKOUT_CODE_RETURNED_MEMO = 'Checkout code expired, returned'

// --- Notifications ----------------------------------------------------------

export interface CheckoutNotice {
  type: typeof CHECKOUT_NOTICE_TYPE
  event: 'redeemed' | 'expired' | 'cancelled' | 'change' | 'rebalanced'
  code_hash: string
  amount?: number
  /** #472: what is left on the code (`rebalanced`, and `redeemed` ending a balance code with 0). */
  remaining?: number
  unit?: string
  tokens?: string[]
}

export function parseCheckoutNotice(content: string): CheckoutNotice | null {
  try {
    const v = JSON.parse(content) as Partial<CheckoutNotice>
    if (v?.type !== CHECKOUT_NOTICE_TYPE) return null
    if (!['redeemed', 'expired', 'cancelled', 'change', 'rebalanced'].includes(String(v.event))) return null
    if (typeof v.code_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(v.code_hash)) return null
    if (v.tokens !== undefined && !(Array.isArray(v.tokens) && v.tokens.every((t) => typeof t === 'string'))) return null
    if (v.amount !== undefined && !Number.isSafeInteger(v.amount)) return null
    if (v.remaining !== undefined && !(Number.isSafeInteger(v.remaining) && v.remaining >= 0)) return null
    if (v.event === 'rebalanced' && v.remaining === undefined) return null
    return v as CheckoutNotice
  } catch {
    return null
  }
}

/** The store's own key, from `GET /v1/checkout-codes/info`. Null when it cannot be read. */
export async function storePubkey(ports: CheckoutPorts): Promise<string | null> {
  try {
    const answer = await ports.store.call('GET', `${CHECKOUT_CODES_PATH}/info`)
    // Contract §6: `{"nostr_pubkey": "…"}`, as imani-checkout-codes `InfoController` answers.
    const key = answer.body?.nostr_pubkey
    return answer.status === 200 && typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key) ? key.toLowerCase() : null
  } catch {
    return null
  }
}

export type NoticeOutcome = 'handled' | 'ignored' | 'retry'

const money = (record: CheckoutCodeRecord, minor: number): string => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: record.unit, minimumFractionDigits: record.decimals }).format(minor / 10 ** record.decimals)
  } catch {
    return `${(minor / 10 ** record.decimals).toFixed(record.decimals)} ${record.unit}`
  }
}

const shopName = (record: CheckoutCodeRecord): string => {
  try {
    return new URL(record.shopUrl).hostname
  } catch {
    return 'the shop'
  }
}

/**
 * One notice from the store. `sealer` is the verified seal author: anything not sealed by the
 * store's own key is ignored. 'retry' leaves the DM unprocessed (the value is not in yet).
 */
export async function handleCheckoutNotice(ports: CheckoutPorts, pubkey: string, notice: CheckoutNotice, sealer: string | undefined): Promise<NoticeOutcome> {
  const store = await storePubkey(ports)
  if (!store) return 'retry'
  if (!sealer || sealer.toLowerCase() !== store) return 'ignored'
  const found = loadCheckoutCodes(pubkey).find((r) => r.codeHash === notice.code_hash.toLowerCase())
  if (!found) return 'ignored'
  // Read again under the code's lock: a run or another notice may have moved it meanwhile.
  return withCheckoutCodeLock(pubkey, found.id, async () => {
    const record = find(pubkey, found.id)
    return record ? handleNoticeLocked(ports, pubkey, notice, record) : 'ignored'
  })
}

async function handleNoticeLocked(ports: CheckoutPorts, pubkey: string, notice: CheckoutNotice, record: CheckoutCodeRecord): Promise<NoticeOutcome> {
  if (notice.event === 'rebalanced') return syncBalance(ports, pubkey, record.id)

  if (notice.event === 'redeemed' && isBalanceEnd(record, notice)) {
    // #472: the last order of a balance code used what was left. `amount` is that order's.
    if (record.status !== 'redeemed') {
      const before = remainingOf(record)
      const spent = Math.min(notice.amount ?? before, before)
      record.status = 'redeemed'
      record.spent = spent
      record.remaining = 0
      record.redemptions = [...(record.redemptions ?? []), { at: ports.now(), amount: spent, remaining: 0 }]
      for (const p of record.parts) if (p.state === 'locked') p.state = 'settled'
      record.done = true
      save(pubkey, record)
      await activity(ports, record, 'redeemed', spent, `${money(record, spent)} used at ${shopName(record)}: nothing left on the code`)
    }
    return 'handled'
  }

  if (notice.event === 'redeemed') {
    const spent = Math.min(notice.amount ?? record.amount, record.amount)
    if (record.status !== 'redeemed') {
      record.status = 'redeemed'
      record.spent = spent
      record.remaining = 0
      for (const p of record.parts) if (p.state === 'locked') p.state = 'settled'
      record.done = true
      save(pubkey, record)
      await activity(ports, record, `redeemed`, spent, `${money(record, record.amount)} code used at ${shopName(record)}: ${money(record, spent)} spent, ${money(record, record.amount - spent)} back`)
    }
    return 'handled'
  }
  if (notice.event === 'change' || notice.event === 'cancelled') {
    const out = await unlockReturned(ports, pubkey, notice.tokens ?? [])
    if (out.kind === 'pending') return 'retry'
    if (notice.event === 'change' && out.kind === 'kept' && out.face > 0) {
      // The shop gave back what the order did not use. The coupons are already in the wallet; this
      // is the history row for them (it was missing, 2026-11-01). Recorded once per code: a second
      // delivery of the notice finds `change` already set and writes nothing.
      if (record.change === undefined) {
        record.change = out.face
        // The store's `redeemed` notice carries the code's amount, not what the order took; the
        // change says the rest. The code's own row then shows what the shop really spent.
        if (record.status === 'redeemed') record.spent = Math.max(0, finalOrderBefore(record) - out.face)
        // #472: a balance code's last order (below the dust threshold) gave change: it took less.
        const last = record.redemptions?.at(-1)
        if (record.status === 'redeemed' && last && last.remaining === 0) last.amount = record.spent ?? last.amount
        save(pubkey, record)
        await changeActivity(ports, record, out.face)
        if (record.status === 'redeemed' && record.spent !== undefined) {
          await activity(ports, record, 'redeemed', record.spent, `${money(record, finalOrderBefore(record))} code used at ${shopName(record)}: ${money(record, record.spent)} spent, ${money(record, out.face)} back`)
        }
      }
    }
    if (notice.event === 'cancelled') {
      record.status = 'cancelled'
      for (const p of record.parts) if (p.state === 'locked') p.state = 'settled'
      record.done = true
      save(pubkey, record)
      await activity(ports, record, 'cancelled', record.amount, `${money(record, record.amount)} code cancelled: back in your wallet`)
    }
    return 'handled'
  }
  // expired. #472: adopt any balance successor first, so the refund is of what is on the code now.
  const suspect = await syncBeforeSettle(ports, pubkey, record.id)
  const current = find(pubkey, record.id) ?? record
  if (current.status !== 'expired' && !current.done) {
    current.status = 'expired'
    save(pubkey, current)
  }
  const after = await settleLockedParts(ports, pubkey, record.id, suspect)
  if (!after?.done) return 'retry'
  const left = remainingOf(after)
  await activity(
    ports,
    after,
    'expired',
    left,
    left === after.amount ? `${money(after, left)} code expired unused: back in your wallet` : `${money(after, left)} left on the code expired: back in your wallet`,
  )
  return 'handled'
}

/** The change a shop gave back: its own incoming history row (`checkout:<id>:change`). */
async function changeActivity(ports: CheckoutPorts, record: CheckoutCodeRecord, face: number): Promise<void> {
  try {
    await (ports.changeActivity ?? ports.activity)({
      id: `checkout:${record.id}:change`,
      at: ports.now(),
      stall: record.stall,
      unit: record.unit,
      decimals: record.decimals,
      amount: face,
      memo: `Change from ${shopName(record)}: ${money(record, face)} back in your wallet`,
    })
  } catch {
    // History is display; the coupons are in the wallet either way.
  }
}

async function activity(ports: CheckoutPorts, record: CheckoutCodeRecord, what: string, amount: number, memo: string): Promise<void> {
  try {
    await ports.activity({ id: `checkout:${record.id}:${what}`, at: ports.now(), stall: record.stall, unit: record.unit, decimals: record.decimals, amount, memo })
  } catch {
    // History is display; the money is settled either way.
  }
}

// --- The fallback: one pass over every outstanding code ---------------------

const STORE_STATUSES: ReadonlySet<CheckoutCodeStatus> = new Set(['reserved', 'held', 'settling', 'cancelling', 'redeemed', 'cancelled', 'expired'])

/**
 * Resume codes part way, read `GET /mine` for lost notices, and bring back parts whose `x` has
 * passed. Never throws. Returns how many records changed.
 */
export async function reconcileCheckoutCodes(ports: CheckoutPorts, pubkey: string): Promise<number> {
  let changed = 0
  let records: CheckoutCodeRecord[]
  try {
    records = loadCheckoutCodes(pubkey).filter((r) => !r.done)
  } catch {
    return 0
  }
  if (records.length === 0) return 0
  const nowS = Math.floor(ports.now() / 1000)

  // A deposit the store took while this record was saved as refused (`isUnclaimedDeposit`): the same
  // body again, which the store answers with the code it issued for this key.
  for (const r of records.filter((r) => r.status === 'abandoned' && isUnclaimedDeposit(r))) {
    await withCheckoutCodeLock(pubkey, r.id, async () => {
      const now = find(pubkey, r.id)
      if (!now || now.status !== 'abandoned' || !isUnclaimedDeposit(now)) return
      now.status = 'depositing'
      delete now.refusal
      save(pubkey, now)
    })
    r.status = 'depositing'
  }

  for (const r of records.filter((r) => r.status === 'locking' || r.status === 'depositing')) {
    if ((await runCheckoutCode(ports, pubkey, r.id)).kind !== 'pending') changed += 1
  }

  let mine: Array<{ code?: string; status?: string; remaining?: number; shop_ready?: boolean }> = []
  try {
    const answer = await ports.store.call('GET', `${CHECKOUT_CODES_PATH}/mine`)
    if (answer.status === 200 && Array.isArray(answer.body)) mine = answer.body as typeof mine
    else if (answer.status === 200 && Array.isArray(answer.body?.codes)) mine = answer.body.codes as typeof mine
  } catch {
    // Unreachable: the clock still brings expired parts back below.
  }
  changed += await adoptIssuedElsewhere(pubkey, mine)
  for (const entry of mine) {
    const code = typeof entry.code === 'string' ? normalise(entry.code) : null
    if (!code?.ok || !STORE_STATUSES.has(entry.status as CheckoutCodeStatus)) continue
    const found = loadCheckoutCodes(pubkey).find((r) => r.code === code.canonical && !r.done)
    if (!found) continue
    changed += await withCheckoutCodeLock(pubkey, found.id, async () => {
      const record = find(pubkey, found.id)
      if (!record || record.done) return 0
      // #405: the shop made its gift card. Saved even when nothing else moved.
      let ready = 0
      if (entry.shop_ready === true && record.shopReady === false) {
        record.shopReady = true
        save(pubkey, record)
        ready = 1
      }
      // #472: a lost `rebalanced` (or a balance code's last order): less is left than we know of.
      const lost =
        typeof entry.remaining === 'number' &&
        Number.isSafeInteger(entry.remaining) &&
        entry.remaining < remainingOf(record) &&
        (entry.status === 'reserved' || entry.status === 'held' || (entry.status === 'redeemed' && (record.redemptions?.length ?? 0) > 0))
      if (lost) return (await syncBalance(ports, pubkey, record.id)) === 'handled' ? 1 : ready
      if (record.status === entry.status) return ready
      // `settling` is the store waiting on the shop's `/rebalance`: nothing to do here yet.
      if (entry.status === 'settling') return ready
      record.status = entry.status as CheckoutCodeStatus
      if (record.status === 'redeemed') {
        for (const p of record.parts) if (p.state === 'locked') p.state = 'settled'
        record.done = true
        await activity(ports, record, 'redeemed', record.amount, `${money(record, record.amount)} code used at ${shopName(record)}`)
      }
      // `cancelled` is finished only once its tokens are in (they come by DM): left outstanding.
      save(pubkey, record)
      return 1
    })
  }

  for (const r of loadCheckoutCodes(pubkey).filter((r) => !r.done && nowS < r.x && r.parts.some(needsRearm))) {
    if (await withCheckoutCodeLock(pubkey, r.id, () => rearmSuccessors(ports, pubkey, r.id))) changed += 1
  }

  for (const r of loadCheckoutCodes(pubkey).filter((r) => !r.done && nowS >= r.x)) {
    const settled = await withCheckoutCodeLock(pubkey, r.id, async () => {
      const suspect = await syncBeforeSettle(ports, pubkey, r.id).catch(() => 'all' as const)
      const after = await settleLockedParts(ports, pubkey, r.id, suspect).catch(() => undefined)
      if (!after?.done) return false
      if (after.status !== 'abandoned') {
        after.status = 'expired'
        save(pubkey, after)
      }
      return true
    }).catch(() => false)
    if (settled) changed += 1
  }
  return changed
}

/**
 * A deposit the store took whose answer this record never kept (2026-11-02): another run of the same
 * record was issued the code, and this run's save of the store's `DUPLICATE_PART` refusal overwrote
 * it, so the wallet said "No code was made" for a code the shop then used twice. Also a deposit
 * whose answer was lost and whose retry the store refuses (a second run's tokens carry other DLEQ
 * proofs, so the same key with a different body is `IDEMPOTENCY_KEY_REUSED`). Every part is locked,
 * so the parts are on the store.
 */
export const isUnclaimedDeposit = (r: CheckoutCodeRecord): boolean =>
  !r.code &&
  !r.done &&
  (r.status === 'depositing' || (r.status === 'abandoned' && r.refusal === 'DUPLICATE_PART')) &&
  r.parts.length > 0 &&
  r.parts.every((p) => p.state === 'locked' && !!p.lockedToken)

/**
 * Give an unclaimed deposit its code back, from the store's `/mine`. The store keys a deposit by
 * customer and idempotency key (this record's id) and lets a locked proof back one code only, so:
 *
 * - when `/mine` names the key (imani-checkout-codes from 0.2.1), the code with this record's key
 *   is this record's;
 * - before that, the code with this record's exact terms: the same locktime `x` to the second, the
 *   same amount, shop key and stall, that no other record of this wallet holds. Two codes of one
 *   wallet with all of those equal would need two made in the same second for the same shop and
 *   amount; a record that matches more than one is left alone.
 *
 * The parts are kept as recorded; the code is then followed like any other, by `/mine` and its
 * notices, whatever it has been through since. Returns how many records changed.
 */
async function adoptIssuedElsewhere(
  pubkey: string,
  mine: Array<{ code?: string; idempotency_key?: unknown; amount?: unknown; expires_at?: unknown; shop_key?: unknown; stall_pubkey?: unknown }>,
): Promise<number> {
  if (!loadCheckoutCodes(pubkey).some(isUnclaimedDeposit)) return 0
  const held = new Set(loadCheckoutCodes(pubkey).map((r) => r.code).filter(Boolean))
  const free = mine.flatMap((e) => {
    const code = typeof e.code === 'string' ? normalise(e.code) : null
    return code?.ok && !held.has(code.canonical) ? [{ ...e, canonical: code.canonical }] : []
  })
  const lockedAmount = (r: CheckoutCodeRecord) => r.parts.reduce((n, p) => n + (p.lockedToken ? partAmount(p.lockedToken) : 0), 0)
  const sameTerms = (r: CheckoutCodeRecord, e: (typeof free)[number]) =>
    e.expires_at === r.x &&
    e.amount === lockedAmount(r) &&
    typeof e.shop_key === 'string' &&
    e.shop_key.toLowerCase() === r.shopKey.toLowerCase() &&
    typeof e.stall_pubkey === 'string' &&
    e.stall_pubkey.toLowerCase() === r.stall
  let changed = 0
  for (const waiting of loadCheckoutCodes(pubkey).filter(isUnclaimedDeposit)) {
    const byKey = free.filter((e) => e.idempotency_key === waiting.id)
    const candidates = byKey.length > 0 ? byKey : free.filter((e) => e.idempotency_key === undefined && sameTerms(waiting, e))
    if (candidates.length !== 1) continue
    const chosen = candidates[0]
    changed += await withCheckoutCodeLock(pubkey, waiting.id, async () => {
      const record = find(pubkey, waiting.id)
      if (!record || !isUnclaimedDeposit(record) || loadCheckoutCodes(pubkey).some((r) => r.code === chosen.canonical)) return 0
      issue(pubkey, record, chosen.canonical)
      free.splice(free.indexOf(chosen), 1)
      return 1
    })
  }
  return changed
}

/** The store issued `canonical` for this record's parts. */
function issue(pubkey: string, record: CheckoutCodeRecord, canonical: string): void {
  const amount = record.parts.reduce((n, p) => n + (p.lockedToken ? partAmount(p.lockedToken) : 0), 0)
  record.status = 'reserved'
  delete record.refusal
  record.code = canonical
  record.codeHash = codeHashOf(canonical)
  record.amount = amount
  record.remaining = amount
  record.redemptions = []
  save(pubkey, record)
}

// --- A balance kept on the code (#472) ---------------------------------------

/** What was on the code when its last order began: the amount, or what earlier orders left. */
function finalOrderBefore(record: CheckoutCodeRecord): number {
  const r = record.redemptions ?? []
  const lastIsFinal = r.at(-1)?.remaining === 0
  const prior = lastIsFinal ? r.at(-2) : r.at(-1)
  return prior ? prior.remaining : record.amount
}

/** A `redeemed` that ends a code which had kept a balance: `remaining: 0` after earlier orders. */
function isBalanceEnd(record: CheckoutCodeRecord, notice: CheckoutNotice): boolean {
  return notice.remaining === 0 && ((record.redemptions?.length ?? 0) > 0 || remainingOf(record) < record.amount)
}

/** Why a balance successor offered for `part` is not adopted, or null when it is good. */
export function successorProblem(record: CheckoutCodeRecord, part: CheckoutPartRecord, R: Uint8Array, token: string, amount: unknown): string | null {
  const checked = checkLockedGift(token, 'lock', record.shopKey)
  if (!checked.ok) return checked.why
  if (checked.x !== record.x) return 'wrong_locktime'
  if (checked.refundPub.toLowerCase() !== xOnlyPub(R).toLowerCase()) return 'wrong_refund_key'
  let fresh, old
  try {
    fresh = parseVoucherToken(token)
    old = parseVoucherToken(part.lockedToken ?? '')
  } catch {
    return 'unreadable'
  }
  const ids = new Set(tokenProofs(token).map((p) => voucherOfProof(p)?.voucherId))
  if (ids.size !== 1 || !ids.has(old.voucher.voucherId)) return 'wrong_voucher'
  if (fresh.voucher.issuerPublicKey.toLowerCase() !== old.voucher.issuerPublicKey.toLowerCase()) return 'wrong_signer'
  if (fresh.voucher.issuerId.toLowerCase() !== record.stall || fresh.voucher.unit.toUpperCase() !== record.unit.toUpperCase()) return 'wrong_stall'
  const face = creditableFaceValue(fresh).faceValue
  if (face !== amount || face <= 0 || face >= part.amount) return 'wrong_amount'
  return null
}

const needsRearm = (p: CheckoutPartRecord) => p.state === 'locked' && p.armed === false && (p.replacedTokens?.length ?? 0) > 0 && !!p.lockedToken

/** Arm the relay for a successor whose re-arm failed earlier. True when one became armed. */
async function rearmSuccessors(ports: CheckoutPorts, pubkey: string, id: string): Promise<boolean> {
  const record = find(pubkey, id)
  const identity = ports.identitySecret()
  if (!record || !identity) return false
  let any = false
  try {
    for (const part of record.parts.filter(needsRearm)) {
      const R = deriveCheckoutRefundSecret(identity, part.i)
      const out = await retryDeposit(ports, R, R, part.lockedToken!)
      if (out.kind === 'armed') {
        part.armed = true
        part.depositKeyset = out.keyset
        any = true
        save(pubkey, record)
      }
    }
    return any
  } finally {
    identity.fill(0)
  }
}

/**
 * Bring a code's parts in line with the store's `GET /{code}/parts` after an order kept a balance
 * on it (a `rebalanced` notice, or `/mine` saying less is left). Never trusts the store alone:
 *
 * - a part the store no longer lists is settled only once the mint says every proof is SPENT;
 * - a part listed with a new token is adopted only when that token is the balance successor of
 *   THIS part (locked to `S` until `x`, refund to this part's `R`, the same voucher, gateway-signed,
 *   less than before, worth what the store says), and its refunds are re-armed at the relay.
 *
 * Anything wrong leaves that part as it was and answers 'retry'. Idempotent.
 */
export async function syncBalance(ports: CheckoutPorts, pubkey: string, id: string): Promise<NoticeOutcome> {
  return (await syncParts(ports, pubkey, id)).outcome
}

/**
 * #472, before any part of a code is refunded at `x`: adopt the successors the store lists (a lost
 * `rebalanced`), then say which parts' old tokens must not be read as finished. Never changes the
 * code's status unless nothing is left. `'all'` when `/parts` could not be read: a spent old token
 * may then be a successor we do not know about, so it waits rather than being called finished.
 * A record with no code (abandoned) has nothing on the store: nothing is suspect.
 */
export async function syncBeforeSettle(ports: CheckoutPorts, pubkey: string, id: string): Promise<ReadonlySet<number> | 'all'> {
  const record = find(pubkey, id)
  if (!record?.code || record.done) return new Set()
  const out = await syncParts(ports, pubkey, id, true)
  return out.reachable ? out.replaced : 'all'
}

async function syncParts(
  ports: CheckoutPorts,
  pubkey: string,
  id: string,
  keepStatus = false,
): Promise<{ outcome: NoticeOutcome; reachable: boolean; replaced: Set<number> }> {
  const replaced = new Set<number>()
  const record = find(pubkey, id)
  if (!record?.code) return { outcome: 'ignored', reachable: false, replaced }
  if (record.done) return { outcome: 'handled', reachable: true, replaced }
  let answer: GatewayAnswer
  try {
    answer = await ports.store.call('GET', `${CHECKOUT_CODES_PATH}/${record.code}/parts`)
  } catch {
    return { outcome: 'retry', reachable: false, replaced }
  }
  const listed = answer.body?.parts
  if (answer.status !== 200 || !Array.isArray(listed)) return { outcome: 'retry', reachable: false, replaced }
  const byIdx = new Map<number, { token?: unknown; amount?: unknown }>()
  for (const e of listed as Array<{ idx?: unknown; token?: unknown; amount?: unknown }>) {
    if (Number.isSafeInteger(e?.idx)) byIdx.set(e.idx as number, e)
  }
  const identity = ports.identitySecret()
  if (!identity) return { outcome: 'retry', reachable: false, replaced }
  const before = remainingOf(record)
  // What orders took, found in this pass: spent parts whole, replaced parts their difference.
  let usedNow = 0
  let unsure = false
  try {
    for (const [idx, part] of record.parts.entries()) {
      if (part.state !== 'locked' || !part.lockedToken) continue
      const entry = byIdx.get(idx)
      if (!entry) {
        // Gone from the code: the shop spent it. Only the mint may say so.
        let states
        try {
          states = await ports.mint.states(mintOf(part.lockedToken), tokenProofs(part.lockedToken).map((p) => p.secret))
        } catch {
          states = ['UNKNOWN']
        }
        if (states.length > 0 && states.every((st) => st === 'SPENT')) {
          usedNow += part.amount
          part.state = 'settled'
          save(pubkey, record)
        } else unsure = true
        continue
      }
      if (entry.token === part.lockedToken) continue
      // Listed with another token: whatever happens below, the old one is not this part's end.
      replaced.add(idx)
      if (typeof entry.token !== 'string') {
        unsure = true
        continue
      }
      const R = deriveCheckoutRefundSecret(identity, part.i)
      if (successorProblem(record, part, R, entry.token, entry.amount)) {
        unsure = true
        continue
      }
      // The old token is spent (the shop burnt it to make this one) before we let it go.
      let oldStates
      try {
        oldStates = await ports.mint.states(mintOf(part.lockedToken), tokenProofs(part.lockedToken).map((p) => p.secret))
      } catch {
        oldStates = ['UNKNOWN']
      }
      if (!oldStates.every((st) => st === 'SPENT')) {
        unsure = true
        continue
      }
      replaced.delete(idx)
      part.replacedTokens = [...(part.replacedTokens ?? []), part.lockedToken]
      part.lockedToken = entry.token
      usedNow += part.amount - (entry.amount as number)
      part.amount = entry.amount as number
      part.armed = false
      delete part.depositKeyset
      save(pubkey, record)
      // Re-armed exactly as a fresh part: one pre-signed refund per proof, NIP-98 by R. After `x`
      // the relay refuses it; the part then comes back by this wallet's own refund (noRelay).
      const out = await retryDeposit(ports, R, R, entry.token)
      part.armed = out.kind === 'armed'
      if ('keyset' in out && out.keyset) part.depositKeyset = out.keyset
      save(pubkey, record)
    }
  } finally {
    identity.fill(0)
  }
  const left = Math.max(0, before - usedNow)
  if (usedNow > 0) {
    const used = before - left
    record.remaining = left
    record.redemptions = [...(record.redemptions ?? []), { at: ports.now(), amount: used, remaining: left }]
    if (left === 0) {
      record.status = 'redeemed'
      record.spent = used
      record.done = isFinished(record)
    } else if (!keepStatus && record.status !== 'cancelling') record.status = 'reserved'
    save(pubkey, record)
    const n = record.redemptions.length
    await usedActivity(
      ports,
      record,
      n,
      used,
      left === 0 ? `${money(record, used)} used at ${shopName(record)}: nothing left on the code` : `${money(record, used)} used at ${shopName(record)}, ${money(record, left)} left on the code`,
    )
  } else if (!keepStatus && !unsure && record.status === 'settling') {
    record.status = 'reserved'
    save(pubkey, record)
  }
  return { outcome: unsure ? 'retry' : 'handled', reachable: true, replaced }
}

/** One partial use: its own outgoing history row (`checkout:<id>:used:<n>`). */
async function usedActivity(ports: CheckoutPorts, record: CheckoutCodeRecord, n: number, amount: number, memo: string): Promise<void> {
  try {
    await (ports.usedActivity ?? ports.activity)({ id: `checkout:${record.id}:used:${n}`, at: ports.now(), stall: record.stall, unit: record.unit, decimals: record.decimals, amount, memo })
  } catch {
    // History is display.
  }
}
