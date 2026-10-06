import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import type { WarrantVerdict } from './issuanceWarrant'

/**
 * Reads a voucher out of the token it is actually carried in, and checks the
 * issuer signed it.
 *
 * Until this module existed nothing in the wallet decoded a token at all —
 * `TokenParser` only regex-matches the `cashuB…` string out of message text.
 * Everything the UI showed about a coupon came from sibling fields on the DM
 * envelope (`dmCrypto.ts`'s `TokenTransferPayload`), which the *sender* writes:
 * `issuer_id`, `face_value`, `token_amount`. NIP-17 tells you who sent a DM. It
 * says nothing about whether their claims about the token inside it are true, so
 * a sender could declare any face value they liked against a genuine low-value
 * token and the mint would never see the discrepancy — it only ever sees proofs.
 *
 * The voucher is inside the token, signed. This reads it from there.
 *
 * Deliberately no network: a merchant at a stall with no signal must still be
 * able to tell their own coupon from someone else's, which is what makes the
 * offline cap meaningful rather than a guess.
 */

// ---------------------------------------------------------------- CBOR

const BREAK = Symbol('cbor-break')

class CborReader {
  private i = 0
  // Written out rather than a `constructor(private readonly b)` parameter
  // property: that syntax is not erasable, and the wallet API typechecks under
  // `erasableSyntaxOnly` because Node strips types rather than compiling them.
  // The service imports this file for API ticket 02, so it has to be readable
  // by both.
  private readonly b: Uint8Array
  constructor(b: Uint8Array) {
    this.b = b
  }

  private u8(): number {
    if (this.i >= this.b.length) throw new Error('cbor: truncated')
    return this.b[this.i++]
  }

  private take(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error('cbor: truncated')
    return this.b.subarray(this.i, (this.i += n))
  }

  private num(n: number): number {
    let v = 0
    for (const byte of this.take(n)) v = v * 256 + byte
    return v
  }

  /** Argument of a head byte. `null` means indefinite length. */
  private arg(ai: number): number | null {
    if (ai < 24) return ai
    if (ai === 24) return this.u8()
    if (ai === 25) return this.num(2)
    if (ai === 26) return this.num(4)
    if (ai === 27) return this.num(8)
    if (ai === 31) return null
    throw new Error(`cbor: bad additional info ${ai}`)
  }

  private float(ai: number): number {
    const bytes = this.take(ai === 25 ? 2 : ai === 26 ? 4 : 8)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (ai === 26) return dv.getFloat32(0)
    if (ai === 27) return dv.getFloat64(0)
    // float16 — not emitted by the Java encoder, decoded for completeness.
    const h = dv.getUint16(0)
    const sign = h & 0x8000 ? -1 : 1
    const exp = (h >> 10) & 0x1f
    const frac = h & 0x3ff
    if (exp === 0) return sign * 2 ** -14 * (frac / 1024)
    if (exp === 0x1f) return frac ? NaN : sign * Infinity
    return sign * 2 ** (exp - 15) * (1 + frac / 1024)
  }

  read(): unknown {
    const ib = this.u8()
    if (ib === 0xff) return BREAK
    const mt = ib >> 5
    const ai = ib & 0x1f

    if (mt === 7) {
      if (ai === 20) return false
      if (ai === 21) return true
      if (ai === 22) return null
      if (ai === 23) return undefined
      if (ai >= 25 && ai <= 27) return this.float(ai)
      return this.arg(ai)
    }

    const n = this.arg(ai)

    switch (mt) {
      case 0:
        return n
      case 1:
        return -1 - (n as number)
      case 2:
        return n === null ? this.concatIndefinite() : this.take(n).slice()
      case 3:
        return n === null
          ? this.readIndefinite().join('')
          : new TextDecoder().decode(this.take(n))
      case 4: {
        if (n === null) return this.readIndefinite()
        const out: unknown[] = []
        for (let k = 0; k < n; k++) out.push(this.read())
        return out
      }
      case 5: {
        const out: Record<string, unknown> = {}
        if (n === null) {
          for (;;) {
            const key = this.read()
            if (key === BREAK) break
            out[String(key)] = this.read()
          }
          return out
        }
        for (let k = 0; k < n; k++) out[String(this.read())] = this.read()
        return out
      }
      case 6:
        // Tagged value — the tag itself carries no meaning for this payload.
        return this.read()
      default:
        throw new Error(`cbor: unsupported major type ${mt}`)
    }
  }

  private readIndefinite(): string[] {
    const parts: string[] = []
    for (;;) {
      const v = this.read()
      if (v === BREAK) break
      parts.push(v as string)
    }
    return parts
  }

  private concatIndefinite(): Uint8Array {
    const chunks: Uint8Array[] = []
    for (;;) {
      const v = this.read()
      if (v === BREAK) break
      chunks.push(v as Uint8Array)
    }
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }
}

export function decodeCbor(bytes: Uint8Array): unknown {
  return new CborReader(bytes).read()
}

// ---------------------------------------------------------------- base64url

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- types

/** The voucher as the issuer signed it. Every field here is inside the token. */
export interface SignedVoucherFields {
  voucherId: string
  issuerId: string
  unit: string
  /**
   * The issued face value, in minor units. Signed, so this is the one hard
   * ceiling on what a redemption may credit — see `issuanceRatio`.
   */
  faceValue: number
  expiresAt?: number
  memo?: string
  backingStrategy?: string
  /**
   * Face minor units per sat.
   *
   * NOT covered by the signature on any voucher issued before the canonicalizer
   * fix: `getCanonicalBytesForSigning` truncated every number through
   * `longValue()`, so every ratio in (0,1) signed as 0 and one fractional ratio
   * is interchangeable with another. Never derive a credit ceiling from this
   * alone — bound it by `faceValue`, which is signed on every voucher.
   */
  issuanceRatio: number
  faceDecimals: number
  merchantMetadata?: string | null
  /**
   * What, outside the issuing service, authorised this issuance. Raw JSON.
   *
   * **Three states, and they are three.** `undefined` means the tag was ABSENT:
   * the coupon predates warrants and the issuer signed nothing about the
   * question. A warrant whose `form` is `none` is a different claim — the
   * issuer has SIGNED that nothing authorised this beyond itself. A reader
   * that collapses the two lets a stripped warrant read as a legacy coupon,
   * which is the downgrade the `none` form exists to prevent.
   *
   * Kept as raw JSON rather than parsed here so this type stays a faithful
   * record of the bytes. `parseIssuanceWarrant` in `issuanceWarrant.ts` turns
   * it into something with opinions.
   */
  issuanceWarrant?: string
  nonce: string
  issuerSignature: string
  issuerPublicKey: string
  /**
   * The key a spender must produce a witness signature for, hex, on a
   * `P2PK_VOUCHER`. Absent on the plain `VOUCHER` kind, which is unlocked.
   *
   * Presence of this is the ONLY honest way to tell the two apart. A plain
   * voucher that merely names a holder in its metadata is not locked: the mint
   * dispatches it to the voucher condition, never looks for a witness, and a
   * thief holding the proof can spend it (ADR 0008).
   */
  lockKey?: string
  /**
   * The canonical bytes exactly as they arrived, when the secret carried its
   * own tags.
   *
   * A `P2PK_VOUCHER` puts its voucher fields in NUT-10 TAGS on the wire, where
   * the plain kind puts them in a CBOR blob with an empty tag array. For the
   * blob form the tags must be REBUILT to check the signature; for this form
   * rebuilding them would be a guess at the issuer's tag order, and tag order is
   * hashed. Verify over what was actually signed instead.
   */
  canonicalWire?: Uint8Array
  /**
   * False when a numeric tag arrived in a form that only became canonical because
   * the canonicaliser normalised it.
   *
   * Such a voucher has two readings, one here and a different one in Java, so
   * `verifyVoucher` refuses it however good the signature is. Set only on the
   * locked kind, which is the only one whose numeric tags arrive on the wire.
   * cashu-voucher#48.
   */
  canonicalNumbers?: boolean
}

export interface ParsedVoucherToken {
  mintUrl: string
  unit: string
  memo?: string
  /** Summed proof amounts, in sats. */
  tokenAmount: number
  /**
   * The sats this token may be CREDITED for: each proof's amount, clamped to
   * its own signed `max_sats` (imani-gateway-customer#141). Never more than
   * `tokenAmount`.
   *
   * A re-signed or split voucher proof gets its sats from the swap that mints
   * it, and the mint cannot see which blinded output carries a voucher secret,
   * so a holder can fund a full-face successor with sats bought today. The
   * gateway therefore signs a `max_sats` into every successor, summing to at
   * most what was burnt, and this is where a redeemer honours it.
   *
   * Per proof, because each proof carries its own bound, and each locked proof's
   * own issuer signature is verified (a proof that does not verify under proof
   * 0's issuer key counts 0). A locked proof with no tag (pre-#141) counts its
   * whole amount, bounded by face and the ledger: the accepted legacy residual
   * (see `creditableSatsOf`). An unlocked voucher counts its whole amount, as before.
   * A proof whose tag is present but unreadable counts 0: reading it as absent
   * would let a holder downgrade a bound by mangling it.
   *
   * Optional so a hand-built `ParsedVoucherToken` keeps compiling and means
   * "no bound known", exactly as an untagged token does.
   */
  creditableSats?: number
  proofCount: number
  voucher: SignedVoucherFields
}

// ---------------------------------------------------------------- parsing

/**
 * `cashuB…` → the voucher inside it.
 *
 * TokenV4 is base64url-encoded CBOR: `{m: mintUrl, u: unit, d?: memo, t: [{i:
 * keysetId, p: [{a: amount, s: secret, c: signature}]}]}`. The NUT-10 secret `s`
 * is `["VOUCHER", <hex>, <nonce>, <tags>]` — and on the wire the tag array is
 * EMPTY, with every voucher field living in the hex blob, which is itself CBOR.
 * The tags are rebuilt from that blob before signature checking (this is what
 * `SignedVoucherCodec` does server-side), which is why `voucherCanonicalBytes`
 * has to reconstruct them rather than read them off the wire.
 */
/**
 * The voucher blob hex out of a NUT-10 secret, in either wire form.
 *
 * NUT-10 has two serialisations in the wild and this wallet meets both:
 *
 *  - `["VOUCHER", "<hex>", "<nonce>", [tags]]` — the flat four-element form.
 *  - `["VOUCHER", {nonce, data, tags}]` — the object form, which is what
 *    cashu-lib's `WellKnownSecretSerializer` actually writes today
 *    ("Writes NUT-10's second element. Key order is nonce, data, tags").
 *
 * Reading only the flat form is how the merchant's Checks section went back to
 * reading **"Not checked"** on genuinely verified coupons. `parseVoucherToken`
 * did `hexToBytes(parsed[1])` on what was an OBJECT, threw, and
 * `verifiedVoucherFrom` swallowed that as "not a voucher token" — so no
 * validation record was ever produced. Silent by construction: a plain ecash
 * token takes the same path legitimately, so nothing looked wrong.
 *
 * Returns null when the secret is not a VOUCHER secret at all, which is a real
 * and expected case (plain ecash) rather than an error.
 */
/**
 * The NUT-10 kinds that carry voucher metadata.
 *
 * Mirrors `VoucherCanonicalBytes.requireVoucherCarryingKind`. `P2PK_VOUCHER` is
 * a voucher that is ALSO P2PK-locked; it is a sibling of `VOUCHER` rather than a
 * subclass, on both sides, so every reader has to name both explicitly.
 */
const VOUCHER_KINDS = ['VOUCHER', 'P2PK_VOUCHER']

function voucherBlobHex(secret: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || !VOUCHER_KINDS.includes(parsed[0])) return null

  const second = parsed[1]
  if (typeof second === 'string') return second
  if (second && typeof second === 'object') {
    const data = (second as { data?: unknown }).data
    return typeof data === 'string' ? data : null
  }
  return null
}

/**
 * The NUT-10 secret of every proof in a TokenV4.
 *
 * Exported for the live-mint probe that checks NUT-07 does not SPEND a
 * credential when it merely reads its state. That probe needs each proof's
 * secret to compute its `Y`, and re-implementing the CBOR reader to get them
 * would mean the probe checked a different decode from the one the app uses —
 * which is precisely the substitution these probes exist to avoid.
 */
/**
 * Whether a NUT-10 secret would be read as a voucher by anything downstream.
 *
 * <h2>Why this lives here, and why it is not `JSON.parse`</h2>
 *
 * Two places need this answer: the swap refuses vouchers because it would destroy
 * them, and the token-level receive refuses them before anything is spent. They
 * had a copy each, with DIFFERENT algorithms, one a prefix match and one a JSON
 * parse. A guard implemented twice is a guard that protects two different sets.
 *
 * The algorithm must match cashu-lib's reader, and that is the subtle part. It
 * gates on `trimmed.startsWith("[") && trimmed.endsWith("]")` and then uses
 * Jackson, which stops at the first complete value and IGNORES trailing content.
 * `JSON.parse` rejects the whole string instead, so `["VOUCHER",{...}] ]` was a
 * voucher to the mint and not to the wallet. A security reviewer proved that, and
 * the consequence is the worst available: the swap succeeds, the right sats come
 * back, and the coupon's face value, warrant and issuer signature are gone with no
 * error anywhere.
 *
 * Errs towards yes. Refusing a plain token costs a fallback to the gateway
 * receive; accepting a voucher costs the coupon.
 */
export function isVoucherSecret(secret: string): boolean {
  const trimmed = secret.trim()
  // The same gate cashu-lib applies before it parses at all. A secret failing this
  // is a NUT-00 bearer string, which is genuinely not a voucher.
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false

  const parsed = leadingJsonValue(trimmed)
  if (parsed === undefined) {
    // Bracketed and unparseable. cashu-lib falls back to a bearer secret and so
    // could we, but the downside is not symmetric: if any reader anywhere sees a
    // voucher here, the swap path destroys it.
    return true
  }

  // The kind comparison is EXACT, matching cashu-lib's `Kind.valueOf`. A secret
  // whose kind is `p2pk_voucher` is not a voucher anywhere in the stack, so there
  // is no coupon to protect and normalising would make this reader accept a shape
  // the rest of the system rejects.
  return Array.isArray(parsed) && (parsed[0] === 'VOUCHER' || parsed[0] === 'P2PK_VOUCHER')
}

/**
 * The first complete JSON value in `text`, ignoring anything after it.
 *
 * What Jackson's `readValue` does and what `JSON.parse` refuses to do, which is
 * the whole reason this exists. Implemented by retrying shorter prefixes rather
 * than by writing a parser, because a hand-written one would be a third reader
 * with its own disagreements.
 */
function leadingJsonValue(text: string): unknown {
  for (let end = text.length; end > 1; end--) {
    if (text[end - 1] !== ']') continue
    try {
      return JSON.parse(text.slice(0, end)) as unknown
    } catch {
      // Not a complete value at this length; try a shorter prefix.
    }
  }
  return undefined
}

export function proofSecrets(token: string): string[] {
  return tokenProofs(token).map((p) => p.secret)
}

/** One proof, in the shape the mint's /v1/swap expects. */
export interface TokenProof {
  amount: number
  /** Keyset id, hex. */
  id: string
  /** The NUT-10 secret, verbatim. */
  secret: string
  /** The unblinded signature, hex. */
  C: string
}

/**
 * Every proof in a TokenV4, decoded with the app's own reader.
 *
 * Exported for the live-mint probes. They need whole proofs rather than just
 * secrets — presenting one for a spend is the only way to observe the mint
 * ENFORCING a lock rather than merely accepting it — and re-implementing the
 * CBOR reader would mean the probe checked a different decode from the one the
 * app uses, which is exactly the substitution these probes exist to avoid.
 */
export function tokenProofs(token: string): TokenProof[] {
  if (!token?.startsWith('cashuB')) throw new Error('not a TokenV4 (cashuB) token')
  const root = decodeCbor(base64UrlDecode(token.slice(6))) as Record<string, unknown>
  const entries = (root.t ?? []) as Array<Record<string, unknown>>

  return entries.flatMap((entry) => {
    // The keyset id lives on the ENTRY, not the proof: TokenV4 groups proofs by
    // keyset precisely so it is stored once.
    const keysetId = entry.i
    const id = keysetId instanceof Uint8Array ? bytesToHex(keysetId) : String(keysetId ?? '')

    return ((entry.p ?? []) as Array<Record<string, unknown>>).map((p) => {
      if (typeof p.s !== 'string') throw new Error('proof has no NUT-10 secret')
      const c = p.c
      return {
        amount: Number(p.a ?? 0),
        id,
        secret: p.s,
        C: c instanceof Uint8Array ? bytesToHex(c) : String(c ?? ''),
      }
    })
  })
}

export function parseVoucherToken(token: string): ParsedVoucherToken {
  if (!token?.startsWith('cashuB')) {
    throw new Error('not a TokenV4 (cashuB) token')
  }
  const root = decodeCbor(base64UrlDecode(token.slice(6))) as Record<string, unknown>

  const entries = (root.t ?? []) as Array<Record<string, unknown>>
  const proofs = entries.flatMap((e) => (e.p ?? []) as Array<Record<string, unknown>>)
  if (proofs.length === 0) throw new Error('token carries no proofs')

  const secret = proofs[0].s
  if (typeof secret !== 'string') throw new Error('proof has no NUT-10 secret')

  /**
   * The locked kind is read from its TAGS; the plain kind from its CBOR blob.
   *
   * Terminal credentials are now issued as `P2PK_VOUCHER` (ADR 0008), and this
   * function threw "token is not a voucher" on every one of them — the wallet
   * could not read a credential the gateway had just minted. The two shapes are
   * genuinely different on the wire, not merely tagged differently: the locked
   * kind's `data` field is the LOCK KEY, so there is no blob to decode.
   */
  const locked = lockedVoucherFrom(secret)
  const dataHex = locked ? null : voucherBlobHex(secret)
  if (locked === null && dataHex === null) {
    throw new Error('token is not a voucher (NUT-10 kind is not VOUCHER or P2PK_VOUCHER)')
  }

  const voucher = locked
    ? locked
    : readVoucherFields(decodeCbor(hexToBytes(dataHex!)) as Record<string, unknown>)

  // Every proof must carry the same voucher. A bundle mixing provenance would
  // otherwise be summed under one voucher's ratio, which is the shape of an
  // inflated token — the server-side ProofCompatibilityValidator rejects the
  // same case.
  //
  // Compare the voucher BLOB, not the whole secret: each proof carries its own
  // NUT-10 wrapper nonce (they have to, or two proofs would be the same proof),
  // so the secret strings of a perfectly good token never match each other. Only
  // the blob — the signed voucher — is shared.
  for (const p of proofs) {
    if (typeof p.s !== 'string') throw new Error('proof has no NUT-10 secret')
    if (locked) {
      // Locked proofs share no blob — each carries its own tags and its own
      // wrapper nonce. `voucher_id` is what identifies the voucher they came
      // from, and mixing two vouchers in one token is the inflation shape this
      // check exists to refuse, so it still has to be refused here.
      const other = lockedVoucherFrom(p.s)
      if (other === null) throw new Error('proof secret is not a NUT-10 secret')
      if (other.voucherId !== locked.voucherId) {
        throw new Error('token mixes proofs from more than one voucher')
      }
      if (other.lockKey !== locked.lockKey) {
        // Two locks in one token would mean part of it is spendable by a
        // different holder than the rest.
        throw new Error('token mixes proofs locked to more than one key')
      }
      continue
    }
    // Through the same reader as above, so a bundle whose proofs use the object
    // form is compared on its blobs rather than rejected outright.
    const otherHex = voucherBlobHex(p.s)
    if (otherHex === null) throw new Error('proof secret is not a NUT-10 secret')
    if (otherHex !== dataHex) throw new Error('token mixes proofs from more than one voucher')
  }

  return {
    mintUrl: String(root.m ?? ''),
    unit: String(root.u ?? ''),
    memo: typeof root.d === 'string' ? root.d : undefined,
    tokenAmount: proofs.reduce((sum, p) => sum + Number(p.a ?? 0), 0),
    creditableSats: proofs.reduce(
      (sum, p) => sum + creditableSatsOf(Number(p.a ?? 0), String(p.s), voucher),
      0,
    ),
    proofCount: proofs.length,
    voucher,
  }
}

/** The `max_sats` tag key (imani-gateway-customer#141). */
export const MAX_SATS_TAG = 'max_sats'

/**
 * The one spelling of a `max_sats` value: a positive decimal, no sign, no
 * leading zero, no exponent, at most 16 digits.
 *
 * The tag is NOT one of the canonicaliser's numeric tags, so it is hashed as
 * the string it is, and `"1"` and `"01"` are different signed bytes. Accepting
 * only this form, exactly as the gateway's `SatBound` does, means the Java and
 * TS readers can never read one signed bound as two numbers (cashu-voucher#48).
 */
const CANONICAL_MAX_SATS = /^[1-9][0-9]{0,15}$/

/** What a proof's secret says about its sat bound. */
export type SatBound =
  | { kind: 'absent' }
  | { kind: 'present'; sats: number }
  | { kind: 'malformed' }

/**
 * Reads a proof secret's `max_sats` tag.
 *
 * Only the locked kind carries tags on the wire. An unlocked `VOUCHER` keeps
 * its fields in a CBOR blob with an empty tag array, and the gateway never
 * signs a bound into one, so it reads as absent.
 */
export function satBoundOf(secret: string): SatBound {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    return { kind: 'absent' }
  }
  if (!Array.isArray(parsed) || parsed[0] !== 'P2PK_VOUCHER') return { kind: 'absent' }
  const tags = (parsed[1] as { tags?: unknown } | undefined)?.tags
  if (!Array.isArray(tags)) return { kind: 'absent' }
  const rows = tags.filter((t): t is unknown[] => Array.isArray(t) && t[0] === MAX_SATS_TAG)
  if (rows.length === 0) return { kind: 'absent' }
  // Two bounds, or one bound with two values, are two claims. Neither is trusted.
  if (rows.length > 1 || rows[0].length !== 2 || typeof rows[0][1] !== 'string') {
    return { kind: 'malformed' }
  }
  const wire = rows[0][1]
  return CANONICAL_MAX_SATS.test(wire)
    ? { kind: 'present', sats: Number(wire) }
    : { kind: 'malformed' }
}

/**
 * One proof's creditable sats (imani-gateway-customer#141).
 *
 * - An unlocked `VOUCHER` proof: its amount. Every proof of the token was
 *   already required to carry proof 0's exact signed blob, so proof 0's
 *   signature covers it. The blob is shared by every output, so it cannot carry
 *   a per-output bound: that is the known residual, bounded by the face value
 *   and the shared ledger.
 * - A locked `P2PK_VOUCHER` proof: 0 unless its OWN issuer signature verifies
 *   under proof 0's issuer key. Callers verify proof 0 only, so a self-made later
 *   proof with the same voucher_id and lock (forged, or signed by some other
 *   key) would otherwise be credited in full.
 * - A verified locked proof with a canonical `max_sats`: `min(amount, max_sats)`.
 * - A verified locked proof with NO `max_sats` (pre-#141): its amount, the
 *   pre-#141 rule, bounded with the rest by the face value and the shared ledger.
 *   Its funded amount is signed nowhere, and the mint signs any blinded output,
 *   so its sats may be a same-secret twin's: that is the ACCEPTED LEGACY
 *   RESIDUAL. Crediting 0 instead stranded every locked voucher sold before
 *   #141 (round 4 count on staging: a handful, 2 known, each bounded by its
 *   own signed face). Every locked output issued since #141 carries a bound
 *   from birth, so only pre-#141 locked vouchers read as untagged.
 * - A malformed `max_sats`: 0. Reading it as absent would be a downgrade.
 */
function creditableSatsOf(amount: number, secret: string, first: SignedVoucherFields): number {
  const locked = lockedVoucherFrom(secret)
  if (locked === null) return amount
  if (
    locked.issuerPublicKey.toLowerCase() !== first.issuerPublicKey.toLowerCase() ||
    !verifyVoucher(locked).signatureValid
  ) {
    return 0
  }
  const bound = satBoundOf(secret)
  if (bound.kind === 'absent') return amount
  if (bound.kind === 'malformed') return 0
  return Math.min(amount, bound.sats)
}

/**
 * The sats to credit: the token's amount, clamped to its per-proof bounds.
 *
 * `min` rather than `creditableSats` alone, so a caller that overrides
 * `tokenAmount` with a smaller figure (`signedPartOf` in `pay.ts` does) still
 * gets the smaller one.
 */
function creditedSats(parsed: ParsedVoucherToken): number {
  return Math.min(parsed.tokenAmount, parsed.creditableSats ?? parsed.tokenAmount)
}

/**
 * A `P2PK_VOUCHER` secret → the voucher inside it, or null for any other kind.
 *
 * The locked kind's NUT-10 second element is `{nonce, data, tags}` where `data`
 * is the 33-byte compressed LOCK KEY and every voucher field is a tag. That is
 * the mint's own layout: the P2PK condition needs `data` to be the spending key
 * it checks a witness against, so the voucher metadata had nowhere to go but
 * the tags.
 *
 * Captures `canonicalWire` while it is here. The tags are rendered back to the
 * exact string the issuer signed, in the order they ARRIVED — reconstructing a
 * plausible order would be a guess, and these bytes are hashed, so a guess that
 * is one tag out of order fails every signature on a perfectly good voucher.
 */
function lockedVoucherFrom(secret: string): SignedVoucherFields | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed[0] !== 'P2PK_VOUCHER') return null

  const body = parsed[1]
  if (!body || typeof body !== 'object') return null
  const { nonce, data, tags } = body as { nonce?: unknown; data?: unknown; tags?: unknown }
  if (typeof data !== 'string' || !Array.isArray(tags)) return null

  const rows = tags.filter((t): t is unknown[] => Array.isArray(t) && typeof t[0] === 'string')
  const tag = (k: string): string | undefined => {
    const row = rows.find((r) => r[0] === k)
    return row && row[1] != null ? String(row[1]) : undefined
  }
  const required = (k: string): string => {
    const v = tag(k)
    if (!v) throw new Error(`locked voucher is missing ${k}`)
    return v
  }
  const num = (k: string, fallback: number): number => {
    const v = tag(k)
    return v == null ? fallback : Number(v)
  }

  return {
    voucherId: required('voucher_id'),
    issuerId: required('issuer'),
    unit: required('unit'),
    faceValue: num('face_value', 0),
    expiresAt: tag('expires_at') == null ? undefined : Number(tag('expires_at')),
    memo: tag('memo'),
    backingStrategy: tag('backing_strategy'),
    issuanceRatio: num('issuance_ratio', 1),
    faceDecimals: num('face_decimals', 0),
    merchantMetadata: tag('merchant_metadata') ?? null,
    issuanceWarrant: tag('issuance_warrant'),
    nonce: typeof nonce === 'string' ? nonce : '',
    issuerSignature: required('issuer_sig'),
    issuerPublicKey: required('issuer_pubkey'),
    lockKey: data,
    canonicalWire: lockedCanonicalBytes(data, typeof nonce === 'string' ? nonce : '', rows),
    canonicalNumbers: hasCanonicalNumericTags(rows),
  }
}

/**
 * The signed bytes of a locked voucher, rebuilt from the tags AS THEY ARRIVED.
 *
 * Mirrors `VoucherCanonicalBytes.of`: `[kind,"data","nonce",[tags…]]`, dropping
 * `issuer_sig` and `issuer_pubkey` (set after signing, so they cannot be under
 * the signature), rendering the four numeric tags bare and everything else
 * quoted.
 */
export function lockedCanonicalBytes(dataHex: string, nonce: string, rows: unknown[][]): Uint8Array {
  const NUMERIC = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
  const AFTER_SIGNING = ['issuer_sig', 'issuer_pubkey']

  const rendered = rows
    .filter((r) => !AFTER_SIGNING.includes(String(r[0])))
    .map((r) => {
      const key = String(r[0])
      const values = r.slice(1).map((v) => {
        const raw = String(v)
        // Integral values render as longs, exactly as the Java does, so 1.0 and
        // 1 produce identical bytes rather than two valid forms.
        if (NUMERIC.includes(key)) return appendNumber(Number(raw), false)
        return `"${escapeJson(raw)}"`
      })
      return `["${escapeJson(key)}"${values.map((v) => ',' + v).join('')}]`
    })

  return new TextEncoder().encode(
    `["P2PK_VOUCHER","${dataHex}","${nonce}",[${rendered.join(',')}]]`,
  )
}

/**
 * Is every numeric tag already written the way the canonicaliser would write it?
 *
 * Normalising before hashing is necessary, so the two implementations agree on the
 * bytes. The side effect is that `"1000"`, `"01000"`, `"1000.0"` and `"1e3"` all
 * hash identically, and therefore all satisfy one signature.
 *
 * That would be harmless if every reader agreed on the value, and they do not.
 * `Number("1000.0")` here gives 1000, while Java's `Long.parseLong` REFUSES it and
 * yields no face value at all. One signed voucher, two readings, and the holder
 * picks. Dropping the Java face-value clamp is what that buys.
 *
 * So a voucher whose bytes only became canonical BECAUSE we normalised them is
 * refused. Mirrors `VoucherCanonicalBytes.hasCanonicalNumericTags` on the Java
 * side, and the two must stay in step. cashu-voucher#48.
 */
export function hasCanonicalNumericTags(rows: unknown[][]): boolean {
  const NUMERIC = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
  return rows.every((row) => {
    if (!NUMERIC.includes(String(row[0]))) return true
    return row.slice(1).every((value) => {
      const wire = String(value)
      const parsed = Number(wire)
      if (!Number.isFinite(parsed)) return false
      return appendNumber(parsed, false) === wire
    })
  })
}

function readVoucherFields(blob: Record<string, unknown>): SignedVoucherFields {
  const str = (k: string): string | undefined => {
    const v = blob[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const required = (k: string): string => {
    const v = str(k)
    if (!v) throw new Error(`voucher blob is missing ${k}`)
    return v
  }
  return {
    voucherId: required('voucherId'),
    issuerId: required('issuerId'),
    unit: required('unit'),
    faceValue: Number(blob.faceValue ?? 0),
    expiresAt: blob.expiresAt == null ? undefined : Number(blob.expiresAt),
    memo: str('memo'),
    backingStrategy: str('backingStrategy'),
    issuanceRatio: blob.issuanceRatio == null ? 1 : Number(blob.issuanceRatio),
    faceDecimals: Number(blob.faceDecimals ?? 0),
    merchantMetadata: str('merchantMetadata') ?? null,
    // `str` returns undefined for a missing or empty value, which is exactly
    // the absent state. Do NOT coalesce to null here: `?? null` would make
    // absent and signed-`none` indistinguishable downstream.
    issuanceWarrant: str('issuanceWarrant'),
    nonce: required('nonce'),
    issuerSignature: required('issuerSignature'),
    issuerPublicKey: required('issuerPublicKey'),
  }
}

// ---------------------------------------------------------------- canonical bytes

/**
 * Java's `Double.toString`, which is what the signer appended.
 *
 * JS and Java agree on the DIGITS on JDK 19+ — both emit the shortest decimal
 * that round-trips — but not on when to use scientific notation, and the
 * canonical bytes are hashed, so one character is a rejected voucher:
 *
 *   0.0009  →  Java "9.0E-4"    JS "0.0009"
 *   1.5e-7  →  Java "1.5E-7"    JS "1.5e-7"
 *
 * Java uses plain decimal only on [1e-3, 1e7) and `E` notation outside it, with
 * an unsigned positive exponent and always a digit after the point.
 *
 * Only ever called for finite non-integral values — integral doubles take the
 * `longValue()` path in the caller, matching the Java.
 */
export function javaDoubleToString(d: number): string {
  const abs = Math.abs(d)
  if (abs >= 1e-3 && abs < 1e7) return String(d)

  const [mantissa, exp] = d.toExponential().split('e')
  const digits = mantissa.includes('.') ? mantissa : `${mantissa}.0`
  // Java writes E7, not E+7; negative exponents keep their sign.
  return `${digits}E${exp.startsWith('+') ? exp.slice(1) : exp}`
}

function escapeJson(input: string): string {
  let out = ''
  for (const c of input) {
    const code = c.codePointAt(0)!
    if (c === '"') out += '\\"'
    else if (c === '\\') out += '\\\\'
    else if (c === '\b') out += '\\b'
    else if (c === '\f') out += '\\f'
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += c
  }
  return out
}

function appendNumber(n: number, legacy: boolean): string {
  // Matches VoucherSignatureService.appendNumber. `legacy` reproduces the
  // pre-fix truncation, which put every number through longValue().
  if (legacy) return String(Math.trunc(n))
  if (Number.isFinite(n) && !Number.isInteger(n)) return javaDoubleToString(n)
  return String(Math.trunc(n))
}

/**
 * Rebuilds the bytes the issuer signed.
 *
 * `["VOUCHER", hex(voucherId utf8), nonce, [tags…]]` — the data field is the
 * voucher UUID (`VoucherSecret` sets it from `voucherId.toString()`), the nonce
 * is the one INSIDE the blob rather than the NUT-10 wrapper's, and the tags come
 * in `VoucherSecret.Builder.build()` insertion order. `issuer_sig` and
 * `issuer_pubkey` are excluded — they are set after signing.
 *
 * Tag order is load-bearing: these bytes are hashed, so reordering two tags
 * fails every signature.
 */
export function voucherCanonicalBytes(v: SignedVoucherFields, legacy = false): Uint8Array {
  const tags: string[] = []
  const strTag = (k: string, value: string) => tags.push(`["${k}","${escapeJson(value)}"]`)
  const numTag = (k: string, value: number) => tags.push(`["${k}",${appendNumber(value, legacy)}]`)

  strTag('issuer', v.issuerId)
  strTag('unit', v.unit)
  numTag('face_value', v.faceValue)
  if (v.expiresAt != null) numTag('expires_at', v.expiresAt)
  if (v.memo != null) strTag('memo', v.memo)
  numTag('face_decimals', v.faceDecimals)
  if (v.backingStrategy != null) strTag('backing_strategy', v.backingStrategy)
  // setIssuanceRatio writes no tag at all when the ratio is exactly 1.0, so a
  // parity voucher must not emit one either.
  if (v.issuanceRatio !== 1) numTag('issuance_ratio', v.issuanceRatio)
  // Order matches `VoucherSecret.Builder.build()`, which calls
  // `setIssuanceWarrant` after `setIssuanceRatio` and `setMerchantMetadata`
  // LAST — after the signature tags, which are excluded here. So the warrant
  // sits between the ratio and the metadata, and this is not cosmetic: these
  // bytes are hashed, so swapping these two lines fails every signature on
  // every warranted coupon.
  if (v.issuanceWarrant != null) strTag('issuance_warrant', v.issuanceWarrant)
  if (v.merchantMetadata != null) strTag('merchant_metadata', v.merchantMetadata)

  const dataHex = bytesToHex(new TextEncoder().encode(v.voucherId))
  return new TextEncoder().encode(`["VOUCHER","${dataHex}","${v.nonce}",[${tags.join(',')}]]`)
}

// ---------------------------------------------------------------- verification

export interface VoucherVerification {
  signatureValid: boolean
  /**
   * True when the signature only checked out against the pre-fix canonical form,
   * in which `issuance_ratio` was truncated to 0 and so is unsigned. The voucher
   * is genuine; its ratio is not attested. Credit must be bounded by `faceValue`.
   */
  legacyCanonical: boolean
}

/**
 * What was actually checked about a coupon, recorded on the row so the merchant
 * can be shown it rather than asked to trust a bare tick.
 *
 * Absent on rows written before this existed — which must read as "not checked",
 * never as "verified".
 */
export interface VoucherValidation {
  /**
   * The issuer's signature verified over the canonical bytes.
   *
   * **Read this as "internally consistent", NOT as "issued by someone I
   * trust".** The signature is checked against `issuerPublicKey`, which is
   * carried INSIDE the voucher being checked — so whoever signed it also chose
   * the key it is verified against. A wholly self-issued voucher at any face
   * value sets this to `true`, and so does one naming a real stall in
   * `issuerId` while signed by somebody else entirely.
   *
   * What it does establish, and it is not nothing: the bytes have not been
   * altered since they were signed. Every field on this record is therefore the
   * issuer's own claim rather than a sender-written one, which is the whole
   * reason `dmCrypto` prefers the voucher over the DM envelope.
   *
   * What stands behind it is the MINT, which signs proofs only for keysets it
   * holds, and the `(mint, issuer)` allowlist of ADR 0006. A self-issued
   * voucher has no valid mint signature and fails at the swap. Offline, there
   * is no such backstop — see `src/lib/__tests__/auditSoundnessLimits.test.ts`,
   * which pins this so the limit cannot be forgotten, and Finding 2 of
   * `docs/research/audit-double-spend-inflation-review.md`.
   *
   * So: necessary for trusting any other field here, and never sufficient on
   * its own for a claim about value. `attestRedemption` requires it before
   * signing a public record, and `refuseIfAnotherStalls` supplies the part it
   * cannot — that the coupon is a claim on THIS stall.
   */
  signatureValid: boolean
  /** Signed before the canonicalizer fix, so `issuance_ratio` is not attested. */
  legacyCanonical: boolean
  /** The signed, authoritative issued face value in minor units. */
  signedFaceValue: number
  /** True when the derived value exceeded the signed face and was clamped down. */
  cappedAtFaceValue: boolean
  /**
   * What, outside the issuing service, authorised this issuance.
   *
   * Distinct from `signatureValid` and that distinction is the point.
   * `signatureValid` says the bytes are internally consistent - whoever signed
   * also chose the key it is checked against - so it is necessary and never
   * sufficient for a claim about who issued this. THIS field is the part that
   * reaches outside the issuing service.
   *
   * `'verified'` is the only value meaning a key outside the issuing service
   * attested this. `'claimed'` is a processor reference nobody checked here.
   * `'absent'` and `'unwarranted'` are two different silences and must stay
   * two. `'failed'` is a present warrant that was refused.
   *
   * Undefined on rows written before warrants existed, which reads the same as
   * `'absent'` - and neither may ever read as verified.
   */
  warrant?: WarrantVerdict['verdict']
  /**
   * The amount the warrant authorises, in minor units, when there is one.
   *
   * NOT the coupon's own value, and the gap between them is the finding. A
   * warrant covers a SALE and a sale splits, so on any part this is LARGER
   * than what the coupon is worth. UI must render this as the issued figure
   * and never as the coupon's balance - see
   * `__tests__/warrantSplitBinding.test.ts`.
   */
  warrantedSaleTotal?: number
}

/**
 * The value to credit for a token, and the evidence behind it.
 *
 * `currentFace = sats * issuanceRatio` is how a partially-spent voucher
 * reports what is left, but the ratio is unsigned on legacy vouchers, so it is
 * clamped to the signed face value. That clamp is the only bound that holds
 * against a rewritten ratio, and it needs no network.
 *
 * `sats` is each proof's amount clamped to its signed `max_sats`
 * (`creditableSats`, imani-gateway-customer#141), so a re-signed proof funded
 * with more sats than were burnt for it is credited for the burn and no more.
 * A token with no `max_sats` is credited exactly as before.
 */
export function creditableFaceValue(parsed: ParsedVoucherToken): {
  faceValue: number
  cappedAtFaceValue: boolean
} {
  const { voucher } = parsed
  const derived = Math.round(creditedSats(parsed) * voucher.issuanceRatio)
  if (voucher.faceValue > 0 && derived > voucher.faceValue) {
    return { faceValue: voucher.faceValue, cappedAtFaceValue: true }
  }
  return { faceValue: derived, cappedAtFaceValue: false }
}

/**
 * This token's value in face minor units BEFORE rounding, clamped like
 * `creditableFaceValue` to the signed face.
 *
 * What the redemption ledger books against, via `cumulativeCredit` in
 * `@imani/redemption`: rounding each part on its own lets an attacker who
 * splits a voucher into many tiny parts collect half a unit per part, so the
 * ledger rounds the running total instead.
 */
export function exactFaceValue(parsed: ParsedVoucherToken): number {
  const { voucher } = parsed
  const exact = creditedSats(parsed) * voucher.issuanceRatio
  if (voucher.faceValue > 0 && exact > voucher.faceValue) return voucher.faceValue
  return exact
}

/**
 * Checks the issuer's BIP-340 signature over the canonical bytes.
 *
 * Tries the current form first and falls back to the pre-fix truncated one, the
 * same two-step `VoucherSignatureService.verify` does, because vouchers issued
 * before the fix are live and cannot be re-signed — the issuer's key is not here.
 */
export function verifyVoucher(v: SignedVoucherFields): VoucherVerification {
  try {
    const sig = hexToBytes(v.issuerSignature)
    const pub = hexToBytes(v.issuerPublicKey)
    if (sig.length !== 64 || pub.length !== 32) {
      return { signatureValid: false, legacyCanonical: false }
    }
    // A locked voucher is verified over the bytes that ARRIVED, because its
    // tags are on the wire and their order is part of what was hashed.
    if (v.canonicalWire) {
      // And its numbers must have arrived in canonical form. A signature over
      // normalised bytes says nothing about which of several readings was meant,
      // and this reader and the Java one disagree about exactly those forms. See
      // `hasCanonicalNumericTags`.
      if (v.canonicalNumbers === false) {
        return { signatureValid: false, legacyCanonical: false }
      }
      return {
        signatureValid: schnorr.verify(sig, sha256(v.canonicalWire), pub),
        legacyCanonical: false,
      }
    }
    if (schnorr.verify(sig, sha256(voucherCanonicalBytes(v, false)), pub)) {
      return { signatureValid: true, legacyCanonical: false }
    }
    // The legacy form truncates every number, but only `issuance_ratio` was ever fractional on a
    // genuine pre-fix voucher. A fraction in face_value, expires_at or face_decimals is a rewrite
    // chosen to truncate back to the signed integer (expires_at 1000 -> 1000.5, which Java's
    // Long.parseLong then reads as no expiry at all), so it gets no legacy window (#194, mirroring
    // cashu-voucher#54's `integralTagsAreIntegers`).
    const integral = [v.faceValue, v.expiresAt, v.faceDecimals].every(
      (n) => n === undefined || Number.isInteger(n),
    )
    if (integral && schnorr.verify(sig, sha256(voucherCanonicalBytes(v, true)), pub)) {
      return { signatureValid: true, legacyCanonical: true }
    }
    return { signatureValid: false, legacyCanonical: false }
  } catch {
    // Malformed hex, bad point, truncated blob — all of it is "not verified".
    return { signatureValid: false, legacyCanonical: false }
  }
}
