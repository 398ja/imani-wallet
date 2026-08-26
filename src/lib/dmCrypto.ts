import { nip17, nip44 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  extractToken as extractTokenFromText,
  parseTokenTransferMessage as parseTextMessage,
} from '@imani/dm-poll'
import type { CryptoAdapter, GiftWrapEvent, UnwrappedDm, TokenMetadata } from '@imani/dm-poll'

import { getSigner } from './nap'
import {
  creditableFaceValue,
  parseVoucherToken,
  verifyVoucher,
  type ParsedVoucherToken,
  type VoucherValidation,
} from './voucherToken'

/**
 * The JSON payload the gateway actually sends.
 *
 * Captured from a live delivery, not inferred. Note it is snake_case —
 * `PayloadBuilder.DmPayload`, the sender-side type in @imani/voucher-send, is
 * camelCase (`faceValue`, `issuerId`). They are NOT the same shape, and reading
 * a received DM with the sender's type yields undefined for every field that
 * matters, including the issuer the merchant list groups by.
 */
interface TokenTransferPayload {
  type: 'cashu_token_transfer'
  version?: string
  token: string
  memo?: string | null
  amount_hint?: number
  unit?: string
  voucher_id?: string
  face_value?: number
  face_unit?: string
  face_decimals?: number
  token_amount?: number
  backing_strategy?: string
  issuer_id?: string
  sender_pubkey?: string
  /** Unix epoch SECONDS. Absent or null when the issuer set no expiry. */
  expires_at?: number | null
  expired?: boolean
  /**
   * Correlation, both forwarded end to end and both dropped here until now.
   *
   * `request_id` is the NUT-18V payment request the sender was paying, and
   * `bundle_id` groups the parts of one multi-voucher send. Verified along the
   * whole chain rather than assumed: gateway-core's `Nip17DmSendPublisher`
   * puts `payment_request_id` and `bundle_*` in the body it POSTs to
   * customer-wallet, `WalletInternalController.sendTokenDm` extracts every one
   * of them onto `SendTokenDmRequest`, and `TokenTransferMessage` serialises
   * them as `request_id` / `bundle_id` / `bundle_total` / `bundle_part_index`
   * / `bundle_part_count` in the rumor this parses.
   *
   * Without them a merchant's till cannot tell that two arriving coupons are
   * one €7 payment for one request, and settles neither.
   *
   * Only these two are read. The other three are derivable from the rows the
   * till already has — summing the parts of a bundle answers "how much
   * arrived" without trusting a count the sender chose.
   */
  request_id?: string | null
  bundle_id?: string | null
}

/**
 * Fields that are real but are not on dm-poll's published `TokenMetadata`, so
 * they ride an intersection rather than the interface.
 *
 * Dropping `expiresAt` here is what once left every DM-received coupon with a
 * null expiry: `/inspect` is the only other source tokenRedemption will take one
 * from, and it 404s on this deployment, so the DM payload was the sole one that
 * arrived. `requestId` and `bundleId` are absent from the interface for the same
 * reason.
 */
function ride(payload: TokenTransferPayload) {
  return {
    expiresAt: payload.expires_at ?? undefined,
    requestId: payload.request_id ?? undefined,
    bundleId: payload.bundle_id ?? undefined,
  }
}

/** A voucher token whose issuer signature did not check out. */
const REJECTED = Symbol('voucher-signature-invalid')

/**
 * Reads the signed voucher out of a token, if it is one and if it is genuine.
 *
 * Three outcomes, and the middle one is the point:
 *
 * - `undefined` — not a voucher token (plain ecash, or unparseable). There are no
 *   issuer claims to check, and this must keep flowing: a customer receiving
 *   ordinary Cashu is not doing anything wrong.
 * - `REJECTED` — it IS a voucher and the signature failed. Not a degraded case to
 *   carry forward with a warning flag: the only way to produce one is to alter a
 *   voucher after the issuer signed it. Refuse the message.
 * - the voucher — genuine, with what was checked and the value it may be credited
 *   for.
 */
function verifiedVoucherFrom(token: string | undefined):
  | { parsed: ParsedVoucherToken; validation: { faceValue: number; record: VoucherValidation } }
  | typeof REJECTED
  | undefined {
  if (!token) return undefined

  let parsed: ParsedVoucherToken
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return undefined
  }

  const { signatureValid, legacyCanonical } = verifyVoucher(parsed.voucher)
  if (!signatureValid) {
    console.warn(
      '[dmCrypto] rejecting voucher with invalid issuer signature:',
      parsed.voucher.voucherId,
      'claimed issuer',
      parsed.voucher.issuerId.slice(0, 16),
    )
    return REJECTED
  }

  const { faceValue, cappedAtFaceValue } = creditableFaceValue(parsed)
  if (cappedAtFaceValue) {
    // Reached when tokenAmount * ratio exceeds what was issued, which on a
    // legacy voucher is what a rewritten ratio looks like.
    console.warn(
      '[dmCrypto] voucher value clamped to signed face value:',
      parsed.voucher.voucherId,
    )
  }

  return {
    parsed,
    validation: {
      faceValue,
      record: {
        signatureValid,
        legacyCanonical,
        signedFaceValue: parsed.voucher.faceValue,
        cappedAtFaceValue,
      },
    },
  }
}

function asPayload(content: string): TokenTransferPayload | null {
  try {
    const parsed = JSON.parse(content) as TokenTransferPayload
    return parsed?.type === 'cashu_token_transfer' && typeof parsed.token === 'string'
      ? parsed
      : null
  } catch {
    return null // Not JSON — a legacy text DM.
  }
}

/**
 * dm-poll's CryptoAdapter, backed by the wallet's own key.
 *
 * Two deviations from imani-apps' vanilla adapter, both forced and both narrow:
 *
 * 1. `parseTokenTransferMessage` handles the JSON `cashu_token_transfer`
 *    envelope first. dm-poll's own TokenParser only regex-parses the legacy
 *    human-readable form ("🎁 Token Transfer: 1.00 USD"), and the gateway's
 *    TokenDmTransferAdapter emits JSON. Text falls through to the package's
 *    parser unchanged, so legacy DMs keep working.
 *
 * 2. `getTokenFingerprint` is content-derived (sha256(token)[0:32]) to match
 *    wallet-storage's token_id rule (spec 017), so a coupon delivered twice
 *    collapses onto one row instead of duplicating.
 */
export function createDmCryptoAdapter(): CryptoAdapter {
  return {
    /**
     * The `recipientPrivkey` argument is deliberately ignored — the key comes
     * from the signer, per unwrap.
     *
     * `DmPollService` stores whatever key it was constructed with as a plain
     * STRING on its config and passes that here. Strings are immutable, so the
     * signer's `clearKey()` — which zeroes its own bytes and drops its
     * reference — cannot reach that copy. Handing the poller a key therefore
     * left a full plaintext copy of it alive for the lifetime of the service,
     * and the poller went on decrypting gift wraps while the wallet was
     * "locked". signer.ts states the opposite as its contract: "Between lock and
     * reunlock there is no key in memory to steal" (RFC §28.6). Reading it here
     * makes the signer the only holder, so eviction actually evicts.
     */
    async unwrapNip17Dm(event: GiftWrapEvent): Promise<UnwrappedDm | null> {
      // Outside the try below: a locked wallet is TRANSIENT and must not be
      // mistaken for a malformed wrap. Throwing lets dm-poll record the real
      // reason and retry after its cooldown; the event is not consumed, because
      // `eventTracker.add` only runs on the success paths.
      const privkey = getSigner().privkeyHex()

      try {
        console.log('[dmCrypto] unwrapping', event.id.slice(0, 8))
        const rumor = nip17.unwrapEvent(event as never, hexToBytes(privkey))
        console.log('[dmCrypto] unwrapped ok, content bytes:', rumor.content.length)
        return {
          eventId: event.id,
          senderPubkey: rumor.pubkey,
          content: rumor.content,
          createdAt: rumor.created_at,
        }
      } catch (e) {
        console.log('[dmCrypto] unwrap threw:', e instanceof Error ? e.message : String(e))
        // A wrap we cannot open is not addressed to us, or is malformed. Null
        // rather than a throw so one bad event does not stall the poll — and it
        // is not lost either: dm-poll tracks it as failed and retries it after a
        // cooldown, since only the success paths mark an event processed.
        return null
      }
    },

    parseTokenTransferMessage(content: string): TokenMetadata | null {
      const payload = asPayload(content)
      if (!payload) return parseTextMessage(content)

      const metadata: TokenMetadata = {
        memo: payload.memo ?? undefined,
        faceValue: payload.face_value,
        faceUnit: payload.face_unit,
        faceDecimals: payload.face_decimals,
        tokenAmount: payload.token_amount ?? payload.amount_hint,
        backingStrategy: payload.backing_strategy as TokenMetadata['backingStrategy'],
        issuerId: payload.issuer_id,
        voucherId: payload.voucher_id,
      }

      // Everything above came off the envelope, which the SENDER writes. The
      // gift wrap authenticates who sent it and nothing about what they claim,
      // and the mint never sees these fields — it checks proofs. So a genuine
      // low-value token could be announced at any face value at all.
      //
      // The voucher is inside the token, signed. Prefer it, for every field it
      // covers. `signed` stays undefined for plain (non-voucher) ecash, which
      // has no issuer claims to check and must keep flowing.
      const signed = verifiedVoucherFrom(payload.token)
      if (signed === REJECTED) return null
      if (!signed) return { ...metadata, ...ride(payload) } as TokenMetadata

      const { parsed, validation } = signed
      const v = parsed.voucher
      return {
        ...metadata,
        faceValue: validation.faceValue,
        faceUnit: v.unit,
        faceDecimals: v.faceDecimals,
        tokenAmount: parsed.tokenAmount,
        backingStrategy: v.backingStrategy as TokenMetadata['backingStrategy'],
        issuerId: v.issuerId,
        voucherId: v.voucherId,
        memo: v.memo ?? metadata.memo,
        ...ride(payload),
        // The signed expiry outranks the envelope's.
        expiresAt: v.expiresAt ?? payload.expires_at ?? undefined,
        validation: validation.record,
      } as TokenMetadata
    },

    /**
     * Also the refusal gate, because `parseTokenTransferMessage` alone is not one.
     *
     * GiftWrapProcessor reads the token FIRST and then folds a null metadata away
     * as "no metadata" (`parseTokenTransferMessage(...) ?? {}`), so REJECTED above
     * changed nothing: a voucher whose issuer signature failed was still swapped
     * at the mint and saved — with an EMPTY envelope, which also made
     * `refuseIfOverRedeemed` skip it for want of a `validation`. Returning null
     * here is what makes the rejection real: no token, so `process` drops the wrap
     * (classified `non_token_dm` — marked processed, never retried).
     *
     * This is the one receive path, so it holds for a coupon arriving from a
     * merchant and for one arriving from another customer alike.
     */
    extractToken(content: string): string | null {
      const payload = asPayload(content)
      if (!payload) return extractTokenFromText(content)
      return verifiedVoucherFrom(payload.token) === REJECTED ? null : payload.token
    },

    getTokenFingerprint(token: string): string {
      return bytesToHex(sha256(new TextEncoder().encode(token))).slice(0, 32)
    },
  }
}

/**
 * The same wire-shape gap, in the other direction.
 *
 * `parseTokenTransferMessage` above must return camelCase because that is
 * dm-poll's published `TokenMetadata`. imani-apps' tokenRedemption — which
 * dm-poll hands that metadata straight to — reads snake_case:
 * `metadata.issuer_id`, `.face_value`, `.face_unit`, `.face_decimals`,
 * `.token_amount`, `.backing_strategy`, `.memo`, `.sender_pubkey`. Every one of
 * them was silently undefined, and nothing threw: the coupon persisted with
 * issuer_id null, and since the merchant list groups by issuer, it rendered as
 * nothing at all.
 *
 * `expires_at` is the same defect, found later and one field short of the
 * original fix: it reaches the wallet as epoch SECONDS on the DM payload, and
 * without this mapping tokenRedemption read undefined and stored null, so no
 * coupon ever had an expiry to show.
 *
 * Both spellings go through — snake_case is what tokenRedemption reads, and the
 * original keys stay for anything downstream that speaks camelCase.
 */
export function toLegacyMetadata(
  metadata: Record<string, unknown> | undefined,
  senderPubkey?: string,
): Record<string, unknown> {
  const m = metadata ?? {}
  return {
    ...m,
    issuer_id: m.issuerId,
    voucher_id: m.voucherId,
    face_value: m.faceValue,
    face_unit: m.faceUnit,
    face_decimals: m.faceDecimals,
    token_amount: m.tokenAmount,
    backing_strategy: m.backingStrategy,
    memo: m.memo,
    expires_at: m.expiresAt,
    request_id: m.requestId,
    bundle_id: m.bundleId,
    sender_pubkey: senderPubkey,
  }
}

/** Exposed for the unwrap path used outside dm-poll (tests, diagnostics). */
export const conversationKey = nip44.getConversationKey
