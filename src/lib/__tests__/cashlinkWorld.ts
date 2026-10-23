/**
 * A Cashlink test world (#295 phase 4): a mint that really signs, and a gateway that implements the
 * lock, re-sign and refund-relay rules, in memory.
 *
 * Written from the RULES, not from the wallet's code, so a wallet that builds the wrong message or
 * the wrong shape fails here as it would against the real services:
 *
 * - The mint signs with real keys (one per power of two) and returns NUT-12 DLEQs. It enforces
 *   NUT-11 on `P2PK_VOUCHER` inputs: before the locktime only the `data` key over the `SIG_ALL`
 *   message `secret || C || amount_0 || B__0 || ...`; after it, `data` OR the refund key; a locktime
 *   with no refund key would be anyone-can-spend (the hazard, pinned by cashu-mint#566). It refuses
 *   archived output keysets (12002), records the witness for NUT-07, and answers NUT-09.
 * - The gateway's lock route checks the exact link-lock shape and that the burn's recorded witness is
 *   by R over the burn outputs (gc#255). Its re-sign route lets only the key that spent the gift ask
 *   (the "spend decides" rule). Its relay checks R's SIG_ALL witness over the deposited outputs,
 *   refuses while off (503), and posts the stored swap at `x + 60 s` when told to run.
 *
 * Issuer signatures are made with a fixed key over the same canonical bytes the wallet verifies.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { hashToCurve, pointFromHex } from '@cashu/crypto/modules/common'
import { createDLEQProof } from '@cashu/crypto/modules/mint/NUT12'

import {
  CASHLINK_LOCK_TAG,
  CASHLINK_RESIGN_TAG,
  cashlinkDigest,
  isOpenAfterLocktime,
  readLinkLock,
  secretHash,
  sigAllMessage,
} from '../cashlinkLock'
import type { CashlinkGateway, CashlinkMint, CashlinkPorts, GatewayAnswer, KeptCoupon, SwapAnswer } from '../cashlinkFlow'
import type { ProofState } from '../giftLink'
import type { RequestSigner } from '../nip98'
import { lockedCanonicalBytes, voucherCanonicalBytes, voucherOfSecret, type SignedVoucherFields, type TokenProof } from '../voucherToken'
import { encodePlainTokenV4 } from '../plainToken'
import type { BlindSignatureResponse, BlindedOutput, UnblindedProof } from '../walletSwap'

export const MINT_URL = 'http://mint.test'
export const ISSUER_KEY = hexToBytes('a1'.repeat(32))
export const ISSUER_PUB = bytesToHex(schnorr.getPublicKey(ISSUER_KEY))
export const STALL = 'b2'.repeat(32)

const utf8 = (s: string) => new TextEncoder().encode(s)
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
/** The generator, as @cashu/crypto's own point type (it bundles its own curve). */
const G = (() => {
  const P = hashToCurve(utf8('g')).constructor as unknown as { BASE: ReturnType<typeof hashToCurve> }
  return P.BASE
})()

// --- The mint -----------------------------------------------------------------

interface Keyset {
  id: string
  active: boolean
  priv: Record<string, bigint>
  pub: Record<string, string>
}

function makeKeyset(id: string, seed: number): Keyset {
  const priv: Record<string, bigint> = {}
  const pub: Record<string, string> = {}
  for (let k = 0; k < 20; k++) {
    const amount = String(2 ** k)
    const scalar = (BigInt(seed) * 1_000_003n + BigInt(k + 1) * 7919n) % N
    priv[amount] = scalar
    pub[amount] = G.multiply(scalar).toHex(true)
  }
  return { id, active: true, priv, pub }
}

export interface MintLog {
  swaps: Array<{ inputs: Array<TokenProof & { witness?: string }>; outputs: BlindedOutput[]; answer: SwapAnswer['kind'] }>
}

export class FakeMint implements CashlinkMint {
  keysets: Keyset[] = [makeKeyset('00aa000000000001', 1)]
  spent = new Map<string, { witness?: string }>()
  signed = new Map<string, BlindSignatureResponse>()
  now = 0
  log: MintLog = { swaps: [] }
  /** Make the next calls fail as an unreachable mint would. */
  down = false
  /** 10001 refunds until this time (a mint clock behind ours). */
  clockBehindUntil = 0
  /** Answer the next swap with a lost reply after signing (the response never arrives). */
  loseNextReply = false

  active(): Keyset {
    return this.keysets.find((k) => k.active)!
  }

  rotate(): Keyset {
    for (const k of this.keysets) k.active = false
    const next = makeKeyset(`00aa00000000000${this.keysets.length + 1}`, this.keysets.length + 1)
    this.keysets.push(next)
    return next
  }

  private keyset(id: string) {
    return this.keysets.find((k) => k.id === id)
  }

  private sign(output: { amount: number; id: string; B_: string }): BlindSignatureResponse {
    const ks = this.keyset(output.id)!
    const a = ks.priv[String(output.amount)]
    const B = pointFromHex(output.B_)
    const C_ = B.multiply(a)
    const dleq = createDLEQProof(B, hexToBytes(a.toString(16).padStart(64, '0')))
    return { id: output.id, amount: output.amount, C_: C_.toHex(true), dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) } }
  }

  /** Mint a fresh proof outright, as an issuance would (with a DLEQ and its r). */
  issue(secret: string, amount: number): UnblindedProof {
    const ks = this.active()
    const r = 12345n + BigInt(this.signed.size)
    const Y = hashToCurve(utf8(secret))
    const B = Y.add(G.multiply(r))
    const sig = this.sign({ amount, id: ks.id, B_: B.toHex(true) })
    const A = pointFromHex(ks.pub[String(amount)])
    const C = pointFromHex(sig.C_).subtract(A.multiply(r))
    return { amount, id: ks.id, secret, C: C.toHex(true), dleq: { e: sig.dleq!.e, s: sig.dleq!.s, r: r.toString(16).padStart(64, '0') } }
  }

  private verifyInput(p: TokenProof & { witness?: string }, outputs: BlindedOutput[]): boolean {
    const ks = this.keyset(p.id)
    if (!ks) return false
    const a = ks.priv[String(p.amount)]
    if (!hashToCurve(utf8(p.secret)).multiply(a).equals(pointFromHex(p.C))) return false
    if (!p.secret.startsWith('["P2PK')) return true
    if (isOpenAfterLocktime(p.secret)) return true // The hazard: anyone. The wallet must never make one.
    const lock = readLinkLock(p.secret)
    if (!lock) return false
    const digest = sha256(utf8(sigAllMessage(p.secret, p.C, outputs)))
    let sigs: string[] = []
    try {
      sigs = (JSON.parse(p.witness ?? '{}') as { signatures?: string[] }).signatures ?? []
    } catch {
      return false
    }
    const by = (pub: string) => sigs.some((s) => {
      try {
        return schnorr.verify(hexToBytes(s), digest, hexToBytes(pub))
      } catch {
        return false
      }
    })
    if (by(lock.linkPub)) return true
    return this.now > lock.locktime && this.now >= this.clockBehindUntil && by(lock.refundPub)
  }

  async activeKeysetId(): Promise<string> {
    if (this.down) throw new Error('mint unreachable')
    return this.active().id
  }

  async keys(_m: string, id: string): Promise<Record<string, string>> {
    if (this.down) throw new Error('mint unreachable')
    const ks = this.keyset(id)
    if (!ks) throw new Error('no such keyset')
    return ks.pub
  }

  async swap(_m: string, inputs: Array<TokenProof & { witness?: string }>, outputs: BlindedOutput[]): Promise<SwapAnswer> {
    if (this.down) throw new Error('mint unreachable')
    let answer: SwapAnswer
    const Ys = inputs.map((i) => hashToCurve(utf8(i.secret)).toHex(true))
    if (outputs.some((o) => this.signed.has(o.B_.toLowerCase()))) answer = { kind: 'spent' }
    else if (Ys.some((y) => this.spent.has(y))) answer = { kind: 'spent' }
    else if (outputs.some((o) => !this.keyset(o.id)?.active)) answer = { kind: 'inactive' }
    else if (inputs.reduce((n, i) => n + i.amount, 0) !== outputs.reduce((n, o) => n + o.amount, 0)) answer = { kind: 'refused', code: 11005 }
    else if (!inputs.every((i) => this.verifyInput(i, outputs))) answer = { kind: 'refused', code: 10001 }
    else {
      inputs.forEach((i, n) => this.spent.set(Ys[n], { witness: i.witness }))
      const signatures = outputs.map((o) => {
        const s = this.sign(o)
        this.signed.set(o.B_.toLowerCase(), s)
        return s
      })
      answer = { kind: 'signed', signatures }
      if (this.loseNextReply) {
        this.loseNextReply = false
        this.log.swaps.push({ inputs, outputs, answer: 'signed' })
        throw new Error('the reply was lost')
      }
    }
    this.log.swaps.push({ inputs, outputs, answer: answer.kind })
    return answer
  }

  async restore(_m: string, outputs: BlindedOutput[]) {
    if (this.down) throw new Error('mint unreachable')
    const hit = outputs.filter((o) => this.signed.has(o.B_.toLowerCase()))
    return { outputs: hit.map((o) => ({ B_: o.B_ })), signatures: hit.map((o) => this.signed.get(o.B_.toLowerCase())!) }
  }

  async states(_m: string, secrets: string[]): Promise<ProofState[]> {
    if (this.down) return secrets.map(() => 'UNKNOWN')
    return secrets.map((s) => (this.spent.has(hashToCurve(utf8(s)).toHex(true)) ? 'SPENT' : 'UNSPENT'))
  }

  witnessOf(secret: string): string | undefined {
    return this.spent.get(hashToCurve(utf8(secret)).toHex(true))?.witness
  }
}

// --- Vouchers -----------------------------------------------------------------

export const COUPON = {
  voucherId: '1d4410af-70f5-4c14-8606-519404684ea7',
  issuerId: STALL,
  unit: 'GBP',
  faceValue: 1000,
  faceDecimals: 2,
  backingStrategy: 'FIXED',
  issuanceRatio: 0.125,
}

function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 0x100 ? [(major << 5) | 24, n] : n < 0x10000 ? [(major << 5) | 25, n >> 8, n & 0xff] : [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  if (typeof v === 'string') {
    const b = utf8(v)
    return new Uint8Array([...head(3, b.length), ...b])
  }
  if (typeof v === 'number' && Number.isInteger(v)) return new Uint8Array(head(0, v))
  if (typeof v === 'number') {
    const buf = new Uint8Array(9)
    buf[0] = (7 << 5) | 27
    new DataView(buf.buffer).setFloat64(1, v)
    return buf
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  const parts = entries.flatMap(([k, x]) => [...cbor(k), ...cbor(x)])
  return new Uint8Array([...head(5, entries.length), ...parts])
}

/** A bearer gift proof secret, signed by the issuer, in the blob form a gift has today. */
export function bearerSecret(overrides: Partial<SignedVoucherFields> = {}, wrapperNonce = 'w0'): string {
  const unsigned: SignedVoucherFields = {
    ...COUPON,
    expiresAt: 1_900_000_000,
    nonce: 'n'.repeat(8),
    issuerSignature: '',
    issuerPublicKey: ISSUER_PUB,
    merchantMetadata: null,
    ...overrides,
  } as SignedVoucherFields
  const sig = bytesToHex(schnorr.sign(sha256(voucherCanonicalBytes(unsigned)), ISSUER_KEY, new Uint8Array(32)))
  const blob = cbor({
    voucherId: unsigned.voucherId,
    issuerId: unsigned.issuerId,
    unit: unsigned.unit,
    faceValue: unsigned.faceValue,
    expiresAt: unsigned.expiresAt,
    faceDecimals: unsigned.faceDecimals,
    backingStrategy: unsigned.backingStrategy,
    issuanceRatio: unsigned.issuanceRatio,
    nonce: unsigned.nonce,
    issuerSignature: sig,
    issuerPublicKey: unsigned.issuerPublicKey,
  })
  return JSON.stringify(['VOUCHER', { nonce: wrapperNonce, data: bytesToHex(blob), tags: [] }])
}

/** The issuer's signature on a locked (tag-form) proposal, as the gateway would add it. */
export function signLocked(proposal: string): string {
  const [kind, body] = JSON.parse(proposal) as [string, { nonce: string; data: string; tags: string[][] }]
  const canonical = lockedCanonicalBytes(body.data, body.nonce, body.tags)
  const sig = bytesToHex(schnorr.sign(sha256(canonical), ISSUER_KEY, new Uint8Array(32)))
  return JSON.stringify([kind, { ...body, tags: [...body.tags, ['issuer_sig', sig], ['issuer_pubkey', ISSUER_PUB]] }])
}

/** The issuer's signature on an unlocked (tag-form) proposal, returned in blob form. */
export function signUnlocked(proposal: string): string {
  const [, body] = JSON.parse(proposal) as [string, { nonce: string; data: string; tags: string[][] }]
  const tag = (k: string) => body.tags.find((t) => t[0] === k)?.[1]
  const voucherId = new TextDecoder().decode(hexToBytes(body.data))
  const fields: SignedVoucherFields = {
    voucherId,
    issuerId: tag('issuer')!,
    unit: tag('unit')!,
    faceValue: Number(tag('face_value')),
    ...(tag('expires_at') ? { expiresAt: Number(tag('expires_at')) } : {}),
    ...(tag('memo') ? { memo: tag('memo') } : {}),
    faceDecimals: Number(tag('face_decimals') ?? 0),
    backingStrategy: tag('backing_strategy'),
    issuanceRatio: Number(tag('issuance_ratio') ?? 1),
    nonce: body.nonce,
    issuerSignature: '',
    issuerPublicKey: ISSUER_PUB,
    merchantMetadata: null,
  }
  const sig = bytesToHex(schnorr.sign(sha256(voucherCanonicalBytes(fields)), ISSUER_KEY, new Uint8Array(32)))
  const blob = cbor({
    voucherId,
    issuerId: fields.issuerId,
    unit: fields.unit,
    faceValue: fields.faceValue,
    expiresAt: fields.expiresAt,
    faceDecimals: fields.faceDecimals,
    backingStrategy: fields.backingStrategy,
    issuanceRatio: fields.issuanceRatio,
    nonce: fields.nonce,
    issuerSignature: sig,
    issuerPublicKey: ISSUER_PUB,
  })
  return JSON.stringify(['VOUCHER', { nonce: body.nonce, data: bytesToHex(blob), tags: [] }])
}

export const tokenOf = (proofs: UnblindedProof[]) => encodePlainTokenV4(MINT_URL, 'sat', proofs)

// --- The gateway --------------------------------------------------------------

export interface Deposit {
  secret: string
  swap: { proof: TokenProof & { witness: string }; outputs: BlindedOutput[] }
  locktime: number
  state: 'PENDING' | 'REFUNDED' | 'ALREADY_SPENT' | 'FAILED'
  signatures?: BlindSignatureResponse[]
  linkPub: string
  refundPub: string
}

export class FakeGateway implements CashlinkGateway {
  routes = true
  relayOn = true
  /** Make every call throw, as an unreachable gateway would. */
  down = false
  deposits = new Map<string, Deposit>()
  locks = new Map<string, { proposed: string; signed: string }>()
  resigns = new Map<string, { proposed: string; caller: string; signed: string }>()
  calls: Array<{ method: string; path: string; body: unknown; signedBy?: string }> = []
  /** Answer the lock with something other than what was asked (a hostile or broken gateway). */
  tamperLock?: (signed: string) => string
  /** Override the answer to one path, once. */
  override = new Map<string, GatewayAnswer>()
  /** Deposit refusals to return, in order. */
  depositAnswers: GatewayAnswer[] = []
  /** What the relay fetch answers, when set (otherwise the stored deposit's state). */
  fetchAnswer?: GatewayAnswer

  constructor(readonly mint: FakeMint) {}

  async call(method: 'GET' | 'POST', path: string, body: unknown, signer?: RequestSigner): Promise<GatewayAnswer> {
    if (this.down) throw new Error('gateway unreachable')
    let signedBy: string | undefined
    if (signer) {
      const ev = (await signer.signEvent({ kind: 27235, created_at: 0, tags: [], content: '' })) as { pubkey: string }
      signedBy = ev.pubkey
    }
    this.calls.push({ method, path, body, signedBy })
    const forced = this.override.get(path)
    if (forced) {
      this.override.delete(path)
      return forced
    }
    if (path.endsWith('/vouchers/cashlink/lock')) return this.routes ? this.lock(body as LockBody) : { status: 404, body: null }
    if (path.endsWith('/vouchers/cashlink/resign')) return this.routes ? this.resign(body as LockBody) : { status: 404, body: null }
    if (path.endsWith('/cashlink/refunds') && method === 'POST') return this.deposit(body as DepositBody, signedBy)
    if (path.includes('/cashlink/refunds/') && method === 'GET') return this.fetch(path.split('/').pop()!, signedBy)
    return { status: 404, body: null }
  }

  private lock(b: LockBody): GatewayAnswer {
    const lock = readLinkLock(b.proposed_secret)
    if (isOpenAfterLocktime(b.proposed_secret)) return refused(422, 'LOCKTIME_WITHOUT_REFUND')
    if (!lock) return refused(422, 'NOT_A_LINK_LOCK')
    const ok = schnorr.verify(hexToBytes(b.authorization), cashlinkDigest(CASHLINK_LOCK_TAG, b.predecessor_secret, b.proposed_secret), hexToBytes(lock.refundPub))
    if (!ok) return refused(422, 'NOT_AUTHORISED')
    if (!b.predecessor_proof?.dleq) return refused(422, 'PREDECESSOR_AMOUNT_UNPROVEN')
    const prior = this.locks.get(b.predecessor_secret)
    if (prior) return prior.proposed === b.proposed_secret ? { status: 200, body: { signed_secret: prior.signed } } : refused(422, 'PREDECESSOR_ALREADY_CLAIMED')
    const witness = this.mint.witnessOf(b.predecessor_secret)
    if (witness === undefined && !this.mint.spent.has(hashToCurve(utf8(b.predecessor_secret)).toHex(true))) return refused(409, 'PREDECESSOR_NOT_SPENT')
    if (!witnessBy(witness, lock.refundPub, sigAllMessage(b.predecessor_secret, b.predecessor_proof.C, b.burn_outputs))) return refused(422, 'SPEND_NOT_ATTRIBUTABLE')
    let signed = signLocked(b.proposed_secret)
    if (this.tamperLock) signed = this.tamperLock(signed)
    this.locks.set(b.predecessor_secret, { proposed: b.proposed_secret, signed })
    return { status: 200, body: { signed_secret: signed } }
  }

  private resign(b: LockBody): GatewayAnswer {
    const lock = readLinkLock(b.predecessor_secret)
    if (!lock) return refused(422, 'WRONG_PREDECESSOR')
    const digest = cashlinkDigest(CASHLINK_RESIGN_TAG, b.predecessor_secret, b.proposed_secret)
    const byLink = safeVerify(b.authorization, digest, lock.linkPub)
    const byRefund = safeVerify(b.authorization, digest, lock.refundPub)
    if (!byLink && !byRefund) return refused(422, 'NOT_AUTHORISED')
    const issuer = voucherOfSecret(b.predecessor_secret)?.issuerId
    if (issuer && this.callerIsIssuer?.(issuer)) return refused(422, 'ISSUER_SELF_SWAP')
    const witness = this.mint.witnessOf(b.predecessor_secret)
    if (witness === undefined) return refused(409, 'PREDECESSOR_NOT_SPENT')
    const msg = sigAllMessage(b.predecessor_secret, b.predecessor_proof.C, b.burn_outputs)
    const spentByLink = witnessBy(witness, lock.linkPub, msg)
    const spentByRefund = witnessBy(witness, lock.refundPub, msg)
    if (spentByLink === spentByRefund) return refused(422, 'SPEND_NOT_ATTRIBUTABLE')
    if ((spentByLink && !byLink) || (spentByRefund && !byRefund)) return refused(422, 'NOT_AUTHORISED')
    const caller = spentByLink ? 'link' : 'refund'
    const prior = this.resigns.get(b.predecessor_secret)
    if (prior) {
      if (prior.caller !== caller) return refused(422, 'CLAIMED_BY_ANOTHER_CALLER')
      return prior.proposed === b.proposed_secret ? { status: 200, body: { signed_secret: prior.signed } } : refused(422, 'PREDECESSOR_ALREADY_CLAIMED')
    }
    const signed = signUnlocked(b.proposed_secret)
    this.resigns.set(b.predecessor_secret, { proposed: b.proposed_secret, caller, signed })
    return { status: 200, body: { signed_secret: signed } }
  }

  callerIsIssuer?: (issuer: string) => boolean

  private deposit(b: DepositBody, signedBy?: string): GatewayAnswer {
    if (!this.relayOn) return refused(503, 'RELAY_DISABLED')
    const queued = this.depositAnswers.shift()
    if (queued) return queued
    if (!b?.proof?.secret) return refused(422, 'MALFORMED')
    const lock = readLinkLock(b.proof.secret)
    if (isOpenAfterLocktime(b.proof.secret)) return refused(422, 'LOCKTIME_WITHOUT_REFUND')
    if (!lock) return refused(422, 'NOT_A_LINK_LOCK')
    if (signedBy !== lock.linkPub) return refused(403, 'NOT_SIGNED_BY_LINK_KEY')
    if (b.outputs.some((o) => !this.mint.keysets.find((k) => k.id === o.id)?.active)) return refused(422, 'KEYSET_INACTIVE')
    const msg = sigAllMessage(b.proof.secret, b.proof.C, b.outputs)
    if (witnessBy(b.proof.witness, lock.linkPub, msg)) return refused(422, 'WITNESS_BY_LINK_KEY')
    if (!witnessBy(b.proof.witness, lock.refundPub, msg)) return refused(422, 'WITNESS_NOT_BY_REFUND_KEY')
    const hash = secretHash(b.proof.secret)
    const prior = this.deposits.get(hash)
    const swap = { proof: b.proof, outputs: b.outputs as BlindedOutput[] }
    if (prior) return JSON.stringify(prior.swap) === JSON.stringify(swap) ? { status: 200, body: { state: 'PENDING', replayed: true } } : refused(409, 'CONFLICT')
    this.deposits.set(hash, { secret: b.proof.secret, swap, locktime: lock.locktime, state: 'PENDING', linkPub: lock.linkPub, refundPub: lock.refundPub })
    return { status: 201, body: { state: 'PENDING', replayed: false } }
  }

  private fetch(hash: string, signedBy?: string): GatewayAnswer {
    if (this.fetchAnswer) return this.fetchAnswer
    const d = this.deposits.get(hash)
    if (!d || (signedBy !== d.linkPub && signedBy !== d.refundPub)) return { status: 404, body: null }
    return { status: 200, body: { state: d.state, ...(d.signatures ? { signatures: d.signatures } : {}) } }
  }

  /** The relay's scheduler, at `now`: posts every due deposit, as gc#262 does. */
  async runRelay(now: number): Promise<void> {
    for (const d of this.deposits.values()) {
      if (d.state !== 'PENDING' || now < d.locktime + 60) continue
      const answer = await this.mint.swap(MINT_URL, [d.swap.proof], d.swap.outputs)
      if (answer.kind === 'signed') {
        d.state = 'REFUNDED'
        d.signatures = answer.signatures
      } else if (answer.kind === 'spent') {
        const mine = await this.mint.restore(MINT_URL, d.swap.outputs)
        if (mine.signatures.length === d.swap.outputs.length) {
          d.state = 'REFUNDED'
          d.signatures = mine.signatures
        } else d.state = 'ALREADY_SPENT'
      } else d.state = 'FAILED'
    }
  }
}

interface LockBody {
  predecessor_secret: string
  proposed_secret: string
  authorization: string
  predecessor_proof: { amount: number; id: string; C: string; dleq?: { e: string; s: string; r: string } }
  burn_outputs: Array<{ amount: number; B_: string }>
}

interface DepositBody {
  proof: TokenProof & { witness: string }
  outputs: Array<{ amount: number; id: string; B_: string }>
}

const refused = (status: number, refusal: string): GatewayAnswer => ({ status, body: { refusal } })

function safeVerify(sigHex: string, digest: Uint8Array, xOnly: string): boolean {
  try {
    return schnorr.verify(hexToBytes(sigHex), digest, hexToBytes(xOnly))
  } catch {
    return false
  }
}

function witnessBy(witness: string | undefined, xOnly: string, message: string): boolean {
  if (!witness) return false
  try {
    const sigs = (JSON.parse(witness) as { signatures?: string[] }).signatures ?? []
    const digest = sha256(utf8(message))
    return sigs.some((s) => safeVerify(s, digest, xOnly))
  } catch {
    return false
  }
}

// --- Ports --------------------------------------------------------------------

export interface World {
  mint: FakeMint
  gateway: FakeGateway
  kept: KeptCoupon[]
  wraps: string[]
  ports: CashlinkPorts
  clock: { now: number }
}

export function world(nowS = 1_800_000_000): World {
  const mint = new FakeMint()
  mint.now = nowS
  const gateway = new FakeGateway(mint)
  const kept: KeptCoupon[] = []
  const wraps: string[] = []
  const clock = { now: nowS }
  const ports: CashlinkPorts = {
    mint,
    gateway,
    deliver: async (_s, token) => {
      wraps.push(token)
      return true
    },
    keep: async (row) => {
      kept.push(row)
    },
    sleep: async () => {},
    now: () => clock.now * 1000,
  }
  return { mint, gateway, kept, wraps, ports, clock }
}

/** Move both clocks. */
export function at(w: World, nowS: number): void {
  w.clock.now = nowS
  w.mint.now = nowS
}
