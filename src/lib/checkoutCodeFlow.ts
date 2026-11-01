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
} from './cashlinkLock'
import { armGift, armPreflight, cashlinkSteps, settleLockedGift, type ArmOutcome, type CashlinkPorts, type GatewayAnswer } from './cashlinkFlow'
import { normalise } from './checkoutCode'
import type { OnlineShop } from './onlineShop'
import {
  loadCheckoutCodes,
  reserveCheckoutRefundIndices,
  saveCheckoutCode,
  type CheckoutCodeRecord,
  type CheckoutCodeStatus,
  type CheckoutPartRecord,
} from './checkoutCodeRecords'
import { creditableFaceValue, parseVoucherToken, tokenProofs, voucherOfSecret, type TokenProof } from './voucherToken'

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

/** Run (or resume) one code. Never throws once the record exists. */
export async function runCheckoutCode(ports: CheckoutPorts, pubkey: string, id: string): Promise<CheckoutOutcome> {
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

function armContext(ports: CheckoutPorts, pubkey: string, record: CheckoutCodeRecord, part: CheckoutPartRecord, R: Uint8Array, identity?: Uint8Array) {
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

/** Null when every part is locked and the record moved on to `depositing`. */
async function lockParts(ports: CheckoutPorts, pubkey: string, record: CheckoutCodeRecord, identity: Uint8Array): Promise<CheckoutOutcome | null> {
  const R = (part: CheckoutPartRecord) => deriveCheckoutRefundSecret(identity, part.i)

  // 0. Before anything is burnt, every part: carved to its amount, then checked whole.
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
      const refusal = await armPreflight(armContext(ports, pubkey, record, part, R(part), identity))
      if (refusal) return refuse(pubkey, record, refusal.kind === 'unarmed' ? refusal.why : refusal.kind)
    }
  }

  // 1-4 for each part, as a Cashlink.
  for (const part of record.parts) {
    if (part.state === 'locked' || part.state === 'kept' || part.state === 'unarmed' || part.state === 'settled') continue
    // Checked above, with every other part: recorded as arming BEFORE its burn, and armed as a
    // resume, so the pre-check is not run twice (and cannot read our own burn as a claim).
    if (part.state === 'new') {
      part.state = 'arming'
      save(pubkey, record)
    }
    const out: ArmOutcome = await armGift(armContext(ports, pubkey, record, part, R(part), identity))
    if (out.kind === 'armed' || out.kind === 'not_armed') {
      // Not armed: the relay did not take a take-back. Still locked, and this wallet posts the same
      // refund itself after `x`, as for a Cashlink. The code is still worth issuing.
      part.state = 'locked'
      part.armed = out.kind === 'armed'
      part.depositKeyset = out.keyset
      delete part.token
      save(pubkey, record)
      if (part.sourceTokenId && !part.split) await ports.consume(part.sourceTokenId)
      continue
    }
    if (out.kind === 'arming') return { kind: 'pending', why: out.why, record }
    // Refused after the burn (the value came back as sats, kept) or before it (the coupon is as it
    // was), or gone: no code. Whatever is locked comes back at `x`.
    part.state = out.kind === 'kept_as_sats' ? 'kept' : out.kind === 'claimed' ? 'settled' : 'unarmed'
    if (part.state !== 'unarmed' && part.sourceTokenId && !part.split) await ports.consume(part.sourceTokenId)
    return abandon(pubkey, record, out.kind === 'unarmed' ? out.why : out.kind)
  }
  record.status = 'depositing'
  save(pubkey, record)
  return null
}

function sameStallAndUnit(token: string, record: CheckoutCodeRecord): boolean {
  try {
    const v = parseVoucherToken(token).voucher
    return v.issuerId.toLowerCase() === record.stall && v.unit.toUpperCase() === record.unit.toUpperCase()
  } catch {
    return false
  }
}

function refuse(pubkey: string, record: CheckoutCodeRecord, why: string): CheckoutOutcome {
  record.status = 'abandoned'
  record.refusal = why
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
    save(pubkey, record)
    return { kind: 'issued', record }
  }
  if (answer.status === 409 || answer.status === 429 || answer.status >= 500 || answer.status === 0) {
    return { kind: 'pending', why: `the code store said ${refusalName(answer)}`, record }
  }
  // A definite refusal: no code. Every part is locked and comes back at `x`.
  return abandon(pubkey, record, refusalName(answer))
}

const refusalName = (a: GatewayAnswer) => (typeof a.body?.refusal === 'string' ? a.body.refusal : `HTTP_${a.status}`)

export const codeHashOf = (canonical: string): string => bytesToHex(sha256(new TextEncoder().encode(canonical)))

// --- Cancelling -------------------------------------------------------------

/** Ask the store to cancel a `reserved` code. True once it is `cancelling` (or already further on). */
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
  const locked = voucherOfSecret(proof.secret)!
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
export async function settleLockedParts(ports: CheckoutPorts, pubkey: string, id: string): Promise<CheckoutCodeRecord | undefined> {
  const record = find(pubkey, id)
  if (!record) return undefined
  const identity = ports.identitySecret()
  if (!identity) return record
  try {
    for (const part of record.parts) {
      if (part.state !== 'locked' || !part.lockedToken) continue
      const out = await settleLockedGift({
        ports,
        refundSecret: deriveCheckoutRefundSecret(identity, part.i),
        noRelay: part.armed === false,
        lockedToken: part.lockedToken,
        ...(part.depositKeyset ? { depositKeyset: part.depositKeyset } : {}),
        onReturning: async () => {},
      })
      if (out.kind === 'returned' || out.kind === 'claimed') {
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

// --- Notifications ----------------------------------------------------------

export interface CheckoutNotice {
  type: typeof CHECKOUT_NOTICE_TYPE
  event: 'redeemed' | 'expired' | 'cancelled' | 'change'
  code_hash: string
  amount?: number
  unit?: string
  tokens?: string[]
}

export function parseCheckoutNotice(content: string): CheckoutNotice | null {
  try {
    const v = JSON.parse(content) as Partial<CheckoutNotice>
    if (v?.type !== CHECKOUT_NOTICE_TYPE) return null
    if (!['redeemed', 'expired', 'cancelled', 'change'].includes(String(v.event))) return null
    if (typeof v.code_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(v.code_hash)) return null
    if (v.tokens !== undefined && !(Array.isArray(v.tokens) && v.tokens.every((t) => typeof t === 'string'))) return null
    if (v.amount !== undefined && !Number.isSafeInteger(v.amount)) return null
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
  const record = loadCheckoutCodes(pubkey).find((r) => r.codeHash === notice.code_hash.toLowerCase())
  if (!record) return 'ignored'

  if (notice.event === 'redeemed') {
    const spent = Math.min(notice.amount ?? record.amount, record.amount)
    if (record.status !== 'redeemed') {
      record.status = 'redeemed'
      record.spent = spent
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
        if (record.status === 'redeemed') record.spent = Math.max(0, record.amount - out.face)
        save(pubkey, record)
        await changeActivity(ports, record, out.face)
        if (record.status === 'redeemed' && record.spent !== undefined) {
          await activity(ports, record, 'redeemed', record.spent, `${money(record, record.amount)} code used at ${shopName(record)}: ${money(record, record.spent)} spent, ${money(record, out.face)} back`)
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
  // expired
  if (record.status !== 'expired') {
    record.status = 'expired'
    save(pubkey, record)
  }
  const after = await settleLockedParts(ports, pubkey, record.id)
  if (!after?.done) return 'retry'
  await activity(ports, after, 'expired', after.amount, `${money(after, after.amount)} code expired unused: back in your wallet`)
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

const STORE_STATUSES: ReadonlySet<CheckoutCodeStatus> = new Set(['reserved', 'held', 'cancelling', 'redeemed', 'cancelled', 'expired'])

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

  for (const r of records.filter((r) => r.status === 'locking' || r.status === 'depositing')) {
    if ((await runCheckoutCode(ports, pubkey, r.id)).kind !== 'pending') changed += 1
  }

  let mine: Array<{ code?: string; status?: string }> = []
  try {
    const answer = await ports.store.call('GET', `${CHECKOUT_CODES_PATH}/mine`)
    if (answer.status === 200 && Array.isArray(answer.body)) mine = answer.body as typeof mine
    else if (answer.status === 200 && Array.isArray(answer.body?.codes)) mine = answer.body.codes as typeof mine
  } catch {
    // Unreachable: the clock still brings expired parts back below.
  }
  for (const entry of mine) {
    const code = typeof entry.code === 'string' ? normalise(entry.code) : null
    if (!code?.ok || !STORE_STATUSES.has(entry.status as CheckoutCodeStatus)) continue
    const record = loadCheckoutCodes(pubkey).find((r) => r.code === code.canonical && !r.done)
    if (!record || record.status === entry.status) continue
    record.status = entry.status as CheckoutCodeStatus
    if (record.status === 'redeemed') {
      for (const p of record.parts) if (p.state === 'locked') p.state = 'settled'
      record.done = true
      await activity(ports, record, 'redeemed', record.amount, `${money(record, record.amount)} code used at ${shopName(record)}`)
    }
    // `cancelled` is finished only once its tokens are in (they come by DM): left outstanding.
    save(pubkey, record)
    changed += 1
  }

  for (const r of loadCheckoutCodes(pubkey).filter((r) => !r.done && nowS >= r.x)) {
    const after = await settleLockedParts(ports, pubkey, r.id).catch(() => undefined)
    if (after?.done) {
      changed += 1
      if (after.status !== 'abandoned') {
        after.status = 'expired'
        save(pubkey, after)
      }
    }
  }
  return changed
}
