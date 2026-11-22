/**
 * A Cashlink that comes back on its own (#295 phase 4): the wallet's whole side of it.
 *
 * `cashlinkLock.ts` holds the shapes and the signatures. This module talks to the mint and to
 * imani-gateway-customer, in an order chosen so that a page that dies at ANY point loses nothing:
 * every output the sender makes is derived from its refund key, so every step can be found again at
 * the mint (NUT-09) and finished on the next run.
 *
 * ## Sending (arming a link)
 *
 * After the ordinary atomic send has put a bearer gift on the link:
 *
 * 0. **Check before anything moves.** The gift must be lockable (the gateway's own allowlist), carry
 *    its amount proof (NUT-12 DLEQ), the expiry must sit in the gateway's window (Q8), the lock route
 *    must answer "not spent yet" to a dry run (so it exists and accepts everything but the burn), and
 *    the refund relay must be switched on. If any of that fails the link stays exactly as it is
 *    today: a bearer gift this wallet takes back when it next runs. Nothing has been burnt.
 * 1. **Burn** each gift proof (one input per swap, `SIG_ALL` tag uniformity) into derived plain
 *    outputs, with a `SIG_ALL` witness by `R`. That witness is what tells the lock route the burn
 *    was ours (gc#255 deviation 1).
 * 2. **Lock**: the gateway signs the successor locked to the link, `refund = [R]`, `locktime = x`.
 * 3. **Mint** it from the burn's outputs, and put it on the link (a gift wrap to the link key).
 * 4. **Deposit** the pre-signed refund swap with the relay, NIP-98 signed by the LINK key so the
 *    relay never learns who sent it. 201/200: armed. Anything else (off, missing, refused,
 *    unreachable): NOT armed, and this wallet takes it back itself.
 *
 * ## Coming back
 *
 * On each run, for a locked link: still unspent before `x`, nothing to do (a deposit that failed is
 * retried); still unspent after `x`, this wallet posts THE SAME pre-signed refund itself (identical
 * outputs, so a relay posting at the same moment changes nothing); spent, the relay's result is
 * fetched by `sha256(secret)`, and failing that the mint is asked (NUT-09) whether it signed our
 * outputs. Ours: the coupon is re-formed through the re-sign route, unlocked (Q4). Not ours: it was
 * claimed. A relay arm that FAILED, for any reason (`code_12002`, `attempts_exhausted:restore_*`),
 * is read exactly like "not armed": the mint decides.
 *
 * ## Claiming
 *
 * The recipient burns the locked gift with the link key into its own outputs, gets the unlocked
 * successor re-signed (the link pathway), and mints it. Its blinding factors are random, so they are
 * written to a small ledger first; logout stays off while that ledger holds anything.
 *
 * ## What it never does
 *
 * - It never makes or accepts a locktime without a refund key (`assertNotOpenAfterLocktime`).
 * - It never sends a redemption declaration: none of these swaps credits anybody (cashu-mint#540 D9).
 * - It never lets a refusal after a burn lose the value: the plain sats are kept, as for a coupon
 *   swapped back to sats.
 */
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hashToCurve, pointFromHex } from '@cashu/crypto/modules/common'
import { verifyDLEQProof } from '@cashu/crypto/modules/client/NUT12'
import { nip17 } from 'nostr-tools'

import {
  CASHLINK_LOCK_TAG,
  CASHLINK_RESIGN_TAG,
  assertNotOpenAfterLocktime,
  blinded,
  cashlinkAuthorization,
  derivedCarrier,
  derivedNonce,
  derivedOutputs,
  isTheLockAskedFor,
  isTheSuccessorAskedFor,
  isSelfLocked,
  linkLockProposal,
  lockWindowProblem,
  lockableVoucher,
  readLinkLock,
  secretHash,
  sigAllWitness,
  unlockedProposal,
  xOnlyPub,
  type DerivedPurpose,
} from './cashlinkLock'
import { linkKeySigner, linkPubOf, secretFromText, type GiftToken, type ProofState } from './giftLink'
import { nip98Header, type RequestSigner } from './nip98'
import { encodePlainTokenV4 } from './plainToken'
import { isVoucherByReference, parseVoucherToken, referencedDocuments, tokenProofs, voucherOfProof, type TokenProof } from './voucherToken'
import { splitTokenByVoucher } from './tokenSplit'
import { splitIntoDenominations, unblindOutputs, type BlindSignatureResponse, type BlindedOutput, type UnblindedProof } from './walletSwap'
import { cashlinkClaimsKey } from './inFlightMoney'
import { faceShareOf } from './faceSplit'

export { cashlinkClaimsKey }

// --- Ports ------------------------------------------------------------------

/** A mint swap's answer, sorted into what the flow acts on. */
export type SwapAnswer =
  | { kind: 'signed'; signatures: BlindSignatureResponse[] }
  /** 11001 or 11003: spent already, or our outputs already signed. Ask NUT-09 who has it. */
  | { kind: 'spent' }
  /** 12002: an output keyset is archived. Nothing was signed. */
  | { kind: 'inactive' }
  /** Anything else the mint refused. Nothing was signed. */
  | { kind: 'refused'; code?: number; detail?: string }

export interface CashlinkMint {
  /**
   * The active sat keyset. #477: the HTTP mint may answer from a read under a minute old; pass
   * `{ fresh: true }` after the mint said a keyset is inactive (12002, KEYSET_INACTIVE).
   */
  activeKeysetId(mintUrl: string, opts?: { fresh?: boolean }): Promise<string>
  keys(mintUrl: string, keysetId: string): Promise<Record<string, string>>
  swap(mintUrl: string, inputs: Array<TokenProof & { witness?: string }>, outputs: BlindedOutput[]): Promise<SwapAnswer>
  /** NUT-09. Throws when the mint cannot be read; an empty answer means it signed none of them. */
  restore(mintUrl: string, outputs: BlindedOutput[]): Promise<{ outputs: { B_: string }[]; signatures: BlindSignatureResponse[] }>
  /** NUT-07, one state per secret. */
  states(mintUrl: string, secrets: string[]): Promise<ProofState[]>
}

export interface GatewayAnswer {
  status: number
  body: Record<string, unknown> | null
}

export interface CashlinkGateway {
  /** A NIP-98 signed call. `signer` undefined means the session's. Throws only when unreachable. */
  call(method: 'GET' | 'POST', path: string, body: unknown, signer?: RequestSigner): Promise<GatewayAnswer>
}

export interface CashlinkPorts {
  mint: CashlinkMint
  gateway: CashlinkGateway
  /** Put a token on a link (a gift wrap to the link key). True once one copy is confirmed stored. */
  deliver(linkSecret: Uint8Array, token: string): Promise<boolean>
  /** Keep a coupon this wallet now holds. Must throw if it could not be written. */
  keep(row: KeptCoupon): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

/** A coupon to keep: the token, and its sats when the coupon could not be re-formed. */
export interface KeptCoupon {
  token: string
  /** Set when only the sats came back: the value is kept as plain ecash in `satsToken`. */
  satsToken?: string
  sats?: number
  /**
   * This proof's whole share of its gift's face (#384), apportioned by largest remainder across the
   * gift's proofs so the rows sum to the gift. Absent: the port rounds this proof on its own.
   */
  faceValue?: number
  /** Why it is being kept, for the History row. */
  why: 'claimed' | 'returned'
  /** Shared by every coupon claimed off one link, so History shows the claim as one entry. */
  bundleId?: string
  /**
   * A Cashlink's own coupon, back with its issuer (`why: 'returned'`): the port writes the
   * incoming "Taken back" row. Absent for every other return (checkout codes, guest gifts, kept
   * sats of a burn), which have their own records.
   */
  takenBack?: true
  /** With `takenBack`: the id of the `sent` row that made the Cashlink, for the return row's link. */
  returnOf?: string
  /** With `takenBack`: the return row's memo, when it is not a Cashlink's ("Taken back from Cashlink"). */
  returnMemo?: string
}

/**
 * The bundle id every coupon claimed off one Cashlink shares: a hash of the link's PUBLIC key, so
 * it is the same on a retry or a start-up finish and reveals nothing about the link secret.
 */
export function cashlinkBundleId(linkPub: string): string {
  return bytesToHex(sha256(new TextEncoder().encode('imani-cashlink-bundle:' + linkPub.toLowerCase()))).slice(0, 32)
}

export const LOCK_PATH = '/api/v1/wallet/vouchers/cashlink/lock'
/** gateway-customer#287: every `/lock` body of a gift in one call, each answered as `/lock` would. */
export const LOCK_BATCH_PATH = '/api/v1/wallet/vouchers/cashlink/lock-batch'
/** The most locks the gateway takes in one batch. */
export const LOCK_BATCH_MAX = 32
export const RESIGN_PATH = '/api/v1/wallet/vouchers/cashlink/resign'
export const REFUNDS_PATH = '/api/v1/wallet/cashlink/refunds'
/** gateway-customer#288: a part's refund deposits in one call, each answered as `/refunds` would. */
export const REFUNDS_BATCH_PATH = REFUNDS_PATH + '/batch'
/** The most deposits the gateway takes in one batch. */
export const REFUNDS_BATCH_MAX = 32

// --- Shared steps -----------------------------------------------------------

const mintOf = (token: string): string => parseVoucherToken(token).mintUrl.trim().replace(/\/+$/, '')

const proofBody = (p: TokenProof) => ({
  amount: p.amount,
  id: p.id,
  C: p.C,
  ...(p.dleq ? { dleq: { e: p.dleq.e, s: p.dleq.s, r: p.dleq.r } } : {}),
})

const burnOutputsBody = (outputs: ReadonlyArray<{ amount: number; B_: string }>) => outputs.map((o) => ({ amount: o.amount, B_: o.B_ }))

/**
 * cashu-voucher#64: an unlocked predecessor stored by reference names its voucher only by hash, so
 * the gateway needs the document beside it (`predecessor_document`, hex) to read the voucher. Sent
 * only when the proof is by reference; an inline or locked predecessor's body is unchanged.
 */
const predecessorDocument = (p: TokenProof): { predecessor_document?: string } =>
  p.document && isVoucherByReference(p.secret) ? { predecessor_document: p.document } : {}

/**
 * Our outputs the mint has signed, as proofs, matched by `B_` (a restore answers a subset). The
 * keyset is the one the mint signed under, so an output re-made with another keyset id still pairs.
 */
async function restoreMine(mint: CashlinkMint, mintUrl: string, outputs: BlindedOutput[]): Promise<UnblindedProof[]> {
  if (outputs.length === 0) return []
  const answer = await mint.restore(mintUrl, outputs)
  const byB = new Map<string, BlindSignatureResponse>()
  answer.outputs.forEach((o, n) => {
    if (answer.signatures[n]) byB.set(o.B_.toLowerCase(), answer.signatures[n])
  })
  const proofs: UnblindedProof[] = []
  for (const output of outputs) {
    const sig = byB.get(output.B_.toLowerCase())
    if (!sig) continue
    proofs.push(...unblindOutputs([{ ...output, id: sig.id }], [sig], await mint.keys(mintUrl, sig.id)))
  }
  return proofs
}

type SwapResult = { kind: 'proofs'; proofs: UnblindedProof[]; fresh?: true } | { kind: 'gone' } | { kind: 'refused'; answer: SwapAnswer }

/**
 * A swap, then its proofs: from the answer, or from NUT-09 when the mint says it already signed.
 * `fresh` when the mint signed these outputs just now: they were never signed before, so nothing
 * can have spent them yet (#477: the caller then skips asking).
 */
async function swapOrRestore(
  mint: CashlinkMint,
  mintUrl: string,
  inputs: Array<TokenProof & { witness?: string }>,
  outputs: BlindedOutput[],
): Promise<SwapResult> {
  const answer = await mint.swap(mintUrl, inputs, outputs)
  if (answer.kind === 'signed') {
    return { kind: 'proofs', proofs: unblindOutputs(outputs, answer.signatures, await mint.keys(mintUrl, outputs[0].id)), fresh: true }
  }
  if (answer.kind === 'spent') {
    const mine = await restoreMine(mint, mintUrl, outputs)
    if (mine.length === outputs.length) return { kind: 'proofs', proofs: mine }
    // Spent, and not into our outputs: someone else spent it. A PARTIAL restore cannot be ours
    // (one swap signs all of its outputs at once, gc#262 R1), so it is not read as ours either.
    if (mine.length === 0) return { kind: 'gone' }
    throw new Error('the mint signed only part of a swap; left for the next run')
  }
  return { kind: 'refused', answer }
}

/** Ask once, and again a few times while the mint has not caught up (409 PREDECESSOR_NOT_SPENT). */
async function signRoute(ports: CashlinkPorts, path: string, body: unknown): Promise<GatewayAnswer> {
  let answer = await ports.gateway.call('POST', path, body)
  for (let attempt = 0; attempt < 3 && answer.status === 409 && answer.body?.refusal === 'PREDECESSOR_NOT_SPENT'; attempt++) {
    await ports.sleep(800 * (attempt + 1))
    answer = await ports.gateway.call('POST', path, body)
  }
  // #396: rate limited (20/min per key on the Cashlink routes): wait and ask again, a few times. The
  // request is deterministic, so asking again is the identical request.
  for (let attempt = 0; attempt < 3 && answer.status === 429; attempt++) {
    await ports.sleep(5_000 * (attempt + 1))
    answer = await ports.gateway.call('POST', path, body)
  }
  return answer
}

/**
 * #396: an answer that is NOT a refusal, only "not now": 409 (not spent yet, or the same request still
 * running), 429 (gateway-customer's per-key rate limit on the Cashlink routes, 20/min) and 5xx. Each
 * leaves the step for the next run. Read as a definite refusal, a 429 after the burn kept the value
 * as plain sats and gave up on the coupon (the link then read "already added" and the take-back
 * never re-formed the voucher).
 */
const notYet = (status: number): boolean => status === 409 || status === 429 || status >= 500

const refusalOf = (a: GatewayAnswer): string => (typeof a.body?.refusal === 'string' ? a.body.refusal : `HTTP_${a.status}`)

/** Gateways that answered the batch route 404/405 (older than gateway-customer#287): asked one by one from then on. */
const noBatchRoute = new WeakSet<CashlinkGateway>()

/** One lock body asked alone: a real lock through `signRoute`, a dry run with only the 429 retry. */
async function askOneLock(ports: CashlinkPorts, body: unknown, real: boolean): Promise<GatewayAnswer> {
  if (real) return signRoute(ports, LOCK_PATH, body)
  let dry = await ports.gateway.call('POST', LOCK_PATH, body)
  // #477: many dry runs at once can meet the gateway's per-caller limit on the Cashlink routes
  // (120 a minute). "Not now" is never "refused": wait and ask again, as `signRoute` does.
  for (let attempt = 0; attempt < 3 && dry.status === 429; attempt++) {
    await ports.sleep(5_000 * (attempt + 1))
    dry = await ports.gateway.call('POST', LOCK_PATH, body)
  }
  return dry
}

/**
 * One batch call, with the 429 retry `signRoute` has. The answers, one per body in order; null
 * when this gateway has no batch route (404/405), so the caller asks one by one. Any other answer
 * that is not a well-formed list (a 5xx, a 429 that did not clear) is that status for every body,
 * which each caller already reads as "not now". Throws only when the gateway is unreachable.
 */
async function lockBatchOnce(ports: CashlinkPorts, bodies: unknown[]): Promise<GatewayAnswer[] | null> {
  let answer = await ports.gateway.call('POST', LOCK_BATCH_PATH, { locks: bodies })
  for (let attempt = 0; attempt < 3 && answer.status === 429; attempt++) {
    await ports.sleep(5_000 * (attempt + 1))
    answer = await ports.gateway.call('POST', LOCK_BATCH_PATH, { locks: bodies })
  }
  if (answer.status === 404 || answer.status === 405) return null
  const results = answer.status === 200 && Array.isArray(answer.body?.results) ? (answer.body.results as unknown[]) : null
  if (!results || results.length !== bodies.length) {
    // The batch as a whole was not judged (a 5xx, a 429 that did not clear, or a 4xx such as a
    // body the edge would not take). None of that is a refusal of any one lock, so it is never
    // passed on as a 4xx: after a burn a 4xx keeps the value as sats, and that would turn "the
    // batch was not read" into "the coupon is not re-formed". 429 and 5xx keep their status
    // (each caller reads them as "not now"); everything else becomes 502, also "not now".
    const status = answer.status === 429 || answer.status >= 500 ? answer.status : 502
    return bodies.map(() => ({ status, body: answer.body }))
  }
  return results.map((r) => {
    const item = (r ?? {}) as { status?: unknown; signed_secret?: unknown; refusal?: unknown }
    const status = typeof item.status === 'number' ? item.status : 502
    return {
      status,
      body: {
        ...(typeof item.signed_secret === 'string' ? { signed_secret: item.signed_secret } : {}),
        ...(typeof item.refusal === 'string' ? { refusal: item.refusal } : {}),
      },
    }
  })
}

/**
 * gateway-customer#287: every lock body of a gift, answered as `/lock` answers each one, in as few
 * calls as the gateway allows: one batch (of up to {@link LOCK_BATCH_MAX}) instead of one call per
 * proof. Each lock that is only "not now" (429, and for a real lock (`real`) a 409
 * PREDECESSOR_NOT_SPENT while the mint catches up with the burn) is asked again, a few times, as
 * `signRoute` does; a dry run reads that 409 as its answer.
 *
 * A gateway without the batch route is asked one body at a time, side by side, exactly as before.
 * Never rejects: a body whose answer could not be had is `{ ok: false }` in its place.
 */
export async function lockAll(ports: CashlinkPorts, bodies: unknown[], real: boolean): Promise<Settled<GatewayAnswer>[]> {
  if (bodies.length === 0) return []
  const oneByOne = () => inParallel(bodies.map((body) => () => askOneLock(ports, body, real)), ARM_CONCURRENCY)
  if (noBatchRoute.has(ports.gateway)) return oneByOne()
  const out: Settled<GatewayAnswer>[] = new Array(bodies.length)
  for (let start = 0; start < bodies.length; start += LOCK_BATCH_MAX) {
    const chunk = bodies.slice(start, start + LOCK_BATCH_MAX).map((body, i) => ({ body, n: start + i }))
    let answers: GatewayAnswer[] | null
    try {
      answers = await lockBatchOnce(ports, chunk.map((c) => c.body))
    } catch (error) {
      for (const c of chunk) out[c.n] = { ok: false, error }
      continue
    }
    if (answers === null) {
      noBatchRoute.add(ports.gateway)
      return oneByOne()
    }
    chunk.forEach((c, i) => (out[c.n] = { ok: true, value: answers![i] }))
    // Ask again for the locks that are only "not now": rate limited (429) in their own answer, or,
    // for a real lock, not spent yet (the burn has not reached the mint's state), as `signRoute`
    // and the dry run's own retry do for a single call.
    const retryable = (a: Settled<GatewayAnswer>): boolean =>
      a.ok && (a.value.status === 429 || (real && a.value.status === 409 && a.value.body?.refusal === 'PREDECESSOR_NOT_SPENT'))
    for (let attempt = 0; attempt < 3; attempt++) {
      const waiting = chunk.filter((c) => retryable(out[c.n]))
      if (waiting.length === 0) break
      const limited = waiting.some((c) => out[c.n].ok && (out[c.n] as { value: GatewayAnswer }).value.status === 429)
      await ports.sleep((limited ? 5_000 : 800) * (attempt + 1))
      let again: GatewayAnswer[] | null
      try {
        again = await lockBatchOnce(ports, waiting.map((c) => c.body))
      } catch (error) {
        for (const c of waiting) out[c.n] = { ok: false, error }
        break
      }
      if (again === null) break
      waiting.forEach((c, i) => (out[c.n] = { ok: true, value: again![i] }))
    }
  }
  return out
}

/** Spread into a KeptCoupon: the face share only when there is one (#384). */
const faceOf = (faceValue: number | undefined): { faceValue?: number } => (faceValue === undefined ? {} : { faceValue })

/** The token a set of proofs makes, carrying their DLEQs (the next holder proves the amount with them). */
const tokenOf = (mintUrl: string, proofs: UnblindedProof[]): string => encodePlainTokenV4(mintUrl, 'sat', proofs)

/**
 * Keep plain sats against the ONE coupon proof they came from: the value is never lost.
 *
 * Keyed by that proof alone (a one-proof token), never by the whole gift token: the app's `keep`
 * writes one voucher row per `tokenIdFrom(token)` and MERGES a second write over the first, so two
 * proofs of one gift kept under the same token would leave only the last proof's sats
 * (rev-wallet377 H1).
 */
async function keepAsSats(
  ports: CashlinkPorts,
  mintUrl: string,
  source: TokenProof,
  proofs: UnblindedProof[],
  why: KeptCoupon['why'],
  faceValue?: number,
  { bundleId, takenBack, returnOf, returnMemo }: Pick<KeptCoupon, 'bundleId' | 'takenBack' | 'returnOf' | 'returnMemo'> = {},
): Promise<void> {
  const couponToken = tokenOf(mintUrl, [{ amount: source.amount, id: source.id, secret: source.secret, C: source.C }])
  await ports.keep({
    token: couponToken,
    satsToken: tokenOf(mintUrl, proofs),
    sats: proofs.reduce((n, p) => n + p.amount, 0),
    why,
    ...faceOf(faceValue),
    ...(bundleId ? { bundleId } : {}),
    ...(takenBack && (bundleId || returnOf) ? { takenBack: true as const, ...(returnOf ? { returnOf } : {}), ...(returnMemo ? { returnMemo } : {}) } : {}),
  })
}

// --- Sending: arming --------------------------------------------------------

/**
 * Why a link was left as an ordinary bearer gift. Nothing was burnt in any of these; all but
 * `burn_refused` are decided before `onArming`.
 */
export type UnarmedReason =
  | 'merchant'
  | 'no_gift'
  | 'not_lockable'
  | 'window'
  | 'no_amount_proof'
  | 'lock_route_unavailable'
  | 'lock_refused'
  | 'relay_unavailable'
  | 'unreachable'
  /** #477: the gateway kept answering 429 to the pre-check; nothing was burnt, try again later. */
  | 'rate_limited'
  /** The mint refused the burn itself (nothing moved). The only one that can follow `onArming`. */
  | 'burn_refused'
  /**
   * The lock key is a stall's online shop and the stall's plan takes no new checkout codes
   * (`422 FEATURE_NOT_IN_PLAN`, #402). Decided by the dry run, so nothing was burnt.
   */
  | 'not_in_plan'

export type ArmOutcome =
  /** Locked, and the take-back is waiting at the relay: it comes back on its own. */
  | { kind: 'armed'; keyset: string }
  /** Locked, but the relay did not take the take-back: this wallet takes it back itself. */
  | { kind: 'not_armed'; keyset: string; why: string }
  /** Left as an ordinary gift, untouched. */
  | { kind: 'unarmed'; why: UnarmedReason; /** #644: the gateway's own refusal name, when it gave one. */ detail?: string }
  /** Part way; the next run carries on (`arm.s = 'arming'`). Nothing is lost. */
  | { kind: 'arming'; why: string }
  /** The gift left the link before it could be locked: it was claimed. */
  | { kind: 'claimed' }
  /** The lock was refused after the burn: the value came back as sats, kept in this wallet. */
  | { kind: 'kept_as_sats' }

export interface ArmContext {
  ports: CashlinkPorts
  linkSecret: Uint8Array
  refundSecret: Uint8Array
  x: number
  /** The bearer gift tokens on the link (already through `giftCandidates`). */
  gifts: GiftToken[]
  /** A merchant account's Cashlinks lapse (owner scope 2026-10-21): never armed. */
  merchant: boolean
  /** Called with the burn keyset BEFORE the first burn, so a page that dies resumes. Must throw on failure. */
  onArming(burnKeyset: string): Promise<void>
  /**
   * Called with each signed lock BEFORE it is minted. A lock is not spendable (it is locked, and
   * its blinding factor is derived), but it is the one way to find the minted gift again should the
   * page die and the gateway no longer replay it.
   */
  onLocked(giftSecret: string, signedLock: string): Promise<void>
  /** Locks recorded by an earlier run, by gift secret. */
  knownLocks?: ReadonlyMap<string, string>
  /** Set when resuming: the burn keyset recorded before the first burn. */
  burnKeyset?: string
  /**
   * #477: called once the locked token is delivered, BEFORE its refunds are deposited, so a
   * caller that only needs the locked token (a checkout code's deposit at the store) can go on
   * while the relay deposits run. Never awaited by the arm's outcome; must not throw.
   */
  onDelivered?: (lockedToken: string) => void
  /**
   * Resuming an arm `onArming` already recorded, whether or not its burn keyset is known (#379: a
   * record that lost it must still never re-run the pre-check, which reads our own burn as a claim).
   */
  resuming?: boolean
  /**
   * #477: this run's own pre-check (`armPreflight`) found every proof UNSPENT just now, so the arm
   * does not ask the mint again before the burns (about 1 s on staging, on the critical path). A
   * state gone stale since is caught by the burn itself, as for any state: the mint answers
   * "spent" and NUT-09 says whose.
   */
  preChecked?: boolean
  /**
   * #402: the key the gift is locked to, when it is not the link key: a checkout part is locked to
   * the shop key `S`. `linkSecret` is then the part's refund key `R`, which signs the deposit
   * (gateway-customer accepts the refund key there) and is what `deliver` is handed.
   */
  lockPub?: string
  /**
   * #402: the wallet's own key K. A gift proof locked to K alone (a bearer split's part) is then
   * lockable: its burn is witnessed by K (NUT-11 SIG_INPUTS) and the lock is authorised by K.
   */
  selfSecret?: Uint8Array
}

/** The relay is on when a deliberately empty deposit is refused for its shape (422), not 503/404. */
async function relayIsOn(ports: CashlinkPorts, linkSecret: Uint8Array): Promise<boolean> {
  try {
    const answer = await ports.gateway.call('POST', REFUNDS_PATH, { proof: {}, outputs: [{}] }, linkKeySigner(linkSecret))
    return answer.status === 422
  } catch {
    return false
  }
}

/**
 * Arm one link. Never throws: every failure is an outcome, and only the ones after a burn leave
 * work for the next run (which `onArming` recorded before the burn).
 */
export async function armGift(ctx: ArmContext): Promise<ArmOutcome> {
  try {
    return await arm(ctx)
  } catch (error) {
    return { kind: 'arming', why: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether the mint signed our derived burn outputs for any of these proofs (NUT-09). */
async function burntByUs(ports: CashlinkPorts, refundSecret: Uint8Array, mintUrl: string, proofs: { proof: TokenProof }[]): Promise<boolean> {
  for (const { proof } of proofs) {
    const burn = derivedOutputs(refundSecret, 'burn', proof.secret, proof.amount, proof.id)
    if ((await restoreMine(ports.mint, mintUrl, burn)).length > 0) return true
  }
  return false
}

/**
 * #379: whether a bearer gift on the link was spent by THIS wallet's own burn (the first step of
 * arming), which is never a claim. Throws when the mint cannot be read: unknown is not "claimed".
 */
export async function burntByThisWallet(ports: CashlinkPorts, refundSecret: Uint8Array, gifts: GiftToken[]): Promise<boolean> {
  for (const g of gifts) {
    // Only a proof with its amount proof (NUT-12 DLEQ) was ever burnt by an arm: the pre-check
    // refuses to burn without one. So a gift without one never costs a mint round trip here.
    const proofs = safeProofs(g.token).filter((p) => p.dleq)
    if (proofs.length === 0 || readLinkLock(proofs[0].secret)) continue
    if (await burntByUs(ports, refundSecret, mintOf(g.token), proofs.map((proof) => ({ proof })))) return true
  }
  return false
}

async function allStillUnspent(ports: ArmContext['ports'], mintUrl: string, proofs: { proof: { secret: string } }[]): Promise<boolean> {
  const states = await ports.mint.states(mintUrl, proofs.map((p) => p.proof.secret))
  return states.length === proofs.length && states.every((s) => s === 'UNSPENT')
}

/**
 * Proofs of one gift (and refunds of one part) in flight at once (#477). A coupon is one proof per
 * power-of-two denomination, so a 12 EUR coupon is up to ~14 proofs; 16 runs every proof of one in
 * a single wave (with 8, a 9-proof coupon waited a whole burn-lock-mint round for its 9th proof,
 * about 1.5 s on staging). The locks go in one batch call (gateway-customer#287), so the gateway's
 * per-caller limits (120 a minute on the Cashlink routes, 30 a minute per link key on the
 * refunds) and the edge's 10 a second per address with a 100 burst are not the bound here.
 */
const ARM_CONCURRENCY = 16

/**
 * #477: how long the lock batch waits for proofs still burning, after the last one asked. The burns
 * of one gift finish within a few hundred ms of each other, except for the odd slow one (a burn
 * that took 1.9 s while the others took 0.8 s held every lock back by a second on staging).
 */
export const LOCK_BATCH_WAIT_MS = 300

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

const settled = <T,>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )

/**
 * #477: run `tasks` at most `limit` at a time and wait for EVERY one, results in task order. Never
 * rejects: a failed task is a `{ ok: false }` in its place, so no step is left running when the
 * caller decides what the outcome is.
 */
export async function inParallel<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<Settled<T>[]> {
  const out: Settled<T>[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const n = next++
      out[n] = await settled(Promise.resolve().then(tasks[n]))
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker))
  return out
}

async function arm(ctx: ArmContext): Promise<ArmOutcome> {
  const { ports } = ctx
  if (ctx.merchant) return { kind: 'unarmed', why: 'merchant' }
  const linkPub = ctx.lockPub ?? linkPubOf(ctx.linkSecret)
  const refundPub = xOnlyPub(ctx.refundSecret)
  const proofs = ctx.gifts.flatMap((g) => tokenProofs(g.token).map((p) => ({ token: g.token, proof: p })))
  if (proofs.length === 0) return { kind: 'unarmed', why: 'no_gift' }
  const mintUrl = mintOf(proofs[0].token)
  const resuming = ctx.resuming === true || ctx.burnKeyset !== undefined

  // 0. Before anything moves. A resumed arm has already passed these and may have burnt.
  // #540 F4: a preflight that passed has just read every proof UNSPENT (it refuses on anything
  // else), so the arm does not ask the mint again. A refusal we carry on past (our own burn) has
  // not, and the states are read below as before.
  let preflightUnspent = false
  if (!resuming) {
    const refusal = await preflight(ctx, proofs, mintUrl, linkPub, refundPub)
    // #379: a gift spent into OUR burn outputs was burnt by this wallet (another run of this arm
    // whose record is not visible here), never claimed. It is finished like a resumed arm.
    if (refusal && !(refusal.kind === 'claimed' && (await burntByUs(ports, ctx.refundSecret, mintUrl, proofs)))) return refusal
    preflightUnspent = refusal === null
  }

  const [burnKeyset, giftStates] = await Promise.all([
    ctx.burnKeyset ?? ports.mint.activeKeysetId(mintUrl),
    ctx.preChecked || preflightUnspent
      ? Promise.resolve(proofs.map(() => 'UNSPENT' as ProofState))
      : ports.mint.states(mintUrl, proofs.map((p) => p.proof.secret)).catch(() => undefined),
  ])
  if (!resuming) await ctx.onArming(burnKeyset)

  // 1-3, per proof. #477: every proof's steps are derived from R and the proof alone, so the
  // proofs run side by side; results are taken in the gift's own order, so the locked token (and
  // the store's idempotent deposit body built from it) is the same whichever finished first. The
  // gift's states are read once for every proof (an answer that is stale by the burn is caught by
  // the burn itself: the mint answers "spent" and NUT-09 says whose).
  const stateOf = (n: number): ProofState | undefined => (giftStates?.length === proofs.length ? giftStates[n] : undefined)
  // gateway-customer#287: the proofs' locks go to the gateway together, in one batch call.
  const gate = new LockGate(ports)
  const lockStep = async (n: number): Promise<LockStep> => {
    gate.enter()
    let asked = false
    try {
      return await lockOne(ctx, mintUrl, proofs[n].proof, burnKeyset, linkPub, refundPub, stateOf(n), (body) => {
        if (asked) return signRoute(ports, LOCK_PATH, body)
        asked = true
        return gate.ask(body)
      })
    } finally {
      if (!asked) gate.leave()
    }
  }
  const steps = await inParallel(
    proofs.map((_, n) => () => lockStep(n)),
    ARM_CONCURRENCY,
  )

  // The mint refused every burn outright and every proof is still unspent: the link is exactly the
  // ordinary gift it was, and must not stay 'arming' for ever (rev-wallet377 M2). On a resumed run
  // "nothing moved in this run" is not "nothing burnt": an earlier run may have burnt ours
  // (rev-wallet377 N1), so only the mint saying every proof is still UNSPENT lets it go back.
  if (steps.every((s) => s.ok && s.value.kind === 'unburnt') && (await allStillUnspent(ports, mintUrl, proofs))) {
    return { kind: 'unarmed', why: 'burn_refused' }
  }

  const locked: UnblindedProof[] = []
  let gone = 0
  let failure: unknown
  for (const [n, s] of steps.entries()) {
    if (!s.ok) {
      failure ??= s.error
      continue
    }
    const out = s.value
    if (out.kind === 'unburnt') {
      // Part way through a multi-proof gift: the next run tries again (the burnt proofs are found
      // by NUT-09).
      failure ??= new Error(`the burn was refused (${out.why}); left for the next run`)
      continue
    }
    if (out.kind === 'locked') locked.push(out.proof)
    else if (out.kind === 'gone') gone += 1
    else await keepAsSats(ports, mintUrl, proofs[n].proof, out.proofs, 'returned', faceShareOf(proofs[n].token, proofs[n].proof.secret))
  }
  // Every proof has finished its steps (nothing is left in flight): a resumed run carries on.
  if (failure !== undefined) throw failure
  if (locked.length === 0) return gone === proofs.length ? { kind: 'claimed' } : { kind: 'kept_as_sats' }

  // 3. On the link. Until a copy is confirmed stored, the link stays `arming` and this is retried.
  // One token per voucher: a token mixing coupons is refused by `parseVoucherToken`, so a link of
  // several coupons locked as one token could be neither claimed nor taken back (staging,
  // 2026-11-05, a 3-coupon link). Every part must be on the link before it counts as delivered.
  for (const p of locked) assertNotOpenAfterLocktime(p.secret)
  // Cut into relay-sized wraps only for a Cashlink. A checkout part (`lockPub`, #402) is one coupon
  // handed to the code store whole as ONE token: its `deliver` keeps a single `lockedToken`, so a cut
  // part would reach the store short (review of #533).
  const lockedTokens = ctx.lockPub
    ? [tokenOf(mintUrl, locked)]
    : splitTokenByVoucher(tokenOf(mintUrl, locked)).flatMap((t) => fitToWraps(ctx.linkSecret, mintUrl, tokenProofs(t)))
  for (const part of lockedTokens) {
    if (!(await ports.deliver(ctx.linkSecret, part))) return { kind: 'arming', why: 'not on the link yet' }
  }
  try {
    for (const part of lockedTokens) ctx.onDelivered?.(part)
  } catch {
    // A hint to the caller; the arm goes on either way.
  }

  // 4. #477: a keyset read just now (not one recorded by an earlier run) is the active one, so the
  // refunds start there; a rotation since is answered KEYSET_INACTIVE and re-read, as before.
  return depositAll(ports, ctx.linkSecret, ctx.refundSecret, mintUrl, locked, ctx.burnKeyset === undefined ? burnKeyset : undefined)
}

/**
 * #402: step 0 alone, for every proof of `ctx.gifts`, with nothing burnt. A checkout code runs it
 * over EVERY part before the first burn, so one part that cannot be locked stops the code while
 * every coupon is still exactly what it was. Null: all of it can be armed. Never throws.
 */
export async function armPreflight(ctx: ArmContext): Promise<ArmOutcome | null> {
  try {
    const proofs = ctx.gifts.flatMap((g) => tokenProofs(g.token).map((p) => ({ token: g.token, proof: p })))
    if (proofs.length === 0) return { kind: 'unarmed', why: 'no_gift' }
    return await preflight(ctx, proofs, mintOf(proofs[0].token), ctx.lockPub ?? linkPubOf(ctx.linkSecret), xOnlyPub(ctx.refundSecret))
  } catch {
    return { kind: 'unarmed', why: 'unreachable' }
  }
}

async function preflight(
  ctx: ArmContext,
  proofs: Array<{ token: string; proof: TokenProof }>,
  mintUrl: string,
  linkPub: string,
  refundPub: string,
): Promise<ArmOutcome | null> {
  const { ports } = ctx
  const nowS = Math.floor(ports.now() / 1000)
  for (const { proof } of proofs) {
    const found = lockableVoucher(proof.secret, selfPubOf(ctx))
    if ('problem' in found) return { kind: 'unarmed', why: 'not_lockable' }
    if (lockWindowProblem(ctx.x, found.voucher.expiresAt, nowS)) return { kind: 'unarmed', why: 'window' }
    // The lock route proves the burnt proof's amount by its DLEQ (#141): without one it would
    // refuse AFTER the burn. So without one, nothing is burnt.
    if (!proof.dleq) return { kind: 'unarmed', why: 'no_amount_proof' }
  }
  // #477: the NUT-07 check, every proof's dry-run lock and the relay check, all read-only, at once.
  // They are judged in the old order (spent first, then the lock route, then the relay), so the
  // answer is the one the sequential checks gave. gateway-customer#287: the dry runs go in one
  // batch call (one by one, side by side, on a gateway without the batch route).
  const judge = (d: Settled<GatewayAnswer>): ArmOutcome | null => {
    if (!d.ok) return { kind: 'unarmed', why: 'unreachable' }
    const dry = d.value
    if (dry.status === 429) return { kind: 'unarmed', why: 'rate_limited' }
    if (dry.status === 404 || dry.status === 405 || dry.status >= 500) return { kind: 'unarmed', why: 'lock_route_unavailable' }
    if (dry.status === 422 && refusalOf(dry) === 'FEATURE_NOT_IN_PLAN') return { kind: 'unarmed', why: 'not_in_plan' }
    if (!(dry.status === 409 && dry.body?.refusal === 'PREDECESSOR_NOT_SPENT')) {
      // #644: keep the gateway's reason, so the customer (and support) can read why.
      const detail = typeof dry.body?.refusal === 'string' ? dry.body.refusal : undefined
      return { kind: 'unarmed', why: 'lock_refused', ...(detail ? { detail } : {}) }
    }
    return null
  }
  const dryBodies = proofs.map(({ proof }) =>
    lockBody(ctx, proof, linkPub, refundPub, derivedOutputs(ctx.refundSecret, 'burn', proof.secret, proof.amount, '00'.repeat(8))),
  )
  const [states, dries, relayOn] = await Promise.all([
    ports.mint.states(mintUrl, proofs.map((p) => p.proof.secret)),
    // A dry run of every lock: the gateway checks everything but the burn before it asks the mint,
    // so "not spent yet" (409) means the route exists and would sign once the gift is burnt.
    lockAll(ports, dryBodies, false),
    relayIsOn(ports, ctx.linkSecret),
    // #477: the burn's keyset, read now (and kept a minute by the HTTP mint) so the arm does not
    // wait for it after the pre-check. A failure here is only a cold cache.
    ports.mint.activeKeysetId(mintUrl).catch(() => undefined),
  ])
  if (states.some((s) => s !== 'UNSPENT')) {
    return states.every((s) => s === 'SPENT') ? { kind: 'claimed' } : { kind: 'unarmed', why: 'unreachable' }
  }
  for (const d of dries) {
    const refusal = judge(d)
    if (refusal) return refusal
  }
  // A gift locked to its link with nothing to post its take-back is no better than today's, so
  // while the relay is off (or not deployed), links stay as they are.
  if (!relayOn) return { kind: 'unarmed', why: 'relay_unavailable' }
  return null
}

function lockBody(ctx: ArmContext, proof: TokenProof, linkPub: string, refundPub: string, burnOutputs: BlindedOutput[]) {
  const self = selfLockedBy(ctx, proof)
  const proposed = linkLockProposal({
    giftSecret: proof.secret,
    linkPub,
    refundPub,
    x: ctx.x,
    maxSats: proof.amount,
    nonce: derivedNonce(ctx.refundSecret, 'lock', proof.secret),
    ...(self ? { selfPub: xOnlyPub(self) } : {}),
  })
  return {
    predecessor_secret: proof.secret,
    proposed_secret: proposed,
    // A bearer gift: by R, whose witness the burn carries. One locked to K: by K, the only key that can burn it.
    authorization: cashlinkAuthorization(self ?? ctx.refundSecret, CASHLINK_LOCK_TAG, proof.secret, proposed),
    predecessor_proof: proofBody(proof),
    burn_outputs: burnOutputsBody(burnOutputs),
    ...predecessorDocument(proof),
  }
}

/**
 * gateway-customer#287: gathers the lock requests of a gift's proofs, which run side by side, into
 * one batch call. Each proof's steps either ask for exactly one lock (`ask`) or finish without one
 * (`leave`). The batch goes as soon as every proof that has started is waiting for its answer or
 * has finished, or (#477) once no proof has asked for {@link LOCK_BATCH_WAIT_MS}: one slow burn
 * then no longer holds back every other proof's lock, it joins the next batch on its own. A proof
 * that starts after a batch went (more proofs than run at once) joins the next one.
 */
class LockGate {
  private waiting: Array<{ body: unknown; resolve: (a: GatewayAnswer) => void; reject: (e: unknown) => void }> = []
  private active = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly ports: CashlinkPorts, private readonly waitMs = LOCK_BATCH_WAIT_MS) {}

  /** A proof's steps begin; every `enter` is followed by exactly one `ask` or `leave`. */
  enter(): void {
    this.active += 1
  }

  ask(body: unknown): Promise<GatewayAnswer> {
    const answer = new Promise<GatewayAnswer>((resolve, reject) => this.waiting.push({ body, resolve, reject }))
    this.active -= 1
    this.flushIfReady()
    // Proofs still burning: wait a little for them, but not for the slowest. Each new ask restarts
    // the wait, so proofs finishing close together still go in one call.
    if (this.waiting.length > 0) {
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.flush(), this.waitMs)
    }
    return answer
  }

  leave(): void {
    this.active -= 1
    this.flushIfReady()
  }

  private flushIfReady(): void {
    if (this.active > 0) return
    this.flush()
  }

  private flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.waiting.length === 0) return
    const batch = this.waiting
    this.waiting = []
    void lockAll(this.ports, batch.map((w) => w.body), true).then(
      (answers) => answers.forEach((a, i) => (a.ok ? batch[i].resolve(a.value) : batch[i].reject(a.error))),
      // `lockAll` never rejects; should it, no proof is left waiting for ever.
      (error: unknown) => batch.forEach((w) => w.reject(error)),
    )
  }
}

type LockStep =
  | { kind: 'locked'; proof: UnblindedProof }
  | { kind: 'gone' }
  | { kind: 'sats'; proofs: UnblindedProof[] }
  /** The mint refused the burn outright: nothing of this proof moved. */
  | { kind: 'unburnt'; why: string }

async function lockOne(
  ctx: ArmContext,
  mintUrl: string,
  proof: TokenProof,
  burnKeyset: string,
  linkPub: string,
  refundPub: string,
  /** #477: the gift's state, read for every proof of the gift in one NUT-07 call. */
  known?: ProofState,
  /** gateway-customer#287: asks for this proof's one lock, batched with the gift's other proofs. */
  askLock: (body: unknown) => Promise<GatewayAnswer> = (body) => signRoute(ctx.ports, LOCK_PATH, body),
): Promise<LockStep> {
  const { ports } = ctx
  let burnOuts = derivedOutputs(ctx.refundSecret, 'burn', proof.secret, proof.amount, burnKeyset)

  // 1. Burn, or find our earlier burn.
  const giftState = known === 'UNSPENT' || known === 'SPENT' ? known : (await ports.mint.states(mintUrl, [proof.secret]))[0]
  let burnt: UnblindedProof[]
  let freshBurn = false
  if (giftState === 'UNSPENT') {
    const burnWitness = (outs: BlindedOutput[]) => {
      const self = selfLockedBy(ctx, proof)
      // Locked to K: the mint checks K over the secret (SIG_INPUTS). Bearer: R over the swap, recorded.
      return self ? inputWitness(self, proof.secret) : sigAllWitness(ctx.refundSecret, proof.secret, proof.C, outs)
    }
    let witness = burnWitness(burnOuts)
    let done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness }], burnOuts)
    if (done.kind === 'refused' && done.answer.kind === 'inactive') {
      // The keyset recorded before the burn was archived since (a resumed run, or a rotation in
      // between): nothing was signed. The same B_ in the active keyset (rev-wallet377 M2), so a
      // later restore still finds them; the witness covers amounts and B_ only.
      burnOuts = derivedOutputs(ctx.refundSecret, 'burn', proof.secret, proof.amount, await ports.mint.activeKeysetId(mintUrl, { fresh: true }))
      witness = burnWitness(burnOuts)
      done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness }], burnOuts)
    }
    if (done.kind === 'gone') return { kind: 'gone' }
    if (done.kind === 'refused') {
      // 11002/11004: an operation on it is in flight (possibly our own burn from another tab), so
      // the next run looks again. Anything else refused outright: nothing was burnt, and the gift
      // is still the bearer gift on the link.
      const code = done.answer.kind === 'refused' ? done.answer.code : undefined
      if (code === 11002 || code === 11004) throw new Error(`the burn is pending (${code}); left for the next run`)
      return { kind: 'unburnt', why: done.answer.kind }
    }
    burnt = done.proofs
    freshBurn = done.fresh === true
  } else if (giftState === 'SPENT') {
    burnt = await restoreMine(ports.mint, mintUrl, burnOuts)
    if (burnt.length === 0) return { kind: 'gone' }
    if (burnt.length !== burnOuts.length) throw new Error('the burn is only partly signed; left for the next run')
  } else {
    throw new Error('the mint could not say whether the gift is spent')
  }

  const gift = voucherOfProof(proof)!
  const ask = { linkPub, refundPub, x: ctx.x, maxSats: proof.amount }
  const body = lockBody(ctx, proof, linkPub, refundPub, burnOuts)
  const carrierFor = (signed: string) => derivedCarrier(ctx.refundSecret, 'mint-link', proof.secret, signed, proof.amount, burnt[0].id)

  // An earlier run may already have minted it: the burn's outputs are then spent, and only the
  // lock it was minted as finds it. Never read as "refused, keep the sats": those sats are gone.
  // #477: outputs the mint signed in THIS swap were never signed before, so no earlier run can
  // have spent them: no need to ask.
  const [burnState] = freshBurn ? ['UNSPENT' as const] : await ports.mint.states(mintUrl, [burnt[0].secret])
  if (burnState === 'SPENT') {
    let signed = ctx.knownLocks?.get(proof.secret)
    if (!signed) {
      const replay = await askLock(body)
      if (replay.status === 200 && typeof replay.body?.signed_secret === 'string') signed = replay.body.signed_secret
    }
    if (signed && isTheLockAskedFor(signed, gift, ask)) {
      const mine = await restoreMine(ports.mint, mintUrl, [carrierFor(signed)])
      if (mine.length === 1) return { kind: 'locked', proof: mine[0] }
    }
    throw new Error('the gift was locked by an earlier run and is not found yet; left for the next run')
  }
  if (burnState !== 'UNSPENT') throw new Error('the mint could not say whether the burn is spent')

  // 2. The lock. Deterministic: a resend after a lost answer is the identical request, and the
  // gateway answers it with the identical lock.
  const answer = await askLock(body)
  if (answer.status === 200 && typeof answer.body?.signed_secret === 'string') {
    const signed = answer.body.signed_secret
    if (!isTheLockAskedFor(signed, gift, ask)) {
      // Never minted: an answer that is not exactly what was asked for could be anything. The
      // burn's outputs are unspent and ours, so the value is kept as sats.
      return { kind: 'sats', proofs: burnt }
    }
    await ctx.onLocked(proof.secret, signed)
    // 3. Mint the locked gift from the burn's outputs.
    const minted = await swapOrRestore(ports.mint, mintUrl, burnt, [carrierFor(signed)])
    if (minted.kind === 'proofs') return { kind: 'locked', proof: minted.proofs[0] }
    throw new Error(`the lock could not be minted (${minted.kind})`)
  }
  if (notYet(answer.status) || answer.status === 404) {
    throw new Error(`the lock is not available yet (${refusalOf(answer)})`)
  }
  // 422 after the burn: the coupon cannot be re-formed, so its value is kept as sats. Never lost.
  return { kind: 'sats', proofs: burnt }
}

/** #402: the wallet's own key, x-only, when the context carries it. */
const selfPubOf = (ctx: ArmContext): string | undefined => (ctx.selfSecret ? xOnlyPub(ctx.selfSecret) : undefined)

/** #402: the wallet's own key when this proof is locked to it alone, else undefined (a bearer gift). */
function selfLockedBy(ctx: ArmContext, proof: TokenProof): Uint8Array | undefined {
  return ctx.selfSecret && isSelfLocked(proof.secret, xOnlyPub(ctx.selfSecret)) ? ctx.selfSecret : undefined
}

/** NUT-11 SIG_INPUTS witness: K over `sha256(secret)`. */
function inputWitness(key: Uint8Array, secret: string): string {
  return JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), key))] })
}

/** The pre-signed refund swap for one locked proof, exactly as deposited and as this wallet would post it. */
export function refundSwap(refundSecret: Uint8Array, locked: TokenProof, keyset: string) {
  const outputs = derivedOutputs(refundSecret, 'refund', locked.secret, locked.amount, keyset)
  const witness = sigAllWitness(refundSecret, locked.secret, locked.C, outputs)
  return { outputs, witness }
}

/** 4. Deposit every locked proof's refund. One failure is enough for "not armed". */
async function depositAll(ports: CashlinkPorts, linkSecret: Uint8Array, refundSecret: Uint8Array, mintUrl: string, locked: TokenProof[], activeKeyset?: string): Promise<ArmOutcome> {
  let keyset: string
  try {
    keyset = activeKeyset ?? (await ports.mint.activeKeysetId(mintUrl))
  } catch {
    return { kind: 'not_armed', keyset: locked[0].id, why: 'mint keysets unreadable' }
  }
  // #477: every refund at once (each is its own idempotent deposit, keyed by the proof); the first
  // failure in the gift's order is the answer, as before. gateway-customer#288: in one batch call.
  const results = await depositMany(ports, linkSecret, refundSecret, mintUrl, locked, keyset)
  for (const r of results) {
    if (!r.ok) return { kind: 'not_armed', keyset, why: r.error instanceof Error ? r.error.message : String(r.error) }
    if (r.value.kind !== 'armed') return { kind: 'not_armed', keyset: r.value.keyset, why: r.value.why }
    keyset = r.value.keyset
  }
  return { kind: 'armed', keyset }
}

type DepositOutcome = { kind: 'armed' | 'not_armed'; keyset: string; why: string }

/** Gateways that answered the refund batch route 404/405 (older than gateway-customer#288): one call per deposit from then on. */
const noRefundBatchRoute = new WeakSet<CashlinkGateway>()

/** The `/refunds` body of one locked proof's pre-signed refund into `keyset`. */
function depositBody(refundSecret: Uint8Array, locked: TokenProof, keyset: string) {
  const { outputs, witness } = refundSwap(refundSecret, locked, keyset)
  return {
    proof: { amount: locked.amount, id: locked.id, secret: locked.secret, C: locked.C, witness },
    outputs: outputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
  }
}

/**
 * One refund batch call. The answers, one per body in order; null when this gateway has no batch
 * route (404/405). A batch not judged as a whole (5xx, 4xx, 429, a body of the wrong shape) is 502
 * for every body, which reads as "not armed", never anything worse: the lock is already made, and
 * the wallet takes the gifts back itself at `x` (or `retryDeposit` stores them on a later run).
 * An item without a numeric status is 502 too. Throws only when the gateway is unreachable.
 */
async function refundBatchOnce(ports: CashlinkPorts, linkSecret: Uint8Array, bodies: unknown[]): Promise<GatewayAnswer[] | null> {
  const answer = await ports.gateway.call('POST', REFUNDS_BATCH_PATH, { deposits: bodies }, linkKeySigner(linkSecret))
  if (answer.status === 404 || answer.status === 405) return null
  const results = answer.status === 200 && Array.isArray(answer.body?.results) ? (answer.body.results as unknown[]) : null
  if (!results || results.length !== bodies.length) {
    return bodies.map(() => ({ status: 502, body: { refusal: `BATCH_HTTP_${answer.status}` } }))
  }
  return results.map((r) => {
    const item = (r ?? {}) as { status?: unknown; refusal?: unknown; replayed?: unknown; state?: unknown }
    const status = typeof item.status === 'number' ? item.status : 502
    return {
      status,
      body: {
        ...(typeof item.refusal === 'string' ? { refusal: item.refusal } : {}),
        ...(typeof item.replayed === 'boolean' ? { replayed: item.replayed } : {}),
        ...(typeof item.state === 'string' ? { state: item.state } : {}),
      },
    }
  })
}

/** A deposit answer read exactly as {@link depositOne} reads it; 'inactive' for a 422 KEYSET_INACTIVE. */
function readDeposit(answer: GatewayAnswer, keyset: string): DepositOutcome | 'inactive' {
  if (answer.status === 201 || answer.status === 200) return { kind: 'armed', keyset, why: '' }
  if (answer.status === 422 && answer.body?.refusal === 'KEYSET_INACTIVE') return 'inactive'
  return { kind: 'not_armed', keyset, why: refusalOf(answer) }
}

/**
 * gateway-customer#288: every locked proof's refund deposit, answered as {@link depositOne} answers
 * each one, in one batch call per {@link REFUNDS_BATCH_MAX} instead of one call per proof. The
 * deposits answered KEYSET_INACTIVE are rebuilt in the freshly read active keyset and sent again,
 * once, in a second batch. A gateway without the route is asked one deposit at a time, as before,
 * and remembered. Never rejects.
 */
async function depositMany(
  ports: CashlinkPorts,
  linkSecret: Uint8Array,
  refundSecret: Uint8Array,
  mintUrl: string,
  locked: TokenProof[],
  keyset: string,
): Promise<Settled<DepositOutcome>[]> {
  const oneByOne = () => inParallel(locked.map((proof) => () => depositOne(ports, linkSecret, refundSecret, mintUrl, proof, keyset)), ARM_CONCURRENCY)
  if (noRefundBatchRoute.has(ports.gateway)) return oneByOne()
  const out: Settled<DepositOutcome>[] = new Array(locked.length)
  const ready: number[] = []
  locked.forEach((proof, n) => {
    try {
      assertNotOpenAfterLocktime(proof.secret)
      ready.push(n)
    } catch (error) {
      out[n] = { ok: false, error }
    }
  })
  const unreachable = (ks: string): Settled<DepositOutcome> => ({ ok: true, value: { kind: 'not_armed', keyset: ks, why: 'relay unreachable' } })
  for (let start = 0; start < ready.length; start += REFUNDS_BATCH_MAX) {
    const chunk = ready.slice(start, start + REFUNDS_BATCH_MAX)
    let answers: GatewayAnswer[] | null
    try {
      answers = await refundBatchOnce(ports, linkSecret, chunk.map((n) => depositBody(refundSecret, locked[n], keyset)))
    } catch {
      for (const n of chunk) out[n] = unreachable(keyset)
      continue
    }
    if (answers === null) {
      noRefundBatchRoute.add(ports.gateway)
      return oneByOne()
    }
    const inactive: number[] = []
    chunk.forEach((n, i) => {
      const read = readDeposit(answers![i], keyset)
      if (read === 'inactive') inactive.push(n)
      else out[n] = { ok: true, value: read }
    })
    if (inactive.length === 0) continue
    // gc#262 R3: our keyset was archived. Read the active one again and rebuild those outputs (the
    // same B_, a new id, the same SIG_ALL signature). Once, in one more batch.
    let fresh: string | undefined
    try {
      fresh = await ports.mint.activeKeysetId(mintUrl, { fresh: true })
    } catch {
      fresh = undefined
    }
    if (fresh === undefined || fresh === keyset) {
      for (const n of inactive) out[n] = { ok: true, value: { kind: 'not_armed', keyset, why: 'KEYSET_INACTIVE' } }
      continue
    }
    const freshKeyset = fresh
    let again: GatewayAnswer[] | null
    try {
      again = await refundBatchOnce(ports, linkSecret, inactive.map((n) => depositBody(refundSecret, locked[n], freshKeyset)))
    } catch {
      for (const n of inactive) out[n] = unreachable(freshKeyset)
      continue
    }
    if (again === null) {
      // The route vanished between two calls (a rollback): those few one at a time.
      noRefundBatchRoute.add(ports.gateway)
      const single = await inParallel(inactive.map((n) => () => depositOne(ports, linkSecret, refundSecret, mintUrl, locked[n], freshKeyset)), ARM_CONCURRENCY)
      inactive.forEach((n, i) => (out[n] = single[i]))
      continue
    }
    inactive.forEach((n, i) => {
      const read = readDeposit(again![i], freshKeyset)
      out[n] = { ok: true, value: read === 'inactive' ? { kind: 'not_armed', keyset: freshKeyset, why: 'KEYSET_INACTIVE' } : read }
    })
  }
  return out
}

async function depositOne(
  ports: CashlinkPorts,
  linkSecret: Uint8Array,
  refundSecret: Uint8Array,
  mintUrl: string,
  locked: TokenProof,
  firstKeyset: string,
): Promise<{ kind: 'armed' | 'not_armed'; keyset: string; why: string }> {
  assertNotOpenAfterLocktime(locked.secret)
  let keyset = firstKeyset
  for (let attempt = 0; attempt < 2; attempt++) {
    const { outputs, witness } = refundSwap(refundSecret, locked, keyset)
    const body = {
      proof: { amount: locked.amount, id: locked.id, secret: locked.secret, C: locked.C, witness },
      outputs: outputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
    }
    let answer: GatewayAnswer
    try {
      answer = await ports.gateway.call('POST', REFUNDS_PATH, body, linkKeySigner(linkSecret))
    } catch {
      return { kind: 'not_armed', keyset, why: 'relay unreachable' }
    }
    if (answer.status === 201 || answer.status === 200) return { kind: 'armed', keyset, why: '' }
    // gc#262 R3: our keyset was archived. Read the active one again and rebuild the outputs: the
    // same B_ (they do not depend on the keyset), a new id, the same signature (SIG_ALL does not
    // cover keyset ids). Once.
    if (answer.status === 422 && answer.body?.refusal === 'KEYSET_INACTIVE' && attempt === 0) {
      try {
        const fresh = await ports.mint.activeKeysetId(mintUrl, { fresh: true })
        if (fresh !== keyset) {
          keyset = fresh
          continue
        }
      } catch {
        // Falls through: not armed.
      }
    }
    // 503 (off, or keys unavailable), 404 (not deployed), 409 (another refund is kept), 403, 422:
    // all of them mean nothing will post this refund. Not armed; this wallet takes it back itself.
    return { kind: 'not_armed', keyset, why: refusalOf(answer) }
  }
  return { kind: 'not_armed', keyset, why: 'KEYSET_INACTIVE' }
}

/** A deposit retried on a later run, before `x`. Same derivation, so a stored one replays (200). */
export async function retryDeposit(ports: CashlinkPorts, linkSecret: Uint8Array, refundSecret: Uint8Array, lockedToken: string): Promise<ArmOutcome> {
  try {
    return await depositAll(ports, linkSecret, refundSecret, mintOf(lockedToken), tokenProofs(lockedToken))
  } catch (error) {
    return { kind: 'not_armed', keyset: '', why: error instanceof Error ? error.message : String(error) }
  }
}

// --- Coming back (the sender) -----------------------------------------------

export type ReturnOutcome =
  /** Nothing to do yet: still on the link. */
  | { kind: 'waiting' }
  /** Back in this wallet as the coupon (or, if it could not be re-formed, as its sats). */
  | { kind: 'returned' }
  /** Somebody claimed it. */
  | { kind: 'claimed' }
  /** Off the link and on its way back; the next run finishes it. */
  | { kind: 'returning'; why: string }
  /** Could not tell or could not act this time; nothing changed. */
  | { kind: 'unknown'; why: string }

export interface ReturnContext {
  ports: CashlinkPorts
  /**
   * The link key. Absent for a gift minted already locked (#410 G14): the buyer holds only the
   * refund key, so only the after-`x` refund pathway is open and `takeBackNow` is refused.
   */
  linkSecret?: Uint8Array
  refundSecret: Uint8Array
  /** No refund was ever deposited with the relay (G14): skip its fetch, the mint is the record. */
  noRelay?: boolean
  /** The locked gift on the link. */
  lockedToken: string
  /** The keyset the refund was deposited with, when it was. */
  depositKeyset?: string
  /** "Take it back" before the link expires: it goes the link key's way. */
  takeBackNow?: boolean
  /** The `sent` row that made the Cashlink: a take-back's History row links to it. */
  returnOf?: string
  /**
   * #643: a return with no link key (an expired checkout code, an unclaimed minted-locked gift) gets
   * its own incoming History row too, with this memo, linked by `returnOf` to the row it reverses.
   */
  returnMemo?: string
  /** Called before anything leaves the link, so a page that dies finishes the return on the next run. */
  onReturning(): Promise<void>
}

/** One run for a locked link (sender). Never throws. */
export async function settleLockedGift(ctx: ReturnContext): Promise<ReturnOutcome> {
  try {
    return await settle(ctx)
  } catch (error) {
    return { kind: 'unknown', why: error instanceof Error ? error.message : String(error) }
  }
}

async function settle(ctx: ReturnContext): Promise<ReturnOutcome> {
  const { ports } = ctx
  const mintUrl = mintOf(ctx.lockedToken)
  const proofs = tokenProofs(ctx.lockedToken)
  for (const p of proofs) assertNotOpenAfterLocktime(p.secret)
  const lock = readLinkLock(proofs[0].secret)
  if (!lock || lock.refundPub !== xOnlyPub(ctx.refundSecret) || (ctx.linkSecret && lock.linkPub !== linkPubOf(ctx.linkSecret))) {
    return { kind: 'unknown', why: 'not this wallet’s Cashlink' }
  }
  if (!ctx.linkSecret && ctx.takeBackNow) return { kind: 'unknown', why: 'only the refund pathway is open without the link key' }
  for (const p of proofs.slice(1)) {
    const other = readLinkLock(p.secret)
    if (!other || other.refundPub !== lock.refundPub || other.linkPub !== lock.linkPub) return { kind: 'unknown', why: 'not this wallet’s Cashlink' }
  }
  const expired = Math.floor(ports.now() / 1000) >= lock.locktime
  const states = await ports.mint.states(mintUrl, proofs.map((p) => p.secret))
  if (states.some((s) => s !== 'UNSPENT' && s !== 'SPENT')) return { kind: 'unknown', why: 'mint state unknown' }

  let returned = 0
  let claimed = 0
  let waiting = 0
  let pending = 0
  for (const [n, proof] of proofs.entries()) {
    const outcome = await settleProof(ctx, mintUrl, proof, states[n], expired)
    if (outcome === 'returned') returned += 1
    else if (outcome === 'claimed') claimed += 1
    else if (outcome === 'waiting') waiting += 1
    else pending += 1
  }
  if (pending > 0) return { kind: 'returning', why: 'part way' }
  if (waiting > 0) return returned + claimed > 0 ? { kind: 'returning', why: 'part way' } : { kind: 'waiting' }
  return returned > 0 ? { kind: 'returned' } : { kind: 'claimed' }
}

type ProofOutcome = 'returned' | 'claimed' | 'waiting' | 'pending'

async function settleProof(ctx: ReturnContext, mintUrl: string, proof: TokenProof, state: ProofState, expired: boolean): Promise<ProofOutcome> {
  const { ports } = ctx
  const refund = refundSwap(ctx.refundSecret, proof, ctx.depositKeyset ?? proof.id)
  const takeback = derivedOutputs(ctx.refundSecret, 'takeback', proof.secret, proof.amount, proof.id)

  if (state === 'SPENT') return found(ctx, mintUrl, proof, refund.outputs, takeback)
  if (!expired && !ctx.takeBackNow) return 'waiting'
  await ctx.onReturning()

  if (expired) {
    // After x: THE SAME refund the relay holds (or would have held), so whichever lands first pays
    // the same outputs. This is also how a link that was never armed, or whose arm FAILED, comes back.
    let used = refund.outputs
    let done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness: refund.witness }], refund.outputs)
    if (done.kind === 'refused' && done.answer.kind === 'inactive') {
      // The keyset was archived since (the relay's post fails the same way, code_12002).
      const fresh = refundSwap(ctx.refundSecret, proof, await ports.mint.activeKeysetId(mintUrl, { fresh: true }))
      used = fresh.outputs
      done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness: fresh.witness }], fresh.outputs)
    }
    if (done.kind === 'proofs') return reform(ctx, mintUrl, proof, done.proofs, used, 'refund')
    if (done.kind === 'gone') return found(ctx, mintUrl, proof, refund.outputs, takeback)
    // 10001 near x: the mint's clock is behind ours. Nothing was signed; the next run tries again.
    return 'pending'
  }
  // Before x ("Take it back"): the link key's way, into outputs only this wallet can unblind.
  if (!ctx.linkSecret) return 'waiting'
  const outs = derivedOutputs(ctx.refundSecret, 'takeback', proof.secret, proof.amount, await ports.mint.activeKeysetId(mintUrl))
  const done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness: sigAllWitness(ctx.linkSecret, proof.secret, proof.C, outs) }], outs)
  if (done.kind === 'proofs') return reform(ctx, mintUrl, proof, done.proofs, outs, 'link')
  if (done.kind === 'gone') return 'claimed'
  return 'pending'
}

/** The relay's signatures, if each carries a DLEQ that verifies against the mint's key. */
async function verifiedRelaySignatures(
  ports: CashlinkPorts,
  mintUrl: string,
  outputs: BlindedOutput[],
  signatures: unknown,
): Promise<{ outs: BlindedOutput[]; sigs: BlindSignatureResponse[] } | null> {
  if (!Array.isArray(signatures) || signatures.length !== outputs.length) return null
  const sigs = signatures as BlindSignatureResponse[]
  const outs = outputs.map((o, n) => ({ ...o, id: String(sigs[n]?.id ?? o.id) }))
  for (const [n, sig] of sigs.entries()) {
    const keys = await ports.mint.keys(mintUrl, outs[n].id)
    const A = keys[String(outs[n].amount)]
    if (!A || !sig?.dleq || sig.amount !== outs[n].amount) return null
    const ok = verifyDLEQProof(
      { e: hexToBytes(sig.dleq.e), s: hexToBytes(sig.dleq.s) },
      pointFromHex(outs[n].B_),
      pointFromHex(sig.C_),
      pointFromHex(A),
    )
    if (!ok) return null
  }
  return { outs, sigs }
}

/** The gift proof is spent: ours (by the relay or by us), or claimed. */
async function found(ctx: ReturnContext, mintUrl: string, proof: TokenProof, refundOutputs: BlindedOutput[], takeback: BlindedOutput[]): Promise<ProofOutcome> {
  const { ports } = ctx
  // The relay's answer first, by sha256(secret), signed by R (only R's fetch shortens its retention).
  let answer: GatewayAnswer | null = null
  if (!ctx.noRelay) {
    try {
      answer = await ports.gateway.call('GET', `${REFUNDS_PATH}/${secretHash(proof.secret)}`, undefined, linkKeySigner(ctx.refundSecret))
    } catch {
      answer = null
    }
  }
  if (answer?.status === 200 && answer.body?.state === 'REFUNDED') {
    try {
      const verified = await verifiedRelaySignatures(ports, mintUrl, refundOutputs, answer.body.signatures)
      if (verified) {
        const proofs = unblindOutputs(verified.outs, verified.sigs, await ports.mint.keys(mintUrl, verified.outs[0].id))
        await ctx.onReturning()
        return reform(ctx, mintUrl, proof, proofs, verified.outs, 'refund')
      }
    } catch {
      // An answer that does not check out is not trusted: the mint is asked below.
    }
  }
  // FAILED (any cause, incl. code_12002 and attempts_exhausted:restore_*), ALREADY_SPENT, 404, an
  // answer that did not verify, or unreachable: the mint is the record. Our refund outputs first,
  // then our take-back outputs.
  for (const [outputs, pathway] of [[refundOutputs, 'refund'], [takeback, 'link']] as const) {
    if (pathway === 'link' && !ctx.linkSecret) continue
    const mine = await restoreMine(ports.mint, mintUrl, outputs)
    if (mine.length === 0) continue
    if (mine.length !== outputs.length) return 'pending'
    await ctx.onReturning()
    return reform(ctx, mintUrl, proof, mine, outputs.map((o, n) => ({ ...o, id: mine[n].id })), pathway)
  }
  return 'claimed'
}

/**
 * The sats are this wallet's: turn them back into the coupon (unlocked, Q4) through the re-sign
 * route, authorised by the key whose spend the mint recorded. A definite refusal keeps the sats.
 */
async function reform(
  ctx: ReturnContext,
  mintUrl: string,
  locked: TokenProof,
  plain: UnblindedProof[],
  spentInto: BlindedOutput[],
  pathway: 'refund' | 'link',
): Promise<ProofOutcome> {
  const { ports } = ctx
  const purpose: DerivedPurpose = pathway === 'refund' ? 'resign-refund' : 'resign-link'
  const proposed = unlockedProposal(locked.secret, derivedNonce(ctx.refundSecret, purpose, locked.secret))
  const key = pathway === 'refund' ? ctx.refundSecret : ctx.linkSecret
  if (!key) return 'pending'
  const answer = await signRoute(ports, RESIGN_PATH, {
    predecessor_secret: locked.secret,
    proposed_secret: proposed,
    authorization: cashlinkAuthorization(key, CASHLINK_RESIGN_TAG, locked.secret, proposed),
    predecessor_proof: proofBody(locked),
    burn_outputs: burnOutputsBody(spentInto),
  })
  const lockedVoucher = voucherOfProof(locked)!
  // #384: this proof's share of the WHOLE gift, so the returned rows add up to what was sent.
  const share = faceShareOf(ctx.lockedToken, locked.secret)
  const signed = answer.body?.signed_secret
  if (answer.status === 200 && typeof signed === 'string' && isTheSuccessorAskedFor(signed, lockedVoucher)) {
    const coupon = await mintCarrier(ports, mintUrl, plain, signed, ctx.refundSecret, pathway === 'refund' ? 'mint-refund' : 'mint-link', locked)
    if (!coupon) return 'pending'
    await ports.keep({ token: tokenOf(mintUrl, [coupon]), why: 'returned', ...faceOf(share), ...takenBackOf(ctx, locked) })
    return 'returned'
  }
  if (notYet(answer.status)) return 'pending'
  // A definite refusal after the sats came back (422, or 404: the routes are gone): keep them.
  await keepAsSats(ports, mintUrl, locked, plain, 'returned', share, takenBackOf(ctx, locked))
  return 'returned'
}

/**
 * A Cashlink take-back (the link key is known: `giftLinks.settleLocked`) is told in History as an
 * incoming row, in the link's bundle (#530) so the coupons of one link fold into one entry. Other
 * returns through `settle` (code and guest gifts, no link key) keep their own records.
 */
function takenBackOf(ctx: ReturnContext, locked: TokenProof): Pick<KeptCoupon, 'bundleId' | 'takenBack' | 'returnOf' | 'returnMemo'> {
  const linkPub = ctx.linkSecret ? readLinkLock(locked.secret)?.linkPub : undefined
  if (linkPub) return { bundleId: cashlinkBundleId(linkPub), takenBack: true, ...(ctx.returnOf ? { returnOf: ctx.returnOf } : {}) }
  // #643: no link key, but the caller names the debit it reverses: its own credit row.
  return ctx.returnOf && ctx.returnMemo ? { takenBack: true, returnOf: ctx.returnOf, returnMemo: ctx.returnMemo } : {}
}

/** Mint a signed successor from plain proofs, or find it if an earlier run already did. */
async function mintCarrier(
  ports: CashlinkPorts,
  mintUrl: string,
  plain: UnblindedProof[],
  signed: string,
  key: Uint8Array,
  purpose: DerivedPurpose,
  anchor: TokenProof,
): Promise<UnblindedProof | null> {
  const amount = plain.reduce((n, p) => n + p.amount, 0)
  if (splitIntoDenominations(amount).length !== 1) throw new Error('a successor needs a single power-of-two output')
  const carrier = derivedCarrier(key, purpose, anchor.secret, signed, amount, plain[0].id)
  const [state] = await ports.mint.states(mintUrl, [plain[0].secret])
  if (state === 'SPENT') return (await restoreMine(ports.mint, mintUrl, [carrier]))[0] ?? null
  const done = await swapOrRestore(ports.mint, mintUrl, plain, [carrier])
  return done.kind === 'proofs' ? done.proofs[0] : null
}

// --- Claiming (the recipient) -----------------------------------------------

/**
 * One claim in progress, kept until the coupon is in this wallet. Holds the link secret (a bearer
 * secret of bounded value, the same class as the parked claim) and the blinding factors only this
 * wallet has. Logout stays off while any is kept (`cashlinkClaimsInFlight`).
 */
export interface CashlinkClaim {
  k: string
  /** The locked proof being claimed. */
  proof: TokenProof
  mintUrl: string
  outputs: BlindedOutput[]
  /** The successor's nonce and the carrier's blinding factor, fixed so a retry is identical. */
  nonce: string
  carrierR: string
  at: number
  /** This proof's whole share of the gift's face (#384). Absent on claims written before. */
  faceValue?: number
}

export function loadClaims(pubkey: string): CashlinkClaim[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(cashlinkClaimsKey(pubkey)) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? (parsed as CashlinkClaim[]).filter((c) => c && typeof c.k === 'string' && c.proof && typeof c.proof.secret === 'string' && Array.isArray(c.outputs))
      : []
  } catch {
    return []
  }
}

/** Throws on a full store, before the burn: a claim whose factors cannot be written is not started. */
function saveClaims(pubkey: string, claims: CashlinkClaim[]): void {
  if (claims.length === 0) localStorage.removeItem(cashlinkClaimsKey(pubkey))
  else localStorage.setItem(cashlinkClaimsKey(pubkey), JSON.stringify(claims))
}

const sameClaim = (a: CashlinkClaim, secret: string) => a.proof.secret === secret

export type ClaimOutcome =
  | { kind: 'ok' }
  | { kind: 'claimed' }
  | { kind: 'failed'; message: string }
  /** The coupon's own issuer: a stall does not open a Cashlink of its own coupon by self-swap (Q3). */
  | { kind: 'own_coupon' }

export interface ClaimContext {
  ports: CashlinkPorts
  pubkey: string
  linkSecret: Uint8Array
  k: string
  lockedTokens: GiftToken[]
}

/** The 32-byte scalar a stored hex blinding factor stands for, never zero. */
function scalarOf(hex: string): bigint {
  const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
  const v = BigInt('0x' + hex) % N
  return v === 0n ? 1n : v
}

/** Claim link-locked gift tokens into this wallet. Never throws. */
export async function claimLockedGift(ctx: ClaimContext): Promise<ClaimOutcome> {
  try {
    for (const { token } of ctx.lockedTokens) {
      const v = parseVoucherToken(token).voucher
      const stall = (/^[0-9a-f]{64}$/i.test(v.issuerId) ? v.issuerId : v.issuerPublicKey).toLowerCase()
      if (stall === ctx.pubkey.toLowerCase()) return { kind: 'own_coupon' }
    }
    let added = 0
    let gone = 0
    let failure: string | undefined
    for (const { token } of ctx.lockedTokens) {
      const mintUrl = mintOf(token)
      for (const proof of tokenProofs(token)) {
        assertNotOpenAfterLocktime(proof.secret)
        const lock = readLinkLock(proof.secret)
        if (!lock || lock.linkPub !== linkPubOf(ctx.linkSecret)) continue
        let claim = loadClaims(ctx.pubkey).find((c) => sameClaim(c, proof.secret))
        if (!claim) {
          const keyset = await ctx.ports.mint.activeKeysetId(mintUrl)
          claim = {
            k: ctx.k,
            proof,
            mintUrl,
            outputs: splitIntoDenominations(proof.amount).map((amount) => blinded(bytesToHex(randomBytes(32)), undefined, amount, keyset)),
            nonce: bytesToHex(randomBytes(32)),
            carrierR: bytesToHex(randomBytes(32)),
            at: ctx.ports.now(),
            ...faceOf(faceShareOf(token, proof.secret)),
          }
          // Written BEFORE the burn: from the burn on, these factors are the only way to the coupon.
          saveClaims(ctx.pubkey, [...loadClaims(ctx.pubkey), claim])
        }
        const result = await finishClaim(ctx.ports, ctx.pubkey, ctx.linkSecret, claim)
        if (result === 'ok') added += 1
        else if (result === 'gone') gone += 1
        else failure ??= result
      }
    }
    if (failure !== undefined) return { kind: 'failed', message: failure }
    if (added === 0 && gone > 0) return { kind: 'claimed' }
    if (added === 0) return { kind: 'failed', message: 'There was nothing on this Cashlink to add.' }
    return { kind: 'ok' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The `k` a claim of a gift locked to this wallet's OWN key carries (#410 G14, handle recipient):
 * the wallet key is never written to the ledger, it is borrowed again from the signer to finish.
 */
export const OWN_KEY_CLAIM = 'own-key'

/** Finish every claim this wallet left part way (start-up). Returns how many coupons arrived. */
export async function finishCashlinkClaims(ports: CashlinkPorts, pubkey: string, ownKey?: () => Uint8Array | null): Promise<number> {
  let done = 0
  for (const claim of loadClaims(pubkey)) {
    const secret = claim.k === OWN_KEY_CLAIM ? (ownKey?.() ?? null) : secretFromText(claim.k)
    if (!secret) continue
    try {
      if ((await finishClaim(ports, pubkey, secret, claim)) === 'ok') done += 1
    } catch {
      // Kept; the next run tries again.
    }
  }
  return done
}

const PARTLY = 'It is only partly added. Try again in a moment.'

/** 'ok', 'gone' (someone else spent it first), or a failure message (the claim is kept unless nothing moved). */
async function finishClaim(ports: CashlinkPorts, pubkey: string, linkSecret: Uint8Array, claim: CashlinkClaim): Promise<'ok' | 'gone' | string> {
  const { proof, mintUrl, outputs } = claim
  const bundleId = cashlinkBundleId(linkPubOf(linkSecret))
  const forget = () => saveClaims(pubkey, loadClaims(pubkey).filter((c) => !sameClaim(c, proof.secret)))

  // 1. Burn with the link key, or find our earlier burn.
  const [state] = await ports.mint.states(mintUrl, [proof.secret])
  let plain: UnblindedProof[]
  if (state === 'UNSPENT') {
    const done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness: sigAllWitness(linkSecret, proof.secret, proof.C, outputs) }], outputs)
    if (done.kind === 'gone') {
      forget()
      return 'gone'
    }
    if (done.kind === 'refused') {
      // Nothing was signed: nothing burnt, nothing to keep.
      forget()
      return 'It could not be added. The Cashlink may have expired.'
    }
    plain = done.proofs
  } else if (state === 'SPENT') {
    plain = await restoreMine(ports.mint, mintUrl, outputs)
    if (plain.length === 0) {
      forget()
      return 'gone'
    }
    if (plain.length !== outputs.length) return PARTLY
  } else {
    return 'We could not reach the voucher service. Try again in a moment.'
  }

  // 2. The unlocked successor, for the link pathway.
  const proposed = unlockedProposal(proof.secret, claim.nonce)
  const answer = await signRoute(ports, RESIGN_PATH, {
    predecessor_secret: proof.secret,
    proposed_secret: proposed,
    authorization: cashlinkAuthorization(linkSecret, CASHLINK_RESIGN_TAG, proof.secret, proposed),
    predecessor_proof: proofBody(proof),
    burn_outputs: burnOutputsBody(outputs),
  })
  const locked = voucherOfProof(proof)!
  const signed = answer.body?.signed_secret
  if (answer.status === 200 && typeof signed === 'string' && isTheSuccessorAskedFor(signed, locked)) {
    // 3. Mint it, with the blinding factor written down before the burn.
    const carrier = blinded(signed, scalarOf(claim.carrierR), proof.amount, plain[0].id)
    const [plainState] = await ports.mint.states(mintUrl, [plain[0].secret])
    let minted: UnblindedProof | undefined
    if (plainState === 'SPENT') minted = (await restoreMine(ports.mint, mintUrl, [carrier]))[0]
    else {
      const done = await swapOrRestore(ports.mint, mintUrl, plain, [carrier])
      minted = done.kind === 'proofs' ? done.proofs[0] : undefined
    }
    if (!minted) return PARTLY
    await ports.keep({ token: tokenOf(mintUrl, [minted]), why: 'claimed', ...faceOf(claim.faceValue), bundleId })
    forget()
    return 'ok'
  }
  if (notYet(answer.status)) return PARTLY
  // A definite refusal after the burn: the value is kept as sats, in this wallet. Never lost.
  await keepAsSats(ports, mintUrl, proof, plain, 'claimed', claim.faceValue, { bundleId })
  forget()
  return 'ok'
}

/** Claims still part way, for logout's check. Never throws: unreadable storage counts as one. */
export function cashlinkClaimsInFlight(pubkey: string): number {
  try {
    const raw = localStorage.getItem(cashlinkClaimsKey(pubkey))
    if (!raw) return 0
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.length : 1
  } catch {
    return 1
  }
}

// --- Restore (the sender's lost device) -------------------------------------

export type RestoreFinding =
  /** Still on the link, locked. Adopt it; the run retries the deposit and takes it back after `x`. */
  | { kind: 'locked'; lockedToken: string; x: number }
  /** Off the link into our outputs and not re-formed yet. Adopt it as returning. */
  | { kind: 'returning'; lockedToken: string; x: number }
  /** Our burn happened but the lock did not finish. Adopt it as arming. */
  | { kind: 'arming'; bearer: GiftToken }
  | { kind: 'none' }

/**
 * What a derived link holds, for the restore scan: a locked gift of ours still on it, our own outputs
 * signed for one (re-formed or not: a re-formed one is harmless to adopt, the re-sign replays), or a
 * burn of ours that never became a lock. Never throws.
 */
export async function restoreFinding(ports: CashlinkPorts, linkSecret: Uint8Array, refundSecret: Uint8Array, tokens: GiftToken[]): Promise<RestoreFinding> {
  try {
    const refundPub = xOnlyPub(refundSecret)
    const linkPub = linkPubOf(linkSecret)
    for (const t of tokens) {
      const proofs = safeProofs(t.token)
      const lock = proofs[0] ? readLinkLock(proofs[0].secret) : null
      if (!lock || lock.linkPub !== linkPub || lock.refundPub !== refundPub) continue
      const mintUrl = mintOf(t.token)
      const states = await ports.mint.states(mintUrl, proofs.map((p) => p.secret))
      if (states.some((s) => s === 'UNSPENT')) return { kind: 'locked', lockedToken: t.token, x: lock.locktime }
      for (const p of proofs) {
        const refund = derivedOutputs(refundSecret, 'refund', p.secret, p.amount, p.id)
        const takeback = derivedOutputs(refundSecret, 'takeback', p.secret, p.amount, p.id)
        const plain = [...(await restoreMine(ports.mint, mintUrl, refund)), ...(await restoreMine(ports.mint, mintUrl, takeback))]
        if (plain.length > 0) {
          const [plainState] = await ports.mint.states(mintUrl, [plain[0].secret])
          // Spent plain outputs mean the coupon was already re-formed into this wallet's history.
          if (plainState !== 'SPENT') return { kind: 'returning', lockedToken: t.token, x: lock.locktime }
        }
      }
    }
    for (const t of tokens) {
      const proofs = safeProofs(t.token)
      if (!proofs[0] || readLinkLock(proofs[0].secret)) continue
      const mintUrl = mintOf(t.token)
      for (const p of proofs) {
        if ('problem' in lockableVoucher(p.secret)) continue
        const burn = derivedOutputs(refundSecret, 'burn', p.secret, p.amount, p.id)
        if ((await restoreMine(ports.mint, mintUrl, burn)).length > 0) return { kind: 'arming', bearer: t }
      }
    }
    return { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}

function safeProofs(token: string): TokenProof[] {
  try {
    return tokenProofs(token)
  } catch {
    return []
  }
}

/**
 * A burn of ours whose lock never reached its link, found by a restore that has no record of the
 * link (its history entry was lost with the device). The burn's sats are this wallet's: kept as
 * sats against the gift. True when something was kept. A burn already minted into a lock is left:
 * the lock is found again only with the link's expiry, which the history entry carries.
 */
export async function recoverOrphanBurn(ports: CashlinkPorts, refundSecret: Uint8Array, bearer: GiftToken): Promise<boolean> {
  try {
    const mintUrl = mintOf(bearer.token)
    let kept = false
    for (const p of tokenProofs(bearer.token)) {
      const burn = derivedOutputs(refundSecret, 'burn', p.secret, p.amount, p.id)
      const mine = await restoreMine(ports.mint, mintUrl, burn)
      if (mine.length !== burn.length) continue
      const states = await ports.mint.states(mintUrl, mine.map((m) => m.secret))
      if (!states.every((s) => s === 'UNSPENT')) continue
      await keepAsSats(ports, mintUrl, p, mine, 'returned', faceShareOf(bearer.token, p.secret))
      kept = true
    }
    return kept
  } catch {
    return false
  }
}

/** NUT-07 for every proof of a token, at its own mint. Never throws: unknown when unreadable. */
export async function tokenStates(ports: CashlinkPorts, token: string): Promise<ProofState[]> {
  try {
    return await ports.mint.states(mintOf(token), tokenProofs(token).map((p) => p.secret))
  } catch {
    return ['UNKNOWN']
  }
}

/** The locktime of a link-locked token (its soonest proof), or null when it is not one. */
export function lockedLocktime(token: string): number | null {
  const times = safeProofs(token).map((p) => readLinkLock(p.secret)?.locktime)
  if (times.length === 0 || times.some((t) => typeof t !== 'number')) return null
  return Math.min(...(times as number[]))
}

/** The tokens on a link that are locked to it (its link key in `data`, the exact link-lock shape). */
export function lockedOnLink(tokens: GiftToken[], linkPub: string): GiftToken[] {
  return tokens.filter(({ token }) => {
    const proofs = safeProofs(token)
    return proofs.length > 0 && proofs.every((p) => readLinkLock(p.secret)?.linkPub === linkPub)
  })
}

/**
 * #402: the shared steps, for the checkout-code flow (`checkoutCodeFlow.ts`), which reuses them
 * rather than growing a second copy of the money path.
 */
export const cashlinkSteps = { mintOf, proofBody, burnOutputsBody, predecessorDocument, restoreMine, swapOrRestore, signRoute, notYet, refusalOf, tokenOf, keepAsSats, mintCarrier }

// --- The default ports ------------------------------------------------------

const MINT_TIMEOUT_MS = 30_000
const GATEWAY_TIMEOUT_MS = 15_000

async function mintFetch(url: string, init: RequestInit): Promise<Response> {
  // Only Content-Type: no redemption declaration ever (cashu-mint#540 D9). Nothing is credited.
  return fetch(url, { ...init, signal: AbortSignal.timeout(MINT_TIMEOUT_MS), credentials: 'omit', referrerPolicy: 'no-referrer' })
}

const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/**
 * #477: a keyset's keys, once per mint and keyset for the life of the page. A keyset id is derived
 * from its keys (NUT-02), so they never change under one id. Fetched 14 times for one 7-proof code
 * before this. A failed fetch is not kept, so the next call asks again.
 */
const keysCache = new Map<string, Promise<Record<string, string>>>()

/** Test seam. */
export function clearMintKeysCache(): void {
  keysCache.clear()
  activeCache.clear()
}

/**
 * #477: the active keyset, kept for a minute per mint. Rotations are rare and every caller that
 * builds outputs handles an inactive keyset (12002 / KEYSET_INACTIVE) by asking with `fresh`.
 */
const ACTIVE_KEYSET_TTL_MS = 60_000
const activeCache = new Map<string, { at: number; id: Promise<string> }>()

/**
 * #477: open the connections to the mint before the first call that has to wait for them (TLS is
 * ~0.35 s on staging), and warm the keyset. For the screen that makes a code. Never throws.
 */
export function warmMint(mintUrl: string): void {
  void httpCashlinkMint()
    .activeKeysetId(mintUrl)
    .then((id) => httpCashlinkMint().keys(mintUrl, id))
    .catch(() => undefined)
}

/** The HTTP mint the app uses. */
export function httpCashlinkMint(): CashlinkMint {
  return {
    activeKeysetId(mintUrl, opts) {
      const now = Date.now()
      const hit = activeCache.get(mintUrl)
      if (!opts?.fresh && hit && now - hit.at < ACTIVE_KEYSET_TTL_MS) return hit.id
      const id = (async () => {
        const r = await mintFetch(`${mintUrl}/v1/keysets`, { method: 'GET' })
        if (!r.ok) throw new Error(`keysets HTTP ${r.status}`)
        const { keysets } = (await r.json()) as { keysets?: { id: string; unit: string; active: boolean }[] }
        const active = keysets?.find((k) => k.active && k.unit === 'sat')
        if (!active) throw new Error('no active sat keyset')
        return active.id
      })()
      const entry = { at: now, id }
      activeCache.set(mintUrl, entry)
      id.catch(() => {
        if (activeCache.get(mintUrl) === entry) activeCache.delete(mintUrl)
      })
      return id
    },
    keys(mintUrl, keysetId) {
      const key = `${mintUrl}|${keysetId}`
      const cached = keysCache.get(key)
      if (cached) return cached
      const fetched = (async () => {
        const r = await mintFetch(`${mintUrl}/v1/keys/${keysetId}`, { method: 'GET' })
        if (!r.ok) throw new Error(`keys HTTP ${r.status}`)
        const { keysets } = (await r.json()) as { keysets?: { id: string; keys: Record<string, string> }[] }
        const k = keysets?.[0]
        if (!k || k.id !== keysetId || !k.keys) throw new Error('keys for another keyset')
        return k.keys
      })()
      keysCache.set(key, fetched)
      fetched.catch(() => {
        if (keysCache.get(key) === fetched) keysCache.delete(key)
      })
      return fetched
    },
    async swap(mintUrl, inputs, outputs) {
      const r = await mintFetch(
        `${mintUrl}/v1/swap`,
        postJson({
          inputs: inputs.map(({ amount, id, secret, C, witness }) => ({ amount, id, secret, C, ...(witness ? { witness } : {}) })),
          // Projected: a secret or blinding factor never leaves the wallet.
          outputs: outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })),
          // cashu-voucher#64: documents of by-reference inputs, only when some input is one.
          ...((v) => (v ? { vouchers: v } : {}))(referencedDocuments(inputs)),
        }),
      )
      const body = (await r.json().catch(() => null)) as { signatures?: BlindSignatureResponse[]; code?: number; detail?: string } | null
      if (r.ok && Array.isArray(body?.signatures)) return { kind: 'signed', signatures: body.signatures }
      const code = Number(body?.code)
      if (code === 11001 || code === 11003) return { kind: 'spent' }
      if (code === 12002) return { kind: 'inactive' }
      // A 5xx may have signed: thrown, so the caller leaves it for NUT-09 on the next run.
      if (r.status >= 500 || r.ok) throw new Error(`swap HTTP ${r.status}`)
      return { kind: 'refused', ...(Number.isFinite(code) ? { code } : {}), ...(body?.detail ? { detail: body.detail } : {}) }
    },
    async restore(mintUrl, outputs) {
      const r = await mintFetch(`${mintUrl}/v1/restore`, postJson({ outputs: outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })) }))
      if (!r.ok) throw new Error(`restore HTTP ${r.status}`)
      const body = (await r.json()) as { outputs?: { B_: string }[]; signatures?: BlindSignatureResponse[] }
      if (!Array.isArray(body.outputs)) throw new Error('restore without outputs')
      return { outputs: body.outputs, signatures: body.signatures ?? [] }
    },
    async states(mintUrl, secrets) {
      const Ys = secrets.map((s) => hashToCurve(new TextEncoder().encode(s)).toHex(true))
      const unknown = secrets.map((): ProofState => 'UNKNOWN')
      try {
        const r = await mintFetch(`${mintUrl}/v1/checkstate`, postJson({ Ys }))
        if (!r.ok) return unknown
        const { states } = (await r.json()) as { states?: { state?: string }[] }
        if (!Array.isArray(states) || states.length !== secrets.length) return unknown
        return states.map((s): ProofState => (s.state === 'UNSPENT' || s.state === 'SPENT' || s.state === 'PENDING' ? s.state : 'UNKNOWN'))
      } catch {
        return unknown
      }
    },
  }
}

/** The gateway, NIP-98 signed. `credentials: 'omit'` when a link or refund key signs. */
export function httpCashlinkGateway(): CashlinkGateway {
  return {
    async call(method, path, body, signer) {
      const text = body === undefined ? undefined : JSON.stringify(body)
      const authorization = signer ? await nip98Header(path, method, text, signer) : await nip98Header(path, method, text)
      const r = await fetch(path, {
        method,
        headers: { Authorization: authorization, ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: text,
        credentials: signer ? 'omit' : 'include',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      })
      const parsed = (await r.json().catch(() => null)) as Record<string, unknown> | null
      return { status: r.status, body: parsed }
    },
  }
}

/** A gift wrap of `token` to the link key, sealed by the link key itself (it names nobody). */
/**
 * The largest link wrap this wallet publishes, in bytes of event JSON. strfry refuses an event over
 * `maxEventSize` (65,536 on staging) while the gateway's cache still keeps it, so a refused wrap
 * reads as delivered. NIP-44 pads in steps and the step below 65,536 is 55,121 (gateway-customer
 * GiftWrapSizeModel), so that is the budget.
 */
export const LINK_WRAP_BUDGET = 55_121

/** Bytes of a link wrap for `token`, as it goes on the wire. */
export function linkWrapBytes(linkSecret: Uint8Array, token: string): number {
  return new TextEncoder().encode(JSON.stringify(wrapForLink(linkSecret, token, 'f'.repeat(64)))).length
}

/**
 * One voucher's locked proofs as tokens whose wraps each fit {@link LINK_WRAP_BUDGET}, measured on
 * the real wrap, halved until they fit. Each is a complete token, read on its own by the claimer
 * and the issuer (the reader takes every wrap on the link). Order is kept, so the cut is the same
 * on every run.
 */
export function fitToWraps(linkSecret: Uint8Array, mintUrl: string, proofs: UnblindedProof[]): string[] {
  const token = tokenOf(mintUrl, proofs)
  if (proofs.length <= 1 || linkWrapBytes(linkSecret, token) <= LINK_WRAP_BUDGET) return [token]
  const half = Math.ceil(proofs.length / 2)
  return [...fitToWraps(linkSecret, mintUrl, proofs.slice(0, half)), ...fitToWraps(linkSecret, mintUrl, proofs.slice(half))]
}

export function wrapForLink(linkSecret: Uint8Array, token: string, senderPubkey?: string) {
  // `sender_pubkey` is the issuer's PUBLIC key, so the claimer can send the "claimed" receipt back
  // (the same field the gateway puts on a bearer gift's wrap). Never a secret.
  const sender = senderPubkey && /^[0-9a-f]{64}$/.test(senderPubkey) ? { sender_pubkey: senderPubkey } : {}
  return nip17.wrapEvent(linkSecret, { publicKey: linkPubOf(linkSecret) }, JSON.stringify({ type: 'cashu_token_transfer', token, ...sender }))
}
